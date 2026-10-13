# reminder-app
This is automated app

## Prerequisites

- **Node.js 20 LTS.** The root `package.json` declares the line as `"engines": { "node": "20.x" }`. This project was verified against **20.20.2**, and **20.19.0 is the hard floor**: `vite@8.3.3` declares its own `engines.node` as `^20.19.0 || >=22.12.0`, so a 20.x release below 20.19 fails the client build. A host that already carries Node 22.x is not enough on its own — install the 20.x line explicitly rather than relying on the host runtime.
- **No C++ toolchain, build tools or system packages.** `better-sqlite3@11.10.0` publishes a prebuilt binary for Node's ABI 115 and downloads it during install, so no compiler and no `make` is needed. SQLite runs inside the server process, so no database server, broker, VPN or container has to be started before building, testing or running the app.
- TypeScript is **not** a prerequisite: it is a development dependency, and `npm install` provides it.

## Install

```bash
npm install
```

Run it once, at the repository root. The root manifest declares the two npm workspaces, `client` and `server`, so this one command resolves both dependency sets, links the two packages and writes the committed `package-lock.json`.

## Develop

```bash
npm run dev
```

Starts both workspaces together under `concurrently`: the server through `tsx watch` on `PORT` (default 3001), and the Vite dev server for the client on its default port 5173. That dev server proxies `/api` to `http://localhost:3001`, so in development the browser reaches the API through one origin exactly as it does in production, and no client module carries a base URL or an environment switch. The proxy target is fixed at that address and reads no environment variable, so develop with `PORT` left at its default; to serve the app on another port, use the built run below.

## Build

```bash
npm run build
```

Builds both workspaces: Vite emits the client's production bundle to `client/dist`, and `tsc` compiles the server to `server/dist`.

## Start

```bash
npm start
```

Runs the compiled server, `node server/dist/index.js`, on `PORT` (default 3001). That one process serves the JSON API **and** the built client from a single origin — the five operations under `/api`, and the client's files with a fallback for every other path — so no cross-origin configuration is needed and the app is reachable at `http://localhost:3001`.

The client's build is mounted only once `client/dist` exists, so on a fresh checkout run `npm run build` before `npm start`.

## Test

```bash
npm test
```

The single documented test command. It runs `vitest run` in both workspaces and never enters watch mode. It needs **no network access**: the server's API tests drive the in-process application against a temporary or in-memory SQLite database, and the client's tests reach only mocks — a mocked HTTP layer, a faked clock and a mocked Notification API.

## Type check

```bash
npm run typecheck
```

The strict TypeScript check across both workspaces, on the option set both extend from `tsconfig.base.json`: `strict` plus `noUnusedLocals`, `noUnusedParameters`, `noImplicitOverride`, `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.

## Seed data

```bash
npm run seed --workspace server          # 1000 reminders, the default
npm run seed --workspace server -- 25    # an explicit count
```

Inserts a batch of reminders into the same database the server opens, so the list and the due check can be exercised at the 1,000-row load they are required to stay responsive at. The default batch is 1,000. The script only ever inserts: running it twice adds a second batch and leaves the first one untouched.

## Configuration

The server has exactly two settings. Both are plain environment variables, and both work with nothing configured.

| Variable | Default | Meaning |
|----------|---------|---------|
| `PORT` | `3001` | The port the server binds. The client's development proxy targets `http://localhost:3001`, this setting's default, which is why a development run and a built run reach the API at the same address; that proxy does not follow a different `PORT`. A value that is not a whole number between 1 and 65535 stops the process with a message naming the setting, rather than being silently replaced by the default. |
| `DATABASE_PATH` | unset, giving `server/data/reminders.sqlite` | The SQLite file the server opens. When the variable is unset the path is resolved by walking up from the storage module to the server package root — the nearest ancestor directory named `server` that holds a `package.json` — so the development run and the built run open the same file rather than one file each. A value that is set is used as the file path verbatim: a relative path is taken from the process's working directory, which is `server/` for the workspace scripts behind `npm start` and `npm run seed --workspace server`, and a missing containing directory is created. The database is opened in WAL journal mode, which places `reminders.sqlite-wal` and `reminders.sqlite-shm` beside it; `.gitignore` excludes the default `server/data/` directory and every `*.sqlite`, `*.sqlite-wal` and `*.sqlite-shm` file. |

No `.env` file is needed or created, the server reads none, and neither setting is a secret. This application has no accounts, no sessions, no tokens and no external service.

## API

Every operation is served under the base path `/api` by the one Express process, in JSON. There are five.

