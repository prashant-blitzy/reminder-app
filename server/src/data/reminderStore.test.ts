/**
 * Tests for the reminder storage layer: the store in `./reminderStore`, over the
 * handle `./database` opens and the shape `./schema` applies.
 *
 * This suite is acceptance evidence rather than a formality. It is the automated
 * proof of four things the feature's requirements rest on:
 *
 *   - a reminder survives a restart — the durability cases close the database
 *     file and reopen it before reading the reminder back;
 *   - a reminder is claimed for notification at most once — the claim cases show
 *     that a second claim is refused and cannot overwrite the instant the first
 *     one recorded;
 *   - the list is served in due-time order, with the identifier breaking a tie
 *     between two reminders that share a due instant, at the documented bound of
 *     1,000 stored reminders and from statements prepared once;
 *   - the stored due instant is character-for-character the one that was written,
 *     so nothing between a request and a row re-interprets it.
 *
 * Three properties keep the suite deterministic, self-contained and quiet:
 *
 *   - It never reads the wall clock. The store takes its time from an accessor,
 *     and the accessor here returns a value this file owns and moves on purpose,
 *     so a creation instant and a claim's instant are asserted exactly rather
 *     than approximately. `Date.now()` and `new Date()` appear nowhere below, and
 *     no assertion depends on how long anything took.
 *   - It runs against an in-memory database, or against a file inside a
 *     directory this file creates under the system temp directory and removes
 *     afterwards. It never opens the documented development database, and it
 *     leaves nothing behind under `server/data/`.
 *   - It touches no network and needs no server. The driver is synchronous and
 *     in-process, no listening socket is opened, and no fixture file is
 *     committed to the repository.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Database } from 'better-sqlite3';

import type { Reminder } from '../types';
import { createDatabase } from './database';
import { createReminderStore } from './reminderStore';
import type { ReminderStore } from './reminderStore';

/**
 * The instant this suite's clock reports until a case moves it deliberately.
 * Every stored `createdAt`, and every instant a claim records, is taken from
 * this value, so the assertions below can compare timestamps with `toBe`.
 */
const PINNED_NOW = '2026-03-01T12:00:00.000Z';

/**
 * A later instant the clock is moved to, used to show that a second reading of
 * the clock is a new value rather than a captured one — and, for the claim, that
 * the later value is what a refused claim must fail to write.
 */
const LATER_PINNED_NOW = '2026-03-01T13:30:00.000Z';

/** The shape `crypto.randomUUID()` produces, which is the only form an `id` may take. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Every field a reminder carries, sorted. Asserting the whole key set of a
 * returned object against this list is what catches both a dropped field and an
 * extra one, which is why the fields are held as one set rather than checked
 * one at a time.
 */
const REMINDER_FIELD_NAMES = ['completed', 'createdAt', 'dueAt', 'id', 'notifiedAt', 'text'];

/** The inclusive upper bound on stored text, taken from the table's own constraint. */
const MAXIMUM_TEXT_LENGTH = 280;

/** The stored-reminder bound the list and the due scan must stay responsive at. */
const SEEDED_REMINDER_COUNT = 1000;

/**
 * The due instants the seeded reminders are spread across: 1,000 whole minutes
 * from 2026-03-02 00:00 UTC, which stays inside a single day whatever the step
 * below is, so no seeded instant crosses a month or a year boundary.
 */
const SEEDED_DUE_DATE_PREFIX = '2026-03-02T';
const SEEDED_DUE_MINUTE_SPAN = 1000;

/**
 * The step between consecutive seeds' due instants. It is coprime with the span
 * above, so the sequence it produces visits 500 distinct minutes in an order
 * unrelated to insertion order — which is the point: a list that accidentally
 * returned rows in insertion order could not pass the ordering case below.
 */
const SEEDED_DUE_MINUTE_STEP = 37;

/** The directory-name prefix of the temporary directory the durability case uses. */
const TEMPORARY_DIRECTORY_PREFIX = 'reminder-store-';

/** The database file name inside that temporary directory. */
const TEMPORARY_DATABASE_FILE_NAME = 'reminders.sqlite';

