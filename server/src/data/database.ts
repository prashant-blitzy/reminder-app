import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import { applySchema } from './schema';

/**
 * Opens the reminder database and hands back a ready-to-use handle.
 *
 * This module is the only place in the repository where a SQLite connection is
 * opened at all: the rest of the storage layer receives the handle this function
 * returns, and no other file calls the driver's constructor. The database is
 * embedded in the server process, so opening one costs a file creation at most
 * and needs no server, broker, VPN or container to be running first.
 *
 * The work is exactly four steps, in this order:
 *   1. resolve the target path (see `resolveDatabasePath`),
 *   2. create the directory that will hold the file when it is missing,
 *   3. open the database and put it in WAL journal mode,
 *   4. apply the storage shape by calling `applySchema` from `./schema`.
 *
 * The fourth step is why this module applies the schema on both the on-disk and
 * the in-memory path: a test database built through this function has the same
 * table, the same two CHECK constraints and the same index as the one the server
 * uses, because both are created by the single definition in `./schema` rather
 * than by two definitions that could drift apart. That statement creates only
 * what is absent, so applying it on every startup is idempotent: a restart
 * neither loses a row nor duplicates a table, and no migration step, drop or
 * alter is ever needed.
 *
 * The returned handle's lifecycle belongs to the caller. This module never
 * closes it, never runs a data statement of its own, never seeds a fixture and
 * never reads the clock, so importing it has no side effect beyond the database
 * the caller explicitly asked for.
 */

/**
 * The name of the server workspace directory, and the file that identifies it as
 * a package root. Together they are what `findServerPackageRoot` walks up looking
 * for; they are derived from the workspace layout the project fixes, in which the
 * repository root holds `client/` and `server/` and each is an npm package with
 * its own `package.json`.
 */
const SERVER_DIRECTORY_NAME = 'server';
const PACKAGE_MANIFEST_NAME = 'package.json';

/**
 * The directory, relative to the server package root, that holds the database
 * file, and the file's name inside it.
 */
const DATA_DIRECTORY_NAME = 'data';
const DEFAULT_DATABASE_FILE_NAME = 'reminders.sqlite';

/**
 * The value `better-sqlite3` reads as "an unnamed database held in memory".
 * Passed through untouched: a database opened with it writes nothing to disk, so
 * it is the path the tests use and the reason the directory creation below is
 * skipped for it.
 */
const IN_MEMORY_DATABASE_PATH = ':memory:';

/**
 * Walks up from a directory looking for the server package root: the nearest
 * ancestor directory that is itself named `server` and carries a `package.json`.
 *
 * The walk exists because a module-relative default alone would resolve to a
 * different file in each of the two documented ways of running this server. The
 * compiled module lives at `<repository>/server/dist/data/`, and the same module
 * loaded straight from source by the development runner lives at
 * `<repository>/server/src/data/`; the nearest `server` package root above each
 * of them is `<repository>/server`, so both runs reach one database file instead
 * of one file per run mode.
 *
 * @param startDirectory The directory to start the walk from, normally the
 * directory holding this module.
 * @returns The absolute path of the server package root.
 * @throws Error when no ancestor qualifies. That cannot happen in the layout the
 * project fixes, and it fails loudly rather than falling back to the process's
 * working directory, which would silently produce a second, unrelated database
 * somewhere the documentation does not mention.
 */
function findServerPackageRoot(startDirectory: string): string {
  let directory = path.resolve(startDirectory);

  for (;;) {
    if (
      path.basename(directory) === SERVER_DIRECTORY_NAME &&
      fs.existsSync(path.join(directory, PACKAGE_MANIFEST_NAME))
    ) {
      return directory;
    }

    const parentDirectory = path.dirname(directory);

    if (parentDirectory === directory) {
      throw new Error(
        `Could not locate the server package root above ${path.resolve(startDirectory)}: ` +
          `no ancestor directory named '${SERVER_DIRECTORY_NAME}' holds a ${PACKAGE_MANIFEST_NAME}.`,
      );
    }

    directory = parentDirectory;
  }
}

/**
 * Resolves a caller-supplied database location, or the documented default when
 * the caller handed nothing, into the absolute path to use.
 *
 * The three input cases are kept apart on purpose:
 *   - nothing (`undefined`, `null` or the empty string, which is what an unset
 *     `DATABASE_PATH` amounts to) yields `<server package root>/data/reminders.sqlite`,
 *   - the in-memory marker is returned exactly as passed, so the driver opens an
 *     unnamed database and no directory or file is created for it,
 *   - anything else is used verbatim. A relative path stays relative to whatever
 *     the caller's working directory is, because interpreting it here would
 *     change a path the caller already expressed.
 *
 * @param databasePath The path the caller asked for, or nothing at all.
 * @returns The absolute default path, the in-memory marker, or the caller's own
 * path unchanged.
 */
function resolveDatabasePath(databasePath?: string | null): string {
  if (databasePath === IN_MEMORY_DATABASE_PATH) {
    return databasePath;
  }

  if (databasePath !== undefined && databasePath !== null && databasePath !== '') {
    return databasePath;
  }

  return path.join(
    findServerPackageRoot(__dirname),
    DATA_DIRECTORY_NAME,
    DEFAULT_DATABASE_FILE_NAME,
  );
}

/**
 * Opens the reminder database, applying the schema before returning it.
 *
 * @param databasePath Where the database lives. Omit it — or pass `null` or an
 * empty string, which is what an unset `DATABASE_PATH` amounts to, and what the
 * composition root hands over — to use the documented default,
 * `<server package root>/data/reminders.sqlite`. Pass `':memory:'` for an
 * in-memory database that touches no disk, which is the path the tests use.
 * Any other value is taken as the file path itself, and its containing directory
 * is created when it does not exist yet, so a caller can point the database at a
 * fresh location without preparing it first.
 * @returns An open, schema-ready `better-sqlite3` handle, owned by the caller.
 */
export function createDatabase(databasePath?: string | null): Database.Database {
  const resolvedDatabasePath = resolveDatabasePath(databasePath);
  const isInMemory = resolvedDatabasePath === IN_MEMORY_DATABASE_PATH;

  if (!isInMemory) {
    // The database file and the two sidecars WAL mode keeps beside it all land in
    // this directory, so it has to exist before the driver creates the file.
    fs.mkdirSync(path.dirname(resolvedDatabasePath), { recursive: true });
  }

  const db = new Database(resolvedDatabasePath);

  if (!isInMemory) {
    // Write-ahead logging is what carries committed rows across a process
    // restart, which is the durability the reminders rely on. It is a property
    // of file-backed databases and inert for an unnamed one, hence the branch.
    db.pragma('journal_mode = WAL');
  }

  applySchema(db);

  return db;
}
