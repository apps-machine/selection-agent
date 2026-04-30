export interface AgentError {
  code: string;
  message: string;
  cause: string;
  /**
   * Single-line short fix, OR an array of lines for multi-step guidance
   * (commands, links, alternatives). Array form renders one line per
   * entry under the "fix:" header so users can copy-paste a real shell
   * command instead of guessing.
   */
  fix: string | string[];
  docs?: string;
}

const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

const supportsColor = process.stdout.isTTY && !process.env.NO_COLOR;

function paint(text: string, code: string): string {
  return supportsColor ? `${code}${text}${RESET}` : text;
}

export function formatError(err: AgentError): string {
  const lines = [
    paint(`✖ ${err.code}: ${err.message}`, `${BOLD}${RED}`),
    paint(`  cause: ${err.cause}`, YELLOW),
  ];
  if (Array.isArray(err.fix)) {
    lines.push(paint(`  fix:`, CYAN));
    for (const step of err.fix) {
      lines.push(paint(`    ${step}`, CYAN));
    }
  } else {
    lines.push(paint(`  fix:   ${err.fix}`, CYAN));
  }
  if (err.docs) {
    lines.push(paint(`  docs:  ${err.docs}`, CYAN));
  }
  return lines.join("\n");
}
