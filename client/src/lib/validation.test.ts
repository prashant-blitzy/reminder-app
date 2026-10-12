/**
 * Tests for `./validation` — the client's copy of the reminder input rules and their messages.
 *
 * This file is the evidence for the validation requirements: every refusal produces its exact message
 * and the field it is attributed to, empty and whitespace-only text are refused identically, the
 * 280-character bound is exact and measured over the trimmed text, a due time at or before the
 * current instant is refused while a future one is accepted, and an accepted submission yields a
 * request body holding exactly `text` and `dueAt`.
 *
 * The one technique that makes this suite worth anything: the seven message literals are written out
 * HERE, character for character, and are never imported from the module under test. `./validation` and
 * the server's `src/validation/reminderInput.ts` are deliberate copies of one rule set — the two
 * workspaces meet only over HTTP — and the copies are held in step by assertion rather than trusted:
 * the server's test hard-codes the same seven strings, so a reword made to one copy alone fails a test
 * in its own tree. An assertion against a string imported from the module, or a constant checked
 * against itself, can never fail and would therefore be no evidence at all. The literal table is typed
 * `satisfies Record<keyof typeof VALIDATION_MESSAGES, string>`, so a key added to or removed from the
 * module stops this file compiling until the table is kept level with it.
 *
 * Two properties keep the suite deterministic and honest:
 *
 * - It needs no fakes. The current instant is a parameter of `validateReminderInput`, so one fixed
 *   instant is passed everywhere and no case's outcome depends on the wall clock, on the host's zone,
 *   on a fake timer or on a stubbed environment. Cases that must sit exactly on the past-due boundary
 *   derive their "current instant" from the due instant they are judging, which makes them
 *   zone-independent. If this file ever seems to need fake timers, the module has read a clock it
 *   must not read, and the module is what needs fixing.
 * - It mocks nothing, opens no socket and reads no clock of its own; instead it asserts the module's
 *   purity — repeat calls agree and the values object is not mutated — rather than assuming it.
 */

import { toDueAtIso } from './time';
import type { CreateReminderInput } from '../types';
import { MAX_TEXT_LENGTH, VALIDATION_MESSAGES, validateReminderInput } from './validation';
import type { ReminderFormValues, ValidationResult } from './validation';

/**
 * The seven message literals, written out character for character.
 *
 * These are the wording the user reads. The first four are this module's own rejections, produced
 * while validating a create-form submission; the last three are the server's wordings, which the
 * client displays rather than produces: they live in `VALIDATION_MESSAGES` so `remindersApi.ts` has a
 * fallback for a failure body it cannot read, and so this file can hold them to the same standard.
 * Rewording, re-punctuating, re-spacing or re-casing any of them is a change to what the user sees,
 * and it fails here and in the server's own validation test.
 */
const EXPECTED_MESSAGES = {
  TEXT_REQUIRED: 'Enter a reminder text.',
  TEXT_TOO_LONG: 'Reminder text must be 280 characters or fewer.',
  DUE_AT_INVALID: 'Enter a valid due date and time.',
  DUE_AT_IN_PAST: 'The due time must be in the future.',
  BODY_INVALID_JSON: 'Request body must be valid JSON.',
  NOT_FOUND: 'Reminder not found.',
  GENERIC_ERROR: 'Something went wrong. Please try again.',
} as const satisfies Record<keyof typeof VALIDATION_MESSAGES, string>;

/** The keys of the literal table, one test case each. */
const EXPECTED_MESSAGE_KEYS = Object.keys(EXPECTED_MESSAGES) as ReadonlyArray<
  keyof typeof EXPECTED_MESSAGES
>;

/** The keys the module actually exposes, which the table above must cover exactly. */
const MODULE_MESSAGE_KEYS = Object.keys(VALIDATION_MESSAGES) as ReadonlyArray<
  keyof typeof VALIDATION_MESSAGES
>;

/**
 * The instant every case is judged against, supplied as `nowIso` and never read from a clock.
 *
 * Mid-day on the 7th, deliberately: a local date and time derived from it is unambiguous in every
 * zone and nowhere near a daylight-saving transition, so a fixture built from this instant resolves
 * back to it exactly.
 */
const NOW_ISO = '2026-10-07T12:00:00.000Z';

