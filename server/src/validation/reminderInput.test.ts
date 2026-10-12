/**
 * Unit suite for `./reminderInput`, the server's authority on a create-reminder request body.
 *
 * The coverage here is the rule set itself: each of the four rules with the exact message its
 * rejection carries, the trimming that precedes both the emptiness check and the length check, the
 * 280/281 boundary, the past-due comparison at and either side of `nowIso`, the order in which the
 * rules report when several fail, and the shape of an accepted value.
 *
 * Two properties of this suite are deliberate and load-bearing:
 *
 * - **Every message is asserted as a literal string, never through the module's private constant
 *   names.** `client/src/lib/validation.ts` carries the same rules and the same wording for the
 *   create form's pre-flight check, and its own suite asserts the same strings; that equality of
 *   literals, checked in both workspaces, is the mechanism that holds the two deliberately
 *   duplicated copies in step (D4). Asserting a literal here is what makes a reworded server
 *   message fail this suite; asserting a constant name, a length or a substring would let the
 *   wording drift silently.
 * - **No clock is read and no fake is installed.** The current instant arrives as the `nowIso`
 *   parameter, so every boundary case below is driven by a pinned constant and the suite is
 *   deterministic with no fake timer installed. The module under test is pure, and so is this file:
 *   no filesystem, no database, no network, no environment variable, no module mocking, and no
 *   import beyond the runner and the module it covers.
 */

import { describe, expect, it } from 'vitest';
import type { NewReminder, ReminderField } from '../types';
import { validateReminderInput } from './reminderInput';

/*
 * The pinned instants. Every one is a literal absolute UTC ISO-8601 string handed to the module as
 * either `nowIso` or `dueAt`, which is what keeps `<= nowIso`, `=== nowIso` and `> nowIso`
 * deterministic without the suite ever asking the host what time it is.
 */

/** The pinned current instant the past-due cases compare against. */
const NOW_ISO = '2026-11-01T09:30:00.000Z';

/** One day before {@link NOW_ISO}: strictly in the past. */
const PAST_ISO = '2026-10-31T09:30:00.000Z';

/** One day after {@link NOW_ISO}: a comfortable margin in the future. */
const FUTURE_ISO = '2026-11-02T09:30:00.000Z';

/** One millisecond before {@link NOW_ISO}: the nearest instant the `<=` comparison must refuse. */
const ONE_MILLISECOND_BEFORE_NOW_ISO = '2026-11-01T09:29:59.999Z';

/** One millisecond after {@link NOW_ISO}: the nearest instant the comparison must accept. */
const ONE_MILLISECOND_AFTER_NOW_ISO = '2026-11-01T09:30:00.001Z';

/**
 * Builds a text of exactly `length` characters.
 *
 * Repetition rather than a literal keeps the boundary cases readable and exact: a 280-character
 * value written out by hand is one miscounted character away from testing the wrong thing.
 *
 * @param length - The character count to produce.
 * @returns A string of exactly `length` characters.
 */
function textOfLength(length: number): string {
  return 'x'.repeat(length);
}

/**
 * Asserts that a body is rejected, naming the field and the literal message.
 *
 * The `expect(result.ok).toBe(false)` line is the assertion of the discriminated branch; the
 * `if (result.ok)` guard that follows is what narrows the union for the two property reads, and it
 * fails loudly rather than silently if the module ever accepts a body that must be refused.
 *
 * @param input - The body to validate.
 * @param nowIso - The pinned current instant.
 * @param field - The request field the rejection must be attributed to.
 * @param message - The literal message the rejection must carry.
 */
function expectRejection(
  input: unknown,
  nowIso: string,
  field: ReminderField,
  message: string,
): void {
  const result = validateReminderInput(input, nowIso);

  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error(
      `Expected a rejection on "${field}", but the body was accepted: ${JSON.stringify(result.value)}`,
    );
  }

  expect(result.field).toBe(field);
  expect(result.message).toBe(message);
}

