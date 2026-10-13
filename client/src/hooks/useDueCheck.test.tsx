/**
 * Tests for `./useDueCheck` — the cadence, the session's claim bookkeeping and the single clock read.
 *
 * This suite is the evidence for the notification requirements: the check fires exactly once for a
 * reminder that has come due, it fires nothing twice — not on a later tick, not when the same
 * reminder is handed to it again with the claim still unrecorded on the server, and not after it is
 * remounted — it reads the list from the server once per tick however many reminders there are, and
 * it reports a failure without ever alerting again for the reminder that failed.
 *
 * Three substitutions make it deterministic, and none of them touches a real collaborator:
 *
 * - The clock and the timers are faked (`vi.useFakeTimers` with `vi.setSystemTime`). That faked
 *   system clock is the whole clock seam: the hook's real accessor (`currentInstantIso` in
 *   `../lib/time`) reads it, so this suite neither imports nor mocks that module, and no clock
 *   parameter is added to the hook. Pinning the system clock pins every instant the hook decides
 *   against and reports as `now`.
 * - The channel is mocked (`../lib/notifications`), so the suite observes that a reminder was
 *   notified without constructing a browser notification. The channel's own behaviour — which
 *   readings permit a browser notification, and what the in-app alert does — is tested in
 *   `client/src/lib/notifications.test.ts`.
 * - The API layer is a set of fakes handed to the hook through its `api` parameter, so no test
 *   reaches the network. The module itself is mocked only to keep the real `ApiError` class — a
 *   failure thrown at the hook is the type the application really throws — and to replace its own
 *   `remindersApi` caller with a tripwire that rejects, so a hook that ignored the injected API would
 *   fail these assertions instead of quietly reaching the real caller.
 *
 * The due condition and the status classification are NOT mocked: `../lib/dueCheck` is the real
 * pure rule, so these tests exercise the integration between the hook's cadence and the rule that
 * decides what is due.
 */

import { act, cleanup, renderHook } from '@testing-library/react';

import { useDueCheck } from './useDueCheck';
import type { Reminder } from '../types';
import { ApiError, type RemindersApi } from '../lib/remindersApi';

/**
 * The cadence the feature fixes, written as the literal the scheduler must honour: the check runs at
 * least once every 30 seconds while the page is open.
 */
const DUE_CHECK_INTERVAL_MS = 30_000;

/**
 * The instant every test starts from, pinned into the faked clock.
 *
 * A literal rather than a reading of the clock, so every assertion in this file is reproducible at
 * any hour of any day: the hook reads its one instant per run from the faked clock, and every
 * fixture below is derived from this same value.
 */
const NOW = '2026-10-07T12:00:00.000Z';

/**
 * The wording the banner shows for an unknown id, and for a failure that carried nothing readable.
 *
 * Written out as literals here rather than imported from the modules that produce them, because
 * these two strings are what the assertions have to pin: a suite that compared the banner against
 * the very constant the application renders from would keep passing while the words the user sees
 * had changed. Each value is the one the server sends and the client displays.
 */
const NOT_FOUND_MESSAGE = 'Reminder not found.';
const GENERIC_MESSAGE = 'Something went wrong. Please try again.';

/**
 * The fakes this suite installs. `vi.hoisted` is required for a value a `vi.mock` factory closes
 * over: the factories are hoisted above the imports, so an ordinary module-scope `const` would not
 * exist yet when they run.
 */
const { notifyMock, listMock, markNotifiedMock, createMock, completeMock, removeMock } =
  vi.hoisted(() => ({
    // Each fake carries the signature of the collaborator it replaces rather than being an untyped
    // stub, so the implementations installed below and the values they resolve are type-checked
    // against the real contract instead of against `any`.
    notifyMock: vi.fn<(reminder: Reminder) => void>(),
    listMock: vi.fn<RemindersApi['list']>(),
    markNotifiedMock: vi.fn<RemindersApi['markNotified']>(),
    createMock: vi.fn<RemindersApi['create']>(),
    completeMock: vi.fn<RemindersApi['complete']>(),
    removeMock: vi.fn<RemindersApi['remove']>(),
  }));

vi.mock('../lib/notifications', () => ({
  notify: notifyMock,
}));

