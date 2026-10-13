/**
 * Tests for `./dueCheck` — the client's single definition of which reminders are due to be
 * notified, and of which of the three states a reminder is in.
 *
 * The suite is the evidence for two requirements. Notification correctness: exactly the reminders
 * that are due, uncompleted and never claimed are selected, so a reminder claimed on an earlier
 * tick or before a page reload is never selected a second time, and a reminder that came due while
 * the page was closed is selected exactly once on the next open — there is no grace window and no
 * recency check. Responsiveness: one selection pass over a 1,000-reminder list returns the expected
 * subset in the expected order, which is the client half of that bound, the whole selection being
 * client-side.
 *
 * Three properties of this file are deliberate.
 *
 * - It is PURE. The module takes the current instant as an argument, so every call below passes one
 *   fixed instant and nothing here needs a fake timer, a stubbed clock, a stubbed global or a
 *   network. A test in this file that needed a faked clock would mean the module had started
 *   reading the clock, and the fix for that would belong in the module rather than here. The only
 *   platform time calls anywhere are parses of instant strings this file supplies.
 * - `describe`, `it` and `expect` are vitest globals (`globals: true` in `client/vite.config.ts`),
 *   so nothing is imported from `'vitest'`. The imports are the unit under test and the reminder
 *   shape it consumes, and nothing else: this workspace declares no Node type definitions, so this
 *   file names no runtime global of its own either.
 * - Every instant here is absolute and every comparison under test is numeric, so no assertion
 *   depends on the host's zone or on the host's clock. The suite answers identically at any hour, in
 *   any zone, with no network.
 */

import type { Reminder } from '../types';
import { STATUS_LABELS, classify, selectDueReminders } from './dueCheck';
import type { ReminderStatus } from './dueCheck';

/**
 * The instant every test in this suite evaluates against.
 *
 * A constant rather than a reading of the clock: it is what makes each assertion reproducible, and
 * it is why this suite needs no clock control at all — the module under test receives this value as
 * an argument on every call.
 */
const NOW = '2026-10-07T12:00:00.000Z';

/** One millisecond after `NOW`, used to show the due bound includes `NOW` itself. */
const ONE_MILLISECOND_AFTER_NOW = '2026-10-07T12:00:00.001Z';

/** A creation instant for generated reminders. No assertion in this suite depends on it. */
const CREATED_AT = '2026-10-01T08:00:00.000Z';

/** The three statuses the module can produce, as the lower-case literals its consumers key on. */
const ALL_STATUSES: readonly ReminderStatus[] = ['upcoming', 'overdue', 'completed'];

/**
 * An absolute instant `minutes` before `NOW`.
 *
 * Derived arithmetically from the fixed `NOW`, so it is exactly as deterministic as `NOW` and reads
 * no clock: `Date.parse` here parses a constant string, and the rest is arithmetic on a number.
 */
function instantBeforeNow(minutes: number): string {
  return new Date(Date.parse(NOW) - minutes * 60_000).toISOString();
}

/** An absolute instant `minutes` after `NOW`, derived from it the same way. */
function instantAfterNow(minutes: number): string {
  return new Date(Date.parse(NOW) + minutes * 60_000).toISOString();
}

/**
 * One reminder, with only the fields the calling test is about overridden.
 *
 * The defaults describe a reminder that IS selected: it came due thirty minutes ago, it is not
 * completed, and its notification has never been claimed. Each test therefore names just the field
 * whose condition it exercises — `dueAt`, `completed` or `notifiedAt` — which keeps the assertion
 * honest about what it proves. A test that spelled out all six fields would hide which condition it
 * turns on, and could then pass while the module ignored that condition entirely.
 *
 * @param overrides The fields this test needs different from the defaults.
 */
function makeReminder(overrides: Partial<Reminder> = {}): Reminder {
  return {
    id: 'reminder-default',
    text: 'Default reminder text',
    dueAt: instantBeforeNow(30),
    completed: false,
    notifiedAt: null,
    createdAt: CREATED_AT,
    ...overrides,
  };
}

