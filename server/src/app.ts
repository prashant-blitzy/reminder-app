/**
 * The Express 5 application: the reminder API, and the client it serves, wired
 * together in one place.
 *
 * This module is the server's construction point. It takes the two
 * collaborators the rest of the server is built around — the reminder data
 * store and the clock — and returns the assembled application, so the order the
 * middleware chain runs in is decided once here rather than once per entry
 * point. Its export is also the seam every API test constructs: a test builds a
 * store over an in-memory or temporary database, pins the clock, calls
 * `createApp` and drives the whole application in process, with no port bound
 * and no network reached.
 *
 * The chain, in the order it is assembled below, is the whole of this module:
 *
 *   1. `express.json()` — parse a JSON body before any route reads it. It is the
 *      only third-party middleware and the only body parser here. No CORS
 *      middleware is mounted because the application is served from a single
 *      origin: the client's development server proxies `/api` to this process
 *      and the production build is served by this process too, so there is no
 *      cross-origin configuration anywhere. No cookie parser, session, logger,
 *      compression, security-header, rate-limiting or health middleware is
 *      mounted either; the feature asks for none of them.
 *   2. the reminder router at `/api` — the five operations, whose paths,
 *      validation rules, statements and status codes all belong to their own
 *      modules and appear nowhere here.
 *   3. the API's own not-found answer — a path under `/api` that no route
 *      matched is still an API request, and must be answered with the API's
 *      error body rather than with Express's default HTML page.
 *   4. the client's production build, when it has been built — its static files,
 *      then a fallback that serves its entry document for every other path. The
 *      build is optional by design: the API is fully usable without it, which is
 *      what makes an API-only run and an in-process test possible.
 *   5. the error middleware, registered last so every failure raised above it
 *      arrives there — a refused input, an unknown id, a malformed request body
 *      the parser rejected, and every storage failure and bug beside them.
 *
 * What this module deliberately does not hold, each because another module owns
 * it: no reminder rule (validation), no SQL statement and no database handle
 * (storage), no status code and no error body (the error middleware), and no
 * instant of its own — nothing here reads the wall clock, and the `now` accessor
 * it is handed is the same one the store was built with, so creation timestamps,
 * the notification claim and the past-due rule all read one clock a test can
 * pin. It reads no environment variable either: `PORT` and `DATABASE_PATH`
 * belong to the composition root, which is what lets a test call `createApp`
 * with no environment set up at all. It writes no log line: this server keeps no
 * audit trail and no log sink, so nothing here touches a console, a file or a
 * service.
 */

import fs from 'node:fs';
import path from 'node:path';

import express from 'express';
import type { Express, NextFunction, Request, Response } from 'express';

import type { ReminderStore } from './data/reminderStore';
import { errorHandler, notFound } from './middleware/errorHandler';
import { createRemindersRouter } from './routes/reminders';

/**
 * The workspace layout this module navigates by: the repository root holds one
 * directory per npm workspace, each identified by its own manifest. The names
 * are those the project fixes — `client/` and `server/` as top-level
 * directories.
 */
const SERVER_DIRECTORY_NAME = 'server';
const CLIENT_DIRECTORY_NAME = 'client';
const PACKAGE_MANIFEST_NAME = 'package.json';

/**
 * The client's production build inside its workspace, and the entry document
 * inside that build. The bundler emits to this directory by default, and it is a
 * deliberate contract with this module: the build is what a single-origin run
 * serves, so both names are stated once here.
 */
const CLIENT_BUILD_DIRECTORY_NAME = 'dist';
const CLIENT_ENTRY_FILE_NAME = 'index.html';

/**
 * The path every reminder operation is mounted under, and the prefix that
 * separates an API request from a client route. The router registers its paths
 * without it, so the prefix is stated here and nowhere else.
 */
const API_MOUNT_PATH = '/api';

/**
 * The route that receives every path no earlier handler claimed, written in the
 * named form Express 5 requires: an unnamed `'*'` is rejected at registration
 * with `TypeError: Missing parameter name at index 1: *` and takes the process
 * down before it can serve anything.
 */
const SPA_FALLBACK_ROUTE = '/*splat';

/**
 * The collaborators `createApp` is built from, supplied as one object rather
 * than as positional arguments because it is the construction point shared by
 * the composition root and the API tests.
 */
export interface CreateAppOptions {
  /**
   * The reminder data store. Every read and write goes through it: this module
   * holds no database handle, opens no connection and writes no SQL, so the
   * storage layer's lifetime — and whether it is file-backed, temporary or
   * in-memory — stays with whoever built it.
   */
  store: ReminderStore;

  /**
   * Returns the current instant as an absolute UTC ISO-8601 string. It is the
   * same accessor the store was constructed with, so the timestamps the server
   * stamps and the past-due rule it applies read one clock; a test that pins it
   * pins all of them together. Nothing in this module reads the wall clock.
   */
  now: () => string;
}

/**
 * Walks up from a directory looking for the repository root: the nearest
 * ancestor directory that holds a `server` workspace carrying a manifest.
 *
 * The walk exists because the two documented ways of running the server place
 * this module differently on disk. Loaded straight from source by the
 * development runner it is `<repository>/server/src`, and compiled it is
 * `<repository>/server/dist`; the nearest ancestor holding `server/package.json`
 * is `<repository>` in both cases, so the client build is resolved to one
 * absolute path rather than one per run mode. The process's working directory is
 * deliberately not consulted: it differs between the workspace scripts and a
 * direct invocation, and a build found relative to it would be a different build
 * per caller.
 *
 * @param startDirectory The directory to start the walk from, normally the
 *   directory holding this module.
 * @returns The absolute path of the repository root, or `undefined` when no
 *   ancestor qualifies. Unlike a database location, a client build is genuinely
 *   optional — an API-only run and an in-process test have none — so a root that
 *   cannot be located leaves the application fully usable and is reported rather
 *   than raised.
 */
