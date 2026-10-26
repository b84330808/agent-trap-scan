// Invisible Unicode that can carry text a human reviewer never sees.

export interface InvisibleHit {
  offset: number;
  kind: "tag-characters" | "variation-selectors" | "bidi-controls" | "zero-width-run";
  severity: "high" | "medium";
  /** Text recovered from the hidden characters, when there is any. */
  decoded?: string;
  length: number;
}

const TAGS = /[\u{E0000}-\u{E007F}]+/gu;
const VARIATION_RUN = /[\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}]{3,}/gu;
const BIDI = /[\u202A-\u202E\u2066-\u2069]+/g;
const ZERO_WIDTH_RUN = /[\u200B-\u200D\u2060-\u2064\uFEFF]{4,}/g;

function printable(s: string): boolean {
  return s.length > 0 && /^[\x20-\x7E\t\n\r]+$/.test(s);
}

/** Unicode tag characters mirror ASCII (U+E0041 is a hidden "A"). */
function decodeTags(run: string): string {
  let out = "";
  for (const ch of run) {
    const cp = ch.codePointAt(0)! - 0xe0000;
    if (cp >= 0x20 && cp <= 0x7e) out += String.fromCharCode(cp);
  }
  return out;
}

/** Variation selectors used as bytes: VS1-VS16 are 0-15, VS17-VS256 are 16-255. */
function decodeVariationSelectors(run: string): string {
  const bytes: number[] = [];
  for (const ch of run) {
    const cp = ch.codePointAt(0)!;
    bytes.push(cp <= 0xfe0f ? cp - 0xfe00 : cp - 0xe0100 + 16);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
  } catch {
    return "";
  }
}

export function findInvisible(text: string): InvisibleHit[] {
  const hits: InvisibleHit[] = [];
  for (const m of text.matchAll(TAGS)) {
    const decoded = decodeTags(m[0]);
    hits.push({ offset: m.index, kind: "tag-characters", severity: "high", decoded, length: m[0].length });
  }
  for (const m of text.matchAll(VARIATION_RUN)) {
    const decoded = decodeVariationSelectors(m[0]);
    const readable = printable(decoded) && decoded.trim().length >= 3;
    hits.push({
      offset: m.index,
      kind: "variation-selectors",
      severity: readable ? "high" : "medium",
      decoded: readable ? decoded : undefined,
      length: m[0].length,
    });
  }
  for (const m of text.matchAll(BIDI)) {
    hits.push({ offset: m.index, kind: "bidi-controls", severity: "medium", length: m[0].length });
  }
  for (const m of text.matchAll(ZERO_WIDTH_RUN)) {
    hits.push({ offset: m.index, kind: "zero-width-run", severity: "medium", length: m[0].length });
  }
  return hits.sort((a, b) => a.offset - b.offset);
}

// Leaves out U+FE0E/U+FE0F and the zero-width (non-)joiners, which ordinary emoji and scripts use.
const INVISIBLE_CHAR =
  /[\u{E0000}-\u{E007F}\u{FE00}-\u{FE0D}\u{E0100}-\u{E01EF}\u202A-\u202E\u2066-\u2069\u200B\u200E\u200F\u2060-\u2064\uFEFF\u00AD]|[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu;

/** Makes invisible and control characters visible as \u{...} so an excerpt cannot smuggle them on. */
export function revealInvisible(s: string): string {
  return s.replace(INVISIBLE_CHAR, (ch) => `\\u{${ch.codePointAt(0)!.toString(16).toUpperCase()}}`);
}
