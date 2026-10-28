// Splits a document into what a human sees and what is hidden from them, and finds the parts
// of human-facing documents that speak to AI agents.
import { isMarkdownPath, isRstPath } from "./surface.ts";

export interface Region {
  /** Offset of the first hidden character. */
  start: number;
  /** Offset just past the last hidden character. */
  end: number;
}

export interface Analysis {
  /** The document with \r\n turned into \n and a leading BOM removed. */
  text: string;
  lineStarts: number[];
  /** The document with hidden parts blanked out (same length, newlines kept). */
  visible: string;
  /** The document with visible parts blanked out (same length, newlines kept). */
  hidden: string;
  hiddenRegions: Region[];
  /** Per line (0-based): true when the visible text there addresses agents. */
  agentLines: boolean[];
}

const AGENT_WORD =
  "(?:(?:AI|LLM|coding|autonomous|automated|agentic)\\s+(?:agents?|assistants?|tools?|models?|bots?|systems?)|AI|A\\.I\\.|LLMs?|agents?|bots?|robots?|assistants?|copilots?|language\\s+models?|Claude|Copilot|Cursor|Codex|ChatGPT|GPT|Gemini|Devin|Windsurf|Cline|Aider)";

/** Phrases that speak to an AI agent directly. */
export const ADDRESS_PATTERNS: readonly RegExp[] = [
  new RegExp(
    `\\bif\\s+you(?:\\s+are|['’]re)\\s+(?:an?\\s+)?(?:automated\\s+|autonomous\\s+|AI\\s+|coding\\s+|LLM\\s+|large\\s+|generative\\s+)*${AGENT_WORD}`,
    "i",
  ),
  new RegExp(
    `\\b(?:note|notes|message|instructions?|guidance|guidelines|rules|reminder|warning|attention|info(?:rmation)?|policy)\\s+(?:for|to)\\s+(?:all\\s+|any\\s+)?${AGENT_WORD}`,
    "i",
  ),
  /\b(?:dear|hey|hello|hi|attention|attn|psst)[,:]?\s+(?:AI|LLMs?|agents?|bots?|assistants?|robots?|Claude|Copilot|Cursor|Codex|ChatGPT|Gemini)\b/i,
  /\b(?:AI|LLM|coding|autonomous|automated)\s+(?:agents?|assistants?|bots?)\s*(?::|\bmust\b|\bshould\b|\bshall\b|\bneed\s+to\b|\bare\s+(?:required|expected|asked|not\s+(?:allowed|permitted))|\bmay\s+not\b|\bmust\s+not\b|\bhave\s+to\b|\breading\s+this\b)/i,
  /\b(?:to|for)\s+(?:the\s+|any\s+)?(?:AI|LLM|agent|bot|assistant|language\s+model)s?\s+reading\s+this\b/i,
  /\bAgents?\s+(?:must|should|shall|may\s+not|must\s+not)\b/,
];

/** Section headings that introduce text for agents. */
const AGENT_HEADING_PATTERNS: readonly RegExp[] = [
  /\b(?:for|to)\s+(?:all\s+|any\s+)?(?:AI|A\.I\.|LLMs?|agents?|bots?|robots?|assistants?|language\s+models?|coding\s+agents?|AI\s+(?:agents?|assistants?|tools?|models?))\b/i,
  /\b(?:note|notes|message|instructions?|guidance|guidelines|rules|policy)\s+(?:for|to)\s+(?:Claude|Copilot|Cursor|Codex|ChatGPT|Gemini)\b/i,
  /^\s*(?:AI|LLM|coding)\s+(?:agents?|assistants?)\s*:?\s*$/i,
  // Not "AI policy" or "AI usage": those sections tell people how they may use AI; the policy rules cover them anywhere.
  /\bagent\s+(?:instructions|guidelines|rules|notes)\b/i,
];

export function addressesAgents(text: string): boolean {
  return ADDRESS_PATTERNS.some((re) => re.test(text));
}

