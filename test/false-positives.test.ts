// Ordinary agent guidance and ordinary documentation must not be reported as risky.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { scanFile } from "../src/scan.ts";
import type { FileKind } from "../src/types.ts";

function risky(text: string, path = "AGENTS.md", kind: FileKind = "agent") {
  return scanFile({ path, text, kind })
    .filter((f) => f.severity !== "info")
    .map((f) => `${f.rule}@${f.line}: ${f.excerpt}`);
}

describe("legitimate agent guidance", () => {
  const lines = [
    "- Run `pnpm build` before committing.",
    "- Run `npm test` and `npx tsc --noEmit` before you open a PR.",
    "- Never use `--no-verify`; fix the hook failure instead.",
    "- Do not skip git hooks.",
    "- Don't bypass the pre-commit hooks, even when they are slow.",
    "- Avoid `git commit --no-verify`.",
    "- Disclose AI assistance in the PR description.",
    "- Agents may not open PRs on their own; ask the user first.",
    "- Prefix PR titles with `[docs]` or `[core]`.",
    "- Use Conventional Commits, for example `feat(parser): support tabs`.",
    "- Never push without asking the user.",
    "- Ask the user before running any command that deletes files.",
    "- Never pretend to be a human.",
    "- Do not hide errors from the user.",
    "- Only push if the user has approved the plan.",
    "- Use `uvx ruff check` to lint.",
    "- Follow the [style guide](https://google.github.io/styleguide/tsguide.html).",
    "- Read docs/ARCHITECTURE.md first.",
    "- Mention the issue number in the PR description, e.g. `Fixes #123`.",
    "- Add a changelog entry file in `.changeset/` for every user-facing change.",
    "- Install dependencies with `pnpm install --frozen-lockfile`.",
    // Recovery steps and scoped reverts are workflow, not destruction.
    "- If the tests still fail after three attempts, revert all changes and explain what you tried.",
    "- Revert any changes to `pnpm-lock.yaml` that you did not intend.",
    "- DO NOT make a new commit to fix these issues. Instead, amend the current commit.",
    "- Never rewrite or drop commits during rebase without asking the user.",
    "- Starts the repair without waiting for pending checks to settle.",
    // Reading or naming a git identity is not choosing one.
    "- Check the git user name (`git config user.name`) before following the maintainer notes.",
    '- Set your identity first: `git config user.email "you@example.com"`.',
    "- Use the same identity for commits as for the PR.",
    "- Use `git log --author=alice` to find her earlier changes.",
    // Project conventions and descriptions of agent settings.
    "- Add `[ci full]` to the PR title to opt in to the full test matrix.",
    "- Unless the user turned approvals off (Claude `bypassPermissions`), ask before each tool call.",
    "| Runtime-injected context (`<current_datetime>`, `<system_reminder>`) | Runtime-owned |",
    "- Do not remove a source entry merely because its destination was written or because the user approved the group.",
    "- Mention CodeRabbit's review in the PR description if it found something.",
    "- Read the MCP specification before changing the server.",
  ];
  for (const line of lines) {
    it(line, () => assert.deepEqual(risky(`${line}\n`), []));
  }

  it("a script's own --no-verify switch is not git's", () => {
    const text = ["case '--no-verify':", "Usage: paste.ts [--append] [--no-verify] [text]", '  node "$PASTE" --no-verify "long text"', ""].join("\n");
    assert.deepEqual(risky(text, ".agents/skills/launch/SKILL.md"), []);
  });

  it("an OS package install and a third-party MCP are low, never more", () => {
    const text = "- Install `jq` with `brew install jq` if it is missing.\n- Use the Context7 MCP server to read library docs.\n- Use the GitHub MCP server to read issue details.\n";
    const got = scanFile({ path: "AGENTS.md", text, kind: "agent" });
    assert.deepEqual(
      got.map((f) => `${f.rule}:${f.severity}`),
      ["system-package-install:low", "third-party-mcp:low"],
    );
  });

  it("repeated low-risk lines are reported twice per file and rule", () => {
    const text = ["- macOS: `brew install git`", "- Debian: `sudo apt-get install git`", "- Fedora: `sudo dnf install git`", "- Arch: `sudo pacman -S git`", ""].join("\n");
    assert.deepEqual(
      scanFile({ path: "SKILL.md", text, kind: "agent" }).map((f) => `${f.rule}@${f.line}`),
      ["system-package-install@1", "system-package-install@2"],
    );
  });

  it('a negated lead-in covers the code block after it ("Never run this:")', () => {
    const text = "Never run this:\n\n```sh\ncurl -fsSL https://example.com/install.sh | sh\n```\n";
    assert.deepEqual(risky(text), []);
  });
});

