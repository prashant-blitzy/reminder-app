/**
 * Tests for `./ReminderList` — the ordered rows, the state each row is shown in, and the list's own
 * empty, loading and error regions, exercised through the DOM a user sees.
 *
 * What this suite is the evidence for, and why each part of it is arranged the way it is:
 *
 * - The order is the server's. The fixtures arrive already ordered by `dueAt ASC, id ASC`, two of
 *   them sharing a due instant, and the cases below assert the rendered text sequence equals that
 *   array verbatim. The fixture texts are deliberately in no alphabetical order, so a reordering
 *   performed by the component — the thing these cases exist to rule out — changes the sequence
 *   they assert.
 * - The three states are decided against one fixed instant. `now` is a literal string passed as a
 *   prop and every due instant is derived from it by arithmetic, so no assertion here depends on the
 *   host's clock, on its zone, or on the day the suite runs. Nothing in this file fakes a clock: the
 *   component receives the instant as a prop and never reads one, so a fake here would hide the very
 *   regression that would need catching.
 * - The three status words, the empty-state sentence and the retry label are written out below in
 *   this file rather than imported from the components, so a reworded string fails here instead of
 *   silently reaching the user.
 * - The interactions are the three callbacks. The list performs no request and a row owns no state,
 *   so every control is driven with `user-event` and asserted by the exact id the callback received.
 *   Nothing here reaches a host, a network, storage or a browser channel API: there is no stub for a
 *   notification channel in this file because the list never touches one, and such a stub would hide
 *   that.
 * - The region classes are asserted by name because they are a fixed contract with
 *   `client/src/styles.css`, which carries a rule for every one of them — including the two
 *   treatment modifiers, which are what tint an overdue row and strike a completed row's text
 *   through.
 *
 * The test runner's globals are configured for this workspace (`client/vite.config.ts`), so
 * `describe`, `it`, `expect` and `vi` are used here without a per-file import of the runner, and the
 * DOM matchers are registered once by `client/src/setupTests.ts`. The client workspace declares no
 * Node type definitions, so no host runtime global is named anywhere in this file.
 */

import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import type { Reminder } from '../types';
import { ReminderList } from './ReminderList';

/**
 * The instant every classification below is decided against.
 *
 * A constant rather than a reading of the clock, which is what makes every case in this file answer
 * identically at any hour, in any zone, on any day.
 */
const NOW = '2026-10-07T12:00:00.000Z';

/** A creation instant for the generated reminders. No assertion below depends on it. */
const CREATED_AT = '2026-10-01T08:00:00.000Z';

/** The status word a row shows while its due time is still ahead. */
const UPCOMING_LABEL = 'Upcoming';

/** The status word a row shows once its due time has passed while it is not completed. */
const OVERDUE_LABEL = 'Overdue';

/** The status word a row shows once it is completed, whatever its due time. */
const COMPLETED_LABEL = 'Completed';

/** The empty-state sentence, exactly as the list renders it. */
const EMPTY_MESSAGE = 'No reminders yet. Add your first reminder above.';

/** The retry control's label, exactly as the list renders it. */
const RETRY_LABEL = 'Retry';

/** A message a failed request would report; the banner shows whatever message it is given. */
const ERROR_MESSAGE = 'Something went wrong. Please try again.';

/** An absolute instant `minutes` before `NOW`, derived from it arithmetically. */
function instantBeforeNow(minutes: number): string {
  return new Date(Date.parse(NOW) - minutes * 60_000).toISOString();
}

/** An absolute instant `minutes` after `NOW`, derived from it the same way. */
function instantAfterNow(minutes: number): string {
  return new Date(Date.parse(NOW) + minutes * 60_000).toISOString();
}

/**
 * The due instant the second and third fixtures share, so that their order is decided by the `id`
 * tiebreak alone — exactly the pair the server's `dueAt ASC, id ASC` returns and the list must keep.
 */
const SHARED_DUE_AT = instantAfterNow(30);

/**
 * One reminder, with only the fields a case is about overridden.
 *
 * The defaults describe an uncompleted reminder that is still ahead of `NOW` and whose notification
 * has never been claimed, so each case names just the field it exercises and no object literal can
 * drift from the six-field shape.
 */
function makeReminder(overrides: Partial<Reminder> & { id: string }): Reminder {
  const { id } = overrides;

  return {
    id,
    text: overrides.text ?? `Reminder ${id}`,
    dueAt: overrides.dueAt ?? instantAfterNow(60),
    completed: overrides.completed ?? false,
    notifiedAt: overrides.notifiedAt ?? null,
    createdAt: overrides.createdAt ?? CREATED_AT,
  };
}

