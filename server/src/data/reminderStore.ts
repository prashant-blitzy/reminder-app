import { randomUUID } from 'node:crypto';

import type { Database, Statement } from 'better-sqlite3';

import type { NewReminder, Reminder } from '../types';

/**
 * The reminder data store: every statement the feature issues against the
 * reminders table, and the single mapping from a stored row to the object the
 * API returns.
 *
 * This module is the only place in the repository that touches SQLite on the
 * reminder feature's behalf, and it does none of the surrounding jobs:
 *
 * - The open handle arrives as a parameter, so the connection's lifetime belongs
 *   to the caller and a caller under test can pass an in-memory or temporary
 *   database.
 * - The table, its constraints and its index belong to `./schema.ts`, which the
 *   caller applies before constructing a store; no statement here creates,
 *   alters or drops anything.
 * - Time arrives as the injected `now` accessor, the same one the application is
 *   built with, so the creation instant and the notification claim share a
 *   single source that a caller can pin.
 *
 * Six statements are prepared once, when the store is constructed, and are
 * closed over by the methods that are returned. Preparing them per store rather
 * than per call is what keeps an open handle's statement count stable however
 * many reminders are read or written.
 *
 * No policy is decided here. Whether an instant is in the future, whether text
 * is long enough and whether a request body may carry an identity are settled
 * before a call reaches this module, so only an already-validated pair of values
 * arrives at `create`, and a client's value for any identity-bearing field never
 * reaches the database at all.
 */

/**
 * Insert one reminder.
 *
 * The identity-bearing columns are written by this statement rather than bound
 * by the caller: `completed` is the literal 0 and `notifiedAt` the literal NULL,
 * so a reminder cannot come into existence already complete or already claimed,
 * whatever a request body asked for. The four bound values are the generated
 * identifier, the trimmed text, the due instant exactly as it was received, and
 * the creation instant taken from the clock.
 */
const INSERT_REMINDER_SQL = `
INSERT INTO reminders (id, text, dueAt, completed, notifiedAt, createdAt)
VALUES (?, ?, ?, 0, NULL, ?)
`;

/**
 * The six columns of a reminder, in the order the row interface below declares
 * them. Spelled out rather than selecting every column of the table, so the row
 * shape a read produces cannot drift silently when the table changes.
 */
const REMINDER_COLUMNS = 'id, text, dueAt, completed, notifiedAt, createdAt';

/**
 * Every stored reminder, in the required due-time order.
 *
 * `dueAt ASC` is that order. The instants are the single ISO-8601 UTC format the
 * client's conversion produces, and that format sorts lexicographically in the
 * same order it sorts chronologically, so the index on `dueAt` is what serves
 * this statement. `id ASC` breaks a tie between two reminders that share a due
 * instant, which makes the order total rather than merely sorted and therefore
 * stable across reads.
 *
 * This one statement is the whole read path: the list the screen renders and the
 * scan for reminders that have come due are the same read, so the cost of either
 * does not grow with the number of stored reminders. No second query, count or
 * per-row lookup belongs beside it.
 */
const LIST_REMINDERS_SQL = `SELECT ${REMINDER_COLUMNS} FROM reminders ORDER BY dueAt ASC, id ASC`;

/** One reminder by identifier, reading the same explicit column list as the list. */
const GET_REMINDER_SQL = `SELECT ${REMINDER_COLUMNS} FROM reminders WHERE id = ?`;

/**
 * Mark a reminder complete.
 *
 * The column is set to the literal 1, so this statement is the only route from
 * incomplete to complete: the insert writes 0 and no other statement writes this
 * column. SQLite counts a row as changed whenever the WHERE clause matches it,
 * so completing an already completed reminder still reports a changed row and
 * leaves its state as it was.
 */
const COMPLETE_REMINDER_SQL = 'UPDATE reminders SET completed = 1 WHERE id = ?';

/**
 * Claim a reminder for notification, recording the instant the claim is made.
 *
 * Delivering a due reminder must happen at most once, and the record of that
 * delivery is this column, so the claim is one statement rather than a read
 * followed by a write: the row and the claim it carries commit together.
 *
 * The `AND notifiedAt IS NULL` guard is the mechanism rather than a refinement.
 * A reminder is claimable while the column is NULL and is excluded from this
 * statement for good once a claim is recorded, so nothing can claim a reminder a
 * second time and no later claim can overwrite an earlier one. The changed-row
 * count is how a caller learns whether it won the claim.
 */
const CLAIM_REMINDER_NOTIFIED_SQL =
  'UPDATE reminders SET notifiedAt = ? WHERE id = ? AND notifiedAt IS NULL';

/** Remove a reminder, in either completion state. */
const DELETE_REMINDER_SQL = 'DELETE FROM reminders WHERE id = ?';

/**
 * One row exactly as SQLite returns it for the column list above.
 *
 * `completed` is the storage form and not the API form: it is the INTEGER the
 * table constrains to 0 or 1, and its only conversion to a boolean happens in
 * `toReminder` below. Every other field is held as stored, so the three instants
 * remain the ISO-8601 strings the table holds and nothing between SQLite and
 * JSON interprets one.
 */
interface ReminderRow {
  id: string;
  text: string;
  dueAt: string;
  completed: number;
  notifiedAt: string | null;
  createdAt: string;
}

