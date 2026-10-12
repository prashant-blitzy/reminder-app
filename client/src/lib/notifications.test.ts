/**
 * Tests for `./notifications` — the client's single notification channel arbiter.
 *
 * This suite is the evidence for the request's channel requirements: with permission `granted` BOTH
 * channels fire; with permission `denied`, with the reading still at `default`, and with no
 * `Notification` API at all, the in-app alert is the whole notification surface and NO browser
 * notification is attempted; each reading has its own banner line; and a repeat delivery carries the
 * same `tag`, which is what makes the platform replace a notification rather than stack it.
 *
 * The alert-only readings matter as much as the granted one. `default` is the reading every browser
 * starts in, so the alert-only path is the state the application is in from its first render until
 * the user's first reminder creation — no prompt shown and no browser call attempted — while `denied`
 * and the absent API are the readings the request requires the feature to keep working under.
 *
 * Four properties of this file are deliberate:
 *
 * - Every case loads a FRESH instance of the module: `vi.resetModules()` followed by a dynamic
 *   `import('./notifications')`. The module keeps private state — the alert list, the subscriber set
 *   and a cached snapshot — and deliberately exports no test-only reset, so a static import would let
 *   one case inherit what another left behind and make the suite depend on its own case order.
 * - The fake `Notification` global records every constructor call in an array the case owns, so "no
 *   browser notification was attempted" is asserted as an EMPTY array. That negative is the
 *   assertion whose absence would let a double-notifying defect ship.
 * - `describe`, `it`, `expect`, `vi` and `afterEach` are the vitest globals (`globals: true` in
 *   `client/vite.config.ts`), so the only import is the type the reminders are built with.
 * - Nothing here reads the wall clock, uses fake timers, touches the network, or names `process`
 *   (this workspace declares no `@types/node`). `notify` takes a whole reminder, so a fixed set of
 *   reminder objects is all the suite needs.
 *
 * What this suite deliberately does not assert: that no service-worker, push-subscription or
 * external delivery path is reachable. Those must not exist in the module at all, so the check for
 * their absence is a grep over `client/src/lib/notifications.ts` rather than a runtime assertion here.
 */

import type { Reminder } from '../types';

/**
 * The banner line the module shows for each channel reading.
 *
 * The four strings are the interface's user-visible contract, so they are repeated here character
 * for character from `./notifications` on purpose: these constants are what a rewording of a line
 * would break, and duplicating them is the point rather than an oversight. The `default` line
 * carries an em dash.
 */
const GRANTED_BANNER = 'Browser notifications are on.';
const DENIED_BANNER = 'Browser notifications are blocked, so due reminders appear as in-app alerts.';
const DEFAULT_BANNER =
  'Notifications are not enabled yet — they will be requested when you add a reminder, and until then due reminders appear as in-app alerts.';
const UNSUPPORTED_BANNER =
  'This browser does not support notifications, so due reminders appear as in-app alerts.';

/**
 * The fixed title of every browser notification the module constructs.
 *
 * Short and unchanging on purpose: the reminder's own text belongs in the notification body, which
 * is the part the platform renders as its message.
 */
const BROWSER_NOTIFICATION_TITLE = 'Reminder';

/** The module under test, as a freshly loaded instance. */
type NotificationsModule = typeof import('./notifications');

/** One call the code under test made on the fake `Notification` constructor. */
interface BrowserCall {
  /** The notification's title: the constructor's first argument. */
  readonly title: unknown;

  /** The notification's options: the constructor's second argument. */
  readonly options: unknown;
}

/** How the fake global's `requestPermission` behaves when the code under test calls it. */
type RequestBehaviour = 'granted' | 'denied' | 'default' | 'reject' | 'missing' | 'not-a-function';

/** How the fake global's constructor behaves. */
type ConstructorBehaviour = 'record' | 'throw';

/** A notification the fake constructed, as much of it as the module touches. */
interface FakeNotificationHandle {
  /** Fires the notification's `error` event, the way a platform that refuses delivery does. */
  fireError(): void;
}

/** What one case drove on the fake browser channel, and how to move it. */
interface FakeBrowserChannel {
  /**
   * The constructor calls made on the fake global, oldest first.
   *
   * An EMPTY array is the assertion that no browser notification was attempted.
   */
  readonly calls: readonly BrowserCall[];

