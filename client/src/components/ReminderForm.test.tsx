/**
 * Tests for `./ReminderForm` — the create form's behaviour, exercised through the DOM a user sees.
 *
 * What this suite is the evidence for:
 *
 * - The four refusals and their exact wording — empty or whitespace-only text, a text over 280
 *   characters, a missing or unusable due date and time, and a due time in the past — each reported
 *   under the field it belongs to, with that field focused and the message associated with it.
 * - The guarantee that a refused submission saves nothing: every refusal case asserts that the
 *   create call was never made. The call is a `vi.fn()` stand-in for the parent's create, which is
 *   also how the failure path is driven — the form's own `create` prop is the seam, so no HTTP layer,
 *   no server, no browser storage and no network is involved anywhere in this file.
 * - The 280/281 boundary: exactly the bound is accepted and sent trimmed, one character more is
 *   refused.
 * - The request body: exactly `text` and `dueAt`, with `dueAt` the instant the typed local date and
 *   time name. No identity-bearing field is ever sent, because the client derives none of them.
 * - The one permission request this application spends: none on mount, exactly one on the first
 *   successful submit from a `default` reading, none afterwards, and none at all from any other
 *   reading.
 * - The failure path: the server's own wording under the input the server named, with that input
 *   focused (or at form level, with focus left alone, when it named none), every entered value kept,
 *   and the submit control usable again.
 *
 * The substitutions, and why each is the one that makes the evidence real:
 *
 * - `../lib/notifications` is NOT replaced. Only its `requestPermission` is wrapped by a counting spy
 *   that delegates to the module's own function, so the reading the form acts on is still the one the
 *   real `getChannelSnapshot()` derives from the stubbed `Notification` global — a hand-written stand-in
 *   could agree with the form about a reading the real module would never report. The stub is a plain
 *   object carrying a reading and a `requestPermission` that answers and then reports that answer, as a
 *   browser does once the user has answered the prompt; a case that installs no stub is the unsupported
 *   browser, which is jsdom's own state (it implements no notification API).
 * - Every case loads a FRESH instance of the component and of the channel module it calls
 *   (`vi.resetModules()` in `beforeEach`, then a dynamic `import('./ReminderForm')` inside that case's
 *   setup). The channel module keeps private session state — the reading a completed permission
 *   request resolved, plus a cached snapshot and the alert list — and deliberately exports no
 *   test-only reset, so a static import would let one case inherit what another left behind and make
 *   this suite depend on its own case order. For the same reason the counting spy is held in
 *   `vi.hoisted`: the `vi.mock` factory runs again for every fresh module instance, and the spy's
 *   identity has to outlive that or the assertions would count a function that no longer exists.
 * - The clock is pinned (`vi.setSystemTime`) so that "in the future" and "in the past" are decided by
 *   this file rather than by the day the suite happens to run, and both dates are years from the pin
 *   so no zone or daylight-saving offset can move the verdict. `shouldAdvanceTime` is required rather
 *   than cosmetic: React's asynchronous `act`, which every awaited `user-event` call is wrapped in,
 *   never settles while the faked clock cannot move, so a frozen clock times out on the first click
 *   (measured, including with `delay: null` and with a `toFake` list that leaves `queueMicrotask`
 *   alone). The instant is still this file's, not the platform's: nothing below compares against the
 *   real clock, and the two dates sit years either side of the pin.
 * - `userEvent.setup({ advanceTimers: vi.advanceTimersByTime })` is what lets typing and clicking
 *   settle while the fake clock owns the timers. The bare `userEvent` export is never used here.
 * - The message literals are written out below rather than imported from `../lib/validation`, so a
 *   reworded message fails here instead of silently reaching the user. This is also what pins them in
 *   step with the server: `client/src/lib/validation.test.ts` asserts the same strings against the
 *   server's copy of the rules.
 * - Every case that submits declares its channel reading explicitly. The cases about validation and
 *   clearing declare `denied`, so the permission path cannot be what makes them pass or fail, and the
 *   reading that spends the request is exercised only by the cases that exist to spend it.
 * - The two platform pickers are driven with `fireEvent.change`, because jsdom implements none of a
 *   date or time input's own editor and normalises a value the control cannot hold to the empty
 *   string — which one case below asserts explicitly rather than papering over.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import type { CreateReminderInput, Reminder } from '../types';

/**
 * The wording of each refusal and of the generic fallback, character for character as the user reads
 * it.
 *
 * Written out here on purpose: a constant imported from the module under test's own rule set could not
 * tell a reworded refusal from an unchanged one.
 */
