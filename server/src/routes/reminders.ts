/**
 * The reminder feature's HTTP surface: one Express 5 router carrying the five
 * operations the API exposes.
 *
 * This is the server's only HTTP layer for reminders. `server/src/app.ts` mounts
 * it at `/api`, so the paths registered below are the client-facing paths with
 * that prefix added:
 *
 *   POST   /api/reminders              → 201, the created reminder
 *   GET    /api/reminders              → 200, every reminder in due-time order
 *   PATCH  /api/reminders/:id/complete → 200, the updated reminder
 *   PATCH  /api/reminders/:id/notified → 200, the reminder carrying its claim
 *   DELETE /api/reminders/:id          → 204, no body
 *
 * Failure is stated here in exactly two ways, and both are raised rather than
 * rendered: a create input the rules refuse, carrying the rule's own message and
 * the field it concerns, and an identifier that names no reminder. They are
 * raised as the typed errors of `../middleware/errorHandler`, which owns the
 * `{ error, field? }` shape and every status this API answers with, so this file
 * writes no error body, computes no message string of its own and never decides
 * a 500. A malformed JSON body, a storage failure and a bug all reach that same
 * middleware without this file arranging anything, because Express forwards a
 * synchronous throw from a handler and every store method is synchronous.
 *
 * The module decides no policy and keeps no state. The rules and their wording
 * live in `../validation/reminderInput`; the statements, the ordering, the
 * identity generation and the row-to-object mapping live in
 * `../data/reminderStore`; the table's shape lives in `../data/schema`. One
 * request therefore amounts to: narrow the parameters, ask the validator, call
 * one store method, answer with what the store returned.
 */

import { Router } from 'express';

import type { ReminderStore } from '../data/reminderStore';
import { badRequest, notFound } from '../middleware/errorHandler';
import { validateReminderInput } from '../validation/reminderInput';

/**
 * The only two fields a create request may carry, held as `unknown` because
 * nothing downstream of the JSON parser guarantees what type a body's property
 * has. The rules that decide whether a value is acceptable belong to the
 * validator, so the types are deliberately left open here rather than narrowed
 * into a lie.
 */
interface CreateCandidate {
  text: unknown;
  dueAt: unknown;
}

/**
 * Lifts the create candidate out of whatever arrived as the request body.
 *
 * A body is useful here only when it is a non-null object. An absent body, a
 * JSON scalar (`"text"`, `42`, `true`, `null`) and an array all amount to the
 * same thing as far as the rules are concerned — no text and no due time — so
 * each becomes the empty candidate and is refused by the first rule, with the
 * rule's own message, instead of raising a `TypeError` that would surface as a
 * 500. (An array needs no separate case: it is an object, it carries no `text`
 * property, and the first rule refuses it accordingly.)
 *
 * Exactly the two request-supplied fields are read, into a fresh object literal
 * that is never the body itself. That is the whole of the identity rule: a body
 * carrying `id`, `completed`, `notifiedAt` or `createdAt` has those fields left
 * behind here, so none of them can reach the validator or a store call. Those
 * four values are derived server-side for a reason rather than by convention —
 * a client-supplied `notifiedAt` would let a page suppress a reminder's
 * notification permanently, and a client-supplied `completed` would let a create
 * request bypass the rule that a completed reminder is never notified.
 *
 * @param body The parsed request body, of no assumed shape.
 * @returns The two fields the validator inspects; both are `undefined` for a
 *   body that carries neither.
 */
function readCreateCandidate(body: unknown): CreateCandidate {
  if (typeof body !== 'object' || body === null) {
    return { text: undefined, dueAt: undefined };
  }

  const fields = body as Record<string, unknown>;

  return { text: fields.text, dueAt: fields.dueAt };
}

/**
 * Narrows the `:id` path parameter that the three id-bearing operations share.
 *
 * A path segment is a request input like any other, so its value is checked
 * rather than assumed: it reaches this module as a runtime value from the URL,
 * and only a non-empty string can name a reminder. A value that is absent, is
 * not a string, or is empty names no reminder at all — which is precisely what a
 * 404 says. Both cases are therefore stated once, as that 404, rather than being
 * defaulted to an empty string and handed to a store that would then be asked a
 * question about a reminder no client can have created.
 *
 * @param rawId The parameter exactly as Express parsed it.
 * @returns The identifier, once it is a non-empty string.
 * @throws HttpError 404 when the parameter is absent, is not a string, or is
 *   empty.
 */
function requireReminderId(rawId: string | undefined): string {
  if (typeof rawId !== 'string' || rawId.length === 0) {
    throw notFound();
  }

  return rawId;
}