vi.mock('../lib/remindersApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/remindersApi')>();

  // The module's own caller is replaced by a tripwire rather than by this suite's fakes. The fakes
  // reach the hook only through its `api` parameter, so every assertion on them also proves the hook
  // used the API it was handed; and a hook that fell back to the module's caller instead gets a
  // rejection, which surfaces as an unexpected `error` and as fakes that were never called, never as
  // a request leaving the test.
  const unreachable = (): Promise<never> =>
    Promise.reject(
      new Error('The module remindersApi was reached; the hook must use the API it was handed.'),
    );
  const tripwire: RemindersApi = {
    list: unreachable,
    create: unreachable,
    complete: unreachable,
    markNotified: unreachable,
    remove: unreachable,
  };

  return { ...actual, remindersApi: tripwire };
});

/** The absolute instant a number of minutes from `NOW` falls on, as the server would report it. */
function atMinutes(minutes: number): string {
  return new Date(Date.parse(NOW) + minutes * 60_000).toISOString();
}

/** One reminder as the server returns it, with only the values a case cares about overridden. */
function reminder(
  id: string,
  dueAt: string,
  overrides: Partial<Reminder> = {},
): Reminder {
  return {
    id,
    text: `Reminder ${id}`,
    dueAt,
    completed: false,
    notifiedAt: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

/**
 * The API layer the hook is given: the module-level fakes, shaped as the interface the hook declares.
 *
 * Built once for the whole file, and deliberately not per render: the hook treats the API value as its
 * one dependency, so a caller that handed it a fresh object on every render would re-create both of
 * its effects each time — the argument effect would re-run forever, and the interval would restart
 * before it could ever fire. The real caller passes the module's own `remindersApi`, which is stable
 * for exactly that reason.
 */
const testApi: RemindersApi = {
  list: listMock,
  create: createMock,
  complete: completeMock,
  markNotified: markNotifiedMock,
  remove: removeMock,
};

/** Renders the hook over a list, returning the tools a case needs to change or tear it down. */
function renderDueCheck(initialList: readonly Reminder[] = []) {
  return renderHook(
    ({ list }: { list: readonly Reminder[] }) => useDueCheck(list, testApi),
    { initialProps: { list: initialList } },
  );
}

/** Settles the microtask queue inside `act`, so a run that awaited a promise completes. */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

/** Advances the faked clock and timers, letting every awaited promise settle along the way. */
async function advance(milliseconds: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
}

/** Fires one of the events the check re-runs on, and settles what the run started. */
async function dispatch(event: Event, target: Window | Document): Promise<void> {
  await act(async () => {
    target.dispatchEvent(event);
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));

  vi.clearAllMocks();

  listMock.mockResolvedValue([]);
  // The claim answers as the server does: the updated reminder, with `notifiedAt` now set.
  markNotifiedMock.mockImplementation(async (id: string) => reminder(id, NOW, { notifiedAt: NOW }));
  createMock.mockImplementation(async () => reminder('created', atMinutes(5)));
  completeMock.mockImplementation(async (id: string) => reminder(id, NOW, { completed: true }));
  removeMock.mockResolvedValue(undefined);
});

afterEach(() => {
  // Unmount first, while the fake timers are still installed, so each hook's interval is cleared on
  // the clock that scheduled it. Done explicitly rather than left to Testing Library's automatic
  // cleanup, which registers itself once per module load: a runner that shares modules between
  // files would otherwise leave this file's hooks mounted from one case into the next.
  cleanup();
  vi.useRealTimers();
});

describe('the first run, against the list the screen already holds', () => {
  it('reports the instant it decided against as `now`', () => {
    const { result } = renderDueCheck();

    expect(result.current.now).toBe(NOW);
    expect(result.current.error).toBeNull();
  });

  it('notifies an uncompleted due reminder once, claims it, and issues no request to do it', async () => {
    const due = reminder('due-1', atMinutes(-1));
    const { result } = renderDueCheck([due]);

    await flush();

    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock).toHaveBeenCalledWith(due);
    // The claim is recorded after the notification, and it is the server's own operation.
    expect(markNotifiedMock).toHaveBeenCalledTimes(1);
    expect(markNotifiedMock).toHaveBeenCalledWith('due-1');
    // The argument path selects from the list it was given: no request, no second source of truth.
    expect(listMock).not.toHaveBeenCalled();
    expect(result.current.error).toBeNull();
  });

  it('notifies a reminder that came due before the page opened on the run that first sees it', async () => {
    // The reload case the requirement is about: the page opened with no list of its own, so the run
    // on mount selected nothing, and the reminder has been due for two hours by the time the screen's
    // list arrives. There is no grace window and no recency check, so it is notified exactly once.
    const overdue = reminder('overdue-on-open', atMinutes(-120));
    const { rerender } = renderDueCheck();

    await flush();
    expect(notifyMock).not.toHaveBeenCalled();

    await act(async () => {
      rerender({ list: [overdue] });
      await Promise.resolve();
    });

    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock).toHaveBeenCalledWith(overdue);
    expect(markNotifiedMock).toHaveBeenCalledTimes(1);
    expect(markNotifiedMock).toHaveBeenCalledWith('overdue-on-open');
    // The arriving list is what triggered it: the argument path issues no request of its own.
    expect(listMock).not.toHaveBeenCalled();
  });

  it('notifies a reminder exactly on its due instant and leaves one a millisecond later alone', async () => {
    const exactlyDue = reminder('due-now', NOW);
    const aMillisecondLater = reminder('due-later', '2026-10-07T12:00:00.001Z');
    renderDueCheck([exactlyDue, aMillisecondLater]);

    await flush();

    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock).toHaveBeenCalledWith(exactlyDue);
  });

  it('notifies nothing when the list holds only completed, claimed or not-yet-due reminders', async () => {
    const completed = reminder('done', atMinutes(-5), { completed: true });
    const claimed = reminder('claimed', atMinutes(-5), { notifiedAt: atMinutes(-4) });
    const upcoming = reminder('upcoming', atMinutes(5));
    renderDueCheck([completed, claimed, upcoming]);

    await flush();

    expect(notifyMock).not.toHaveBeenCalled();
    expect(markNotifiedMock).not.toHaveBeenCalled();
  });

  it('notifies nothing on a later tick that still reports a completed, a claimed and an upcoming reminder', async () => {
    // The same three refusals, exercised on the other path into the selection: a tick selects from
    // the array the server has just returned, so the conditions have to hold there too.
    const completed = reminder('done', atMinutes(-5), { completed: true });
    const claimed = reminder('claimed', atMinutes(-5), { notifiedAt: atMinutes(-4) });
    const upcoming = reminder('upcoming', atMinutes(5));
    renderDueCheck([completed, claimed, upcoming]);

    await flush();

    listMock.mockResolvedValue([completed, claimed, upcoming]);
    await advance(DUE_CHECK_INTERVAL_MS);

    expect(listMock).toHaveBeenCalledTimes(1);
    expect(notifyMock).not.toHaveBeenCalled();
    expect(markNotifiedMock).not.toHaveBeenCalled();
  });

  it('notifies every due reminder, in the order the server returned them, and claims each once', async () => {
    const first = reminder('first', atMinutes(-3));
    const second = reminder('second', atMinutes(-2));
    renderDueCheck([
      reminder('completed-overdue', atMinutes(-9), { completed: true }),
      first,
      reminder('claimed', atMinutes(-7), { notifiedAt: atMinutes(-6) }),
      second,
      reminder('upcoming', atMinutes(9)),
    ]);

    await flush();

    expect(notifyMock).toHaveBeenCalledTimes(2);
    expect(notifyMock).toHaveBeenNthCalledWith(1, first);
    expect(notifyMock).toHaveBeenNthCalledWith(2, second);
    expect(markNotifiedMock.mock.calls).toEqual([['first'], ['second']]);
  });

  it('notifies nothing on a fresh mount over a list whose claims the server already recorded', async () => {
    // The reload case: the claim lives on the server, so a page that opens again finds `notifiedAt`
    // set and the check selects nothing at all.
    renderDueCheck([reminder('reloaded', atMinutes(-30), { notifiedAt: atMinutes(-29) })]);

    await flush();

    expect(notifyMock).not.toHaveBeenCalled();
    expect(markNotifiedMock).not.toHaveBeenCalled();
  });
});