  /**
   * The `error` listeners the constructed notifications registered, oldest first.
   *
   * Listed so a case can assert the module gave the platform a destination for a refused delivery
   * rather than leaving it to surface as an unhandled error.
   */
  readonly errorListeners: readonly (() => void)[];

  /** The notification objects the fake handed back, so a case can fire one's `error` event. */
  readonly created: readonly FakeNotificationHandle[];

  /** How many times the fake's `requestPermission` was called. */
  requestPermissionCalls(): number;

  /** Sets the reading the fake reports, as the platform does when the user changes it. */
  setPermission(reading: unknown): void;

  /** Sets how the fake's `requestPermission` behaves. */
  setRequestPermission(behaviour: RequestBehaviour): void;

  /** Sets how the fake's constructor behaves. */
  setConstructor(behaviour: ConstructorBehaviour): void;
}

/**
 * Builds a recording `Notification` fake, stubs it into the global scope, and hands back the record
 * of what the code under test did with it.
 *
 * jsdom implements no notification API and `client/src/setupTests.ts` installs no stub, so the case
 * that wants a browser channel has to provide one itself. The fake is a class because the module
 * constructs the global with `new`, and it records the constructor's arguments in an array the case
 * can assert on — which is what turns "no browser notification was attempted" from an assumption
 * into a checked negative.
 *
 * @param reading The reading the fake reports, exactly as `Notification.permission` would.
 * @returns The record and the controls, with the fake already installed as the global.
 */
function installFakeBrowserChannel(reading: unknown): FakeBrowserChannel {
  const calls: BrowserCall[] = [];
  const errorListeners: Array<() => void> = [];
  const created: FakeNotificationHandle[] = [];

  let constructorBehaviour: ConstructorBehaviour = 'record';
  let requestPermissionCalls = 0;

  class FakeNotification implements FakeNotificationHandle {
    static permission?: unknown;

    static requestPermission?: unknown;

    /** The listeners this notification registered, so its `error` event can be fired. */
    readonly instanceListeners: Array<() => void> = [];

    constructor(title: unknown, options?: unknown) {
      if (constructorBehaviour === 'throw') {
        throw new Error('the platform refused to construct a notification');
      }

      calls.push({ title, options });
      created.push(this);
    }

    addEventListener(type: string, listener: unknown): void {
      if (type !== 'error' || typeof listener !== 'function') {
        return;
      }

      const errorListener = listener as () => void;
      this.instanceListeners.push(errorListener);
      errorListeners.push(errorListener);
    }

    fireError(): void {
      for (const listener of this.instanceListeners) {
        listener();
      }
    }
  }

  FakeNotification.permission = reading;
  // The default request behaviour answers `granted`, which is the reading the upgrade path produces.
  // A case that needs another answer, a rejection, or no callable member at all replaces it below.
  FakeNotification.requestPermission = (): Promise<unknown> => {
    requestPermissionCalls += 1;
    return Promise.resolve('granted');
  };

  vi.stubGlobal('Notification', FakeNotification);

  function setRequestPermission(behaviour: RequestBehaviour): void {
    if (behaviour === 'missing') {
      delete FakeNotification.requestPermission;
      return;
    }

    if (behaviour === 'not-a-function') {
      // A member that exists but cannot be called: the module checks `typeof` before calling it.
      FakeNotification.requestPermission = 'not callable';
      return;
    }

    FakeNotification.requestPermission = (): Promise<unknown> => {
      requestPermissionCalls += 1;

      if (behaviour === 'reject') {
        return Promise.reject(new Error('the user dismissed the prompt'));
      }

      return Promise.resolve(behaviour);
    };
  }

  return {
    calls,
    errorListeners,
    created,
    requestPermissionCalls: () => requestPermissionCalls,
    setPermission: (next: unknown): void => {
      FakeNotification.permission = next;
    },
    setRequestPermission,
    setConstructor: (behaviour: ConstructorBehaviour): void => {
      constructorBehaviour = behaviour;
    },
  };
}

/**
 * Stubs the global as a browser that has no `Notification` API at all.
 *
 * `vi.stubGlobal('Notification', undefined)` is what makes the module's own guard —
 * `typeof Notification === 'undefined'` — take the unsupported branch.
 */
function installAbsentNotificationApi(): void {
  vi.stubGlobal('Notification', undefined);
}

