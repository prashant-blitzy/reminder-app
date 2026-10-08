/**
 * Tests for `./time` — the client's single local-to-UTC conversion and the single formatter.
 *
 * This suite is the evidence for the time requirements: a local date and time the user types
 * converts to the expected absolute UTC instant, that instant resolves back to the same local date
 * and time, a daylight-saving transition cannot shift a stored reminder's absolute due time, and
 * input the module cannot honour — a malformed value, an out-of-range component, an impossible
 * calendar date — returns `null` instead of a fabricated instant.
 *
 * Two properties of this file are deliberate:
 *
 * - The zone is pinned with `vi.stubEnv('TZ', ...)` and never by assigning to the runtime's
 *   environment object directly: this workspace declares no `@types/node`, so naming that global
 *   fails `npm run typecheck --workspace client`. A runtime zone stub only decides the offsets if
 *   the engine re-reads the zone, so the first test proves the pin took effect before any offset
 *   assertion relies on it.
 * - `describe`, `it`, `expect`, `beforeAll`, `afterAll` and `vi` are the vitest globals
 *   (`globals: true`), so the only import is the unit under test.
 *
 * The suite is deterministic: it reads no wall clock, uses no fake timers (the module takes no
 * clock), touches no network and mocks nothing.
 */

import { formatLocalDueAt, toDueAtIso } from './time';

/**
 * The zone the whole suite runs in. It observes daylight saving, so its 2026 offsets are UTC−5
 * (EST) in winter and UTC−4 (EDT) in summer, and both its transitions are exercised below.
 */
const PINNED_ZONE = 'America/New_York';

