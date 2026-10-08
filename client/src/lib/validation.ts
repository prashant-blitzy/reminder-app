/**
 * The client's copy of the reminder input rules and their messages.
 *
 * This module exists so the create form can report a rejection inline, before any request is sent,
 * while the user is still looking at the field they need to fix. It is the client half of a
 * deliberately duplicated pair: the server workspace's validation module is the authority — its
 * wording is what the user actually reads when the server refuses a request — and this module
 * carries the same rules and the same literal messages for the pre-flight check.
 *
 * The duplication is sanctioned rather than a defect to repair. The project fixes two top-level
 * workspaces, `client/` and `server/`, with strict type checking in both, and the workspaces meet
 * only over HTTP: no client file may import from `server/`, and a third shared workspace would need
 * its own build step or a TypeScript project-reference arrangement inside the server's emitting
 * build — more machinery than a thirty-line rule set justifies. The two copies are therefore held in
 * step rather than trusted to stay in step: this module's test and the server's validation test
 * assert the same literal strings, so a change made to one copy alone fails the other's test.
 *
 * Three cross-cutting decisions shape what is written here:
 *
 * - Only `text` and `dueAt` are accepted from the client. `id`, `completed`, `notifiedAt` and
 *   `createdAt` are derived by the server, so this module's success value assembles exactly those
 *   two keys and the form never builds a request body of its own.
 * - The current instant is a parameter (`nowIso`), never read here: this module carries no clock
 *   read of its own, which is what makes the past-due rule testable against a pinned clock and keeps
 *   one time source in the client.
 * - The local-to-UTC conversion lives in `./time` and nowhere else. This module calls it; it never
 *   repeats any part of it.
 *
 * `validateReminderInput` is pure, total and side-effect free: it performs no fetch, touches no DOM,
 * reads no clock, mutates nothing and never throws.
 */

import type { CreateReminderInput } from '../types';
import { toDueAtIso } from './time';

/**
 * The longest reminder text the API accepts, after trimming.
 *
 * The single declaration of the bound: the form's live character counter compares against this
 * constant, this module enforces it, and the server refuses the same value with a `CHECK` constraint
 * on the table. A text of exactly this length is accepted; one character more is refused.
 */
export const MAX_TEXT_LENGTH = 280;

/**
 * Every message the reminder UI can show, character for character as the tests assert them.
 *
 * The first four are this module's own rejections, produced while validating the create form. The
 * last three are the server's wordings, which the client displays rather than produces: they live
 * here so `remindersApi.ts` has the fallback for a failure body it cannot read, and so
 * `validation.test.ts` can assert them against the server's test.
 *
 * Do not reword, re-punctuate, re-space or re-case any of them, and reference them by key —
 * consumers use `VALIDATION_MESSAGES.TEXT_REQUIRED` and `VALIDATION_MESSAGES.GENERIC_ERROR`, never a
 * literal of their own.
 */
export const VALIDATION_MESSAGES = {
  /** The text field is empty, or holds nothing but whitespace. */
  TEXT_REQUIRED: 'Enter a reminder text.',

  /** The trimmed text is longer than `MAX_TEXT_LENGTH`. */
  TEXT_TOO_LONG: 'Reminder text must be 280 characters or fewer.',

  /** The date and/or time is missing, incomplete or does not name a real local instant. */
  DUE_AT_INVALID: 'Enter a valid due date and time.',

  /** The due instant is not strictly in the future. */
  DUE_AT_IN_PAST: 'The due time must be in the future.',

  /** Server wording, displayed by the client: the request body was not valid JSON. */
  BODY_INVALID_JSON: 'Request body must be valid JSON.',

  /** Server wording, displayed by the client: no reminder exists with the given identifier. */
  NOT_FOUND: 'Reminder not found.',

  /**
   * Server wording, displayed by the client: the failure carried no readable message, so the
   * generic wording stands in for it.
   */
  GENERIC_ERROR: 'Something went wrong. Please try again.',
} as const;

/**
 * The create form's raw input, exactly as the user left it: the text they typed and the two
 * platform-picker strings for the due date and time.
 *
 * Both dates and times are held as the plain strings the pickers produce (`YYYY-MM-DD` and `HH:mm`),
 * never as a `Date` or an instant, because the user's own zone and locale govern what they typed and
 * `./time` is the only place that turns the pair into an instant.
 */
export interface ReminderFormValues {
  /** The reminder's text, untrimmed: this module trims it before measuring or accepting it. */
  text: string;