/** A whole day before the pinned instant: strictly past it in every zone. */
const DAY_BEFORE_NOW_ISO = '2026-10-06T12:00:00.000Z';

/** A text that passes every text rule, used wherever a case is about the due time instead. */
const VALID_TEXT = 'Call the dentist';

/** A local date and time after the pinned instant: 2027 follows 2026 in every zone. */
const FUTURE_DATE = '2027-01-15';
const FUTURE_TIME = '09:30';

/** A local date and time before the pinned instant. */
const PAST_DATE = '2026-01-15';
const PAST_TIME = '09:30';

/**
 * Both sides of the text bound, written with the numbers spelled out.
 *
 * These are deliberately not derived from `MAX_TEXT_LENGTH`: with the bound written literally here,
 * the 280/281 boundary is measured against the number the request fixes rather than against whatever
 * the module's constant happens to hold.
 */
const TEXT_OF_280_CHARACTERS = 'a'.repeat(280);
const TEXT_OF_281_CHARACTERS = 'a'.repeat(281);

/** Whitespace around a text, used to prove the bound and the emptiness check both work on the trim. */
const PADDING = '   ';

/** Reads an instant's local calendar date (`YYYY-MM-DD`) in the runtime's zone. */
function localDateOfInstant(instant: Date): string {
  const year = String(instant.getFullYear()).padStart(4, '0');
  const month = String(instant.getMonth() + 1).padStart(2, '0');
  const day = String(instant.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Reads an instant's local wall-clock time (`HH:mm`) in the runtime's zone. */
function localTimeOfInstant(instant: Date): string {
  const hour = String(instant.getHours()).padStart(2, '0');
  const minute = String(instant.getMinutes()).padStart(2, '0');
  return `${hour}:${minute}`;
}

/**
 * A submission naming the exact local date and time an absolute instant falls on in the runtime's
 * zone.
 *
 * Building a fixture from an instant rather than from an assumed offset is what keeps the past-due
 * cases independent of the zone the suite runs in: the pair this returns resolves back to that same
 * instant, so a boundary case compares two instants that were fixed in advance.
 */
function valuesAtInstant(instantIso: string, text: string = VALID_TEXT): ReminderFormValues {
  const instant = new Date(Date.parse(instantIso));
  return {
    text,
    date: localDateOfInstant(instant),
    time: localTimeOfInstant(instant),
  };
}

/** A submission assembled from the three values the form holds, exactly as the user left them. */
function valuesFor(text: string, date: string, time: string): ReminderFormValues {
  return { text, date, time };
}

/**
 * The absolute instant a local pair resolves to, or a failure naming the fixture.
 *
 * Throwing rather than returning a fallback keeps a fixture that the runtime cannot resolve from
 * quietly turning into a test of something else: the message says which pair was unusable.
 */
function instantOf(date: string, time: string): string {
  const iso = toDueAtIso(date, time);
  if (iso === null) {
    throw new Error(
      `the fixture ${date} ${time} is not a real local date and time in this runtime's zone`,
    );
  }
  return iso;
}

/**
 * Asserts a refusal: the field it is attributed to and the message the user reads.
 *
 * The refusal branch carries exactly `failure` and `ok` and never an `input`, so a result that also
 * offered a request body — the shape that would let a caller submit a value this module had just
 * refused — fails here as well as in the message assertion.
 */
function expectRefusal(result: ValidationResult, field: 'text' | 'dueAt'): string {
  if (result.ok) {
    throw new Error(`expected a refusal attributed to ${field}, but the input was accepted`);
  }
  expect(Object.keys(result).sort()).toEqual(['failure', 'ok']);
  expect(result.failure.field).toBe(field);
  return result.failure.message;
}

/**
 * Asserts an acceptance and returns the request body it produced.
 *
 * Every acceptance is evidence for the same contract: the outcome holds exactly `ok` and `input`, and
 * the body holds exactly the two keys the client may send. Identity-bearing fields (`id`,
 * `completed`, `notifiedAt`, `createdAt`) are derived by the server, and a client-supplied
 * `notifiedAt` in particular would let the page suppress a reminder's notification permanently, so
 * the key set is asserted on every accepted case rather than once.
 */
function expectAccepted(result: ValidationResult): CreateReminderInput {
  if (!result.ok) {
    throw new Error(
      `expected the input to be accepted, but it was refused with "${result.failure.message}"`,
    );
  }
  expect(Object.keys(result).sort()).toEqual(['input', 'ok']);
  expect(Object.keys(result.input).sort()).toEqual(['dueAt', 'text']);
  return result.input;
}

describe('the message literals this copy must hold in step with the server\u2019s', () => {
  it('exposes exactly the seven keys the client and the server share, no more and no fewer', () => {
    expect([...MODULE_MESSAGE_KEYS].sort()).toEqual([...EXPECTED_MESSAGE_KEYS].sort());
  });

  // One case per literal, registered from the table itself so each is reported under its own key and
  // a single reworded string fails on its own rather than behind a combined assertion.
  for (const key of EXPECTED_MESSAGE_KEYS) {
    it(`holds ${key} exactly as the literal written out in this file`, () => {
      expect(VALIDATION_MESSAGES[key]).toBe(EXPECTED_MESSAGES[key]);
    });
  }
});

describe('MAX_TEXT_LENGTH', () => {
  it('is 280, the bound the request fixes and the number the form counts against', () => {
    expect(MAX_TEXT_LENGTH).toBe(280);
  });

  it('accepts a text of exactly the bound and refuses one character more', () => {
    const accepted = expectAccepted(
      validateReminderInput(
        valuesFor('a'.repeat(MAX_TEXT_LENGTH), FUTURE_DATE, FUTURE_TIME),
        NOW_ISO,
      ),
    );
    expect(accepted.text.length).toBe(MAX_TEXT_LENGTH);

    const refusal = validateReminderInput(
      valuesFor('a'.repeat(MAX_TEXT_LENGTH + 1), FUTURE_DATE, FUTURE_TIME),
      NOW_ISO,
    );
    expect(expectRefusal(refusal, 'text')).toBe(EXPECTED_MESSAGES.TEXT_TOO_LONG);
  });
});

describe('the text rules', () => {
  it('refuses an empty text, attributing the message to the text field', () => {
    const refusal = validateReminderInput(valuesFor('', FUTURE_DATE, FUTURE_TIME), NOW_ISO);
    expect(expectRefusal(refusal, 'text')).toBe(EXPECTED_MESSAGES.TEXT_REQUIRED);
  });

  it('refuses whitespace-only text identically, because the trim happens before the emptiness check', () => {
    const blankTexts: readonly string[] = ['   ', '\t', '\n  \t ', ' \u00a0 '];
    for (const blank of blankTexts) {
      const refusal = validateReminderInput(valuesFor(blank, FUTURE_DATE, FUTURE_TIME), NOW_ISO);
      expect(
        expectRefusal(refusal, 'text'),
        `the blank text ${JSON.stringify(blank)} must be refused as a missing text`,
      ).toBe(EXPECTED_MESSAGES.TEXT_REQUIRED);
    }
  });

  it('returns the trimmed text, never the padded original', () => {
    const padded = `${PADDING}${VALID_TEXT}${PADDING}`;
    const input = expectAccepted(
      validateReminderInput(valuesFor(padded, FUTURE_DATE, FUTURE_TIME), NOW_ISO),
    );
    expect(input.text).toBe(VALID_TEXT);
    expect(input.text).not.toBe(padded);
  });

  it('trims only the ends, leaving whitespace inside the text untouched', () => {
    const input = expectAccepted(
      validateReminderInput(valuesFor('  Call   the  dentist\t', FUTURE_DATE, FUTURE_TIME), NOW_ISO),
    );
    expect(input.text).toBe('Call   the  dentist');
  });

  it('accepts exactly 280 non-space characters and refuses 281', () => {
    // The fixtures are checked here so a miscounted repeat cannot make the boundary cases assert a
    // bound nobody chose.
    expect(TEXT_OF_280_CHARACTERS.length).toBe(280);
    expect(TEXT_OF_281_CHARACTERS.length).toBe(281);

    const input = expectAccepted(
      validateReminderInput(valuesFor(TEXT_OF_280_CHARACTERS, FUTURE_DATE, FUTURE_TIME), NOW_ISO),
    );
    expect(input.text).toBe(TEXT_OF_280_CHARACTERS);

    const refusal = validateReminderInput(
      valuesFor(TEXT_OF_281_CHARACTERS, FUTURE_DATE, FUTURE_TIME),
      NOW_ISO,
    );
    expect(expectRefusal(refusal, 'text')).toBe(EXPECTED_MESSAGES.TEXT_TOO_LONG);
  });

  it('measures the bound after trimming, so 280 characters inside padding are accepted', () => {
    const padded = `${PADDING}${TEXT_OF_280_CHARACTERS}${PADDING}`;
    // The untrimmed value is over the bound: a length check run before the trim would refuse a text
    // the user is entitled to, which is what this case is here to catch.
    expect(padded.length).toBeGreaterThan(280);

    const input = expectAccepted(
      validateReminderInput(valuesFor(padded, FUTURE_DATE, FUTURE_TIME), NOW_ISO),
    );
    expect(input.text).toBe(TEXT_OF_280_CHARACTERS);
    expect(input.text.length).toBe(280);
  });

  it('refuses 281 characters however much padding surrounds them', () => {
    const padded = `${PADDING}${TEXT_OF_281_CHARACTERS}${PADDING}`;
    const refusal = validateReminderInput(valuesFor(padded, FUTURE_DATE, FUTURE_TIME), NOW_ISO);
    expect(expectRefusal(refusal, 'text')).toBe(EXPECTED_MESSAGES.TEXT_TOO_LONG);
  });
});

describe('the due-date rules', () => {
  it('refuses a missing date or time as an unusable due time', () => {
    const missing: ReadonlyArray<readonly [string, string]> = [
      ['', FUTURE_TIME],
      [FUTURE_DATE, ''],
      ['', ''],
    ];
    for (const [date, time] of missing) {
      const refusal = validateReminderInput(valuesFor(VALID_TEXT, date, time), NOW_ISO);
      expect(
        expectRefusal(refusal, 'dueAt'),
        `the pair "${date}" "${time}" must be refused as an unusable due time`,
      ).toBe(EXPECTED_MESSAGES.DUE_AT_INVALID);
    }
  });

  it('refuses a date or time the runtime cannot resolve, whatever its shape', () => {
    const unusable: ReadonlyArray<readonly [string, string]> = [
      ['not-a-date', FUTURE_TIME],
      ['2026-02-30', FUTURE_TIME], // a day February does not have
      ['2026-13-01', FUTURE_TIME], // a month that does not exist
      ['2026-1-5', FUTURE_TIME], // not the `YYYY-MM-DD` form the picker produces
      ['2027-01-15T00:00:00Z', FUTURE_TIME], // a full instant where a date belongs
      [FUTURE_DATE, 'noon'],
      [FUTURE_DATE, '9:30'],
      [FUTURE_DATE, '24:00'],
      [FUTURE_DATE, '09:60'],
      [FUTURE_DATE, '09:30:60'],
    ];
    for (const [date, time] of unusable) {
      const refusal = validateReminderInput(valuesFor(VALID_TEXT, date, time), NOW_ISO);
      expect(
        expectRefusal(refusal, 'dueAt'),
        `the pair "${date}" "${time}" must be refused as an unusable due time`,
      ).toBe(EXPECTED_MESSAGES.DUE_AT_INVALID);
    }
  });

  it('refuses a due time a whole day before the current instant', () => {
    const past = valuesAtInstant(DAY_BEFORE_NOW_ISO);
    // The fixture names that exact instant in this zone, so "past" is a fact about the two instants
    // rather than an assumption about the offset the host applies.
    expect(instantOf(past.date, past.time)).toBe(DAY_BEFORE_NOW_ISO);

    const refusal = validateReminderInput(past, NOW_ISO);
    expect(expectRefusal(refusal, 'dueAt')).toBe(EXPECTED_MESSAGES.DUE_AT_IN_PAST);
  });

  it('refuses a clearly past local date and time', () => {
    const refusal = validateReminderInput(valuesFor(VALID_TEXT, PAST_DATE, PAST_TIME), NOW_ISO);
    expect(expectRefusal(refusal, 'dueAt')).toBe(EXPECTED_MESSAGES.DUE_AT_IN_PAST);
  });

  it('refuses a due time exactly equal to the current instant, since the rule requires strictly future', () => {
    // Both sides of this comparison are the same instant by construction: the due time is resolved
    // from the pair, and that resolved value is then passed as the current instant. Nothing here
    // depends on the host's zone or on either instant's numeric value.
    const dueAt = instantOf(FUTURE_DATE, FUTURE_TIME);
    const refusal = validateReminderInput(
      valuesFor(VALID_TEXT, FUTURE_DATE, FUTURE_TIME),
      dueAt,
    );
    expect(expectRefusal(refusal, 'dueAt')).toBe(EXPECTED_MESSAGES.DUE_AT_IN_PAST);
  });

  it('refuses a due time equal to the pinned instant, read back as local components', () => {
    const equal = valuesAtInstant(NOW_ISO);
    expect(instantOf(equal.date, equal.time)).toBe(NOW_ISO);

    const refusal = validateReminderInput(equal, NOW_ISO);
    expect(expectRefusal(refusal, 'dueAt')).toBe(EXPECTED_MESSAGES.DUE_AT_IN_PAST);
  });

  it('refuses a due time one millisecond before the current instant', () => {
    const dueAt = instantOf(FUTURE_DATE, FUTURE_TIME);
    const nowIso = new Date(Date.parse(dueAt) + 1).toISOString();

    const refusal = validateReminderInput(valuesFor(VALID_TEXT, FUTURE_DATE, FUTURE_TIME), nowIso);
    expect(expectRefusal(refusal, 'dueAt')).toBe(EXPECTED_MESSAGES.DUE_AT_IN_PAST);
  });

  it('accepts a clearly future local date and time', () => {
    const input = expectAccepted(
      validateReminderInput(valuesFor(VALID_TEXT, FUTURE_DATE, FUTURE_TIME), NOW_ISO),
    );
    expect(input.dueAt).toBe(instantOf(FUTURE_DATE, FUTURE_TIME));
  });

  it('accepts a due time one minute after the current instant', () => {
    const dueAt = instantOf(FUTURE_DATE, FUTURE_TIME);
    const nowIso = new Date(Date.parse(dueAt) - 60_000).toISOString();

    const input = expectAccepted(
      validateReminderInput(valuesFor(VALID_TEXT, FUTURE_DATE, FUTURE_TIME), nowIso),
    );
    expect(input.dueAt).toBe(dueAt);
  });

  it('judges the past-due rule against the instant it is given rather than a clock of its own', () => {
    // One submission, judged twice against instants on either side of it. If the module read the wall
    // clock, both calls would answer the same way and one of these assertions would fail.
    const dueAt = instantOf(PAST_DATE, PAST_TIME);
    const before = new Date(Date.parse(dueAt) - 60_000).toISOString();
    const after = new Date(Date.parse(dueAt) + 60_000).toISOString();

    const accepted = expectAccepted(
      validateReminderInput(valuesFor(VALID_TEXT, PAST_DATE, PAST_TIME), before),
    );
    expect(accepted.dueAt).toBe(dueAt);

    const refusal = validateReminderInput(valuesFor(VALID_TEXT, PAST_DATE, PAST_TIME), after);
    expect(expectRefusal(refusal, 'dueAt')).toBe(EXPECTED_MESSAGES.DUE_AT_IN_PAST);
  });
});

describe('the request body an accepted submission produces', () => {
  it('holds exactly text and dueAt, the two keys the client is allowed to send', () => {
    const padded = `${PADDING}${VALID_TEXT}${PADDING}`;
    const input = expectAccepted(
      validateReminderInput(valuesFor(padded, FUTURE_DATE, FUTURE_TIME), NOW_ISO),
    );

    expect(Object.keys(input).sort()).toEqual(['dueAt', 'text']);
    expect(input.text).toBe(VALID_TEXT);
    expect(input.dueAt).toBe(instantOf(FUTURE_DATE, FUTURE_TIME));
  });

  it('carries no identity-bearing field the server derives for itself', () => {
    const input = expectAccepted(
      validateReminderInput(valuesFor(VALID_TEXT, FUTURE_DATE, FUTURE_TIME), NOW_ISO),
    );

    const derivedByTheServer: readonly string[] = ['id', 'completed', 'notifiedAt', 'createdAt'];
    for (const derived of derivedByTheServer) {
      expect(input, `the request body must not carry ${derived}`).not.toHaveProperty(derived);
    }
  });

  it('ignores identity-bearing fields smuggled alongside the form values', () => {
    // A client-supplied `notifiedAt` would let the page suppress a reminder's notification for good,
    // and a client-supplied `completed` would bypass the completed-reminder rule. The body is built
    // from the two form fields alone, so nothing that rides along with the values object can reach it.
    const smuggled = {
      text: VALID_TEXT,
      date: FUTURE_DATE,
      time: FUTURE_TIME,
      id: 'client-supplied-id',
      completed: true,
      notifiedAt: NOW_ISO,
      createdAt: NOW_ISO,
    };

    const input = expectAccepted(validateReminderInput(smuggled, NOW_ISO));
    expect(input).toEqual({ text: VALID_TEXT, dueAt: instantOf(FUTURE_DATE, FUTURE_TIME) });
    expect(Object.keys(input).sort()).toEqual(['dueAt', 'text']);
  });

  it('produces the dueAt that ./time resolves the same pair to, unmodified', () => {
    const input = expectAccepted(
      validateReminderInput(valuesFor(VALID_TEXT, FUTURE_DATE, FUTURE_TIME), NOW_ISO),
    );
    expect(input.dueAt).toBe(toDueAtIso(FUTURE_DATE, FUTURE_TIME));
  });
});

describe('the order the rules are applied in', () => {
  it('reports the text before the due time when both inputs are wrong', () => {
    const refusal = validateReminderInput(valuesFor('', PAST_DATE, PAST_TIME), NOW_ISO);
    expect(expectRefusal(refusal, 'text')).toBe(EXPECTED_MESSAGES.TEXT_REQUIRED);
  });

  it('reports blank text before an unusable date', () => {
    const refusal = validateReminderInput(valuesFor('   ', 'not-a-date', 'noon'), NOW_ISO);
    expect(expectRefusal(refusal, 'text')).toBe(EXPECTED_MESSAGES.TEXT_REQUIRED);
  });

  it('reports over-long text before an unusable date and before a past due time', () => {
    const alsoWrongDateOrTime: ReadonlyArray<readonly [string, string]> = [
      ['', ''],
      [PAST_DATE, PAST_TIME],
    ];
    for (const [date, time] of alsoWrongDateOrTime) {
      const refusal = validateReminderInput(
        valuesFor(TEXT_OF_281_CHARACTERS, date, time),
        NOW_ISO,
      );
      expect(
        expectRefusal(refusal, 'text'),
        `over-long text with the pair "${date}" "${time}" must report the text first`,
      ).toBe(EXPECTED_MESSAGES.TEXT_TOO_LONG);
    }
  });

  it('reports an unusable date before a past due time, because no instant can be judged yet', () => {
    const refusal = validateReminderInput(valuesFor(VALID_TEXT, '', ''), NOW_ISO);
    expect(expectRefusal(refusal, 'dueAt')).toBe(EXPECTED_MESSAGES.DUE_AT_INVALID);
  });
});

describe('the module\u2019s purity', () => {
  it('returns the same outcome for the same arguments on repeat calls', () => {
    const values = valuesFor(`  ${VALID_TEXT}  `, FUTURE_DATE, FUTURE_TIME);
    const first = validateReminderInput(values, NOW_ISO);
    const second = validateReminderInput(values, NOW_ISO);

    expect(first.ok).toBe(true);
    expect(second).toEqual(first);
  });

  it('does not mutate the values it is given', () => {
    const padded = `${PADDING}${VALID_TEXT}${PADDING}`;
    const values = valuesFor(padded, FUTURE_DATE, FUTURE_TIME);
    const before = { ...values };

    validateReminderInput(values, NOW_ISO);

    expect(values).toEqual(before);
    expect(values.text).toBe(padded);
  });

  it('refuses every malformed pair without throwing', () => {
    const malformed: ReadonlyArray<readonly [string, string]> = [
      ['', ''],
      ['nonsense', 'nonsense'],
      ['2026-02-30', '25:00'],
      ['2026-01-15T09:30:00Z', '09:30'],
    ];

    for (const [date, time] of malformed) {
      expect(
        () => validateReminderInput(valuesFor(VALID_TEXT, date, time), NOW_ISO),
        `the pair "${date}" "${time}" must be refused rather than raise`,
      ).not.toThrow();
    }
  });
});

