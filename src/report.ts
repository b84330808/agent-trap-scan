// Ties a target (a path or a GitHub repository) to a full scan report.
import { stat } from "node:fs/promises";
import { scanFiles, summarize, type ScanOptions } from "./scan.ts";
import { collectGitHub, parseGitHubTarget, type GitHubOptions } from "./sources/github.ts";
import { collectLocal, type CollectOptions } from "./sources/local.ts";
import type { ScanReport, SourceFile } from "./types.ts";
import { NAME, VERSION } from "./version.ts";

export interface TargetOptions extends ScanOptions, CollectOptions {
  /** Force a mode instead of guessing from the target. */
  mode?: "local" | "github";
  /** Branch, tag or commit (GitHub mode). */
  ref?: string;
  github?: Omit<GitHubOptions, keyof CollectOptions>;
}

function build(target: string, mode: ScanReport["mode"], files: SourceFile[], warnings: string[], options: ScanOptions, extra: Partial<ScanReport> = {}): ScanReport {
  const findings = scanFiles(files, options);
  return {
    tool: { name: NAME, version: VERSION },
    target,
    mode,
    ...extra,
    files: files.map((f) => ({ path: f.path, kind: f.kind, bytes: Buffer.byteLength(f.text), ...(f.url ? { url: f.url } : {}) })),
    findings,
    summary: summarize(findings),
    warnings,
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function scanLocal(path: string, options: TargetOptions = {}): Promise<ScanReport> {
  const { files, warnings } = await collectLocal(path, options);
  return build(path, "local", files, warnings, options);
}

export async function scanGitHub(target: string, options: TargetOptions = {}): Promise<ScanReport> {
  const parsed = parseGitHubTarget(target);
  if (!parsed) throw new Error(`not a GitHub repository: ${target} (expected owner/repo or a github.com URL)`);
  const ref = options.ref ?? parsed.ref;
  const got = await collectGitHub(ref ? { ...parsed, ref } : parsed, { ...options.github, maxFiles: options.maxFiles, maxBytes: options.maxBytes });
  return build(`${parsed.owner}/${parsed.repo}`, "github", got.files, got.warnings, options, { ref: got.ref, commit: got.commit });
}

/** A path that exists is scanned on disk; otherwise owner/repo or a GitHub URL is fetched. */
export async function scanTarget(target: string, options: TargetOptions = {}): Promise<ScanReport> {
  if (options.mode === "local") return scanLocal(target, options);
  if (options.mode === "github") return scanGitHub(target, options);
  if (await exists(target)) return scanLocal(target, options);
  if (parseGitHubTarget(target)) return scanGitHub(target, options);
  throw new Error(`no such file or directory, and not a GitHub repository: ${target}`);
}

/** Scans text that did not come from disk, such as a file an agent fetched with `gh api` or `curl`. */
export function scanText(path: string, text: string, kind: SourceFile["kind"], options: ScanOptions = {}): ScanReport {
  return build(path, "local", [{ path, text, kind }], [], options);
}