function findRepositoryRoot(startDirectory: string): string | undefined {
  let directory = path.resolve(startDirectory);

  for (;;) {
    const serverManifest = path.join(directory, SERVER_DIRECTORY_NAME, PACKAGE_MANIFEST_NAME);

    if (fs.existsSync(serverManifest)) {
      return directory;
    }

    const parentDirectory = path.dirname(directory);

    if (parentDirectory === directory) {
      return undefined;
    }

    directory = parentDirectory;
  }
}

/**
 * Resolves the absolute path of the client's production build.
 *
 * @returns `<repository root>/client/dist`, or `undefined` when the repository
 *   root cannot be located. Whether the build has actually been produced is a
 *   separate question, answered by the existence check at the mount point,
 *   because a missing build is a normal state rather than a failure.
 */
function resolveClientBuildDirectory(): string | undefined {
  const repositoryRoot = findRepositoryRoot(__dirname);

  return repositoryRoot === undefined
    ? undefined
    : path.join(repositoryRoot, CLIENT_DIRECTORY_NAME, CLIENT_BUILD_DIRECTORY_NAME);
}

/**
 * Mounts the client's production build: its static files, then the fallback
 * that serves its entry document for a path no file matched.
 *
 * The fallback is what lets the client be reached at any page path rather than
 * only at the files the build happens to contain. It passes two kinds of request
 * on instead of answering them with the entry document:
 *
 *   - a path under the API prefix. The fallback is registered after the API
 *     mount and matches every path, so without this an unknown API path would
 *     become a page rather than keep the API's answer.
 *   - a path that names a file — its last segment carries an extension, such as
 *     `/favicon.ico` or a stale `/assets/index-<hash>.js`. The static handler
 *     above has already looked for that file and not found it, so the honest
 *     answer is a 404. Sending the entry document instead would report an absent
 *     file as present, with HTML where an icon, a script or a stylesheet was
 *     expected, which surfaces in the browser as a misleading MIME-type error
 *     rather than as the missing file it is. Page paths carry no extension, so
 *     every path the client can actually be opened at still reaches it.
 *
 * @param app The application to mount onto.
 * @param clientDirectory The absolute path of the built client, which the caller
 *   has already established exists.
 */
function serveBuiltClient(app: Express, clientDirectory: string): void {
  app.use(express.static(clientDirectory));

  app.get(SPA_FALLBACK_ROUTE, (req: Request, res: Response, next: NextFunction): void => {
    if (req.path.startsWith(API_MOUNT_PATH) || path.posix.extname(req.path) !== '') {
      next();
      return;
    }

    // The entry document is named relative to the build directory, passed as the
    // root, rather than as one absolute path. The file sender refuses any path
    // with a segment that starts with a dot unless the segment lies inside the
    // root it was given; with an absolute path and no root, a checkout placed
    // under any dot-prefixed directory would answer every page path with an
    // error while `/` still worked through the static handler.
    res.sendFile(CLIENT_ENTRY_FILE_NAME, { root: clientDirectory });
  });
}

/**
 * Builds the application over an injected store and clock.
 *
 * Every request follows the same route through it: the JSON body is parsed, the
 * reminder router answers it if its path is one of the five operations, an
 * unmatched API path is refused as an API error, a request for anything else is
 * answered with the client's document when a build exists, and whatever fails
 * along the way is formatted by the error middleware at the end of the chain.
 *
 * @param options The application's two collaborators.
 * @returns The assembled application, ready to listen.
 */
export function createApp({ store, now }: CreateAppOptions): Express {
  const app = express();

  // A JSON body is parsed before any route runs, so a handler receives an object
  // rather than a stream. A body the parser cannot read is raised as its own
  // error and reaches the error middleware below, which answers it as the
  // refused input it is. This is the only body parser and the only third-party
  // middleware in the chain.
  app.use(express.json());

  // The feature's whole HTTP surface, under the one prefix every operation
  // shares; the router itself registers its paths without it.
  app.use(API_MOUNT_PATH, createRemindersRouter({ store, now }));

  // An API path no operation matched is still an API request, so it is refused
  // in the API's own vocabulary: the request is forwarded as the error the error
  // middleware turns into the single `{ error, field? }` body, rather than being
  // left to fall through to the HTML page Express sends by default. The wording,
  // the status and the body shape all stay in that one module; this mount only
  // decides that an unmatched API path is an error to be formatted.
  app.use(API_MOUNT_PATH, (_req: Request, _res: Response, next: NextFunction): void => {
    next(notFound());
  });

  // The client's build is served from this same process, which is what makes one
  // origin serve both the API and the page. It is mounted only once it has been
  // built, so the application is fully usable — and every API test is meaningful
  // — before any client build exists.
  const clientDirectory = resolveClientBuildDirectory();

  if (clientDirectory !== undefined && fs.existsSync(clientDirectory)) {
    serveBuiltClient(app, clientDirectory);
  }

  // Registered last, so every failure raised by the parser, the router or the
  // client's build above arrives here and is answered as one shape.
  app.use(errorHandler);

  return app;
}
