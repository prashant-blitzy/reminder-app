/**
 * Tests for `./ReminderForm` — the create form's behaviour, exercised through the DOM a user sees.
 *
 * What this suite is the evidence for, and why each part of it is faked the way it is:
 *
 * - The four refusals and their exact wording. Each message is asserted against
 *   `VALIDATION_MESSAGES`, the one place the strings are written, so a reworded message fails here
 *   rather than silently reaching the user — and the same literals are asserted by
 *   `client/src/lib/validation.test.ts`, which is what holds the client copy and the server copy in
 *   step.
 * - The guarantee that a refused submission saves nothing: every refusal case asserts that the
 *   create call was never made. The call is a `vi.fn()` stand-in for the parent's create, which is
 *   also how the failure path is driven — the form's own `create` prop is the seam, so no HTTP layer,
 *   no server and no network is involved anywhere in this file.
 * - The one permission request, from the `default` reading only, on the submit gesture. The channel
 *   module is mocked, because what this suite must prove is when the form asks and when it does not;
 *   the module's own behaviour in each reading is `client/src/lib/notifications.test.ts`'s subject.
 * - The counter, the labels, the missing `maxLength`, and the field-wrapping the stylesheet's
 *   `nth-child(2)`/`:nth-child(3)` rules depend on.
 *
 * The clock is pinned (`vi.setSystemTime`) so that "in the future" and "in the past" are decided by
 * this file rather than by the day the suite happens to run, and the two dates are chosen far from
 * the pinned instant in both directions so no zone or daylight-saving offset can move the verdict.
 * `user-event` types and clicks as a user does; the two platform pickers are driven with
 * `fireEvent.change`, because jsdom does not implement a date input's own spinner.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ApiError } from '../lib/remindersApi';
import { toDueAtIso } from '../lib/time';
import { MAX_TEXT_LENGTH, VALIDATION_MESSAGES } from '../lib/validation';
import type { CreateReminderInput, Reminder } from '../types';
import { ReminderForm } from './ReminderForm';

/**
 * The channel the mocked notifications module reports, and the spy on the request the form spends.
 *
 * Held in `vi.hoisted` because `vi.mock`'s factory is hoisted above this file's imports and can only
 * see values that are hoisted with it.
 */
const channel = vi.hoisted(() => ({
  permission: 'default' as 'default' | 'granted' | 'denied' | 'unsupported',
  requestPermission: vi.fn(),
}));

vi.mock('../lib/notifications', () => ({
  getChannelSnapshot: () => ({
    permission: channel.permission,
    bannerText: `channel:${channel.permission}`,
    alerts: [],
  }),
  requestPermission: () => {
    channel.requestPermission();
    return Promise.resolve(channel.permission);
  },
}));

/** The instant the clock is pinned to, so no assertion below depends on the day of the run. */
const PINNED_NOW = new Date('2026-10-07T12:00:00Z');

/** A date and time far enough ahead of the pinned instant to be unambiguously in the future. */
const FUTURE_DATE = '2030-01-02';
const FUTURE_TIME = '09:30';

/** A date far enough behind the pinned instant to be unambiguously in the past. */
const PAST_DATE = '2020-01-01';
const PAST_TIME = '09:30';

/** Builds the reminder the create stub resolves with, echoing the input the form sent. */
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
 * Renders the form with a create stub and returns everything a test needs to drive and assert it.
 *
 * @param create The behaviour of the create prop; by default it resolves a reminder echoing the
 *   input, which is the success path.
 */
