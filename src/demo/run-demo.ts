import snapshot from "./snapshot-data.json" with { type: "json" };

interface DemoCandidate {
  rank: number;
  appName: string;
  store: "apple" | "google";
  market: string;
  category: string;
  estimatedRevenueUsd: number;
  localizationGap: number;
  paywallComplexity: number;
  compositeScore: number;
  reasoning: string;
}

interface DemoSnapshot {
  generatedAt: string;
  marketsScanned: number;
  candidatesEvaluated: number;
  topCandidates: DemoCandidate[];
}

export async function runDemo(opts: { format: "markdown" | "json" }): Promise<void> {
  const data = snapshot as DemoSnapshot;
  if (opts.format === "json") {
    process.stdout.write(JSON.stringify(data, null, 2) + "\n");
    return;
  }
  process.stdout.write(renderMarkdownBrief(data));
}

function renderMarkdownBrief(data: DemoSnapshot): string {
  const lines: string[] = [];
  lines.push(`# Selection Agent — Demo Brief`);
  lines.push(``);
  lines.push(`> Cached snapshot generated ${data.generatedAt}.`);
  lines.push(`> ${data.candidatesEvaluated} candidates evaluated across ${data.marketsScanned} markets.`);
  lines.push(``);
  lines.push(`## Top ${data.topCandidates.length} candidates`);
  lines.push(``);
  lines.push(`| # | App | Store | Market | Category | Est. revenue | Loc gap | Paywall | Score |`);
  lines.push(`|---|---|---|---|---|---|---|---|---|`);
  for (const c of data.topCandidates) {
    lines.push(
      `| ${c.rank} | **${c.appName}** | ${c.store} | ${c.market} | ${c.category} | $${c.estimatedRevenueUsd.toLocaleString()} | ${c.localizationGap}/10 | ${c.paywallComplexity}/10 | ${c.compositeScore.toFixed(2)} |`,
    );
  }
  lines.push(``);
  lines.push(`## Reasoning highlights`);
  lines.push(``);
  for (const c of data.topCandidates) {
    lines.push(`### ${c.rank}. ${c.appName}`);
    lines.push(c.reasoning);
    lines.push(``);
  }
  lines.push(`---`);
  lines.push(`Run \`selection-agent scan\` for a live ranking once milestone M2+ lands.`);
  lines.push(``);
  return lines.join("\n");
}