/**
 * Loads a fresh instance of the module under test.
 *
 * `vi.resetModules()` clears vitest's module registry, so the dynamic import that follows evaluates
 * `./notifications` again from source: the alert list is empty, no snapshot is cached and no
 * subscriber is registered. Without this, a case would inherit the state of whichever case ran
 * before it.
 *
 * @returns The module, with no state carried over from any earlier case.
 */
async function loadNotifications(): Promise<NotificationsModule> {
  vi.resetModules();
  return import('./notifications');
}

/**
 * Builds one reminder in the shape the server returns.
 *
 * All six keys are always present, because the client contract in `client/src/types.ts` says a
 * response body always carries them; only the values a case cares about are named.
 *
 * @param overrides The values to differ from the defaults.
 * @returns A complete, well-formed reminder.
 */
function makeReminder(overrides: {
  id?: string;
  text?: string;
  dueAt?: string;
  completed?: boolean;
  notifiedAt?: string | null;
  createdAt?: string;
} = {}): Reminder {
  return {
    id: overrides.id ?? 'reminder-1',
    text: overrides.text ?? 'Water the plants',
    dueAt: overrides.dueAt ?? '2026-11-01T05:30:00.000Z',
    completed: overrides.completed ?? false,
    notifiedAt: overrides.notifiedAt ?? null,
    createdAt: overrides.createdAt ?? '2026-10-31T23:00:00.000Z',
  };
}

/** Reads one option out of the constructor's second argument, whatever the module passed. */
function readOption(options: unknown, key: string): unknown {
  if (typeof options !== 'object' || options === null) {
    return undefined;
  }

  return (options as Record<string, unknown>)[key];
}

/**
 * Asserts that no browser notification was attempted.
 *
 * The negative every alert-only case is built on: an empty record of constructor calls is what
 * proves the module did not reach for the browser channel.
 */
function expectNoBrowserCall(channel: FakeBrowserChannel): void {
  expect(channel.calls, 'no browser notification may be constructed in this reading').toHaveLength(0);
}

/** Asserts exactly one browser notification was constructed and returns its recorded arguments. */
function expectOneBrowserCall(channel: FakeBrowserChannel): BrowserCall {
  expect(channel.calls, 'exactly one browser notification must be constructed').toHaveLength(1);

  const [call] = channel.calls;
  if (call === undefined) {
    throw new Error('no browser notification call was recorded');
  }

  return call;
}

// Each case installs its own Notification stub, so each case restores the global it found: an
// unstubbed global, where `typeof Notification === 'undefined'` is the unsupported reading.
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a reminder becoming due with permission granted', () => {
  const grantedReminder = makeReminder({ id: 'reminder-granted', text: 'Take the medication' });

  /** Delivers that reminder on a granted channel and hands back what the delivery touched. */
  async function deliverGranted(): Promise<{
    channel: FakeBrowserChannel;
    notifications: NotificationsModule;
  }> {
    const channel = installFakeBrowserChannel('granted');
    const notifications = await loadNotifications();
    notifications.notify(grantedReminder);

    return { channel, notifications };
  }

  it('appends exactly one in-app alert carrying the reminder id, text and due instant', async () => {
    const { notifications } = await deliverGranted();

    const snapshot = notifications.getChannelSnapshot();
    expect(snapshot.permission).toBe('granted');
    expect(snapshot.alerts).toHaveLength(1);

    const [alert] = snapshot.alerts;
    expect(alert?.reminderId).toBe(grantedReminder.id);
    expect(alert?.text).toBe(grantedReminder.text);
    expect(alert?.dueAt).toBe(grantedReminder.dueAt);
  });

  it('constructs exactly one browser notification whose body is the reminder text', async () => {
    const { channel } = await deliverGranted();

    const call = expectOneBrowserCall(channel);
    expect(call.title).toBe(BROWSER_NOTIFICATION_TITLE);
    expect(readOption(call.options, 'body')).toBe(grantedReminder.text);
  });

  it('tags that notification with the reminder id, so the platform can replace it', async () => {
    const { channel } = await deliverGranted();

    const call = expectOneBrowserCall(channel);
    expect(readOption(call.options, 'tag')).toBe(`reminder-${grantedReminder.id}`);
  });

  it('shows the granted banner line', async () => {
    // The stub is installed for its effect only; this case reads the banner, not the call record.
    installFakeBrowserChannel('granted');
    const notifications = await loadNotifications();

    const snapshot = notifications.getChannelSnapshot();
    expect(snapshot.permission).toBe('granted');
    expect(snapshot.bannerText).toBe(GRANTED_BANNER);
  });

  it('stamps the same tag on a repeat delivery, so a repeat replaces rather than stacks', async () => {
    const { channel, notifications } = await deliverGranted();

    notifications.notify(grantedReminder);

    expect(channel.calls).toHaveLength(2);

    const [first, second] = channel.calls;
    const firstTag = readOption(first?.options, 'tag');
    expect(firstTag).toBe(`reminder-${grantedReminder.id}`);
    // One tag per reminder is the whole anti-stacking mechanism: the platform replaces a
    // notification that shares a tag, so a repeat delivery cannot leave two on screen.
    expect(readOption(second?.options, 'tag')).toBe(firstTag);
  });
});

