# Discovery methodology — list the takeable, don't predict the future

> Operational runbook for picking the next mobile app to clone — with empirical
> evidence, explicit kill criteria, and a fixed time + budget envelope per cycle.

---

## Status

| Field | Value |
|---|---|
| Methodology version | 1.0 |
| Status | Active — productized in `@apps-machine/selection-agent` v0.11.0+ |
| Runtime envelope target | ≤5h human time + ≤$50 LLM/data budget per cycle |
| Audience | Solo indie operators building a portfolio of mobile apps |

---

## Core principle

**List the takeable. Don't predict the future.**

Two consecutive empirical investigations on tier-2 SEA mobile-app data (2026)
established that public chart + metadata signals do not support a predictive
ranker for 90-day-forward retention beyond the trivial "current rank predicts
future rank" baseline. Current rank at t0 saturates the prediction problem
at top-decile precision under short horizons; layered factor stacks (tenure,
cross-market spread, IAP shape, publisher tenure, rank stability, rank
trajectory) all show negative residualized lift over current-rank-alone.

The operator-correct framing is therefore:

> "Of the apps that ARE durably winning RIGHT NOW, which subset is clonable by
> a solo indie operator at modest budget?"

This is a **filtering + ranking problem on observed winners**, not a
**prediction problem on hidden signal**. The methodology in this document
implements that filter end-to-end.

The implication for tooling: we don't need a fancy ML model. We need a
five-stage data pipeline that (a) audits the inputs, (b) filters by
durability + cross-market presence + monetization, (c) classifies each
candidate's clonability via an LLM that reads title + description +
publisher, (d) hands the filtered shortlist to the operator, and (e)
generates a dossier scaffold that the operator signs GO/NO-GO.

---

## When to run discovery

- A portfolio slot opens (an app shipped, was killed, graduated, or its
  dossier was rejected before build).
- You ask "what should I build next?".
- Quarter-end portfolio review.
- After a kill criterion fires on an existing app.

## When NOT to run

- Mid-build for an existing app — feature requests go to that app's spec
  document under a `Backlog (post-v1)` section.
- During a race-window closure on an existing app — focus on incumbent
  defense first.
- When your chart-snapshot data is more than 90 days stale — refresh the
  ingest first.

---

## Inputs (must have before starting)

| Input | Source | Verification |
|---|---|---|
| Chart-rank time series ≥365 days, target markets, both stores | Your sqlite cache `chart_snapshots` table | `selection-agent audit` (Stage 1) |
| App invariants (publisher_id, release_date) | `app_invariants` table populated from a metadata dump | `selection-agent audit` (Stage 1) |
| Risk thresholds (your own risk tolerances, encoded as JSON) | A `thresholds.json` you author once | Schema documented in `RiskThresholdsSchema` (library API) |
| Existing portfolio status | Your project tracker | Manual check |
| `ANTHROPIC_API_KEY` | https://console.anthropic.com/settings/keys | `[ -n "$ANTHROPIC_API_KEY" ]` after sourcing your `.env` |

If any input is stale or missing, **stop and refresh first**. Stage 1 below
catches most input gaps.

### Note on data acquisition

This package does NOT include a chart + metadata data ingest. You are
expected to bring your own data layer. Recommended providers:

- AppTweak (paid, ~$200/mo for tier-1 plan) — pulls historical chart
  positions + metadata via REST API. The schema in `src/storage/schema.ts`
  is shaped for AppTweak-style outputs.
- Build your own daily snapshot via `selection-agent snapshot` (uses
  `app-store-scraper` + `google-play-scraper`) — accumulates forward time
  series; you'll have a meaningful window after ~3-6 months of daily runs.

The methodology is provider-agnostic. As long as you can populate
`chart_snapshots`, `app_invariants`, and a `metadata.jsonl` dossier file in
the schema this package expects, the rest works.

---

## The 5-stage procedure

```
Stage 1 — Pre-flight data audit          (selection-agent audit)
Stage 2 — Build the shortlist            (selection-agent shortlist)
Stage 3 — Cross-reference risk thresholds (selection-agent risk-check)
Stage 4 — Operator pick                  (manual — you read the shortlist)
Stage 5 — Dossier generation             (selection-agent dossier)
```

