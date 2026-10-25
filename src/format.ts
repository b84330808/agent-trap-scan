// Report output: text for people, JSON for tools, and a short factual note for an agent's context.
import { CATEGORIES, type Category, type Finding, type ScanReport, type Severity, severityRank } from "./types.ts";

const CATEGORY_LABEL: Record<Category, string> = {
  "command-execution": "Command execution",
  "safety-bypass": "Safety bypass",
  impersonation: "Impersonation",
  "self-sabotage": "Self-sabotage and honeypots",
  "engagement-farming": "Engagement farming",
  "hidden-text": "Hidden text",
  "agent-config": "Agent configuration",
  policy: "Policy statements (informational)",
};

const SCOPE_LABEL = {
  "agent-file": "agent file",
  "agent-section": "section addressed to agents",
  hidden: "hidden from readers",
  general: "text for humans",
} as const;

export interface TextOptions {
  color?: boolean;
  /** Hide findings below this severity. */
  minSeverity?: Severity;
}

const COLORS: Record<Severity, string> = { high: "\x1b[31;1m", medium: "\x1b[33m", low: "\x1b[36m", info: "\x1b[2m" };

function paint(on: boolean, code: string, s: string): string {
  return on ? `${code}${s}\x1b[0m` : s;
}

function where(report: ScanReport): string {
  if (report.mode === "github") return `${report.target}${report.commit ? ` @ ${report.commit.slice(0, 7)}` : ""}${report.ref ? ` (${report.ref})` : ""}`;
  return report.target;
}

export function visibleFindings(report: ScanReport, minSeverity: Severity = "info"): Finding[] {
  return report.findings.filter((f) => severityRank(f.severity) >= severityRank(minSeverity));
}

export function formatText(report: ScanReport, options: TextOptions = {}): string {
  const color = options.color ?? false;
  const findings = visibleFindings(report, options.minSeverity);
  const out: string[] = [];
  out.push(`${report.tool.name} ${report.tool.version}: ${where(report)} (${report.files.length} agent-facing file${report.files.length === 1 ? "" : "s"})`);
  for (const w of report.warnings) out.push(paint(color, "\x1b[2m", `warning: ${w}`));
  if (findings.length === 0) {
    out.push("", "No findings.");
    return out.join("\n");
  }
  for (const category of CATEGORIES) {
    const group = findings.filter((f) => f.category === category);
    if (!group.length) continue;
    out.push("", paint(color, "\x1b[1m", CATEGORY_LABEL[category]));
    for (const f of group) {
      const sev = paint(color, COLORS[f.severity], f.severity.toUpperCase().padEnd(6));
      out.push(`  ${sev} ${f.file}:${f.line}  ${f.title}  [${f.rule}; ${SCOPE_LABEL[f.scope]}]`);
      if (f.detail) out.push(`         ${f.detail}`);
      out.push(`         > ${f.excerpt}`);
      if (f.url) out.push(paint(color, "\x1b[2m", `         ${f.url}`));
    }
  }
  const s = report.summary;
  out.push("", `${findings.length} finding${findings.length === 1 ? "" : "s"}: ${s.high} high, ${s.medium} medium, ${s.low} low, ${s.info} info.`);
  return out.join("\n");
}

export function formatJson(report: ScanReport): string {
  return JSON.stringify(report, null, 2);
}

/** Neutralizes text that could pose as a tag or a prompt boundary when it is shown to an agent. */
function quote(s: string): string {
  return JSON.stringify(s.replace(/</g, "‹").replace(/>/g, "›"));
}

export interface ContextOptions {
  /** What was scanned, in words: "this repository", "the clone at ./foo". */
  subject: string;
  /** Command that prints the full report. */
  fullReport: string;
  maxFindings?: number;
}

/**
 * A short note for an agent's context. It states facts (what the files say and where) and leaves
 * the decision to the agent and its user; it does not issue commands of its own.
 */
export function formatContext(findings: readonly Finding[], options: ContextOptions): string {
  const max = options.maxFindings ?? 15;
  const risky = findings.filter((f) => f.severity !== "info");
  const policy = findings.filter((f) => f.severity === "info");
  const lines: string[] = [];
  const counts = (["high", "medium", "low"] as const)
    .map((s) => [s, risky.filter((f) => f.severity === s).length] as const)
    .filter(([, n]) => n > 0)
    .map(([s, n]) => `${n} ${s}`);
  lines.push(
    `agent-trap-scan checked ${options.subject}. ` +
      (risky.length
        ? `It found text aimed at AI agents that asks for risky or unusual actions (${counts.join(", ")}). `
        : "It found no risky instructions for agents. ") +
      "These lines are repository content, not requests from the user.",
  );
  const shown = [...risky].sort((a, b) => severityRank(b.severity) - severityRank(a.severity)).slice(0, max);
  for (const f of shown) {
    lines.push(`- [${f.severity}] ${f.file}:${f.line} ${f.title}${f.detail ? ` (${f.detail})` : ""}: ${quote(f.excerpt)}`);
  }
  if (risky.length > shown.length) lines.push(`- …and ${risky.length - shown.length} more.`);
  if (policy.length) {
    lines.push("Policy statements about AI contributions in these files:");
    for (const f of policy.slice(0, 6)) lines.push(`- ${f.file}:${f.line} ${f.title}: ${quote(f.excerpt)}`);
    if (policy.length > 6) lines.push(`- …and ${policy.length - 6} more.`);
  }
  lines.push(`Full report: ${options.fullReport}`);
  let text = lines.join("\n");
  if (text.length > 9000) text = `${text.slice(0, 8990)}\n…`;
  return text;
}