describe('a reminder becoming due with permission denied', () => {
  it('appends the in-app alert and attempts no browser notification', async () => {
    const reminder = makeReminder({ id: 'reminder-denied', text: 'Call the dentist' });
    const channel = installFakeBrowserChannel('denied');
    const notifications = await loadNotifications();

    expect(() => notifications.notify(reminder)).not.toThrow();

    const snapshot = notifications.getChannelSnapshot();
    expect(snapshot.permission).toBe('denied');
    expect(snapshot.alerts).toHaveLength(1);
    expect(snapshot.alerts[0]?.reminderId).toBe(reminder.id);
    expect(snapshot.alerts[0]?.text).toBe(reminder.text);
    expectNoBrowserCall(channel);
  });

  it('shows the blocked banner line', async () => {
    installFakeBrowserChannel('denied');
    const notifications = await loadNotifications();

    expect(notifications.getChannelSnapshot().bannerText).toBe(DENIED_BANNER);
  });
});

describe('a reminder becoming due with the reading still at default', () => {
  it('appends the in-app alert and attempts no browser notification', async () => {
    // `default` is the reading every browser starts in, so this is the state the app is in from its
    // first render until the user's first reminder creation: the alert is the whole surface, and the
    // API being present is not permission to use it.
    const reminder = makeReminder({ id: 'reminder-default', text: 'Book the tickets' });
    const channel = installFakeBrowserChannel('default');
    const notifications = await loadNotifications();

    expect(() => notifications.notify(reminder)).not.toThrow();

    const snapshot = notifications.getChannelSnapshot();
    expect(snapshot.permission).toBe('default');
    expect(snapshot.alerts).toHaveLength(1);
    expect(snapshot.alerts[0]?.text).toBe(reminder.text);
    expectNoBrowserCall(channel);
  });

  it('shows the not-enabled-yet banner line', async () => {
    installFakeBrowserChannel('default');
    const notifications = await loadNotifications();

    // Compared with an exact match, em dash included: the line is user-visible text, and a loose
    // matcher would accept a reworded one.
    expect(notifications.getChannelSnapshot().bannerText).toBe(DEFAULT_BANNER);
  });
});

describe('a reminder becoming due with no Notification API at all', () => {
  it('reports the reading as unsupported and still appends the in-app alert', async () => {
    const reminder = makeReminder({ id: 'reminder-unsupported', text: 'Renew the passport' });
    installAbsentNotificationApi();
    const notifications = await loadNotifications();

    expect(() => notifications.notify(reminder)).not.toThrow();

    const snapshot = notifications.getChannelSnapshot();
    expect(snapshot.permission).toBe('unsupported');
    expect(snapshot.alerts).toHaveLength(1);
    expect(snapshot.alerts[0]?.reminderId).toBe(reminder.id);
    expect(snapshot.alerts[0]?.text).toBe(reminder.text);
  });

  it('shows the unsupported-browser banner line', async () => {
    installAbsentNotificationApi();
    const notifications = await loadNotifications();

    expect(notifications.getChannelSnapshot().bannerText).toBe(UNSUPPORTED_BANNER);
  });

  it('throws from nothing the due check would call', async () => {
    const reminder = makeReminder({ id: 'reminder-absent-api' });
    installAbsentNotificationApi();
    const notifications = await loadNotifications();

    // The whole notify path, the snapshot read and the dismiss control, with the API absent: a
    // browser without notifications must still run the reminder feature end to end.
    expect(() => notifications.notify(reminder)).not.toThrow();
    expect(notifications.getChannelSnapshot().alerts).toHaveLength(1);
    expect(() => notifications.dismissAlert(reminder.id)).not.toThrow();
    expect(notifications.getChannelSnapshot().alerts).toHaveLength(0);
    await expect(notifications.requestPermission()).resolves.toBe('unsupported');
  });
});

