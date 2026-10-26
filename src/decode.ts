// Turns file bytes into text without dropping a file that a tool might skip as binary:
// UTF-16 is decoded, NUL bytes are removed and noted, and an oversized file is cut and noted.
import type { SourceFile } from "./types.ts";

export interface Decoded {
  text: string;
  notes: NonNullable<SourceFile["notes"]>;
}

function utf16Order(bytes: Uint8Array): "le" | "be" | null {
  const n = Math.min(bytes.length, 4000) & ~1;
  if (n < 4) return null;
  let evenZero = 0;
  let oddZero = 0;
  for (let i = 0; i < n; i += 2) {
    if (bytes[i] === 0) evenZero++;
    if (bytes[i + 1] === 0) oddZero++;
  }
  const pairs = n / 2;
  if (oddZero > pairs * 0.4 && evenZero < pairs * 0.05) return "le";
  if (evenZero > pairs * 0.4 && oddZero < pairs * 0.05) return "be";
  return null;
}

function decodeUtf16(bytes: Uint8Array, order: "le" | "be"): string {
  if (order === "le") return new TextDecoder("utf-16le").decode(bytes);
  const swapped = new Uint8Array(bytes.length - (bytes.length % 2));
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    swapped[i] = bytes[i + 1]!;
    swapped[i + 1] = bytes[i]!;
  }
  return new TextDecoder("utf-16le").decode(swapped);
}

/** `bytes` may already be cut to the limit; pass `fullSize` so the cut is noted. */
export function decodeText(bytes: Uint8Array, maxBytes: number, fullSize = bytes.length): Decoded {
  const notes: Decoded["notes"] = [];
  let b = bytes;
  if (fullSize > maxBytes || b.length > maxBytes) {
    notes.push("truncated");
    b = b.subarray(0, maxBytes);
  }
  let text: string;
  if (b[0] === 0xff && b[1] === 0xfe) text = decodeUtf16(b.subarray(2), "le");
  else if (b[0] === 0xfe && b[1] === 0xff) text = decodeUtf16(b.subarray(2), "be");
  else {
    const order = utf16Order(b);
    text = order ? decodeUtf16(b, order) : new TextDecoder("utf-8").decode(b);
  }
  if (text.includes("\u0000")) {
    notes.push("nul-bytes");
    text = text.replace(/\u0000+/g, "");
  }
  return { text, notes };
}
