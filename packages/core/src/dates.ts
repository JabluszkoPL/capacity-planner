/**
 * Date utilities used across the app. All functions treat dates as local
 * calendar days (no timezone math) and ISO strings as "YYYY-MM-DD".
 *
 * Ported from the POC's date helpers. Nearly every later task depends on these.
 */

function pad(n: number): string {
  return n < 10 ? "0" + n : "" + n;
}

/** Serialize a Date to a "YYYY-MM-DD" local-calendar string. */
export function toISO(d: Date): string {
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
}

/** Parse a "YYYY-MM-DD" string into a local Date at midnight. */
export function fromISO(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/** Return a new Date n days after d (n may be negative). Does not mutate d. */
export function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

/** True for Saturday and Sunday. */
export function isWeekend(d: Date): boolean {
  const g = d.getDay();
  return g === 0 || g === 6;
}

/** Monday-based start of the week containing d, at midnight. Does not mutate d. */
export function startOfWeek(d: Date): Date {
  const r = new Date(d);
  const day = r.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  r.setDate(r.getDate() + diff);
  r.setHours(0, 0, 0, 0);
  return r;
}

/** Whole-day difference b - a (integer, rounded). */
export function diffDays(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

/** Today's date as a "YYYY-MM-DD" string (local time). */
export function todayISO(): string {
  const t = new Date();
  t.setHours(0, 0, 0, 0);
  return toISO(t);
}