/**
 * The suite's clock, and the only source of time in this file.
 *
 * The variable is mutable on purpose: a case that needs a second, later reading
 * assigns to it, and every read goes through the single accessor below, which is
 * the accessor the store is constructed with. Nothing writes an instant by hand
 * into a stored row, so the values a case asserts are the values the store took
 * from this clock.
 */
let current = PINNED_NOW;
const now = (): string => current;

/**
 * A store together with the handle it reads and writes through.
 *
 * Both are returned because a case needs the handle for two reasons that cannot
 * be reached through the store: closing it to prove durability across a restart,
 * and counting the statements it was asked to prepare.
 */
interface StoreHarness {
  readonly db: Database;
  readonly store: ReminderStore;
}

/**
 * Every handle this file has opened and not yet closed, and every temporary
 * directory it has created. Both are module-scoped so the cleanup below can
 * reach what a case opened without the case having to remember to close it: a
 * case may fail an assertion at any line, and the handles and directories must
 * still be released afterwards.
 */
const openHandles = new Set<Database>();
const temporaryDirectories: string[] = [];

/**
 * Opens a database and builds a store over it, with the suite's clock.
 *
 * This is the seam under test rather than a convenience: the handle comes from
 * `./database`, which applies the schema, so a store here has exactly the table,
 * the two CHECK constraints and the index the running server's store has, and
 * the clock is this file's accessor rather than the process's clock.
 *
 * @param databasePath A path for the database, or `':memory:'` for one that
 *   writes nothing to disk.
 * @returns The handle and the store built over it.
 */
function openHarness(databasePath: string): StoreHarness {
  const db = createDatabase(databasePath);
  openHandles.add(db);

  return { db, store: createReminderStore(db, now) };
}

/** Builds a store over a fresh in-memory database, which is the shape most cases use. */
function openInMemoryHarness(): StoreHarness {
  return openHarness(':memory:');
}

/**
 * Builds a store over a fresh database file in a directory this file creates.
 *
 * The directory is created by the platform's own helper, so no path is computed
 * by hand and two runs cannot collide; it is recorded so the cleanup removes it,
 * including the write-ahead log and shared-memory sidecars that WAL mode keeps
 * beside the database file.
 *
 * @returns The handle, the store built over it, and the database file's path.
 */
function openTemporaryFileHarness(): StoreHarness & { readonly filePath: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), TEMPORARY_DIRECTORY_PREFIX));
  temporaryDirectories.push(directory);

  const filePath = path.join(directory, TEMPORARY_DATABASE_FILE_NAME);

  return { ...openHarness(filePath), filePath };
}

/**
 * Closes a handle and forgets it, so the cleanup below neither closes it twice
 * nor reads anything through it.
 *
 * A case that closes the handle itself — the durability case does — must use
 * this rather than the driver's own `close`, which is what keeps the bookkeeping
 * in step with the handle's real state.
 */
function closeHandle(db: Database): void {
  if (openHandles.delete(db) && db.open) {
    db.close();
  }
}

/**
 * Restores the clock, closes every handle this case left open and removes every
 * temporary directory it created, so each case starts from the same state and
 * the suite is repeatable in either order.
 *
 * Handles are closed before directories are removed: a file still open by the
 * driver cannot be deleted on a platform that locks it, and removing a directory
 * that still holds a database file would silently leave the file behind.
 */
afterEach(() => {
  current = PINNED_NOW;

  for (const db of openHandles) {
    if (db.open) {
      db.close();
    }
  }
  openHandles.clear();

  for (const directory of temporaryDirectories) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  temporaryDirectories.length = 0;
});

/** Gives every case the same starting clock, whatever the case before it did. */
beforeEach(() => {
  current = PINNED_NOW;
});

/**
 * The order the list is required to produce: by due instant, and then by
 * identifier when two reminders share one.
 *
 * It is written here as the specification of that order rather than derived from
 * a query, so the seeded ordering case compares the store's answer against an
 * independent statement of what the answer must be.
 */