/** The ids of a selection, in the order the selection returned them. */
function idsOf(reminders: readonly Reminder[]): string[] {
  return reminders.map((reminder) => reminder.id);
}

describe('selectDueReminders — the three conditions are exact and all required', () => {
  it('selects a reminder that has come due, is uncompleted and is unnotified', () => {
    const due = makeReminder({ id: 'due', dueAt: instantBeforeNow(5) });
    const notYetDue = makeReminder({ id: 'not-yet-due', dueAt: instantAfterNow(5) });

    expect(idsOf(selectDueReminders([due, notYetDue], NOW))).toEqual(['due']);
  });

  it('selects a reminder sitting exactly on its due instant, because the bound is inclusive', () => {
    const exactlyDue = makeReminder({ id: 'exactly-due', dueAt: NOW });
    const oneMillisecondLater = makeReminder({
      id: 'one-millisecond-later',
      dueAt: ONE_MILLISECOND_AFTER_NOW,
    });

    expect(idsOf(selectDueReminders([exactlyDue, oneMillisecondLater], NOW))).toEqual([
      'exactly-due',
    ]);
  });

  it('does not select a completed reminder, even when it is overdue and unnotified', () => {
    const dueAt = instantBeforeNow(45);
    const completed = makeReminder({ id: 'completed', dueAt, completed: true });
    const stillOpen = makeReminder({ id: 'still-open', dueAt, completed: false });

    expect(idsOf(selectDueReminders([completed, stillOpen], NOW))).toEqual(['still-open']);
  });

  it('does not select a reminder whose notification was already claimed', () => {
    const dueAt = instantBeforeNow(45);
    const claimed = makeReminder({ id: 'claimed', dueAt, notifiedAt: instantBeforeNow(44) });
    const unclaimed = makeReminder({ id: 'unclaimed', dueAt, notifiedAt: null });

    expect(idsOf(selectDueReminders([claimed, unclaimed], NOW))).toEqual(['unclaimed']);
  });

  it('selects nothing when no reminder satisfies all three conditions', () => {
    const list: readonly Reminder[] = [
      makeReminder({ id: 'still-ahead', dueAt: instantAfterNow(1) }),
      makeReminder({ id: 'completed-and-due', dueAt: instantBeforeNow(1), completed: true }),
      makeReminder({ id: 'due-but-claimed', dueAt: instantBeforeNow(1), notifiedAt: NOW }),
      makeReminder({ id: 'completed-and-claimed', completed: true, notifiedAt: NOW }),
    ];

    expect(selectDueReminders(list, NOW)).toEqual([]);
  });

  it('preserves the order it was given rather than sorting by due time', () => {
    // The server returns the list already ordered by `dueAt ASC, id ASC`, so this function selects a
    // subset of it and must not sort: an input whose array order disagrees with its due-time order
    // proves that nothing here reorders anything.
    const input: readonly Reminder[] = [
      makeReminder({ id: 'earliest', dueAt: instantBeforeNow(180) }),
      makeReminder({ id: 'latest', dueAt: instantBeforeNow(60) }),
      makeReminder({ id: 'middle', dueAt: instantBeforeNow(120) }),
    ];

    expect(idsOf(selectDueReminders(input, NOW))).toEqual(['earliest', 'latest', 'middle']);
  });

  it('does not mutate the list it was given, and returns a new array', () => {
    const input: Reminder[] = [
      makeReminder({ id: 'due', dueAt: instantBeforeNow(10) }),
      makeReminder({ id: 'not-yet-due', dueAt: instantAfterNow(10) }),
      makeReminder({ id: 'claimed', dueAt: instantBeforeNow(10), notifiedAt: NOW }),
    ];
    const snapshot = input.map((reminder) => ({ ...reminder }));

    const selected = selectDueReminders(input, NOW);

    expect(selected).not.toBe(input);
    expect(input).toHaveLength(snapshot.length);
    expect(input).toEqual(snapshot);
    expect(idsOf(input)).toEqual(['due', 'not-yet-due', 'claimed']);
  });
});

