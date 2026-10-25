// Collects the agent-facing files of a directory on disk.
import { execFile } from "node:child_process";
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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

const execFileAsync = promisify(execFile);

export const DEFAULT_MAX_FILES = 400;
export const DEFAULT_MAX_BYTES = 1_000_000;
/** Directories the walker looks in at most, so a huge tree outside git cannot stall a hook. */
const MAX_DIRS = 20_000;

function toPosix(p: string): string {
  return p.split(sep).join("/");
}

function looksBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8000).includes(0);
}

/** Tracked and untracked-but-not-ignored files of the work tree at `root`, or null when `root` is not a git work tree root. */
async function gitListFiles(root: string): Promise<string[] | null> {
  try {
    await lstat(join(root, ".git"));
  } catch {
    return null;
  }
  try {
    // A checkout's own .git/config can name a core.fsmonitor program that git would run; turn it off.
    const args = ["-c", "core.fsmonitor=false", "-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"];
    const { stdout } = await execFileAsync("git", args, {
      timeout: 15_000,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
    return [...new Set(stdout.split("\0").filter(Boolean))];
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

async function readText(path: string, maxBytes: number, warnings: string[], label: string): Promise<string | null> {
  const info = await stat(path);
  if (info.size > maxBytes) {
    warnings.push(`skipped ${label}: ${info.size} bytes is over the ${maxBytes}-byte limit`);
    return null;
  }
  const buf = await readFile(path);
  if (looksBinary(buf)) return null;
  return buf.toString("utf8");
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
    const text = await readText(root, maxBytes, warnings, basename(root));
    const files = text === null ? [] : [{ path: basename(root), text, kind: await kindOfFile(root) }];
    return { files, warnings };
  }

  const realRoot = await realpath(root);
  const found: Array<{ abs: string; rel: string; kind: FileKind; depth: number }> = [];
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  let truncated = false;
  const listed = options.useGit === false ? null : await gitListFiles(root);
  if (listed) {
    queue.length = 0;
    const picked = listed
      .map((rel) => ({ rel, kind: classifyPath(rel) }))
      .filter((f): f is { rel: string; kind: FileKind } => f.kind !== null && !f.rel.split("/").some((d) => SKIP_DIRS.has(d)))
      .sort((x, y) => x.rel.split("/").length - y.rel.split("/").length || x.rel.localeCompare(y.rel));
    for (const f of picked) {
      if (found.length >= maxFiles) {
        truncated = true;
        break;
      }
      const abs = join(root, ...f.rel.split("/"));
      try {
        const real = await realpath(abs);
        const back = relative(realRoot, real);
        if (back.startsWith("..") || isAbsolute(back)) {
          warnings.push(`skipped ${f.rel}: symbolic link points outside the scanned directory`);
          continue;
        }
        if (!(await stat(real)).isFile()) continue;
      } catch {
        continue;
      }
      found.push({ abs, rel: f.rel, kind: f.kind, depth: f.rel.split("/").length - 1 });
    }
  }
  // Breadth first, so the files nearest the root win when a cap is hit.
  let dirsSeen = 0;
  while (queue.length) {
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
      if (entry.isSymbolicLink()) {
        // CLAUDE.md -> AGENTS.md is common; a link that leaves the repository is not followed.
        try {
          const target = await realpath(abs);
          if (!(await stat(target)).isFile()) continue;
          const back = relative(realRoot, target);
          if (back.startsWith("..") || isAbsolute(back)) {
            warnings.push(`skipped ${rel}: symbolic link points outside the scanned directory`);
            continue;
          }
        } catch {
          continue;
        }
      }
      if (found.length >= maxFiles) {
        truncated = true;
        break;
      }
      found.push({ abs, rel, kind, depth });
    }
    if (truncated) break;
  }
  if (truncated) warnings.push(`stopped after ${maxFiles} files; raise --max-files to scan more`);

  const files: SourceFile[] = [];
  for (const f of found) {
    try {
      const text = await readText(f.abs, maxBytes, warnings, f.rel);
      if (text !== null) files.push({ path: f.rel, text, kind: f.kind });
    } catch (err) {
      warnings.push(`could not read ${f.rel}: ${(err as Error).message}`);
    }
  }
  return { files, warnings };
}
