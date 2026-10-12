/**
 * The screen's reminder state: the list as the server last reported it, the two flags that describe
 * that read, and the four operations the screen performs on a reminder.
 *
 * This module is the client's single owner of the loaded array. `client/src/App.tsx` calls it once —
 * with no argument in production — and threads what it returns to the create form, the list and the
 * error banner, so one read fills one list and no second component keeps a copy that could disagree
 * with it.
 *
 * What it holds is transient view state and nothing else: the fetched array, the loading flag raised
 * while a read is in flight, and the message from the last failed operation. The reminder is the
 * server's data — persisted there, re-read from there — so nothing here writes browser storage of
 * any kind (`localStorage`, `sessionStorage`, IndexedDB, a cookie), and a reload re-reads the server
 * rather than restoring anything locally.
 *
 * Four boundaries this module does not cross, each owned by the module it points at:
 *
 * - It performs no HTTP. Every request goes through the injected `RemindersApi`, which defaults to
 *   the `remindersApi` singleton in `../lib/remindersApi` — the client's only `fetch`. There is no
 *   `fetch` call here, no status code is inspected, no URL is assembled and no error type is
 *   constructed: a failure arrives as an `ApiError` that already carries the wording to show the
 *   user and, when the server attributed the refusal to an input, the input it belongs to.
 * - It never reorders, filters, de-duplicates or re-maps what the server returns. The list arrives
 *   ordered by `dueAt ASC, id ASC` from the server, which owns that comparator, and the array is
 *   stored exactly as received; a second ordering rule here could only disagree with the first.
 * - It assembles no request body and derives no field. `create` passes the validated `{ text, dueAt }`
 *   payload straight through, and `id`, `completed`, `notifiedAt` and `createdAt` are the server's to
 *   produce, so none of them is named as a request value on this side.
 * - It reads no clock and handles no time. No instant is created, parsed, formatted or compared
 *   here; the row and the due check take the current instant as an argument from their own caller,
 *   and `../lib/time` is the client's only converter.
 *
 * The rule that shapes the four operations is that the screen must never present a reminder as saved
 * when it was not. Nothing is applied optimistically, in any direction: `load` replaces the array
 * with exactly what the server returned, `create` re-reads the list after the server accepted the
 * reminder, `complete` replaces one row with the reminder the server returned an update for, and
 * `remove` drops a row only after the server confirmed the deletion. A refused operation leaves the
 * array and the row exactly as they were, so the screen shows either the server's state or the state
 * before the attempt — never a state the server never reported.
 *
 * The `api` parameter is this module's test seam: production code passes nothing and gets the
 * singleton, while a test passes a stub and reaches no host at all. Its identity is also what the
 * callbacks below depend on, so a caller that swaps the stub re-runs the mount read against the new
 * one.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type { RemindersApi } from '../lib/remindersApi';
import { ApiError, remindersApi } from '../lib/remindersApi';
import { VALIDATION_MESSAGES } from '../lib/validation';
import type { CreateReminderInput, Reminder } from '../types';

/**
 * What the screen consumes: the list and its flags, plus the four operations it performs.
 *
 * Every member is required. The screen always has an array to render (empty before the first read
 * completes), always has both flags, and always receives the four callbacks, so no consumer has to
 * test for an absent one.
 */
export interface UseRemindersResult {
  /** The reminders as the server last returned them, ordered `dueAt ASC, id ASC`, unmodified. */
  reminders: Reminder[];

  /**
   * `true` while a list read is in flight: the read on mount and every reload after it, including
   * the reload that follows a successful creation. `false` once a read has settled, whether it
   * succeeded or failed.
   */
  loading: boolean;

  /**
   * The message to show for the last failed list read, completion or deletion, or `null` when the
   * last attempt succeeded. It is never set for a failed creation: that failure is reported inline
   * by the create form, under the input the server attributed it to.
   */
  error: string | null;

  /** Reads the list again, replacing it on success; the error banner's Retry control calls this. */
  load: () => Promise<void>;

  /**
   * Creates one reminder from the form's validated input and resolves the reminder the server
   * created. Rejects with the API's error when the server refuses the request, so the caller can
   * attribute the message to the offending input.
   */
  create: (input: CreateReminderInput) => Promise<Reminder>;