describe('selectDueReminders — a reminder that came due while the page was closed', () => {
  it('selects it on the next open, with no grace window and no recency check', () => {
    // Three days late and one that has only just arrived are selected by the same rule: the
    // requirement is about reminders that have not been notified, not about how recent the due time
    // is, so nothing here may add a freshness window.
    const overdueSinceThreeDaysAgo = makeReminder({
      id: 'overdue-since-three-days-ago',
      dueAt: instantBeforeNow(3 * 24 * 60),
    });
    const becameDueJustNow = makeReminder({ id: 'became-due-just-now', dueAt: NOW });

    expect(idsOf(selectDueReminders([overdueSinceThreeDaysAgo, becameDueJustNow], NOW))).toEqual([
      'overdue-since-three-days-ago',
      'became-due-just-now',
    ]);
  });

  it('does not select it once its notification is claimed, which is what stops a reload re-firing', () => {
    // The claim is stored on the server rather than held in this session, so a reminder claimed on
    // the previous open is selected by nothing after a reload.
    const dueAt = instantBeforeNow(3 * 24 * 60);
    const claimedOnTheLastOpen = makeReminder({
      id: 'claimed-on-the-last-open',
      dueAt,
      notifiedAt: instantBeforeNow(3 * 24 * 60 - 1),
    });
    const neverClaimed = makeReminder({ id: 'never-claimed', dueAt, notifiedAt: null });

    expect(idsOf(selectDueReminders([claimedOnTheLastOpen, neverClaimed], NOW))).toEqual([
      'never-claimed',
    ]);
  });
});

describe('classify — the three states a row can be in', () => {
  it('reports a completed reminder as completed however long ago it was due, never overdue', () => {
    const completedAYearAgo = makeReminder({
      id: 'completed-a-year-ago',
      dueAt: instantBeforeNow(365 * 24 * 60),
      completed: true,
    });

    expect(classify(completedAYearAgo, NOW)).toBe('completed');
    // The negation is the requirement, not a restatement: a completed reminder must never carry the
    // Overdue label, however overdue its due instant is.
    expect(classify(completedAYearAgo, NOW)).not.toBe('overdue');
  });

  it('reports a completed reminder as completed even when its due time is still ahead', () => {
    expect(classify(makeReminder({ dueAt: instantAfterNow(60), completed: true }), NOW)).toBe(
      'completed',
    );
  });

  it('reports an uncompleted reminder that has come due as overdue, at and after its due instant', () => {
    expect(classify(makeReminder({ id: 'long-due', dueAt: instantBeforeNow(60) }), NOW)).toBe(
      'overdue',
    );
    // The same inclusive bound the selection uses: an instant equal to now is overdue, not upcoming,
    // so the row can never read Upcoming while the check treats that reminder as due.
    expect(classify(makeReminder({ id: 'exactly-due', dueAt: NOW }), NOW)).toBe('overdue');
  });

  it('reports an uncompleted reminder whose due instant is still ahead as upcoming', () => {
    expect(classify(makeReminder({ dueAt: instantAfterNow(1) }), NOW)).toBe('upcoming');
    expect(classify(makeReminder({ dueAt: ONE_MILLISECOND_AFTER_NOW }), NOW)).toBe('upcoming');
  });

  it('puts completion ahead of the due instant, so an overdue completed reminder is never overdue', () => {
    // The pair is the assertion: one due instant, complete and incomplete. Testing the due instant
    // before completion makes the second expectation read 'overdue', which is the defect this
    // ordering exists to prevent.
    const dueAt = instantBeforeNow(1);

    expect(classify(makeReminder({ id: 'open', dueAt, completed: false }), NOW)).toBe('overdue');
    expect(classify(makeReminder({ id: 'done', dueAt, completed: true }), NOW)).toBe('completed');
  });
});

