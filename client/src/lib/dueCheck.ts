/**
 * The client's single definition of which reminders are due to be notified, and of which of the
 * three states a reminder is in.
 *
 * One module owns both rules because they must never disagree. The row that renders a reminder's
 * status label and the periodic check that fires its notification read the same functions, so the
 * list cannot show a reminder as Upcoming while the check treats it as due. The consumers are
 * `client/src/components/ReminderItem.tsx` and `client/src/components/ReminderList.tsx` for the
 * status text and treatment, and `client/src/hooks/useDueCheck.ts` for the selection. A second
 * definition of either rule anywhere in the client is a defect.
 *
 * Everything here is pure, and the current instant is an ARGUMENT on every function. This module
 * therefore reads no clock of any kind: not `Date`'s epoch accessor, not a `Date` constructed with no
 * arguments, and not a monotonic timer. The only platform time call in the file is the parse of an
 * instant a caller supplied, which is exactly what makes the due decision deterministic and testable
 * against a pinned instant instead of against fake timers. It also performs no request and touches
 * no browser API: it decides which reminders are due, and the hook that owns the 30-second cadence
 * is the one that notifies them and records the claim through `client/src/lib/remindersApi.ts`.
 *
 * Nothing is sorted, reordered or dropped here either. The server returns the list already ordered by
 * `dueAt ASC, id ASC`, so this module selects a subset of it and classifies rows, and never moves a
 * row or replaces one.
 *
 * The only import is the reminder shape from `../types`. The module has no runtime dependency, uses
 * no package outside the workspace's pinned set, and reaches nothing from the other workspace (the
 * client and the server meet over HTTP only).
 */

import type { Reminder } from '../types';

/**
 * The three states a reminder can be in.
 *
 * The member names are the ones the stylesheet keys its treatments on
 * (`.reminder-item--upcoming`, `.reminder-item--overdue`, `.reminder-item--completed`), so they are
 * part of this module's contract rather than an internal detail.
 */
export type ReminderStatus = 'upcoming' | 'overdue' | 'completed';

/**
 * The text of each status, as a row renders it.
 *
 * Status is carried by these words and never by colour alone, so every status the list can show has
 * a label here.
 */
export const STATUS_LABELS: Record<ReminderStatus, string> = {
  upcoming: 'Upcoming',
  overdue: 'Overdue',
  completed: 'Completed',
};

/**
 * Reads an absolute ISO-8601 instant as milliseconds since the epoch.
 *
 * @param iso An instant in the form the server stores and returns, or any value that reached the
 *   client in the `dueAt` field.
 * @returns The instant in milliseconds, or `null` when the value holds no instant the platform can
 *   read (`Date.parse` answers `NaN`). Every caller treats `null` as "cannot be compared" rather
 *   than letting a `NaN` comparison decide the outcome silently.
 */
function parseInstant(iso: string): number | null {
  const instant = Date.parse(iso);
  return Number.isNaN(instant) ? null : instant;
}

/**
 * The one comparison rule behind both exports: has `dueAt` arrived as of `nowMs`?
 *
 * Both operands are compared as NUMBERS, never as strings. The server stores the validated string it
 * received, so an offset-bearing instant the client sent (`2026-10-07T12:00:00+02:00`) would sort
 * after `2026-10-07T11:00:00Z` in a text comparison while being chronologically EARLIER. Comparing
 * text would therefore mark that past reminder Upcoming and postpone its notification for good,
 * which is why the comparison is numeric.
 *
 * A daylight-saving transition needs no handling here and gets none: both operands are already
 * absolute instants, so a zone change alters how an instant is displayed, never what it compares to.
 *
 * @param dueAtIso The reminder's due instant, as stored.
 * @param nowMs The current instant in milliseconds, already parsed by the caller so that one "now"
 *   serves a whole list.
 * @returns `true` only when both instants are readable and the due instant is at or before now. The
 *   bound is inclusive, so a reminder sitting exactly on its due instant counts as due. An unreadable
 *   due instant is never due.
 */
function isDueAtOrBefore(dueAtIso: string, nowMs: number): boolean {
  const dueAt = parseInstant(dueAtIso);
  return dueAt !== null && dueAt <= nowMs;
}

/**
 * Classifies one reminder for display.
 *
 * Completion is checked first, so a completed reminder is always Completed however long ago it was
 * due: it is never Overdue, and it is never a candidate for notification. Otherwise the due instant
 * decides, at or before now meaning Overdue and later meaning Upcoming.
 *
 * @param reminder The reminder to classify.
 * @param nowIso The current instant, supplied by the caller (this module never reads the clock).
 * @returns `'completed'`, `'overdue'` or `'upcoming'`. An unreadable `dueAt` yields `'upcoming'`,
 *   because a reminder that cannot be shown to be past due must not be presented as overdue.
 */
export function classify(reminder: Reminder, nowIso: string): ReminderStatus {
  if (reminder.completed) {
    return 'completed';
  }

  const now = parseInstant(nowIso);
  if (now === null) {
    return 'upcoming';
  }

  return isDueAtOrBefore(reminder.dueAt, now) ? 'overdue' : 'upcoming';
}

/**
 * Selects the reminders that are due to be notified as of the given instant.
 *
 * The three conditions are exact and all required: the reminder is uncompleted
 * (`completed === false`), it has come due (`dueAt <= now`), and its notification has never been
 * claimed (`notifiedAt === null`). The last of the three is what makes delivery happen at most once,
 * so a reminder already claimed is never selected again - not on a later tick and not after a page
 * reload, because the claim is stored on the server rather than held in this session.
 *
 * There is deliberately NO grace window. A reminder that came due while the page was closed is
 * selected by the same rule as one that comes due now, so it is notified exactly once on the next
 * open when the check first runs. A completed reminder can never be selected, whatever its due time.
 *
 * @param reminders The list as the server returned it, already ordered by `dueAt ASC, id ASC`. The
 *   input is read only: this function neither mutates it, nor sorts it, nor reorders what it returns.
 * @param nowIso The current instant, supplied by the caller (this module never reads the clock).
 * @returns A new array holding just the due, unnotified, uncompleted reminders - in their original
 *   order, so the notification order matches the order the list renders. Empty when nothing is due,
 *   and empty when `nowIso` itself holds no readable instant, since an unreadable "now" cannot
 *   establish that anything has come due.
 */
export function selectDueReminders(reminders: readonly Reminder[], nowIso: string): Reminder[] {
  const now = parseInstant(nowIso);
  if (now === null) {
    return [];
  }

  return reminders.filter(
    (reminder) =>
      !reminder.completed && reminder.notifiedAt === null && isDueAtOrBefore(reminder.dueAt, now),
  );
}
