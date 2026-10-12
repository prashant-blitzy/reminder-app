/**
 * The client's single HTTP caller: every reminder request the application makes goes through
 * `remindersApi`, and every failure the application renders is an `ApiError` this module threw.
 *
 * Two boundaries are fixed here (they are project decisions rather than conventions, so they are
 * stated once, in this header, and every consumer relies on them):
 *
 * - This is the ONLY module under `client/src` that performs HTTP. Hooks and components call the
 *   five operations below and read a typed error from them; none of them calls `fetch`, and none of
 *   them inspects a status code. A second network call anywhere else in the client is a defect.
 * - This is the ONLY place a non-2xx response becomes a typed error. A refused connection, a body
 *   the client cannot read and an input the server refused all leave this module as an `ApiError`,
 *   so no component has to defend itself against a raw `TypeError: Failed to fetch` or a
 *   `SyntaxError` thrown by `response.json()`. The UI renders `error.message` and attributes the
 *   message by `error.field`.
 *
 * Why both boundaries have to live in one module: the client and the server are separate npm
 * workspaces that meet only over HTTP, so this file is the client's only knowledge of the wire
 * contract. Spreading a `fetch` call or a status-code check across a component would put that
 * knowledge in a second place, where it would drift from the server and from the error rendering.
 *
 * The contract implemented here, exactly as the server implements it:
 *
 * | Operation                            | Success | Result                            |
 * |--------------------------------------|---------|-----------------------------------|
 * | `POST /api/reminders`                | 201     | the created reminder              |
 * | `GET /api/reminders`                 | 200     | every reminder, in server order   |
 * | `PATCH /api/reminders/:id/complete`  | 200     | the updated reminder              |
 * | `PATCH /api/reminders/:id/notified`  | 200     | the updated reminder              |
 * | `DELETE /api/reminders/:id`          | 204     | nothing (resolves `void`)         |
 *
 * A failure is 400 (the input was refused), 404 (`Reminder not found.` for an unknown id) or 500
 * (the store failed), and in every case it carries the body declared as `ApiErrorBody` in
 * `../types`: `{ error: string, field?: 'text' | 'dueAt' }`.
 *
 * Four things this module deliberately does NOT do, each for a reason that outlives the code:
 *
 * - It carries no base URL and no environment switch. All five paths are relative (`/api/...`), so
 *   the Vite development server proxies them to the Express process and the built application
 *   reaches the same process on its own origin. A hard-coded host would break one of those two runs,
 *   which is why the paths are written out literally below and nothing else in the client holds a
 *   host either.
 * - It never sends a value the server derives. A create request carries exactly the two keys of
 *   `CreateReminderInput`, `text` and `dueAt`; `id`, `completed`, `notifiedAt` and `createdAt` are
 *   never sent, and a client-supplied `notifiedAt` would let the page suppress a reminder's
 *   notification permanently.
 * - It reads no clock. Time enters the application through the user's input (`./time` converts it)
 *   and the current instant is supplied by the caller wherever it is needed; a request needs no
 *   timestamp of its own, and the server stamps everything it stores.
 * - It logs nothing. A log line here would be the one place a reminder's text or id could leave the
 *   application, so no failure path writes to the console, and no thrown error carries reminder
 *   content: an `ApiError` carries the server's message, a status and at most a field name.
 *
 * Nothing here sorts, filters, pages or caches either. The server returns the list already ordered
 * by `dueAt ASC, id ASC`, and the client renders it in that order, so a second ordering rule in this
 * module could only disagree with the first. Nothing is written to browser storage: the reminder is
 * the server's data, and this module is a transport for it.
 */

import type { ApiErrorBody, CreateReminderInput, Reminder } from '../types';
import { VALIDATION_MESSAGES } from './validation';

/**
 * The request inputs a rejection can be attributed to: the values of `ApiErrorBody['field']`.
 *
 * Taken from the declared error body rather than written out again, so this module and `../types`
 * cannot drift apart. `NonNullable` is what removes the `undefined` of the optional property, which
 * is re-added explicitly on `ApiError.field` below.
 */