/** Column ranges of inline code spans in a line: a run of N backticks up to the next run of exactly N. Linear time. */
export function codeSpans(line: string): Array<[number, number]> {
  const runs: Array<[number, number]> = [];
  for (let i = 0; i < line.length; ) {
    if (line[i] !== "`") {
      i++;
      continue;
    }
    let j = i;
    while (line[j] === "`") j++;
    runs.push([i, j - i]);
    i = j;
  }
  // For each run length, the run indexes in order, and a cursor that only moves forward.
  const byLength = new Map<number, { list: number[]; next: number }>();
  runs.forEach(([, len], k) => {
    const entry = byLength.get(len) ?? { list: [], next: 0 };
    entry.list.push(k);
    byLength.set(len, entry);
  });
  const spans: Array<[number, number]> = [];
  let k = 0;
  while (k < runs.length) {
    const [at, len] = runs[k]!;
    const entry = byLength.get(len)!;
    while (entry.next < entry.list.length && entry.list[entry.next]! <= k) entry.next++;
    const close = entry.list[entry.next];
    if (close === undefined) {
      k++;
      continue;
    }
    spans.push([at, runs[close]![0] + len]);
    k = close + 1;
  }
  return spans;
}

/** Words after which a quotation or emphasis names a phrase instead of saying it. */
const MENTION_CUE = /\b(?:such\s+as|like|e\.g\.?|for\s+example|say|says|said|starts?(?:\s+with)?|called|named|titled|heading|section|under|below|phrase|text|line|reads)\s*[:,]?\s*$/i;
/** "such as *A* or *B*": a list of mentions continues after "or" / "and". */
const LIST_CUE = /^\s*(?:,|or|and|,\s*or|,\s*and)\s*$/i;

/**
 * Drops text that mentions a phrase rather than using it ('a heading such as *Note for AI tools*',
 * 'a paragraph that starts "If you are an AI agent"'), so only a real address counts.
 * Code spans always go; quotations and emphasis go only after a cue word.
 */
export function withoutMentions(line: string): string {
  let s = line;
  const spans = codeSpans(s);
  for (let n = spans.length - 1; n >= 0; n--) {
    const [a, b] = spans[n]!;
    s = `${s.slice(0, a)}${" ".repeat(b - a)}${s.slice(b)}`;
  }
  const quoted = /"[^"\n]{1,200}"|“[^”\n]{1,200}”|„[^“\n]{1,200}“|«[^»\n]{1,200}»|(\*\*?|__?)(?=\S)[^\n*_]{1,200}?\S\1/g;
  let out = "";
  let last = 0;
  let previousWasMention = false;
  for (const m of s.matchAll(quoted)) {
    const gap = s.slice(last, m.index);
    const before = out + gap;
    const mention: boolean = MENTION_CUE.test(before.slice(-40)) || (previousWasMention && LIST_CUE.test(gap));
    out = mention ? `${before} ` : before + m[0];
    previousWasMention = mention;
    last = m.index + m[0].length;
  }
  return out + s.slice(last);
}

