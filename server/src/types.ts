/**
 * Reminder API contract types.
 *
 * This module is the server's side of the client/server contract. The two
 * workspaces are separate npm packages that may not import from one another,
 * so `client/src/types.ts` mirrors these declarations by value rather than by
 * import. The part both copies must keep identical is frozen here: the field
 * names, and the two-literal `field` union. Those names are the same in every
 * representation a reminder passes through — SQLite column names, row fields,
 * JSON response keys and client-side fields — so `dueAt` is `dueAt` in the
 * table, in the row object and in the response body. The client's copy is held
 * in step by its own tests, and the API tests assert a response body's exact
 * key set against `Reminder`.
 *
 * Every instant (`dueAt`, `notifiedAt`, `createdAt`) is an opaque absolute UTC
 * ISO-8601 string. The server never formats a timestamp, never applies a time
 * zone and never re-derives an instant: the client converts the user's local
 * date and time into the single absolute instant it sends, and this side
 * stores and returns that value unchanged.
 *
 * Type declarations only — no imports, no runtime values, no side effects.
 */

/**
 * The request-supplied fields a validation rejection can be attributed to.
 *
 * Only `text` and `dueAt` ever come from a client request, so only they can be
 * named in an error body. This is a string-literal union rather than an enum
 * on purpose: an enum emits a runtime object, whereas a type-only name stays
 * erasable and remains usable through `import type` under `isolatedModules`.
 */
export type ReminderField = 'text' | 'dueAt';

/**
 * A persisted reminder, exactly as the API returns it.
 *
 * All six fields are always present on a response object. A nullable field is
 * sent as `null` rather than omitted, so a client can tell "not yet notified"
 * apart from "field absent".
 */
export interface Reminder {
  /** Server-generated identity (`crypto.randomUUID()`); never accepted from a request body. */
  id: string;
  /** The reminder text, trimmed; between 1 and 280 characters. */
  text: string;
  /**
   * The absolute UTC instant the reminder is due, ISO-8601 with a `Z` suffix.
   * Derived on the client from the user's local date and time, stored verbatim
   * and compared against the clock only to reject a due time already in the past.
   */
  dueAt: string;
  /**
   * Whether the reminder has been completed. This is the JSON-boundary form:
   * the `INTEGER 0/1` storage form exists only in the store's row-to-object
   * mapping, and no numeric variant of this type belongs here.
   */
  completed: boolean;
  /**
   * The instant this reminder was claimed for notification, or `null` while it
   * is unclaimed. Nullable rather than optional, and written only from `null`,
   * which is what makes the notification happen at most once across reloads.
   */
  notifiedAt: string | null;
  /** The instant the row was inserted; server-derived from the injected clock. */
  createdAt: string;
}

/**
 * The only values a client may supply when creating a reminder.
 *
 * The identity-bearing fields of {@link Reminder} are server-derived, and a
 * create body that carries them has them ignored, so they are deliberately
 * absent here. Admitting them would let a client suppress a reminder's
 * notification by supplying `notifiedAt`, or bypass the completed-reminder
 * rule by supplying `completed`.
 */
export interface NewReminder {
  /** Trimmed reminder text, 1 to 280 characters. */
  text: string;
  /** Absolute UTC ISO-8601 instant, strictly after the server's current instant. */
  dueAt: string;
}

/**
 * The single body of every non-2xx API response.
 *
 * `field` is optional *and* restricted to {@link ReminderField}: with
 * `exactOptionalPropertyTypes` enabled, the property must either be absent or
 * one of the two literal field names, so `{ error: 'x', field: undefined }`
 * does not type-check. Whoever produces this body must therefore build
 * `{ error }` or `{ error, field }` conditionally rather than passing an
 * explicitly undefined value.
 */
export interface ApiErrorBody {
  /** A user-facing message; carries no reminder content, internal id or stack trace. */
  error: string;
  /** The request field the message is attributed to, when the rejection concerns one field. */
  field?: ReminderField;
}
