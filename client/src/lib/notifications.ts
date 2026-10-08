/**
 * The client's single notification channel arbiter: it reads the browser's notification permission,
 * requests it from a user gesture, delivers a reminder on the browser channel where that is
 * permitted, mirrors every delivery into the application's own in-app alert list, and supplies the
 * line the UI shows about the channel in use.
 *
 * This is the ONLY module in the client that touches the `Notification` global. Every consumer goes
 * through the functions below — the banner that renders the channel status and the alerts, the form
 * that spends the permission request on its submit gesture, and the due check that reports a
 * reminder becoming due — so the fallback rule exists in exactly one place, and the denied and
 * unsupported paths are exercisable as one unit.
 *
 * The rule the module exists to implement: the in-app alert is unconditional and the browser
 * notification is a best-effort addition to it. The alert is rendered by the application, never by
 * the platform, so it works whether the reading is `granted`, `denied`, still `default`, or the API
 * is absent entirely. A browser notification is attempted only when the API exists AND the reading
 * is `granted`: a reading of `denied` — and one of `default`, which behaves as denied until a
 * request succeeds — is not permission to construct one.
 *
 * The platform facts this arrangement follows from, all of them measured rather than assumed:
 *
 * - `Notification.permission` has three readings, `granted`, `denied` and `default`; the fourth
 *   state modelled here is the API being absent.
 * - `Notification.requestPermission()` must follow a user gesture, so it is never called on load.
 *   The create form's submit is the gesture; this module only supplies the call.
 * - A denied permission does NOT throw. Chrome returns a notification object and reports the
 *   failure as that object's `error` event, with nothing on the console. The
 *   `permission === 'granted'` guard is therefore the control, and the `try`/`catch` with the
 *   `error` listener is a second line of defence rather than the first.
 * - A page-scoped notification lives exactly as long as its page, which is the lifetime this
 *   application is allowed to notify in. Nothing here reaches for a service worker, a push
 *   subscription or any external delivery service.
 *
 * What this module deliberately does not do: it never reads the clock (the caller decides that a
 * reminder has become due and passes the whole reminder in), it never performs a network request,
 * it never stores anything in the browser (the alert list is transient view state), it never
 * deduplicates by reminder id (the due check's in-session claim set and the server's `notifiedAt`
 * column are what make delivery happen at most once), and it never logs reminder content.
 */

import type { Reminder } from '../types';

/**
 * The channel reading, as this module reports it: the three readings the platform has, plus the
 * state where the API does not exist at all.
 */
export type PermissionState = 'granted' | 'denied' | 'default' | 'unsupported';

/**
 * One in-app alert: the application-rendered counterpart of a browser notification.
 *
 * It carries the three values the alert surface shows and nothing else — no dismissal state, no
 * delivery state and no timestamp of its own, because an alert exists only for as long as the page
 * does and the authoritative record of the notification is the server's `notifiedAt` column.
 */
export interface InAppAlert {
  /** The id of the reminder the alert is about; used to dismiss it. */
  reminderId: string;

  /** The reminder's text, as the server returned it. */
  text: string;

  /** The reminder's due instant, as the server returned it (absolute UTC ISO-8601). */
  dueAt: string;
}

/**
 * Everything the channel surface renders, assembled in one object.
 *
 * `getChannelSnapshot` returns an object of this shape with a stable identity: the same reference
 * is handed back until the reading or the alert list actually changes. That stability is a
 * requirement of the consuming component rather than a style preference — the component reads the
 * snapshot through `useSyncExternalStore`, which re-renders indefinitely if the getter returns a
 * fresh object on every call.
 */
export interface ChannelSnapshot {
  /** The current channel reading. */
  permission: PermissionState;

  /** The line the UI shows about the channel in use, derived from `permission`. */
  bannerText: string;

  /** The alerts currently on screen, oldest first. */
  alerts: readonly InAppAlert[];
}

/**
 * The title of every browser notification this module constructs.
 *
 * Deliberately short and fixed: the reminder's own text belongs in the notification body, which is
 * the part the platform renders as its message.
 */
const BROWSER_NOTIFICATION_TITLE = 'Reminder';

/**
 * The one mapping from a channel reading to the line the UI shows, so no component re-derives it.
 *
 * The four strings are the interface's user-visible contract and are asserted character for
 * character by the tests. The `default` line carries an em dash.
 */
const BANNER_TEXT: Readonly<Record<PermissionState, string>> = {
  granted: 'Browser notifications are on.',
  denied: 'Browser notifications are blocked, so due reminders appear as in-app alerts.',
  default:
    'Notifications are not enabled yet — they will be requested when you add a reminder, and until then due reminders appear as in-app alerts.',
  unsupported: 'This browser does not support notifications, so due reminders appear as in-app alerts.',
};