function setup(create?: (input: CreateReminderInput) => Promise<Reminder>) {
  const createMock = vi.fn(
    create ?? (async (input: CreateReminderInput): Promise<Reminder> => makeReminder(input)),
  );

  const view = render(<ReminderForm create={createMock} />);

  return { createMock, view, user: userEvent.setup() };
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

/** Submits the form the way a user does, by activating the control. */
async function submit(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(submitButton());
}

beforeEach(() => {
  // The clock is pinned, and the fake timers are told to advance with real time: the pin is what
  // makes "in the future" and "in the past" this file's decision rather than the run day's, and the
  // auto-advance is what lets Testing Library's and user-event's own timers still resolve instead of
  // waiting on a clock that never moves.
  vi.useFakeTimers({ now: PINNED_NOW, shouldAdvanceTime: true });
  channel.permission = 'default';
  channel.requestPermission.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the markup the contract fixes', () => {
  it('renders one form holding three labelled inputs and the Add reminder submit control', () => {
    setup();

    expect(form()).toBeInTheDocument();
    expect(textField()).toBeInTheDocument();
    expect(dateField()).toBeInTheDocument();
    expect(timeField()).toBeInTheDocument();
    expect(submitButton()).toBeInTheDocument();
  });

  it('keeps the three field wrappers as the form\'s first three children, in the plan\'s order', () => {
    setup();

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

  it('leaves the text input without a maxLength, so the bound is the rule\'s and not the browser\'s', () => {
    setup();

    expect(textField()).not.toHaveAttribute('maxlength');
    expect(textField()).toHaveAttribute('type', 'text');
    expect(dateField()).toHaveAttribute('type', 'date');
    expect(timeField()).toHaveAttribute('type', 'time');
  });

  it('counts what has been typed against the bound the rule measures against', async () => {
    const { user } = setup();

    expect(screen.getByText(`0 of ${MAX_TEXT_LENGTH} characters`)).toBeInTheDocument();

    await user.type(textField(), 'Water the plants');

    expect(screen.getByText(`16 of ${MAX_TEXT_LENGTH} characters`)).toBeInTheDocument();
  });

  it('reserves one message region per input, each announced without moving focus', () => {
    setup();

    const regions = document.querySelectorAll('.reminder-form__error');

    // Three, one per input, all present and empty: the reserved line is what keeps the row still
    // between an accepted and a rejected submit.
    expect(regions).toHaveLength(3);
    for (const region of regions) {
      expect(region).toHaveAttribute('aria-live', 'polite');
      expect(region.textContent).toBe('');
    }

    // Each control points at the region that describes it.
    expect(textField()).toHaveAttribute('aria-describedby', regions[0]?.id ?? '');
    expect(dateField()).toHaveAttribute('aria-describedby', regions[2]?.id ?? '');
    expect(timeField()).toHaveAttribute('aria-describedby', regions[2]?.id ?? '');
  });
});

describe('a refused submission', () => {
  it('reports empty text, focuses the text input and sends no request', async () => {
    const { createMock, user } = setup();

    await submit(user);

    expect(screen.getByText(VALIDATION_MESSAGES.TEXT_REQUIRED)).toBeInTheDocument();
    expect(textField()).toHaveFocus();
    expect(textField()).toHaveAttribute('aria-invalid', 'true');
    expect(createMock).not.toHaveBeenCalled();
  });

  it('treats whitespace-only text as missing and sends no request', async () => {
    const { createMock, user } = setup();

    await fill(user, '', FUTURE_DATE, FUTURE_TIME);
    await user.type(textField(), '   ');
    await submit(user);

    expect(screen.getByText(VALIDATION_MESSAGES.TEXT_REQUIRED)).toBeInTheDocument();
    expect(createMock).not.toHaveBeenCalled();
  });

  it('refuses a text one character over the bound, and sends no request', async () => {
    const { createMock, user } = setup();

    // Set directly rather than typed: the point of this case is the bound, and typing the bound plus
    // one character would spend the whole test's time budget on keystrokes.
    fireEvent.change(textField(), { target: { value: 'x'.repeat(MAX_TEXT_LENGTH + 1) } });
    fireEvent.change(dateField(), { target: { value: FUTURE_DATE } });
    fireEvent.change(timeField(), { target: { value: FUTURE_TIME } });
    await submit(user);

    expect(screen.getByText(VALIDATION_MESSAGES.TEXT_TOO_LONG)).toBeInTheDocument();
    expect(textField()).toHaveFocus();
    expect(createMock).not.toHaveBeenCalled();
  });

  it('accepts a text of exactly the bound and counts the trim, not the whitespace around it', async () => {
    const { createMock, user } = setup();

    await fill(user, '', FUTURE_DATE, FUTURE_TIME);
    fireEvent.change(textField(), { target: { value: `  ${'x'.repeat(MAX_TEXT_LENGTH)}  ` } });
    await submit(user);

    await waitFor(() => {
      expect(createMock).toHaveBeenCalledTimes(1);
    });

    const sent = createMock.mock.calls[0]?.[0];
    expect(sent?.text).toBe('x'.repeat(MAX_TEXT_LENGTH));
    expect(sent?.dueAt).toBe(toDueAtIso(FUTURE_DATE, FUTURE_TIME));
  });

  it('sends exactly the text and the due instant, and nothing else', async () => {
    const { createMock, user } = setup();

    await fill(user, 'Call the dentist', FUTURE_DATE, FUTURE_TIME);
    await submit(user);

    await waitFor(() => {
      expect(createMock).toHaveBeenCalledTimes(1);
    });

    const sent = createMock.mock.calls[0]?.[0];
    expect(sent === undefined ? [] : Object.keys(sent).sort()).toEqual(['dueAt', 'text']);
  });

  it('reports a missing date and time and focuses the control the user has yet to fill', async () => {
    const { createMock, user } = setup();

    await fill(user, 'Call the dentist', '', '');
    await submit(user);

    expect(screen.getByText(VALIDATION_MESSAGES.DUE_AT_INVALID)).toBeInTheDocument();
    expect(dateField()).toHaveFocus();
    expect(dateField()).toHaveAttribute('aria-invalid', 'true');
    expect(timeField()).toHaveAttribute('aria-invalid', 'true');
    expect(createMock).not.toHaveBeenCalled();
  });

  it('focuses the time control when only the time is missing', async () => {
    const { createMock, user } = setup();

    await fill(user, 'Call the dentist', FUTURE_DATE, '');
    await submit(user);

    expect(screen.getByText(VALIDATION_MESSAGES.DUE_AT_INVALID)).toBeInTheDocument();
    expect(timeField()).toHaveFocus();
    expect(createMock).not.toHaveBeenCalled();
  });

  it('reports a due time in the past and sends no request', async () => {
    const { createMock, user } = setup();

    await fill(user, 'Call the dentist', PAST_DATE, PAST_TIME);
    await submit(user);

    expect(screen.getByText(VALIDATION_MESSAGES.DUE_AT_IN_PAST)).toBeInTheDocument();
    expect(createMock).not.toHaveBeenCalled();
  });

  it('clears the message of the field being edited and leaves the other field untouched', async () => {
    const { user } = setup();

    await fill(user, 'Call the dentist', '', '');
    await submit(user);
    expect(screen.getByText(VALIDATION_MESSAGES.DUE_AT_INVALID)).toBeInTheDocument();

    fireEvent.change(dateField(), { target: { value: FUTURE_DATE } });

    expect(screen.queryByText(VALIDATION_MESSAGES.DUE_AT_INVALID)).not.toBeInTheDocument();
    expect(dateField()).toHaveAttribute('aria-invalid', 'false');
  });

  it('spends no permission request on a refused submission', async () => {
    const { user } = setup();

    await submit(user);

    expect(channel.requestPermission).not.toHaveBeenCalled();
  });
});

describe('a successful create', () => {
  it('clears the three inputs and the message, and counts from zero again', async () => {
    const { createMock, user } = setup();

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
    expect(document.querySelectorAll('.reminder-form__error')[0]?.textContent).toBe('');
  });

  it('asks for notification permission once, on the first submit, and never on load', async () => {
    // The platform answers `granted`, which is what the real channel module records after a
    // successful request; the second submit must therefore ask nothing.
    channel.requestPermission.mockImplementation(() => {
      channel.permission = 'granted';
    });

    const { createMock, user } = setup();

    expect(channel.requestPermission).not.toHaveBeenCalled();

    await fill(user, 'Call the dentist', FUTURE_DATE, FUTURE_TIME);
    await submit(user);

    await waitFor(() => {
      expect(createMock).toHaveBeenCalledTimes(1);
    });
    expect(channel.requestPermission).toHaveBeenCalledTimes(1);

    await fill(user, 'Book the tickets', FUTURE_DATE, FUTURE_TIME);
    await submit(user);

    await waitFor(() => {
      expect(createMock).toHaveBeenCalledTimes(2);
    });
    expect(channel.requestPermission).toHaveBeenCalledTimes(1);
  });

  it.each([
    { permission: 'denied' as const },
    { permission: 'granted' as const },
    { permission: 'unsupported' as const },
  ])(
    'asks for permission under no reading but default (reading: $permission)',
    async ({ permission }) => {
      channel.permission = permission;

      const { createMock, user } = setup();

      await fill(user, 'Call the dentist', FUTURE_DATE, FUTURE_TIME);
      await submit(user);

      await waitFor(() => {
        expect(createMock).toHaveBeenCalledTimes(1);
      });
      expect(channel.requestPermission).not.toHaveBeenCalled();
    },
  );
});

describe('a failed create', () => {
  it('keeps every entered value and shows the server wording under the field it names', async () => {
    const { createMock, user } = setup(async () => {
      throw new ApiError(VALIDATION_MESSAGES.TEXT_TOO_LONG, 400, 'text');
    });

    await fill(user, 'Call the dentist', FUTURE_DATE, FUTURE_TIME);
    await submit(user);

    await waitFor(() => {
      expect(screen.getByText(VALIDATION_MESSAGES.TEXT_TOO_LONG)).toBeInTheDocument();
    });

    expect(createMock).toHaveBeenCalledTimes(1);
    expect(textField()).toHaveValue('Call the dentist');
    expect(dateField()).toHaveValue(FUTURE_DATE);
    expect(timeField()).toHaveValue(FUTURE_TIME);
    expect(document.querySelectorAll('.reminder-form__error')[0]?.textContent).toBe(
      VALIDATION_MESSAGES.TEXT_TOO_LONG,
    );
  });

  it('shows a failure that names no field at form level, keeping the values', async () => {
    const { user } = setup(async () => {
      throw new ApiError(VALIDATION_MESSAGES.GENERIC_ERROR, 500);
    });

    await fill(user, 'Call the dentist', FUTURE_DATE, FUTURE_TIME);
    await submit(user);

    await waitFor(() => {
      expect(screen.getByText(VALIDATION_MESSAGES.GENERIC_ERROR)).toBeInTheDocument();
    });

    // Form level: the message is the form's fourth message region, and neither input is accused.
    expect(document.querySelectorAll('.reminder-form__error')).toHaveLength(4);
    expect(textField()).toHaveAttribute('aria-invalid', 'false');
    expect(dateField()).toHaveAttribute('aria-invalid', 'false');
    expect(textField()).toHaveValue('Call the dentist');
    expect(dateField()).toHaveValue(FUTURE_DATE);
    expect(timeField()).toHaveValue(FUTURE_TIME);
  });

  it('reports the generic wording for a failure that is not an ApiError, and keeps the values', async () => {
    const { user } = setup(async () => {
      throw new Error('an unexpected failure');
    });

    await fill(user, 'Call the dentist', FUTURE_DATE, FUTURE_TIME);
    await submit(user);

    await waitFor(() => {
      expect(screen.getByText(VALIDATION_MESSAGES.GENERIC_ERROR)).toBeInTheDocument();
    });

    // The raw error's own message is never shown: it is the one string that could carry something the
    // user should not read.
    expect(screen.queryByText('an unexpected failure')).not.toBeInTheDocument();
    expect(textField()).toHaveValue('Call the dentist');
  });

  it('enables the submit control again after the failure', async () => {
    const { user } = setup(async () => {
      throw new ApiError(VALIDATION_MESSAGES.GENERIC_ERROR, 500);
    });

    await fill(user, 'Call the dentist', FUTURE_DATE, FUTURE_TIME);
    await submit(user);

    await waitFor(() => {
      expect(screen.getByText(VALIDATION_MESSAGES.GENERIC_ERROR)).toBeInTheDocument();
    });

    expect(submitButton()).toBeEnabled();
  });
});
