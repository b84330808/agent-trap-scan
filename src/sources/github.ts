// Collects the agent-facing files of a GitHub repository without cloning it:
// one tree listing through the API, then raw file downloads.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { classifyPath } from "../surface.ts";
import type { SourceFile } from "../types.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_FILES, type CollectOptions } from "./local.ts";

const execFileAsync = promisify(execFile);

export interface GitHubTarget {
  owner: string;
  repo: string;
  ref?: string;
}

export type Fetcher = (url: string, init: { headers: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

export interface GitHubOptions extends CollectOptions {
  fetch?: Fetcher;
  /** A GitHub token. Optional for public repositories (60 API calls an hour without one). */
  token?: string | null;
  apiBase?: string;
  rawBase?: string;
}

export interface GitHubCollected {
  files: SourceFile[];
  warnings: string[];
  ref: string;
  commit: string;
}

export class GitHubError extends Error {
  override name = "GitHubError";
}

const NAME = /^[A-Za-z0-9_.-]+$/;

/** Accepts owner/repo, owner/repo@ref, github:owner/repo, git@github.com:owner/repo.git and github.com URLs (with /tree/<ref>). */
export function parseGitHubTarget(input: string): GitHubTarget | null {
  let s = input.trim();
  let ref: string | undefined;
  const url = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s#?]+?)(?:\.git)?(?:\/(?:tree|blob)\/([^\s#?]+))?\/?(?:[#?].*)?$/i.exec(s);
  if (url) {
    const [, owner, repo, tree] = url;
    if (!NAME.test(owner!) || !NAME.test(repo!)) return null;
    return tree ? { owner: owner!, repo: repo!, ref: decodeURIComponent(tree) } : { owner: owner!, repo: repo! };
  }
  const ssh = /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i.exec(s);
  if (ssh) return NAME.test(ssh[1]!) && NAME.test(ssh[2]!) ? { owner: ssh[1]!, repo: ssh[2]! } : null;
  s = s.replace(/^github:/i, "");
  const at = s.indexOf("@");
  if (at !== -1) {
    ref = s.slice(at + 1);
    s = s.slice(0, at);
    if (!ref) return null;
  }
  const parts = s.split("/");
  if (parts.length !== 2 || !parts.every((x) => NAME.test(x) && x !== "." && x !== "..")) return null;
  return ref ? { owner: parts[0]!, repo: parts[1]!, ref } : { owner: parts[0]!, repo: parts[1]! };
}

/** GITHUB_TOKEN, then GH_TOKEN, then `gh auth token`; null when none is available. */
export async function resolveToken(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const fromEnv = env.GITHUB_TOKEN || env.GH_TOKEN;
  if (fromEnv) return fromEnv.trim();
  try {
    const { stdout } = await execFileAsync("gh", ["auth", "token"], { timeout: 10_000, windowsHide: true });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

interface TreeEntry {
  path: string;
  type: string;
  size?: number;
}

const encodePath = (p: string) => p.split("/").map(encodeURIComponent).join("/");

/** Paths tried one by one when the tree listing is too large for GitHub to return in full. */
const FALLBACK_PATHS = [
  "AGENTS.md",
  "CLAUDE.md",
  "GEMINI.md",
  ".cursorrules",
  ".windsurfrules",
  ".mcp.json",
  ".claude/settings.json",
  ".claude/CLAUDE.md",
  ".github/copilot-instructions.md",
  ".github/pull_request_template.md",
  ".github/PULL_REQUEST_TEMPLATE.md",
  "CONTRIBUTING.md",
  ".github/CONTRIBUTING.md",
  "docs/CONTRIBUTING.md",
  "CONTRIBUTING.rst",
  "AI_POLICY.md",
  "README.md",
  "README.rst",
  "SECURITY.md",
];

export async function collectGitHub(target: GitHubTarget, options: GitHubOptions = {}): Promise<GitHubCollected> {
  const doFetch: Fetcher = options.fetch ?? (globalThis.fetch as unknown as Fetcher);
  const api = options.apiBase ?? "https://api.github.com";
  const raw = options.rawBase ?? "https://raw.githubusercontent.com";
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const token = options.token === undefined ? await resolveToken() : options.token;
  const warnings: string[] = [];
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "agent-trap-scan",
    "x-github-api-version": "2022-11-28",
  };
  if (token) headers.authorization = `Bearer ${token}`;
  const repoPath = `${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}`;

  const getJson = async (url: string): Promise<unknown> => {
    const res = await doFetch(url, { headers });
    if (res.status === 404) throw new GitHubError(`${target.owner}/${target.repo}: not found (or private and the token cannot see it)`);
    if (res.status === 401) throw new GitHubError("GitHub rejected the token (401). Check GITHUB_TOKEN or run `gh auth login`.");
    if (res.status === 403 || res.status === 429) {
      throw new GitHubError(`GitHub API rate limit or access error (${res.status}).${token ? "" : " Set GITHUB_TOKEN or run `gh auth login` for a higher limit."}`);
    }
    if (!res.ok) throw new GitHubError(`GitHub API returned ${res.status} for ${url}`);
    return res.json();
  };

  let ref = target.ref;
  if (!ref) {
    const repo = (await getJson(`${api}/repos/${repoPath}`)) as { default_branch?: string };
    ref = repo.default_branch ?? "HEAD";
  }
  const commitInfo = (await getJson(`${api}/repos/${repoPath}/commits/${encodeURIComponent(ref)}`)) as { sha?: string };
  const commit = commitInfo.sha;
  if (!commit) throw new GitHubError(`could not resolve ${ref} to a commit`);
  const tree = (await getJson(`${api}/repos/${repoPath}/git/trees/${commit}?recursive=1`)) as { tree?: TreeEntry[]; truncated?: boolean };

  let candidates: Array<{ path: string; size?: number }> = [];
  if (tree.truncated) {
    warnings.push("the repository tree is too large to list in full; scanned the usual top-level files only");
    candidates = FALLBACK_PATHS.map((path) => ({ path }));
  }
  for (const entry of tree.tree ?? []) {
    if (entry.type !== "blob") continue;
    if (tree.truncated && candidates.some((c) => c.path === entry.path)) continue;
    if (classifyPath(entry.path)) candidates.push({ path: entry.path, size: entry.size });
  }
  // Shallow paths first, so the cap drops deep files.
  candidates.sort((x, y) => x.path.split("/").length - y.path.split("/").length || x.path.localeCompare(y.path));
  if (candidates.length > maxFiles) {
    warnings.push(`found ${candidates.length} files; scanned the first ${maxFiles} (raise --max-files to scan more)`);
    candidates = candidates.slice(0, maxFiles);
  }

  const rawHeaders: Record<string, string> = { "user-agent": "agent-trap-scan" };
  if (token) rawHeaders.authorization = `Bearer ${token}`;
  const files: SourceFile[] = [];
  const queue = [...candidates];
  const worker = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const kind = classifyPath(next.path);
      if (!kind) continue;
      if (next.size !== undefined && next.size > maxBytes) {
        warnings.push(`skipped ${next.path}: ${next.size} bytes is over the ${maxBytes}-byte limit`);
        continue;
      }
      try {
        const res = await doFetch(`${raw}/${repoPath}/${commit}/${encodePath(next.path)}`, { headers: rawHeaders });
        if (res.status === 404) continue;
        if (!res.ok) {
          warnings.push(`could not download ${next.path} (${res.status})`);
          continue;
        }
        const text = await res.text();
        if (text.length > maxBytes || text.slice(0, 8000).includes("\u0000")) continue;
        files.push({ path: next.path, text, kind, url: `https://github.com/${repoPath}/blob/${commit}/${encodePath(next.path)}` });
      } catch (err) {
        warnings.push(`could not download ${next.path}: ${(err as Error).message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  files.sort((x, y) => x.path.localeCompare(y.path));
  return { files, warnings, ref, commit };
}
