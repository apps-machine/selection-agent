import pkg from "../../package.json" with { type: "json" };

/**
 * Single source of truth for the displayed CLI version. Read from
 * package.json so a version bump in the package metadata automatically
 * flows to the banner + citty meta + every printed brief.
 */
export const VERSION: string = pkg.version;

/**
 * Branded ASCII banner shown at the top of every markdown CLI output
 * (demo + scan). JSON output skips the banner so machine consumers get
 * pure JSON.
 *
 * Design intent: compact (under 60 chars wide so it fits any default
 * terminal), branded enough to feel like a tool, not a prototype. The
 * "AM" monogram doubles as the logo without claiming to be art.
 *
 * The block-letter glyphs render as plain ASCII in any terminal. We
 * deliberately do NOT wrap in a markdown code fence: terminal users
 * (the primary consumer of `npx ... demo`) would see literal triple-
 * backticks, which look noisier than the glyphs themselves.
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