/**
 * Asserts that a body is accepted, returning the normalised value for further assertions.
 *
 * @param input - The body to validate.
 * @param nowIso - The pinned current instant.
 * @returns The `NewReminder` the module produced.
 */
function expectAccepted(input: unknown, nowIso: string): NewReminder {
  const result = validateReminderInput(input, nowIso);

  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(
      `Expected the body to be accepted, but it was rejected on "${result.field}": ${result.message}`,
    );
  }

  return result.value;
}

describe('validateReminderInput — rule 1: the text must exist and must not be blank', () => {
  it('rejects an empty text', () => {
    expectRejection({ text: '', dueAt: FUTURE_ISO }, NOW_ISO, 'text', 'Enter a reminder text.');
  });

  it('rejects a text of spaces only', () => {
    expectRejection(
      { text: '   ', dueAt: FUTURE_ISO },
      NOW_ISO,
      'text',
      'Enter a reminder text.',
    );
  });

  it('rejects a text of non-space whitespace only', () => {
    expectRejection({ text: '\t\n', dueAt: FUTURE_ISO }, NOW_ISO, 'text', 'Enter a reminder text.');
  });

  it('rejects a body with no text field at all', () => {
    expectRejection({ dueAt: FUTURE_ISO }, NOW_ISO, 'text', 'Enter a reminder text.');
  });

  it('rejects a null text', () => {
    expectRejection({ text: null, dueAt: FUTURE_ISO }, NOW_ISO, 'text', 'Enter a reminder text.');
  });

  it('rejects a numeric text', () => {
    expectRejection({ text: 42, dueAt: FUTURE_ISO }, NOW_ISO, 'text', 'Enter a reminder text.');
  });

  it('rejects a boolean text', () => {
    expectRejection({ text: true, dueAt: FUTURE_ISO }, NOW_ISO, 'text', 'Enter a reminder text.');
  });

  it('rejects an array text', () => {
    expectRejection(
      { text: ['buy milk'], dueAt: FUTURE_ISO },
      NOW_ISO,
      'text',
      'Enter a reminder text.',
    );
  });

  it('rejects an object text', () => {
    expectRejection(
      { text: { value: 'buy milk' }, dueAt: FUTURE_ISO },
      NOW_ISO,
      'text',
      'Enter a reminder text.',
    );
  });

  /*
   * A body that is not an object at all fails the same rule as a missing text, because nothing here
   * has a text property to read. Each shape gets its own case so a regression in the entry guard
   * names the shape it broke on.
   */

  it('rejects a null body', () => {
    expectRejection(null, NOW_ISO, 'text', 'Enter a reminder text.');
  });

  it('rejects an undefined body', () => {
    expectRejection(undefined, NOW_ISO, 'text', 'Enter a reminder text.');
  });

  it('rejects a numeric body', () => {
    expectRejection(42, NOW_ISO, 'text', 'Enter a reminder text.');
  });

  it('rejects a string body', () => {
    expectRejection('buy milk', NOW_ISO, 'text', 'Enter a reminder text.');
  });

  it('rejects an array body', () => {
    expectRejection([{ text: 'buy milk', dueAt: FUTURE_ISO }], NOW_ISO, 'text', 'Enter a reminder text.');
  });
});

describe('validateReminderInput — rule 2: the 280-character boundary over the trimmed text', () => {
  it('accepts a text of exactly 280 characters', () => {
    const value = expectAccepted({ text: textOfLength(280), dueAt: FUTURE_ISO }, NOW_ISO);

    expect(value.text.length).toBe(280);
    expect(value.text).toBe(textOfLength(280));
  });

  it('rejects a text of 281 characters', () => {
    expectRejection(
      { text: textOfLength(281), dueAt: FUTURE_ISO },
      NOW_ISO,
      'text',
      'Reminder text must be 280 characters or fewer.',
    );
  });

  /*
   * The padded cases pin two facts with one input each: the count is taken over the trimmed value,
   * and the bound itself is inclusive. A 280-character text with one space on each side is 282
   * characters raw and is accepted; a 281-character trimmed text is refused however it is padded.
   */

  it('accepts a padded text whose trimmed form is exactly 280 characters', () => {
    const padded = ` ${textOfLength(280)} `;

    expect(padded.length).toBe(282);

    const value = expectAccepted({ text: padded, dueAt: FUTURE_ISO }, NOW_ISO);

    expect(value.text).toBe(textOfLength(280));
    expect(value.text.length).toBe(280);
  });

  it('rejects a padded text whose trimmed form is 281 characters', () => {
    const padded = ` ${textOfLength(281)} `;

    expect(padded.trim().length).toBe(281);

    expectRejection(
      { text: padded, dueAt: FUTURE_ISO },
      NOW_ISO,
      'text',
      'Reminder text must be 280 characters or fewer.',
    );
  });
});