  /** Marks one reminder complete and reflects the server's updated reminder in its row. */
  complete: (id: string) => Promise<void>;

  /**
   * Deletes one reminder, in either completion state, and drops its row once the server confirms.
   *
   * Named `remove` rather than `delete` because `delete` is a reserved word: it cannot be used as a
   * binding name, so a consumer could not destructure it from this result at all.
   */
  remove: (id: string) => Promise<void>;
}

/**
 * Resolves the wording to show for a failure list-level operations report.
 *
 * The server's own message is preferred to anything this module could invent — it is the authority
 * on why a request was refused — and `../lib/remindersApi` guarantees that message is never blank.
 * The `instanceof` check against `ApiError` covers every failure that module produces; the broader
 * `Error` check below it covers an equivalent error raised by a substituted API layer, whose class
 * is not this module's; and the generic message stands in for a cause that carries no readable
 * message at all, so the banner can never render an empty line or `[object Object]`.
 *
 * Only the message is read. A failure's status code, its field name and its cause are none of these
 * operations' business: the message is what the user acts on, and nothing else about a failure is
 * carried into the state or shown on screen.
 *
 * @param cause The value a rejected request produced.
 * @returns The message to show: the API's own wording when the cause carries one, the generic
 *   wording otherwise. Never blank, and never throws.
 */
function resolveErrorMessage(cause: unknown): string {
  if (cause instanceof ApiError) {
    return cause.message;
  }

  if (cause instanceof Error && cause.message.trim().length > 0) {
    return cause.message;
  }

  return VALIDATION_MESSAGES.GENERIC_ERROR;
}

/**
 * Owns the screen's reminder list and the operations performed on it.
 *
 * One call fills the list, and every later change to it comes from a server response: the read on
 * mount, the re-read that follows a successful creation, the single row a completion replaces, and
 * the single row a deletion drops. There is no second source of truth — no local store, no cache, no
 * browser storage — so the screen cannot show a reminder the server does not have.
 *
 * @param api The client's reminder API. Defaults to the `remindersApi` singleton, which is the
 *   client's only HTTP caller; a caller substitutes a stub to drive the hook without a host.
 * @returns The list, its loading and error state, and the four operations the screen calls.
 */
