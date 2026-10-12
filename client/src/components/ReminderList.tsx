/**
 * The reminder list: the application's single error banner, the two states an empty list can be in,
 * and the rows themselves.
 *
 * This component is a renderer and nothing else. It holds no state, runs no effect, reads no ref and
 * issues no request: the reminders arrive already fetched, the current instant arrives already
 * chosen, and every interaction it offers calls a callback its parent supplied. The same props
 * therefore always produce the same output, which is what lets each of its states be verified by
 * passing a value rather than by waiting for one.
 *
 * What it deliberately does not do, and where each rule lives instead:
 *
 * - It never orders the rows. The server returns reminders in due-time order (`dueAt` ascending,
 *   with `id` breaking a tie), so the array is rendered exactly as received: no sort call, no
 *   comparator, and no regrouping by status or by completion. A second ordering here could only
 *   disagree with the order the list is defined by.
 * - It never reads the clock. The `now` prop is the instant the periodic due check classified with,
 *   and it is forwarded to every row unchanged. A row's label and the notification decision
 *   therefore agree by construction, and an `Upcoming` row turns `Overdue` as time passes without a
 *   refetch or a re-render triggered from here.
 * - It never talks to the API. The client's one HTTP caller belongs to the hook that owns the list,
 *   and the callbacks below hand work back to that owner; the retry control is the same rule, so it
 *   calls `onRetry` and carries no fetching logic of its own.
 * - It never opens a second place for a failure to appear. This is the application's only error
 *   banner: the parent owns the message and renders no banner of its own, and there is no per-row
 *   error surface, so one failure is reported once rather than once per row.
 *
 * The regions, in the order they appear - and the order is the contract:
 *
 * 1. The error banner, whenever there is an error, carrying the server's message verbatim and a
 *    retry control. The message is never reformatted, prefixed or replaced.
 * 2. A loading placeholder, only while the first fetch is in flight with nothing on screen yet.
 * 3. The empty message, only when the list is genuinely empty and no error is being shown.
 * 4. The rows, whenever there are any - including while the banner is up, so a failed complete or
 *    delete leaves the reminders the user already has visible and the rest of the screen usable.
 *
 * The interaction between 1 and 3 is the point of those conditions. A failed first fetch with
 * nothing cached shows the banner alone: telling the user the list is empty at that moment would
 * state something the application does not know.
 *
 * Accessibility comes from the elements rather than from attributes. The banner is a
 * `role="alert"` region, so a screen reader announces the failure as it appears; the retry control
 * is a real `<button type="button">` and is therefore focusable and operable from the keyboard; and
 * every row is a real list item inside the real `<ul>` below, so the list's structure, its reading
 * order and its focus order all come from the platform. The empty and loading messages are text in
 * the document, never a colour or a shape alone.
 *
 * The class names are a fixed contract shared with `client/src/styles.css`, which carries a rule
 * for every one of them: `reminder-list`, `error-banner`, `error-banner__message`,
 * `error-banner__retry`, `reminder-list__placeholder`, `reminder-list__empty` and
 * `reminder-list__items`. No other class is used here, and the stylesheet is not edited from here.
 */

import type { JSX } from 'react';

import { ReminderItem } from './ReminderItem';
import type { Reminder } from '../types';

/**
 * The props this component renders from and delegates to.
 *
 * Every property is required and none is optional, because every one of them is always known by the
 * time the list renders: the parent has either fetched the reminders or is fetching them, has either
 * a failure or none, and always has an instant to classify the rows against.
 */
export interface ReminderListProps {
  /**
   * The reminders to render, in the order the server returned them (`dueAt` ascending, then `id`).
   *
   * Read-only on purpose: this component renders the list it is given and never rearranges, removes
   * or appends to it. The array the parent owns is the single source of the on-screen order.
   */
  reminders: readonly Reminder[];

  /**
   * Whether the first fetch is still in flight.
   *
   * It selects the placeholder and nothing else - a re-read of an already-populated list therefore
   * keeps showing its rows rather than replacing them with a placeholder.
   */
  loading: boolean;

  /**
   * The current instant as an absolute ISO-8601 string, forwarded unchanged to every row so each one
   * classifies itself against the same instant the due check used.
   */
  now: string;

  /**
   * The message to show in the single error banner, or `null` when there is no failure to report.
   *
   * Its presence is what decides between the banner and the two empty states, so it is deliberately
   * the whole of the error state rather than a flag beside a message.
   */
  error: string | null;

  /**
   * Called when the banner's retry control is used.
   *
   * The banner is rendered whenever `error` is non-null, whether or not rows are already on screen,
   * so this is the one control that clears a failed list, complete or delete.
   */
  onRetry: () => void;

  /** Called with a reminder's id when that row's Complete control is used. */
  onComplete: (id: string) => void;

  /** Called with a reminder's id when that row's Delete control is used. */
  onRemove: (id: string) => void;
}

/**
 * Renders the reminder list: the one error banner, the loading and empty states, and the rows.
 *
 * @param props The reminders to render, whether they are still loading, the instant to classify them
 *   against, the message to show when a request failed, and the three callbacks the list's controls
 *   delegate to.
 * @returns The list region: its banner when there is an error, a placeholder while the first fetch
 *   runs, the empty message when there is genuinely nothing to show, and otherwise the ordered rows.
 */
export function ReminderList({
  reminders,
  loading,
  now,
  error,
  onRetry,
  onComplete,
  onRemove,
}: ReminderListProps): JSX.Element {
  // Whether there is anything to list is a fact about the data, and it is read once so the four
  // conditions below cannot drift into four separate readings of the same array.
  const hasReminders = reminders.length > 0;

  return (
    <section className="reminder-list">
      {/* 1. The single error banner. The message is the server's own text, shown exactly as it
          arrived; the control hands the refetch back to whoever owns the list. */}
      {error !== null ? (
        <div className="error-banner" role="alert">
          <p className="error-banner__message">{error}</p>

          <button type="button" className="error-banner__retry" onClick={onRetry}>
            Retry
          </button>
        </div>
      ) : null}

      {/* 2. The placeholder for the first fetch, shown only while the list is still empty. A re-read
          of a populated list keeps its rows visible instead, so the list never blanks on a refetch. */}
      {error === null && loading && !hasReminders ? (
        <p className="reminder-list__placeholder">Loading reminders…</p>
      ) : null}

      {/* 3. The empty message, shown only once the fetch has finished without an error: with an error
          present the banner above is the whole report, and with a fetch still in flight the
          placeholder is. */}
      {error === null && !loading && !hasReminders ? (
        <p className="reminder-list__empty">No reminders yet. Add your first reminder above.</p>
      ) : null}

      {/* 4. The rows, in the order they arrived. Rendered independently of the banner, so a failed
          complete or delete leaves the list the user already has on screen. */}
      {hasReminders ? (
        <ul className="reminder-list__items">
          {reminders.map((reminder) => (
            <ReminderItem
              key={reminder.id}
              reminder={reminder}
              now={now}
              onComplete={onComplete}
              onRemove={onRemove}
            />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/**
 * Default export of the same component, for the import form the application shell may use.
 *
 * The shell that mounts this list (`client/src/App.tsx`) is written from a separate brief and did
 * not exist when this file was implemented, so the import form it will use could not be read from
 * the tree. Exporting both forms keeps either one working without an edit here; both resolve to the
 * single implementation above, so there is no second component to keep in step.
 */
export default ReminderList;
