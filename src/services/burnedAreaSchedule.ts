/**
 * Which months the burned-area job may ask NASA for. Pure date arithmetic,
 * kept out of the job so it can be unit-tested without a database.
 */

/** Do not even ask CMR before the month has been over this long. */
export const EARLIEST_PUBLISH_DAYS = 30;

export function firstOfMonthUTC(year: number, monthIndex: number): Date {
  return new Date(Date.UTC(year, monthIndex, 1));
}

export function lastDayOfMonthUTC(month: Date): Date {
  return new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0));
}

export function addDaysUTC(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86_400_000);
}

/** Parses 'YYYY-MM' (env) into the first of that month, UTC; falls back on garbage. */
export function parseBackfillFrom(value: string | undefined, fallback: string): Date {
  const m = /^(\d{4})-(\d{2})$/.exec((value ?? fallback).trim());
  if (!m) return parseBackfillFrom(fallback, fallback);
  return firstOfMonthUTC(Number(m[1]), Number(m[2]) - 1);
}

/**
 * Months from `from` up to the newest month whose end is at least
 * EARLIEST_PUBLISH_DAYS in the past. Never the current month.
 */
export function eligibleMonths(now: Date, from: Date): Date[] {
  const months: Date[] = [];
  let m = firstOfMonthUTC(from.getUTCFullYear(), from.getUTCMonth());
  for (;;) {
    const publishable = addDaysUTC(lastDayOfMonthUTC(m), EARLIEST_PUBLISH_DAYS + 1);
    if (publishable.getTime() > now.getTime()) break;
    months.push(m);
    m = firstOfMonthUTC(m.getUTCFullYear(), m.getUTCMonth() + 1);
    if (months.length > 600) break; // a typo in the env must not loop forever
  }
  return months;
}
