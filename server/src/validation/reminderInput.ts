/**
 * Reminder creation input validation.
 *
 * This module is the server's single authority for the rules that decide
 * whether a create request is accepted, and for the exact wording of the
 * message a rejection carries. `server/src/routes/reminders.ts` turns an
 * `{ ok: false }` result into a 400 and `server/src/middleware/errorHandler.ts`
 * renders it as `{ error, field? }`; the client workspace keeps its own copy of
 * the same rules and asserts the same literal message strings, so a change to
 * one copy without the other fails that workspace's test.
 *
 * Four rules, applied in a fixed order so that a body failing several of them
 * reports deterministically (the text rejection always wins):
 *
 *   1. `text` is a string whose trimmed form is non-empty.
 *   2. The trimmed text is at most 280 characters.
 *   3. `dueAt` is a string that parses to a finite instant.
 *   4. `dueAt` is strictly after the current instant.
 *
 * Only the two request-supplied fields are normalised. `id`, `completed`,
 * `notifiedAt` and `createdAt` are derived by the server — the store generates
 * them, and they are changed only through the dedicated complete and notified
 * operations — so a body carrying them has them ignored here rather than
 * honoured; admitting them would let a caller suppress a reminder's
 * notification or bypass the completed-reminder rule.
 *
 * The module is pure: no IO, no logging, no HTTP type, no datastore access, no
 * environment variable and no dependency beyond the shared contract types. It
 * reads no clock — the current instant arrives as the `nowIso` parameter, which
 * the composition root supplies from the one injected accessor the whole server
 * reads time through, so an API test that pins that instant pins every
 * server-side time comparison together.
 */

import type { NewReminder, ReminderField } from '../types';

/**
 * The inclusive upper bound on the stored text length, measured over the
 * trimmed value. 280 is accepted and 281 is refused; the `reminders` table
 * carries the same bound as a `CHECK` constraint, which is the last line of
 * defence rather than the rule the user is shown.
 */
const MAX_TEXT_LENGTH = 280;

/*
 * The user-facing rejection messages. These strings are the contract: the
 * tests in both workspaces assert the literals rather than these constant
 * names, and the client displays the server's wording verbatim when a request
 * is refused.
 */

/** Shown when `text` is absent, not a string, or blank after trimming. */
const MISSING_TEXT_MESSAGE = 'Enter a reminder text.';

/** Shown when the trimmed text is longer than {@link MAX_TEXT_LENGTH}. */
const TEXT_TOO_LONG_MESSAGE = 'Reminder text must be 280 characters or fewer.';

/** Shown when `dueAt` is absent, not a string, or unparseable. */
const INVALID_DUE_AT_MESSAGE = 'Enter a valid due date and time.';

/** Shown when `dueAt` parses but is not strictly after the current instant. */
const PAST_DUE_AT_MESSAGE = 'The due time must be in the future.';

/**
 * The outcome of validating a create request body.
 *
 * The two branches are discriminated by `ok`. On success the caller receives a
 * `NewReminder` it can hand straight to the store's insert; on rejection it
 * receives the request field the message belongs to and the message itself.
 */
export type ValidationResult =
  | { ok: true; value: NewReminder }
  | { ok: false; field: ReminderField; message: string };

/**
 * Narrows a parsed request body to a plain object.
 *
 * A type predicate rather than an assertion: the body arrives as `unknown`
 * because nothing downstream of `express.json()` guarantees its shape, and the
 * rules below must refuse a malformed body rather than throw on it. A JavaScript
 * array also satisfies `typeof value === 'object'`, which needs no special case
 * — an array carries no `text` property, so the first rule rejects it.
 *
 * @param value - The value to test.
 * @returns True when `value` is a non-null object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Validates a parsed create-reminder request body.
 *
 * @param input - The parsed request body, handled as `unknown`. Anything that is
 *   not an object is treated as an empty body, so every malformed shape reaches
 *   a rule and is refused rather than raising.
 * @param nowIso - The current instant as an absolute UTC ISO-8601 string, read
 *   from the injected clock accessor. The past-due rule compares against it and
 *   nothing here reads a clock of its own.
 * @returns `{ ok: true, value }` with the trimmed text and the `dueAt` string
 *   exactly as received, or `{ ok: false, field, message }` naming the field the
 *   rejection is attributed to.
 */
export function validateReminderInput(
  input: unknown,
  nowIso: string,
): ValidationResult {
  const body: Record<string, unknown> = isRecord(input) ? input : {};

  // Rule 1 — the text must exist and must not be blank. One rejection covers the
  // empty string, a whitespace-only string, an absent field, `null` and every
  // non-string value, because all of them fail the same check.
  const rawText = body.text;
  if (typeof rawText !== 'string') {
    return { ok: false, field: 'text', message: MISSING_TEXT_MESSAGE };
  }
  const text = rawText.trim();
  if (text.length === 0) {
    return { ok: false, field: 'text', message: MISSING_TEXT_MESSAGE };
  }

  // Rule 2 — the bound applies to the trimmed value, which is also what is
  // stored and returned, so leading and trailing whitespace can never cost the
  // user characters they cannot see.
  if (text.length > MAX_TEXT_LENGTH) {
    return { ok: false, field: 'text', message: TEXT_TOO_LONG_MESSAGE };
  }

  // Rule 3 — the due time must be present and must parse to a finite instant.
  // `Date.parse` is the specified test: it yields `NaN` for every string that is
  // not an absolute instant, and the value stays a string throughout, so the
  // comparison below is numeric.
  const rawDueAt = body.dueAt;
  if (typeof rawDueAt !== 'string') {
    return { ok: false, field: 'dueAt', message: INVALID_DUE_AT_MESSAGE };
  }
  const dueAtMilliseconds = Date.parse(rawDueAt);
  if (Number.isNaN(dueAtMilliseconds)) {
    return { ok: false, field: 'dueAt', message: INVALID_DUE_AT_MESSAGE };
  }

  // Rule 4 — the due time must be strictly in the future. An instant exactly
  // equal to the current instant is refused, deliberately: there is no grace
  // window and no rounding, so "due now" is a past due time for this purpose.
  const nowMilliseconds = Date.parse(nowIso);
  if (dueAtMilliseconds <= nowMilliseconds) {
    return { ok: false, field: 'dueAt', message: PAST_DUE_AT_MESSAGE };
  }

  // Accepted. The value is a fresh object literal holding exactly the two
  // request-supplied fields: `text` trimmed, and `dueAt` byte-for-byte as it was
  // received, because the stored instant must be identical to the one the client
  // sent and the server never re-derives or reformats it. Nothing is spread in
  // from the body, so identity-bearing fields cannot ride along into the row.
  return { ok: true, value: { text, dueAt: rawDueAt } };
}
