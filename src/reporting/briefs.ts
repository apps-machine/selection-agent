import type { RankedCandidate, ScanResult } from "../orchestrator/types.ts";

/**
 * Markdown founder brief. Pinned via `briefs.golden.test.ts` —
 * intentional output is golden-tested; any drift is a deliberate
 * format change that requires re-snapshot.
 */
export function generateBrief(result: ScanResult): string {
  const lines: string[] = [];
  const isoDay = result.generatedAt.slice(0, 10);
  lines.push(`# Selection Agent — Scan ${isoDay}`);
  lines.push("");
  lines.push(
    `**Markets**: ${result.markets.join(", ")}  |  ` +
      `**Apps scanned**: ${result.appsScanned}  |  ` +
      `**Cost**: $${result.costUsd.toFixed(2)}`,
  );
  lines.push("");
  lines.push(`## Top ${result.candidates.length} candidates`);
  lines.push("");

  if (result.candidates.length === 0) {
    lines.push("_No candidates passed scoring this run._");
    lines.push("");
  } else {
    for (const c of result.candidates) {
      lines.push(...renderCandidate(c));
    }
  }

  if (result.failedSlices.length > 0) {
    lines.push("---");
    lines.push("");
    lines.push("### Failed slices (skipped, no candidates)");
    lines.push("");
    for (const f of result.failedSlices) {
      lines.push(`- ${f.store} / ${f.market} — ${f.reason}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function renderCandidate(c: RankedCandidate): string[] {
  const lines: string[] = [];
  const { app } = c;
  const composite = c.composite.composite.toFixed(2);
  lines.push(
    `### #${c.rank} — ${app.name} (${app.store}, ${app.market}) — composite ${composite}/10`,
  );
  lines.push("");

  const locReason = c.textJudge?.reasoning ?? "heuristic only — no text judge run";
  lines.push(
    `- **Localization gap**: ${c.composite.breakdown.locGap.toFixed(1)}/10 (${oneLine(locReason)})`,
  );

  if (c.visionJudge !== null) {
    lines.push(
      `- **Cultural fit (vision)**: ${c.visionJudge.culturalFitScore.toFixed(1)}/10 (${oneLine(c.visionJudge.reasoning)})`,
    );
  } else {
    const reason =
      app.screenshotUrls.length === 0
        ? "no vision judge — empty screenshots"
        : "no vision judge — judge skipped or errored";
    lines.push(`- **Cultural fit (vision)**: n/a (${reason})`);
  }

  lines.push(
    `- **Revenue est**: ${c.composite.breakdown.revenue.toFixed(1)}/10 ` +
      `(${app.ratingsCount ?? 0} ratings, market ${app.market})`,
  );
  lines.push(`- **Paywall complexity**: ${c.composite.breakdown.paywall.toFixed(1)}/10`);

  const velocityCell =
    c.composite.breakdown.velocity === null
      ? "scaffolding (J0/14)"
      : `${c.composite.breakdown.velocity.toFixed(1)}/10`;
  lines.push(`- **Velocity**: ${velocityCell}`);

  const conf = meanConfidence(c);
  lines.push(`- **Confidence**: ${conf === null ? "n/a" : conf.toFixed(2)}`);

  const link = appStoreLink(app.store, app.appId, app.market);
  lines.push(`- App Store: ${link}`);
  lines.push("");
  return lines;
}

function meanConfidence(c: RankedCandidate): number | null {
  const xs: number[] = [];
  if (c.textJudge !== null) xs.push(c.textJudge.confidence);
  if (c.visionJudge !== null) xs.push(c.visionJudge.confidence);
  if (xs.length === 0) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function appStoreLink(store: "apple" | "google", appId: string, market: string): string {
  if (store === "apple") {
    return `https://apps.apple.com/${market}/app/id${appId}`;
  }
  return `https://play.google.com/store/apps/details?id=${appId}&gl=${market}`;
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}
