/**
 * The composition root and process entry point of the server workspace.
 *
 * This is the only file that resolves configuration, opens the database, builds
 * the store, builds the application and binds a port. Everything the server is
 * made of is created here and nowhere else, and every other module in the
 * workspace is written to be constructed by its caller — which is what lets a
 * test build the same application over an in-memory store instead of starting
 * this process.
 *
 * The composition runs in one order, and this file is that order:
 *
 *   1. the database — `createDatabase` opens the file `DATABASE_PATH` names, or
 *      the documented default when the variable is unset, and applies the schema
 *      idempotently, so a first run creates the table and a later run leaves it
 *      alone. The path rule lives inside `./data/database`, which resolves it
 *      from its own module location; this file hands the variable over and never
 *      computes a location of its own.
 *   2. the clock — one accessor, `now` below, returning an absolute UTC
 *      ISO-8601 instant. It is the only wall-clock read in the workspace: it
 *      stamps `createdAt` when a reminder is inserted, supplies the `notifiedAt`
 *      a notification claim records, and supplies the instant the past-due rule
 *      compares a submitted `dueAt` against. One accessor rather than one per
 *      module is what keeps those three readings in agreement, and it is why a
 *      test that pins time pins all three together.
 *   3. the store — `createReminderStore` receives that same accessor instance,
 *      so the instants the storage layer writes come from the identical clock
 *      the application's validation reads.
 *   4. the application — `createApp({ store, now })` receives the store and,
 *      deliberately, the same accessor again; handing it a second clock would
 *      let a stored instant and a compared instant drift apart.
 *   5. the listener — the port is resolved from `PORT` and the process binds it,
 *      logging one line naming the URL.
 *
 * Two ways of running this workspace both enter through the file above: the
 * development run loads it straight from source (`tsx watch src/index.ts`) and
 * the built run executes its compiled form (`node dist/index.js`), so the
 * database default resolves to the same file in both and a database written by
 * one run is the database the other opens.
 *
 * The server has exactly two settings, `PORT` and `DATABASE_PATH`, and both work
 * with nothing configured: the port falls back to {@link DEFAULT_PORT} and the
 * database path to the storage module's documented default. There is no settings
 * module, no configuration file, no argument parser and no `.env` reader, and
 * there is no third setting, no credential and no secret — this application has
 * no accounts, no sessions and no external service to authenticate with.
 *
 * What this file holds no part of, each because another module owns it and this
 * one only wires: no route and no HTTP handling (`./routes/reminders` mounted by
 * `./app`), no SQL statement and no database driver (the handle arrives as a
 * return value from `./data/database` and is passed on, so `better-sqlite3` is
 * never imported here), no reminder rule (`./validation/reminderInput`), no
 * status code and no error body (`./middleware/errorHandler`), and no identity,
 * session, cookie or user concept anywhere, because the feature belongs to a
 * single anonymous user.
 *
 * It also adds nothing around the listening process. There is no signal handler,
 * no shutdown routine, no retry loop, no cluster fork, no scheduler and no
 * background worker: the server performs no scheduled work at all, because it
 * never decides that a reminder has become due — the open client selects due
 * reminders and the server only records the claim the client reports. A startup
 * failure, such as a database path that cannot be opened or a port already in
 * use, therefore stops the process with the failing operation's own error rather
 * than being swallowed here.
 *
 * Logging is one line, once, naming the URL. This server keeps no audit trail and
 * writes to no log sink, so no reminder text, no reminder identifier, no
 * credential and no stack trace is ever printed, and no logger is introduced.
 */

import { createApp } from './app';
import { createDatabase } from './data/database';
import { createReminderStore } from './data/reminderStore';

/**
 * The port the listener binds when `PORT` says nothing. It is not an arbitrary
 * fallback: the client's development configuration proxies its `/api` requests
 * to this port, so a development run and a built run reach the API at the same
 * address without either side being reconfigured.
 */
const DEFAULT_PORT = 3001;

/**
 * The inclusive range a configured port has to fall inside. The upper bound is
 * the largest value a TCP port can carry and the lower bound excludes zero,
 * which would let the operating system pick an arbitrary free port and make the
 * address the startup line reports untrue.
 */
const MIN_PORT = 1;
const MAX_PORT = 65535;

/**
 * Resolves the port to listen on from the value of `PORT`.
 *
 * The value arrives as a string because that is what the environment holds, and
 * it is converted here, once, at the point of use: a numeric string handed to a
 * listener is read as the path of a local socket rather than as a port. A value
 * that is absent, or present but blank, selects {@link DEFAULT_PORT}.
 *
 * An unusable value is refused rather than replaced by the default. A process
 * told to listen on one address and quietly listening on another is a
 * misconfiguration nobody sees, whereas failing here names the setting, the
 * permitted range and the value that was rejected, all of which are safe to
 * print — `PORT` is a number, never a credential.
 *
 * @param configuredPort The raw value of `PORT`, or `undefined` when unset.
 * @returns The port to bind, as a number.
 * @throws Error when the value is not a whole number inside the permitted range.
 */
function resolvePort(configuredPort: string | undefined): number {
  if (configuredPort === undefined || configuredPort.trim() === '') {
    return DEFAULT_PORT;
  }

  const port = Number(configuredPort);

  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
    throw new Error(
      `PORT must be a whole number between ${MIN_PORT} and ${MAX_PORT}; ` +
        `received '${configuredPort}'.`,
    );
  }

  return port;
}

/**
 * The workspace's single clock: the current instant as an absolute UTC ISO-8601
 * string.
 *
 * It is created once, here, and the one instance is handed to both collaborators
 * below, so every instant the server writes or compares comes from one source.
 * The instant carries no zone of its own — an ISO-8601 value with the `Z` suffix
 * denotes an absolute instant — and nothing here formats it for display: turning
 * a local date and time into that instant, and back into display text for the
 * viewer's zone, happens on the client, which is the only side that knows a zone.
 */
const now = (): string => new Date().toISOString();

// Step 1: the database. The environment variable is passed through as it is —
// including when it is unset, which the storage module reads as "use the
// documented default" — so the path-resolution rule exists in exactly one place.
const db = createDatabase(process.env.DATABASE_PATH);

// Step 2 and 3: the store, over that handle, reading time through the single
// accessor above.
const store = createReminderStore(db, now);

// Step 4: the application, over that store and that same accessor instance. The
// chain it assembles — the JSON body parser, the reminder router, the API's
// not-found answer, the built client when one exists, and the error middleware —
// is stated once in `./app`, and a second application, router or error handler is
// never built here.
const app = createApp({ store, now });

// Step 5: the listener. `PORT` is read here, as the configuration root this file
// is, and the listener binds every interface so the API and the built client are
// reachable from the same address.
const port = resolvePort(process.env.PORT);

app.listen(port, () => {
  console.log(`Reminder app listening on http://localhost:${port}`);
});
