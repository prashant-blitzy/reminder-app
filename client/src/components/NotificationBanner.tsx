/**
 * The channel-status line and the in-app alert region: the surface that tells the user which
 * notification channel is in use, and that shows every reminder the due check has reported as due.
 *
 * Why this component renders its region unconditionally: the in-app alert is the WHOLE notification
 * surface whenever the reading is `denied`, whenever it is still `default`, and whenever the browser
 * has no Notification API at all. A region that appeared only once there was something to show — or
 * only for a reading that permits browser notifications — would leave the application with no way to
 * tell the user a reminder had come due in exactly the cases where the alert is the only channel left.
 * So the status line and the list are always in the document, and an empty list is a rendered fact
 * (the stylesheet reserves its height for precisely that reason), not a reason to return `null`.
 *
 * Where every decision lives: nowhere in this file. The component is presentational, and it reads
 * everything through `client/src/lib/notifications.ts`, which is the only module that touches the
 * `Notification` global and the only one that decides the channel in use.
 *
 * - The status line is `snapshot.bannerText`, rendered verbatim. The four sentences are that module's
 *   literals, so this file never branches on the permission reading, never builds or paraphrases a
 *   sentence, and needs no change when a sentence changes.
 * - An alert is appended by `notify`, which the due check calls; dismissing one removes it through
 *   `dismissAlert`. This file neither appends nor removes anything itself.
 * - A stored instant is formatted for the viewer only by `formatLocalDueAt` from
 *   `client/src/lib/time.ts`. This file therefore reads no clock at all: it does not call `new Date`,
 *   `Date.parse`, `toLocaleString` or `Intl`, because a second representation change anywhere in the
 *   client is the defect that arrangement exists to prevent.
 *
 * How it subscribes: `useSyncExternalStore(subscribe, getChannelSnapshot)`. The module hands back a
 * CACHED snapshot whose identity changes only when the reading or the alert list actually changes,
 * which is what makes the store safe to read on every render and is why the snapshot is used as it
 * arrives — never copied into `useState`, never mirrored by an effect, never rebuilt into a new object
 * during render. Any of those would either discard the module's identity guarantee or re-render
 * indefinitely against it.
 *
 * What it deliberately does not do: no props (the module owns the state), no state, effects, refs or
 * timers; no network request and no storage of any kind; no knowledge of the server (the client and
 * the server meet over HTTP only); no reminder classification of its own (a row's Upcoming, Overdue or
 * Completed label comes from `client/src/lib/dueCheck.ts`, and an alert carries only what the server
 * returned); and no error banner — the application's one error banner belongs to the list.
 */

import { useSyncExternalStore } from 'react';

import { dismissAlert, getChannelSnapshot, subscribe } from '../lib/notifications';
import { formatLocalDueAt } from '../lib/time';

/**
 * Renders the current channel status above the in-app alerts, and nothing else.
 *
 * The alerts are rendered in the order the snapshot supplies them, one list item per alert keyed by
 * the reminder's id, with no sorting, filtering or deduplication: the snapshot's order is the order in
 * which the due check reported them, and delivery happens at most once because the due check claims
 * each reminder in session and the server records the claim, so a second entry for one reminder would
 * mean a second delivery rather than a duplicate to hide.
 */
export function NotificationBanner() {
  const snapshot = useSyncExternalStore(subscribe, getChannelSnapshot);

  return (
    <section className="notification-banner">
      <p className="notification-banner__status">{snapshot.bannerText}</p>

      {/* A live region: an alert that arrives while the user is reading the list is announced
          without moving focus. `polite` is what keeps the announcement from interrupting whatever
          they are doing, which suits a reminder that has no deadline of its own. */}
      <ul className="notification-banner__alerts" aria-live="polite">
        {snapshot.alerts.map((alert) => {
          // Formatted once per alert and used for both the visible due time and the dismiss
          // control's accessible name, so the two can never disagree.
          const dueText = formatLocalDueAt(alert.dueAt);

          return (
            <li className="alert" key={alert.reminderId}>
              <span className="alert__text">{alert.text}</span>
              <span className="alert__due">{dueText}</span>
              {/* Named after the reminder it dismisses: several alerts can be on screen at once,
                  and a row of identical "Dismiss" buttons would leave a screen-reader user unable
                  to tell which reminder each one belongs to. The visible word is the first word of
                  the accessible name, so the spoken label still matches what is read on screen. */}
              <button
                type="button"
                className="alert__dismiss"
                aria-label={`Dismiss alert: ${alert.text}`}
                onClick={() => dismissAlert(alert.reminderId)}
              >
                Dismiss
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * Default export of the same component.
 *
 * `client/src/App.tsx`, the screen that renders this one, is written from a separate brief, so the
 * import form it uses is not knowable from here. Exporting both forms keeps either choice working
 * without an edit to this file: a named import (`import { NotificationBanner } from './components/…'`)
 * and a default import both resolve to the single implementation above, which has no props for either
 * caller to pass. There is exactly one component here, not two.
 */
export default NotificationBanner;
