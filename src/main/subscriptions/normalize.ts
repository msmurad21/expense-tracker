/**
 * Turning the merchant string on a bank alert into something groupable.
 *
 * Card networks pass a 22-40 character descriptor that has been through several
 * systems. The same subscription can arrive as `NETFLIX.COM`, `Netflix
 * 8663797`, `SQ *NETFLIX` or `NETFLIX.COM 866-579-7172 CA`. Unless these
 * collapse to one key, a single subscription looks like four one-off purchases
 * and no recurrence is ever detected.
 */

/** Payment processor and gateway prefixes that say nothing about the merchant. */
//
// Every alternative here must be anchored so it can only match a whole token.
// An earlier version had a bare `SP ?`, which matched the first two letters of
// SPOTIFY and normalised it to "OTIFY" — quietly splitting one subscription
// into two. Prefixes that are plain letters need `\s+`, not an optional space.
const PROCESSOR_PREFIXES =
  /^(SQ\s?\*|TST\s?\*|PAYPAL\s?\*|PP\s?\*|IC\s?\*|EZ\s?\*|SP\s+|WWW\.|POS\s+|ECOM\s+|PURCHASE\s+|PMNT\s+|PAYMENT TO\s+)/i;

/** Trailing noise: reference numbers, phone numbers, store ids. */
const TRAILING_NOISE = [
  /\s+#\d+$/,
  /\s+\d{6,}$/,
  /\s+[A-Z0-9]{10,}$/,
  /\s+\d{3}-\d{3}-\d{4}$/,
  /\s+\d{3}-\d{7}$/,
];

/** Country/region tails: "… SAN JOSE CA", "… LONDON GB", "… KARACHI PK". */
const LOCALITY_TAIL = /\s+[A-Z][A-Z\s]{2,20}\s+[A-Z]{2}$/;

const TLD_TAIL = /\.(COM|NET|IO|CO|APP|ORG|PK|UK|AI)\b/gi;

/**
 * Reduce a raw descriptor to a stable grouping key.
 *
 * Conservative on purpose: over-normalising merges genuinely different
 * merchants, which is far worse than leaving two spellings unmerged. The alias
 * table below is where deliberate merges belong.
 */