type ErrorField = NonNullable<ApiErrorBody['field']>;

/**
 * The collection's path, relative on purpose.
 *
 * Every operation below is built from it, so the mount point appears once in this file. It is the
 * path the server mounts its reminder router on, and the path the development proxy forwards.
 */
const API_PATH = '/api/reminders';

/**
 * The media type of every request body this module sends.
 *
 * The server parses request bodies with `express.json()`, which reads a body only when the request
 * declares this type, so the two requests that carry a body set it and the two that carry none
 * (the list and the delete) do not.
 */
const JSON_CONTENT_TYPE = 'application/json';

/**
 * The status an `ApiError` carries when the request never reached the server.
 *
 * A rejected `fetch` — offline, a refused connection, an aborted request, DNS — has no HTTP status
 * to report, and `0` is not a status any server can send, so a caller can tell "the server said no"
 * from "the server was never reached" without parsing the message.
 */
const NO_RESPONSE_STATUS = 0;

/**
 * Every failure this module can produce, as one recognisable type.
 *
 * A caller catches this rather than inspecting a response, which is what keeps status-code handling
 * out of the components: they read `message` (already the wording to show the user), `field` (the
 * input to attribute the message to, when the server named one) and, where it matters, `status`.
 *
 * `status` is the HTTP status of the response that failed, or `NO_RESPONSE_STATUS` when the request
 * never reached the server. `field` carries the server's own value and nothing else: the name it
 * attributed the failure to when it named one, and `undefined` when it named none — never `null`,
 * and never a field name this module invented.
 *
 * The instance carries nothing else on purpose. There is no response object, no request body, no
 * status text and no reminder content on it, so a failure cannot leak reminder text into a log, a
 * stack trace or a rendered message.
 */
export class ApiError extends Error {
  /** The HTTP status that failed, or `0` when no response was received. */
  readonly status: number;

  /**
   * The input the server attributed the rejection to, or `undefined` when it named none.
   *
   * The explicit `| undefined` is required rather than stylistic: `exactOptionalPropertyTypes` is on
   * for this workspace, so a bare `field?: ErrorField` would admit a missing key but forbid the
   * `undefined` that a body without a `field` produces when it is read.
   */
  readonly field?: ErrorField | undefined;

  /**
   * @param message The wording to show the user: the server's message, or the generic fallback.
   * @param status The failed HTTP status, or `NO_RESPONSE_STATUS` when nothing was reached.
   * @param field The input the server attributed the failure to, when it named one.
   */
  constructor(message: string, status: number, field?: ErrorField | undefined) {
    super(message);

    // Set explicitly so a caught error is recognisable as this type even where the class name is
    // lost to minification, and so `error.name` reads 'ApiError' rather than 'Error'.
    this.name = 'ApiError';
    this.status = status;
    this.field = field;
  }
}

/**
 * The client's whole view of the reminder API: the five operations the application performs, and
 * nothing else.
 *
 * Typed as an interface so the five operations are declared once, in the order the contract lists
 * them, and the exported value is checked against them rather than defining them by its own shape.
 */
export interface RemindersApi {
  /** Reads every reminder, in the order the server returns them (`dueAt ASC, id ASC`). */
  list(): Promise<Reminder[]>;

  /** Creates one reminder from the text and the absolute due instant the client derived. */
  create(input: CreateReminderInput): Promise<Reminder>;

  /** Marks one reminder complete and resolves the updated reminder. */
  complete(id: string): Promise<Reminder>;

  /**
   * Records that a reminder's notification has been claimed and resolves the updated reminder.
   *
   * The operation the at-most-once guarantee rests on: the server writes `notifiedAt` only from
   * `NULL` and only once, so a later claim cannot overwrite the first and a reloaded page finds the
   * claim already recorded. The client's part is to call this, after the notification has been
   * shown, and to treat a failure as a reportable error rather than a reason to retry.
   */
  markNotified(id: string): Promise<Reminder>;