describe('selectDueReminders and classify — offset-bearing and unreadable due instants', () => {
  // The server stores the due instant exactly as the client sent it, so an offset-bearing string can
  // reach these functions, and the comparison must be numeric. Text comparison misorders the two
  // cases marked below as traps, and misordering is not cosmetic: it would postpone a past
  // reminder's notification for good, or fire a future reminder's early.

  /**
   * 12:00 in a +02:00 zone is 10:00 UTC — two hours before NOW. As text it also sorts before NOW
   * (`+` precedes `.`), so it is due under either comparison and cannot by itself expose a text
   * comparison; the two trap constants below are the ones that sort on the wrong side of NOW.
   */
  const OFFSET_ALREADY_DUE = '2026-10-07T12:00:00+02:00';

  /** 13:00 in a +05:00 zone is 08:00 UTC — four hours before NOW, yet later than NOW as text. */
  const OFFSET_PAST_BUT_TEXTUALLY_LATER = '2026-10-07T13:00:00+05:00';

  /**
   * 14:00 in a +02:00 zone is 12:00 UTC — exactly NOW, so this reminder IS due, the bound being
   * inclusive. It is asserted with the inclusive-bound cases above rather than with the future ones
   * for that reason: an instant equal to now has arrived.
   */
  const OFFSET_EXACTLY_NOW = '2026-10-07T14:00:00+02:00';

  /** 16:00 in a +02:00 zone is 14:00 UTC — two hours after NOW. */
  const OFFSET_NOT_YET_DUE = '2026-10-07T16:00:00+02:00';

  /** 11:30 in a -01:00 zone is 12:30 UTC — thirty minutes after NOW, yet earlier than NOW as text. */
  const OFFSET_FUTURE_BUT_TEXTUALLY_EARLIER = '2026-10-07T11:30:00-01:00';

  it('selects and reports overdue an offset-bearing instant that is in the past', () => {
    expect(Date.parse(OFFSET_ALREADY_DUE)).toBeLessThan(Date.parse(NOW));

    const reminder = makeReminder({ id: 'offset-already-due', dueAt: OFFSET_ALREADY_DUE });

    expect(idsOf(selectDueReminders([reminder], NOW))).toEqual(['offset-already-due']);
    expect(classify(reminder, NOW)).toBe('overdue');
  });

  it('compares offset-bearing instants numerically, so a past one that sorts after NOW as text is still due', () => {
    expect(Date.parse(OFFSET_PAST_BUT_TEXTUALLY_LATER)).toBeLessThan(Date.parse(NOW));
    // The trap, stated: as text this instant lies beyond NOW, so a string comparison would leave
    // this past reminder unnotified for as long as it exists.
    expect(OFFSET_PAST_BUT_TEXTUALLY_LATER > NOW).toBe(true);

    const reminder = makeReminder({
      id: 'offset-past-textually-later',
      dueAt: OFFSET_PAST_BUT_TEXTUALLY_LATER,
    });

    expect(idsOf(selectDueReminders([reminder], NOW))).toEqual(['offset-past-textually-later']);
    expect(classify(reminder, NOW)).toBe('overdue');
  });

  it('treats an offset-bearing instant equal to NOW as due, on the same inclusive bound', () => {
    expect(Date.parse(OFFSET_EXACTLY_NOW)).toBe(Date.parse(NOW));

    const reminder = makeReminder({ id: 'offset-exactly-now', dueAt: OFFSET_EXACTLY_NOW });
    const stillAhead = makeReminder({ id: 'still-ahead', dueAt: instantAfterNow(1) });

    expect(idsOf(selectDueReminders([reminder, stillAhead], NOW))).toEqual(['offset-exactly-now']);
    expect(classify(reminder, NOW)).toBe('overdue');
  });

  it('does not select an offset-bearing instant that is still ahead', () => {
    expect(Date.parse(OFFSET_NOT_YET_DUE)).toBeGreaterThan(Date.parse(NOW));

    const reminder = makeReminder({ id: 'offset-not-yet-due', dueAt: OFFSET_NOT_YET_DUE });
    const due = makeReminder({ id: 'due', dueAt: instantBeforeNow(1) });

    expect(idsOf(selectDueReminders([reminder, due], NOW))).toEqual(['due']);
    expect(classify(reminder, NOW)).toBe('upcoming');
  });

  it('compares offset-bearing instants numerically, so a future one that sorts before NOW as text is not due', () => {
    expect(Date.parse(OFFSET_FUTURE_BUT_TEXTUALLY_EARLIER)).toBeGreaterThan(Date.parse(NOW));
    // The trap in the other direction: as text this instant lies before NOW, so a string comparison
    // would treat a reminder that has not arrived as due and notify it early.
    expect(OFFSET_FUTURE_BUT_TEXTUALLY_EARLIER < NOW).toBe(true);

    const reminder = makeReminder({
      id: 'offset-future-textually-earlier',
      dueAt: OFFSET_FUTURE_BUT_TEXTUALLY_EARLIER,
    });

    expect(selectDueReminders([reminder], NOW)).toEqual([]);
    expect(classify(reminder, NOW)).toBe('upcoming');
  });

  it('never selects or reports overdue a due instant the platform cannot read', () => {
    const unreadable = makeReminder({ id: 'unreadable', dueAt: 'garbage' });
    const empty = makeReminder({ id: 'empty', dueAt: '' });
    const readable = makeReminder({ id: 'readable', dueAt: instantBeforeNow(1) });

    expect(idsOf(selectDueReminders([unreadable, empty, readable], NOW))).toEqual(['readable']);
    // A reminder that cannot be shown to be past due must not be presented as overdue, and must not
    // be notified either: the state is Upcoming, and the notification condition needs a real instant.
    expect(classify(unreadable, NOW)).toBe('upcoming');
    expect(classify(empty, NOW)).not.toBe('overdue');
  });

  it('selects nothing and never reports overdue when the supplied current instant cannot be read', () => {
    const due = makeReminder({ id: 'due', dueAt: instantBeforeNow(1) });

    // An unreadable "now" cannot establish that anything has come due, so nothing is selected: an
    // empty selection is the safe answer, and the alternative would notify on a failed comparison.
    expect(selectDueReminders([due], 'garbage')).toEqual([]);
    expect(selectDueReminders([due], '')).toEqual([]);
    expect(classify(due, 'garbage')).toBe('upcoming');
  });
});

