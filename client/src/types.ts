/**
 * The client's half of the reminder API contract.
 *
 * `client/` and `server/` are separate npm workspaces and meet only over HTTP — the client reaches
 * reminder data exclusively through `/api` — so this module is the client's own declaration of the
 * JSON the server produces and accepts. It therefore imports nothing: not from `server/`, which no
 * client file may reach, and not from any other client module.
 *
 * The contract it records, in the terms the server implements it:
 *
 * - A reminder carries the six camelCase keys `id`, `text`, `dueAt`, `completed`, `notifiedAt` and
 *   `createdAt`, and a response body always carries all six — a nullable field is sent as `null`
 *   rather than omitted.
 * - The client sends exactly two keys when it creates a reminder, `text` and `dueAt`. Identity-bearing
 *   fields (`id`, `completed`, `notifiedAt`, `createdAt`) are derived by the server and any value the
 *   client supplies for them is ignored, so they are deliberately absent from the request type.
 * - `dueAt`, `notifiedAt` and `createdAt` are opaque absolute UTC instants (ISO-8601 with a `Z`
 *   suffix). Only `client/src/lib/time.ts` converts or formats one.
 * - Every non-2xx response carries one error body of the shape declared as `ApiErrorBody`.
 */

/**
 * One reminder exactly as the server returns it.
 *
 * Every property is required. A stored reminder always has a due time and a creation instant, and
 * an unclaimed notification is reported as `null`, so no property is optional here.
 */
export interface Reminder {
  /** Server-generated identifier (`crypto.randomUUID()` on insert); never supplied by the client. */
  id: string;

  /** The reminder's text, already trimmed by the server: between 1 and 280 characters. */
  text: string;

  /** The due instant, as an absolute UTC ISO-8601 timestamp with a `Z` suffix. */
  dueAt: string;

  /** `true` once the reminder has been completed; only the complete operation sets it. */
  completed: boolean;

  /**
   * The instant at which the reminder's notification was claimed, as an absolute UTC ISO-8601
   * timestamp, or `null` while it is unclaimed.
   *
   * Exactly `string | null` and never optional: the server sends this key on every reminder it
   * returns, and under `exactOptionalPropertyTypes` an optional property would admit `undefined`,
   * which the wire shape never carries.
   */
  notifiedAt: string | null;

  /** The instant the reminder was created, as an absolute UTC ISO-8601 timestamp. */
  createdAt: string;
}

/**
 * The body of every non-2xx response from the API.
 *
 * One shape covers all of them: a rejected input (400, usually with the `field` it was attributed
 * to), an unknown identifier (404) and a storage failure (500).
 */
export interface ApiErrorBody {
  /** Human-readable message the UI renders — inline beside a field, or in the error banner. */
  error: string;

  /**
   * The input the server attributed the rejection to, or absent when the failure belongs to no
   * single field (an unknown identifier, for instance).
   *
   * The explicit `| undefined` is deliberate and must stay. `exactOptionalPropertyTypes` is on for
   * this workspace, so a bare `field?: 'text' | 'dueAt'` would allow the key to be missing but
   * forbid assigning `undefined` to it, while the HTTP wrapper in `client/src/lib/remindersApi.ts`
   * constructs this object from a parsed body whose `field` is typed `'text' | 'dueAt' | undefined`.
   * Dropping it makes that assignment fail to compile.
   */
  field?: 'text' | 'dueAt' | undefined;
}

/**
 * The only request body the client ever sends when creating a reminder.
 *
 * Exactly these two keys: the reminder's text and the absolute instant derived from the date and
 * time the user entered. Naming an identity-bearing field here would invite a caller to send a
 * value the server ignores and the contract forbids.
 */
export interface CreateReminderInput {
  /** The reminder's text; the server trims it and rejects an empty or over-long value. */
  text: string;

  /** The due instant as an absolute UTC ISO-8601 timestamp, derived in `client/src/lib/time.ts`. */
  dueAt: string;
}
