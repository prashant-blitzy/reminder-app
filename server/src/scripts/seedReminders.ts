import { createDatabase } from '../data/database';
import { createReminderStore } from '../data/reminderStore';

import type { NewReminder } from '../types';

/**
 * Dev-only seeding of reminders, so the reminder list can be exercised at the
 * thousand-row load the project requires it to stay responsive at.
 *
 * The automated form of that check lives with the store's own suite, which seeds
 * a thousand rows against an in-memory or temporary database. This script is the
 * manual form: it points the application's own database at a batch of reminders
 * a person can then open in the browser and scroll, which is why it is the only
 * file in the server that exists purely for development.
 *
 * It is run through the workspace script that already names it:
 *
 *     npm run seed --workspace server            # 1000 reminders, the default
 *     npm run seed --workspace server -- 25      # an explicit count
 *
 * The database it writes to is the one the server itself would open: the path in
 * `DATABASE_PATH` when that variable is set, and the documented default beside
 * the server package otherwise. Nothing here resolves that path — the caller is
 * what resolves it, exactly as the composition root does — so the seeded rows
 * are the rows the running server serves.
 *
 * Four properties of this file are deliberate and load-bearing:
 *
 *   1. It reaches storage only through the store. `server/src/data/**` is the
 *      repository's only SQL, so this script contains no statement of any kind:
 *      it opens the database through `createDatabase` and writes rows through
 *      the store's `create`, never through a handle it has prepared itself.
 *   2. It only ever inserts. There is no delete, no truncate, no drop and no row
 *      replacement, so running it twice adds a second batch and leaves the first
 *      batch exactly as it was.
 *   3. It supplies no identity-bearing value. `create` derives the identifier,
 *      stamps the creation instant and leaves the reminder uncompleted and
 *      unclaimed, so the only two things passed in are the text and the due
 *      instant.
 *   4. It reports one line and nothing else. Standard output carries the number
 *      of rows inserted, with no reminder text, no identifier and no database
 *      path; a failure is one short line on standard error and a non-zero exit
 *      status, never a stack dump.
 *
 * This is a script rather than a module: it exports nothing, has no importable
 * surface and is not reachable from the running API. It is type-checked by the
 * server's `typecheck` and `build` scripts and is compiled to
 * `server/dist/scripts/seedReminders.js`, but nothing imports it.
 */

/**
 * How many reminders are inserted when the caller names no count.
 *
 * A thousand is the load the project requires the list and the due check to
 * stay responsive at, so the default is the check itself.
 */
const DEFAULT_COUNT = 1000;

/**
 * The gap between two consecutive seeded due instants: one minute.
 *
 * A fixed positive step is what makes the seeded instants strictly increasing
 * and distinct, so the list order the store imposes never has to fall back to
 * its tie-break between two reminders sharing a due instant, and a thousand
 * seeded rows read as a natural upcoming sequence running about seventeen hours
 * ahead of the run.
 */
const DUE_STEP_MS = 60_000;

/**
 * The label every seeded reminder's text is built from, followed by the row's
 * position in the batch and the batch size ("Seed reminder 7 of 1000").
 *
 * The position is what makes a seeded row recognisable in the browser without
 * this script having to print an identifier, and the resulting text is always
 * non-blank and far below the 280-character bound the table enforces, so no
 * insert can be refused part way through a batch.
 */
const SEED_TEXT_LABEL = 'Seed reminder';

/**
 * The database handle's type, taken from the factory that produces it.
 *
 * Spelling it out here rather than importing the driver is what keeps this
 * script's imports to the two sibling modules it is allowed: the handle's type
 * is whatever `createDatabase` returns, so it stays correct without a second
 * dependency being named at this boundary.
 */
type DatabaseHandle = ReturnType<typeof createDatabase>;

/**
 * This script's own time accessor, handed to the store as its only clock.
 *
 * The store never reads the wall clock for itself: every instant it writes comes
 * from the accessor it was constructed with, which is what lets the API's tests
 * pin time. Seeding is a one-off development action with nothing to pin, so the
 * accessor is the real clock — but it is still an accessor passed in, so the
 * store's contract is honoured rather than bypassed.
 *
 * @returns The current instant as an absolute UTC ISO-8601 string, the single
 * instant format this project stores.
 */
const now = (): string => new Date().toISOString();

/**
 * What a count argument resolved to: either a usable count, or the argument that
 * could not be used.
 *
 * The two outcomes are kept apart as data rather than signalled through a
 * sentinel, so the caller cannot mistake "the caller named no count" for "the
 * caller named a count that is not a number", and the rejected argument travels
 * with the rejection for the error line to name.
 */
type ResolvedCount =
  | { readonly isValid: true; readonly count: number }
  | { readonly isValid: false; readonly argument: string };

/**
 * Turns the optional command-line argument into the number of reminders to
 * insert.
 *
 * No argument means the documented default. An argument is accepted only as a
 * positive whole number: digits alone, and a value of at least one, so a
 * negative, zero, fractional, non-numeric or unrepresentably large value is
 * rejected instead of being coerced into something that would insert nothing or
 * insert indefinitely.
 * Surrounding whitespace is trimmed first, because the value arrives from a
 * command line where a shell may have passed it on with padding.
 *
 * This function decides only; reporting a rejection belongs to the caller, so
 * the resolve step stays free of output.
 *
 * @param rawArgument The raw value of `process.argv[2]`, or `undefined` when the
 * caller passed no argument at all.
 * @returns The count to insert, or the argument that was rejected.
 */
