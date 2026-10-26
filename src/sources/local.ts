// Collects the agent-facing files of a directory on disk.
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { decodeText } from "../decode.ts";
import { runTool } from "../exec.ts";
import { classifyPath, MAX_DEPTH, SKIP_DIRS } from "../surface.ts";
import type { FileKind, SourceFile } from "../types.ts";

export interface CollectOptions {
  maxFiles?: number;
  maxBytes?: number;
  /** In a git work tree, list files with `git ls-files` (respects .gitignore). Default true. */
  useGit?: boolean;
}

export interface Collected {
  files: SourceFile[];
  warnings: string[];
}

export const DEFAULT_MAX_FILES = 400;
export const DEFAULT_MAX_BYTES = 1_000_000;
/** Directories the walker looks in at most, so a huge tree outside git cannot stall a hook. */
const MAX_DIRS = 20_000;

function toPosix(p: string): string {
  return p.split(sep).join("/");
}

/** True when `target` is `root` or inside it. */
export function inside(root: string, target: string): boolean {
  const back = relative(root, target);
  return back !== ".." && !back.startsWith(`..${sep}`) && !isAbsolute(back);
}

interface GitListing {
  files: string[];
  /** Submodules and nested repositories, which `ls-files` lists as one entry and does not enter. */
  nested: string[];
}

/** Files of the work tree at `root` (tracked, and untracked but not ignored), or null when it is not a git work tree root. */
async function gitListFiles(root: string): Promise<GitListing | null> {
  try {
    await lstat(join(root, ".git"));
  } catch {
    return null;
  }
  // A checkout's own .git/config can name a core.fsmonitor program that git would run; turn it off.
  const git = (args: string[]) => runTool("git", ["-c", "core.fsmonitor=false", "-C", root, ...args], { timeout: 15_000, maxBuffer: 64 * 1024 * 1024 });
  try {
    const [listed, staged] = await Promise.all([
      git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"]),
      git(["ls-files", "-z", "--stage"]),
    ]);
    const nested = new Set<string>();
    // Untracked nested repositories come back as "dir/".
    const files = listed.split("\0").filter((p) => {
      if (!p) return false;
      if (p.endsWith("/")) {
        nested.add(p.slice(0, -1));
        return false;
      }
      return true;
    });
    // Submodules are entries with mode 160000.
    for (const entry of staged.split("\0")) {
      const m = /^160000 \S+ \d+\t(.+)$/.exec(entry);
      if (m) nested.add(m[1]!);
    }
    return { files: [...new Set(files)].filter((f) => !nested.has(f)), nested: [...nested] };
  } catch {
    return null;
  }
}

/** The nearest directory at or above `start` that holds a `.git` entry, or null. */
export async function findRepoRoot(start: string): Promise<string | null> {
  let dir = resolve(start);
  for (let i = 0; i < 40; i++) {
    try {
      await lstat(join(dir, ".git"));
      return dir;
    } catch {
      // keep going up
    }
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  return null;
}

/** Reads at most `maxBytes` and decodes them; a cut file or one with NUL bytes gets a note, not a silent skip. */
async function readSource(path: string, maxBytes: number): Promise<Pick<SourceFile, "text" | "notes">> {
  const handle = await open(path, "r");
  try {
    const size = (await handle.stat()).size;
    const buf = Buffer.alloc(Math.min(size, maxBytes));
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    const { text, notes } = decodeText(buf.subarray(0, bytesRead), maxBytes, size);
    return notes.length ? { text, notes } : { text };
  } finally {
    await handle.close();
  }
}

/** Kind of a single file the user pointed at: by its place in its repo, else by its name, else agent text. */
export async function kindOfFile(path: string): Promise<FileKind> {
  const root = await findRepoRoot(dirname(path));
  const rel = root ? toPosix(relative(root, path)) : basename(path);
  return classifyPath(rel) ?? classifyPath(basename(path)) ?? "agent";
}

export async function collectLocal(target: string, options: CollectOptions = {}): Promise<Collected> {
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const warnings: string[] = [];
  const root = resolve(target);
  const info = await stat(root);

  if (info.isFile()) {
    const read = await readSource(root, maxBytes);
    return { files: [{ path: basename(root), kind: await kindOfFile(root), ...read }], warnings };
  }

  const realRoot = await realpath(root);
  const found: Array<{ abs: string; rel: string; kind: FileKind }> = [];
  const queue: Array<{ dir: string; depth: number }> = [];
  let truncated = false;

  /** Adds a file unless the cap is hit; a link that leaves the repository is not followed. */
  const add = async (abs: string, rel: string, kind: FileKind, isLink: boolean | null): Promise<void> => {
    if (found.length >= maxFiles) {
      truncated = true;
      return;
    }
    if (isLink !== false) {
      try {
        const real = await realpath(abs);
        if (!inside(realRoot, real)) {
          warnings.push(`skipped ${rel}: symbolic link points outside the scanned directory`);
          return;
        }
        if (!(await stat(real)).isFile()) return;
      } catch {
        return;
      }
    }
    found.push({ abs, rel, kind });
  };

  const listed = options.useGit === false ? null : await gitListFiles(root);
  if (listed) {
    const picked = listed.files
      .map((rel) => ({ rel, kind: classifyPath(rel) }))
      .filter((f): f is { rel: string; kind: FileKind } => f.kind !== null && !f.rel.split("/").some((d) => SKIP_DIRS.has(d)))
      .sort((x, y) => x.rel.split("/").length - y.rel.split("/").length || x.rel.localeCompare(y.rel));
    for (const f of picked) {
      await add(join(root, ...f.rel.split("/")), f.rel, f.kind, null);
      if (truncated) break;
    }
    // Claude Code still reads CLAUDE.md files inside submodules and nested repositories, so walk those.
    for (const rel of listed.nested) {
      const depth = rel.split("/").length;
      if (depth <= MAX_DEPTH) queue.push({ dir: join(root, ...rel.split("/")), depth });
    }
  } else {
    queue.push({ dir: root, depth: 0 });
  }

  // Breadth first, so the files nearest the root win when a cap is hit.
  let dirsSeen = 0;
  while (queue.length && !truncated) {
    if (++dirsSeen > MAX_DIRS) {
      warnings.push(`stopped after looking in ${MAX_DIRS} directories`);
      break;
    }
    const { dir, depth } = queue.shift()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((x, y) => x.name.localeCompare(y.name));
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      const rel = toPosix(relative(root, abs));
      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH && !SKIP_DIRS.has(entry.name)) queue.push({ dir: abs, depth: depth + 1 });
        continue;
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      const kind = classifyPath(rel);
      if (!kind) continue;
      await add(abs, rel, kind, entry.isSymbolicLink());
      if (truncated) break;
    }
  }
  if (truncated) warnings.push(`stopped after ${maxFiles} files; raise --max-files to scan more`);

  const files: SourceFile[] = [];
  for (const f of found) {
    try {
      files.push({ path: f.rel, kind: f.kind, ...(await readSource(f.abs, maxBytes)) });
    } catch (err) {
      warnings.push(`could not read ${f.rel}: ${(err as Error).message}`);
    }
  }
  return { files, warnings };
}