describe('selectDueReminders and classify — a 1,000-reminder list', () => {
  /** How many reminders the generated list holds — the load the responsiveness bound names. */
  const TOTAL = 1000;

  /** The four shapes the generator cycles through, one per reminder. */
  type GeneratedShape = 'due-unnotified' | 'due-notified' | 'completed-overdue' | 'upcoming';

  /**
   * The shape of the reminder at `index`.
   *
   * One source for the generated list's composition: the list is built from this function and the
   * expected selection and statuses are computed from it, so no expectation can drift from the data
   * it describes and no count is written down twice.
   */
  function shapeFor(index: number): GeneratedShape {
    switch (index % 4) {
      case 0:
        return 'due-unnotified';
      case 1:
        return 'due-notified';
      case 2:
        return 'completed-overdue';
      default:
        return 'upcoming';
    }
  }

  /** The status each shape implies for a reminder evaluated at `NOW` or later. */
  const STATUS_OF_SHAPE: Record<GeneratedShape, ReminderStatus> = {
    'due-unnotified': 'overdue',
    'due-notified': 'overdue',
    'completed-overdue': 'completed',
    upcoming: 'upcoming',
  };

  /** One reminder in the shape `index` calls for; every due instant is distinct. */
  function generate(index: number): Reminder {
    const minutes = index + 1;
    const id = `generated-${index}`;
    const text = `Generated reminder ${index}`;

    switch (shapeFor(index)) {
      case 'due-unnotified':
        return makeReminder({ id, text, dueAt: instantBeforeNow(minutes) });
      case 'due-notified':
        return makeReminder({
          id,
          text,
          dueAt: instantBeforeNow(minutes),
          notifiedAt: instantBeforeNow(minutes - 1),
        });
      case 'completed-overdue':
        return makeReminder({ id, text, dueAt: instantBeforeNow(minutes), completed: true });
      case 'upcoming':
        return makeReminder({ id, text, dueAt: instantAfterNow(minutes) });
    }
  }

  // Read-only, so the calls below also stand as evidence that the module accepts and honours the
  // read-only list the client holds rather than a mutable copy of it.
  const generated: readonly Reminder[] = Array.from({ length: TOTAL }, (_unused, index) =>
    generate(index),
  );

  /** The ids the selection must return, in order, computed from the generator's own rule. */
  const expectedSelectedIds = generated
    .filter((_reminder, index) => shapeFor(index) === 'due-unnotified')
    .map((reminder) => reminder.id);

  /** The status each reminder must be classified as, computed from the generator's own rule. */
  const expectedStatuses = generated.map((_reminder, index) => STATUS_OF_SHAPE[shapeFor(index)]);

  it('selects exactly the due, uncompleted, unnotified reminders, in the order it was given', () => {
    const selected = selectDueReminders(generated, NOW);

    // Computed from the generator rather than hard-coded, and neither empty nor the whole list: a
    // module that selected everything, or nothing, fails here instead of passing an assertion about
    // a degenerate list.
    expect(expectedSelectedIds.length).toBeGreaterThan(0);
    expect(expectedSelectedIds.length).toBeLessThan(TOTAL);
    expect(selected).toHaveLength(expectedSelectedIds.length);
    expect(idsOf(selected)).toEqual(expectedSelectedIds);
  });

  it('classifies all 1,000 reminders, giving each the status its generated shape implies', () => {
    const statuses = generated.map((reminder) => classify(reminder, NOW));

    expect(statuses).toHaveLength(TOTAL);
    expect(statuses).toEqual(expectedStatuses);
    // Every one of the 1,000 is one of the three statuses, and all three are present, so no status
    // is undefined or invented at this size.
    expect(new Set(statuses).size).toBe(ALL_STATUSES.length);
    expect([...new Set(statuses)].sort()).toEqual([...ALL_STATUSES].sort());
  });
});

