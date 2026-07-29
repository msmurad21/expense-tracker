import { z } from 'zod';
import { vetPattern } from './safeRegex.js';

/**
 * Validation for parse templates.
 *
 * This is the gate every template passes through before it can be stored, and
 * it is the single place where "can this rule be trusted to run against every
 * future email" is decided. Templates arrive from three places — shipped
 * built-ins, an LLM proposal derived from an email, and hand-editing — and all
 * three are validated identically. Built-ins get no privilege: a mistake in one
 * of ours is as capable of hanging the app as a hostile proposal.
 *
 * A template is DATA. There is no code path that evaluates a string as code.
 */

const IDENTIFIER = /^[a-z][a-z0-9_]*$/;
const DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

export const FIELD_TYPES = ['money_minor', 'currency', 'date', 'string', 'last4'] as const;

export const fieldRuleSchema = z
  .object({
    field: z
      .string()
      .min(1)
      .max(40)
      .regex(IDENTIFIER, 'field names must be lower_snake_case identifiers'),
    pattern: z.string(),
    type: z.enum(FIELD_TYPES),
    required: z.boolean(),
    /** Used when the pattern finds nothing — e.g. a bank that only ever bills PKR. */
    fallback: z.string().max(100).optional(),
  })
  .superRefine((rule, ctx) => {
    const verdict = vetPattern(rule.pattern);
    if (!verdict.safe) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['pattern'],
        message: `Unsafe pattern for "${rule.field}" (${verdict.code}): ${verdict.reason}`,
      });
    }
  });

export const parseTemplateSchema = z
  .object({
    name: z.string().min(1).max(80),
    /**
     * The DKIM-verified domain this template is bound to. Binding to the From
     * header instead would be worthless — anyone can put a bank's address there.
     */
    senderDomain: z.string().min(3).max(253).regex(DOMAIN, 'must be a bare domain'),
    subjectPattern: z.string().max(300).nullable(),
    kind: z.enum(['bank_alert', 'receipt']),
    rules: z.array(fieldRuleSchema).min(1).max(20),
    origin: z.enum(['builtin', 'llm', 'user']),
    status: z.enum(['pending', 'approved', 'rejected']),
  })
  .superRefine((template, ctx) => {
    if (template.subjectPattern !== null) {
      // The subject matcher needs no capture group, so it is vetted for safety
      // only — hence the wrapper that satisfies the one-group requirement.
      const verdict = vetPattern(`(${template.subjectPattern})`);
      if (!verdict.safe) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['subjectPattern'],
          message: `Unsafe subject pattern (${verdict.code}): ${verdict.reason}`,
        });
      }
    }

    const fields = new Set(template.rules.map((r) => r.field));

    const duplicates = template.rules.length !== fields.size;
    if (duplicates) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['rules'],
        message: 'Two rules extract the same field name.',
      });
    }

    // A template that cannot produce the minimum useful record is a bug, not a
    // partial success — better to reject it than to write half a transaction.
    const requiredFor: Record<string, string[]> = {
      bank_alert: ['amount', 'occurred_at'],
      receipt: ['amount'],
    };
    for (const needed of requiredFor[template.kind] ?? []) {
      if (!fields.has(needed)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['rules'],
          message: `A ${template.kind} template must extract "${needed}".`,
        });
      }
    }

    // Money is meaningless without knowing the unit.
    if (fields.has('amount') && !fields.has('currency')) {
      const amountRule = template.rules.find((r) => r.field === 'amount');
      if (!amountRule?.fallback) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['rules'],
          message:
            'A template extracting "amount" must also extract "currency", or set a currency fallback on the amount rule.',
        });
      }
    }
  });

export type ValidatedTemplate = z.infer<typeof parseTemplateSchema>;

export interface TemplateValidation {
  ok: boolean;
  template?: ValidatedTemplate;
  /** Messages written for the approval tray, not for a stack trace. */
  problems: string[];
}

/** Validate an untrusted object into a template, or explain why it cannot be. */
export function validateTemplate(input: unknown): TemplateValidation {
  const result = parseTemplateSchema.safeParse(input);
  if (result.success) {
    return { ok: true, template: result.data, problems: [] };
  }
  return {
    ok: false,
    problems: result.error.issues.map((issue) =>
      issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message,
    ),
  };
}
