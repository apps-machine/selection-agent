/**
 * Stage 5 Runbook-Discovery — discovery dossier generator.
 *
 * Pure functions that take a Path E shortlist (JSON output of
 * `selection-agent shortlist`) plus a candidate reference (app_id + store)
 * and emit a populated dossier markdown document. The CLI surface
 * (`selection-agent dossier`) is a thin shell over these functions.
 *
 * The dossier is the audit trail that bridges the OBJECTIVE Stages 1-3
 * outputs (chart durability, monetization, market spread, clonability)
 * with the SUBJECTIVE founder decision (opportunity statement, kill
 * thresholds, AI hook choice, GO/NO-GO sign-off). Auto-populated sections
 * fill in shortlist evidence; PLACEHOLDER sections carry `TODO:` markers
 * and short hints for the user to complete in their editor.
 *
 * The default template (DEFAULT_DOSSIER_TEMPLATE) is intentionally
 * generic — usable by any indie operator. Operator-specific templates
 * can be supplied via the CLI's `--template` flag and use the same
 * `{{token}}` substitution surface documented below.
 */

export type Store = "apple" | "googleplay";

/** Minimal candidate shape required to populate a dossier. */
export interface ShortlistCandidate {
  app_id: string;
  store: string;
  title?: string | null;
  publisher_name?: string | null;
  publisher_app_count?: number | null;
  dna_class?: string | null;
  dna_subclass?: string | null;
  markets_active?: string[];
  tenure_days_max?: number | null;
  best_rank?: number | null;
  has_subscription_iap?: boolean | null;
  iap_count?: number | null;
  score?: number | null;
  clonability_hypothesis?: string | null;
  // Anything else passes through unused.
  [key: string]: unknown;
}

/** Top-level shortlist JSON shape produced by `selection-agent shortlist`. */
export interface Shortlist {
  shortlist?: ShortlistCandidate[];
  candidates?: ShortlistCandidate[];
  [key: string]: unknown;
}

export interface DossierOpts {
  /** The slug used for the title heading + front matter. */
  slug: string;
  /** The shortlist row to populate from. */
  candidate: ShortlistCandidate;
  /** Path to the source shortlist file (recorded in front matter). */
  shortlistSource: string;
  /** Optional user-supplied template. Defaults to DEFAULT_DOSSIER_TEMPLATE. */
  template?: string;
  /** Override "now" so tests + reproducible runs can pin the date. */
  now?: Date;
}

/**
 * Parse a `<app_id>:<store>` candidate reference.
 *
 * The colon is the only separator; app_ids may contain dots
 * (`com.example.app`), so we split on the LAST colon to keep dotted
 * package names intact. Throws on missing colon, empty halves, or unknown
 * store values.
 */
export function parseCandidateRef(ref: string): { app_id: string; store: Store } {
  if (typeof ref !== "string" || ref.length === 0) {
    throw new Error("candidate ref is empty (expected <app_id>:<store>)");
  }
  const lastColon = ref.lastIndexOf(":");
  if (lastColon === -1) {
    throw new Error(`candidate ref missing colon: "${ref}" (expected <app_id>:<store>)`);
  }
  const app_id = ref.slice(0, lastColon);
  const store = ref.slice(lastColon + 1);
  if (app_id.length === 0) {
    throw new Error(`candidate ref has empty app_id: "${ref}"`);
  }
  if (store !== "apple" && store !== "googleplay") {
    throw new Error(
      `candidate ref has unknown store "${store}": accepted values are "apple" or "googleplay"`,
    );
  }
  return { app_id, store };
}

/**
 * Locate the candidate row matching the given app_id + store. Returns
 * null when no match is found so the CLI can surface a clean exit-1
 * "not found in shortlist" error.
 */
export function findCandidate(
  shortlist: Shortlist | ShortlistCandidate[],
  app_id: string,
  store: Store,
): ShortlistCandidate | null {
  const arr: ShortlistCandidate[] = Array.isArray(shortlist)
    ? shortlist
    : (shortlist.shortlist ?? shortlist.candidates ?? []);
  for (const c of arr) {
    if (c && c.app_id === app_id && c.store === store) return c;
  }
  return null;
}

/**
 * Render a candidate field as a string suitable for `{{token}}` substitution.
 * Null / undefined render as the empty string (NOT "null") so the dossier
 * stays clean when optional fields are absent.
 */
function renderField(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map((v) => String(v)).join(", ");
  if (typeof value === "boolean") return value ? "yes" : "no";
  return String(value);
}

function renderScore(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return value.toFixed(4);
  return "";
}

function tokenMap(opts: DossierOpts, dateIso: string): Record<string, string> {
  const c = opts.candidate;
  return {
    slug: opts.slug,
    date: dateIso,
    shortlist_source: opts.shortlistSource,
    "candidate.app_id": renderField(c.app_id),
    "candidate.store": renderField(c.store),
    "candidate.title": renderField(c.title),
    "candidate.publisher_name": renderField(c.publisher_name),
    "candidate.publisher_app_count": renderField(c.publisher_app_count),
    "candidate.dna_class": renderField(c.dna_class),
    "candidate.dna_subclass": renderField(c.dna_subclass),
    "candidate.markets_active": renderField(c.markets_active),
    "candidate.tenure_days_max": renderField(c.tenure_days_max),
    "candidate.best_rank": renderField(c.best_rank),
    "candidate.has_subscription_iap": renderField(c.has_subscription_iap),
    "candidate.iap_count": renderField(c.iap_count),
    "candidate.score": renderScore(c.score),
    "candidate.clonability_hypothesis": renderField(c.clonability_hypothesis),
  };
}