function compareByDueAtThenId(left: Reminder, right: Reminder): number {
  if (left.dueAt !== right.dueAt) {
    return left.dueAt < right.dueAt ? -1 : 1;
  }

  if (left.id !== right.id) {
    return left.id < right.id ? -1 : 1;
  }

  return 0;
}

/**
 * The due instant of the nth seeded step: an ISO-8601 UTC instant on one fixed
 * day, built arithmetically rather than through a `Date`.
 *
 * @param step The seed's place in the sequence. Consecutive seeds share an
 *   instant (see `seedReminders`), so this is not the reminder's index.
 * @returns The instant as the format the client sends and the table stores.
 */
function seededDueInstant(step: number): string {
  const offsetMinutes = (step * SEEDED_DUE_MINUTE_STEP) % SEEDED_DUE_MINUTE_SPAN;
  const hours = Math.floor(offsetMinutes / 60);
  const minutes = offsetMinutes % 60;

  return `${SEEDED_DUE_DATE_PREFIX}${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:00.000Z`;
}

/**
 * Stores `count` reminders through the store, at due instants deliberately
 * unrelated to the order they are inserted in, with consecutive pairs sharing
 * one instant so the identifier's tiebreak is exercised at this scale too.
 *
 * Every reminder goes through `create`, the store's only write path, so the
 * seeded rows are produced by the code under test rather than inserted beside it.
 *
 * @param store The store to seed.
 * @param count How many reminders to store.
 * @returns The stored reminders, in the order they were created.
 */
function seedReminders(store: ReminderStore, count: number): Reminder[] {
  const seeded: Reminder[] = [];

  for (let index = 0; index < count; index += 1) {
    seeded.push(
      store.create({
        text: `Seeded reminder ${String(index)}`,
        dueAt: seededDueInstant(Math.floor(index / 2)),
      }),
    );
  }

  return seeded;
}

/**
 * Wraps a handle so that the number of `prepare` calls it receives can be read
 * back, and forwards every other property to the driver untouched.
 *
 * A counting `Proxy` is used rather than `vi.spyOn` on purpose: `prepare`
 * belongs to the driver's prototype rather than to an own property of an
 * ordinary object, and a spy would have to redefine it and restore it
 * afterwards, whereas a wrapper leaves the driver object itself unmodified and
 * needs no restoring. The `prepare` it hands back calls the driver with the
 * driver's own object as `this`, so the statement it returns is an ordinary
 * driver statement.
 *
 * @param handle An open driver handle.
 * @returns The wrapped handle, and an accessor for the count of `prepare` calls
 *   it has seen.
 */
function countPreparedStatements(handle: Database): {
  readonly handle: Database;
  readonly prepareCalls: () => number;
} {
  let prepareCalls = 0;

  const wrapped = new Proxy(handle, {
    get(target, property, receiver) {
      if (property === 'prepare') {
        return (source: string) => {
          prepareCalls += 1;

          return target.prepare(source);
        };
      }

      return Reflect.get(target, property, receiver);
    },
  });

  return { handle: wrapped, prepareCalls: () => prepareCalls };
}

