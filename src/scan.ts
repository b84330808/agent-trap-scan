// Runs the rules over the agent-facing files of a repository.
import { configFindings } from "./config.ts";
import { NEGATION, RULES, type Rule } from "./rules.ts";
import { addressesAgents, analyze, lineIndexAt, type Analysis } from "./text.ts";
import { type Finding, type Scope, type Severity, type SourceFile, SEVERITIES, severityRank, shiftSeverity } from "./types.ts";
import { findInvisible, revealInvisible } from "./unicode.ts";

export interface ScanOptions {
  /** Rule ids to skip. */
  ignore?: readonly string[];
}

/** Policy statements tend to repeat; report the first few per file and rule. */
const MAX_INFO_PER_RULE = 2;

const EXCERPT_MAX = 180;

function excerptOf(line: string, column: number): string {
  let s = line;
  let start = 0;
  if (s.length > EXCERPT_MAX) {
    start = Math.max(0, Math.min(column - 60, s.length - EXCERPT_MAX));
    s = s.slice(start, start + EXCERPT_MAX);
  }
  s = s.replace(/\s+/g, " ").trim();
  if (start > 0) s = `…${s}`;
  if (start + EXCERPT_MAX < line.length) s = `${s}…`;
  return revealInvisible(s);
}

function lineText(source: string, a: Analysis, index: number): string {
  const start = a.lineStarts[index]!;
  const next = a.lineStarts[index + 1];
  return source.slice(start, next === undefined ? source.length : next - 1);
}

