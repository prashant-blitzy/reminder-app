import type { Database } from 'better-sqlite3';

/**
 * The single definition of the reminder storage shape: one table, its two CHECK
 * constraints and one index. `server/src/data/database.ts` applies it in
 * production and in tests alike, so a test database has exactly the shape the
 * real one has, and no second definition of the table exists anywhere.
 *
 * Every column is camelCase and carries the same name as the JSON key the API
 * returns, so a column, a row field and a response key are one name throughout.
 *
 * The columns are, in order:
 *   - `id`         TEXT primary key. Deliberately not INTEGER PRIMARY KEY: that
 *                  form would make the column an alias for the rowid SQLite
 *                  assigns itself rather than holding the UUID that
 *                  `server/src/data/reminderStore.ts` mints with
 *                  `crypto.randomUUID()`. Identity-bearing values are derived
 *                  server-side and never accepted from a caller. SQLite does not
 *                  imply NOT NULL for a TEXT primary key, so the column is left
 *                  exactly as specified here and the store's always-supplied
 *                  UUID, rather than a constraint, is what keeps an id present.
 *   - `text`       the reminder text, 1-280 characters as stored. The CHECK is
 *                  the third line of defence behind the client form and the
 *                  input rules; `length()` on a TEXT value counts characters, so
 *                  280 is accepted and 281 is refused.
 *   - `dueAt`      the absolute due instant as an ISO-8601 UTC string. Opaque to
 *                  the server, which never reformats or re-derives it, and has
 *                  no default and no format constraint.
 *   - `completed`  0 or 1. The conversion to a JSON boolean happens in exactly
 *                  one place, the row-to-object mapping in
 *                  `server/src/data/reminderStore.ts`; SQLite's BOOLEAN type name
 *                  is avoided so the stored representation is unambiguous.
 *   - `notifiedAt` the only nullable column. Written only by the notification
 *                  claim, and only from NULL, so the first claim wins and a
 *                  reminder is notified at most once across reloads and
 *                  restarts.
 *   - `createdAt`  the absolute insert instant, taken from the clock accessor
 *                  injected into the store.
 *
 * Both statements check for the object's existence before creating it, which is
 * the whole idempotence mechanism: the schema is applied on every startup, so a
 * restart neither loses nor duplicates anything and no migration step, drop or
 * alter is ever needed.
 *
 * The single index serves both the required list order
 * `ORDER BY dueAt ASC, id ASC` and the due scan, which is what keeps the list
 * responsive at the 1,000-reminder bound. No second table, column or index is
 * part of this storage shape.
 */
const REMINDERS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS reminders (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 280),
  dueAt TEXT NOT NULL,
  completed INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0,1)),
  notifiedAt TEXT,
  createdAt TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reminders_due_at ON reminders (dueAt);
`;

/**
 * Creates the reminder table, its constraints and its index on an already open
 * database, creating nothing that is already there.
 *
 * The connection's lifecycle belongs to the caller: this function neither opens
 * nor closes a handle, and performs no data statement of its own, so calling it
 * against the same handle more than once is safe and leaves existing rows
 * untouched.
 *
 * @param db An open better-sqlite3 database handle.
 */
export function applySchema(db: Database): void {
  db.exec(REMINDERS_SCHEMA_SQL);
}
