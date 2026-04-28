export interface AgentError {
  code: string;
  message: string;
  cause: string;
  fix: string;
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
    paint(`  fix:   ${err.fix}`, CYAN),
  ];
  if (err.docs) {
    lines.push(paint(`  docs:  ${err.docs}`, CYAN));
  }
  return lines.join("\n");
}