describe('requestPermission — the browser is contacted only from the default reading', () => {
  it('resolves granted without contacting the browser', async () => {
    const channel = installFakeBrowserChannel('granted');
    channel.setRequestPermission('denied');
    const notifications = await loadNotifications();

    await expect(notifications.requestPermission()).resolves.toBe('granted');

    expect(channel.requestPermissionCalls(), 'the browser must not be asked again').toBe(0);
  });

  it('resolves denied and never re-requests it, because a repeat cannot succeed', async () => {
    const channel = installFakeBrowserChannel('denied');
    // A fake that WOULD grant if it were asked makes the zero-call assertion mean something.
    channel.setRequestPermission('granted');
    const notifications = await loadNotifications();

    await expect(notifications.requestPermission()).resolves.toBe('denied');

    expect(channel.requestPermissionCalls(), 'a denied reading must never be re-requested').toBe(0);
    expect(notifications.getChannelSnapshot().permission).toBe('denied');
  });

  it('resolves unsupported with the API absent, touching nothing and throwing nothing', async () => {
    installAbsentNotificationApi();
    const notifications = await loadNotifications();

    await expect(notifications.requestPermission()).resolves.toBe('unsupported');
    expect(notifications.getChannelSnapshot().permission).toBe('unsupported');
  });

  it('calls the browser exactly once from default and adopts the answer as the reading', async () => {
    const channel = installFakeBrowserChannel('default');
    channel.setRequestPermission('granted');
    const notifications = await loadNotifications();

    expect(notifications.getChannelSnapshot().permission).toBe('default');

    await expect(notifications.requestPermission()).resolves.toBe('granted');

    expect(channel.requestPermissionCalls(), 'a default reading is the one that asks').toBe(1);

    const snapshot = notifications.getChannelSnapshot();
    expect(snapshot.permission).toBe('granted');
    expect(snapshot.bannerText).toBe(GRANTED_BANNER);
  });

  it('lets the platform own the reading again once it reports a change of its own', async () => {
    const channel = installFakeBrowserChannel('default');
    channel.setRequestPermission('granted');
    const notifications = await loadNotifications();

    await expect(notifications.requestPermission()).resolves.toBe('granted');
    expect(notifications.getChannelSnapshot().permission).toBe('granted');

    // The user blocks notifications outside the page, and the platform reports the new reading: the
    // answer this session recorded must not keep overriding what the platform now says.
    channel.setPermission('denied');

    const afterBlocking = notifications.getChannelSnapshot();
    expect(afterBlocking.permission).toBe('denied');
    expect(afterBlocking.bannerText).toBe(DENIED_BANNER);
  });

  it('resolves a defined reading when the browser rejects the request', async () => {
    const channel = installFakeBrowserChannel('default');
    channel.setRequestPermission('reject');
    const notifications = await loadNotifications();

    const reading = await notifications.requestPermission();

    expect(channel.requestPermissionCalls()).toBe(1);
    const readings: ReadonlyArray<string> = ['granted', 'denied', 'default', 'unsupported'];
    expect(readings, 'a rejected request must resolve to a defined reading').toContain(reading);
    expect(notifications.getChannelSnapshot().permission).toBe(reading);
  });

  it('resolves the current reading when the browser has no requestPermission at all', async () => {
    const channel = installFakeBrowserChannel('default');
    channel.setRequestPermission('missing');
    const notifications = await loadNotifications();

    await expect(notifications.requestPermission()).resolves.toBe('default');

    expect(channel.requestPermissionCalls(), 'no callable member exists to count').toBe(0);
  });

  it('resolves the current reading when requestPermission exists but is not callable', async () => {
    const channel = installFakeBrowserChannel('default');
    channel.setRequestPermission('not-a-function');
    const notifications = await loadNotifications();

    await expect(notifications.requestPermission()).resolves.toBe('default');

    expect(channel.requestPermissionCalls(), 'a non-callable member is never called').toBe(0);
  });
});