function isAgentHeading(title: string): boolean {
  const plain = title.replace(/\p{Extended_Pictographic}|[\uFE0F\u200D*_`]/gu, " ").replace(/\s+/g, " ").trim();
  return AGENT_HEADING_PATTERNS.some((re) => re.test(plain));
}

export function lineStartsOf(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

/** 0-based line index of an offset. */
export function lineIndexAt(lineStarts: number[], offset: number): number {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export function normalize(text: string): string {
  return text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

interface Line {
  index: number;
  start: number;
  text: string;
}

function splitLines(text: string, lineStarts: number[]): Line[] {
  return lineStarts.map((start, index) => {
    const next = lineStarts[index + 1];
    const end = next === undefined ? text.length : next - 1;
    return { index, start, text: text.slice(start, end) };
  });
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** HTML comments in Markdown, outside fenced code. Only the text between the delimiters counts as hidden. */
function htmlComments(lines: Line[], textLength: number): Region[] {
  const regions: Region[] = [];
  let fence: { ch: string; len: number } | null = null;
  let commentStart = -1;
  for (const line of lines) {
    if (commentStart === -1) {
      const m = FENCE.exec(line.text);
      if (fence) {
        if (m && m[1]![0] === fence.ch && m[1]!.length >= fence.len && line.text.slice(m[0].length).trim() === "") fence = null;
        continue;
      }
      if (m) {
        fence = { ch: m[1]![0]!, len: m[1]!.length };
        continue;
      }
    }
    let pos = 0;
    const spans = commentStart === -1 ? codeSpans(line.text) : [];
    while (pos <= line.text.length) {
      if (commentStart === -1) {
        const open = line.text.indexOf("<!--", pos);
        if (open === -1) break;
        // `<!-- like this -->` in a code span is shown as written.
        const span = spans.find(([s, e]) => open >= s && open < e);
        if (span) {
          pos = span[1];
          continue;
        }
        // `<!-->` and `<!--->` are complete, empty comments (CommonMark, HTML).
        const empty = /^<!---?>/.exec(line.text.slice(open, open + 6));
        if (empty) {
          pos = open + empty[0].length;
          continue;
        }
        commentStart = line.start + open + 4;
        pos = open + 4;
      } else {
        const close = line.text.indexOf("-->", Math.max(pos, commentStart - line.start));
        if (close === -1) break;
        regions.push({ start: commentStart, end: line.start + close });
        commentStart = -1;
        pos = close + 3;
      }
    }
  }
  // An unclosed comment hides everything after it.
  if (commentStart !== -1) regions.push({ start: commentStart, end: textLength });
  return regions;
}

/** Markdown "link reference" comments such as `[//]: # (text)`. */
function referenceComments(lines: Line[]): Region[] {
  const regions: Region[] = [];
  const re = /^ {0,3}\[(?:\/\/|comment|#|_|\s*)\]:\s*(?:#|<>)\s*(?:\((.*)\)|"(.*)"|'(.*)')\s*$/i;
  for (const line of lines) {
    const m = re.exec(line.text);
    if (!m) continue;
    const content = m[1] ?? m[2] ?? m[3] ?? "";
    const at = line.text.lastIndexOf(content);
    regions.push({ start: line.start + at, end: line.start + at + content.length });
  }
  return regions;
}

/** reStructuredText comments: `.. text` that is not a directive, target or substitution, plus its indented body. */
function rstComments(lines: Line[]): Region[] {
  const regions: Region[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^\.\.(?:\s+(.*))?$/.exec(lines[i]!.text);
    if (!m) continue;
    const rest = m[1] ?? "";
    if (/^(?:[\w:+-]+::|_|\||\[)/.test(rest)) continue;
    let last = i;
    for (let j = i + 1; j < lines.length; j++) {
      const t = lines[j]!.text;
      if (t.trim() === "") continue;
      if (/^\s+\S/.test(t)) last = j;
      else break;
    }
    const start = lines[i]!.start + 2 + (lines[i]!.text.length - 2 - rest.length);
    const endLine = lines[last]!;
    const end = endLine.start + endLine.text.length;
    if (end > start) regions.push({ start, end });
    i = last;
  }
  return regions;
}

/** Replaces every character whose mask value is not `keep` with a space, keeping newlines. */
function blank(text: string, mask: Uint8Array, keep: number): string {
  let out = "";
  let runStart = 0;
  for (let i = 1; i <= text.length; i++) {
    if (i < text.length && (mask[i] === keep) === (mask[runStart] === keep)) continue;
    const chunk = text.slice(runStart, i);
    out += mask[runStart] === keep ? chunk : chunk.replace(/[^\n]/g, " ");
    runStart = i;
  }
  return out;
}

interface Heading {
  line: number;
  level: number;
  title: string;
}

function headings(lines: Line[], markdown: boolean, rst: boolean): Heading[] {
  const out: Heading[] = [];
  const rstLevels: string[] = [];
  let fence: { ch: string; len: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]!.text;
    if (markdown) {
      const f = FENCE.exec(text);
      if (fence) {
        if (f && f[1]![0] === fence.ch && f[1]!.length >= fence.len) fence = null;
        continue;
      }
      if (f) {
        fence = { ch: f[1]![0]!, len: f[1]!.length };
        continue;
      }
      const atx = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(text);
      if (atx) {
        out.push({ line: i, level: atx[1]!.length, title: atx[2]! });
        continue;
      }
    }
    const next = lines[i + 1]?.text;
    const prevBlank = i === 0 || lines[i - 1]!.text.trim() === "";
    if (text.trim() !== "" && next !== undefined) {
      if (markdown && /^ {0,3}(=+|-+)\s*$/.test(next) && !/^\s*([-*+]|\d+[.)])\s/.test(text)) {
        out.push({ line: i, level: next.trim()[0] === "=" ? 1 : 2, title: text.trim() });
        i++;
        continue;
      }
      const under = /^([=\-~^"'`#*+:._])\1{2,}\s*$/.exec(next);
      if (rst && under && next.trim().length >= text.trim().length) {
        const ch = under[1]!;
        if (!rstLevels.includes(ch)) rstLevels.push(ch);
        out.push({ line: i, level: rstLevels.indexOf(ch) + 1, title: text.trim() });
        i++;
        continue;
      }
    }
    // A short paragraph made only of emphasis works as a heading: "*Note for AI Tools*".
    const nextBlank = next === undefined || next.trim() === "";
    const emph = /^\s*(\*\*?|__?)([^*_\n].{0,100}?)\1\s*:?\s*$/.exec(text);
    if (emph && prevBlank && nextBlank) out.push({ line: i, level: 7, title: emph[2]! });
  }
  return out;
}

/** Blocks of non-blank lines (fenced code counts as one block). Returns [firstLine, lastLine] pairs. */
function blocks(lines: Line[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let start = -1;
  let fence: { ch: string; len: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]!.text;
    const f = FENCE.exec(text);
    if (fence) {
      if (f && f[1]![0] === fence.ch && f[1]!.length >= fence.len) fence = null;
      continue;
    }
    if (f) {
      fence = { ch: f[1]![0]!, len: f[1]!.length };
      if (start === -1) start = i;
      continue;
    }
    if (text.trim() === "") {
      if (start !== -1) out.push([start, i - 1]);
      start = -1;
    } else if (/^\s*\|/.test(text)) {
      // Each table row stands alone.
      if (start !== -1) out.push([start, i - 1]);
      out.push([i, i]);
      start = -1;
    } else if (start === -1) start = i;
  }
  if (start !== -1) out.push([start, lines.length - 1]);
  return out;
}

export function analyze(rawText: string, path: string, wholeFileForAgents: boolean): Analysis {
  const text = normalize(rawText);
  const lineStarts = lineStartsOf(text);
  const lines = splitLines(text, lineStarts);
  const markdown = isMarkdownPath(path);
  const rst = isRstPath(path);

  let hiddenRegions: Region[] = [];
  if (markdown) hiddenRegions = [...htmlComments(lines, text.length), ...referenceComments(lines)];
  else if (rst) hiddenRegions = rstComments(lines);
  hiddenRegions.sort((a, b) => a.start - b.start);

  // 0 visible, 1 hidden, 2 comment delimiter (in neither view, so `<!--` never matches a rule).
  const mask = new Uint8Array(text.length);
  if (markdown) {
    const re = /<!--|-->/g;
    for (let m = re.exec(text); m; m = re.exec(text)) mask.fill(2, m.index, m.index + m[0].length);
  }
  for (const r of hiddenRegions) mask.fill(1, r.start, r.end);
  const visible = blank(text, mask, 0);
  const hidden = blank(text, mask, 1);

  const agentLines = new Array<boolean>(lines.length).fill(wholeFileForAgents);
  if (!wholeFileForAgents) {
    const visibleLines = splitLines(visible, lineStarts);
    const heads = headings(visibleLines, markdown, rst || !markdown);
    heads.forEach((h, n) => {
      if (!isAgentHeading(h.title) && !(h.level === 7 && addressesAgents(h.title))) return;
      let end = lines.length - 1;
      for (const later of heads.slice(n + 1)) {
        if (later.level <= h.level) {
          end = later.line - 1;
          break;
        }
      }
      for (let i = h.line; i <= end; i++) agentLines[i] = true;
    });
    // A paragraph that addresses agents, and the block right after it (often the list it introduces).
    const bl = blocks(visibleLines);
    bl.forEach(([first, last], n) => {
      const body = visibleLines.slice(first, last + 1).map((l) => withoutMentions(l.text)).join(" ");
      if (!addressesAgents(body)) return;
      const tableRow = /^\s*\|/.test(visibleLines[first]!.text);
      const until = tableRow ? last : (bl[n + 1]?.[1] ?? last);
      for (let i = first; i <= until; i++) agentLines[i] = true;
    });
  }

  return { text, lineStarts, visible, hidden, hiddenRegions, agentLines };
}