const TEXT_REQUIRED = 'Enter a reminder text.';
const TEXT_TOO_LONG = 'Reminder text must be 280 characters or fewer.';
const DUE_AT_INVALID = 'Enter a valid due date and time.';
const DUE_AT_IN_PAST = 'The due time must be in the future.';
const GENERIC_ERROR = 'Something went wrong. Please try again.';

/**
 * The wording the server's refusal carries in the failure cases below.
 *
 * Deliberately a string none of the five above can produce, so asserting it proves the `ApiError`'s
 * own message reached the field rather than one this client invented.
 */
const SERVER_REFUSAL = 'That reminder text was refused by the server.';

/** The bound the text rule measures against, as the rule states it. */
const MAX_TEXT_LENGTH = 280;

/** The instant the faked clock is pinned to, so no verdict below depends on the day of the run. */
const PINNED_NOW = new Date('2026-10-07T12:00:00Z');

/** A local date and time far enough ahead of the pin to be unambiguously in the future. */
const FUTURE_DATE = '2030-01-02';
const FUTURE_TIME = '09:30';

/**
 * The instant `FUTURE_DATE` and `FUTURE_TIME` name: built here from the same local components the
 * user entered, so the expectation is correct in every zone and independent of the client's own
 * converter. January 2nd is nowhere near a daylight-saving transition in any zone.
 */
const FUTURE_INSTANT = new Date(2030, 0, 2, 9, 30).toISOString();

/** A local date and time far enough behind the pin to be unambiguously in the past. */
const PAST_DATE = '2020-01-01';
const PAST_TIME = '09:30';

/** The form's create prop, as the parent supplies it. */
type CreateProp = (input: CreateReminderInput) => Promise<Reminder>;

/**
 * The counting spy on the one permission request the form spends.
 *
 * The count is the assertion, not the platform's answer: whether an answer arrives is
 * `client/src/lib/notifications.test.ts`'s subject, while what this suite must prove is WHEN the form
 * asks — never on load, once on the first successful submit, and never from another reading.
 */
const { permissionRequests } = vi.hoisted(() => ({ permissionRequests: vi.fn() }));

/**
 * Mocks exactly one export of the channel module and keeps every other one real.
 *
 * Spreading the actual module is what leaves `getChannelSnapshot` in place, so the reading the form
 * compares is still derived from the stubbed `Notification` global rather than from anything this
 * file decides.
 */
vi.mock('../lib/notifications', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/notifications')>();

  return {
    ...actual,
    requestPermission: () => {
      permissionRequests();
      return actual.requestPermission();
    },
  };
});

/** How a case's browser reports notification permission, before any request is made. */
type Reading = 'granted' | 'denied' | 'default';

/** What one case needs back from the stubbed browser channel. */
interface FakeBrowserChannel {
  /** How many times the code under test called the platform's own `requestPermission`. */
  platformRequests(): number;
}

/**
 * Stubs a `Notification` global that reports `reading` and answers a permission request with `answer`,
 * moving its own reading to that answer as a browser does once the user has answered the prompt.
 *
 * @param reading The reading the stub reports before any request is made.
 * @param answer The reading a request resolves with, and the reading the stub reports afterwards.
 * @returns The record a case can assert on.
 */
function stubBrowserChannel(reading: Reading, answer: Reading = 'granted'): FakeBrowserChannel {
  const state: { permission: unknown } = { permission: reading };

  const requestPermission = vi.fn(() => {
    state.permission = answer;
    return Promise.resolve(answer);
  });

  vi.stubGlobal('Notification', {
    get permission(): unknown {
      return state.permission;
    },
    requestPermission,
  });

  return { platformRequests: () => requestPermission.mock.calls.length };
}

/**
 * Builds the failure the create prop rejects with, as the type the application really throws.
 *
 * The `ApiError` class is loaded here, inside the case that needs it, rather than imported at the top
 * of this file. `vi.resetModules()` hands the component a fresh `../lib/remindersApi` instance, so a
 * class captured from that module's first instance is a different constructor, `instanceof` inside the
 * form would be false, and every failure would take the unclassifiable branch — the branch these cases
 * exist to distinguish themselves from.
 *
 * @param message The wording the server sent.
 * @param status The HTTP status that failed.
 * @param field The input the server attributed the failure to, when it named one.
 * @returns A promise that rejects with that `ApiError`.
 */