/**
 * The registered subscribers. Private on purpose: no consumer reads the module's state directly, it
 * reads the snapshot, and nothing outside this module can replace or clear the listener set.
 */
const listeners = new Set<() => void>();

/**
 * The alerts currently on screen. Replaced by a NEW array on every change rather than mutated, so a
 * snapshot holding the previous array keeps its identity until it is rebuilt.
 */
let alerts: readonly InAppAlert[] = [];

/**
 * The assembled snapshot, reused while nothing it carries has changed.
 */
let cachedSnapshot: ChannelSnapshot | null = null;

/**
 * The reading a completed permission request was made from, and the reading it produced.
 *
 * The browser updates `Notification.permission` itself when the user answers a prompt, but a test
 * double need not, and some environments report the new reading late. These two keep the resolved
 * answer authoritative while the platform still reports the old one: the override applies only
 * while the global reading is still the one the request was made from, so a later change made by
 * the user outside the page (unblocking notifications, for instance) immediately wins over it.
 */
let requestedFrom: PermissionState | null = null;
let requestedTo: PermissionState | null = null;

/**
 * The parts of the `Notification` global this module reads, typed permissively.
 *
 * The DOM library types the global as the full `Notification` constructor; reading it through this
 * shape is what lets the module treat `permission` as a value of unknown quality and
 * `requestPermission` as possibly missing or not callable, instead of assuming every environment —
 * and every test double — provides both.
 */
interface NotificationApiShape {
  readonly permission?: unknown;
  readonly requestPermission?: unknown;
}

/**
 * Resolves the `Notification` global, or `null` when the API does not exist in this environment.
 *
 * Every access to the global starts here, so the "is the API there at all" decision is made once.
 */
function readNotificationApi(): NotificationApiShape | null {
  if (typeof Notification === 'undefined') {
    return null;
  }

  return Notification as unknown as NotificationApiShape;
}

/**
 * Narrows an unknown value to one of the three readings the platform defines.
 */
function isBrowserPermission(value: unknown): value is 'granted' | 'denied' | 'default' {
  return value === 'granted' || value === 'denied' || value === 'default';
}

/**
 * Reads the platform's own reading, without applying any override this session recorded.
 *
 * @returns `unsupported` when the API is absent, the reported reading when it is one of the three
 *   the platform defines, and `default` for anything else — an unrecognised value, a missing one, or
 *   a `permission` accessor that throws. `default` is the safe fallback because it permits no
 *   browser notification while the in-app alert, which needs no permission, still fires.
 */
function readGlobalPermission(): PermissionState {
  const api = readNotificationApi();
  if (api === null) {
    return 'unsupported';
  }

  let reading: unknown;
  try {
    reading = api.permission;
  } catch {
    return 'default';
  }

  return isBrowserPermission(reading) ? reading : 'default';
}

/**
 * The channel reading this module reports: the platform's reading, unless a permission request
 * completed in this session and the platform has not moved on from the reading it was made from.
 */
function readPermission(): PermissionState {
  const globalReading = readGlobalPermission();

  if (requestedTo !== null && globalReading === requestedFrom) {
    return requestedTo;
  }

  return globalReading;
}

/**
 * Tells every subscriber that the snapshot may have changed.
 *
 * The listener set is copied before it is walked, so a subscriber that subscribes or unsubscribes
 * while it is being notified cannot alter the set under the iteration. A subscriber that throws is
 * contained: it is the UI's problem, and it must not stop the remaining subscribers from learning
 * about a change, nor break the delivery path that reported it. Nothing is logged — the failure
 * could carry reminder content, and this module never logs reminder content.
 */
function emit(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // Contained on purpose; see the description above.
    }
  }
}

/**
 * The `error` event listener attached to every browser notification this module constructs.
 *
 * It exists so the platform has a destination for a refused notification — Chrome reports a denied
 * permission as this event rather than by throwing — and so a refused delivery never surfaces to
 * the page as an unhandled error. It does nothing further on purpose: the in-app alert is already
 * on screen and is the guarantee, so there is nothing to repair, nothing to re-alert and no
 * reminder content to log. This is an intentional no-op, not unfinished work.
 */
function handleBrowserNotificationFailure(): void {
  // No statement by design; the description above is the whole behaviour.
}

/**
 * The current channel snapshot: the reading, the line the UI shows for it, and the alerts on screen.
 *
 * The reading is recomputed from the global on every call, because the user can change it outside
 * the page at any moment. The returned object, however, is reused until something it carries
 * changes: a fresh object on every call would make a `useSyncExternalStore` consumer re-render
 * indefinitely.
 *
 * @returns The snapshot, whose identity changes only when the reading or the alert list changes.
 */
