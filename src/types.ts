export type Severity = "high" | "medium" | "low" | "info";

export const SEVERITIES: readonly Severity[] = ["high", "medium", "low", "info"];

const RANK: Record<Severity, number> = { high: 3, medium: 2, low: 1, info: 0 };

export function severityRank(severity: Severity): number {
  return RANK[severity];
}

/** One level up (hidden text) or down (a less likely context), never past high or below low. */
export function shiftSeverity(severity: Severity, by: 1 | -1): Severity {
  if (severity === "info") return "info";
  const next = Math.min(3, Math.max(1, RANK[severity] + by));
  return SEVERITIES.find((s) => RANK[s] === next) ?? severity;
}

export type Category =
  | "command-execution"
  | "safety-bypass"
  | "destructive"
  | "impersonation"
  | "self-sabotage"
  | "engagement-farming"
  | "third-party"
  | "hidden-text"
  | "agent-config"
  | "policy";

export const CATEGORIES: readonly Category[] = [
  "command-execution",
  "safety-bypass",
  "destructive",
  "impersonation",
  "self-sabotage",
  "engagement-farming",
  "third-party",
  "hidden-text",
  "agent-config",
  "policy",
];

/**
 * - agent: written for agents (AGENTS.md, CLAUDE.md, .claude/, .cursor/, Copilot instructions, SKILL.md, MCP config)
 * - contributing: CONTRIBUTING, AI policy and SECURITY files
 * - template: pull request and issue templates
 * - readme: the top-level README
 */
export type FileKind = "agent" | "contributing" | "template" | "readme";

/**
 * Where a match sits:
 * - agent-file: anywhere in a file written for agents
 * - agent-section: a section or paragraph of another file that addresses agents ("Note for AI tools", "If you are an LLM")
 * - hidden: text a human reading the rendered page does not see (HTML comments, invisible Unicode)
 * - general: everything else, written for humans
 */
export type Scope = "agent-file" | "agent-section" | "hidden" | "general";

export interface SourceFile {
  /** Path relative to the scanned root, with forward slashes. */
  path: string;
  text: string;
  kind: FileKind;
  /** Web link to the file, when it came from GitHub. */
  url?: string;
  /** Problems reading the file that a reader should know about. */
  notes?: Array<"truncated" | "nul-bytes">;
}

export interface Finding {
  rule: string;
  category: Category;
  severity: Severity;
  /** What the text asks for, in a few words. */
  title: string;
  /** Extra facts, such as the command a hook runs. */
  detail?: string;
  file: string;
  line: number;
  /** The line (or part of it) that matched, with invisible characters made visible. */
  excerpt: string;
  scope: Scope;
  url?: string;
}

export interface ScannedFile {
  path: string;
  kind: FileKind;
  bytes: number;
  url?: string;
}

export interface ScanReport {
  tool: { name: string; version: string };
  target: string;
  mode: "local" | "github";
  /** Branch, tag or commit that was asked for (GitHub mode). */
  ref?: string;
  /** Commit that was scanned (GitHub mode). */
  commit?: string;
  files: ScannedFile[];
  findings: Finding[];
  summary: Record<Severity, number>;
  /** The repository's AI policy in a few words, taken from the policy findings ("agents not allowed", …). */
  aiPolicy: string[];
  warnings: string[];
}