/**
 * Builds the reminder API's router over an injected store and clock.
 *
 * Both collaborators are construction parameters rather than imports, which is
 * what lets an API test build the whole application over an in-memory or
 * temporary database with a pinned clock and drive it without a listening
 * socket.
 *
 * @param options The router's two collaborators.
 * @param options.store The reminder data store. Every read and write goes
 *   through it: this module holds no database handle, writes no SQL and keeps no
 *   list of its own, so nothing it answers can come from state a client's
 *   earlier request left in memory.
 * @param options.now Returns the current instant as an absolute UTC ISO-8601
 *   string. It has exactly one use here — supplying the current instant to the
 *   validator's past-due rule — and it is the same accessor the store was
 *   constructed with, so the creation instant, the notification claim and this
 *   comparison all read one clock that a test can pin. Nothing in this file
 *   consults the wall clock, and nothing here formats an instant or applies a
 *   time zone: the three instants a reminder carries are opaque absolute
 *   strings that pass through unchanged.
 * @returns The router, ready to be mounted at `/api`.
 */
export function createRemindersRouter(options: { store: ReminderStore; now: () => string }): Router {
  const { store, now } = options;
  const router = Router();

  /**
   * Create a reminder.
   *
   * The validator runs before any store call, so a refused input reaches no
   * statement, leaves no row and creates no partial state: the client is never
   * shown a reminder as saved when it was not. Only the value the validator
   * accepted is handed to the store — trimmed text and the due instant
   * byte-for-byte as it arrived — and the store supplies the identifier, the
   * creation instant, the uncompleted and unclaimed starting state, and the
   * response object read back from the row it wrote.
   */
  router.post('/reminders', (req, res) => {
    const result = validateReminderInput(readCreateCandidate(req.body), now());

    if (!result.ok) {
      throw badRequest(result.message, result.field);
    }

    const created = store.create(result.value);

    res.status(201).json(created);
  });

  /**
   * List every reminder.
   *
   * The array is returned as the store produces it: already in the required
   * due-time order, with the tiebreak the store applies, and already carrying
   * the boolean form of the completion flag. Nothing is re-sorted, filtered or
   * mapped here, so the list the screen renders, the list the client's due check
   * scans and the order the database guarantees are the same array.
   */
  router.get('/reminders', (_req, res) => {
    res.status(200).json(store.list());
  });

  /**
   * Mark a reminder complete.
   *
   * A store answer of `undefined` means no row has this identifier — an already
   * completed reminder is returned unchanged rather than reported as missing —
   * so it is the one condition that becomes a 404. The row that comes back is
   * the persisted state read after the change committed, so the response reports
   * what the database holds rather than what the request asked for.
   */
  router.patch('/reminders/:id/complete', (req, res) => {
    const updated = store.complete(requireReminderId(req.params.id));

    if (updated === undefined) {
      throw notFound();
    }

    res.status(200).json(updated);
  });

  /**
   * Record the claim that a due reminder has been notified.
   *
   * Any request body is ignored entirely: the claim is made of the identifier in
   * the path and the instant the store's clock records, so there is nothing a
   * caller could usefully supply and nothing it could override.
   *
   * The claim is the store's single guarded statement — `SET notifiedAt = ? ...
   * AND notifiedAt IS NULL` — so it succeeds once, records itself as it commits,
   * and leaves an earlier claim's instant in place. That single statement answers
   * `undefined` for two different situations, and they are not the same answer to
   * a client:
   *
   *   - the row exists and the claim is already recorded. The reminder is known
   *     and is in the state this operation asks for, so the request is a repeat
   *     of a claim that was already won — an idempotent retry the client's due
   *     check may legitimately issue — and it answers 200 with the stored
   *     reminder, whose `notifiedAt` is the instant the first claim recorded.
   *     Answering 404 here would report a live reminder as missing and send the
   *     client into an error state for a reminder that was notified exactly once.
   *   - no row has this identifier. That, and only that, is an unknown reminder
   *     and becomes the 404.
   *
   * The read-back is what tells the two apart, and it is the only read this
   * operation performs.
   */
  router.patch('/reminders/:id/notified', (req, res) => {
    const id = requireReminderId(req.params.id);
    const claimed = store.markNotified(id);

    if (claimed !== undefined) {
      res.status(200).json(claimed);
      return;
    }

    // The claim was not won: either it was already recorded for this reminder, or
    // no reminder has this identifier. Reading the row back is what separates
    // them, so a known reminder whose claim already stands answers 200 with the
    // stored state and only a truly unknown identifier answers 404.
    const existing = store.get(id);

    if (existing === undefined) {
      throw notFound();
    }

    res.status(200).json(existing);
  });

  /**
   * Delete a reminder, in either completion state.
   *
   * The store reports whether a row was removed; `false` — no row had this
   * identifier — is the only condition that becomes a 404. A successful removal
   * answers 204 with no body: the reminder is gone and there is nothing left to
   * describe, so the response carries no JSON at all rather than an empty object.
   */
  router.delete('/reminders/:id', (req, res) => {
    const removed = store.remove(requireReminderId(req.params.id));

    if (!removed) {
      throw notFound();
    }

    res.status(204).end();
  });

  return router;
}
