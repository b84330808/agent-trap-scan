import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyPath } from "../src/surface.ts";
import { parseGitHubTarget } from "../src/sources/github.ts";

describe("which files are agent-facing", () => {
  const cases: Array<[string, string | null]> = [
    ["AGENTS.md", "agent"],
    ["packages/core/AGENTS.md", "agent"],
    ["CLAUDE.md", "agent"],
    [".claude/settings.json", "agent"],
    [".claude/hooks/check.sh", "agent"],
    [".claude/commands/release.md", "agent"],
    [".cursor/rules/style.mdc", "agent"],
    [".cursorrules", "agent"],
    [".github/copilot-instructions.md", "agent"],
    [".github/instructions/ts.instructions.md", "agent"],
    [".mcp.json", "agent"],
    [".vscode/settings.json", "agent"],
    ["skills/x/SKILL.md", "agent"],
    ["llms.txt", "agent"],
    ["CONTRIBUTING.md", "contributing"],
    [".github/CONTRIBUTING.md", "contributing"],
    ["CONTRIBUTING.rst", "contributing"],
    ["website/src/latest/docs/contributing.md", "contributing"],
    ["AI_POLICY.md", "contributing"],
    ["SECURITY.md", "contributing"],
    [".github/pull_request_template.md", "template"],
    [".github/PULL_REQUEST_TEMPLATE/feature.md", "template"],
    [".github/ISSUE_TEMPLATE/bug.yml", "template"],
    ["README.md", "readme"],
    ["README", "readme"],
    ["docs/guide/README.md", null],
    ["src/index.ts", null],
    [".claude/logo.png", null],
    ["docs/llms.txt", "agent"],
    ["a/b/c/llms.txt", null],
    ["CLAUDE-FIXING-ISSUES.md", "agent"],
    ["AGENTS.override.md", "agent"],
    ["docs/CLAUDE_RELEASE.md", "agent"],
    ["docs/agent_executor.md", null],
    ["docs/claude-setup.md", null],
  ];
  for (const [path, kind] of cases) it(path, () => assert.equal(classifyPath(path), kind));
});

describe("GitHub targets", () => {
  it("parses the usual forms", () => {
    assert.deepEqual(parseGitHubTarget("owner/repo"), { owner: "owner", repo: "repo" });
    assert.deepEqual(parseGitHubTarget("owner/repo@v1.2"), { owner: "owner", repo: "repo", ref: "v1.2" });
    assert.deepEqual(parseGitHubTarget("github:owner/repo"), { owner: "owner", repo: "repo" });
    assert.deepEqual(parseGitHubTarget("https://github.com/owner/repo.git"), { owner: "owner", repo: "repo" });
    assert.deepEqual(parseGitHubTarget("https://github.com/owner/repo/tree/feature/x"), { owner: "owner", repo: "repo", ref: "feature/x" });
    assert.deepEqual(parseGitHubTarget("git@github.com:owner/repo.git"), { owner: "owner", repo: "repo" });
  });
  it("rejects things that are not repositories", () => {
    for (const s of ["owner", "a/b/c", "../x", "owner/..", "https://gitlab.com/a/b", "owner/repo@"]) assert.equal(parseGitHubTarget(s), null, s);
  });
});