  /**
   * Deletes one reminder, in either completion state, and resolves nothing.
   *
   * Named `remove` rather than `delete` because `delete` is a reserved word: it cannot be used as a
   * binding name (`const { delete } = api` is a syntax error) and cannot be reached as an identifier
   * on a destructured value, so the legal identifier is part of the contract rather than a matter of
   * taste.
   */
  remove(id: string): Promise<void>;
}

/**
 * Builds the path of one reminder.
 *
 * The id is percent-encoded, so an identifier that is not URL-safe cannot alter the path or the
 * operation it addresses. The value in the store is a server-generated UUID today, and encoding it
 * is what keeps that from being load-bearing.
 *
 * @param id The reminder's identifier, as returned by the server.
 * @returns The reminder's path, relative to the document origin.
 */
function reminderPath(id: string): string {
  return `${API_PATH}/${encodeURIComponent(id)}`;
}

/**
 * Builds the request for an operation that carries a JSON body.
 *
 * The headers object and the serialised body are both built fresh per call rather than shared, so
 * one request can never be affected by another and a caller is never handed a mutable request it
 * could add a field to.
 *
 * @param method The HTTP method of the operation, always `POST` or `PATCH` here.
 * @param body The body to serialise, which is the only value the request will carry.
 * @returns The request init for `fetch`.
 */
function jsonRequestInit(method: 'POST' | 'PATCH', body: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': JSON_CONTENT_TYPE },
    body: JSON.stringify(body),
  };
}

/**
 * Performs the one network call this module makes.
 *
 * Every operation below funnels through here, which is what makes "one `fetch` in the client" true
 * by construction rather than by review: there is exactly one call site, and everything a caller
 * needs to know about it — relative path, request init, typed failure — is decided here.
 *
 * The cause of a rejected `fetch` is deliberately not carried into the message. It names no
 * reminder, it is not something the user can act on, and the failure the UI must render is the same
 * whatever the cause, so the message is the generic one and the status is `NO_RESPONSE_STATUS`.
 *
 * @param path The request path, relative to the document origin.
 * @param init The request method, headers and body.
 * @returns The response, whatever its status. A non-2xx response is not a rejection here; the
 *   callers below turn it into an `ApiError`, because only they know what a success looks like.
 * @throws {ApiError} With `NO_RESPONSE_STATUS` and the generic message when the request never
 *   reached the server: offline, an unreachable host, an aborted request, or no `fetch` at all.
 */
async function send(path: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(path, init);
  } catch {
    throw new ApiError(VALIDATION_MESSAGES.GENERIC_ERROR, NO_RESPONSE_STATUS);
  }
}

/**
 * Reads a successful response's body as the given shape.
 *
 * A success whose body cannot be read is still a failure the user has to be told about, so it
 * becomes an `ApiError` rather than letting a `SyntaxError` reach a component. The status carried is
 * the response's own, so the failure is reported against the request that produced it.
 *
 * @param response A response whose status is already known to be successful.
 * @returns The parsed body, typed as the caller declares it.
 * @throws {ApiError} With the generic message when the body is not readable JSON.
 */
async function readJson<T>(response: Response): Promise<T> {
  try {
    return (await response.json()) as T;
  } catch {
    throw new ApiError(VALIDATION_MESSAGES.GENERIC_ERROR, response.status);
  }
}

/**
 * Turns a failed response into the typed error the UI renders.
 *
 * The server's own message is preferred to anything this module could invent, because the server is
 * the authority on why a request was refused and `client/src/lib/validation.ts` already carries its
 * wordings. The generic message stands in only when the body is unreadable or holds no usable
 * message — an empty string counts as no message, so the UI can never render a blank error.
 *
 * A `field` is carried across only when the server named one of the two inputs this client has; any
 * other value is dropped rather than passed on as a field name no control can render.
 *
 * @param response A response with a non-2xx status.
 * @returns The `ApiError` to throw: the server's message and field when they are usable, the generic
 *   message otherwise, and always the response's status.
 */
