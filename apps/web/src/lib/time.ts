/** The browser's IANA timezone, which every absolute time on screen is in. */
export function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" });
const time = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const day = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
const shortDateTime = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/** "24 Nov 2026, 14:02:31": details and logs. */
export function formatDateTime(iso: string): string {
  return dateTime.format(new Date(iso));
}

const longDate = new Intl.DateTimeFormat(undefined, { dateStyle: "long" });
const mediumDate = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

/** "20 November 2026": a date in a sentence, such as when a release came out. */
export function formatLongDate(iso: string): string {
  return longDate.format(new Date(iso));
}

/** "20 Nov 2026": a date beside a value. */
export function formatDate(iso: string): string {
  return mediumDate.format(new Date(iso));
}

/** "2 Dec, 14:02": short enough for a Badge, such as when a share link expires. */
export function formatShortDateTime(iso: string): string {
  return shortDateTime.format(new Date(iso));
}

/** "14:02:31": a time within a day heading. */
export function formatTime(iso: string): string {
  return time.format(new Date(iso));
}

/** The local calendar day of a time, as a key: "2026-11-24". */
export function dayKeyOf(iso: string): string {
  const date = new Date(iso);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const dayOfMonth = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${dayOfMonth}`;
}

/** "Today", "Yesterday" or "Mon, 23 Nov 2026": a day heading. */
export function formatDay(iso: string, now: Date = new Date()): string {
  const key = dayKeyOf(iso);
  if (key === dayKeyOf(now.toISOString())) return "Today";
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (key === dayKeyOf(yesterday.toISOString())) return "Yesterday";
  return day.format(new Date(iso));
}

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

const units: readonly [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["week", 7 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
];

/** "5 minutes ago", "yesterday", "just now": recency in lists. */
export function formatRelative(iso: string, now: Date = new Date()): string {
  const seconds = Math.round((new Date(iso).getTime() - now.getTime()) / 1000);
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return relative.format(Math.trunc(seconds / size), unit);
  }
  return "just now";
}

/** A `datetime-local` input's value (local time) as an ISO 8601 instant; undefined when empty or invalid. */
export function localInputToIso(value: string): string | undefined {
  if (value === "") return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}