/** The local calendar date (`YYYY-MM-DD`) an instant falls on, read in the runtime's zone. */
function localDateOf(instant: Date): string {
  const year = String(instant.getFullYear()).padStart(4, '0');
  const month = String(instant.getMonth() + 1).padStart(2, '0');
  const day = String(instant.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** The local wall-clock time (`HH:mm`) an instant falls on, read in the runtime's zone. */
function localTimeOf(instant: Date): string {
  const hour = String(instant.getHours()).padStart(2, '0');
  const minute = String(instant.getMinutes()).padStart(2, '0');
  return `${hour}:${minute}`;
}

/**
 * Converts local components the module must accept, asserts an instant came back, and narrows the
 * nullable result so no later use of the value needs a non-null assertion the compiler cannot check.
 */
function expectInstant(date: string, time: string): string {
  const iso = toDueAtIso(date, time);
  expect(iso, `toDueAtIso(${date}, ${time}) must produce an instant`).not.toBeNull();
  if (iso === null) {
    throw new Error(`toDueAtIso(${date}, ${time}) produced no instant`);
  }
  return iso;
}

/** Asserts that local components the module must refuse produce no instant at all. */
function expectNoInstant(date: string, time: string): void {
  expect(toDueAtIso(date, time), `toDueAtIso(${date}, ${time}) must produce no instant`).toBeNull();
}

beforeAll(() => {
  vi.stubEnv('TZ', PINNED_ZONE);
});

afterAll(() => {
  vi.unstubAllEnvs();
});

describe('the pinned test zone', () => {
  it('is America/New_York, proved by the standard-time hour offset before any other assertion', () => {
    // 12:00 UTC is 07:00 EST (UTC−5). If this fails the zone pin did not take effect and every
    // offset assertion below would be measuring the host's zone instead of the pinned one.
    expect(new Date('2026-01-15T12:00:00Z').getHours()).toBe(7);
    expect(new Date('2026-01-15T12:00:00Z').getMinutes()).toBe(0);
  });
});

describe('toDueAtIso — round trip in standard time', () => {
  it('converts a local date and time to the expected absolute instant (EST, UTC−5)', () => {
    expect(toDueAtIso('2026-01-15', '09:30')).toBe('2026-01-15T14:30:00.000Z');
  });

  it('resolves the stored instant back to the local date and time it was entered as', () => {
    const instant = new Date(expectInstant('2026-01-15', '09:30'));
    expect(instant.getHours()).toBe(9);
    expect(instant.getMinutes()).toBe(30);
    expect(localDateOf(instant)).toBe('2026-01-15');
    expect(localTimeOf(instant)).toBe('09:30');
  });

  it('returns the same instant when the recovered local components are converted again', () => {
    const iso = expectInstant('2026-01-15', '09:30');
    const instant = new Date(iso);
    expect(toDueAtIso(localDateOf(instant), localTimeOf(instant))).toBe(iso);
  });

  it('resolves at the chosen minute when the optional seconds group is present', () => {
    expect(toDueAtIso('2026-01-15', '09:30:59')).toBe('2026-01-15T14:30:00.000Z');
  });
});

describe('toDueAtIso — round trip in daylight-saving time', () => {
  it('converts a summer local date and time to the expected absolute instant (EDT, UTC−4)', () => {
    expect(toDueAtIso('2026-07-15', '09:30')).toBe('2026-07-15T13:30:00.000Z');
  });

  it('resolves the summer instant back to the local date and time it was entered as', () => {
    const instant = new Date(expectInstant('2026-07-15', '09:30'));
    expect(instant.getHours()).toBe(9);
    expect(instant.getMinutes()).toBe(30);
    expect(localDateOf(instant)).toBe('2026-07-15');
    expect(localTimeOf(instant)).toBe('09:30');
  });

  it('returns the same instant when the recovered summer components are converted again', () => {
    const iso = expectInstant('2026-07-15', '09:30');
    const instant = new Date(iso);
    expect(toDueAtIso(localDateOf(instant), localTimeOf(instant))).toBe(iso);
  });

  it('resolves the same local wall-clock time through the offset in force in each season', () => {
    // 09:30 local is 14:30Z in winter (EST, UTC−5) and 13:30Z in summer (EDT, UTC−4): the offset
    // applied is the one in force at the instant the user chose, never one fixed offset.
    const winter = new Date(expectInstant('2026-01-15', '09:30'));
    const summer = new Date(expectInstant('2026-07-15', '09:30'));
    expect(winter.getUTCHours()).toBe(14);
    expect(summer.getUTCHours()).toBe(13);
    expect(winter.getUTCMinutes()).toBe(30);
    expect(summer.getUTCMinutes()).toBe(30);
  });
});

describe('toDueAtIso — the daylight-saving boundary', () => {
  // In this zone daylight saving ends on Sunday 2026-11-01 at 02:00 local (EDT to EST) and begins
  // on Sunday 2026-03-08 at 02:00 local (EST to EDT).

  it('uses the offset in force before the autumn transition (EDT, UTC−4)', () => {
    expect(toDueAtIso('2026-11-01', '01:30')).toBe('2026-11-01T05:30:00.000Z');
  });

  it('uses the offset in force after the autumn transition (EST, UTC−5)', () => {
    expect(toDueAtIso('2026-11-01', '03:30')).toBe('2026-11-01T08:30:00.000Z');
  });

  it('uses the offset in force before the spring transition (EST, UTC−5)', () => {
    expect(toDueAtIso('2026-03-08', '01:30')).toBe('2026-03-08T06:30:00.000Z');
  });

  it('uses the offset in force after the spring transition (EDT, UTC−4)', () => {
    expect(toDueAtIso('2026-03-08', '03:30')).toBe('2026-03-08T07:30:00.000Z');
  });

  it('refuses the local time that does not exist on the spring-forward day instead of shifting it', () => {
    // 02:30 never occurs on this date; the platform would resolve it to a different real local
    // time (03:30 here), so the rollover check must reject it rather than store the shifted hour.
    expect(toDueAtIso('2026-03-08', '02:30')).toBeNull();
  });

  it('stores a pre-transition local time as one absolute instant, unchanged by a later conversion', () => {
    const first = expectInstant('2026-11-01', '01:30');
    const second = expectInstant('2026-11-01', '01:30');
    expect(second).toBe(first);
    expect(first).toBe('2026-11-01T05:30:00.000Z');
  });

  it('formats each stored instant for the pinned zone as the local time it was entered as', () => {
    const beforeTheAutumnTransition = new Date(expectInstant('2026-11-01', '01:30'));
    const afterTheAutumnTransition = new Date(expectInstant('2026-11-01', '03:30'));
    expect(localTimeOf(beforeTheAutumnTransition)).toBe('01:30');
    expect(localTimeOf(afterTheAutumnTransition)).toBe('03:30');

    const beforeTheSpringTransition = new Date(expectInstant('2026-03-08', '01:30'));
    const afterTheSpringTransition = new Date(expectInstant('2026-03-08', '03:30'));
    expect(localTimeOf(beforeTheSpringTransition)).toBe('01:30');
    expect(localTimeOf(afterTheSpringTransition)).toBe('03:30');
  });
});

describe('formatLocalDueAt', () => {
  it('renders a stored instant as local text naming its year, never as an invalid date', () => {
    const storedInstants: ReadonlyArray<readonly [string, string]> = [
      [expectInstant('2026-11-01', '01:30'), '2026-11-01'],
      [expectInstant('2026-03-08', '03:30'), '2026-03-08'],
      [expectInstant('2026-07-15', '09:30'), '2026-07-15'],
    ];

    for (const [iso, localDate] of storedInstants) {
      const formatted = formatLocalDueAt(iso);
      expect(formatted).toContain('2026');
      expect(formatted).not.toContain('Invalid');
      expect(localDateOf(new Date(iso))).toBe(localDate);
    }
  });

  it('agrees with an independently constructed Intl formatter for the same instant', () => {
    const iso = expectInstant('2026-03-08', '03:30');
    const independentlyFormatted = new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(iso));
    expect(formatLocalDueAt(iso)).toBe(independentlyFormatted);
  });

  it('returns an unparseable input unchanged rather than printing an invalid date', () => {
    expect(formatLocalDueAt('nonsense')).toBe('nonsense');
  });

  it('does not throw for an empty string and returns it unchanged', () => {
    expect(() => formatLocalDueAt('')).not.toThrow();
    expect(formatLocalDueAt('')).toBe('');
  });
});

describe('toDueAtIso — input the module must refuse', () => {
  it('returns null for a malformed date', () => {
    expectNoInstant('not-a-date', '09:30');
    expectNoInstant('2026-1-5', '09:30');
    expectNoInstant('2026/01/15', '09:30');
    expectNoInstant('', '09:30');
  });

  it('returns null for a malformed time', () => {
    expectNoInstant('2026-01-15', '9:30');
    expectNoInstant('2026-01-15', '09:30:00.000');
    expectNoInstant('2026-01-15', 'noon');
    expectNoInstant('2026-01-15', '');
  });

  it('returns null for a component outside its range', () => {
    expectNoInstant('2026-13-01', '09:30');
    expectNoInstant('2026-00-10', '09:30');
    expectNoInstant('2026-01-32', '09:30');
    expectNoInstant('2026-01-15', '24:00');
    expectNoInstant('2026-01-15', '09:60');
    expectNoInstant('2026-01-15', '09:30:60');
  });

  it('returns null for a full instant string passed as the date, because the pattern is anchored', () => {
    expectNoInstant('2026-01-15T00:00:00Z', '09:30');
    expectNoInstant('2026-01-15 00:00:00', '09:30');
  });

  it('returns null for 2026-02-30 instead of storing the different date it rolls over into', () => {
    // Without the rollover check this silently becomes 2026-03-02T14:00:00.000Z, so an impossible
    // date would be saved as a real reminder on a day the user never chose.
    expectNoInstant('2026-02-30', '09:00');
    expect(toDueAtIso('2026-02-30', '09:00')).not.toBe('2026-03-02T14:00:00.000Z');
  });

  it('returns null for any other date that rolls over into the following month', () => {
    expectNoInstant('2026-04-31', '09:00');
    expectNoInstant('2026-06-31', '09:00');
  });

  it('returns null for 29 February in a year that has no leap day', () => {
    expectNoInstant('2026-02-29', '09:00');
  });

  it('accepts the last day of February and a real leap day, so the day bound is not over-strict', () => {
    expect(toDueAtIso('2026-02-28', '09:00')).toBe('2026-02-28T14:00:00.000Z');
    expect(toDueAtIso('2024-02-29', '09:00')).toBe('2024-02-29T14:00:00.000Z');
  });

  it('never throws and never returns an invalid date string for refused input', () => {
    const refused: ReadonlyArray<readonly [string, string]> = [
      ['not-a-date', '09:30'],
      ['2026-01-15', 'noon'],
      ['2026-02-30', '09:00'],
      ['2026-13-01', '09:30'],
      ['', ''],
    ];

    for (const [date, time] of refused) {
      expect(toDueAtIso(date, time)).toBeNull();
      expect(toDueAtIso(date, time)).not.toBe('Invalid Date');
      expect(() => toDueAtIso(date, time)).not.toThrow();
    }
  });
});