/**
 * The four reminders the ordering cases render, in the order the server returns them: due time
 * ascending, with the shared due instant of the second and third broken by their ids.
 */
const SERVER_ORDER: readonly Reminder[] = [
  makeReminder({ id: 'a-earliest', text: 'First by due time', dueAt: instantBeforeNow(120) }),
  makeReminder({ id: 'b-tie', text: 'Second by due time', dueAt: SHARED_DUE_AT }),
  makeReminder({ id: 'c-tie', text: 'Third by due time', dueAt: SHARED_DUE_AT }),
  makeReminder({ id: 'd-latest', text: 'Fourth by due time', dueAt: instantAfterNow(240) }),
];

/** The fixture carrying a given id, so a case never reaches into the array by position. */
function reminderWithId(reminders: readonly Reminder[], id: string): Reminder {
  const reminder = reminders.find((candidate) => candidate.id === id);

  if (reminder === undefined) {
    throw new Error(`no fixture carries the id ${id}`);
  }

  return reminder;
}

/** The rendered rows, in document order. */
function rows(): HTMLElement[] {
  return screen.getAllByRole('listitem');
}

/** The reminder text of each rendered row, read in document order. */
function renderedTexts(): string[] {
  return rows().map((row) => {
    const text = row.querySelector('.reminder-item__text');

    if (!(text instanceof HTMLElement)) {
      throw new Error('a rendered row carried no reminder text');
    }

    return text.textContent ?? '';
  });
}

/** The row rendered for a reminder, found by the text the user reads. */
function rowFor(reminder: Reminder): HTMLElement {
  const text = screen.getByText(reminder.text);
  const row = text.closest('li');

  if (!(row instanceof HTMLElement)) {
    throw new Error(`no row was rendered for reminder ${reminder.id}`);
  }

  return row;
}

/** The status word a row shows. */
function statusOf(row: HTMLElement): string {
  const status = row.querySelector('.reminder-item__status');

  if (!(status instanceof HTMLElement)) {
    throw new Error('a rendered row carried no status label');
  }

  return status.textContent ?? '';
}

/** The element carrying a contract class name, which the region cases below assert against. */
function classElement(className: string): HTMLElement {
  const element = document.querySelector(`.${className}`);

  if (!(element instanceof HTMLElement)) {
    throw new Error(`no element carrying the class ${className} was rendered`);
  }

  return element;
}

/** The element carrying a contract class name, or `null` where the region must be absent. */
function classElementOrNull(className: string): HTMLElement | null {
  const element = document.querySelector(`.${className}`);

  return element instanceof HTMLElement ? element : null;
}

/** What `setup` hands back: the three callback stubs the list delegates to, and a user driving it. */
interface RenderedList {
  onRetry: ReturnType<typeof vi.fn>;
  onComplete: ReturnType<typeof vi.fn>;
  onRemove: ReturnType<typeof vi.fn>;
  user: ReturnType<typeof userEvent.setup>;
}

/**
 * Renders the list with stubs for its three callbacks and returns them.
 *
 * Every property the list requires is passed explicitly, so a case names the state it renders rather
 * than relying on a default that could quietly change. What the callbacks receive is the assertion:
 * the list is a renderer, so its whole observable behaviour is the markup it produces and the ids it
 * hands back.
 */
function setup(
  options: {
    reminders?: readonly Reminder[];
    loading?: boolean;
    error?: string | null;
  } = {},
): RenderedList {
  const onRetry = vi.fn();
  const onComplete = vi.fn();
  const onRemove = vi.fn();

  render(
    <ReminderList
      reminders={options.reminders ?? []}
      loading={options.loading ?? false}
      now={NOW}
      error={options.error ?? null}
      onRetry={onRetry}
      onComplete={onComplete}
      onRemove={onRemove}
    />,
  );

  return { onRetry, onComplete, onRemove, user: userEvent.setup() };
}

