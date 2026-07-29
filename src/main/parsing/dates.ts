/**
 * Turning the date strings found in bank alerts into UTC instants.
 *
 * Bank alert emails almost never carry a UTC offset. They say "29/07/2026
 * 14:35" and expect you to know the bank's timezone. Feeding that to
 * `new Date(string)` is a trap: the result depends on the host's locale and on
 * engine-specific parsing quirks, so the same email can land on different days
 * for different users.
 *
 * So: parse explicitly against known shapes, apply a configured offset, and
 * always record HOW the instant was derived in `tzSource`. When a date is later
 * shown to be a day out, that field is what makes it debuggable.
 */

export interface DateParseOptions {
  /**
   * Minutes to add to local time to reach UTC, negated — i.e. the offset of the
   * assumed zone. Pakistan (PKT, UTC+5) is 300.
   */
  assumedOffsetMinutes: number;
  /** Human label recorded in `tzSource`, e.g. "PKT". */
  assumedTzLabel: string;
  /**
   * Whether an ambiguous numeric date like 03/04/2026 is day-first. True for
   * Pakistan, the UK and most of the world; false for the United States.
   */
  dayFirst: boolean;
}

export const DEFAULT_DATE_OPTIONS: DateParseOptions = {
  assumedOffsetMinutes: 300, // UTC+05:00
  assumedTzLabel: 'PKT',
  dayFirst: true,
};

export interface DateParseResult {
  ok: boolean;
  /** ISO-8601 in UTC, e.g. "2026-07-29T09:35:00.000Z". */
  iso?: string;
  /** How we got there: "explicit:+05:00" or "assumed:PKT". */
  tzSource?: string;
  reason?: string;
}

const MONTHS: Record<string, number> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

/** Build a UTC ISO string from local wall-clock parts plus an offset. */
function toUtcIso(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  s: number,
  offsetMinutes: number,
): string | null {
  // Reject impossible dates before Date silently rolls them over
  // (new Date(2026, 1, 31) quietly becomes 3 March).
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;

  const utcMillis = Date.UTC(y, mo - 1, d, h, mi, s) - offsetMinutes * 60_000;
  const date = new Date(utcMillis);

  // Confirm the round trip: catches 31 February and friends.
  const check = new Date(Date.UTC(y, mo - 1, d));
  if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;

  return date.toISOString();
}

function parseTimeParts(
  hour: string | undefined,
  minute: string | undefined,
  second: string | undefined,
  meridiem: string | undefined,
): { h: number; mi: number; s: number } {
  let h = hour ? Number(hour) : 0;
  const mi = minute ? Number(minute) : 0;
  const s = second ? Number(second) : 0;

  if (meridiem) {
    const isPm = /p/i.test(meridiem);
    if (h === 12) h = isPm ? 12 : 0;
    else if (isPm) h += 12;
  }
  return { h, mi, s };
}

/** Shapes we accept, tried in order. */
const PATTERNS: {
  name: string;
  re: RegExp;
  build: (
    m: RegExpMatchArray,
    opts: DateParseOptions,
  ) => { y: number; mo: number; d: number; h: number; mi: number; s: number } | null;
}[] = [
  {
    // 2026-07-29T14:35:00 / 2026-07-29 14:35
    name: 'iso',
    re: /(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?/,
    build: (m) => {
      const t = parseTimeParts(m[4], m[5], m[6], undefined);
      return { y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]), ...t };
    },
  },
  {
    // 29-Jul-2026 14:35 / 29 July 2026 / 29 Jul 26
    name: 'day-month-name-year',
    re: /(\d{1,2})[-\s/]([A-Za-z]{3,9})[-\s/](\d{2,4})(?:[,\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?)?/,
    build: (m) => {
      const mo = MONTHS[(m[2] ?? '').toLowerCase()];
      if (!mo) return null;
      const t = parseTimeParts(m[4], m[5], m[6], m[7]);
      let y = Number(m[3]);
      if (y < 100) y += 2000;
      return { y, mo, d: Number(m[1]), ...t };
    },
  },
  {
    // Jul 29, 2026 2:35 PM
    name: 'month-name-day-year',
    re: /([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})(?:[,\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?)?/,
    build: (m) => {
      const mo = MONTHS[(m[1] ?? '').toLowerCase()];
      if (!mo) return null;
      const t = parseTimeParts(m[4], m[5], m[6], m[7]);
      return { y: Number(m[3]), mo, d: Number(m[2]), ...t };
    },
  },
  {
    // 29/07/2026 14:35 — order depends on locale, resolved below
    name: 'numeric',
    re: /(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})(?:[,\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?)?/,
    build: (m, opts) => {
      const a = Number(m[1]);
      const b = Number(m[2]);
      let y = Number(m[3]);
      if (y < 100) y += 2000;

      // If one component exceeds 12 it can only be the day, whatever the
      // convention. Otherwise fall back to the configured order.
      let d: number;
      let mo: number;
      if (a > 12 && b <= 12) {
        d = a;
        mo = b;
      } else if (b > 12 && a <= 12) {
        d = b;
        mo = a;
      } else {
        d = opts.dayFirst ? a : b;
        mo = opts.dayFirst ? b : a;
      }

      const t = parseTimeParts(m[4], m[5], m[6], m[7]);
      return { y, mo, d, ...t };
    },
  },
];

/**
 * Parse `input` to a UTC instant.
 *
 * An explicit offset in the string always wins. Otherwise the configured
 * assumed zone is applied and recorded, so a wrong assumption is visible in the
 * data rather than baked invisibly into a timestamp.
 */
export function parseDateToUtc(
  input: string,
  options: DateParseOptions = DEFAULT_DATE_OPTIONS,
): DateParseResult {
  if (typeof input !== 'string' || input.trim() === '') {
    return { ok: false, reason: 'empty date' };
  }

  // An explicit offset (or a trailing Z) means we can trust the string itself.
  const explicit = /(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?)\s*(Z|[+-]\d{2}:?\d{2})/.exec(
    input,
  );
  if (explicit) {
    const normalised = `${explicit[1]!.replace(' ', 'T')}${
      explicit[2] === 'Z' ? 'Z' : explicit[2]!.replace(/(\d{2})(\d{2})$/, '$1:$2')
    }`;
    const parsed = new Date(normalised);
    if (!Number.isNaN(parsed.getTime())) {
      return {
        ok: true,
        iso: parsed.toISOString(),
        tzSource: `explicit:${explicit[2]}`,
      };
    }
  }

  for (const pattern of PATTERNS) {
    const m = pattern.re.exec(input);
    if (!m) continue;

    const parts = pattern.build(m, options);
    if (!parts) continue;

    const iso = toUtcIso(
      parts.y,
      parts.mo,
      parts.d,
      parts.h,
      parts.mi,
      parts.s,
      options.assumedOffsetMinutes,
    );
    if (!iso) continue;

    return { ok: true, iso, tzSource: `assumed:${options.assumedTzLabel}` };
  }

  return { ok: false, reason: `no recognised date in "${input.slice(0, 60)}"` };
}