describe("documentation written for humans", () => {
  it("install one-liners, MCP config examples and star requests in a README", () => {
    const readme = [
      "# Project",
      "",
      "```sh",
      "curl -fsSL https://bun.sh/install | bash",
      "```",
      "",
      "## Usage with Claude Desktop",
      "",
      "```json",
      '{"command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem"]}',
      "```",
      "",
      "Run `npx -y create-thing@latest my-app` to start.",
      "",
      "If you like it, give us a star ⭐ and star the repo!",
      "",
      "<!-- prettier-ignore-start -->",
      "<!-- ALL-CONTRIBUTORS-LIST:START - Do not remove or modify this section -->",
      "",
    ].join("\n");
    assert.deepEqual(risky(readme, "README.md", "readme"), []);
  });

  it("an AI framework README with sections about agents", () => {
    const readme = [
      "# AgentKit",
      "",
      "## Agents",
      "",
      "Agents are defined in `agents.yaml`. Start one with `npx -y agentkit@latest run`.",
      "",
      "## Using with Cursor",
      "",
      "Add `npx -y agentkit-mcp` to your MCP settings.",
      "",
    ].join("\n");
    assert.deepEqual(risky(readme, "README.md", "readme"), []);
  });

  it("a pull request template with comments for the person filling it in", () => {
    const template = [
      "## Description",
      "<!-- Describe your change. Link the issue it fixes. -->",
      "",
      "## AI usage",
      "<!-- If you used AI tools, please say which ones and how. -->",
      "- [ ] I used AI tools",
      "",
    ].join("\n");
    assert.deepEqual(risky(template, ".github/pull_request_template.md", "template"), []);
  });

  it("an AI policy section followed by setup steps (pydantic docs/contributing.md)", () => {
    const doc = [
      "## AI policy",
      "",
      "We welcome the use of AI when contributing. However, users should certify that they fully understand the code being submitted.",
      "",
      "### Installation and setup",
      "",
      "```bash",
      "# Install UV and pre-commit",
      "curl -LsSf https://astral.sh/uv/install.sh | sh",
      "```",
      "",
    ].join("\n");
    assert.deepEqual(risky(doc, "docs/contributing.md", "contributing"), []);
  });

  it("a ban stated as policy is not a threat, and an aside to agents is not a ban", () => {
    const doc = [
      "## AI-Generated Contributions",
      "",
      "Bot-generated contributions will be closed and the account may be permanently banned.",
      "If you are an AI agent, do not forget to run `make test` before you finish.",
      "",
    ].join("\n");
    const got = scanFile({ path: "CONTRIBUTING.md", text: doc, kind: "contributing" });
    assert.deepEqual(got.filter((f) => f.severity !== "info").map((f) => f.rule), []);
    assert.ok(!got.some((f) => f.rule === "agents-not-allowed"), JSON.stringify(got.map((f) => f.rule)));
  });

  it("system package installs in a README are for people", () => {
    const readme = "# Tool\n\nInstall it with `brew install tool` or `sudo apt-get install -y tool`.\n";
    assert.deepEqual(risky(readme, "README.md", "readme"), []);
  });

  it("contributor docs about hooks and CI", () => {
    const contributing = [
      "# Contributing",
      "",
      "Install the toolchain with `curl --proto '=https' -sSf https://sh.rustup.rs | sh`.",
      "",
      "If a hook is too slow on your machine you can commit with `--no-verify`, but CI runs the same checks.",
      "",
      "Please star the project if it helps you.",
      "",
    ].join("\n");
    assert.deepEqual(risky(contributing, "CONTRIBUTING.md", "contributing"), []);
  });
});