async function failWith(message: string, status: number, field?: 'text' | 'dueAt'): Promise<never> {
  const { ApiError } = await import('../lib/remindersApi');

  throw new ApiError(message, status, field);
}

/** Builds the reminder a create stub resolves with, echoing the input the form sent. */
function makeReminder(input: CreateReminderInput): Reminder {
  return {
    id: 'reminder-1',
    text: input.text,
    dueAt: input.dueAt,
    completed: false,
    notifiedAt: null,
    createdAt: '2026-10-07T12:00:00.000Z',
  };
}

/** The text input, found by the label the user reads. */
function textField(): HTMLInputElement {
  return screen.getByLabelText('Reminder text');
}

/** The due date input. */
function dateField(): HTMLInputElement {
  return screen.getByLabelText('Due date');
}

/** The due time input. */
function timeField(): HTMLInputElement {
  return screen.getByLabelText('Due time');
}

/** The submit control, found by the exact label the contract fixes. */
function submitButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: 'Add reminder' });
}

/** The form element itself, for the structural assertions the stylesheet's selectors depend on. */
function form(): HTMLFormElement {
  const element = document.querySelector('form.reminder-form');
  if (!(element instanceof HTMLFormElement)) {
    throw new Error('the form element was not rendered');
  }
  return element;
}

/**
 * The form's message regions in document order: the text field's, the date control's reserved line,
 * the due-time pair's — which sits under the time control and covers both controls of the pair — and
 * the form-level one, for a failure that names no input. All four are always in the document.
 */
function messageRegions(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('.reminder-form__error'));
}

/**
 * Renders a fresh instance of the form with a create stub, and returns what a case drives it with.
 *
 * The component and the channel module are imported dynamically, after the `vi.resetModules()` in
 * `beforeEach`, so this case sees its own instances of both rather than another case's module state.
 *
 * @param create The behaviour of the create prop; by default it resolves a reminder echoing the
 *   input, which is the success path.
 */
async function setup(create: CreateProp = async (input) => makeReminder(input)) {
  const createMock = vi.fn<CreateProp>(create);
  const { ReminderForm } = await import('./ReminderForm');

  render(<ReminderForm create={createMock} />);

  return { createMock, user: userEvent.setup({ advanceTimers: vi.advanceTimersByTime }) };
}

/** Fills the three inputs; the text is typed as a user types it, the pickers are set directly. */
async function fill(
  user: ReturnType<typeof userEvent.setup>,
  text: string,
  date: string,
  time: string,
): Promise<void> {
  if (text !== '') {
    await user.type(textField(), text);
  }
  if (date !== '') {
    fireEvent.change(dateField(), { target: { value: date } });
  }
  if (time !== '') {
    fireEvent.change(timeField(), { target: { value: time } });
  }
}

/**
 * Drops focus to the document body, as Chrome does when the focused submit control is disabled for
 * the duration of a request. jsdom does not drop the focus of a disabled control itself, so a create
 * stub calls this to put the page in the state a real browser leaves it in.
 */
function dropFocusLikeABrowser(): void {
  const focused = document.activeElement;
  if (focused instanceof HTMLElement) {
    focused.blur();
  }
}

/** Submits the form the way a user does, by activating the control. */
async function submit(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(submitButton());
}

beforeEach(() => {
  // A fresh module graph and a clean spy per case, then the clock: this file's instant, with the
  // timers advancing at real time so React's asynchronous `act` and user-event's awaited
  // interactions can settle — see the note on `shouldAdvanceTime` in the header.
  vi.resetModules();
  vi.clearAllMocks();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(PINNED_NOW);
});

