import { parseMoneyMinor, normaliseCurrency } from './money.js';
import { parseDateToUtc, DEFAULT_DATE_OPTIONS, type DateParseOptions } from './dates.js';
import type { ValidatedTemplate } from './templateSchema.js';

/**
 * The interpreter for declarative parse templates.
 *
 * This is deliberately the *only* thing that turns a template into extracted
 * values, and it is a fixed evaluator over a closed set of field types. A
 * template can describe what to capture and how to coerce it; it can never
 * describe behaviour. There is no `eval`, no `new Function`, and no dynamic
 * dispatch on template-supplied strings anywhere in this file.
 */

export interface EmailDocument {
  subject: string;
  bodyText: string;
  /** Verified sender domain, or null when DKIM was absent or failed. */
  dkimDomain: string | null;
  fromDomain: string;
}

export type ExtractedValue = string | number | null;

export interface ExtractionResult {
  ok: boolean;
  fields: Record<string, ExtractedValue>;
  /** Required fields whose pattern did not match. */
  missing: string[];
  /** Fields that matched but could not be coerced, with the reason. */
  errors: string[];
}

/**
 * Whether `template` is allowed to run against `doc`.
 *
 * The binding is to the DKIM-verified domain, never the From header. An
 * unsigned message matches nothing: a spoofed "HBL" alert cannot borrow the
 * trust of a template minted from genuinely signed HBL mail. The cost is that
 * mail from domains which do not sign is unparseable, which is the right side
 * to err on for something that writes financial records.
 */
export function templateAppliesTo(template: ValidatedTemplate, doc: EmailDocument): boolean {
  if (template.status !== 'approved') return false;
  if (doc.dkimDomain === null) return false;

  const domain = doc.dkimDomain.toLowerCase();
  const bound = template.senderDomain.toLowerCase();

  // Exact match, or a subdomain of the bound domain (alerts.hbl.com vs hbl.com).
  const domainMatches = domain === bound || domain.endsWith(`.${bound}`);
  if (!domainMatches) return false;

  if (template.subjectPattern !== null) {
    try {
      if (!new RegExp(template.subjectPattern, 'i').test(doc.subject)) return false;
    } catch {
      return false; // a template that cannot compile matches nothing
    }
  }

  return true;
}

/** Pull capture group 1 (or the sole named group) out of `text`. */
function captureFirst(pattern: string, text: string): string | null {
  let re: RegExp;
  try {
    re = new RegExp(pattern, 'i');
  } catch {
    return null;
  }

  const m = re.exec(text);
  if (!m) return null;

  if (m.groups) {
    const values = Object.values(m.groups).filter((v) => v !== undefined);
    if (values.length > 0) return values[0] ?? null;
  }
  return m[1] ?? null;
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Apply `template` to `doc`.
 *
 * Currency is resolved first because money coercion depends on it — the number
 * of minor units in "12.345" differs between USD and KWD.
 */
export function evaluateTemplate(
  template: ValidatedTemplate,
  doc: EmailDocument,
  dateOptions: DateParseOptions = DEFAULT_DATE_OPTIONS,
): ExtractionResult {
  // Patterns may match against the subject or the body; searching the two
  // joined keeps templates simple and costs nothing at these sizes.
  const haystack = `${doc.subject}\n${doc.bodyText}`;

  const fields: Record<string, ExtractedValue> = {};
  const missing: string[] = [];
  const errors: string[] = [];

  const rawByField = new Map<string, string | null>();
  for (const rule of template.rules) {
    rawByField.set(rule.field, captureFirst(rule.pattern, haystack));
  }

  // ── Pass 1: currency ─────────────────────────────────────────────────────
  const currencyRule = template.rules.find((r) => r.type === 'currency');
  const amountRule = template.rules.find((r) => r.field === 'amount');

  let currency: string | null = null;
  if (currencyRule) {
    const raw = rawByField.get(currencyRule.field) ?? currencyRule.fallback ?? null;
    currency = raw === null ? null : normaliseCurrency(raw);
    if (currency === null && currencyRule.required) {
      if (raw === null) missing.push(currencyRule.field);
      else errors.push(`${currencyRule.field}: unrecognised currency "${raw}"`);
    }
    if (currency !== null) fields[currencyRule.field] = currency;
  }
  // A bank that only ever bills one currency can declare it on the amount rule.
  if (currency === null && amountRule?.fallback) {
    currency = normaliseCurrency(amountRule.fallback);
    if (currency) fields['currency'] = currency;
  }

  // ── Pass 2: everything else ──────────────────────────────────────────────
  for (const rule of template.rules) {
    if (rule === currencyRule) continue;

    const raw = rawByField.get(rule.field) ?? null;
    const value = raw ?? (rule.type === 'money_minor' ? null : (rule.fallback ?? null));

    if (value === null) {
      if (rule.required) missing.push(rule.field);
      else fields[rule.field] = null;
      continue;
    }

    switch (rule.type) {
      case 'money_minor': {
        if (currency === null) {
          errors.push(`${rule.field}: cannot read an amount without knowing the currency`);
          break;
        }
        const parsed = parseMoneyMinor(value, currency);
        if (parsed.ok && parsed.minor !== undefined) {
          fields[rule.field] = parsed.minor;
        } else {
          errors.push(`${rule.field}: ${parsed.reason ?? 'unparseable amount'}`);
        }
        break;
      }

      case 'date': {
        const parsed = parseDateToUtc(value, dateOptions);
        if (parsed.ok && parsed.iso) {
          fields[rule.field] = parsed.iso;
          // Recorded alongside so a mis-assumed timezone stays debuggable.
          fields[`${rule.field}_tz_source`] = parsed.tzSource ?? null;
        } else {
          errors.push(`${rule.field}: ${parsed.reason ?? 'unparseable date'}`);
        }
        break;
      }

      case 'last4': {
        const digits = /(\d{4})\s*$/.exec(value.trim()) ?? /(\d{4})/.exec(value);
        if (digits) {
          fields[rule.field] = digits[1]!;
        } else {
          errors.push(`${rule.field}: no four-digit group in "${value}"`);
        }
        break;
      }

      case 'string': {
        fields[rule.field] = collapseWhitespace(value);
        break;
      }

      case 'currency': {
        // Handled in pass 1; a second currency rule is not meaningful.
        break;
      }
    }
  }

  return {
    ok: missing.length === 0 && errors.length === 0,
    fields,
    missing,
    errors,
  };
}
