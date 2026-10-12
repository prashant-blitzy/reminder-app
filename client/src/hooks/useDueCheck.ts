/**
 * The due check: the client's one scheduler for "this reminder has just come due", the one place a
 * reminder's notification is fired, and the one place it is claimed on the server.
 *
 * This hook owns exactly three things:
 *
 * - THE SCHEDULING. The check runs once immediately when the hook mounts, then every 30 000 ms, and
 *   again on `focus` and on a `visibilitychange` that leaves the document visible. The immediate run
 *   is what notifies a reminder that came due while the page was closed — the moment the app opens.
 *   The focus and visibility re-runs exist because a backgrounded tab throttles timers: "at least
 *   once every 30 seconds" is a requirement about the open application, not about a timer's
 *   goodwill. Overlapping runs are refused, so two ticks, or a tick and a focus run, can never both
 *   select the same reminder.
 *
 * - THE SESSION'S CLAIM BOOKKEEPING. A reminder is added to an in-session set of claimed ids BEFORE
 *   its notification is fired, so a run that overlaps the one already firing it cannot alert twice.
 *   Across sessions the guarantee is the server's `notifiedAt` column, written by `api.markNotified`
 *   as one atomic statement: this hook's set covers the gap between firing a notification and the
 *   claim being recorded, and that column covers everything after it.
 *
 * - THE CLIENT'S SINGLE WALL-CLOCK READ. One read per run, taken here and nowhere else, is passed
 *   down as an argument to `selectDueReminders` (which decides what is due and reads no clock of its
 *   own) and reported back as `now`, so the row that renders a due time is classified from the very
 *   instant the notification decision was made from. The form's own pre-flight check reaches the
 *   same accessor, `currentInstantIso` in `../lib/time`, so the client has one time source, not two.
 *
 * What this hook deliberately does not own, and must not reimplement — each is one shared module:
 *
 * - The due condition and the status classification belong to `../lib/dueCheck`, so the row's
 *   Overdue label and this hook's decision to notify can never disagree.
 * - The notification channels belong to `../lib/notifications`. It appends the in-app alert, decides
 *   by itself whether a browser notification may be attempted, and no permission is read or
 *   requested here — the single permission request rides the create form's submit gesture.
 * - The HTTP calls belong to `../lib/remindersApi`, which is the client's only caller and the only
 *   place a non-2xx response becomes a typed error.
 * - The time conversion and the clock accessor belong to `../lib/time`.
 *
 * The list this hook reads is the same complete list the screen renders, obtained through
 * `api.list()`: one request per tick, whatever the number of reminders. There is no separate "due"
 * endpoint and no per-reminder request, so the periodic cost of the feature does not grow with the
 * size of the list — which is what keeps it responsive at the thousand reminders the requirement
 * bounds it by.
 *
 * Failure policy, stated because it is a decision rather than an accident: a claim that fails is
 * reported and never retried for that reminder in this session, since a retry would alert the user
 * every 30 seconds for as long as the page stays open — worse than one missed notification. A list
 * read that fails inside the check claims nothing and is simply read again by the next tick. Neither
 * failure modifies the screen's list, neither re-alerts, and this hook renders nothing: `App.tsx`
 * merges its `error` into the one banner as `listError ?? claimError`, so a failure the user just
 * caused takes precedence over this background one.
 *
 * Nothing here reaches for a service worker, a push subscription or any external delivery service. A
 * page-scoped notification lives exactly as long as its page, and an open page is the only lifetime
 * this application is allowed to notify in.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type { Reminder } from '../types';
import { selectDueReminders } from '../lib/dueCheck';
import { notify } from '../lib/notifications';
import { ApiError, remindersApi, type RemindersApi } from '../lib/remindersApi';
import { currentInstantIso } from '../lib/time';
import { VALIDATION_MESSAGES } from '../lib/validation';

/**
 * How often the check runs while the page stays open, in milliseconds.
 *
 * The requirement is "at least once every 30 seconds", so this is the cadence the check is scheduled
 * at and the value the suite advances the faked timer by. It is deliberately not exported: the
 * module's export surface is `useDueCheck` and `UseDueCheckResult`, and the cadence is a fixed fact
 * of the feature rather than a knob for a caller to turn.
 */
const DUE_CHECK_INTERVAL_MS = 30_000;

/**
 * What the hook reports back to the screen.
 */
export interface UseDueCheckResult {
  /**
   * The instant the most recent run decided against, as an absolute UTC ISO-8601 string.
   *
   * Refreshed by every run, so the screen's status labels are computed from the instant the
   * notification decision was made from rather than from a second, later clock read.
   */
  now: string;

  /**
   * The message of a failure this background check could not complete, or `null` when the most
   * recent run finished without one.
   *
   * Non-blocking by design: the screen keeps working, and `App.tsx` merges this value into the
   * single error banner behind the screen's own list error.
   */
  error: string | null;
}

/**
 * Reads the message to show for a failure, whichever shape it arrived in.
 *
 * The typed failure is the one `../lib/remindersApi` throws, and its message is already the wording
 * to display. The `Error` branch is not redundant: a suite that substitutes the API module with its
 * own equivalent error class must still yield a useful message, and so must any other failure that
 * carries one. Anything else — a rejection carrying no message, or none at all — falls back to the
 * generic wording, so the banner can never be handed an empty string.
 *
 * @param error The value a rejected promise produced.
 * @returns The wording for the user.
 */
function resolveErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return error.message;
  }

  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  return VALIDATION_MESSAGES.GENERIC_ERROR;
}

/**
 * Watches for reminders that have come due, notifies each one once, and records the claim.
 *
 * @param reminders The list as the screen holds it: the server's array, ordered by `dueAt ASC,
 *   id ASC`. A change of its identity — which `useReminders` produces only when new data has
 *   arrived from the server — is what re-runs the check against it, so a reminder that came due
 *   while the page was closed is notified as soon as the first list arrives, without waiting a tick.
 * @param api The client's HTTP caller. Defaults to the real `remindersApi`; a suite passes its own
 *   to observe the calls, which is the seam this hook is tested through. It must be a STABLE
 *   reference — the module's own `remindersApi` is — because it is this hook's only dependency: a
 *   caller that built a fresh value on every render would re-create both effects on every render,
 *   re-running the argument path forever and restarting the interval before it could ever fire.
 * @returns The instant the last run decided against and the message of any failure it met.
 */
export function useDueCheck(
  reminders: readonly Reminder[],
  api?: RemindersApi,
): UseDueCheckResult {
  const [now, setNow] = useState<string>(() => currentInstantIso());
  const [error, setError] = useState<string | null>(null);

  /**
   * Whether a run is in flight. Held in a ref rather than in state because it must be read and
   * written synchronously, within one run and before React has re-rendered; a state value would
   * arrive a render too late for the guard to stop anything.
   */
  const runningRef = useRef(false);

  /**
   * The ids this session has already fired a notification for, kept for the lifetime of the page.
   *
   * Session view state, never persisted: the durable record is the server's `notifiedAt` column, and
   * this set exists only to cover the interval between firing a notification and that column being
   * written.
   */
  const claimedRef = useRef<Set<string>>(new Set());

  /**
   * The API to call: the injected one when a suite supplies it, the real caller otherwise.
   *
   * Resolved once per render so the run below depends on one stable value, and so the default is
   * applied without the caller having to know it.
   */
  const client = api ?? remindersApi;

  /**
   * One run of the check.
   *
   * @param providedList The list to select from when the caller already holds it (mount, and every
   *   change of the `reminders` argument), or `null` to read the current list from the server (every
   *   interval tick, and every focus or visibility re-run). The argument path issues no request,
   *   which is what makes a reminder that came due while the page was closed notify as soon as the
   *   screen's own list arrives.
   *
   * The whole run — the fetch included — sits inside the overlap guard, and the guard is released in
   * a `finally` so a failure cannot leave it stuck. The function never rejects: both failure paths
   * are caught here and reported through `error`, so no call site needs a rejection handler.
   */
  const run = useCallback(
    async (providedList: readonly Reminder[] | null): Promise<void> => {
      if (runningRef.current) {
        return;
      }
      runningRef.current = true;

      try {
        // A fresh attempt supersedes a stale failure message. Cleared only once the run is known to
        // proceed, so a refused run leaves the message the last real attempt produced.
        setError(null);

        // The run's one read of the clock. The same instant decides what is due below and is
        // reported to the screen, so a row's status and this run's notification cannot disagree.
        const instant = currentInstantIso();
        setNow(instant);

        const list = providedList ?? (await client.list());

        // Selection is the shared rule in `../lib/dueCheck`, filtered by the ids this session has
        // already fired for. Nothing is sorted: the server's order is the notification order.
        const selected = selectDueReminders(list, instant).filter(
          (reminder) => !claimedRef.current.has(reminder.id),
        );

        for (const reminder of selected) {
          // Claimed in session BEFORE the notification is fired and therefore before the claim
          // request is issued: a tick that lands while this run is still recording the claim must
          // find the id already taken.
          claimedRef.current.add(reminder.id);
          notify(reminder);

          try {
            await client.markNotified(reminder.id);
          } catch (claimFailure) {
            // Reported, and deliberately not retried: the id stays in the session set, so this
            // reminder is not alerted again on any later tick. The loop continues, so one failed
            // claim never costs the remaining reminders their notification.
            setError(resolveErrorMessage(claimFailure));
          }
        }
      } catch (listFailure) {
        // The list could not be read. Nothing was selected and nothing was claimed, so the next tick
        // simply reads again.
        setError(resolveErrorMessage(listFailure));
      } finally {
        runningRef.current = false;
      }
    },
    [client],
  );

  // The argument path: mount, and every change of the list the screen holds. No request is issued
  // here, and `now` is deliberately absent from the dependencies — it is this hook's own output, and
  // including it would re-run the check on every re-render it caused.
  useEffect(() => {
    void run(reminders);
  }, [run, reminders]);

  // The scheduler: the interval and the two listeners, created in the effect that clears them.
  //
  // The dependency is `run` alone on purpose. Recreating this effect whenever the list changed would
  // reset the interval, and a list changing more often than the cadence would then never reach a
  // tick at all — which would break "at least once every 30 seconds" while looking correct.
  useEffect(() => {
    const timer = window.setInterval(() => {
      void run(null);
    }, DUE_CHECK_INTERVAL_MS);

    const handleFocus = (): void => {
      void run(null);
    };

    const handleVisibilityChange = (): void => {
      if (document.visibilityState === 'visible') {
        void run(null);
      }
    };

    window.addEventListener('focus', handleFocus);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [run]);

  return { now, error };
}