afterEach(() => {
  // The globals a case stubbed are put back, so no case starts inside another's browser state: with
  // no stub installed, the channel module reports the unsupported browser that jsdom provides.
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the markup the contract fixes', () => {
  it('renders one form holding three labelled inputs and the Add reminder submit control', async () => {
    await setup();

    expect(form()).toBeInTheDocument();
    expect(textField()).toBeInTheDocument();
    expect(dateField()).toBeInTheDocument();
    expect(timeField()).toBeInTheDocument();
    expect(submitButton()).toBeInTheDocument();
  });

  it("keeps the three field wrappers as the form's first three children, in the plan's order", async () => {
    await setup();

    // The stylesheet gives `.reminder-form__field:nth-child(2)` and `:nth-child(3)` the narrow basis
    // the date and time fields need, so the wrappers' positions are part of the visual contract.
    const children = Array.from(form().children);

    expect(children[0]).toHaveClass('reminder-form__field');
    expect(children[0]).toContainElement(textField());
    expect(children[1]).toHaveClass('reminder-form__field');
    expect(children[1]).toContainElement(dateField());
    expect(children[2]).toHaveClass('reminder-form__field');
    expect(children[2]).toContainElement(timeField());
  });

  it("leaves the text input without a maxLength, so the bound is the rule's and not the browser's", async () => {
    await setup();

    expect(textField()).not.toHaveAttribute('maxlength');
    expect(textField()).toHaveAttribute('type', 'text');
    expect(dateField()).toHaveAttribute('type', 'date');
    expect(timeField()).toHaveAttribute('type', 'time');
  });

  it('counts what has been typed against the bound the rule measures against', async () => {
    const { user } = await setup();

    expect(screen.getByText(`0 of ${MAX_TEXT_LENGTH} characters`)).toBeInTheDocument();

    await user.type(textField(), 'Water the plants');

    expect(screen.getByText(`16 of ${MAX_TEXT_LENGTH} characters`)).toBeInTheDocument();
  });

  it('reserves one message region per field and one at form level, each announced without moving focus', async () => {
    await setup();

    const regions = messageRegions();

    // Four, one per field and one at form level, all present and empty before anything has been
    // refused: the reserved line is what keeps the row still between an accepted and a rejected
    // submit, and a live region has to exist before its text arrives for that text to be announced.
    expect(regions).toHaveLength(4);
    for (const region of regions) {
      expect(region).toHaveAttribute('aria-live', 'polite');
      expect(region.textContent).toBe('');
    }

    // The form-level region belongs to no field: it is the form's own child, outside every wrapper.
    expect(regions[3]?.parentElement).toBe(form());

    // Each control points at the region that describes it: the text field at its own, and both
    // controls of the due-time pair at the one region their shared value is reported in.
    expect(textField()).toHaveAttribute('aria-describedby', regions[0]?.id ?? '');
    expect(dateField()).toHaveAttribute('aria-describedby', regions[2]?.id ?? '');
    expect(timeField()).toHaveAttribute('aria-describedby', regions[2]?.id ?? '');
  });
});

