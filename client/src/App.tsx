/**
 * The screen: one main view holding the four regions of the reminder app, in the order they are used,
 * plus the state those regions share.
 *
 * This is the composition root of the client and deliberately nothing more. It renders; it issues no
 * request, schedules nothing, validates nothing, converts no time, reads no clock and notifies no one.
 * Each of those responsibilities has exactly one owner in this tree — the two hooks for the list, its
 * four operations and the schedule, the components for the regions themselves, and the five shared
 * modules under `lib/` beneath them — so this file imports the two hooks and the three components and
 * reimplements none of what they do.
 *
 * THE REGIONS, IN THIS ORDER, BECAUSE THE ORDER IS THE ORDER OF USE:
 *
 * 1. The heading, naming the screen. It is the document's single `<h1>` and its text matches the
 *    document title the client's entry page declares.
 * 2. `NotificationBanner` — what the app is telling you: the channel in use, and the in-app alerts for
 *    reminders that have come due. It takes no props; it subscribes to the notification module's store
 *    itself, so the channel reading and the alert list have one owner rather than one per consumer.
 * 3. `ReminderForm` — what you add. The form owns its three inputs and its inline messages and hands
 *    the create call straight back to this component, so the request, the list update and the error
 *    state stay here with the list they belong to.
 * 4. `ReminderList` — what you have: the ordered rows, their loading and empty states, and the
 *    application's single error banner.
 *
 * WHY THE DUE CHECK IS STARTED HERE, ONCE, AT THIS LEVEL: a notification is delivered only while this
 * page is open, and the hook that delivers it stops when the component that mounted it unmounts. So
 * the mounted screen is exactly the lifetime notification is permitted in, and starting the check
 * anywhere deeper — in the list, the form or the banner — would tie it to a region that may come and
 * go, or start a second instance alongside the first. One call, at the top, is the whole arrangement.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT HOLD: no second copy of the reminders. The list arrives from
 * `useReminders` and is passed straight through, never mirrored into local state, never appended to
 * optimistically and never reordered, because the screen must never present a reminder as saved when
 * the server did not store it (the hook updates the array only from a server response or a re-read).
 * For the same reason no browser storage of any kind appears here, and no HTTP call does either:
 * reminder data is the server's, and the client's one HTTP caller belongs to the hook that owns it.
 *
 * The class names used here are the fixed vocabulary `client/src/styles.css` carries a rule for:
 * `app` and `app__title`, and nothing else. The regions style themselves.
 */

import { NotificationBanner } from './components/NotificationBanner';
import { ReminderForm } from './components/ReminderForm';
import { ReminderList } from './components/ReminderList';
import { useDueCheck } from './hooks/useDueCheck';
import { useReminders } from './hooks/useReminders';

/**
 * Renders the reminder screen and starts the due check.
 *
 * @returns The screen: the heading, the channel-status and alert region, the create form, and the
 *   ordered list with its one error banner.
 */
export default function App() {
  // The screen's own state: the list as the server last reported it, whether it is loading, the
  // message of the last failed list, completion or deletion, and the four operations the form and the
  // rows delegate back here. `load` is the banner's retry control; `create` goes to the form;
  // `complete` and `remove` go to the rows.
  const {
    reminders,
    loading,
    error: listError,
    load,
    create,
    complete,
    remove,
  } = useReminders();

  // The due check, started by the mounted screen and nowhere else. It reports the instant the last run
  // decided against, which is threaded straight to the list below, so a row's Upcoming/Overdue/
  // Completed label and the decision to notify are computed from the same clock read — one instant,
  // one verdict, no chance of the row and the notification disagreeing.
  const { now, error: claimError } = useDueCheck(reminders);

  // ONE FAILURE, ONE BANNER. This component owns the message; `ReminderList` owns the markup (the
  // `role="alert"` region and its retry control), so there is exactly one banner in the document and
  // no failure is reported twice. The list's own failure wins — it is what the user just did — over a
  // background failure from the notification claim; `??` is used rather than `||` so an empty-string
  // message still counts as a message and is never silently replaced by the other one.
  const error = listError ?? claimError;

  return (
    <main className="app">
      <h1 className="app__title">Reminders</h1>

      <NotificationBanner />

      <ReminderForm create={create} />

      <ReminderList
        reminders={reminders}
        loading={loading}
        now={now}
        error={error}
        onRetry={load}
        onComplete={complete}
        onRemove={remove}
      />
    </main>
  );
}
