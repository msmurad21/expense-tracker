import { describe, it, expect } from 'vitest';
import { validateTemplate } from '../src/main/parsing/templateSchema.js';
import { evaluateTemplate, templateAppliesTo } from '../src/main/parsing/evaluator.js';
import { hblAlert, hblTemplate, netflixReceipt, spoofedAlert } from './fixtures/synthetic.js';

const validated = () => {
  const result = validateTemplate(hblTemplate);
  if (!result.ok || !result.template) {
    throw new Error(`fixture template is invalid: ${result.problems.join('; ')}`);
  }
  return result.template;
};

describe('template validation', () => {
  it('accepts a well-formed template', () => {
    expect(validateTemplate(hblTemplate).ok).toBe(true);
  });

  it('rejects a template containing an unsafe pattern', () => {
    const evil = {
      ...hblTemplate,
      rules: [{ ...hblTemplate.rules[0]!, pattern: '(a+)+' }, ...hblTemplate.rules.slice(1)],
    };
    const result = validateTemplate(evil);
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toContain('NESTED_QUANTIFIER');
  });

  it('rejects an unsafe subject pattern too', () => {
    const result = validateTemplate({ ...hblTemplate, subjectPattern: '(x+x+)+y' });
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toContain('subjectPattern');
  });

  it('requires a bank alert to extract an amount and a timestamp', () => {
    const result = validateTemplate({
      ...hblTemplate,
      rules: [hblTemplate.rules[0]!, hblTemplate.rules[2]!], // currency + merchant only
    });
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toContain('amount');
  });

  it('refuses an amount with no way to know its currency', () => {
    const result = validateTemplate({
      ...hblTemplate,
      rules: hblTemplate.rules.filter((r) => r.field !== 'currency'),
    });
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toContain('currency');
  });

  it('rejects duplicate field names', () => {
    const result = validateTemplate({
      ...hblTemplate,
      rules: [...hblTemplate.rules, hblTemplate.rules[1]!],
    });
    expect(result.ok).toBe(false);
  });

  it('rejects a sender domain that is not a bare domain', () => {
    expect(validateTemplate({ ...hblTemplate, senderDomain: 'https://hbl.com' }).ok).toBe(false);
    expect(validateTemplate({ ...hblTemplate, senderDomain: 'not a domain' }).ok).toBe(false);
  });

  it('holds built-in templates to exactly the same standard', () => {
    // A mistake in one of our own templates can hang the app just as easily.
    const result = validateTemplate({
      ...hblTemplate,
      origin: 'builtin',
      rules: [{ ...hblTemplate.rules[0]!, pattern: '(a*)*' }, ...hblTemplate.rules.slice(1)],
    });
    expect(result.ok).toBe(false);
  });
});

describe('template binding — what a template is allowed to run against', () => {
  const template = validated();

  it('applies to mail from its own DKIM-verified domain', () => {
    expect(templateAppliesTo(template, hblAlert)).toBe(true);
  });

  it('applies to a subdomain of the bound domain', () => {
    expect(templateAppliesTo(template, { ...hblAlert, dkimDomain: 'alerts.hbl.com' })).toBe(true);
  });

  it('does NOT apply to an unsigned message', () => {
    // The core anti-spoofing property: without DKIM there is no trust to borrow.
    expect(templateAppliesTo(template, spoofedAlert)).toBe(false);
  });

  it('does NOT apply to a different domain, however similar', () => {
    expect(templateAppliesTo(template, { ...hblAlert, dkimDomain: 'hbl-alerts.example.net' })).toBe(
      false,
    );
    // Suffix matching must not be fooled by a domain merely ending in the name.
    expect(templateAppliesTo(template, { ...hblAlert, dkimDomain: 'evilhbl.com' })).toBe(false);
  });

  it('does NOT apply when the template is not approved', () => {
    // Nothing parses until a human has seen what the template extracts.
    expect(templateAppliesTo({ ...template, status: 'pending' }, hblAlert)).toBe(false);
    expect(templateAppliesTo({ ...template, status: 'rejected' }, hblAlert)).toBe(false);
  });

  it('does NOT apply when the subject does not match', () => {
    expect(templateAppliesTo(template, { ...hblAlert, subject: 'Monthly statement' })).toBe(false);
  });
});

describe('extraction', () => {
  const template = validated();

  it('pulls every field out of a bank alert', () => {
    const result = evaluateTemplate(template, hblAlert);

    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.errors).toEqual([]);

    expect(result.fields['currency']).toBe('PKR');
    expect(result.fields['amount']).toBe(432050); // exact minor units
    expect(result.fields['merchant']).toBe('NETFLIX.COM');
    expect(result.fields['card_last4']).toBe('4821');
    // 14:35 PKT is 09:35 UTC.
    expect(result.fields['occurred_at']).toBe('2026-07-29T09:35:00.000Z');
  });

  it('records how the timestamp was derived', () => {
    const result = evaluateTemplate(template, hblAlert);
    expect(result.fields['occurred_at_tz_source']).toBe('assumed:PKT');
  });

  it('reports missing required fields instead of writing a partial record', () => {
    const result = evaluateTemplate(template, {
      ...hblAlert,
      bodyText: 'Your card was used. Amount: PKR 100.00',
    });

    expect(result.ok).toBe(false);
    expect(result.missing).toContain('card_last4');
    expect(result.missing).toContain('occurred_at');
  });

  it('reports a coercion failure rather than guessing', () => {
    const result = evaluateTemplate(template, {
      ...hblAlert,
      bodyText: hblAlert.bodyText.replace('29/07/2026 14:35', '31/02/2026 14:35'),
    });

    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('occurred_at');
  });
});

describe('extraction — a merchant receipt', () => {
  const receiptTemplate = {
    name: 'Netflix receipt',
    senderDomain: 'netflix.com',
    subjectPattern: 'receipt',
    kind: 'receipt' as const,
    origin: 'builtin' as const,
    status: 'approved' as const,
    rules: [
      { field: 'currency', pattern: 'Total:\\s*(US\\$)', type: 'currency' as const, required: true },
      {
        field: 'amount',
        pattern: 'Total:\\s*US\\$([\\d,.]+)',
        type: 'money_minor' as const,
        required: true,
      },
      {
        field: 'plan_name',
        pattern: 'Netflix plan:\\s*(.+)',
        type: 'string' as const,
        required: false,
      },
      {
        field: 'owning_account',
        pattern: 'Account:\\s*(\\S+@\\S+)',
        type: 'string' as const,
        required: false,
      },
      {
        field: 'next_renewal_at',
        pattern: 'Next billing date:\\s*(.+)',
        type: 'date' as const,
        required: false,
      },
    ],
  };

  it('captures the plan and the owning account — what a bank alert cannot tell us', () => {
    const validatedReceipt = validateTemplate(receiptTemplate);
    expect(validatedReceipt.ok).toBe(true);

    const result = evaluateTemplate(validatedReceipt.template!, netflixReceipt);

    expect(result.fields['amount']).toBe(1549);
    expect(result.fields['currency']).toBe('USD');
    expect(result.fields['plan_name']).toBe('Standard with ads');
    // This is the field that answers "whose subscription is this?".
    expect(result.fields['owning_account']).toBe('example.member@example.com');
  });
});