describe('a refused submission', () => {
  it('reports empty text, focuses the field, associates the message with it and sends no request', async () => {
    stubBrowserChannel('denied');
    const { createMock, user } = await setup();

    await submit(user);

    const message = screen.getByText(TEXT_REQUIRED);

    expect(messageRegions()[0]?.textContent).toBe(TEXT_REQUIRED);
    expect(textField()).toHaveFocus();
    expect(textField()).toHaveAttribute('aria-invalid', 'true');
    expect(textField()).toHaveAttribute('aria-describedby', message.id);
    expect(createMock).not.toHaveBeenCalled();
  });

  it('treats whitespace-only text as missing and sends no request', async () => {
    stubBrowserChannel('denied');
    const { createMock, user } = await setup();

    await fill(user, '', FUTURE_DATE, FUTURE_TIME);
    await user.type(textField(), '   ');
    await submit(user);

    expect(screen.getByText(TEXT_REQUIRED)).toBeInTheDocument();
    expect(textField()).toHaveFocus();
    expect(createMock).not.toHaveBeenCalled();
  });

  it('refuses a text one character over the bound, and sends no request', async () => {
    stubBrowserChannel('denied');
    const { createMock, user } = await setup();

    // Set directly rather than typed: the point of this case is the bound, and typing the bound plus
    // one character would spend the whole test's time budget on keystrokes.
    fireEvent.change(textField(), { target: { value: 'x'.repeat(MAX_TEXT_LENGTH + 1) } });
    fireEvent.change(dateField(), { target: { value: FUTURE_DATE } });
    fireEvent.change(timeField(), { target: { value: FUTURE_TIME } });
    await submit(user);

    const message = screen.getByText(TEXT_TOO_LONG);

    expect(textField()).toHaveFocus();
    expect(textField()).toHaveAttribute('aria-describedby', message.id);
    expect(createMock).not.toHaveBeenCalled();
  });

  it('accepts a text of exactly the bound and sends the trim, not the whitespace around it', async () => {
    stubBrowserChannel('denied');
    const { createMock, user } = await setup();

    await fill(user, '', FUTURE_DATE, FUTURE_TIME);
    fireEvent.change(textField(), { target: { value: `  ${'x'.repeat(MAX_TEXT_LENGTH)}  ` } });
    await submit(user);

    await waitFor(() => {
      expect(createMock).toHaveBeenCalledTimes(1);
    });

    const sent = createMock.mock.calls[0]?.[0];

    expect(sent?.text).toBe('x'.repeat(MAX_TEXT_LENGTH));
    expect(sent?.dueAt).toBe(FUTURE_INSTANT);
  });

  it('sends exactly the text and the due instant, and nothing else', async () => {
    stubBrowserChannel('denied');
    const { createMock, user } = await setup();

    await fill(user, 'Call the dentist', FUTURE_DATE, FUTURE_TIME);
    await submit(user);

    await waitFor(() => {
      expect(createMock).toHaveBeenCalledTimes(1);
    });

    const sent = createMock.mock.calls[0]?.[0];

    // The key set is asserted rather than sampled: a field the server derives must never leave the
    // client, and this is the case that would notice one added here.
    expect(sent === undefined ? [] : Object.keys(sent).sort()).toEqual(['dueAt', 'text']);
    expect(sent?.dueAt).toBe(FUTURE_INSTANT);
  });

  it('reports a missing date and time, focuses the control to fill in, and sends no request', async () => {
    stubBrowserChannel('denied');
    const { createMock, user } = await setup();

    await fill(user, 'Call the dentist', '', '');
    await submit(user);

    const message = screen.getByText(DUE_AT_INVALID);

    expect(dateField()).toHaveFocus();
    expect(dateField()).toHaveAttribute('aria-invalid', 'true');
    expect(timeField()).toHaveAttribute('aria-invalid', 'true');

    // The due date and the due time are one value in two controls, so the pair's one message is the
    // message both of them point at.
    expect(dateField()).toHaveAttribute('aria-describedby', message.id);
    expect(timeField()).toHaveAttribute('aria-describedby', message.id);
    expect(createMock).not.toHaveBeenCalled();
  });

  it('focuses the time control when only the time is missing', async () => {
    stubBrowserChannel('denied');
    const { createMock, user } = await setup();

    await fill(user, 'Call the dentist', FUTURE_DATE, '');
    await submit(user);

    expect(screen.getByText(DUE_AT_INVALID)).toBeInTheDocument();
    expect(timeField()).toHaveFocus();
    expect(createMock).not.toHaveBeenCalled();
  });

  it('reports the same message when a picker cannot hold what was entered', async () => {
    stubBrowserChannel('denied');
    const { createMock, user } = await setup();

    await fill(user, 'Call the dentist', '', '');

    // jsdom implements none of a date or time input's own editor and normalises a value the control
    // cannot hold to the empty string, so an unusable value and an empty control are the same refusal
    // — asserted here rather than papered over.
    fireEvent.change(dateField(), { target: { value: 'not-a-date' } });
    fireEvent.change(timeField(), { target: { value: '99:99' } });

    expect(dateField()).toHaveValue('');
    expect(timeField()).toHaveValue('');

    await submit(user);

    expect(screen.getByText(DUE_AT_INVALID)).toBeInTheDocument();
    expect(dateField()).toHaveFocus();
    expect(createMock).not.toHaveBeenCalled();
  });

  it('reports a due time in the past, associates the message with the pair, and sends no request', async () => {
    stubBrowserChannel('denied');
    const { createMock, user } = await setup();

    await fill(user, 'Call the dentist', PAST_DATE, PAST_TIME);
    await submit(user);

    const message = screen.getByText(DUE_AT_IN_PAST);

    expect(timeField()).toHaveAttribute('aria-describedby', message.id);
    expect(createMock).not.toHaveBeenCalled();
  });

  it('clears the due-time message when one of its two controls is edited', async () => {
    stubBrowserChannel('denied');
    const { user } = await setup();

    await fill(user, 'Call the dentist', '', '');
    await submit(user);
    expect(screen.getByText(DUE_AT_INVALID)).toBeInTheDocument();

    fireEvent.change(dateField(), { target: { value: FUTURE_DATE } });

    expect(screen.queryByText(DUE_AT_INVALID)).not.toBeInTheDocument();
    expect(dateField()).toHaveAttribute('aria-invalid', 'false');
    expect(timeField()).toHaveAttribute('aria-invalid', 'false');
  });

  it('keeps a text message while a due-time control is edited', async () => {
    stubBrowserChannel('denied');
    const { user } = await setup();

    await fill(user, '', FUTURE_DATE, FUTURE_TIME);
    await submit(user);
    expect(screen.getByText(TEXT_REQUIRED)).toBeInTheDocument();

    fireEvent.change(dateField(), { target: { value: FUTURE_DATE } });
    fireEvent.change(timeField(), { target: { value: FUTURE_TIME } });

    // Editing a field the message does not belong to must not withdraw the refusal of the one it
    // does: the user has still not said what the reminder is.
    expect(screen.getByText(TEXT_REQUIRED)).toBeInTheDocument();
    expect(textField()).toHaveAttribute('aria-invalid', 'true');
  });

  it('spends no permission request on a refused submission', async () => {
    // The reading that WOULD spend a request, so the assertion is about the refusal and not about a
    // reading that had nothing to ask for.
    stubBrowserChannel('default');
    const { user } = await setup();

    await submit(user);

    expect(permissionRequests).not.toHaveBeenCalled();
  });
});