async function toApiError(response: Response): Promise<ApiError> {
  const { status } = response;

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return new ApiError(VALIDATION_MESSAGES.GENERIC_ERROR, status);
  }

  // A body that is not an object — a bare string, a number, `null` — holds no message and no field.
  if (typeof parsed !== 'object' || parsed === null) {
    return new ApiError(VALIDATION_MESSAGES.GENERIC_ERROR, status);
  }

  // Read through the declared error body, partially: a failure body may carry neither the message
  // nor the field this client understands, and both are checked before either is used.
  const body: Partial<ApiErrorBody> = parsed;

  const message =
    typeof body.error === 'string' && body.error.trim().length > 0
      ? body.error
      : VALIDATION_MESSAGES.GENERIC_ERROR;

  const field: ErrorField | undefined =
    body.field === 'text' || body.field === 'dueAt' ? body.field : undefined;

  return new ApiError(message, status, field);
}

/**
 * Performs a request whose success carries a JSON body, and reads it.
 *
 * @param path The request path, relative to the document origin.
 * @param init The request method, headers and body.
 * @returns The parsed body, typed as the caller declares it.
 * @throws {ApiError} For a non-2xx response, an unreadable success body, or a request that never
 *   reached the server.
 */
async function requestJson<T>(path: string, init: RequestInit): Promise<T> {
  const response = await send(path, init);

  if (!response.ok) {
    throw await toApiError(response);
  }

  return readJson<T>(response);
}

/**
 * Performs a request whose success carries no body.
 *
 * The successful response is deliberately not read: a DELETE answers 204 with no content, and
 * reading it would turn a correct response into a parse failure. The failed response still is read,
 * through the same helper the other operations use, so a refused delete is reported exactly as a
 * refused create is.
 *
 * @param path The request path, relative to the document origin.
 * @param init The request method, headers and body.
 * @throws {ApiError} For a non-2xx response, or a request that never reached the server.
 */
async function requestVoid(path: string, init: RequestInit): Promise<void> {
  const response = await send(path, init);

  if (!response.ok) {
    throw await toApiError(response);
  }
}

/**
 * The client's HTTP caller, and the only value the rest of the client imports.
 *
 * Each member is a thin statement of one operation's contract: its method, its path and the shape
 * the caller gets back. All five return the server's own result — the created reminder, the updated
 * reminder, the list as ordered, nothing for a delete — so a caller never has to reconstruct what
 * the server did, and never has to re-read the list to learn it.
 */
export const remindersApi: RemindersApi = {
  list(): Promise<Reminder[]> {
    // No body, no content type: a GET has neither, and the array arrives already ordered.
    return requestJson<Reminder[]>(API_PATH, { method: 'GET' });
  },

  create(input: CreateReminderInput): Promise<Reminder> {
    // The request body is rebuilt from the two fields by name rather than sent as the argument
    // itself, so the key set that leaves the client is exactly `text` and `dueAt` whatever the
    // caller passed. The server ignores any other field it is sent, and this is the side that
    // guarantees it is not sent one.
    const body: CreateReminderInput = { text: input.text, dueAt: input.dueAt };

    return requestJson<Reminder>(API_PATH, jsonRequestInit('POST', body));
  },

  complete(id: string): Promise<Reminder> {
    // An empty JSON object rather than no body at all: the operation is a `PATCH`, and sending a
    // body keeps the request shaped the same way as the claim below it. Neither carries a value —
    // completion is the server's to set, and this request cannot pre-empt it.
    return requestJson<Reminder>(`${reminderPath(id)}/complete`, jsonRequestInit('PATCH', {}));
  },

  markNotified(id: string): Promise<Reminder> {
    // The claim, sent with an empty body: the instant recorded is the server's to choose, and a
    // client that could send one could back-date or suppress it.
    return requestJson<Reminder>(`${reminderPath(id)}/notified`, jsonRequestInit('PATCH', {}));
  },

  remove(id: string): Promise<void> {
    // The success carries no body, so none is read. The failed response is read and typed exactly
    // as the others', which is how a delete of an already-deleted reminder reaches the list's own
    // error banner rather than surfacing as an unhandled rejection.
    return requestVoid(reminderPath(id), { method: 'DELETE' });
  },
};
