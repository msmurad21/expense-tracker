/**
 * Synthetic email fixtures.
 *
 * Every value here is invented. Real bank alerts must never be committed to
 * this repository — not redacted ones either, because redaction is easy to get
 * wrong and a leaked card number cannot be un-leaked. These are written by hand
 * to mimic the *structure* of real alerts without containing anyone's data.
 *
 * Card numbers, amounts, account identifiers and merchant references below are
 * all fictional.
 */
import type { EmailDocument } from '../../src/main/parsing/evaluator.js';

export const HBL_ALERT_BODY = `Dear Customer,

Your HBL Debit Card ending 4821 has been used for a purchase.

Amount: PKR 4,320.50
Merchant: NETFLIX.COM
Date & Time: 29/07/2026 14:35

If you did not authorize this transaction, please call 111-111-425 immediately.

Regards,
HBL`;

export const hblAlert: EmailDocument = {
  subject: 'Transaction Alert - HBL Debit Card',
  bodyText: HBL_ALERT_BODY,
  dkimDomain: 'hbl.com',
  fromDomain: 'hbl.com',
};

export const NETFLIX_RECEIPT_BODY = `Hi Shah,

Thanks for being a member.

Your Netflix plan: Standard with ads
Billing period: 29 Jul 2026 to 28 Aug 2026
Next billing date: 29 Aug 2026

Total: US$15.49

Account: example.member@example.com

Questions? Visit netflix.com/help`;

export const netflixReceipt: EmailDocument = {
  subject: 'Your Netflix receipt',
  bodyText: NETFLIX_RECEIPT_BODY,
  dkimDomain: 'netflix.com',
  fromDomain: 'netflix.com',
};

/**
 * The same HBL alert, but unsigned and sent from a lookalike domain — i.e. what
 * a spoofing attempt actually looks like. Nothing may parse this.
 */
export const spoofedAlert: EmailDocument = {
  subject: 'Transaction Alert - HBL Debit Card',
  bodyText: HBL_ALERT_BODY.replace('4,320.50', '99,999.00'),
  dkimDomain: null,
  fromDomain: 'hbl-alerts.example.net',
};

/** A valid template for the HBL alert above. */
export const hblTemplate = {
  name: 'HBL debit card alert',
  senderDomain: 'hbl.com',
  subjectPattern: 'Transaction Alert',
  kind: 'bank_alert' as const,
  origin: 'builtin' as const,
  status: 'approved' as const,
  rules: [
    {
      field: 'currency',
      pattern: 'Amount:\\s*([A-Z]{3})',
      type: 'currency' as const,
      required: true,
    },
    {
      field: 'amount',
      pattern: 'Amount:\\s*[A-Z]{3}\\s*([\\d,]+\\.\\d{2})',
      type: 'money_minor' as const,
      required: true,
    },
    {
      field: 'merchant',
      pattern: 'Merchant:\\s*(.+)',
      type: 'string' as const,
      required: true,
    },
    {
      field: 'card_last4',
      pattern: 'ending\\s+(\\d{4})',
      type: 'last4' as const,
      required: true,
    },
    {
      field: 'occurred_at',
      pattern: 'Date & Time:\\s*([\\d/]+\\s+[\\d:]+)',
      type: 'date' as const,
      required: true,
    },
  ],
};