describe('create', () => {
  it('stores a reminder carrying exactly the six shared camelCase fields', () => {
    const { store } = openInMemoryHarness();

    const reminder = store.create({ text: 'Call the dentist', dueAt: '2026-03-02T09:00:00.000Z' });

    // The whole key set is compared rather than each name in turn: a seventh
    // field, or a field the mapping stopped returning, fails here.
    expect(Object.keys(reminder).sort()).toEqual([...REMINDER_FIELD_NAMES].sort());

    expect(reminder).toEqual({
      id: expect.any(String),
      text: 'Call the dentist',
      dueAt: '2026-03-02T09:00:00.000Z',
      completed: false,
      notifiedAt: null,
      createdAt: PINNED_NOW,
    });
  });

  it('mints a unique identifier of UUID shape for each stored reminder', () => {
    const { store } = openInMemoryHarness();

    const first = store.create({ text: 'First', dueAt: '2026-03-02T09:00:00.000Z' });
    const second = store.create({ text: 'Second', dueAt: '2026-03-02T10:00:00.000Z' });

    expect(first.id).toMatch(UUID_PATTERN);
    expect(second.id).toMatch(UUID_PATTERN);
    expect(first.id).not.toBe(second.id);

    // The identity the store returned is the identity the row holds, so the two
    // can never disagree about which reminder a later call names.
    expect(store.get(first.id)?.id).toBe(first.id);
    expect(store.get(second.id)?.id).toBe(second.id);
  });

  it('returns a new reminder uncompleted, with notifiedAt present and null', () => {
    const { store } = openInMemoryHarness();

    const created = store.create({ text: 'Uncompleted on arrival', dueAt: '2026-03-02T09:00:00.000Z' });
    const readBack = store.get(created.id);

    expect(typeof created.completed).toBe('boolean');
    expect(created.completed).toBe(false);
    expect(created.notifiedAt).toBeNull();
    expect(Object.keys(created)).toContain('notifiedAt');

    // The read path maps the stored 0 and NULL the same way the write path
    // reported them, so "not complete" and "not yet claimed" survive a round
    // trip through SQLite rather than existing only in the returned object.
    expect(readBack?.completed).toBe(false);
    expect(readBack?.notifiedAt).toBeNull();
    expect(store.list()[0]?.completed).toBe(false);
    expect(store.list()[0]?.notifiedAt).toBeNull();
  });

  it('stamps createdAt from the clock and keeps dueAt character-for-character', () => {
    const { store } = openInMemoryHarness();
    const dueAt = '2026-03-02T09:00:00.000Z';

    const created = store.create({ text: 'Byte-identical due instant', dueAt });

    expect(created.createdAt).toBe(PINNED_NOW);
    // `toBe` and not `toEqual`: the instant must reach the row and come back as
    // the same string, not as an equal instant some layer re-derived or
    // reformatted.
    expect(created.dueAt).toBe(dueAt);
    expect(store.get(created.id)?.dueAt).toBe(dueAt);
    expect(store.list()[0]?.dueAt).toBe(dueAt);
    expect(store.get(created.id)?.createdAt).toBe(PINNED_NOW);
  });

  it('reads the clock per call, so a later create carries a later createdAt', () => {
    const { store } = openInMemoryHarness();

    const first = store.create({ text: 'Before the clock moved', dueAt: '2026-03-02T09:00:00.000Z' });

    current = LATER_PINNED_NOW;

    const second = store.create({ text: 'After the clock moved', dueAt: '2026-03-02T10:00:00.000Z' });

    expect(second.createdAt).toBe(LATER_PINNED_NOW);
    expect(first.createdAt).toBe(PINNED_NOW);
    // The first reminder's stamp is a value in its row, not a reference to the
    // clock: moving the clock does not rewrite it.
    expect(store.get(first.id)?.createdAt).toBe(PINNED_NOW);
  });

  it('stores the text it is given verbatim, leaving trimming to the input rules', () => {
    const { store } = openInMemoryHarness();
    const text = '  Buy milk on the way home  ';

    const created = store.create({ text, dueAt: '2026-03-02T09:00:00.000Z' });

    // The store is a persistence boundary, not a normaliser: it writes the text
    // it receives and never trims, truncates or re-cases it. Trimming is decided
    // before an input reaches the store.
    expect(created.text).toBe(text);
    expect(store.get(created.id)?.text).toBe(text);
  });
});