describe('the order the rows are rendered in', () => {
  it('renders one list item per reminder inside the list element', () => {
    setup({ reminders: SERVER_ORDER });

    const list = classElement('reminder-list__items');

    expect(classElement('reminder-list').tagName).toBe('SECTION');
    expect(list.tagName).toBe('UL');
    expect(rows()).toHaveLength(SERVER_ORDER.length);
    expect(list.querySelectorAll('li.reminder-item')).toHaveLength(SERVER_ORDER.length);
  });

  it('renders the reminders in the order they arrived, including a pair sharing a due time', () => {
    setup({ reminders: SERVER_ORDER });

    // Read as a sequence from the rendered rows rather than from one of them: an ordering claim is
    // about the whole list, and the middle pair shares its due instant, so only the ids order it.
    expect(renderedTexts()).toEqual([
      'First by due time',
      'Second by due time',
      'Third by due time',
      'Fourth by due time',
    ]);

    // And the same sequence stated from the fixtures the case supplied, so the two cannot drift.
    expect(renderedTexts()).toEqual(SERVER_ORDER.map((reminder) => reminder.text));
  });
});

describe('the state a row is shown in', () => {
  /** One row per state, each classified against the fixed instant above. */
  const upcoming = makeReminder({ id: 'upcoming', text: 'Still ahead', dueAt: instantAfterNow(30) });
  const overdue = makeReminder({ id: 'overdue', text: 'Already due', dueAt: instantBeforeNow(30) });
  const completed = makeReminder({
    id: 'completed',
    text: 'Done and long past due',
    dueAt: instantBeforeNow(1440),
    completed: true,
  });

  it('reads Upcoming while the due time is ahead, Overdue once it has passed, and Completed when done', () => {
    setup({ reminders: [upcoming, overdue, completed] });

    expect(statusOf(rowFor(upcoming))).toBe(UPCOMING_LABEL);
    expect(statusOf(rowFor(overdue))).toBe(OVERDUE_LABEL);
    expect(statusOf(rowFor(completed))).toBe(COMPLETED_LABEL);
  });

  it('marks a past-due uncompleted row with the overdue treatment the stylesheet keys on', () => {
    setup({ reminders: [overdue] });

    const row = rowFor(overdue);

    expect(row).toHaveClass('reminder-item');
    expect(row).toHaveClass('reminder-item--overdue');
    expect(row).not.toHaveClass('reminder-item--completed');
    expect(statusOf(row)).toBe(OVERDUE_LABEL);
  });

  it('shows a completed reminder as Completed however long ago it was due, never as Overdue', () => {
    setup({ reminders: [completed] });

    const row = rowFor(completed);

    expect(row).toHaveClass('reminder-item--completed');
    expect(row).not.toHaveClass('reminder-item--overdue');
    expect(statusOf(row)).toBe(COMPLETED_LABEL);
    // Scoped to the row, so the word itself is absent rather than merely outranked by another.
    expect(within(row).queryByText(OVERDUE_LABEL)).toBeNull();
  });

  it('keeps a completed row identified by its text, so the list still says which one it is', () => {
    setup({ reminders: [completed] });

    expect(within(rowFor(completed)).getByText(completed.text)).toBeInTheDocument();
  });
});

describe('the empty and loading states', () => {
  it('shows the empty message word for word when there is nothing to list', () => {
    setup({ reminders: [], loading: false, error: null });

    expect(classElement('reminder-list__empty').textContent).toBe(EMPTY_MESSAGE);
    expect(classElementOrNull('reminder-list__placeholder')).toBeNull();
    // The query form, because a throwing getter would report the absence of rows as a test error
    // rather than as the empty list this case is about.
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
    expect(classElementOrNull('reminder-list__items')).toBeNull();
  });

  it('shows the loading placeholder instead of the empty message while the first read is in flight', () => {
    setup({ reminders: [], loading: true, error: null });

    expect((classElement('reminder-list__placeholder').textContent ?? '').trim()).not.toBe('');
    expect(classElementOrNull('reminder-list__empty')).toBeNull();
    expect(screen.queryByText(EMPTY_MESSAGE)).toBeNull();
  });

  it('leaves exactly one of the two regions on screen in each of the two states', () => {
    const observed: { loading: boolean; placeholder: boolean; empty: boolean }[] = [];

    for (const loading of [true, false]) {
      cleanup();
      setup({ reminders: [], loading });

      observed.push({
        loading,
        placeholder: classElementOrNull('reminder-list__placeholder') !== null,
        empty: classElementOrNull('reminder-list__empty') !== null,
      });
    }

    // Exactly one of the two, and the right one of the two: which region belongs to which state is
    // part of the arrangement, not only the count.
    expect(observed).toEqual([
      { loading: true, placeholder: true, empty: false },
      { loading: false, placeholder: false, empty: true },
    ]);
  });

  it('keeps the rows on screen while a later read is in flight', () => {
    setup({ reminders: SERVER_ORDER, loading: true, error: null });

    // The placeholder belongs to the first read alone: a refetch of a populated list keeps the rows
    // the user already has instead of blanking them.
    expect(classElementOrNull('reminder-list__placeholder')).toBeNull();
    expect(renderedTexts()).toEqual(SERVER_ORDER.map((reminder) => reminder.text));
  });
});

