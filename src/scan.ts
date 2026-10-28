// Runs the rules over the agent-facing files of a repository.
import { configFindings } from "./config.ts";
import { NEGATION, RULES, type Rule } from "./rules.ts";
import { addressesAgents, analyze, codeSpans, lineIndexAt, type Analysis } from "./text.ts";
import { type Finding, type Scope, type Severity, type SourceFile, SEVERITIES, severityRank, shiftSeverity } from "./types.ts";
import { findInvisible, revealInvisible } from "./unicode.ts";

export interface ScanOptions {
  /** Rule ids to skip. */
  ignore?: readonly string[];
  /** Stop starting new files after this time (epoch milliseconds). */
  deadline?: number;
}

export interface ScanResult {
  findings: Finding[];
  /** Files left unscanned because the deadline passed. */
  unscanned: string[];
}

/** Policy statements and low-risk lines (package installs, tool mentions) repeat; report the first few per file and rule. */
const MAX_REPEATS_PER_RULE = 2;

const EXCERPT_MAX = 180;

/** Repository text placed in a report: invisible and control characters shown as \u{…}, whitespace flattened. */
export function clean(s: string, max = 300): string {
  const flat = s.replace(/[\t\n\r\f\v\u2028\u2029]+/g, " ").replace(/ {2,}/g, " ").trim();
  return revealInvisible(flat.length > max ? `${flat.slice(0, max - 1)}…` : flat);
}

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

/** Lines of one view of a file, sliced once each: a long line can hold thousands of matches. */
class Lines {
  readonly #cache = new Map<number, string>();
  readonly #source: string;
  readonly #starts: number[];
  constructor(source: string, a: Analysis) {
    this.#source = source;
    this.#starts = a.lineStarts;
  }
  get(index: number): string {
    let line = this.#cache.get(index);
    if (line === undefined) {
      const start = this.#starts[index]!;
      const next = this.#starts[index + 1];
      line = this.#source.slice(start, next === undefined ? this.#source.length : next - 1);
      this.#cache.set(index, line);
    }
    return line;
  }
}