describe('list — the due-time order', () => {
  it('returns every reminder in ascending dueAt order', () => {
    const { store } = openInMemoryHarness();

    // Inserted out of order on purpose, so an answer that followed insertion
    // order would fail.
    store.create({ text: 'Third', dueAt: '2026-03-02T18:00:00.000Z' });
    store.create({ text: 'First', dueAt: '2026-03-02T06:00:00.000Z' });
    store.create({ text: 'Second', dueAt: '2026-03-02T12:00:00.000Z' });

    expect(store.list().map((reminder) => reminder.text)).toEqual(['First', 'Second', 'Third']);
    expect(store.list().map((reminder) => reminder.dueAt)).toEqual([
      '2026-03-02T06:00:00.000Z',
      '2026-03-02T12:00:00.000Z',
      '2026-03-02T18:00:00.000Z',
    ]);
  });

  it('breaks a tie on dueAt with the identifier, so the order is total', () => {
    const { store } = openInMemoryHarness();
    const sharedDueAt = '2026-03-02T09:00:00.000Z';

    const tied = store.create({ text: 'Tied first inserted', dueAt: sharedDueAt });
    const alsoTied = store.create({ text: 'Tied second inserted', dueAt: sharedDueAt });
    const later = store.create({ text: 'Later', dueAt: '2026-03-02T10:00:00.000Z' });

    // The expected order of the pair is computed from the identifiers the store
    // returned, never from the order they were inserted in — otherwise the case
    // would only restate insertion order and prove nothing about the tiebreak.
    const expectedTiedOrder = [tied.id, alsoTied.id].sort();

    const listed = store.list();

    expect(listed).toHaveLength(3);
    expect(listed.map((reminder) => reminder.id)).toEqual([
      ...expectedTiedOrder,
      later.id,
    ]);
    // The pair is adjacent, so nothing with a different due instant interleaved
    // itself between them.
    expect(listed[0]?.dueAt).toBe(sharedDueAt);
    expect(listed[1]?.dueAt).toBe(sharedDueAt);
    expect(listed[0]?.id).toBe(expectedTiedOrder[0]);
    expect(listed[1]?.id).toBe(expectedTiedOrder[1]);
  });

  it('returns an empty array when no reminder has been stored', () => {
    const { store } = openInMemoryHarness();

    const listed = store.list();

    expect(Array.isArray(listed)).toBe(true);
    expect(listed).toEqual([]);
    expect(listed).toHaveLength(0);
  });
});

describe('get', () => {
  it('returns the stored reminder for a known identifier', () => {
    const { store } = openInMemoryHarness();

    const created = store.create({ text: 'Known reminder', dueAt: '2026-03-02T09:00:00.000Z' });

    const read = store.get(created.id);

    expect(read).toBeDefined();
    expect(read).toEqual(created);
  });

  it('returns undefined for an identifier no reminder has', () => {
    const { store } = openInMemoryHarness();

    store.create({ text: 'The only reminder', dueAt: '2026-03-02T09:00:00.000Z' });

    // `undefined` — not an empty object and not a throw — is what the route layer
    // turns into a 404, so the value itself is asserted here.
    expect(store.get('8e6f2d9a-0000-4000-8000-000000000000')).toBeUndefined();
  });
});


describe('complete', () => {
  it('returns the reminder marked complete, as a boolean', () => {
    const { store } = openInMemoryHarness();

    const created = store.create({ text: 'To be completed', dueAt: '2026-03-02T09:00:00.000Z' });

    const completed = store.complete(created.id);

    expect(completed).toBeDefined();
    expect(typeof completed?.completed).toBe('boolean');
    // The returned object reports the persisted state: it is read back from the
    // row the statement changed, so this is the stored value and not an echo of
    // the call.
    expect(completed?.completed).toBe(true);
    expect(completed?.id).toBe(created.id);
  });

  it('persists completion, so a later read of the row reports it too', () => {
    const { store } = openInMemoryHarness();

    const created = store.create({ text: 'Persisted completion', dueAt: '2026-03-02T09:00:00.000Z' });
    store.complete(created.id);

    expect(store.get(created.id)?.completed).toBe(true);
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]?.completed).toBe(true);
  });

  it('leaves every other field of the reminder untouched', () => {
    const { store } = openInMemoryHarness();
    const dueAt = '2026-03-02T09:00:00.000Z';

    const created = store.create({ text: 'Only completion changes', dueAt });
    const completed = store.complete(created.id);

    expect(completed).toEqual({ ...created, completed: true });
    expect(completed?.dueAt).toBe(dueAt);
    expect(completed?.createdAt).toBe(PINNED_NOW);
    expect(completed?.notifiedAt).toBeNull();
  });

  it('is idempotent: completing an already completed reminder reports it complete again', () => {
    const { store } = openInMemoryHarness();

    const created = store.create({ text: 'Completed twice', dueAt: '2026-03-02T09:00:00.000Z' });

    const first = store.complete(created.id);
    const second = store.complete(created.id);

    // A repeat is an ordinary outcome rather than an error, and it reports the
    // same stored state the first call left.
    expect(first?.completed).toBe(true);
    expect(second).toBeDefined();
    expect(second?.completed).toBe(true);
    expect(second).toEqual(first);
  });

  it('returns undefined for an identifier no reminder has', () => {
    const { store } = openInMemoryHarness();

    store.create({ text: 'Untouched by the miss', dueAt: '2026-03-02T09:00:00.000Z' });

    expect(store.complete('8e6f2d9a-0000-4000-8000-000000000000')).toBeUndefined();
    expect(store.list()[0]?.completed).toBe(false);
  });
});