/**
 * The one row-to-object mapping for a reminder, and the only place the stored
 * 0/1 becomes the boolean the API returns.
 *
 * The returned object carries all six fields on every path, with `notifiedAt`
 * explicitly `null` while the reminder is unclaimed, so a consumer can always
 * tell an unclaimed reminder from a field that is missing. The three instants
 * are passed through exactly as stored: this function neither interprets one,
 * re-formats one nor applies a time zone to one, which is what keeps the instant
 * a client receives identical to the instant it sent.
 *
 * The stored 0 and 1 are read through a truth test rather than an identity
 * comparison, so the mapping holds whatever numeric representation the injected
 * handle returns for the column; the table's CHECK constraint already excludes
 * every other stored value.
 */
function toReminder(row: ReminderRow): Reminder {
  return {
    id: row.id,
    text: row.text,
    dueAt: row.dueAt,
    completed: Boolean(row.completed),
    notifiedAt: row.notifiedAt,
    createdAt: row.createdAt,
  };
}

/**
 * The store's whole public surface: the six operations the reminder feature
 * performs over its table.
 *
 * Each operation reports a missing reminder rather than throwing, because an
 * unknown identifier is an ordinary outcome of a `:id` route and the caller
 * decides what status it deserves: `undefined` from a single-row operation and
 * `false` from `remove` both mean no row was found. Only a failure of the
 * database handle itself propagates as a thrown error.
 */
export interface ReminderStore {
  /**
   * Persists one reminder and returns it as stored.
   *
   * The identifier is generated here and the creation instant is taken from the
   * clock, so neither comes from the input, which carries only the text and the
   * due instant. The new reminder starts uncompleted and unclaimed. The returned
   * object is read back from the row that was written, so it reports the
   * persisted state rather than restating the arguments.
   */
  create(input: NewReminder): Reminder;

  /** Every stored reminder in due-time order; an empty table yields an empty array. */
  list(): Reminder[];

  /** The reminder with this identifier, or `undefined` when no row has it. */
  get(id: string): Reminder | undefined;

  /**
   * Marks the reminder complete and returns it as stored, or `undefined` when no
   * row has this identifier. An already completed reminder is returned unchanged
   * rather than being treated as missing.
   */
  complete(id: string): Reminder | undefined;

  /**
   * Claims the reminder for notification and returns it as stored, or
   * `undefined` when the claim was not won: either no row has this identifier or
   * a claim is already recorded on it. A reminder whose claim failed keeps the
   * instant recorded by the claim that won.
   */
  markNotified(id: string): Reminder | undefined;

  /** Removes the reminder; `true` when a row was deleted and `false` when none was. */
  remove(id: string): boolean;
}

/**
 * Builds a store over an already open database, preparing its six statements
 * once.
 *
 * The schema is assumed to be applied already — the caller opens the handle and
 * applies it — so this function creates no table and touches no row. Constructing
 * a store is safe to repeat against one handle: every statement is prepared
 * afresh, nothing is cached across stores, and a store holds no state of its own
 * beyond the prepared statements and the clock it was given.
 *
 * @param db An open handle whose database already carries the reminder schema.
 *   Its lifetime stays with the caller; this function neither opens nor closes it.
 * @param now The store's only time source, returning an absolute UTC ISO-8601
 *   instant. It stamps `createdAt` on insert and supplies the instant a
 *   successful claim records, the same accessor the application is built with.
 * @returns The store's six operations.
 */
export function createReminderStore(db: Database, now: () => string): ReminderStore {
  // Each statement is prepared exactly once here. Its declared type pins the
  // values it binds; the two reads additionally declare the row they return,
  // which the statement's SQL text cannot convey, so their result type is
  // asserted. A statement is never prepared per call, and no operation below
  // prepares one of its own.
  const insertStatement: Statement<[string, string, string, string]> = db.prepare(INSERT_REMINDER_SQL);
  const listStatement = db.prepare(LIST_REMINDERS_SQL) as Statement<[], ReminderRow>;
  const getStatement = db.prepare(GET_REMINDER_SQL) as Statement<[string], ReminderRow>;
  const completeStatement: Statement<[string]> = db.prepare(COMPLETE_REMINDER_SQL);
  const claimStatement: Statement<[string, string]> = db.prepare(CLAIM_REMINDER_NOTIFIED_SQL);
  const deleteStatement: Statement<[string]> = db.prepare(DELETE_REMINDER_SQL);

  /**
   * Reads back a row a write has just affected and maps it.
   *
   * The write statements do not return rows, so this is how a mutating operation
   * reports persisted state: the object a caller receives was read from the
   * table after the change committed, not assembled from the values it was
   * passed.
   *
   * The one way this can find nothing is a database that accepted a write it did
   * not persist, which is a failure of the handle rather than a missing
   * reminder. It is raised as an error for the caller to report, and its message
   * carries neither the reminder's text nor its identifier.
   */
  const readStoredReminder = (id: string): Reminder => {
    const row = getStatement.get(id);

    if (row === undefined) {
      throw new Error('A reminder that was just written could not be read back.');
    }

    return toReminder(row);
  };

  return {
    create(input: NewReminder): Reminder {
      const id = randomUUID();

      insertStatement.run(id, input.text, input.dueAt, now());

      return readStoredReminder(id);
    },

    list(): Reminder[] {
      return listStatement.all().map(toReminder);
    },

    get(id: string): Reminder | undefined {
      const row = getStatement.get(id);

      return row === undefined ? undefined : toReminder(row);
    },

    complete(id: string): Reminder | undefined {
      const result = completeStatement.run(id);

      return result.changes === 0 ? undefined : readStoredReminder(id);
    },

    markNotified(id: string): Reminder | undefined {
      const result = claimStatement.run(now(), id);

      return result.changes === 0 ? undefined : readStoredReminder(id);
    },

    remove(id: string): boolean {
      return deleteStatement.run(id).changes > 0;
    },
  };
}