  /** The local calendar date the user picked, in `YYYY-MM-DD` form. */
  date: string;

  /** The local wall-clock time the user picked, in `HH:mm` form. */
  time: string;
}

/**
 * One rejection, attributed to the input that caused it.
 *
 * The `field` names the form control the message belongs under, so the form renders the message
 * inline and focuses the control the user must correct; it is the same vocabulary the server uses
 * in its error body.
 */
export interface ValidationFailure {
  /** The input that was refused. */
  field: 'text' | 'dueAt';

  /** The message to show beside that input, taken from `VALIDATION_MESSAGES`. */
  message: string;
}

/**
 * The outcome of validating a create-form submission: either the normalised request body, or the
 * single rejection that stopped it. Modelling both outcomes in the type is what lets a caller
 * handle a refusal without an exception and without a second check.
 */
export type ValidationResult =
  | { ok: true; input: CreateReminderInput }
  | { ok: false; failure: ValidationFailure };

/**
 * Validates a create-form submission and, when it passes, produces the request body to send.
 *
 * The rules run in a fixed order so the message a user sees is the first thing wrong with their
 * input rather than an arbitrary one: missing text is reported before an over-long text, and an
 * unusable date and time is reported before a due instant in the past (which cannot be judged until
 * the pair resolves to an instant).
 *
 * 1. The text is trimmed. An empty trimmed form — an empty string and whitespace-only text alike —
 *    is refused as `TEXT_REQUIRED`.
 * 2. A trimmed text longer than `MAX_TEXT_LENGTH` is refused as `TEXT_TOO_LONG`. The trimmed form is
 *    measured, so surrounding whitespace never counts against the user.
 * 3. The date and time are resolved to an absolute instant in `./time`. A `null` — a missing,
 *    malformed or impossible local date and time — is refused as `DUE_AT_INVALID`.
 * 4. An instant at or before `nowIso` is refused as `DUE_AT_IN_PAST`. A strictly future instant is
 *    required, so an instant equal to now is refused.
 * 5. Otherwise the trimmed text and the resolved instant are returned as the request body.
 *
 * @param values The form's raw input: the typed text and the picked date and time.
 * @param nowIso The current instant as an absolute UTC ISO-8601 string, supplied by the caller so
 *   this function stays pure and testable against a pinned clock.
 * @returns `{ ok: true, input }` with exactly the two request keys, or `{ ok: false, failure }` with
 *   the field and message to show. Never throws.
 */
export function validateReminderInput(
  values: ReminderFormValues,
  nowIso: string,
): ValidationResult {
  // Rule 1 — trim once, then work with the trimmed form throughout. Trimming before both the
  // emptiness check and the length check is what makes whitespace-only text count as missing and
  // keeps surrounding whitespace out of the character count.
  const trimmedText = values.text.trim();

  if (trimmedText.length === 0) {
    const failure: ValidationFailure = {
      field: 'text',
      message: VALIDATION_MESSAGES.TEXT_REQUIRED,
    };
    return { ok: false, failure };
  }

  // Rule 2 — the bound is inclusive: exactly `MAX_TEXT_LENGTH` characters is accepted.
  if (trimmedText.length > MAX_TEXT_LENGTH) {
    const failure: ValidationFailure = {
      field: 'text',
      message: VALIDATION_MESSAGES.TEXT_TOO_LONG,
    };
    return { ok: false, failure };
  }

  // Rule 3 — the one conversion, taken from `./time`. An unusable date and time yields no instant,
  // which is a refusal of the due-time input rather than of the text.
  const dueAt = toDueAtIso(values.date, values.time);

  if (dueAt === null) {
    const failure: ValidationFailure = {
      field: 'dueAt',
      message: VALIDATION_MESSAGES.DUE_AT_INVALID,
    };
    return { ok: false, failure };
  }

  // Rule 4 — numeric comparison of the two instants, so an instant equal to the current one is not
  // "in the future" and is refused. Both sides are absolute instants by this point, so the
  // comparison is independent of any zone.
  if (Date.parse(dueAt) <= Date.parse(nowIso)) {
    const failure: ValidationFailure = {
      field: 'dueAt',
      message: VALIDATION_MESSAGES.DUE_AT_IN_PAST,
    };
    return { ok: false, failure };
  }

  // Rule 5 — the request body, typed so its shape is checked where it is built: exactly `text` and
  // `dueAt`, the trimmed text (which is what the server stores and returns) and the resolved
  // instant unmodified.
  const input: CreateReminderInput = { text: trimmedText, dueAt };

  return { ok: true, input };
}