const CLAUSE_BREAK = /[.;:!?,]\s|[([]|\s[-–—]\s|^\s*(?:[-*+>]|\d+[.)])\s/g;
/** How far back from a match to look for the start of its clause. */
const CLAUSE_WINDOW = 300;

/** The clause the match sits in (up to the match), and the clause before it when a colon separates them. */
function clausesBefore(line: string, column: number): { clause: string; leadIn: string | null } {
  const from = Math.max(0, column - CLAUSE_WINDOW);
  const before = line.slice(from, column);
  const cuts: Array<{ at: number; end: number; colon: boolean }> = [];
  for (const m of before.matchAll(CLAUSE_BREAK)) cuts.push({ at: m.index, end: m.index + m[0].length, colon: m[0][0] === ":" });
  const last = cuts[cuts.length - 1];
  if (!last) return { clause: before, leadIn: null };
  const prev = cuts[cuts.length - 2];
  return { clause: before.slice(last.end), leadIn: last.colon ? before.slice(prev ? prev.end : 0, last.at) : null };
}

/** Negation words that do not negate what follows: "don't forget to", "not optional", "no exceptions". */
const NOT_A_NEGATION =
  /\b(?:don'?t|do\s+not|never|not|no)\s+(?:forget|hesitate|fail|miss|skip|ignore|worry|exceptions?|excuses?|optional|matter)\b|\bnot\s+(?:optional|negotiable)\b|\bwithout\s+(?:fail|exception)\b|\bno\s+matter\b/i;

/** True when the clause ends with a negation of what comes next ("Never use", "Do not skip", "Avoid `git commit"). */
function negates(clause: string): boolean {
  if (NOT_A_NEGATION.test(clause)) return false;
  const words = clause.trim().split(/\s+/);
  return NEGATION.test(words.slice(-5).join(" "));
}

/** "Never run this:" on the line before a code block or list negates what follows. */
function negatedByLeadIn(lines: Lines, index: number): boolean {
  let seen = 0;
  for (let i = index - 1; i >= 0 && seen < 4; i--) {
    const t = lines.get(i).trim();
    if (!t || /^(`{3,}|~{3,})/.test(t)) continue;
    seen++;
    if (/:\s*$/.test(t)) {
      const leadIn = t.replace(/:\s*$/, "");
      const lastClause = leadIn.split(/[.;!?]\s/).pop() ?? leadIn;
      return negates(lastClause);
    }
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

/** True when `column` falls in one of `spans` (sorted, not overlapping). Binary search: a line can hold thousands. */
function insideSpan(spans: Array<[number, number]>, column: number): boolean {
  let lo = 0;
  let hi = spans.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [s, e] = spans[mid]!;
    if (column < s) hi = mid - 1;
    else if (column >= e) lo = mid + 1;
    else return true;
  }
  return false;
}

function ruleHits(file: SourceFile, a: Analysis, rule: Rule, regionAddress: Address[], original: Lines): Hit[] {
  const hits: Hit[] = [];
  const views: Array<[string, boolean]> = [[a.visible, false]];
  if (a.hiddenRegions.length) views.push([a.hidden, true]);
  for (const [source, isHidden] of views) {
    const lines = new Lines(source, a);
    // One hit per line is enough, and a line that fails a whole-line check fails it for every match:
    // either way the rest of a long line is not re-examined.
    const done = new Set<number>();
    const spans = new Map<number, Array<[number, number]>>();
    for (const pattern of rule.patterns) {
      pattern.lastIndex = 0;
      for (const m of source.matchAll(pattern)) {
        const index = lineIndexAt(a.lineStarts, m.index);
        if (done.has(index)) continue;
        const line = lines.get(index);
        const column = m.index - a.lineStarts[index]!;
        if ((rule.context && !rule.context.some((re) => re.test(line))) || rule.unlessLine?.test(line) || (!isHidden && file.kind !== "agent" && !a.agentLines[index] && !rule.general)) {
          done.add(index);
          continue;
        }
        if (rule.filter && !rule.filter(m[0])) continue;
        if (rule.skipInCode) {
          let s = spans.get(index);
          if (!s) spans.set(index, (s = codeSpans(line)));
          if (insideSpan(s, column)) continue;
        }
        const { clause, leadIn } = clausesBefore(line, column);
        if (rule.negatable !== false && (negates(clause) || (leadIn !== null && negates(leadIn)) || negatedByLeadIn(lines, index))) continue;
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
        done.add(index);
        hits.push({ rule, severity, scope, line: index + 1, excerpt: excerptOf(original.get(index), column) });
      }
    }
  }
  return hits;
}

/** A short note that only asks the agent to pass something on to its user ("remind your human to look at these"). */
const RELAY_TO_USER = /\b(?:remind|tell|ask|let|inform|show|point\s+out\s+to)\s+(?:your|the)\s+(?:human|user|operator|developer|contributor)s?\b/i;
const RELAY_MAX = 300;

function hiddenNotes(file: SourceFile, a: Analysis, regionAddress: Address[]): Finding[] {
  const out: Finding[] = [];
  a.hiddenRegions.forEach((region, n) => {
    const address = regionAddress[n];
    // Templates use comments to talk to the person filling them in; only a direct address to agents stands out there.
    if (!address || (file.kind === "template" && address === "loose")) return;
    const body = a.text.slice(region.start, region.end);
    // Rules that match inside the comment are reported on their own, one level up; this finding is about the comment itself.
    const relay = body.trim().length <= RELAY_MAX && RELAY_TO_USER.test(body);
    const severity: Severity = relay ? "info" : file.kind === "template" || address === "loose" ? "low" : "medium";
    const line = lineIndexAt(a.lineStarts, region.start);
    out.push({
      rule: "hidden-agent-note",
      category: "hidden-text",
      severity,
      title: relay
        ? "Hidden comment addressed to AI agents asks them to pass a note to the user"
        : "Hidden comment addressed to AI agents (not shown on the rendered page)",
      file: file.path,
      line: line + 1,
      excerpt: clean(body, EXCERPT_MAX),
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

function invisibleFindings(file: SourceFile, a: Analysis, original: Lines): Finding[] {
  return findInvisible(a.text).map((hit) => {
    const index = lineIndexAt(a.lineStarts, hit.offset);
    return {
      rule: "invisible-unicode",
      category: "hidden-text",
      severity: hit.severity,
      title: INVISIBLE_TITLES[hit.kind],
      detail: hit.decoded ? `decodes to: ${JSON.stringify(hit.decoded.slice(0, 200))}` : `${hit.length} characters`,
      file: file.path,
      line: index + 1,
      excerpt: excerptOf(original.get(index), hit.offset - a.lineStarts[index]!),
      scope: "hidden",
    } satisfies Finding;
  });
}

const NOTE_TITLES: Record<NonNullable<SourceFile["notes"]>[number], string> = {
  truncated: "File is larger than the scan limit; only its beginning was scanned",
  "nul-bytes": "File contains NUL bytes, which make many tools treat it as binary and skip it",
};

/** One finding per line and category (the most severe), and a cap on repeated policy and low-risk lines. */
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
    if (f.severity === "info" || (f.severity === "low" && f.category !== "hidden-text")) {
      const key = `${f.file}:${f.rule}`;
      const n = perRule.get(key) ?? 0;
      perRule.set(key, n + 1);
      if (n >= MAX_REPEATS_PER_RULE) continue;
    }
    out.push(f);
  }
  return out;
}

export function scanFile(file: SourceFile, options: ScanOptions = {}): Finding[] {
  const ignore = new Set(options.ignore ?? []);
  const a = analyze(file.text, file.path, file.kind === "agent");
  const original = new Lines(a.text, a);
  const regionAddress = a.hiddenRegions.map((r) => addressOf(a.text.slice(r.start, r.end)));
  const findings: Finding[] = [];
  for (const rule of RULES) {
    if (ignore.has(rule.id)) continue;
    for (const hit of ruleHits(file, a, rule, regionAddress, original)) {
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
  findings.push(...hiddenNotes(file, a, regionAddress), ...invisibleFindings(file, a, original));
  for (const c of configFindings({ ...file, text: a.text })) {
    const line = Math.min(Math.max(1, c.line), a.lineStarts.length);
    findings.push({
      ...c,
      file: file.path,
      line,
      excerpt: c.excerpt ?? excerptOf(original.get(line - 1), 0),
      scope: "agent-file",
    });
  }
  for (const note of file.notes ?? []) {
    findings.push({ rule: "partial-scan", category: "hidden-text", severity: "medium", title: NOTE_TITLES[note], file: file.path, line: 1, excerpt: excerptOf(original.get(0), 0), scope: "agent-file" });
  }
  const kept = dedupe(findings.filter((f) => !ignore.has(f.rule)));
  for (const f of kept) {
    // Paths and config details come from the repository too.
    f.file = clean(f.file);
    if (f.detail !== undefined) f.detail = clean(f.detail);
    if (file.url) f.url = `${file.url}#L${f.line}`;
  }
  return kept;
}

export function scanAll(files: readonly SourceFile[], options: ScanOptions = {}): ScanResult {
  const findings: Finding[] = [];
  const unscanned: string[] = [];
  for (const f of files) {
    if (options.deadline !== undefined && Date.now() > options.deadline) {
      unscanned.push(f.path);
      continue;
    }
    findings.push(...scanFile(f, options));
  }
  findings.sort((x, y) => severityRank(y.severity) - severityRank(x.severity) || x.file.localeCompare(y.file) || x.line - y.line);
  return { findings, unscanned };
}

export function scanFiles(files: readonly SourceFile[], options: ScanOptions = {}): Finding[] {
  return scanAll(files, options).findings;
}

export function summarize(findings: readonly Finding[]): Record<Severity, number> {
  const summary = Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<Severity, number>;
  for (const f of findings) summary[f.severity]++;
  return summary;
}
