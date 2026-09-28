// Drafts that mention prices, discounts, contract terms or date/deliverable commitments are flagged: they always need
// the CEO's explicit per-email approval (never "approve all", never auto-approve). Mirrors sales_detect_flags() in
// supabase/migrations/20260928090000_sales_pipeline.sql; the SQL trigger recomputes flags on every save, so this copy
// is for the agent's tool feedback and must stay in sync (both are tested on the same samples).
export const SALES_FLAGS = ['pricing', 'discount', 'contract', 'commitment', 'proposal'] as const;
export type SalesFlag = (typeof SALES_FLAGS)[number];

const DAYS = 'monday|tuesday|wednesday|thursday|friday|saturday|sunday';
const MONTHS = 'jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec';

const RULES: [Exclude<SalesFlag, 'proposal'>, RegExp[]][] = [
  ['pricing', [
    /[$€£₱]\s?\d/,
    /\b\d[\d,.]*\s?(usd|aud|gbp|cad|eur|php|dollars?|pesos?)\b/,
    /\b(price|prices|pricing|priced|quote|quoted|quotes|quotation|fee|fees|invoice|hourly rate|day rate|flat rate|per hour|per month|per project)\b/,
  ]],
  ['discount', [
    /\b(discount|discounts|discounted|coupon|promo|promotion|percent off|special offer|limited[- ]time|waive|waived)\b/,
    /\d+\s?% off/,
  ]],
  ['contract', [
    /\b(contract|contracts|agreement|statement of work|sow|terms and conditions|payment terms|deposit|retainer|guarantee|guaranteed|guarantees|warranty|refund|nda)\b/,
    /\bt&cs?\b/,
    /\bsign (the|an?|our|this)\b/,
  ]],
  ['commitment', [
    new RegExp(`\\b(by|before|until|on|due|starting|ready|live|launch|launched|deliver|delivered)\\s+(the\\s+)?(${DAYS}|tomorrow|tonight|end of|next week|next month|this week|this month`
      + `|\\d{1,2}(st|nd|rd|th)?\\s+(of\\s+)?(${MONTHS})|(${MONTHS})[a-z]*\\.?\\s+\\d{1,2}\\b|\\d{1,2}\\/\\d{1,2})`),
    /\bwithin\s+\d+\s+(business\s+|working\s+)?(hours|days|weeks|months)\b/,
    /\b\d+\s+(business|working)\s+days\b/,
    /\b(deadline|turnaround|we will deliver|we'll deliver|we can deliver|we'll have (it|this|them) (done|ready))\b/,
  ]],
];

/** Flags for a draft (sorted, like the SQL). Proposals always carry "proposal". */
export function detectFlags(subject: string, body: string, kind?: string): SalesFlag[] {
  const s = `${subject ?? ''}\n${body ?? ''}`.toLowerCase();
  const out = new Set<SalesFlag>(RULES.filter(([, res]) => res.some((re) => re.test(s))).map(([f]) => f));
  if (kind === 'proposal') out.add('proposal');
  return [...out].sort();
}

export const needsExplicitApproval = (flags: readonly string[]) => flags.length > 0;

const LABEL: Record<SalesFlag, string> = {
  pricing: 'prices', discount: 'a discount', contract: 'contract terms', commitment: 'a date or deliverable commitment', proposal: 'a proposal',
};
export function describeFlags(flags: readonly string[]): string {
  return flags.map((f) => LABEL[f as SalesFlag] ?? f).join(', ');
}
