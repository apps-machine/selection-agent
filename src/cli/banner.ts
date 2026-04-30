import pkg from "../../package.json" with { type: "json" };

/**
 * Single source of truth for the displayed CLI version. Read from
 * package.json so a version bump in the package metadata automatically
 * flows to the banner + citty meta + every printed brief.
 */
export const VERSION: string = pkg.version;

/**
 * Branded ASCII banner shown once per CLI invocation, before citty parses
 * argv. That means the FIRST thing a `npx @apps-machine/selection-agent`
 * user sees — including the no-arg help screen — is the brand. JSON
 * output skips the banner (see shouldShowBanner in cli/index.ts) so
 * machine consumers get pure JSON.
 */
export function renderBanner(): string {
  const lines: string[] = [];
  lines.push("");
  lines.push("  ▄▀█ █▀▄▀█        APPS MACHINE");
  lines.push(`  █▀█ █░▀░█        selection-agent · v${VERSION} · MIT`);
  lines.push("");
  lines.push("  Rank app cloning opportunities globally");
  lines.push("  https://github.com/apps-machine/selection-agent");
  lines.push("");
  return lines.join("\n");
}