describe('markNotified — the claim that happens at most once', () => {
  it('records the instant the clock returned and leaves completion untouched', () => {
    const { store } = openInMemoryHarness();

    const created = store.create({ text: 'Due now', dueAt: '2026-03-01T11:59:00.000Z' });

    const claimed = store.markNotified(created.id);

    expect(claimed).toBeDefined();
    // `toBe` and not `toEqual`: the claim must store the accessor's value as it
    // was returned, not an instant some layer re-derived from it.
    expect(claimed?.notifiedAt).toBe(PINNED_NOW);
    expect(claimed?.completed).toBe(false);
    expect(store.get(created.id)?.notifiedAt).toBe(PINNED_NOW);
    expect(store.get(created.id)?.completed).toBe(false);
  });

  it('refuses a second claim, so no later instant can overwrite the recorded one', () => {
    const { store } = openInMemoryHarness();

    const created = store.create({ text: 'Claimed once only', dueAt: '2026-03-01T11:59:00.000Z' });

    const firstClaim = store.markNotified(created.id);
    expect(firstClaim?.notifiedAt).toBe(PINNED_NOW);

    current = LATER_PINNED_NOW;

    const secondClaim = store.markNotified(created.id);

    // The guard on the statement is what makes this undefined: the reminder is
    // no longer claimable, so the second call changed no row.
    expect(secondClaim).toBeUndefined();
    expect(store.get(created.id)?.notifiedAt).toBe(PINNED_NOW);
    expect(store.list()[0]?.notifiedAt).toBe(PINNED_NOW);
  });

  it('returns undefined for an identifier no reminder has', () => {
    const { store } = openInMemoryHarness();

    store.create({ text: 'Never claimed', dueAt: '2026-03-02T09:00:00.000Z' });

    expect(store.markNotified('8e6f2d9a-0000-4000-8000-000000000000')).toBeUndefined();
    expect(store.get('8e6f2d9a-0000-4000-8000-000000000000')).toBeUndefined();
  });

  it('claims a completed reminder exactly as it claims an uncompleted one', () => {
    const { store } = openInMemoryHarness();

    const created = store.create({ text: 'Completed, then claimed', dueAt: '2026-03-01T11:59:00.000Z' });
    store.complete(created.id);

    const claimed = store.markNotified(created.id);

    // The claim is about the column and not about the completion state, so the
    // two concerns are not conflated: a completed reminder is claimed here, and
    // the caller decides whether it is a candidate for notification.
    expect(claimed?.notifiedAt).toBe(PINNED_NOW);
    expect(claimed?.completed).toBe(true);

    current = LATER_PINNED_NOW;

    expect(store.markNotified(created.id)).toBeUndefined();
    expect(store.get(created.id)?.notifiedAt).toBe(PINNED_NOW);
    expect(store.get(created.id)?.completed).toBe(true);
  });
});

