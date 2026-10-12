/**
 * One row of the reminder list: a single reminder's text, its due time in the viewer's local zone,
 * its status as a word, and the two controls that act on it.
 *
 * This component renders and delegates; it holds nothing. It has no state, no effects, no refs, no
 * timers and no requests of its own: the two interactions it offers call the callbacks it is given,
 * so the parent keeps ownership of the API call, of the list update and of the single error banner.
 * It therefore renders the same output for the same props, which is what lets the row's three states
 * be verified by passing an instant rather than by waiting for one.
 *
 * The two rules it must not re-derive live in the modules it imports:
 *
 * - Which of the three states a reminder is in comes from `classify`, and the wording of that state
 *   from `STATUS_LABELS`, both in `../lib/dueCheck`. That is the same function the periodic due check
 *   selects the reminders to notify with, so a row can never show a state the check disagrees with.
 * - How a stored instant reads in the viewer's zone comes from `formatLocalDueAt` in `../lib/time`,
 *   the client's only formatter. Nothing here touches a date: no instant is built, parsed, offset or
 *   reformatted on this side of the module boundary.
 *
 * The current instant arrives as the `now` prop rather than being read here. It is the same instant
 * the due check classified with, so the label and the notification agree by construction; and a
 * clock read inside a render would also make the row impossible to verify deterministically.
 *
 * The class names are a fixed contract shared with `client/src/styles.css`, which carries a rule for
 * every one of them: `reminder-item`, `reminder-item__text`, `reminder-item__due`,
 * `reminder-item__status`, `reminder-item__actions`, `reminder-item__action` and the three modifiers
 * `reminder-item--upcoming`, `reminder-item--overdue` and `reminder-item--completed`. The modifier
 * suffix is exactly the value `classify` returns, so the class is built from that value instead of
 * from a second mapping that could drift away from the status union. The stylesheet also gives the
 * last action of the cluster the danger treatment, which is why Delete is always rendered after
 * Complete.
 *
 * Status is carried by text as well as by treatment: the modifier paints the row and the label spells
 * the state out, so the three states stay distinguishable without colour.
 *
 * Every element is the semantic one. The row is a real list item inside the list's `<ul>`, the due
 * time is a `<time>` whose `dateTime` attribute carries the machine-readable instant, and both
 * controls are real `<button type="button">` elements, so keyboard operation, focus order and screen
 * reader announcement come from the platform rather than from script. A completed reminder keeps its
 * Delete control and loses only the Complete one, because a reminder may be removed in either state,
 * and completion is decided before the due time is considered, so a completed row is never presented
 * as overdue however long ago it was due.
 */

import type { JSX } from 'react';

import { classify, STATUS_LABELS } from '../lib/dueCheck';
import { formatLocalDueAt } from '../lib/time';
import type { Reminder } from '../types';

/**
 * The props this row renders from and delegates to.
 *
 * Every property is required and none is optional. A row always has a reminder to render and an
 * instant to classify it against, and both callbacks are supplied by the parent: the row never calls
 * the API, never writes a field and never changes the list itself.
 */
export interface ReminderItemProps {
  /** The reminder to render, exactly as it was received from the API. */
  reminder: Reminder;

  /** The current instant as an absolute ISO-8601 string, used to classify the reminder. */
  now: string;

  /** Called with the reminder's id when its Complete control is used. */
  onComplete: (id: string) => void;

  /** Called with the reminder's id when its Delete control is used. */
  onRemove: (id: string) => void;
}

/**
 * Renders one reminder as a list row.
 *
 * @param props The reminder to render, the instant to classify it against, and the two callbacks the
 *   row's controls delegate to.
 * @returns The row: its text, its due time in the viewer's local zone, its status word, and its
 *   Complete (when it is not yet completed) and Delete controls.
 */
export function ReminderItem({
  reminder,
  now,
  onComplete,
  onRemove,
}: ReminderItemProps): JSX.Element {
  // One classification per render, used for both the modifier and the label, so the row's treatment
  // and its wording are always the same state.
  const status = classify(reminder, now);

  return (
    <li className={`reminder-item reminder-item--${status}`}>
      <p className="reminder-item__text">{reminder.text}</p>

      <time className="reminder-item__due" dateTime={reminder.dueAt}>
        {formatLocalDueAt(reminder.dueAt)}
      </time>

      <span className="reminder-item__status">{STATUS_LABELS[status]}</span>

      <div className="reminder-item__actions">
        {reminder.completed ? null : (
          <button
            type="button"
            className="reminder-item__action"
            onClick={() => onComplete(reminder.id)}
          >
            Complete
          </button>
        )}

        {/* Always rendered, and always last, so the stylesheet's danger treatment on the cluster's
            last action lands on Delete in both completion states. */}
        <button
          type="button"
          className="reminder-item__action"
          onClick={() => onRemove(reminder.id)}
        >
          Delete
        </button>
      </div>
    </li>
  );
}