describe('validateReminderInput — trimming of the accepted text', () => {
  it('stores and returns the trimmed text of a padded value', () => {
    const value = expectAccepted({ text: '  buy milk  ', dueAt: FUTURE_ISO }, NOW_ISO);

    expect(value.text).toBe('buy milk');
  });

  it('never echoes the raw padded text back untrimmed', () => {
    const raw = ' \tbuy milk\n ';

    const value = expectAccepted({ text: raw, dueAt: FUTURE_ISO }, NOW_ISO);

    expect(value.text).not.toBe(raw);
    expect(value.text).toBe('buy milk');
  });
});

describe('validateReminderInput — rule 3: the due time must parse to a finite instant', () => {
  it('rejects a body with no dueAt field at all', () => {
    expectRejection(
      { text: 'buy milk' },
      NOW_ISO,
      'dueAt',
      'Enter a valid due date and time.',
    );
  });

  it('rejects a null dueAt', () => {
    expectRejection(
      { text: 'buy milk', dueAt: null },
      NOW_ISO,
      'dueAt',
      'Enter a valid due date and time.',
    );
  });

  it('rejects a numeric dueAt', () => {
    expectRejection(
      { text: 'buy milk', dueAt: 12345 },
      NOW_ISO,
      'dueAt',
      'Enter a valid due date and time.',
    );
  });

  it('rejects a boolean dueAt', () => {
    expectRejection(
      { text: 'buy milk', dueAt: true },
      NOW_ISO,
      'dueAt',
      'Enter a valid due date and time.',
    );
  });

  it('rejects an array dueAt', () => {
    expectRejection(
      { text: 'buy milk', dueAt: [FUTURE_ISO] },
      NOW_ISO,
      'dueAt',
      'Enter a valid due date and time.',
    );
  });

  it('rejects an object dueAt', () => {
    expectRejection(
      { text: 'buy milk', dueAt: { iso: FUTURE_ISO } },
      NOW_ISO,
      'dueAt',
      'Enter a valid due date and time.',
    );
  });

  it('rejects an unparseable dueAt string', () => {
    expectRejection(
      { text: 'buy milk', dueAt: 'not a date' },
      NOW_ISO,
      'dueAt',
      'Enter a valid due date and time.',
    );
  });

  it('rejects an empty dueAt string', () => {
    expectRejection(
      { text: 'buy milk', dueAt: '' },
      NOW_ISO,
      'dueAt',
      'Enter a valid due date and time.',
    );
  });
});