describe('focus once a request from the submit control settles', () => {
  it('returns focus to the submit control after a success, when the browser dropped it', async () => {
    stubBrowserChannel('denied');
    const { createMock, user } = await setup(async (input) => {
      dropFocusLikeABrowser();
      return makeReminder(input);
    });

    await fill(user, 'Call the dentist', FUTURE_DATE, FUTURE_TIME);
    await submit(user);

    await waitFor(() => {
      expect(textField()).toHaveValue('');
    });

    expect(createMock).toHaveBeenCalledTimes(1);
    expect(submitButton()).toBeEnabled();
    expect(submitButton()).toHaveFocus();
  });

  it('returns focus to the submit control after a failure that names no input', async () => {
    stubBrowserChannel('denied');
    const { user } = await setup(async () => {
      dropFocusLikeABrowser();
      return failWith(GENERIC_ERROR, 500);
    });

    await fill(user, 'Call the dentist', FUTURE_DATE, FUTURE_TIME);
    await submit(user);

    await waitFor(() => {
      expect(screen.getByText(GENERIC_ERROR)).toBeInTheDocument();
    });

    expect(submitButton()).toHaveFocus();
    expect(textField()).toHaveValue('Call the dentist');
  });

  it('sends focus to the named input, not back to the control, after a refusal of that input', async () => {
    stubBrowserChannel('denied');
    const { user } = await setup(async () => {
      dropFocusLikeABrowser();
      return failWith(SERVER_REFUSAL, 400, 'text');
    });

    await fill(user, 'Call the dentist', FUTURE_DATE, FUTURE_TIME);
    await submit(user);

    await waitFor(() => {
      expect(screen.getByText(SERVER_REFUSAL)).toBeInTheDocument();
    });

    expect(textField()).toHaveFocus();
    expect(submitButton()).not.toHaveFocus();
  });

  it('leaves focus where the user moved it during the request', async () => {
    stubBrowserChannel('denied');
    const { user } = await setup(async (input) => {
      dropFocusLikeABrowser();
      // The user moves on while the request is on the wire.
      textField().focus();
      return makeReminder(input);
    });

    await fill(user, 'Call the dentist', FUTURE_DATE, FUTURE_TIME);
    await submit(user);

    await waitFor(() => {
      expect(textField()).toHaveValue('');
    });

    expect(textField()).toHaveFocus();
    expect(submitButton()).not.toHaveFocus();
  });

  it('keeps focus in the text field when the form is submitted with Enter from it', async () => {
    stubBrowserChannel('denied');
    const { createMock, user } = await setup();

    await fill(user, '', FUTURE_DATE, FUTURE_TIME);
    await user.type(textField(), 'Call the dentist{Enter}');

    await waitFor(() => {
      expect(createMock).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(textField()).toHaveValue('');
    });

    expect(textField()).toHaveFocus();
  });
});