export function useReminders(api: RemindersApi = remindersApi): UseRemindersResult {
  // The array starts empty and `loading` starts true, so the first render shows the list's placeholder
  // rather than its empty state: "no reminders yet" is a claim about the server's data, and it is not
  // made until the server has answered.
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // The sequence number of the newest read. A ref rather than state because it decides whether a
  // response may touch state and never appears in the rendered output, so changing it must not
  // re-render anything.
  const loadRequestRef = useRef(0);

  /**
   * Reads the list and replaces the current one with what the server returns.
   *
   * The read is what the screen's retry control calls, and it is also what refreshes the list after a
   * successful creation. A failure leaves the previous list in place — the array is only ever
   * replaced by a successful response — and reports the failure's message, which is what keeps a
   * refused read from emptying the screen.
   *
   * Overlapping reads are resolved in favour of the newest: every read claims a sequence number and
   * only the newest one may apply its result, clear the loading flag or report a failure. Two reads
   * can overlap whenever one is requested while another is still in flight — a retry pressed during
   * the read it retries, or a creation reloading while the mount read is outstanding — and without
   * that rule the slower response would settle the state and could restore a list the faster read had
   * already replaced.
   */
  const load = useCallback(async (): Promise<void> => {
    const requestId = loadRequestRef.current + 1;
    loadRequestRef.current = requestId;

    // Cleared at the start of the attempt rather than only on success, so the banner never outlives
    // the failure that produced it and a retry visibly replaces the old message with the new outcome.
    setError(null);
    setLoading(true);

    try {
      const loaded = await api.list();

      // Superseded: a newer read owns the state now, so this response is dropped rather than applied.
      if (loadRequestRef.current !== requestId) {
        return;
      }

      // Stored exactly as returned — no sort, no filter, no de-duplication, no re-mapping. The server
      // orders the list (`dueAt ASC, id ASC`) and this array is a rendering of its answer, not a
      // second opinion about it.
      setReminders(loaded);
    } catch (cause) {
      // Superseded reads report nothing: the newer read speaks for the current state.
      if (loadRequestRef.current !== requestId) {
        return;
      }

      // The list stays as it was. A failed read has nothing better to show than the last known list,
      // and emptying it here would present a working application as an empty one.
      setError(resolveErrorMessage(cause));
    } finally {
      // Guarded for the same reason as the branches above: a superseded read must not clear the flag
      // while the read that replaced it is still in flight. Every path still clears it — success,
      // failure and supersession alike — because this block runs however the try above ended.
      if (loadRequestRef.current === requestId) {
        setLoading(false);
      }
    }
  }, [api]);

  // The read on mount. It fills the list on the first render and again after every page reload, which
  // is how the reminders the server persisted reach the screen. Depending on `load` rather than on an
  // empty array keeps the effect attached to the callback it calls, so an injected API layer is read
  // through instead of the list staying bound to the layer that was replaced.
  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Creates one reminder and resolves the reminder the server created.
   *
   * A refusal is re-thrown rather than reported through `error`: the create form owns that failure and
   * renders it inline beneath the input the server attributed it to, so reporting it here as well
   * would print one failure twice. The list and the form's input are both left untouched when the
   * request is refused, which is what keeps a reminder the server never stored from appearing as
   * though it had been saved.
   */
  const create = useCallback(
    async (input: CreateReminderInput): Promise<Reminder> => {
      // The server's own reminder is returned before the list is re-read, so the caller learns what
      // was created even if the read that follows it fails. Nothing is inserted into the array here:
      // the order is the server's, and placing a row client-side would reimplement that comparator
      // outside its owner.
      const created = await api.create(input);

      // The list is re-read after the server accepted the reminder, so what the screen shows is the
      // server's answer to "what is stored now" — the new reminder included, in its own place.
      await load();

      return created;
    },
    [api, load],
  );

  /**
   * Marks one reminder complete and reflects the server's updated reminder in its row.
   *
   * The row is replaced by the reminder the completion returned, which is a server response rather
   * than an optimistic guess: the completion is the server's to record, and a screen that showed it
   * before the record existed would contradict the server on the next reload. The row cannot move,
   * because completion changes neither `dueAt` nor `id`, the two fields the order is built from.
   */
  const complete = useCallback(
    async (id: string): Promise<void> => {
      setError(null);

      try {
        const updated = await api.complete(id);

        // One element replaced, in place. `.map` is also the `noUncheckedIndexedAccess`-safe form of
        // the same intent: there is no indexed read to guard. An id no longer in the list replaces
        // nothing and is not resurrected from the response.
        setReminders((current) =>
          current.map((reminder) => (reminder.id === id ? updated : reminder)),
        );
      } catch (cause) {
        // The row stays exactly as it was: a completion the server did not record must never read as
        // completed on screen.
        setError(resolveErrorMessage(cause));
      }
    },
    [api],
  );

  /**
   * Deletes one reminder, in either completion state, once the server confirms the deletion.
   *
   * The deletion answers with no body, so a resolved call is the whole confirmation there is. The row
   * is dropped only after it, which is what stops a screen from showing a reminder as deleted while
   * the server still holds it.
   */
  const remove = useCallback(
    async (id: string): Promise<void> => {
      setError(null);

      try {
        await api.remove(id);

        // Idempotent by construction: an id that is no longer in the list removes nothing and throws
        // nothing, so a deletion racing another consumer can neither corrupt the set nor fail.
        setReminders((current) => current.filter((reminder) => reminder.id !== id));
      } catch (cause) {
        setError(resolveErrorMessage(cause));
      }
    },
    [api],
  );

  // A fresh object per render holding the current values: the state lives in the three `useState`
  // calls above, and the four callbacks are stable for as long as `api` is. Every member of the
  // returned shape is present on the first render, before any read has settled, so a consumer never
  // has to handle a partly built result.
  return { reminders, loading, error, load, create, complete, remove };
}