describe('the in-app alert survives every browser-channel failure', () => {
  it('contains a constructor that throws, and still appends the alert', async () => {
    const reminder = makeReminder({ id: 'reminder-throwing', text: 'Feed the cat' });
    const channel = installFakeBrowserChannel('granted');
    channel.setConstructor('throw');
    const notifications = await loadNotifications();

    expect(() => notifications.notify(reminder)).not.toThrow();

    const snapshot = notifications.getChannelSnapshot();
    expect(snapshot.alerts).toHaveLength(1);
    expect(snapshot.alerts[0]?.reminderId).toBe(reminder.id);
    // The construction failed, so the call was never recorded and no notification object exists.
    expect(channel.calls).toHaveLength(0);
    expect(channel.created).toHaveLength(0);
  });

  it('contains a refusal the platform reports through the notification error event', async () => {
    // This is how a refused delivery actually manifests in current Chrome: the constructor returns a
    // notification and the failure arrives as that notification's `error` event, with nothing thrown
    // and nothing on the console. The permission guard is therefore the control, and this listener is
    // the destination that keeps the event from surfacing as an unhandled error.
    const reminder = makeReminder({ id: 'reminder-error-event', text: 'Pay the invoice' });
    const channel = installFakeBrowserChannel('granted');
    const notifications = await loadNotifications();

    expect(() => notifications.notify(reminder)).not.toThrow();

    expect(
      channel.errorListeners,
      'every constructed notification must give the platform somewhere to report a refusal',
    ).toHaveLength(1);

    const [delivered] = channel.created;
    expect(delivered).toBeDefined();
    expect(() => delivered?.fireError()).not.toThrow();

    const snapshot = notifications.getChannelSnapshot();
    expect(snapshot.alerts).toHaveLength(1);
    expect(snapshot.alerts[0]?.reminderId).toBe(reminder.id);
    // Firing the failure changed nothing on the browser channel: no repair, no retry, no second
    // notification — the alert already on screen is the guarantee.
    expect(channel.calls).toHaveLength(1);
  });
});

describe('dismissAlert and subscribe', () => {
  it('removes the alert carrying that reminder id', async () => {
    const reminder = makeReminder({ id: 'reminder-dismiss' });
    installFakeBrowserChannel('granted');
    const notifications = await loadNotifications();
    notifications.notify(reminder);

    expect(notifications.getChannelSnapshot().alerts).toHaveLength(1);

    notifications.dismissAlert(reminder.id);

    expect(notifications.getChannelSnapshot().alerts).toHaveLength(0);
  });

  it('leaves the list empty once every alert has been dismissed', async () => {
    const first = makeReminder({ id: 'reminder-one' });
    const second = makeReminder({ id: 'reminder-two', text: 'Second reminder' });
    installFakeBrowserChannel('denied');
    const notifications = await loadNotifications();

    notifications.notify(first);
    notifications.notify(second);
    expect(notifications.getChannelSnapshot().alerts).toHaveLength(2);

    notifications.dismissAlert(first.id);
    expect(notifications.getChannelSnapshot().alerts).toHaveLength(1);

    notifications.dismissAlert(second.id);
    expect(notifications.getChannelSnapshot().alerts).toHaveLength(0);
  });

  it('is a no-op that does not throw for an id no alert carries', async () => {
    const reminder = makeReminder({ id: 'reminder-present' });
    installFakeBrowserChannel('denied');
    const notifications = await loadNotifications();
    notifications.notify(reminder);

    expect(() => notifications.dismissAlert('reminder-absent')).not.toThrow();
    // A dismiss control can be reached twice, or after the alert is already gone: neither must take
    // the alert that is still on screen with it.
    expect(notifications.getChannelSnapshot().alerts).toHaveLength(1);
    expect(notifications.getChannelSnapshot().alerts[0]?.reminderId).toBe(reminder.id);
  });

  it('tells a subscriber about an append and about a dismiss', async () => {
    const reminder = makeReminder({ id: 'reminder-subscribed' });
    installFakeBrowserChannel('granted');
    const notifications = await loadNotifications();

    let signals = 0;
    notifications.subscribe(() => {
      signals += 1;
    });

    notifications.notify(reminder);
    expect(signals, 'the append must reach the subscriber').toBe(1);

    notifications.dismissAlert(reminder.id);
    expect(signals, 'the dismiss must reach the subscriber').toBe(2);
  });

  it('stops telling a subscriber that has unsubscribed, twice over', async () => {
    const reminder = makeReminder({ id: 'reminder-unsubscribed' });
    installFakeBrowserChannel('denied');
    const notifications = await loadNotifications();

    let signals = 0;
    const unsubscribe = notifications.subscribe(() => {
      signals += 1;
    });

    notifications.notify(reminder);
    expect(signals).toBe(1);

    unsubscribe();
    expect(() => unsubscribe(), 'unsubscribing twice is harmless').not.toThrow();

    notifications.notify(reminder);
    notifications.dismissAlert(reminder.id);
    expect(signals, 'an unsubscribed listener must hear nothing more').toBe(1);
  });

  it('keeps delivering to the remaining subscribers when one subscriber throws', async () => {
    const reminder = makeReminder({ id: 'reminder-broken-subscriber' });
    installFakeBrowserChannel('denied');
    const notifications = await loadNotifications();

    const told: string[] = [];
    notifications.subscribe(() => {
      throw new Error('a broken subscriber');
    });
    notifications.subscribe(() => {
      told.push('told');
    });

    // A subscriber's failure is the UI's problem: it must not break the delivery that reported the
    // reminder to the others, and it must not escape into the due check that called notify.
    expect(() => notifications.notify(reminder)).not.toThrow();
    expect(told).toEqual(['told']);
    expect(notifications.getChannelSnapshot().alerts).toHaveLength(1);
  });
});