export function getChannelSnapshot(): ChannelSnapshot {
  const permission = readPermission();

  if (
    cachedSnapshot === null ||
    cachedSnapshot.permission !== permission ||
    cachedSnapshot.alerts !== alerts
  ) {
    cachedSnapshot = {
      permission,
      bannerText: BANNER_TEXT[permission],
      alerts,
    };
  }

  return cachedSnapshot;
}

/**
 * Registers a listener that is told whenever the snapshot may have changed.
 *
 * @param listener Called after a reading change, an alert appended or an alert dismissed.
 * @returns A function that removes the listener; calling it twice is harmless.
 */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

/**
 * Asks the browser for notification permission, from inside a user gesture.
 *
 * The reading decides everything. `granted`, `denied` and `unsupported` resolve immediately with the
 * reading already held and never touch the browser: a `denied` reading is never re-requested, because
 * a repeat cannot succeed and prompting again is hostile to the user. Only a `default` reading calls
 * `Notification.requestPermission()`.
 *
 * The call is guarded on every side — an API that disappeared, a `requestPermission` that is not a
 * function, and a rejected promise all resolve to a defined reading rather than throwing — because
 * this runs inside a form submission, where an exception would take the user's reminder with it.
 *
 * @returns The reading after the request, which is the platform's answer when one was asked for.
 */
export function requestPermission(): Promise<PermissionState> {
  const current = readPermission();

  if (current !== 'default') {
    return Promise.resolve(current);
  }

  const api = readNotificationApi();
  if (api === null) {
    return Promise.resolve('unsupported');
  }

  const request = api.requestPermission;
  if (typeof request !== 'function') {
    return Promise.resolve(current);
  }

  return completeRequest(api, request as (this: unknown) => unknown, current);
}

/**
 * Awaits the platform's answer and records it as this session's reading.
 *
 * @param api The resolved `Notification` global, which the request is called on so `this` is right.
 * @param request The `requestPermission` function, already checked to be callable.
 * @param requestedFromReading The reading the request was made from, which is `default`.
 * @returns The reading after the request; subscribers are notified when it changed.
 */
async function completeRequest(
  api: NotificationApiShape,
  request: (this: unknown) => unknown,
  requestedFromReading: PermissionState,
): Promise<PermissionState> {
  let outcome: unknown;

  try {
    outcome = await request.call(api);
  } catch {
    // A rejected request is not a reading. The browser may still have answered and updated the
    // global, so the reading is recomputed below rather than assumed to be what it was.
    outcome = undefined;
  }

  const previous = readPermission();
  const resolved = isBrowserPermission(outcome) ? outcome : readGlobalPermission();

  requestedFrom = requestedFromReading;
  requestedTo = resolved;

  const next = readPermission();
  if (next !== previous) {
    emit();
  }

  return next;
}

/**
 * Reports a reminder to the user on both channels the module owns.
 *
 * The in-app alert is appended unconditionally and first: it is the surface that works in every
 * reading and with no API at all, so nothing below it can take it away. The browser notification is
 * then attempted only when the API exists and the reading is `granted`, and every failure mode is
 * contained — a refused construction, a platform that reports the refusal through the notification's
 * `error` event, and a platform that has no constructor at all all leave the alert standing. Nothing
 * is rethrown, nothing is re-alerted and no reminder content is logged.
 *
 * There is no deduplication by reminder id here. Delivery happens at most once because the due check
 * claims each reminder in session and the server records the claim; a second call for the same
 * reminder would legitimately mean a second delivery.
 *
 * @param reminder The reminder that has become due, as the server returned it.
 */
export function notify(reminder: Reminder): void {
  alerts = [
    ...alerts,
    {
      reminderId: reminder.id,
      text: reminder.text,
      dueAt: reminder.dueAt,
    },
  ];
  emit();

  const reading = readPermission();
  if (typeof Notification === 'undefined' || reading !== 'granted') {
    return;
  }

  try {
    const delivered = new Notification(BROWSER_NOTIFICATION_TITLE, {
      body: reminder.text,
      tag: `reminder-${reminder.id}`,
    });

    if (typeof delivered.addEventListener === 'function') {
      delivered.addEventListener('error', handleBrowserNotificationFailure);
    }
  } catch {
    // The platform refused the notification — a mobile browser, or a reading that changed between
    // the check above and this line. The alert is on screen; there is nothing further to do.
  }
}

/**
 * Removes the alert carrying that reminder's id.
 *
 * @param reminderId The reminder whose alert should go. An id no alert carries is a no-op, not an
 *   error: a dismiss control can be reached twice, or after the alert has already been removed.
 */
export function dismissAlert(reminderId: string): void {
  const remaining = alerts.filter((alert) => alert.reminderId !== reminderId);

  if (remaining.length === alerts.length) {
    return;
  }

  alerts = remaining;
  emit();
}