describe('a successful create', () => {
  it('clears the three inputs and the message, and counts from zero again', async () => {
    stubBrowserChannel('denied');
    const { createMock, user } = await setup();

    await fill(user, 'Call the dentist', FUTURE_DATE, FUTURE_TIME);
    await submit(user);

    await waitFor(() => {
      expect(createMock).toHaveBeenCalledTimes(1);
    });

    await waitFor(() => {
      expect(textField()).toHaveValue('');
    });
    expect(dateField()).toHaveValue('');
    expect(timeField()).toHaveValue('');
    expect(screen.getByText(`0 of ${MAX_TEXT_LENGTH} characters`)).toBeInTheDocument();
    for (const region of messageRegions()) {
      expect(region.textContent).toBe('');
    }
  });

  it('asks for permission once, on the first successful submit, and never on load', async () => {
    // The platform answers `granted`, which is what the real channel module reports once the request
    // has been made, so the second submit has nothing left to ask for.
    const channel = stubBrowserChannel('default', 'granted');
    const { createMock, user } = await setup();

    expect(permissionRequests).not.toHaveBeenCalled();
    expect(channel.platformRequests()).toBe(0);

    await fill(user, 'Call the dentist', FUTURE_DATE, FUTURE_TIME);
    await submit(user);

    await waitFor(() => {
      expect(createMock).toHaveBeenCalledTimes(1);
    });

    expect(permissionRequests).toHaveBeenCalledTimes(1);
    // The real channel module reached the platform exactly once: the form asked, and the ask got
    // through rather than being swallowed by a stand-in.
    expect(channel.platformRequests()).toBe(1);

    await fill(user, 'Book the tickets', FUTURE_DATE, FUTURE_TIME);
    await submit(user);

    await waitFor(() => {
      expect(createMock).toHaveBeenCalledTimes(2);
    });

    expect(permissionRequests).toHaveBeenCalledTimes(1);
    expect(channel.platformRequests()).toBe(1);
  });

  it.each(['denied', 'granted', 'unsupported'] as const)(
    'asks for permission under no reading but default (reading: %s)',
    async (reading) => {
      // `unsupported` is the browser with no notification API at all, which is the state a case that
      // installs no stub runs in — jsdom's own state.
      if (reading !== 'unsupported') {
        stubBrowserChannel(reading);
      }

      const { createMock, user } = await setup();

      await fill(user, 'Call the dentist', FUTURE_DATE, FUTURE_TIME);
      await submit(user);

      await waitFor(() => {
        expect(createMock).toHaveBeenCalledTimes(1);
      });
      expect(permissionRequests).not.toHaveBeenCalled();
    },
  );
});