describe('remove', () => {
  it('returns true for a known identifier and leaves nothing behind', () => {
    const { store } = openInMemoryHarness();

    const created = store.create({ text: 'To be removed', dueAt: '2026-03-02T09:00:00.000Z' });

    expect(store.remove(created.id)).toBe(true);
    expect(store.get(created.id)).toBeUndefined();
    expect(store.list()).toEqual([]);
  });

  it('returns false for an unknown identifier and for a second removal of the same one', () => {
    const { store } = openInMemoryHarness();

    const created = store.create({ text: 'Removed once', dueAt: '2026-03-02T09:00:00.000Z' });

    expect(store.remove(created.id)).toBe(true);
    // An unknown identifier and an already removed one are the same outcome: no
    // row was deleted.
    expect(store.remove(created.id)).toBe(false);
    expect(store.remove('8e6f2d9a-0000-4000-8000-000000000000')).toBe(false);
  });

  it('removes a reminder in either completion state', () => {
    const { store } = openInMemoryHarness();

    const completed = store.create({ text: 'Completed reminder', dueAt: '2026-03-02T09:00:00.000Z' });
    const uncompleted = store.create({ text: 'Uncompleted reminder', dueAt: '2026-03-02T10:00:00.000Z' });
    store.complete(completed.id);

    expect(store.remove(completed.id)).toBe(true);
    expect(store.remove(uncompleted.id)).toBe(true);

    expect(store.get(completed.id)).toBeUndefined();
    expect(store.get(uncompleted.id)).toBeUndefined();
    expect(store.list()).toEqual([]);
  });

  it('removes only the reminder it was named, leaving the others intact', () => {
    const { store } = openInMemoryHarness();

    const kept = store.create({ text: 'Kept', dueAt: '2026-03-02T09:00:00.000Z' });
    const discarded = store.create({ text: 'Discarded', dueAt: '2026-03-01T11:59:00.000Z' });
    store.markNotified(kept.id);

    store.remove(discarded.id);

    expect(store.list()).toEqual([store.get(kept.id)]);
    expect(store.get(kept.id)?.notifiedAt).toBe(PINNED_NOW);
  });
});


describe('durability across a reopen — a stored reminder survives a restart', () => {
  it('reads the row back, unchanged, after the database file is closed and reopened', () => {
    const { db, filePath, store } = openTemporaryFileHarness();
    const dueAt = '2026-03-02T09:00:00.000Z';

    const created = store.create({ text: 'Survives a restart', dueAt });

    closeHandle(db);

    // Reopening the same path is the restart, and it applies the schema again:
    // the table, its constraints and its index already exist, so nothing is
    // created twice and nothing is dropped.
    const { store: reopenedStore } = openHarness(filePath);

    const read = reopenedStore.get(created.id);

    expect(read).toEqual(created);
    expect(read?.text).toBe('Survives a restart');
    expect(read?.dueAt).toBe(dueAt);
    expect(read?.createdAt).toBe(PINNED_NOW);
    expect(read?.completed).toBe(false);
    expect(read?.notifiedAt).toBeNull();
    // Exactly one row: reopening neither duplicated the row nor lost it.
    expect(reopenedStore.list()).toHaveLength(1);
  });

  it('keeps the notification claim across a reopen, so a restart cannot notify twice', () => {
    const { db, filePath, store } = openTemporaryFileHarness();
    const dueAt = '2026-03-01T11:59:00.000Z';

    const claimed = store.create({ text: 'Claimed before the restart', dueAt });
    const unclaimed = store.create({ text: 'Unclaimed before the restart', dueAt });
    expect(store.markNotified(claimed.id)?.notifiedAt).toBe(PINNED_NOW);

    closeHandle(db);

    // The restarted process reads its own, later clock; the claim recorded before
    // the restart is a stored value and does not move with it.
    current = LATER_PINNED_NOW;

    const { store: reopenedStore } = openHarness(filePath);

    expect(reopenedStore.get(claimed.id)?.notifiedAt).toBe(PINNED_NOW);
    expect(reopenedStore.markNotified(claimed.id)).toBeUndefined();
    expect(reopenedStore.get(claimed.id)?.notifiedAt).toBe(PINNED_NOW);

    // A reminder left unclaimed before the restart is still claimable after it,
    // so the claim's NULL survives in both directions.
    expect(reopenedStore.get(unclaimed.id)?.notifiedAt).toBeNull();
    expect(reopenedStore.markNotified(unclaimed.id)?.notifiedAt).toBe(LATER_PINNED_NOW);
  });

  it('reopens a database a second time without changing what it holds', () => {
    const { db, filePath, store } = openTemporaryFileHarness();
    const created = store.create({ text: 'Opened three times', dueAt: '2026-03-02T09:00:00.000Z' });
    store.complete(created.id);

    closeHandle(db);

    const { db: secondHandle, store: secondStore } = openHarness(filePath);
    expect(secondStore.list()).toHaveLength(1);
    expect(secondStore.get(created.id)?.completed).toBe(true);

    closeHandle(secondHandle);

    const { store: thirdStore } = openHarness(filePath);

    expect(thirdStore.list()).toEqual([{ ...created, completed: true }]);
    expect(thirdStore.list()).toHaveLength(1);
  });
});