function resolveCount(rawArgument: string | undefined): ResolvedCount {
  if (rawArgument === undefined) {
    return { isValid: true, count: DEFAULT_COUNT };
  }

  const trimmedArgument = rawArgument.trim();

  if (!/^[0-9]+$/.test(trimmedArgument)) {
    return { isValid: false, argument: rawArgument };
  }

  const count = Number(trimmedArgument);

  if (!Number.isSafeInteger(count) || count < 1) {
    return { isValid: false, argument: rawArgument };
  }

  return { isValid: true, count };
}

/**
 * Renders a rejected count argument for the error line.
 *
 * The value is quoted and escaped, so an argument carrying a newline or another
 * control character cannot forge or split the line it is reported on, and it is
 * truncated, because the length of a command-line argument is bounded by nothing
 * this script controls and a rejection is not worth an unbounded line of output.
 *
 * @param rawArgument The rejected argument as it arrived.
 * @returns The argument as a short, safely printable fragment.
 */
function formatArgument(rawArgument: string): string {
  const maxRenderedLength = 32;
  const truncatedArgument =
    rawArgument.length > maxRenderedLength
      ? `${rawArgument.slice(0, maxRenderedLength)}...`
      : rawArgument;

  return JSON.stringify(truncatedArgument);
}

/**
 * Reduces a thrown value to one short line for the error output.
 *
 * Only the message is reported. A stack trace names source files and line
 * numbers, which a person seeding a development database cannot act on, while
 * the message is what identifies the cause — an unusable database location, a
 * handle that could not be opened — in the single line the failure is allowed.
 *
 * @param error The value thrown by the seeding attempt.
 * @returns The error's message, or a rendering of a value that is not an error.
 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Opens the project's database, inserts the requested batch of reminders and
 * closes the handle.
 *
 * The batch is inserted through the store's `create`, one row per call, which is
 * the only write path this file has: the store derives every identity-bearing
 * column, so the two values supplied per row are the text and the due instant,
 * and nothing here supplies an identifier, a completion state or a claim.
 *
 * The due instants are laid out from a single reading of the clock taken before
 * the loop. One origin for the whole batch is what keeps the sequence evenly
 * spaced and its first instant in the future however long the batch takes; an
 * instant computed per row from a fresh reading would drift by the run's own
 * duration and could eventually stop advancing.
 *
 * The text and the due instant are the two guarantees this script has to keep
 * for itself, because `create` validates nothing — validation is the API's
 * concern. Both hold by construction: the text is a non-blank label well inside
 * the 280-character bound, so the table's CHECK cannot refuse a row and abort a
 * batch part way through, and the instants are strictly increasing and strictly
 * later than the run, so the seeded rows read as upcoming rather than overdue.
 *
 * The handle is closed whether the batch completed or threw. Closing checkpoints
 * the write-ahead log into the database file, so whatever the batch committed is
 * on disk, and it releases the database for the process to exit cleanly.
 *
 * @param count How many reminders to insert.
 * @returns How many reminders were inserted.
 * @throws Whatever the database, the schema application or an insert threw,
 * after the handle has been closed.
 */
function seedReminders(count: number): number {
  // The location is the caller's to resolve, exactly as the composition root
  // resolves it: this factory deliberately does not read DATABASE_PATH itself,
  // and an unset variable arrives here as undefined and selects the documented
  // default database beside the server package.
  const db: DatabaseHandle = createDatabase(process.env.DATABASE_PATH);

  try {
    const store = createReminderStore(db, now);
    const firstDueAtMs = Date.now() + DUE_STEP_MS;

    let inserted = 0;

    for (let index = 0; index < count; index += 1) {
      const input: NewReminder = {
        text: `${SEED_TEXT_LABEL} ${index + 1} of ${count}`,
        dueAt: new Date(firstDueAtMs + index * DUE_STEP_MS).toISOString(),
      };

      store.create(input);

      // Counted from the rows the loop actually got through rather than from
      // the requested count, so a batch that throws reports the failure it hit
      // rather than a number this script never verified.
      inserted += 1;
    }

    return inserted;
  } finally {
    db.close();
  }
}

/**
 * Runs the seeder once and reports its outcome.
 *
 * A rejected argument stops the run before any database is opened, so nothing is
 * inserted and the only output is one line naming what was wrong. A successful
 * run prints exactly one line carrying the number of rows inserted. A failure
 * prints one short line and exits non-zero, which is what makes a failed seeding
 * visible to whoever ran it.
 */
function main(): void {
  // Read by index rather than destructured: the element's type is what carries
  // the "no argument was passed" case, and an absent argument is a normal run
  // of the documented default rather than an error.
  const resolvedCount = resolveCount(process.argv[2]);

  if (!resolvedCount.isValid) {
    process.stderr.write(
      `The reminder count must be a positive whole number, and ${formatArgument(resolvedCount.argument)} is not one. ` +
        'Usage: npm run seed --workspace server -- [count]\n',
    );
    process.exitCode = 1;

    return;
  }

  try {
    const inserted = seedReminders(resolvedCount.count);

    // The whole of this script's standard output: one line, no reminder text,
    // no identifier, no database path.
    console.log(`Inserted ${inserted} reminders.`);
  } catch (error) {
    process.stderr.write(`Seeding reminders failed: ${describeError(error)}\n`);
    process.exitCode = 1;
  }
}

main();