describe('the statuses and labels the consumers read', () => {
  it('names the three statuses in lower case, the form the stylesheet keys its treatments on', () => {
    const produced = [
      classify(makeReminder({ dueAt: instantAfterNow(1) }), NOW),
      classify(makeReminder({ dueAt: instantBeforeNow(1) }), NOW),
      classify(makeReminder({ dueAt: instantBeforeNow(1), completed: true }), NOW),
    ];

    // Exactly these three literals: `client/src/styles.css` keys `.reminder-item--upcoming`,
    // `.reminder-item--overdue` and `.reminder-item--completed` on them, so a differently cased or
    // differently spelled status silently loses its treatment.
    expect(produced).toEqual(['upcoming', 'overdue', 'completed']);
    expect(Object.keys(STATUS_LABELS)).toHaveLength(ALL_STATUSES.length);
    expect(Object.keys(STATUS_LABELS).sort()).toEqual([...ALL_STATUSES].sort());
  });

  it('supplies the label a row renders for each status, from STATUS_LABELS alone', () => {
    expect(STATUS_LABELS[classify(makeReminder({ dueAt: instantAfterNow(1) }), NOW)]).toBe(
      'Upcoming',
    );
    expect(STATUS_LABELS[classify(makeReminder({ dueAt: instantBeforeNow(1) }), NOW)]).toBe(
      'Overdue',
    );
    expect(STATUS_LABELS[classify(makeReminder({ completed: true }), NOW)]).toBe('Completed');
  });

  it('labels every status the module can produce, and no label is the status name itself', () => {
    for (const status of ALL_STATUSES) {
      const label = STATUS_LABELS[status];
      expect(label, `STATUS_LABELS must label '${status}'`).toBeTruthy();
      // The status is carried by these words and never by colour alone, so a label equal to the raw
      // status would put a lower-case token in front of the user.
      expect(label).not.toBe(status);
    }
  });
});
