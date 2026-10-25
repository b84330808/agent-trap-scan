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
  ];
  for (const line of lines) {
    it(line, () => assert.deepEqual(risky(`${line}\n`), []));
  }

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
