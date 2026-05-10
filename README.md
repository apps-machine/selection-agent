# @apps-machine/selection-agent

> Empirical mobile-app discovery for solo indie portfolio operators. Ranks
> the apps that ARE durably winning right now, classifies which subset is
> clonable by a one-person team, and emits a signed dossier per candidate.

```bash
npx @apps-machine/selection-agent demo
```

Zero config, no API key. ~30 seconds to your first ranked brief from cached
data. The full pipeline is four commands; the methodology is documented at
[`docs/discovery-methodology.md`](./docs/discovery-methodology.md).

---

## What this is

A productized methodology for picking the next mobile app to clone, with
empirical evidence and explicit kill criteria. The package wraps a five-stage
discovery pipeline that:

1. **Audits** your local chart + metadata cache against six pre-flight
   checks (data coverage, point-in-time validity, app-invariants
   coverage).
2. **Filters** durable winners (≥180-day top-100 tenure × ≥2 markets ×
   clonable category × LLM-classified indie-vs-mega).
3. **Cross-references** each candidate against your operator-defined risk
   thresholds (markets spread, tenure, IAP shape, supported locales,
   clonable DNA).
4. Hands you a ranked shortlist for the **operator pick** (manual — your
   taste call).
5. **Generates a dossier** scaffold (markdown) the operator signs GO/NO-GO.

The methodology comes out of empirical work: two consecutive predictive-ranker
investigations on tier-2 SEA mobile-app data established that public chart +
metadata signals do not support a predictive ranker beyond the trivial
"current rank predicts future rank" baseline. The operator-correct framing is
therefore "list the takeable, don't predict the future" — which is what this
package implements.

Built for solo indie operators shipping a portfolio of mobile apps. Open
core, MIT licensed.

---

## Install

```bash
npm install @apps-machine/selection-agent
# or
bun add @apps-machine/selection-agent
```