describe('getChannelSnapshot — identity is stable until something changes', () => {
  it('returns the same object reference while nothing has changed', async () => {
    installFakeBrowserChannel('granted');
    const notifications = await loadNotifications();

    // `useSyncExternalStore` re-renders indefinitely if the getter returns a fresh object on every
    // call, so this identity is a requirement of the consuming component, not a style preference.
    const first = notifications.getChannelSnapshot();
    const second = notifications.getChannelSnapshot();

    expect(second).toBe(first);
  });

  it('returns a different reference after an alert is appended', async () => {
    const reminder = makeReminder({ id: 'reminder-identity-append' });
    installFakeBrowserChannel('granted');
    const notifications = await loadNotifications();

    const before = notifications.getChannelSnapshot();
    notifications.notify(reminder);
    const after = notifications.getChannelSnapshot();

    expect(after).not.toBe(before);
    expect(after.alerts).toHaveLength(1);
    expect(notifications.getChannelSnapshot()).toBe(after);
  });

  it('returns a different reference after an alert is dismissed', async () => {
    const reminder = makeReminder({ id: 'reminder-identity-dismiss' });
    installFakeBrowserChannel('granted');
    const notifications = await loadNotifications();
    notifications.notify(reminder);

    const before = notifications.getChannelSnapshot();
    notifications.dismissAlert(reminder.id);
    const after = notifications.getChannelSnapshot();

    expect(after).not.toBe(before);
    expect(after.alerts).toHaveLength(0);
    expect(notifications.getChannelSnapshot()).toBe(after);
  });

  it('returns a different reference when the platform reading changes on its own', async () => {
    const channel = installFakeBrowserChannel('default');
    const notifications = await loadNotifications();

    const before = notifications.getChannelSnapshot();
    channel.setPermission('granted');
    const after = notifications.getChannelSnapshot();

    expect(after).not.toBe(before);
    expect(after.permission).toBe('granted');
    expect(after.bannerText).toBe(GRANTED_BANNER);
  });
});

describe('the alert list is transient view state', () => {
  it('is empty again once every alert has been dismissed, with no browser notification re-attempted', async () => {
    const reminder = makeReminder({ id: 'reminder-transient' });
    const channel = installFakeBrowserChannel('denied');
    const notifications = await loadNotifications();

    notifications.notify(reminder);
    expect(notifications.getChannelSnapshot().alerts).toHaveLength(1);

    notifications.dismissAlert(reminder.id);

    const snapshot = notifications.getChannelSnapshot();
    expect(snapshot.alerts).toHaveLength(0);
    // Dismissing is a view action: nothing is re-delivered, and no browser call is made by it.
    expectNoBrowserCall(channel);
  });

  it('appends one alert per delivery, leaving at-most-once delivery to the caller and the server', async () => {
    // This module deliberately does not deduplicate by reminder id. Delivering at most once is the
    // due check's in-session claim set and the server's `notifiedAt` column, so a case that asserted
    // deduplication here would be asserting a guarantee this module does not own.
    const reminder = makeReminder({ id: 'reminder-repeated' });
    const channel = installFakeBrowserChannel('default');
    const notifications = await loadNotifications();

    notifications.notify(reminder);
    notifications.notify(reminder);

    expect(notifications.getChannelSnapshot().alerts).toHaveLength(2);
    expectNoBrowserCall(channel);
  });
});

