export interface PaywallScoreInput {
  iapPresent: boolean;
  description: string;
}

const BASELINE_IAP = 3;

const SUBSCRIPTION_RE = /\b(subscription|subscribe|monthly|yearly|annual)\b|\/(?:month|mo|year|yr)\b|per\s+(?:month|year)/i;
const TRIAL_RE = /\b(free trial|trial period|\d+[- ]day(?: free)? trial|try (it )?free)\b/i;
const LIFETIME_RE = /\b(lifetime|one[- ]?time|forever|permanent purchase)\b/i;
const TIER_RE = /\b(pro|premium|plus|elite|ultimate|gold|platinum)\b/gi;

export function scorePaywallComplexity(input: PaywallScoreInput): number {
  if (!input.iapPresent) return 0;
  const desc = input.description ?? "";

  let score = BASELINE_IAP;
  if (SUBSCRIPTION_RE.test(desc)) score += 2;
  if (TRIAL_RE.test(desc)) score += 2;
  if (LIFETIME_RE.test(desc)) score += 2;

  const tierMatches = desc.match(TIER_RE);
  const distinctTiers = tierMatches
    ? new Set(tierMatches.map((t) => t.toLowerCase())).size
    : 0;
  if (distinctTiers >= 2) score += 1;

  return Math.max(0, Math.min(10, score));
}
