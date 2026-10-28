// Which files in a repository an AI coding agent is likely to read, and what kind each one is.
import type { FileKind } from "./types.ts";

/** Files written for agents, at any depth (matched without regard to case). */
export const AGENT_FILE_NAMES = [
  "AGENTS.md",
  "AGENT.md",
  "CLAUDE.md",
  "CLAUDE.local.md",
  "GEMINI.md",
  "SKILL.md",
  "copilot-instructions.md",
  ".cursorrules",
  ".windsurfrules",
  ".clinerules",
  ".goosehints",
  ".mcp.json",
] as const;
const AGENT_NAMES = new Set<string>(AGENT_FILE_NAMES.map((n) => n.toLowerCase()));

/**
 * Variants of those names that hold more instructions ("CLAUDE-FIXING-ISSUES.md", "AGENTS.override.md").
 * Upper case only: "agent_executor.md" in an agent framework's docs is not one.
 */
export const AGENT_FILE_VARIANT_GLOBS = ["AGENTS-*.md", "AGENTS_*.md", "AGENTS.*.md", "CLAUDE-*.md", "CLAUDE_*.md", "CLAUDE.*.md", "GEMINI-*.md", "GEMINI_*.md"] as const;
const AGENT_FILE_VARIANT = /^(?:AGENTS|CLAUDE|GEMINI)[-_.][\w.-]*\.md$/;

/** Files written for agents that only count near the top of the tree. */
export const SHALLOW_AGENT_FILE_NAMES = ["llms.txt", "llms-full.txt"] as const;
const SHALLOW_AGENT_NAMES = new Set<string>(SHALLOW_AGENT_FILE_NAMES);

/** Directories whose whole content is agent configuration or instructions. */
export const AGENT_DIR_NAMES = [
  ".claude",
  ".cursor",
  ".agents",
  ".codex",
  ".gemini",
  ".windsurf",
  ".clinerules",
  ".roo",
  ".junie",
  ".kiro",
  ".continue",
  ".amazonq",
] as const;
const AGENT_DIRS = new Set<string>(AGENT_DIR_NAMES);

/** Agent folders that live under .github/. */
export const GITHUB_AGENT_DIR_NAMES = ["instructions", "prompts", "agents", "chatmodes", "copilot"] as const;
const GITHUB_AGENT_DIRS = new Set<string>(GITHUB_AGENT_DIR_NAMES);

/** Editor settings that can carry agent instructions or auto-approve agent actions. */
export const AGENT_CONFIG_FILE_PATHS = [".vscode/mcp.json", ".vscode/settings.json"] as const;
const AGENT_CONFIG_PATHS = new Set<string>(AGENT_CONFIG_FILE_PATHS);

const TEXT_EXT = /\.(md|mdx|markdown|mdc|rst|txt|adoc)$/i;
const CONFIG_EXT = /\.(json|jsonc|ya?ml|toml)$/i;
const SCRIPT_EXT = /\.(sh|bash|zsh|ps1|js|mjs|cjs|ts|py)$/i;

/** Directories the local walker never enters. Agent directories are not in this list. */
export const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "bower_components",
  "vendor",
  "third_party",
  "dist",
  "build",
  "out",
  "target",
  "coverage",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".cache",
  ".venv",
  "venv",
  "__pycache__",
  ".tox",
  ".nox",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".gradle",
  ".idea",
  "Pods",
  "DerivedData",
]);

/** Deepest directory level the scanners look at. */
export const MAX_DEPTH = 8;

function hasTextExtension(name: string): boolean {
  return TEXT_EXT.test(name) || !name.includes(".") || name.startsWith(".");
}

/**
 * Classifies a path relative to the repository root (forward slashes).
 * Returns null for files that are not part of the agent-facing surface.
 */
export function classifyPath(relPath: string): FileKind | null {
  const path = relPath.replace(/\\/g, "/").replace(/^\.\/+/, "");
  const parts = path.split("/").filter(Boolean);
  if (parts.length === 0 || parts.length - 1 > MAX_DEPTH) return null;
  const name = parts[parts.length - 1]!;
  const lower = name.toLowerCase();
  const dirs = parts.slice(0, -1).map((d) => d.toLowerCase());
  const depth = dirs.length;
  const lowerPath = path.toLowerCase();

  if (dirs.some((d) => AGENT_DIRS.has(d))) {
    return TEXT_EXT.test(name) || CONFIG_EXT.test(name) || SCRIPT_EXT.test(name) || !name.includes(".") ? "agent" : null;
  }
  const gh = dirs.indexOf(".github");
  if (gh !== -1 && dirs[gh + 1] !== undefined && GITHUB_AGENT_DIRS.has(dirs[gh + 1]!)) {
    return TEXT_EXT.test(name) || CONFIG_EXT.test(name) ? "agent" : null;
  }
  if (AGENT_NAMES.has(lower) || AGENT_FILE_VARIANT.test(name)) return "agent";
  if (SHALLOW_AGENT_NAMES.has(lower) && depth <= 2) return "agent";
  if (AGENT_CONFIG_PATHS.has(lowerPath)) return "agent";

  if (isTemplatePath(dirs, lower)) return "template";

  if (/^contributing(\.|$)/.test(lower) && depth <= 4 && hasTextExtension(name)) return "contributing";
  if (/^(ai|llm|agents?)[-_ ]?(policy|usage|use|guidelines|contributions?)(\.|$)/.test(lower) && depth <= 2 && hasTextExtension(name)) {
    return "contributing";
  }
  if (/^security(\.|$)/.test(lower) && depth <= 1 && hasTextExtension(name)) return "contributing";

  if (/^readme(\.|$)/.test(lower) && hasTextExtension(name) && (depth === 0 || (depth === 1 && dirs[0] === ".github"))) {
    return "readme";
  }
  return null;
}

function isTemplatePath(dirs: string[], lower: string): boolean {
  const inMeta = dirs.length > 0 && [".github", "docs", ".gitlab", ".gitea", ".forgejo"].includes(dirs[0]!);
  if (/^(pull_request_template|merge_request_template)(\.|$)/.test(lower) && (dirs.length === 0 || inMeta)) return true;
  if (!inMeta || !(TEXT_EXT.test(lower) || CONFIG_EXT.test(lower))) return false;
  return dirs.slice(1).some((d) => /^(pull_request_template|issue_template|merge_request_templates|issue_templates|discussion_template)$/.test(d));
}

/** True for files the scanners should parse as Markdown (HTML comments, headings). */
export function isMarkdownPath(path: string): boolean {
  return /\.(md|mdx|markdown|mdc|html?)$/i.test(path);
}

export function isRstPath(path: string): boolean {
  return /\.rst$/i.test(path);
}
