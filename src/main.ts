import { parseArgs } from "node:util";
import { formatJson, formatText, visibleFindings } from "./format.ts";
import { runHook } from "./hook.ts";
import { scanTarget } from "./report.ts";
import { BUILTIN_RULES, RULES, allRuleIds } from "./rules.ts";
import { type Severity, SEVERITIES, severityRank } from "./types.ts";
import { VERSION } from "./version.ts";

const HELP = `agent-trap-scan ${VERSION}
Scan a repository for text aimed at AI coding agents and flag the risky parts.

Usage:
  agent-trap-scan [path]                 scan a directory or one file (default: .)
  agent-trap-scan <owner/repo[@ref]>     scan a GitHub repository without cloning it
  agent-trap-scan <github.com URL>       same, e.g. https://github.com/owner/repo/tree/main
  agent-trap-scan hook                   run as a Claude Code hook (reads the hook event on stdin)
  agent-trap-scan rules                  list the rules

Options:
  --json                 print the report as JSON
  --fail-on <level>      exit 1 when a finding is at least this severe: high (default), medium, low, never
  --min-severity <level> hide findings below this level in text output (default: info)
  --ignore <ids>         comma-separated rule ids to skip
  --ref <ref>            branch, tag or commit to scan (GitHub mode)
  --github / --local     treat the target as a GitHub repository / as a path
  --max-files <n>        stop after this many files (default: 400)
  --no-color             plain output
  -h, --help             show this help
  -v, --version          show the version

Exit codes: 0 nothing at --fail-on level, 1 found something, 2 error.
GitHub mode reads GITHUB_TOKEN, GH_TOKEN or \`gh auth token\` when available; public repositories work without one.`;

const LEVELS = new Set<string>([...SEVERITIES, "never"]);

function level(name: string, value: string | undefined, fallback: string): string {
  const v = value ?? fallback;
  const allowNever = name === "--fail-on";
  if (!LEVELS.has(v) || (v === "never" && !allowNever)) throw new UsageError(`${name} must be one of high, medium, low, info${allowNever ? ", never" : ""}`);
  return v;
}

class UsageError extends Error {}

export async function main(argv: string[], io = { stdout: process.stdout, stderr: process.stderr, stdin: process.stdin }): Promise<number> {
  if (argv[0] === "hook") {
    await runHook(io.stdin, io.stdout);
    return 0;
  }
  if (argv[0] === "rules") {
    for (const r of [...RULES, ...BUILTIN_RULES]) io.stdout.write(`${r.id.padEnd(24)} ${r.severity.padEnd(6)} ${r.category.padEnd(18)} ${r.title}\n`);
    return 0;
  }
  let values;
  let positionals;
  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        json: { type: "boolean" },
        "fail-on": { type: "string" },
        "min-severity": { type: "string" },
        ignore: { type: "string" },
        ref: { type: "string" },
        github: { type: "boolean" },
        local: { type: "boolean" },
        "max-files": { type: "string" },
        "no-color": { type: "boolean" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
    }));
  } catch (err) {
    io.stderr.write(`${(err as Error).message}\n\n${HELP}\n`);
    return 2;
  }
  if (values.help) {
    io.stdout.write(`${HELP}\n`);
    return 0;
  }
  if (values.version) {
    io.stdout.write(`${VERSION}\n`);
    return 0;
  }
  try {
    if (positionals.length > 1) throw new UsageError("give one target");
    const failOn = level("--fail-on", values["fail-on"], "high");
    const minSeverity = level("--min-severity", values["min-severity"], "info") as Severity;
    const ignore = (values.ignore ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const known = new Set(allRuleIds());
    const unknown = ignore.filter((id) => !known.has(id));
    if (unknown.length) throw new UsageError(`unknown rule id: ${unknown.join(", ")} (see \`agent-trap-scan rules\`)`);
    const maxFiles = values["max-files"] === undefined ? undefined : Number(values["max-files"]);
    if (maxFiles !== undefined && (!Number.isInteger(maxFiles) || maxFiles < 1)) throw new UsageError("--max-files must be a positive whole number");
    if (values.github && values.local) throw new UsageError("use --github or --local, not both");

    const report = await scanTarget(positionals[0] ?? ".", {
      ignore,
      maxFiles,
      ref: values.ref,
      mode: values.github ? "github" : values.local ? "local" : undefined,
    });
    if (values.json) io.stdout.write(`${formatJson(report)}\n`);
    else {
      const color = !values["no-color"] && !process.env.NO_COLOR && Boolean((io.stdout as NodeJS.WriteStream).isTTY);
      io.stdout.write(`${formatText(report, { color, minSeverity })}\n`);
    }
    if (failOn === "never") return 0;
    return visibleFindings(report).some((f) => severityRank(f.severity) >= severityRank(failOn as Severity)) ? 1 : 0;
  } catch (err) {
    io.stderr.write(`agent-trap-scan: ${(err as Error).message}\n`);
    if (err instanceof UsageError) io.stderr.write("Run `agent-trap-scan --help` for usage.\n");
    return 2;
  }
}