Each stage is independently runnable and idempotent. The output of one is
the input to the next; intermediate artifacts are written to disk so a
cycle can be paused and resumed across days.

---

## Stage 1 — Pre-flight data audit (30 minutes, MANDATORY)

This stage is **non-negotiable**. Two empirical investigations preceding
this methodology each shipped flawed verdicts on datasets that had data
flaws which 5 SQL queries would have caught:

- The first investigation shipped a thesis verdict on a dataset where one
  factor field was permanently null and silently collapsed the eligibility
  rate from 100% to 25%.
- The second investigation assumed metadata was point-in-time when it was
  not (a single-pull metadata dump replicates current state across all
  historical t0 labels).

Both errors would have been caught by an audit that took less than half an
hour to write. The audit is now codified.

### Run

```bash
selection-agent audit
# or with explicit DB and markets:
selection-agent audit --db ./.cache/selection-agent.sqlite --markets bd,th,vn,my,id
# or write the markdown report to a file:
selection-agent audit --output ./audit-report.md
```

### What the audit checks

The command runs six SQL checks against your local cache and emits a
markdown report. Each check returns PASS, WARN, or FAIL. The CLI exits 1
if any check FAILs, exits 0 otherwise.

| # | Check | What it answers |
|---|---|---|
| 1 | Chart coverage per (market, store) | Do you have ≥300 days of top-100 chart data for every target market+store? |
| 2 | Rank distribution | Does your data extend deeper than top-100, or only cover the visible top? |
| 3 | Recent-data window | Is the most recent snapshot within 90 days of today? |
| 4 | Metadata point-in-time validity | When sampling 3 multi-snapshot triples, do versions[] arrays differ across t0s? (If they don't, your metadata is duplicated, not historical.) |
| 5 | Signal-snapshots inventory | Which precomputed factors exist in your DB? |
| 6 | App-invariants coverage | What fraction of apps have publisher_id and release_date populated? |

### Hard blocks (do NOT proceed to Stage 2 if any of these fire)

- Coverage <300 days for any target market+store → refresh chart ingest.
- Metadata point-in-time check shows duplicated `versions[]` across t0s
  AND your downstream methodology depends on temporal metadata factors
  (the default Path E pipeline does not — it only uses invariants).
- `app_invariants` coverage <70% on `publisher_id` → run your invariant
  ingest before proceeding.

If a hard block fires, the resolution is one of:

- Refresh your data source with a new pull (provider-specific runbook).
- Document the gap in the dossier (Stage 5) and add it to the kill
  criteria for the picked app.

Document audit findings inline in the discovery dossier (Stage 5).

---

## Stage 2 — Build the shortlist (~1 minute pipeline runtime + LLM cost)

Stage 2 produces a ranked CSV/JSON of clonable indie portfolio candidates.
A single command runs five sequential filters plus an optional LLM
clonability classifier.

### Run

```bash
# With LLM classifier (default, requires ANTHROPIC_API_KEY):
selection-agent shortlist --markets id,vn,th,my,bd --output ./out/

# Without LLM (faster, cheaper, but keeps mega-platform false positives):
selection-agent shortlist --markets id,vn,th,my,bd --output ./out/ --no-llm

# Custom shortlist size (default 50):
selection-agent shortlist --output ./out/ --shortlist-size 100
```

Output:

- `./out/<ISO ts>/shortlist.csv` — opens in Excel/Numbers; one row per
  candidate with all evidence columns.
- `./out/<ISO ts>/shortlist.json` — structured input to Stage 3 + 5.

### The 5-filter funnel

| Step | Filter | What it removes |
|---|---|---|
| F1 (durability) | App must hold top-100 in at least one (market, store) for ≥180 cumulative days within the trailing year | flash-in-the-pan apps; one-off marketing pushes |
| F1 rollup | Aggregate F1 hits per (app, store) so cross-market spread can be measured | denormalization step |
| F5 (cross-market) | App must be active in ≥2 tier-2 markets | single-market wins (often campaign-driven, not durable) |
| F3 (DNA-clonable) | Category/DNA class must be in the clonable set (Match, Hyper-Casual, Idle, Photo & Video, Productivity & Tools, Lifestyle, Education, Health & Fitness, etc.) | streaming, social networks, big-IP games, banking, healthcare regulated apps |
| LLM classifier | LLM reads title + description + publisher and tags `CLONE` (solo-buildable indie target) vs `SKIP` (mega-platform / regulated / brand-IP) | residual mega-apps that survived F3 (e.g., ChatGPT in "Productivity") |

### Sanity ranges for the funnel

A reference run on a tier-2 SEA cohort produced:

| Step | Count | Sanity range |
|---|---|---|
| F1 raw | 796 (app, store, market) rows | 500-1500 |
| F1 rollup | 419 (app, store) pairs | 250-700 |
| F5 (cross-market ≥2) | 172 pairs | 100-300 |
| F3 (DNA-clonable) | 66 candidates | 40-120 |
| LLM kept | 16 CLONE-tagged | 8-30 |

If the funnel is **outside** these ranges by more than 2x, investigate
before trusting the output:

| Symptom | Likely cause | Fix |
|---|---|---|
| F1 count <300 | data window too short, or markets list wrong | refresh chart data; recheck market filter |
| F1 rollup ≈ F1 raw | apps appear in only 1 (market, store) pair → too few markets active | OK if expected; surface in dossier |
| F5 collapse to <50 | apps siloed per single market → either too narrow markets or expired data | widen tier-2 list to include ph/kh/mm/lk/sg |
| Clonable category drops 90%+ | dna.class_label labels missing OR universe is dominated by social/streaming | check metadata coverage; widen the clonable DNA set |
| LLM kept count 0 | prompt too strict OR genuinely no clonable opportunities this cycle | review 5 SKIP examples; if false-negatives, soften prompt; else accept verdict |
| LLM kept count >40 | prompt too loose | tighten — add more mega-brand exclusion examples |

### Cost envelope

LLM classifier cost is bounded at well under $1 per cycle on a
typical-size funnel (60-150 candidates × Sonnet-class judge × ~500 tokens
per candidate). The shortlist pipeline itself is pure-SQL and runs in
under a minute.

---

## Stage 3 — Cross-reference candidates with risk thresholds (15 minutes)

Stage 3 annotates the shortlist with PASS/WARN/FAIL/INFO per check
against your operator-supplied thresholds JSON.

### Run

```bash
selection-agent risk-check \
  --shortlist ./out/<ISO ts>/shortlist.json \
  --thresholds ./my-thresholds.json \
  --output ./out/<ISO ts>/risk-check.json \
  --format json
```

### What thresholds you author

Author a `thresholds.json` once and reuse it across cycles. Partial JSON
is fine; defaults fill missing fields. The full schema lives in
`RiskThresholdsSchema` (importable as a library API).

```json
{
  "maxConcurrentMarkets": 3,
  "minTenureDays": 180,
  "requireSubscriptionIap": false,
  "supportedMarkets": ["id", "vn", "th", "my", "bd", "us", "gb"],
  "clonableDnaClasses": [
    "Photo & Video",
    "Productivity & Tools",
    "Lifestyle",
    "Education",
    "Health & Fitness"
  ]
}
```

### What the 5 checks evaluate

| Check | Question |
|---|---|
| `markets_spread` | Is the candidate active in at least `maxConcurrentMarkets` markets? |
| `tenure` | Did the candidate hold top-100 for at least `minTenureDays` days in its best market? |
| `subscription_iap` | Does the candidate have a subscription IAP? (Informational unless `requireSubscriptionIap: true`.) |
| `supported_markets` | Are all of the candidate's `markets_active` in your `supportedMarkets` set? |
| `clonable_dna` | Is the candidate's DNA class in your `clonableDnaClasses` set? |

Each check returns PASS, WARN, FAIL, or INFO. An aggregate verdict per
candidate is computed as the worst non-INFO status. INFO checks (e.g.
informational subscription check when `requireSubscriptionIap: false`)
do not contribute to the aggregate.

### Reading the output

The annotated JSON contains a `summary` block with PASS/WARN/FAIL counts
and a `candidates[]` array where each row carries a `verdict` field plus
per-check `checks[]`. CSV format flattens this for easy spreadsheet
review.

Apps that fail ≥1 check get demoted to "watchlist" — re-evaluate next
cycle, don't kill permanently. Apps that PASS all 5 checks are ready for
Stage 4.

---

## Stage 4 — Operator pick (10 minutes)

This stage is **manual on purpose**. The shortlist plus the risk-check
annotation gives you the objective information; the pick itself is your
taste call.

### Decision ergonomics

- The shortlist CSV opens in Numbers/Excel. A 50-row shortlist reads in
  under 5 minutes.
- If two candidates feel equally strong, pick the one with broader
  market spread (more durable cross-region validation). The Stage 2
  pipeline already ranks on this.
- If you have prior product taste or experience that matches a
  candidate's archetype, that's a tiebreaker. ("Build for problems you
  yourself have" — Pieter Levels.)
- Reject reasons must be logged for the next discovery cycle (avoids
  re-evaluating the same candidate over and over).

### Output

Pick the slug for the picked app. Slug rules:

- Short (≤12 chars).
- Brandable (pronounceable, no clash with existing trademarks).
- Pronounceable in your target markets.
- No ambiguity with the candidate you cloned (don't name yours after theirs).

---

## Stage 5 — Generate the dossier (30-60 minutes)

The dossier is the audit trail of Stages 1-4 plus your subjective
opportunity statement and kill criteria. It signs GO/NO-GO and feeds
your spec / build pipeline.

### Run

```bash
selection-agent dossier \
  --shortlist ./out/<ISO ts>/shortlist.json \
  --candidate <app_id>:<store> \
  --slug <name> \
  --output ./apps/<slug>/docs/discovery/<YYYY-MM-DD>-<slug>.md
```

The candidate ref form is `<app_id>:<store>`, where store is `apple` or
`googleplay`. App IDs may contain dots (e.g.
`com.example.app:googleplay`) — only the LAST colon is the separator.

### Custom templates

Pass `--template <path>` to use your own dossier markdown template. The
default template (`DEFAULT_DOSSIER_TEMPLATE`) ships with the package and
covers:

1. Front matter (slug, date, source, candidate ref, verdict)
2. Candidate evidence (auto-populated from the shortlist row)
3. Opportunity statement (placeholder — you write 1 paragraph)
4. 9 strategic filters (PASS/FAIL each, with reasoning)
5. Business archetype (free + IAP / paid one-time / subscription)
6. ASO keywords (you fill in 5 primary + 9 secondary)
7. AI hook decision (on-device named SDK/model OR external API call)
8. Design archetype tag (Keepsake / Utility / Data-heavy / AI Utility / Premium B2C / Kids)
9. Risk thresholds compatibility table
10. Kill criteria (J60 + J90 — see below)
11. Out-of-scope (v0)
12. Operator signoff line

Templates use mustache-style `{{token}}` substitution. Available tokens:

- `{{slug}}` — your app slug
- `{{date}}` — today's date (YYYY-MM-DD)
- `{{shortlist_source}}` — the path to the source shortlist
- `{{candidate.app_id}}`, `{{candidate.store}}`, `{{candidate.title}}`,
  `{{candidate.publisher_name}}`, `{{candidate.publisher_app_count}}`,
  `{{candidate.dna_class}}`, `{{candidate.dna_subclass}}`,
  `{{candidate.markets_active}}`, `{{candidate.tenure_days_max}}`,
  `{{candidate.best_rank}}`, `{{candidate.has_subscription_iap}}`,
  `{{candidate.iap_count}}`, `{{candidate.score}}`,
  `{{candidate.clonability_hypothesis}}`

### The 9 strategic filters (placeholder section)

You fill these in with PASS/FAIL each:

1. **Solo-buildable in 4 weeks** — can one operator ship v1 in a month?
2. **No content licensing dependencies** — no music, books, or video
   library required.
3. **No network-effect lock-in** — the value doesn't depend on other
   users being on the same app.
4. **No regulatory exposure** — no banking, healthcare, gambling
   licensing; no children-data exposure outside COPPA/GDPR-K trivial.
5. **Market validation present** — reference apps in the shortlist with
   working sub IAP confirm the monetization model.
6. **ASO entry path exists** — there is at least one keyword opportunity
   with KD<20 in the target market(s).
7. **Localization-as-moat OR other defensible wedge** — the picked app
   has a clear reason it can hold against the original incumbent.
8. **Privacy/ethical posture clean** — you would be comfortable using
   this app yourself + recommending it to family.
9. **Multi-market same-template fit** — the same codebase ships to ≥2
   markets without per-market forks.

### Kill criteria framework (J60 + J90)

The dossier must include explicit numeric kill criteria the operator
agreed to ex-ante. The framework:

- **J60 (60 days post-launch):**
  - Below threshold A → kill.
  - Between threshold A and B → maintenance mode (keep alive, don't
    invest more).
  - Above threshold B → double down (more user acquisition, more
    feature investment, prep multi-market expansion).

- **J90 (90 days post-launch):**
  - Race-window check — is the original incumbent investing in
    countering your wedge? If yes, escalate or pivot. If no, the wedge
    is durable.

Numeric thresholds for A and B are operator-specific. A common
framework is "kill below \$X MRR, maintain \$X-Y MRR, double-down
above \$Y MRR" with X and Y chosen so the kill threshold reflects your
true cost of carry per app and the double-down threshold reflects your
opportunity cost of not investing the time elsewhere.

These thresholds belong in your `risk-thresholds.json` (or a per-app
extension thereof) BEFORE the discovery cycle starts. **Editing them
after seeing candidate outcomes is post-hoc rationalization** (see
anti-pattern A5 below).

### Operator signoff

The dossier ends with an explicit GO line. Once signed, the dossier is
the input to your spec / build pipeline. Until signed, it's a draft.

---

## Anti-patterns (do NOT do)

These are real mistakes that pre-date this methodology. The runbook
explicitly forbids them.

### A1 — Try to predict future winners from public chart + metadata

Two empirical investigations on tier-2 SEA mobile-app data established
this is exhausted. Current rank at t0 saturates the prediction problem
at top-decile precision under short horizons; layered factor stacks all
show negative residualized lift.

Any discovery cycle that resurrects "predictive ranking" is **out of
scope** for this methodology. New thesis tests must have their own
design doc and adversarial review before running.

### A2 — Trust metadata as temporally valid

A single-pull metadata dump (the typical AppTweak / SimilarWeb
historical pull shape) replicates current state across all historical
t0 labels. Verified empirically — only `release_date` and
`publisher_id` are usable as temporal invariants.

Any factor depending on temporal metadata drift (rating drift, version
cadence, IAP changes) is uncomputable from this data shape. Either pay
for date-stamped re-pulls (some providers expose `as_of_date`) or drop
the factor.

### A3 — Skip the Stage 1 pre-flight audit

Two consecutive thesis-test failures had data flaws that 5 SQL queries
would have caught. Stage 1 takes 30 minutes; it has saved >40 hours of
wasted analysis cumulatively.

**Non-negotiable. Run it every cycle.**

### A4 — Use `publisher_app_count` as the indie filter

A typical metadata universe is biased toward whatever cohort you pulled
for. If you pulled SEA-cohort apps, then mega-apps (ChatGPT, Canva,
Google One, CapCut) appear with `publisher_app_count = 1` because you
have only their flagship in metadata. The filter is broken by sampling
bias.

**Use the LLM classifier instead** — it sees title + description +
publisher_name and correctly tags MEGA-PLATFORM vs INDIE-CLONABLE.

### A5 — Pre-register kill criteria after seeing the shortlist

Kill criteria belong in your thresholds JSON BEFORE the discovery cycle
starts. Editing them after seeing candidate outcomes is post-hoc
rationalization (the Harvey-Liu-Zhu factor zoo problem applies here
too).

### A6 — Skip adversarial review on new methodology

If you're modifying the methodology (new factor, new filter, new
outcome variable), the modified methodology gets a second-opinion
review pass before running. The two thesis-test failures collectively
absorbed 26+ findings during their adversarial reviews; without those
reviews, more cycles would have shipped flawed verdicts.

A useful default: run the modified methodology design through a
different LLM (or a different model from the same provider) and ask it
to find faults before you commit to a run.

### A7 — Run discovery with stale data

If your `chart_snapshots.MAX(captured_at)` is more than 90 days old,
refresh the ingest first. The cross-market and tenure math depends on
recent rank trajectories; a 6-month-old snapshot will surface apps that
have already declined.

---

## Outputs (what you keep)

| File | Content | Lifetime |
|---|---|---|
| `./out/<ISO ts>/shortlist.{csv,json}` | Ranked candidates with clonability hypotheses | Immutable archive |
| `./out/<ISO ts>/risk-check.json` | Annotated shortlist with PASS/WARN/FAIL per check | Immutable archive |
| `apps/<slug>/docs/discovery/<date>-<slug>.md` | Signed dossier for picked candidate | Immutable until kill |

The dossier is the input to your spec / build / ship pipeline. The
shortlist + risk-check archives are evidence for retros: which
candidates did you reject? Why? Did you reconsider any of them later?

---

## Lessons learned (curated empirical findings)

These are the empirical findings that shaped the current methodology.

- **Localization-quality alone does not predict portfolio survival in
  tier-2 SEA.** A 70-cohort backtest of a single-factor "localization
  gap" thesis returned negative residualized lift across all tested
  horizons. Implication: never include localization-quality as a
  ranking factor in a predictive ranker. (It can still be a Stage 4
  taste input — a strong loc gap is one signal that the incumbent is
  sleeping on a market.)

- **Additive linear factor stacks (current rank + 7 chart-derived
  factors) do not beat current-rank-alone on 90-day-forward retention.**
  Verified across multiple horizon windows on a tier-2 SEA cohort.
  Implication: prediction-from-signals is exhausted on this data shape.
  Switch to the filter-and-rank-the-takeable framing this document
  describes.

- **Metadata.jsonl from a single provider pull is NOT temporally
  valid.** It replicates current state across all historical t0 labels.
  Only `release_date` and `publisher_id` survive as invariants.
  Implication: all metadata-derived factors that depend on temporal
  drift are unusable from a single-pull metadata file.

- **`publisher_app_count` heuristic for indie filter is broken by
  sampling bias.** A SEA-cohort metadata pull surfaces mega-apps with
  `app_count=1`. The LLM classifier with explicit MEGA-vs-INDIE prompt
  outperforms. Implication: ALWAYS run the LLM classifier as the indie
  filter.

- **The "list-the-takeable" reframe.** Two consecutive prediction
  failures led to the operator-correct framing. ~16 actionable
  candidates per cycle, in 30 seconds + ~$0.04 of LLM spend.
  Implication: this is the methodology's core procedure.

---

## When to refresh this methodology

This is a living document. Update it after each cycle if:

- A new anti-pattern emerges (add to "Anti-patterns" section).
- A new lesson is learned (add to "Lessons learned" section).
- The shortlist funnel changes shape (update Stage 2 sanity ranges).
- Threshold defaults change (update the schema + this doc together).

Major revisions (new stages, dropped stages, new core principle)
deserve a full design doc + adversarial review pass before lock.

---

## Citations

The empirical findings cited above come from a tier-2 SEA mobile-app
data analysis conducted in 2026. The full analysis (factor design,
backtest harness, verdict tables, paired-comparison deltas) is
forthcoming as a long-form post:

- https://apps-machine.dev/posts/discovery-methodology *(forthcoming)*

The methodology in this document is the productized output of those
findings. The package's CLI commands implement Stages 1, 2, 3, and 5
directly; Stage 4 is intentionally manual.