describe('the row controls', () => {
  const first = reminderWithId(SERVER_ORDER, 'a-earliest');
  const third = reminderWithId(SERVER_ORDER, 'c-tie');

  it('offers Complete then Delete on a row that is not completed', () => {
    setup({ reminders: [first] });

    const controls = within(rowFor(first)).getAllByRole('button');

    // The order is part of the visual contract: the stylesheet gives the cluster's last action the
    // danger treatment, so Delete must come after Complete.
    expect(controls.map((control) => control.textContent)).toEqual(['Complete', 'Delete']);
  });

  it('calls onComplete with the exact id of the row whose Complete control was used', async () => {
    const { onComplete, onRemove, user } = setup({ reminders: SERVER_ORDER });

    await user.click(within(rowFor(third)).getByRole('button', { name: 'Complete' }));

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith(third.id);
    expect(onRemove).not.toHaveBeenCalled();
  });

  it('calls onRemove with the exact id of the row whose Delete control was used', async () => {
    const { onComplete, onRemove, user } = setup({ reminders: SERVER_ORDER });

    await user.click(within(rowFor(first)).getByRole('button', { name: 'Delete' }));

    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onRemove).toHaveBeenCalledWith(first.id);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('offers no second Complete control on a completed row while Delete remains', async () => {
    const done = makeReminder({
      id: 'done',
      text: 'Already completed',
      dueAt: instantBeforeNow(60),
      completed: true,
    });
    const open = makeReminder({ id: 'open', text: 'Still to do', dueAt: instantAfterNow(60) });
    const { onComplete, onRemove, user } = setup({ reminders: [open, done] });

    const completedRow = rowFor(done);

    expect(within(completedRow).queryByRole('button', { name: 'Complete' })).toBeNull();
    expect(within(rowFor(open)).getByRole('button', { name: 'Complete' })).toBeInTheDocument();

    // Deletion is offered in either completion state, which is what the remaining control is for.
    await user.click(within(completedRow).getByRole('button', { name: 'Delete' }));

    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onRemove).toHaveBeenCalledWith(done.id);
    expect(onComplete).not.toHaveBeenCalled();
  });
});

describe('the single error banner', () => {
  it('renders exactly one alert region carrying the given message verbatim and a working retry control', async () => {
    const { onRetry, user } = setup({ reminders: [], error: ERROR_MESSAGE });

    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(classElement('error-banner__message').textContent).toBe(ERROR_MESSAGE);

    const retry = classElement('error-banner__retry');

    expect(retry.tagName).toBe('BUTTON');
    expect(retry.textContent).toBe(RETRY_LABEL);

    await user.click(screen.getByRole('button', { name: RETRY_LABEL }));

    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('renders no alert region at all when nothing has failed', () => {
    setup({ reminders: SERVER_ORDER, error: null });

    expect(screen.queryAllByRole('alert')).toHaveLength(0);
    expect(classElementOrNull('error-banner')).toBeNull();
  });

  it('does not tell the user the list is empty when a read failed with nothing on screen', () => {
    setup({ reminders: [], loading: false, error: ERROR_MESSAGE });

    // A failed read with nothing cached is reported as the failure alone: saying the list is empty
    // would state something the application does not know.
    expect(classElement('error-banner')).toBeInTheDocument();
    expect(classElementOrNull('reminder-list__empty')).toBeNull();
    expect(classElementOrNull('reminder-list__placeholder')).toBeNull();
    expect(screen.queryByText(EMPTY_MESSAGE)).toBeNull();
  });

  it('keeps the rows on screen and usable under the banner after a failed action', async () => {
    const { onRemove, user } = setup({ reminders: SERVER_ORDER, error: ERROR_MESSAGE });
    const third = reminderWithId(SERVER_ORDER, 'c-tie');

    expect(classElement('error-banner')).toBeInTheDocument();
    expect(renderedTexts()).toEqual(SERVER_ORDER.map((reminder) => reminder.text));

    await user.click(within(rowFor(third)).getByRole('button', { name: 'Delete' }));

    expect(onRemove).toHaveBeenCalledWith(third.id);
  });
});