describe('validateReminderInput — rule 4: the due time must be strictly in the future', () => {
  it('rejects a due time strictly earlier than the current instant', () => {
    expectRejection(
      { text: 'buy milk', dueAt: PAST_ISO },
      NOW_ISO,
      'dueAt',
      'The due time must be in the future.',
    );
  });

  /*
   * The boundary the implementation's `<=` exists for: an instant equal to the current one is not
   * "in the future", so there is no grace window and no rounding, and this is the case most likely
   * to regress if the comparison is ever relaxed to `<`.
   */

  it('rejects a due time exactly equal to the current instant', () => {
    expectRejection(
      { text: 'buy milk', dueAt: NOW_ISO },
      NOW_ISO,
      'dueAt',
      'The due time must be in the future.',
    );
  });

  it('rejects a due time one millisecond before the current instant', () => {
    expectRejection(
      { text: 'buy milk', dueAt: ONE_MILLISECOND_BEFORE_NOW_ISO },
      NOW_ISO,
      'dueAt',
      'The due time must be in the future.',
    );
  });

  it('accepts a due time one millisecond after the current instant', () => {
    const value = expectAccepted(
      { text: 'buy milk', dueAt: ONE_MILLISECOND_AFTER_NOW_ISO },
      NOW_ISO,
    );

    expect(value.dueAt).toBe(ONE_MILLISECOND_AFTER_NOW_ISO);
  });

  it('accepts a due time a day after the current instant', () => {
    const value = expectAccepted({ text: 'buy milk', dueAt: FUTURE_ISO }, NOW_ISO);

    expect(value.dueAt).toBe(FUTURE_ISO);
  });
});

describe('validateReminderInput — the order in which the rules report', () => {
  it('reports the text rejection when the text is empty and the due time is in the past', () => {
    const result = validateReminderInput({ text: '', dueAt: PAST_ISO }, NOW_ISO);

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('Expected the body to be rejected, but it was accepted.');
    }

    expect(result.field).toBe('text');
    expect(result.message).toBe('Enter a reminder text.');
  });

  it('reports the date rejection, not the past-due one, for an unparseable due time', () => {
    const result = validateReminderInput({ text: 'buy milk', dueAt: 'not a date' }, NOW_ISO);

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('Expected the body to be rejected, but it was accepted.');
    }

    expect(result.field).toBe('dueAt');
    expect(result.message).toBe('Enter a valid due date and time.');
    expect(result.message).not.toBe('The due time must be in the future.');
  });
});

describe('validateReminderInput — the accepted value', () => {
  it('returns exactly the two request keys', () => {
    const value = expectAccepted({ text: 'buy milk', dueAt: FUTURE_ISO }, NOW_ISO);

    expect(Object.keys(value).sort()).toEqual(['dueAt', 'text']);
  });

  it('returns the dueAt string byte-for-byte as it was received', () => {
    const value = expectAccepted({ text: 'buy milk', dueAt: FUTURE_ISO }, NOW_ISO);

    expect(value.dueAt).toBe(FUTURE_ISO);
  });

  it('does not reformat a dueAt that spells the same instant without milliseconds', () => {
    const dueAtWithoutMilliseconds = '2026-11-02T09:30:00Z';

    const value = expectAccepted({ text: 'buy milk', dueAt: dueAtWithoutMilliseconds }, NOW_ISO);

    expect(value.dueAt).toBe(dueAtWithoutMilliseconds);
  });

  /*
   * D1 — identity-bearing fields belong to the server and are ignored when a client sends them. A
   * supplied `notifiedAt` would let a caller suppress a reminder's notification and a supplied
   * `completed` would bypass the completed-reminder rule, so the accepted value must never carry
   * them through.
   */

  it('ignores identity-bearing fields that a request body supplies', () => {
    const value = expectAccepted(
      {
        text: 'buy milk',
        dueAt: FUTURE_ISO,
        id: 'client-supplied-id',
        completed: true,
        notifiedAt: '2026-01-01T00:00:00.000Z',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      NOW_ISO,
    );

    expect(Object.keys(value).sort()).toEqual(['dueAt', 'text']);
    expect(Object.prototype.hasOwnProperty.call(value, 'id')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(value, 'completed')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(value, 'notifiedAt')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(value, 'createdAt')).toBe(false);
    expect(value.text).toBe('buy milk');
    expect(value.dueAt).toBe(FUTURE_ISO);
  });

  it('drops an unknown extra field rather than carrying it into the value', () => {
    const value = expectAccepted({ text: 'buy milk', dueAt: FUTURE_ISO, foo: 'bar' }, NOW_ISO);

    expect(Object.keys(value).sort()).toEqual(['dueAt', 'text']);
    expect(Object.prototype.hasOwnProperty.call(value, 'foo')).toBe(false);
  });
});