export function normaliseMerchant(raw: string): string {
  let s = raw.toUpperCase().trim();

  // Strip diacritics so "CAFÉ" and "CAFE" agree.
  s = s.normalize('NFD').replace(/[̀-ͯ]/g, '');

  s = s.replace(PROCESSOR_PREFIXES, '');
  s = s.replace(TLD_TAIL, '');
  s = s.replace(LOCALITY_TAIL, '');
  for (const pattern of TRAILING_NOISE) s = s.replace(pattern, '');

  // Keep letters, digits and spaces; collapse the rest.
  s = s.replace(/[^A-Z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

  // Drop a trailing bare number ("NETFLIX 8663797").
  s = s.replace(/\s+\d+$/, '');

  // Keep single-character tokens. An earlier version dropped them as noise,
  // which turned "K ELECTRIC" into "ELECTRIC" — missing the alias entry and
  // displaying the utility as "Electric". Initials are part of plenty of real
  // brand names.
  const tokens = s.split(' ').filter((t) => t.length > 0);
  return tokens.slice(0, 3).join(' ').trim();
}

/**
 * Deliberate merges from a normalised key to a canonical display name.
 *
 * Shipped as plain data so that adding one is a one-line pull request needing
 * no knowledge of the rest of the codebase — the cheapest useful contribution
 * anyone can make.
 */
export const MERCHANT_ALIASES: Record<string, { name: string; category: string }> = {
  NETFLIX: { name: 'Netflix', category: 'Streaming' },
  SPOTIFY: { name: 'Spotify', category: 'Streaming' },
  'SPOTIFY USA': { name: 'Spotify', category: 'Streaming' },
  'DISNEY PLUS': { name: 'Disney+', category: 'Streaming' },
  YOUTUBEPREMIUM: { name: 'YouTube Premium', category: 'Streaming' },
  'YOUTUBE PREMIUM': { name: 'YouTube Premium', category: 'Streaming' },
  'GOOGLE YOUTUBE': { name: 'YouTube Premium', category: 'Streaming' },

  APPLE: { name: 'Apple', category: 'Software & SaaS' },
  'APPLE BILL': { name: 'Apple', category: 'Software & SaaS' },
  'APPLE COM BILL': { name: 'Apple', category: 'Software & SaaS' },
  ITUNES: { name: 'Apple', category: 'Software & SaaS' },
  'GOOGLE STORAGE': { name: 'Google One', category: 'Software & SaaS' },
  'GOOGLE ONE': { name: 'Google One', category: 'Software & SaaS' },
  MICROSOFT: { name: 'Microsoft', category: 'Software & SaaS' },
  'MICROSOFT 365': { name: 'Microsoft 365', category: 'Software & SaaS' },
  ADOBE: { name: 'Adobe', category: 'Software & SaaS' },
  'ADOBE CREATIVE': { name: 'Adobe', category: 'Software & SaaS' },
  CANVA: { name: 'Canva', category: 'Software & SaaS' },
  NOTION: { name: 'Notion', category: 'Software & SaaS' },
  FIGMA: { name: 'Figma', category: 'Software & SaaS' },
  GITHUB: { name: 'GitHub', category: 'Software & SaaS' },
  DROPBOX: { name: 'Dropbox', category: 'Software & SaaS' },
  SLACK: { name: 'Slack', category: 'Software & SaaS' },
  ZOOM: { name: 'Zoom', category: 'Software & SaaS' },

  OPENAI: { name: 'OpenAI', category: 'AI Tools' },
  'OPENAI CHATGPT': { name: 'OpenAI', category: 'AI Tools' },
  ANTHROPIC: { name: 'Anthropic', category: 'AI Tools' },
  'ANTHROPIC CLAUDE': { name: 'Anthropic', category: 'AI Tools' },
  CURSOR: { name: 'Cursor', category: 'AI Tools' },
  PERPLEXITY: { name: 'Perplexity', category: 'AI Tools' },

  AMAZON: { name: 'Amazon', category: 'Shopping' },
  'AMZN MKTP': { name: 'Amazon', category: 'Shopping' },
  'AMAZON PRIME': { name: 'Amazon Prime', category: 'Shopping' },

  UBER: { name: 'Uber', category: 'Transport' },
  CAREEM: { name: 'Careem', category: 'Transport' },

  JAZZ: { name: 'Jazz', category: 'Telecom' },
  ZONG: { name: 'Zong', category: 'Telecom' },
  UFONE: { name: 'Ufone', category: 'Telecom' },
  TELENOR: { name: 'Telenor', category: 'Telecom' },
  'K ELECTRIC': { name: 'K-Electric', category: 'Utilities' },
  'SUI GAS': { name: 'Sui Gas', category: 'Utilities' },
};

export interface ResolvedMerchant {
  key: string;
  displayName: string;
  category: string | null;
  /** 'alias' when a deliberate mapping matched; 'derived' when we inferred it. */
  source: 'alias' | 'derived';
}

/** Resolve a raw descriptor to a canonical merchant. */
export function resolveMerchant(raw: string): ResolvedMerchant {
  const key = normaliseMerchant(raw);

  const alias = MERCHANT_ALIASES[key];
  if (alias) {
    return { key, displayName: alias.name, category: alias.category, source: 'alias' };
  }

  // Try the leading token — "NETFLIX INTL BV" should still find "NETFLIX".
  const firstToken = key.split(' ')[0] ?? '';
  const byFirstToken = MERCHANT_ALIASES[firstToken];
  if (byFirstToken) {
    return {
      key: firstToken,
      displayName: byFirstToken.name,
      category: byFirstToken.category,
      source: 'alias',
    };
  }

  return {
    key,
    displayName: titleCase(key),
    category: null,
    source: 'derived',
  };
}

function titleCase(value: string): string {
  return value
    .toLowerCase()
    .split(' ')
    .map((word) => (word.length === 0 ? word : word[0]!.toUpperCase() + word.slice(1)))
    .join(' ');
}