describe('the 1,000-reminder bound', () => {
  it('serves the whole list from the statements prepared once at construction', () => {
    const { db } = openInMemoryHarness();
    const counting = countPreparedStatements(db);
    const store = createReminderStore(counting.handle, now);

    // Six statements — insert, list, get, complete, claim, delete — prepared when
    // the store is built. This also shows the count is live: a wrapper that saw
    // no `prepare` call at all could not make the rest of this case meaningful.
    expect(counting.prepareCalls()).toBe(6);

    seedReminders(store, SEEDED_REMINDER_COUNT);

    const preparedBeforeReading = counting.prepareCalls();

    const listed = store.list();

    expect(listed).toHaveLength(SEEDED_REMINDER_COUNT);
    // Reading 1,000 reminders prepared nothing: the list is one statement run
    // once, not a query per reminder.
    expect(counting.prepareCalls()).toBe(preparedBeforeReading);
  });

  it('returns all 1,000 reminders in dueAt ASC, id ASC order', () => {
    const { store } = openInMemoryHarness();
    const seeded = seedReminders(store, SEEDED_REMINDER_COUNT);

    const listed = store.list();

    // The whole array is compared against an independent statement of the
    // required order, and the due instants are separately shown to be
    // non-decreasing. A list in insertion order — which the seeding deliberately
    // makes a different order — fails both.
    expect(listed).toHaveLength(SEEDED_REMINDER_COUNT);
    expect(listed).toEqual([...seeded].sort(compareByDueAtThenId));
    expect(listed.map((reminder) => reminder.dueAt)).toEqual(
      listed.map((reminder) => reminder.dueAt).slice().sort(),
    );

    // Every stored reminder appears exactly once, and half of them share a due
    // instant with a neighbour, so the identifier's tiebreak is exercised here
    // and not only in the small case above.
    const listedIds = new Set(listed.map((reminder) => reminder.id));
    expect(listedIds.size).toBe(SEEDED_REMINDER_COUNT);
    expect(new Set(listed.map((reminder) => reminder.dueAt)).size).toBe(SEEDED_REMINDER_COUNT / 2);
  });
});

describe('the table constraint on stored text', () => {
  /**
   * The table's own bound, proved through the store's write path. Input rules
   * refuse text outside the bound before a request reaches the store, so this is
   * the third line of defence and it is asserted as such rather than assumed.
   */
  it('accepts a text of exactly the maximum length', () => {
    const { store } = openInMemoryHarness();
    const text = 'a'.repeat(MAXIMUM_TEXT_LENGTH);

    const created = store.create({ text, dueAt: '2026-03-02T09:00:00.000Z' });

    expect(created.text).toBe(text);
    expect(created.text).toHaveLength(MAXIMUM_TEXT_LENGTH);
    expect(store.get(created.id)?.text).toBe(text);
  });

  it('refuses a text one character over the maximum, storing nothing', () => {
    const { store } = openInMemoryHarness();

    // The failure is a violation of the CHECK constraint, so the statement is
    // refused. The driver's message is not asserted: what matters is that the
    // write does not succeed and leaves no row behind.
    expect(() =>
      store.create({ text: 'a'.repeat(MAXIMUM_TEXT_LENGTH + 1), dueAt: '2026-03-02T09:00:00.000Z' }),
    ).toThrow();

    expect(store.list()).toEqual([]);
  });

  it('refuses empty text at the table as well', () => {
    const { store } = openInMemoryHarness();

    expect(() => store.create({ text: '', dueAt: '2026-03-02T09:00:00.000Z' })).toThrow();

    expect(store.list()).toEqual([]);
  });
});