const CLAUSE_BREAK = /[.;!?,]\s|[([]|\s[-–—]\s|^\s*(?:[-*+>]|\d+[.)])\s/g;

/** The part of the line from the last clause break up to the match. */
function clauseBefore(line: string, column: number): string {
  const before = line.slice(0, column);
  let cut = 0;
  for (const m of before.matchAll(CLAUSE_BREAK)) cut = m.index + m[0].length;
  return before.slice(cut);
}

/** "Never run this:" followed by a code block or list: the lead-in negates what follows. */
function negatedByLeadIn(source: string, a: Analysis, index: number): boolean {
  let seen = 0;
  for (let i = index - 1; i >= 0 && seen < 4; i--) {
    const t = lineText(source, a, i).trim();
    if (!t || /^(`{3,}|~{3,})/.test(t)) continue;
    seen++;
    if (/:\s*$/.test(t)) return NEGATION.test(t);
    if (!/^([-*+]|\d+[.)])\s|^\$|^>/.test(t)) return false;
  }
  return false;
}

interface Hit {
  rule: Rule;
  severity: Severity;
  scope: Scope;
  line: number;
  excerpt: string;
}

type Address = "strong" | "loose" | null;

function addressOf(body: string): Address {
  if (addressesAgents(body)) return "strong";
  const agentWord = /\b(?:AI|LLMs?|agents?|assistants?|Claude|Copilot|Cursor|Codex|ChatGPT|Gemini|language\s+models?)\b/i;
  const imperative = /\b(?:must|should|always|never|do\s+not|don'?t|please|ensure|make\s+sure|remember|you|your)\b/i;
  return agentWord.test(body) && imperative.test(body) ? "loose" : null;
}

function ruleHits(file: SourceFile, a: Analysis, rule: Rule, regionAddress: Address[]): Hit[] {
  const hits: Hit[] = [];
  const views: Array<[string, boolean]> = [[a.visible, false]];
  if (a.hiddenRegions.length) views.push([a.hidden, true]);
  for (const [source, isHidden] of views) {
    for (const pattern of rule.patterns) {
      pattern.lastIndex = 0;
      for (const m of source.matchAll(pattern)) {
        const index = lineIndexAt(a.lineStarts, m.index);
        const line = lineText(source, a, index);
        const column = m.index - a.lineStarts[index]!;
        if (rule.context && !rule.context.some((re) => re.test(line))) continue;
        if (rule.unlessLine?.test(line)) continue;
        if (rule.filter && !rule.filter(m[0])) continue;
        const clause = clauseBefore(line, column);
        if (rule.negatable !== false && (NEGATION.test(clause) || negatedByLeadIn(source, a, index))) continue;
        if (rule.unlessBefore?.test(clause)) continue;

        let scope: Scope;
        let severity: Severity = rule.severity;
        if (isHidden) {
          // Outside agent files, a hidden comment counts as agent text only when it speaks to agents.
          const region = a.hiddenRegions.findIndex((r) => m.index >= r.start && m.index < r.end);
          if (file.kind !== "agent" && !regionAddress[region] && !rule.general) continue;
          scope = "hidden";
          severity = shiftSeverity(severity, 1);
        } else if (file.kind === "agent") scope = "agent-file";
        else if (a.agentLines[index]) scope = "agent-section";
        else {
          if (!rule.general) continue;
          scope = "general";
          severity = rule.general;
        }
        // In a hidden comment that nobody addressed to agents, a template's notes to humans are normal.
        if (isHidden && file.kind === "template" && rule.category === "policy") severity = "info";
        hits.push({ rule, severity, scope, line: index + 1, excerpt: excerptOf(lineText(a.text, a, index), column) });
      }
    }
  }
  return hits;
}

function hiddenNotes(file: SourceFile, a: Analysis, regionAddress: Address[]): Finding[] {
  const out: Finding[] = [];
  a.hiddenRegions.forEach((region, n) => {
    const address = regionAddress[n];
    // Templates use comments to talk to the person filling them in; only a direct address to agents stands out there.
    if (!address || (file.kind === "template" && address === "loose")) return;
    const body = a.text.slice(region.start, region.end);
    const severity: Severity = file.kind === "template" || address === "loose" ? "low" : "medium";
    const line = lineIndexAt(a.lineStarts, region.start);
    const flat = body.replace(/\s+/g, " ").trim();
    out.push({
      rule: "hidden-agent-note",
      category: "hidden-text",
      severity,
      title: "Hidden comment addressed to AI agents (not shown on the rendered page)",
      file: file.path,
      line: line + 1,
      excerpt: revealInvisible(flat.length > EXCERPT_MAX ? `${flat.slice(0, EXCERPT_MAX)}…` : flat),
      scope: "hidden",
    });
  });
  return out;
}

const INVISIBLE_TITLES = {
  "tag-characters": "Invisible Unicode tag characters (hidden ASCII text)",
  "variation-selectors": "Run of Unicode variation selectors (can encode hidden bytes)",
  "bidi-controls": "Bidirectional control characters (text may display in a different order than it reads)",
  "zero-width-run": "Run of zero-width characters (can encode hidden data)",
} as const;

function invisibleFindings(file: SourceFile, a: Analysis): Finding[] {
  return findInvisible(a.text).map((hit) => {
    const index = lineIndexAt(a.lineStarts, hit.offset);
    const line = lineText(a.text, a, index);
    return {
      rule: "invisible-unicode",
      category: "hidden-text",
      severity: hit.severity,
      title: INVISIBLE_TITLES[hit.kind],
      detail: hit.decoded ? `decodes to: ${JSON.stringify(hit.decoded.slice(0, 200))}` : `${hit.length} characters`,
      file: file.path,
      line: index + 1,
      excerpt: excerptOf(line, hit.offset - a.lineStarts[index]!),
      scope: "hidden",
    } satisfies Finding;
  });
}

/** One finding per line and category (the most severe), and a cap on repeated policy lines. */
function dedupe(findings: Finding[]): Finding[] {
  const best = new Map<string, Finding>();
  for (const f of findings) {
    const key = f.category === "agent-config" ? `${f.file}:${f.line}:${f.rule}:${f.detail ?? ""}` : `${f.file}:${f.line}:${f.category}`;
    const prev = best.get(key);
    if (!prev || severityRank(f.severity) > severityRank(prev.severity)) best.set(key, f);
  }
  const perRule = new Map<string, number>();
  const out: Finding[] = [];
  for (const f of [...best.values()].sort((x, y) => x.line - y.line)) {
    if (f.severity === "info") {
      const key = `${f.file}:${f.rule}`;
      const n = perRule.get(key) ?? 0;
      perRule.set(key, n + 1);
      if (n >= MAX_INFO_PER_RULE) continue;
    }
    out.push(f);
  }
  return out;
}

export function scanFile(file: SourceFile, options: ScanOptions = {}): Finding[] {
  const ignore = new Set(options.ignore ?? []);
  const a = analyze(file.text, file.path, file.kind === "agent");
  const regionAddress = a.hiddenRegions.map((r) => addressOf(a.text.slice(r.start, r.end)));
  const findings: Finding[] = [];
  for (const rule of RULES) {
    if (ignore.has(rule.id)) continue;
    for (const hit of ruleHits(file, a, rule, regionAddress)) {
      findings.push({
        rule: hit.rule.id,
        category: hit.rule.category,
        severity: hit.severity,
        title: hit.rule.title,
        file: file.path,
        line: hit.line,
        excerpt: hit.excerpt,
        scope: hit.scope,
      });
    }
  }
  findings.push(...hiddenNotes(file, a, regionAddress), ...invisibleFindings(file, a));
  for (const c of configFindings({ ...file, text: a.text })) {
    const line = Math.max(1, c.line);
    findings.push({
      ...c,
      file: file.path,
      line,
      excerpt: c.excerpt ?? excerptOf(lineText(a.text, a, line - 1), 0),
      scope: "agent-file",
    });
  }
  const kept = dedupe(findings.filter((f) => !ignore.has(f.rule)));
  if (file.url) for (const f of kept) f.url = `${file.url}#L${f.line}`;
  return kept;
}

export function scanFiles(files: readonly SourceFile[], options: ScanOptions = {}): Finding[] {
  const all = files.flatMap((f) => scanFile(f, options));
  return all.sort(
    (x, y) => severityRank(y.severity) - severityRank(x.severity) || x.file.localeCompare(y.file) || x.line - y.line,
  );
}

export function summarize(findings: readonly Finding[]): Record<Severity, number> {
  const summary = Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<Severity, number>;
  for (const f of findings) summary[f.severity]++;
  return summary;
}