| Operation | Request body | Success | Failures |
|-----------|--------------|---------|----------|
| `POST /api/reminders` | `{ "text": string, "dueAt": string }` | **201** — the created reminder | **400** `{ error, field }` for a refused input; **500** on a storage failure |
| `GET /api/reminders` | none | **200** — an array of every reminder, ordered by `dueAt` and then by `id` | **500** on a storage failure |
| `PATCH /api/reminders/:id/complete` | none | **200** — the updated reminder, with `completed: true` | **404** `{ "error": "Reminder not found." }` for an unknown id; **500** on a storage failure |
| `PATCH /api/reminders/:id/notified` | none | **200** — the updated reminder, with `notifiedAt` set | **404** for an unknown id; **500** on a storage failure |
| `DELETE /api/reminders/:id` | none | **204** — no body | **404** for an unknown id; **500** on a storage failure |

`PATCH /api/reminders/:id/notified` records the notification claim, which is what makes a reminder notified at most once and keeps a reload from firing it again. Calling it for a reminder whose claim already stands is an accepted repeat and answers **200** with the stored reminder.

Creating a reminder. `dueAt` must be a parseable instant strictly in the future, which is why the example below uses a fixed future date rather than one already past:

```bash
curl -X POST http://localhost:3001/api/reminders \
  -H 'Content-Type: application/json' \
  -d '{"text":"Take the bins out","dueAt":"2030-01-01T09:30:00.000Z"}'
```

```json
{
  "id": "9f8b2b1a-4d2f-4c1e-8a77-5b6f0c1d2e3f",
  "text": "Take the bins out",
  "dueAt": "2030-01-01T09:30:00.000Z",
  "completed": false,
  "notifiedAt": null,
  "createdAt": "2029-12-31T18:04:11.208Z"
}
```

Every response carries all six camelCase fields — `id`, `text`, `dueAt`, `completed`, `notifiedAt`, `createdAt` — and a field with no value is sent as `null` rather than omitted. `dueAt`, `notifiedAt` and `createdAt` are absolute UTC instants in ISO-8601 form.

A create body carries **only** `text` and `dueAt`. The other four fields are derived server-side, and identity-bearing values sent in a request body — `id`, `completed`, `notifiedAt`, `createdAt` — are **ignored**, never honoured: a client-supplied `notifiedAt` could otherwise suppress a reminder's notification permanently, and a client-supplied `completed` could bypass the rule that a completed reminder is never notified.

Failures are one shape from one place — `{ "error": string, "field"?: "text" | "dueAt" }` — with `field` present only when a specific input was refused:

```json
{ "error": "Reminder text must be 280 characters or fewer.", "field": "text" }
```

| Condition | Status | `error` | `field` |
|-----------|--------|---------|---------|
| Text missing, empty or whitespace-only | 400 | `Enter a reminder text.` | `text` |
| Text longer than 280 characters after trimming | 400 | `Reminder text must be 280 characters or fewer.` | `text` |
| Due date or time missing or unparseable | 400 | `Enter a valid due date and time.` | `dueAt` |
| Due time not in the future | 400 | `The due time must be in the future.` | `dueAt` |
| Body is not valid JSON | 400 | `Request body must be valid JSON.` | *(absent)* |
| Unknown id — complete, notified or delete | 404 | `Reminder not found.` | *(absent)* |
| Storage failure | 500 | `Something went wrong. Please try again.` | *(absent)* |

## Behaviour notes

- **Times.** A reminder's due date and time are entered in the user's local time zone, converted to one absolute UTC instant on the client, and stored as that instant. Display converts the same instant back to the viewer's local zone. The server never formats a timestamp and never applies a zone; it compares `dueAt` against its own clock only to refuse a due time in the past. Because the instant is resolved once, from the local components the user typed, a daylight-saving change cannot shift a stored reminder's absolute due time.
- **The due check.** While the page is open, the client looks for due reminders once immediately on mount and then every 30 seconds, re-running when the window regains focus or the tab becomes visible. A reminder is selected when it is not completed, its `dueAt` is at or before now, and its `notifiedAt` is `null`. Each selected reminder fires exactly one in-app alert and, when browser notification permission is granted, exactly one browser notification, and the claim is then recorded on the server — so a reminder is notified at most once, across a reload and across a server restart.
- **Notification delivery is limited to an open browser page.** There is no service worker, no push subscription and no third-party notification service: a page-scoped browser notification's lifetime is the page's lifetime, and this application stops there by design. The in-app alert is the channel that always works, because the application renders it itself and it needs no permission. Reminders therefore still arrive as in-app alerts while that permission is undecided or blocked, and in a browser without the Notification API at all. Browser notification permission is requested only from a reminder-creation submit, never on page load, and only while the permission reading is still undecided; once it is blocked it is never requested again.
- **Storage.** Every reminder — and the record that it was notified — lives on the server, in the SQLite file described under Configuration. Nothing about reminders is kept in browser storage, so a reload and a server restart both leave the list exactly as it was.
- **The list.** Rows are ordered by `dueAt` and then by `id`, so two reminders sharing a due time still have one deterministic order. Each row is labelled Upcoming, Overdue or Completed, and that state is carried by the label's text rather than by colour alone.