Requires [Bun](https://bun.sh) ≥ 1.0 at runtime.

---

## Quickstart (CLI)

The four-command discovery pipeline:

```bash
# Stage 1 — Pre-flight data audit (mandatory, 30s)
selection-agent audit --db ./.cache/selection-agent.sqlite

# Stage 2 — Build the shortlist (~1 min, ~$0.04 LLM spend)
selection-agent shortlist \
  --markets id,vn,th,my,bd \
  --output ./out/

# Stage 3 — Cross-reference your risk thresholds
selection-agent risk-check \
  --shortlist ./out/<ISO ts>/shortlist.json \
  --thresholds ./my-thresholds.json \
  --output ./out/<ISO ts>/risk-check.json

# Stage 5 — Generate the dossier for the picked candidate
selection-agent dossier \
  --shortlist ./out/<ISO ts>/shortlist.json \
  --candidate 544007664:apple \
  --slug myapp \
  --output ./apps/myapp/discovery.md
```

Stage 4 (operator pick) is intentionally manual — open the shortlist CSV in
Numbers/Excel, read it in 5 minutes, decide.

---

## Methodology

A 5-stage operational runbook. Full text in
[`docs/discovery-methodology.md`](./docs/discovery-methodology.md).

| Stage | Goal | Command |
|---|---|---|
| 1 — Audit | Verify chart coverage + metadata point-in-time validity + app-invariants coverage | `selection-agent audit` |
| 2 — Shortlist | 5-filter funnel (durability → cross-market → DNA-clonable → LLM indie/mega) | `selection-agent shortlist` |
| 3 — Risk check | Annotate shortlist with PASS/WARN/FAIL/INFO per operator threshold | `selection-agent risk-check` |
| 4 — Pick | Operator reads shortlist, picks 1 (manual) | — |
| 5 — Dossier | Markdown dossier scaffold ready for GO/NO-GO signoff | `selection-agent dossier` |

---

## CLI commands

### `selection-agent audit`

Stage 1 pre-flight data audit. Runs six SQL checks against your local cache
and emits a markdown report.

**Flags:**
- `--db <path>` — sqlite cache path. Defaults to `$SELECTION_AGENT_DB` or
  `./.cache/selection-agent.sqlite`.
- `--markets <ids>` — comma-separated ISO alpha-2 codes. Defaults to
  `bd,th,vn,my,id`.
- `--metadata <path>` — explicit `metadata.jsonl[.gz]` path. If omitted,
  scans `data/apptweak-*` directories under cwd.
- `--output <path>` — write the markdown report to this path. Defaults to
  stdout.

**Example:**
```bash
selection-agent audit --markets bd,th,vn,my,id --output audit.md
```

**Output shape:** Markdown report with summary table + per-check details.

**Exit codes:** `0` if all checks PASS or WARN, `1` if any check FAILs.

---

### `selection-agent shortlist`

Stage 2 shortlist generator. Runs five sequential filters plus an optional
LLM clonability classifier.

**Flags:**
- `--db <path>` — sqlite cache path.
- `--markets <ids>` — comma-separated ISO alpha-2 codes. Defaults to
  `id,vn,th,my,bd`.
- `--metadata <path>` — explicit `metadata.jsonl[.gz]` path.
- `--output <dir>` — directory for output artifacts. A timestamped
  subdirectory is created with `shortlist.csv` + `shortlist.json`. Omit
  for stdout-only summary.
- `--no-llm` — skip the LLM clonability classifier and keep all
  DNA-clonable candidates. Default: LLM enabled (requires
  `ANTHROPIC_API_KEY`).
- `--shortlist-size <n>` — final shortlist truncation size. Default 50.

**Example:**
```bash
selection-agent shortlist \
  --markets id,vn,th,my,bd \
  --output ./out/ \
  --shortlist-size 30
```

**Output shape:** A timestamped directory under `--output` containing
`shortlist.csv` (spreadsheet-ready) and `shortlist.json` (input to
risk-check + dossier). Stdout reports the funnel counts.

**Exit codes:** `0` on success, `2` on bad input, `1` on pipeline failure.

---

### `selection-agent risk-check`

Stage 3 risk-threshold annotator. Reads the shortlist JSON + a thresholds
JSON; evaluates 5 checks per candidate; emits annotated JSON or CSV.

**Flags:**
- `--shortlist <path>` — required. Path to `shortlist.json`.
- `--thresholds <path>` — required. Path to a thresholds JSON file. Partial
  JSON is fine; defaults fill in missing fields. See library API below for
  the full schema.
- `--output <path>` — write the annotated payload to this path. Defaults to
  stdout.
- `--format <json|csv>` — output format. Default `json`.

**Example:**
```bash
selection-agent risk-check \
  --shortlist ./out/2026-05-08T12-00-00Z/shortlist.json \
  --thresholds ./my-thresholds.json \
  --output ./out/2026-05-08T12-00-00Z/risk-check.json
```

**Output shape:** JSON with a `summary` block (PASS/WARN/FAIL/total) plus a
`candidates[]` array where each row carries an aggregate `verdict` plus
per-check details. CSV format flattens for spreadsheet review.

**Exit codes:** `0` if at least one candidate PASSes, `1` if none, `2` on
bad input.

---

### `selection-agent dossier`

Stage 5 dossier generator. Reads a shortlist + a candidate ref + a slug;
writes a populated markdown dossier ready for operator signoff.

**Flags:**
- `--shortlist <path>` — required. Path to `shortlist.json`.
- `--candidate <ref>` — required. `<app_id>:<store>` format (e.g.
  `544007664:apple`, `com.example.app:googleplay`). The last colon is the
  separator (so dotted package names work).
- `--slug <name>` — required. Short brand slug for the dossier title +
  default filename.
- `--template <path>` — optional path to a custom markdown template with
  mustache-style `{{token}}` placeholders. Defaults to the bundled
  `DEFAULT_DOSSIER_TEMPLATE` (12 sections).
- `--output <path>` — output path. Defaults to
  `<slug>-dossier-<YYYY-MM-DD>.md` in the current directory.

**Example:**
```bash
selection-agent dossier \
  --shortlist ./out/2026-05-08T12-00-00Z/shortlist.json \
  --candidate 544007664:apple \
  --slug myapp \
  --output ./apps/myapp/discovery.md
```

**Output shape:** Markdown file with front matter, auto-populated candidate
evidence, and placeholder `TODO:` sections for the operator to fill in
(opportunity statement, 9 strategic filters, ASO keywords, AI hook
decision, kill criteria, signoff line).

**Exit codes:** `0` on success, `1` if the candidate ref doesn't match any
shortlist row or output write fails, `2` on missing required flags or
invalid candidate ref format.

---

## Library API

For consumers using this programmatically (e.g., embedding into a
dashboard or a CI workflow), the package exports its schemas + evaluators
as a pure library:

```ts
import {
  RiskThresholdsSchema,
  evaluateShortlist,
  buildDossier,
  parseCandidateRef,
  findCandidate,
  DEFAULT_DOSSIER_TEMPLATE,
} from "@apps-machine/selection-agent";
import { readFileSync } from "node:fs";

// Parse + validate a thresholds JSON (defaults fill missing fields)
const thresholds = RiskThresholdsSchema.parse(
  JSON.parse(readFileSync("./thresholds.json", "utf8")),
);

// Annotate a shortlist
const shortlist = JSON.parse(readFileSync("./shortlist.json", "utf8"));
const annotated = evaluateShortlist(shortlist, thresholds);
console.log(`${annotated.summary.pass} of ${annotated.summary.total} pass`);

// Generate a dossier
const candidateRef = parseCandidateRef("544007664:apple");
const candidate = findCandidate(shortlist, candidateRef.app_id, candidateRef.store);
if (candidate) {
  const md = buildDossier({
    slug: "myapp",
    candidate,
    shortlistSource: "./shortlist.json",
    template: DEFAULT_DOSSIER_TEMPLATE,
  });
  console.log(md);
}
```

**Public exports:**

| Export | Kind | What it is |
|---|---|---|
| `RiskThresholdsSchema` | Zod schema | Validates a thresholds JSON; defaults fill missing fields. |
| `RiskThresholds` | Type | `z.infer<typeof RiskThresholdsSchema>`. |
| `DEFAULT_SUPPORTED_MARKETS` | const | Default supported-market ISO codes. |
| `DEFAULT_CLONABLE_DNA_CLASSES` | const | Default clonable DNA classes. |
| `evaluateCandidate` | function | Run all 5 checks on one candidate. |
| `evaluateShortlist` | function | Run all 5 checks on every candidate + summary. |
| `RiskCheckResult`, `Verdict`, `CheckStatus`, etc. | types | Result types. |
| `parseCandidateRef` | function | Parse `<app_id>:<store>` strings. |
| `findCandidate` | function | Lookup helper for shortlist arrays. |
| `buildDossier` | function | Render a markdown dossier from a candidate. |
| `DEFAULT_DOSSIER_TEMPLATE` | const | Bundled 12-section markdown template. |
| `Shortlist`, `ShortlistCandidate`, `DossierOpts` | types | I/O contracts. |

---

## Data requirements

This package operates on a local sqlite cache + an optional
`metadata.jsonl[.gz]` dossier file. The cache schema is documented in
`src/storage/schema.ts` (run `selection-agent audit` once to materialize
it). Required tables:

- `chart_snapshots` — daily top-100 ranks per (app, market, store).
- `app_invariants` — publisher_id + release_date per (app, store).
- `signal_snapshots` — precomputed factor values (created lazily).

**Bringing your own data ingest is required.** This package does NOT
include data acquisition. Recommended providers:

- **AppTweak** (paid) — pulls historical chart positions + metadata via
  REST API. The schema is shaped for AppTweak-style outputs.
- **DIY forward collection** — `selection-agent snapshot` accumulates
  daily top-100 snapshots via `app-store-scraper` and
  `google-play-scraper`. After ~3-6 months you have a meaningful window
  for the durability filter.

The methodology is provider-agnostic; bring whatever data you have, as
long as it materializes into the expected schema.

---

## Demo and ad-hoc commands

In addition to the four-command discovery pipeline, the package ships a
few utility commands for getting started and for daily data collection:

```bash
selection-agent demo                       # cached snapshot, no API key
selection-agent scan                       # live dual-store scan (heuristic + LLM judges)
selection-agent scan --no-llm              # heuristics only — skip LLM judges
selection-agent snapshot                   # daily top-100 snapshot writer (cron-friendly)
selection-agent report --compare-judges    # text vs vision judge divergence on the latest scan
selection-agent --help                     # full help
```

`scan` ranks live chart entries on a heuristic composite of localization
gap × paywall complexity × revenue × velocity, then runs Claude judges
(text + vision in parallel) on the top-N. It's useful for spot research
and for accumulating LLM-graded snapshots; the four-command discovery
pipeline above is the full methodology.

`snapshot` is a cron-friendly daily writer — run it in `launchd` /
`systemd` / cron to accumulate forward chart-rank time series in your
local sqlite cache. After enough days you can use that data instead of a
paid provider for the audit + shortlist stages.

---

## Configuration

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

| Variable | Required for | Default |
|---|---|---|
| `ANTHROPIC_API_KEY` | `shortlist` (without `--no-llm`), `scan` (without `--no-llm`) | — |
| `ANTHROPIC_TEXT_JUDGE_MODEL` | optional | `claude-sonnet-4-6` |
| `ANTHROPIC_VISION_JUDGE_MODEL` | optional | `claude-sonnet-4-6` |
| `LOG_LEVEL` | optional | `info` |
| `SELECTION_AGENT_DB` | optional | `./.cache/selection-agent.sqlite` |
| `SELECTION_AGENT_BUDGET_USD` | optional | `20` |

---

## Open-source policy

This is the OSS half of an open-core mobile-app studio. The package
itself — the methodology, the CLI, the schemas, the evaluators — is
MIT-licensed and the source of truth for the discovery procedure.

The studio's private business logic (specific risk thresholds, internal
ops pipeline, deployment infrastructure, SaaS) is **not** in this
package and never will be. If you're an indie operator running your own
portfolio, this package gives you everything you need to discover
candidates; you bring your own data, your own thresholds, your own
build pipeline.

---

## Contributing

Standard Bun + Biome + bun:test workflow:

```bash
git clone https://github.com/apps-machine/selection-agent
cd selection-agent
bun install
bun test
bun run typecheck
bun src/cli/index.ts demo
```

Pre-commit: `git config core.hooksPath .githooks` (runs `gitleaks` if
installed).

PRs welcome. Bug reports and methodology improvements are especially
welcome — empirical findings that contradict the current methodology
beat any feature.

---

## License

MIT — see [LICENSE](./LICENSE).

---

## Related

- [`@apps-machine/shared-types`](https://github.com/apps-machine/shared-types) — shared Zod schemas
- [Apps Machine org](https://github.com/apps-machine) — open-core components
