import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after } from "node:test";

/** A temporary directory holding `files`, removed when the test file finishes. */
export function tempTree(files: Record<string, string>, options: { git?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "agent-trap-scan-test-"));
  for (const [rel, text] of Object.entries(files)) {
    const abs = join(root, ...rel.split("/"));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text);
  }
  if (options.git) {
    execFileSync("git", ["init", "-q"], { cwd: root });
  }
  after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

export class Sink {
  data = "";
  isTTY = false;
  write(chunk: string): boolean {
    this.data += chunk;
    return true;
  }
}