describe('the scheduler', () => {
  it('reads the list from the server once per tick and never notifies the same reminder twice', async () => {
    const due = reminder('due-1', atMinutes(-1));
    const { result } = renderDueCheck();

    // The server keeps reporting the reminder as unclaimed, which is the state a stale response or a
    // claim still in flight would leave: the session's own set has to be what stops the second alert.
    listMock.mockResolvedValue([due]);

    await advance(DUE_CHECK_INTERVAL_MS);
    expect(listMock).toHaveBeenCalledTimes(1);
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock).toHaveBeenCalledWith(due);
    expect(markNotifiedMock).toHaveBeenCalledTimes(1);
    expect(markNotifiedMock).toHaveBeenCalledWith('due-1');

    await advance(DUE_CHECK_INTERVAL_MS);
    expect(listMock).toHaveBeenCalledTimes(2);
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(markNotifiedMock).toHaveBeenCalledTimes(1);
    expect(result.current.error).toBeNull();
  });

  it('notifies once when the list arrives, stays silent on a stale tick, and stays silent after a remount once the claim is recorded', async () => {
    const due = reminder('due-1', atMinutes(-1));
    const firstSession = renderDueCheck();

    await flush();
    expect(notifyMock).not.toHaveBeenCalled();

    // The screen's list arrives: the argument path notifies and claims, and issues no request.
    await act(async () => {
      firstSession.rerender({ list: [due] });
      await Promise.resolve();
    });

    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock).toHaveBeenCalledWith(due);
    expect(markNotifiedMock).toHaveBeenCalledTimes(1);
    expect(markNotifiedMock).toHaveBeenCalledWith('due-1');
    expect(listMock).not.toHaveBeenCalled();
    expect(firstSession.result.current.now).toBe(NOW);

    // Thirty seconds on, the tick reads a snapshot that still reports the reminder unclaimed. Only
    // the session's own claim set can keep this tick silent; the server's column is not set in it.
    listMock.mockResolvedValue([due]);
    await advance(DUE_CHECK_INTERVAL_MS);

    expect(listMock).toHaveBeenCalledTimes(1);
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(markNotifiedMock).toHaveBeenCalledTimes(1);

    // The reload: a new hook instance, and so a new, empty session set, over the list as the server
    // now holds it. Here the recorded `notifiedAt` is the only thing that can keep it silent, on the
    // argument path and on the tick alike.
    firstSession.unmount();
    const claimed = reminder('due-1', atMinutes(-1), { notifiedAt: NOW });
    listMock.mockResolvedValue([claimed]);
    const secondSession = renderDueCheck([claimed]);

    await flush();
    await advance(DUE_CHECK_INTERVAL_MS);

    expect(listMock).toHaveBeenCalledTimes(2);
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(markNotifiedMock).toHaveBeenCalledTimes(1);
    expect(secondSession.result.current.error).toBeNull();
  });

  it('refreshes `now` with the clock read of each run', async () => {
    const { result } = renderDueCheck();

    expect(result.current.now).toBe(NOW);

    await advance(DUE_CHECK_INTERVAL_MS);

    expect(result.current.now).toBe('2026-10-07T12:00:30.000Z');
  });

  it('issues exactly one request per tick however many reminders are stored', async () => {
    const due = reminder('due-1', atMinutes(-1));
    const thousandReminders: Reminder[] = [
      due,
      ...Array.from({ length: 999 }, (_element, index) =>
        reminder(`upcoming-${String(index)}`, atMinutes(index + 1)),
      ),
    ];

    renderDueCheck();
    listMock.mockResolvedValue(thousandReminders);

    await advance(DUE_CHECK_INTERVAL_MS);

    expect(listMock).toHaveBeenCalledTimes(1);
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock).toHaveBeenCalledWith(due);
  });

  it('does not reset the interval when the list the screen holds changes', async () => {
    const { rerender } = renderDueCheck();

    await advance(15_000);
    await act(async () => {
      rerender({ list: [reminder('later', atMinutes(5))] });
      await Promise.resolve();
    });
    await advance(15_000);

    // A tick landed 30 seconds after the mount. Had the interval been recreated when the list
    // changed, the timer would have restarted at 15 seconds and no tick would have arrived yet.
    expect(listMock).toHaveBeenCalledTimes(1);
  });

  it('re-runs the check when the window regains focus', async () => {
    const due = reminder('due-1', atMinutes(-1));
    renderDueCheck();

    listMock.mockResolvedValue([due]);
    await dispatch(new Event('focus'), window);
    await flush();

    expect(listMock).toHaveBeenCalledTimes(1);
    expect(notifyMock).toHaveBeenCalledTimes(1);
  });

  it('re-runs the check on a visibilitychange that leaves the document visible', async () => {
    renderDueCheck();

    await dispatch(new Event('visibilitychange'), document);

    expect(listMock).toHaveBeenCalledTimes(1);
  });

  it('ignores a visibilitychange while the document is hidden', async () => {
    renderDueCheck();

    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await dispatch(new Event('visibilitychange'), document);
    visibility.mockRestore();

    expect(listMock).not.toHaveBeenCalled();
  });

  it('refuses a run that arrives while another one is still in flight', async () => {
    const due = reminder('due-1', atMinutes(-1));
    let releaseList: ((value: Reminder[]) => void) | null = null;
    listMock.mockImplementationOnce(
      () =>
        new Promise<Reminder[]>((resolve) => {
          releaseList = resolve;
        }),
    );

    renderDueCheck();

    // The tick starts a run that stays in flight on the pending read.
    await advance(DUE_CHECK_INTERVAL_MS);
    expect(listMock).toHaveBeenCalledTimes(1);

    // A focus run arrives during it and is refused before it fetches anything.
    await dispatch(new Event('focus'), window);
    expect(listMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      releaseList?.([due]);
      await Promise.resolve();
    });

    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(markNotifiedMock).toHaveBeenCalledTimes(1);
  });

  it('clears the interval and both listeners when it unmounts', async () => {
    const { unmount } = renderDueCheck();

    await flush();
    unmount();

    await advance(DUE_CHECK_INTERVAL_MS);
    await dispatch(new Event('focus'), window);
    await dispatch(new Event('visibilitychange'), document);

    expect(listMock).not.toHaveBeenCalled();
  });
});

