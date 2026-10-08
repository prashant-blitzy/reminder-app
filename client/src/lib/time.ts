/**
 * The client's single conversion between the local date and time a user types and the absolute UTC
 * instant the server stores, and the single formatter that renders a stored instant for the viewer.
 *
 * This is the only place in the client where a timestamp changes representation. Every other module
 * imports it rather than repeating any part of it: the create form (which turns the typed date and
 * time into the `dueAt` it sends), the reminder row (which renders a stored instant), the due check
 * (which compares stored instants against the current instant) and the client validation copy.
 * A second conversion anywhere else is a defect.
 *
 * Why this arrangement is the daylight-saving-correct one: the typed year, month, day, hour and
 * minute are resolved ONCE, by the platform, through the local `Date` constructor, using the UTC
 * offset in force at that instant. The result is an absolute instant, so a later zone change — or a
 * daylight-saving transition — cannot shift a stored reminder's due time; it only changes how that
 * instant is displayed, which is the required behaviour ("stored in UTC, displayed in the user's
 * local time zone"). Building the instant from a formatted string, appending a `Z`, or subtracting
 * an offset by hand would all break that guarantee, so none of them is done here.
 *
 * The module deliberately has no imports: no runtime dependency, no type-only package, and no
 * module from the other workspace (the client and the server meet over HTTP only).
 */

/**
 * An exact `YYYY-MM-DD` date, anchored so a longer string (a full ISO timestamp, for example)
 * cannot match by prefix.
 */
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * An exact `HH:mm` or `HH:mm:ss` time. The seconds group is optional and, when present, is range
 * checked only: the stored instant is resolved at the minute the user chose.
 */
const TIME_PATTERN = /^(\d{2}):(\d{2})(?::(\d{2}))?$/;

/**
 * Turns the local date and time the user typed into the absolute UTC instant that is sent to the
 * server as `dueAt`.
 *
 * The value is built from local components through the `Date` constructor, never parsed from a
 * string, so the offset applied is the one in force at that instant in the viewer's zone.
 *
 * @param date A local calendar date in `YYYY-MM-DD` form.
 * @param time A local wall-clock time in `HH:mm` or `HH:mm:ss` form.
 * @returns The absolute instant as an ISO-8601 UTC string (with a `Z` suffix), or `null` when the
 *   input is malformed, a component is out of range, or the constructed date rolled over into
 *   another day. It never throws and never fabricates an instant.
 */
export function toDueAtIso(date: string, time: string): string | null {
  const dateMatch = DATE_PATTERN.exec(date);
  if (dateMatch === null) {
    return null;
  }

  const yearGroup = dateMatch[1];
  const monthGroup = dateMatch[2];
  const dayGroup = dateMatch[3];
  if (yearGroup === undefined || monthGroup === undefined || dayGroup === undefined) {
    return null;
  }

  const timeMatch = TIME_PATTERN.exec(time);
  if (timeMatch === null) {
    return null;
  }

  const hourGroup = timeMatch[1];
  const minuteGroup = timeMatch[2];
  const secondGroup = timeMatch[3];
  if (hourGroup === undefined || minuteGroup === undefined) {
    return null;
  }

  const year = Number(yearGroup);
  const month = Number(monthGroup);
  const day = Number(dayGroup);
  const hour = Number(hourGroup);
  const minute = Number(minuteGroup);
  const second = secondGroup === undefined ? 0 : Number(secondGroup);

  if (month < 1 || month > 12) {
    return null;
  }
  if (day < 1 || day > 31) {
    return null;
  }
  if (hour < 0 || hour > 23) {
    return null;
  }
  if (minute < 0 || minute > 59) {
    return null;
  }
  if (second < 0 || second > 59) {
    return null;
  }

  const constructed = new Date(year, month - 1, day, hour, minute);

  if (Number.isNaN(constructed.getTime())) {
    return null;
  }

  // Rollover check. `new Date` silently normalises impossible components — an out-of-range day
  // becomes a day of the following month, a two-digit year becomes 19xx, and a local time that
  // does not exist on a spring-forward day shifts forward by an hour — so the constructed
  // instant's own local components are compared back against what the user typed. Any mismatch
  // means the requested local time is not a real local time, and nothing is returned for it.
  if (
    constructed.getFullYear() !== year ||
    constructed.getMonth() !== month - 1 ||
    constructed.getDate() !== day ||
    constructed.getHours() !== hour ||
    constructed.getMinutes() !== minute
  ) {
    return null;
  }

  return constructed.toISOString();
}

/**
 * Renders a stored absolute instant as local date and time text for the viewer's zone.
 *
 * The formatter is constructed per call and deliberately names no `timeZone`, so the runtime's zone
 * is read at the moment of formatting. A formatter cached at module scope would capture the zone
 * when the module is first evaluated and go stale the moment that zone changes.
 *
 * @param iso An absolute instant as stored by the server (ISO-8601, UTC).
 * @returns Display text for the viewer's zone and locale; the input unchanged when it holds no
 *   instant the platform can read, so a malformed value stays visible instead of breaking a render.
 */
export function formatLocalDueAt(iso: string): string {
  const instant = Date.parse(iso);
  if (Number.isNaN(instant)) {
    return iso;
  }

  const formatter = new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  return formatter.format(new Date(instant));
}
