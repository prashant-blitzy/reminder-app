/**
 * The single producer of a failure response for the reminder API.
 *
 * Every non-2xx response body this server sends is built here, so the client can
 * render one shape wherever it shows a failure: `{ error: string, field?: 'text'
 * | 'dueAt' }`. No route, store or validator writes an error body of its own; a
 * handler that wants a particular status raises the typed error this module
 * understands and lets Express forward it, and the JSON body parser's own parse
 * failure is recognised structurally rather than by wording.
 *
 * Raising a failure, as the reminder routes do:
 *
 *     throw badRequest('Enter a reminder text.', 'text'); // 400, attributed to a field
 *     throw notFound();                                   // 404, no field
 *     throw new HttpError(409, 'Conflict.');              // any other refusal
 *
 * Exactly three outcomes exist, and nothing else in this file:
 *
 *   - 400 — an input this API refuses, including a request body that is not
 *     valid JSON (thrown by `express.json()` before any route runs);
 *   - 404 — an id that names no reminder;
 *   - 500 — every unexpected failure, a storage failure included.
 *
 * Two of its properties are deliberate and load-bearing:
 *
 *   - Nothing is logged. This server keeps no audit trail and writes to no log
 *     sink, so nothing here touches `console`, a file or a service.
 *   - Nothing taken from a caught error reaches the response. A parse error's
 *     message embeds a snippet of the raw request body and its `body` property
 *     holds that body in full, and a driver error can carry SQLite text and a
 *     filesystem path; echoing either would leak request content or internal
 *     detail to the caller. Only the fixed, user-facing literals below are sent.
 *
 * The status codes, the body shape and the literals are this module's contract
 * with the client, which renders `{ error, field? }` in the inline message of a
 * form field or in its error banner, so the messages here are fixed strings.
 * The validation messages themselves (`Enter a reminder text.` and its
 * siblings) are deliberately absent: they belong to the module that decides a
 * rejection, and this file only transports the message and field it carries.
 */

import type { NextFunction, Request, Response } from 'express';

import type { ApiErrorBody, ReminderField } from '../types';

/** Sent for a body the JSON parser could not read. Fixed, so it never echoes the body. */
const INVALID_JSON_MESSAGE = 'Request body must be valid JSON.';

/** Sent for an id that names no reminder; the single definition of this wording. */
const NOT_FOUND_MESSAGE = 'Reminder not found.';

/** Sent for every unexpected failure, so no internal detail can escape through it. */
const UNEXPECTED_FAILURE_MESSAGE = 'Something went wrong. Please try again.';

/**
 * A failure that carries the status the API should answer with.
 *
 * The class exists so a handler can state a refusal in the vocabulary of the
 * API — "this input is invalid", "this id is unknown" — without also deciding a
 * status number or writing a response body itself. It carries a status, an
 * optional field and a user-facing message, and nothing else: no cause, no
 * stack of its own and no request context, because none of that may be sent.
 */
export class HttpError extends Error {
  /** The HTTP status this failure answers with. */
  readonly status: number;

  /**
   * The request field the message is attributed to, when the refusal concerns a
   * single field. Absent rather than `undefined` when the refusal concerns the
   * request as a whole: the response body type allows either an absent `field`
   * or one of the two field names, never an explicit `undefined`.
   *
   * Declared `declare` so the compiler emits no field definition for it. A plain
   * optional property would be defined as `undefined` on every instance, which
   * is the explicit-undefined state this property is meant never to take: the
   * assignment below is what creates it, and only when a field was supplied.
   */
  declare readonly field?: ReminderField;

  /**
   * @param status  the HTTP status to answer with
   * @param message the user-facing message to send verbatim
   * @param field   the request field the message concerns, when there is one
   */
  constructor(status: number, message: string, field?: ReminderField) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    // Assigned only when supplied, so the property stays absent otherwise: the
    // response body type admits an absent `field`, not an undefined one.
    if (field !== undefined) {
      this.field = field;
    }
  }
}

/**
 * Build the error a handler raises to refuse an input, attributing it to the
 * request field it concerns when the refusal is about one field.
 *
 * The message is sent to the client verbatim, so it must be a message meant for
 * a person and must carry no reminder content, id, path or SQL.
 */
export function badRequest(message: string, field?: ReminderField): HttpError {
  return new HttpError(400, message, field);
}

/**
 * Build the error a handler raises for an id that names no reminder.
 *
 * Every operation that takes an id — complete, notified and delete — reports an
 * unknown one through this single definition, so the 404 body is one wording.
 */
export function notFound(): HttpError {
  return new HttpError(404, NOT_FOUND_MESSAGE);
}

/**
 * Express error middleware: the one place a failure becomes a status and a body.
 *
 * Mounted last in the chain, after the JSON parser, the API router and the
 * static client build, so every failure they forward arrives here. The four
 * declared parameters are required: Express recognises error middleware by
 * arity, and with three parameters this would silently become an ordinary
 * middleware and no failure would ever be formatted. The two unused parameters
 * keep their positions and carry a leading underscore.
 */
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof HttpError) {
    // A refusal a handler stated: its own status and message, with `field`
    // present only when the refusal was attributed to one request field. The
    // body is built conditionally because an explicit `field: undefined` is not
    // assignable to the response body type.
    const body: ApiErrorBody =
      err.field === undefined
        ? { error: err.message }
        : { error: err.message, field: err.field };

    res.status(err.status).json(body);
    return;
  }

  if (
    // Either structural signal marks the JSON parser's refusal: the tag the
    // parser puts on the error it creates, or a SyntaxError that carries the raw
    // request body it could not read. Neither the message text, which is
    // localised and varies by parser version, nor a status check is involved.
    (err as { type?: unknown } | null)?.type === 'entity.parse.failed' ||
    (err instanceof SyntaxError && 'body' in err)
  ) {
    // A malformed body concerns the request as a whole, so no `field` is
    // attributed to it, and the fixed literal is the whole response: neither the
    // parse error's message nor its `body` property may be sent, because both
    // carry the raw request content.
    const body: ApiErrorBody = { error: INVALID_JSON_MESSAGE };
    res.status(400).json(body);
    return;
  }

  // Everything else: a storage failure, a bug, a value no other branch
  // recognises. The generic literal is the whole response — an error message, a
  // stack, a driver string or a path must not reach the caller.
  const body: ApiErrorBody = { error: UNEXPECTED_FAILURE_MESSAGE };
  res.status(500).json(body);
}