describe('the order of delivery and the claim', () => {
  it('fires the notification before recording the claim', async () => {
    const due = reminder('due-1', atMinutes(-1));
    const steps: string[] = [];

    notifyMock.mockImplementation(() => {
      steps.push('notify');
    });
    markNotifiedMock.mockImplementation(async (id: string) => {
      steps.push('claim');
      return reminder(id, NOW, { notifiedAt: NOW });
    });

    renderDueCheck([due]);
    await flush();

    // The alert is shown because a real due reminder was read from the server, and the claim that
    // makes the delivery happen at most once is recorded immediately after it.
    expect(steps).toEqual(['notify', 'claim']);
  });
});

describe('failures', () => {
  it('reports a failed claim and never retries that reminder in this session', async () => {
    const due = reminder('due-1', atMinutes(-1));
    markNotifiedMock.mockRejectedValueOnce(new ApiError(NOT_FOUND_MESSAGE, 404));
    const { result } = renderDueCheck([due]);

    await flush();

    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(result.current.error).toBe(NOT_FOUND_MESSAGE);

    // The server still reports the reminder as unclaimed, and the check still refuses to alert again:
    // retrying would alert the user every 30 seconds for as long as the page stayed open.
    listMock.mockResolvedValue([due]);
    await advance(DUE_CHECK_INTERVAL_MS);

    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(markNotifiedMock).toHaveBeenCalledTimes(1);
  });

  it('keeps notifying the remaining due reminders when one claim fails', async () => {
    const first = reminder('first', atMinutes(-2));
    const second = reminder('second', atMinutes(-1));
    markNotifiedMock.mockRejectedValueOnce(new ApiError(GENERIC_MESSAGE, 500));
    const { result } = renderDueCheck([first, second]);

    await flush();

    expect(notifyMock).toHaveBeenCalledTimes(2);
    expect(notifyMock).toHaveBeenNthCalledWith(1, first);
    expect(notifyMock).toHaveBeenNthCalledWith(2, second);
    expect(markNotifiedMock.mock.calls).toEqual([['first'], ['second']]);
    expect(result.current.error).toBe(GENERIC_MESSAGE);
  });

  it('reports a failed list read, claims nothing, and reads again on the next tick', async () => {
    const due = reminder('due-1', atMinutes(-1));
    const { result } = renderDueCheck();
    listMock.mockRejectedValueOnce(new ApiError(GENERIC_MESSAGE, 503));

    await advance(DUE_CHECK_INTERVAL_MS);

    expect(result.current.error).toBe(GENERIC_MESSAGE);
    expect(notifyMock).not.toHaveBeenCalled();
    expect(markNotifiedMock).not.toHaveBeenCalled();

    listMock.mockResolvedValue([due]);
    await advance(DUE_CHECK_INTERVAL_MS);

    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(result.current.error).toBeNull();
  });

  it('falls back to the generic wording when a failure carries no usable message', async () => {
    const { result } = renderDueCheck();

    listMock.mockRejectedValueOnce({ reason: 'a rejection with no message' });
    await advance(DUE_CHECK_INTERVAL_MS);
    expect(result.current.error).toBe(GENERIC_MESSAGE);

    listMock.mockRejectedValueOnce(new Error(''));
    await advance(DUE_CHECK_INTERVAL_MS);
    expect(result.current.error).toBe(GENERIC_MESSAGE);
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it('accepts any error that carries a message of its own', async () => {
    // The identity test that recognises `ApiError` can legitimately fail — a suite may substitute the
    // API module with its own equivalent class — and the message is still what the user should see.
    const { result } = renderDueCheck();
    listMock.mockRejectedValueOnce(new Error(NOT_FOUND_MESSAGE));

    await advance(DUE_CHECK_INTERVAL_MS);

    expect(result.current.error).toBe(NOT_FOUND_MESSAGE);
  });
});