/**
 * Substitute `{{token}}` placeholders in `template` using `tokens`. Unknown
 * tokens are preserved verbatim (left as `{{whatever}}`), letting user
 * templates carry literal `{{...}}` strings without escaping. We use a
 * non-greedy regex bounded to a single line so a `{{` left-brace pair
 * never accidentally consumes an entire paragraph.
 */
function substitute(template: string, tokens: Record<string, string>): string {
  return template.replace(/\{\{([^{}\n]+?)\}\}/g, (match, raw) => {
    const key = String(raw).trim();
    if (key in tokens) return tokens[key] ?? "";
    return match;
  });
}

/**
 * Build a populated dossier markdown string. Pure: no IO, no logging.
 * Caller is responsible for writing the result wherever it belongs.
 */
export function buildDossier(opts: DossierOpts): string {
  const now = opts.now ?? new Date();
  const dateIso = now.toISOString().slice(0, 10);
  const template = opts.template ?? DEFAULT_DOSSIER_TEMPLATE;
  const tokens = tokenMap(opts, dateIso);
  return substitute(template, tokens);
}

/**
 * Default generic dossier template.
 *
 * Audience: any indie operator running a discovery cycle with the
 * `selection-agent` CLI. No project-specific references — the template
 * captures objective shortlist evidence (sections 1, 3) and leaves
 * subjective sections (4-12) as `TODO:` placeholders the user fills in
 * with their editor before signing GO / NO-GO.
 */
export const DEFAULT_DOSSIER_TEMPLATE = `---
slug: {{slug}}
stage: dossier
verdict: PENDING
date: {{date}}
source: {{shortlist_source}}
---

# {{slug}} — discovery dossier (DRAFT)

## 1. Candidate

- **App ID**: {{candidate.app_id}}
- **Store**: {{candidate.store}}
- **Title**: {{candidate.title}}
- **Publisher**: {{candidate.publisher_name}} (apps: {{candidate.publisher_app_count}})
- **DNA**: {{candidate.dna_class}} / {{candidate.dna_subclass}}
- **Markets active (tier-2 SEA top-100)**: {{candidate.markets_active}}
- **Tenure days (max)**: {{candidate.tenure_days_max}}
- **Best rank**: {{candidate.best_rank}}
- **Subscription IAP**: {{candidate.has_subscription_iap}} (IAP count: {{candidate.iap_count}})
- **Path E score**: {{candidate.score}}
- **Clonability hypothesis**: {{candidate.clonability_hypothesis}}

## 2. Opportunity statement

TODO: 1 paragraph describing the wedge. What problem does this clone solve, for whom, in which markets, and why is it takeable by a solo operator?

## 3. Path E shortlist evidence

The shortlist row above carries the objective evidence. Cross-reference siblings in the same DNA class for additional triangulation. Source: \`{{shortlist_source}}\`.

## 4. Nine strategic filters

Each filter must PASS before the candidate progresses to spec. Document reasoning per row.

| # | Filter | Status | Reasoning |
|---|---|---|---|
| 1 | Solo-buildable in 4 weeks | TODO | TODO |
| 2 | No content licensing dependencies | TODO | TODO |
| 3 | No network-effect lock-in | TODO | TODO |
| 4 | No regulatory exposure | TODO | TODO |
| 5 | Market validation present | TODO | TODO |
| 6 | ASO entry path exists | TODO | TODO |
| 7 | Localization-as-moat OR other defensible wedge | TODO | TODO |
| 8 | Privacy / ethical posture clean | TODO | TODO |
| 9 | Multi-market same-template fit | TODO | TODO |

## 5. Business archetype

Pick one (delete the others):

- (a) free + IAP
- (b) paid one-time
- (c) subscription

TODO: justify the pick in 1-2 sentences.

## 6. ASO keywords

TODO: 5 primary + 9 secondary = 14 total. Mix localized + English where relevant.

- Primary 1: TODO
- Primary 2: TODO
- Primary 3: TODO
- Primary 4: TODO
- Primary 5: TODO
- Secondary 1: TODO
- Secondary 2: TODO
- Secondary 3: TODO
- Secondary 4: TODO
- Secondary 5: TODO
- Secondary 6: TODO
- Secondary 7: TODO
- Secondary 8: TODO
- Secondary 9: TODO

## 7. AI hook decision

Pick one (delete the other) and name the SDK / model:

- **On-device**: TODO (e.g. CoreML, MLKit, on-device Whisper)
- **Cloud**: TODO (e.g. hosted LLM via your own Worker / API gateway)

TODO: justify the pick. Cost ceiling per user / month?

## 8. Risk threshold compatibility

Match the candidate against your portfolio thresholds. Fail any row → reconsider.

| Threshold | Limit | Candidate value | Status |
|---|---|---|---|
| Max concurrent markets | TODO | TODO | TODO |
| Capital per app validation | TODO | TODO | TODO |
| Language quality minimum | TODO | TODO | TODO |
| Kill ROAS d7 | TODO | TODO | TODO |
| Double-down ROAS d14 | TODO | TODO | TODO |
| Max portfolio apps | TODO | TODO | TODO |

## 9. Kill criteria (J60)

Adjust the example numbers to your portfolio economics.

- < $X MRR by day 60 → kill, write postmortem
- $X – $Y MRR by day 60 → maintenance only (no further investment)
- > $Y MRR by day 60 → portfolio winner, double down on paid acquisition

J90 race-window check: if a comparable competitor launched within the last 90 days, document their position + your wedge differentiation.

## 10. Out of scope (v0)

TODO: enumerate the deferred features that explicitly do NOT ship in v0. This is a contract with your future self.

- TODO
- TODO
- TODO

## 11. Founder signoff

GO / NO-GO: ___ (signed: ___, date: ___)
`;