describe('a failed create', () => {
  it('keeps every entered value and shows the server wording under the field it names', async () => {
    stubBrowserChannel('denied');
    const { createMock, user } = await setup(async () => failWith(SERVER_REFUSAL, 400, 'text'));

    await fill(user, 'Call the dentist', FUTURE_DATE, FUTURE_TIME);
    await submit(user);

    await waitFor(() => {
      expect(screen.getByText(SERVER_REFUSAL)).toBeInTheDocument();
    });

    const message = screen.getByText(SERVER_REFUSAL);

    expect(createMock).toHaveBeenCalledTimes(1);
    // Under the text field, not at form level and not under the due-time pair: the message is the
    // server's and the field it belongs under is the one the server named.
    expect(textField()).toHaveAttribute('aria-describedby', message.id);
    expect(message.parentElement).toContainElement(textField());
    expect(textField()).toHaveAttribute('aria-invalid', 'true');
    // The server named the text, so the text field is where the user is sent to correct it.
    expect(textField()).toHaveFocus();
    // Under that input and nowhere else: a failure the server attributed to an input is not repeated
    // at form level, so the form-level region stays empty.
    expect(messageRegions()).toHaveLength(4);
    expect(messageRegions()[0]?.textContent).toBe(SERVER_REFUSAL);
    expect(messageRegions()[3]?.textContent).toBe('');

    // Every entered value survives a refused create: the form is never emptied on an assumption.
    expect(textField()).toHaveValue('Call the dentist');
    expect(dateField()).toHaveValue(FUTURE_DATE);
    expect(timeField()).toHaveValue(FUTURE_TIME);
  });

  it('shows a failure that names no field at form level, keeping the values', async () => {
    stubBrowserChannel('denied');
    const { user } = await setup(async () => failWith(GENERIC_ERROR, 500));

    await fill(user, 'Call the dentist', FUTURE_DATE, FUTURE_TIME);
    await submit(user);

    await waitFor(() => {
      expect(screen.getByText(GENERIC_ERROR)).toBeInTheDocument();
    });

    // Form level: the form's fourth message region, outside every field wrapper, and neither input
    // is accused of anything — nor focused, since there is no input to send the user to.
    const regions = messageRegions();
    expect(regions).toHaveLength(4);
    expect(regions.at(-1)?.textContent).toBe(GENERIC_ERROR);
    expect(regions.at(-1)?.parentElement).toBe(form());
    expect(regions[0]?.textContent).toBe('');
    expect(regions[2]?.textContent).toBe('');
    expect(textField()).toHaveAttribute('aria-invalid', 'false');
    expect(dateField()).toHaveAttribute('aria-invalid', 'false');
    expect(timeField()).toHaveAttribute('aria-invalid', 'false');
    expect(textField()).not.toHaveFocus();
    expect(dateField()).not.toHaveFocus();
    expect(timeField()).not.toHaveFocus();

    expect(textField()).toHaveValue('Call the dentist');
    expect(dateField()).toHaveValue(FUTURE_DATE);
    expect(timeField()).toHaveValue(FUTURE_TIME);
  });

  it('shows a server refusal of the due time under the pair and focuses the pair, keeping the values', async () => {
    stubBrowserChannel('denied');
    const { createMock, user } = await setup(async () => failWith(SERVER_REFUSAL, 400, 'dueAt'));

    await fill(user, 'Call the dentist', FUTURE_DATE, FUTURE_TIME);
    await submit(user);

    await waitFor(() => {
      expect(screen.getByText(SERVER_REFUSAL)).toBeInTheDocument();
    });

    const message = screen.getByText(SERVER_REFUSAL);

    expect(createMock).toHaveBeenCalledTimes(1);
    // The pair's one region carries the server's wording, and both of its controls point at it.
    expect(messageRegions()[2]).toBe(message);
    expect(dateField()).toHaveAttribute('aria-describedby', message.id);
    expect(timeField()).toHaveAttribute('aria-describedby', message.id);
    expect(dateField()).toHaveAttribute('aria-invalid', 'true');
    expect(timeField()).toHaveAttribute('aria-invalid', 'true');
    expect(textField()).toHaveAttribute('aria-invalid', 'false');
    // Both controls hold a value, so the pair's first control is the one focused.
    expect(dateField()).toHaveFocus();
    expect(messageRegions()[3]?.textContent).toBe('');

    expect(textField()).toHaveValue('Call the dentist');
    expect(dateField()).toHaveValue(FUTURE_DATE);
    expect(timeField()).toHaveValue(FUTURE_TIME);
  });

  it('reports the generic wording for a failure that is not an ApiError, and keeps the values', async () => {
    stubBrowserChannel('denied');
    const { user } = await setup(async () => {
      throw new Error('an unexpected failure');
    });

    await fill(user, 'Call the dentist', FUTURE_DATE, FUTURE_TIME);
    await submit(user);

    await waitFor(() => {
      expect(screen.getByText(GENERIC_ERROR)).toBeInTheDocument();
    });

    // The raw error's own message is never shown: it is the one string that could carry something the
    // user should not read.
    expect(screen.queryByText('an unexpected failure')).not.toBeInTheDocument();
    expect(textField()).toHaveValue('Call the dentist');
  });

  it('enables the submit control again after the failure', async () => {
    stubBrowserChannel('denied');
    const { user } = await setup(async () => failWith(GENERIC_ERROR, 500));

    await fill(user, 'Call the dentist', FUTURE_DATE, FUTURE_TIME);
    await submit(user);

    await waitFor(() => {
      expect(screen.getByText(GENERIC_ERROR)).toBeInTheDocument();
    });

    expect(submitButton()).toBeEnabled();
  });
});
