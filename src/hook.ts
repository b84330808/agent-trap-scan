// Claude Code hook handler: `agent-trap-scan hook` reads the hook event on stdin and, when it finds
// something, prints JSON that adds a short factual note to the agent's context.
//
// - SessionStart: scans the repository the session starts in.
// - PreToolUse (Read): scans an agent-facing file (AGENTS.md, CONTRIBUTING.md, ...) before the agent reads it.
// - PostToolUse (Bash, PowerShell): scans a repository right after `git clone` / `gh repo clone`, and
//   agent-facing files the command printed (`cat AGENTS.md`, `gh api .../contents/CLAUDE.md`).
//
// It never blocks a tool call and exits 0 even when something goes wrong.
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { cloneTargets, splitCommands } from "./clone.ts";
import { formatContext } from "./format.ts";
import { scanLocal, scanText } from "./report.ts";
import { clean } from "./scan.ts";
import { findRepoRoot } from "./sources/local.ts";
import { classifyPath } from "./surface.ts";
import type { Finding, ScanReport } from "./types.ts";

export interface HookInput {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  source?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  tool_use_id?: string;
}

export interface HookDeps {
  /** Where the per-session record of reported findings lives. */
  stateDir?: string;
  env?: NodeJS.ProcessEnv;
  /** How the note tells the agent to get the full report. Default: this script run with node. */
  selfCommand?: string;
}

export interface HookOutput {
  hookSpecificOutput: { hookEventName: string; additionalContext: string };
  systemMessage?: string;
}

const AGENT_FILE_IN_COMMAND =
  /(?:^|[\s/'"`:\\])((?:AGENTS|AGENT|CLAUDE|GEMINI|SKILL|CONTRIBUTING|copilot-instructions|llms|llms-full)(?:\.[\w.]+)?|\.cursorrules|\.windsurfrules|\.clinerules|\.goosehints|\.mcp\.json|(?:pull_request|PULL_REQUEST)_TEMPLATE(?:\.md)?)(?=$|[\s'"`?#)&|;])/;
/** Commands that print a file or a download. Checked on each simple command of the line, not just the first. */
const READS_OUTPUT = /^(?:cat|type|more|less|head|tail|bat|Get-Content|gc|git|gh|curl|wget|iwr|irm|Invoke-WebRequest|Invoke-RestMethod)(?:\.exe)?$/i;

/** Time a hook may spend scanning, leaving room under the timeouts in hooks/hooks.json. */
const BUDGET_MS = { SessionStart: 20_000, PreToolUse: 6_000, PostToolUse: 20_000 } as const;

function toPosix(p: string): string {
  return p.split(sep).join("/");
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Creates a marker file once; false when another process already created it. */
async function claim(stateDir: string, id: string): Promise<boolean> {
  try {
    const dir = join(stateDir, "claims");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, createHash("sha256").update(id).digest("hex").slice(0, 32)), "", { flag: "wx" });
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "EEXIST";
  }
}

function key(f: Finding, base: string): string {
  return createHash("sha256").update(`${base}\0${f.file}\0${f.rule}\0${f.excerpt}`).digest("hex").slice(0, 16);
}

class Seen {
  #file: string | null;
  #keys = new Set<string>();
  constructor(stateDir: string, sessionId: string | undefined) {
    this.#file = sessionId ? join(stateDir, `session-${sessionId.replace(/[^\w.-]/g, "_").slice(0, 80)}.json`) : null;
  }
  async load(reset: boolean): Promise<void> {
    if (!this.#file || reset) return;
    try {
      const data = JSON.parse(await readFile(this.#file, "utf8")) as { keys?: string[] };
      for (const k of data.keys ?? []) this.#keys.add(k);
    } catch {
      // first event of the session
    }
  }
  /** Drops findings already reported in this session and remembers the rest. */
  fresh(findings: Finding[], base: string): Finding[] {
    const out = findings.filter((f) => !this.#keys.has(key(f, base)));
    for (const f of out) this.#keys.add(key(f, base));
    return out;
  }
  async save(): Promise<void> {
    if (!this.#file) return;
    try {
      await mkdir(dirname(this.#file), { recursive: true });
      const tmp = `${this.#file}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify({ keys: [...this.#keys].slice(-5000) }));
      await rename(tmp, this.#file);
    } catch {
      // best effort
    }
  }
}

function output(event: string, context: string, findings: Finding[]): HookOutput {
  const high = findings.filter((f) => f.severity === "high").length;
  const medium = findings.filter((f) => f.severity === "medium").length;
  const out: HookOutput = { hookSpecificOutput: { hookEventName: event, additionalContext: context } };
  if (high || medium) out.systemMessage = `agent-trap-scan: ${[high && `${high} high`, medium && `${medium} medium`].filter(Boolean).join(", ")} finding(s) in text aimed at AI agents`;
  return out;
}

function shown(findings: Finding[]): Finding[] {
  // Low findings alone are not worth a note in the agent's context.
  return findings.some((f) => f.severity === "high" || f.severity === "medium" || f.severity === "info") ? findings : [];
}

function outputOf(response: unknown): { stdout: string; stderr: string } {
  if (typeof response === "string") return { stdout: response, stderr: "" };
  if (response && typeof response === "object") {
    const r = response as Record<string, unknown>;
    const stdout = typeof r.stdout === "string" ? r.stdout : typeof r.output === "string" ? r.output : "";
    return { stdout, stderr: typeof r.stderr === "string" ? r.stderr : "" };
  }
  return { stdout: "", stderr: "" };
}

/** `gh api .../contents/AGENTS.md` prints JSON with the file in base64; anything else is used as printed. */
function printedText(stdout: string): string {
  const t = stdout.trim();
  if (!t.startsWith("{")) return stdout;
  try {
    const data = JSON.parse(t) as { content?: unknown; encoding?: unknown };
    if (typeof data.content === "string" && data.encoding === "base64") return Buffer.from(data.content, "base64").toString("utf8");
  } catch {
    // not JSON after all
  }
  return stdout;
}

/** Directories git reported cloning into ("Cloning into 'dir'..."), for command lines the parser could not follow. */
function clonedInto(output: string, cwd: string): string[] {
  return [...output.matchAll(/^Cloning into (?:bare repository )?'(.+?)'\.\.\./gm)].map((m) => resolve(cwd, m[1]!));
}

export async function handleHook(input: HookInput, deps: HookDeps = {}): Promise<HookOutput | null> {
  const env = deps.env ?? process.env;
  const stateDir = deps.stateDir ?? join(tmpdir(), "agent-trap-scan");
  const event = input.hook_event_name ?? "";
  const cwd = input.cwd || process.cwd();
  const started = Date.now();
  // Several `if` filters can match one tool call; the first process to claim it does the work.
  if (input.tool_use_id && !(await claim(stateDir, `${event}-${input.session_id ?? ""}-${input.tool_use_id}`))) return null;
  const seen = new Seen(stateDir, input.session_id);
  const self = deps.selfCommand ?? (process.argv[1] ? `node "${toPosix(process.argv[1])}"` : "agent-trap-scan");

  if (event === "SessionStart") {
    let root = await findRepoRoot(cwd);
    if (!root) return null;
    // A dotfiles repository at the home directory would mean walking all of $HOME; scan where the session started instead.
    if (resolve(root) === resolve(homedir()) || dirname(resolve(root)) === resolve(root)) {
      if (resolve(cwd) === resolve(root)) return null;
      root = cwd;
    }
    // After /clear or compaction the earlier note is gone from context, so report everything again.
    await seen.load(input.source !== "resume" && input.source !== "fork");
    const report = await scanLocal(root, { maxFiles: 300, deadline: started + BUDGET_MS.SessionStart });
    const findings = shown(seen.fresh(report.findings, root));
    await seen.save();
    if (!findings.length) return null;
    const files = plural(report.files.length, "agent-facing file");
    const subject = root === cwd ? `this repository (${files})` : `the repository at ${JSON.stringify(toPosix(root))} (${files})`;
    return output(event, formatContext(findings, { subject, fullReport: self, path: toPosix(root), warnings: report.warnings }), findings);
  }

  if (event === "PreToolUse" && input.tool_name === "Read") {
    const path = typeof input.tool_input?.file_path === "string" ? input.tool_input.file_path : "";
    if (!path) return null;
    const root = await findRepoRoot(dirname(path));
    const rel = root ? toPosix(relative(root, path)) : basename(path);
    if (!classifyPath(rel) && !classifyPath(basename(path))) return null;
    await seen.load(false);
    const report = await scanLocal(path, { deadline: started + BUDGET_MS.PreToolUse });
    // Findings carry the bare file name in single-file mode; show the path the agent used.
    for (const f of report.findings) f.file = clean(rel);
    const findings = shown(seen.fresh(report.findings, root ?? dirname(path)));
    await seen.save();
    if (!findings.length) return null;
    return output(event, formatContext(findings, { subject: `${JSON.stringify(clean(rel))}, which is about to be read`, fullReport: self, path: toPosix(path), warnings: report.warnings }), findings);
  }

  if (event === "PostToolUse" && (input.tool_name === "Bash" || input.tool_name === "PowerShell")) {
    const command = typeof input.tool_input?.command === "string" ? input.tool_input.command : "";
    if (!command) return null;
    await seen.load(false);
    const notes: string[] = [];
    const all: Finding[] = [];

    const shell = input.tool_name === "PowerShell" ? "powershell" : "bash";
    const { stdout, stderr } = outputOf(input.tool_response);
    const dirs = new Set([...cloneTargets(command, cwd, env, shell), ...clonedInto(`${stderr}\n${stdout}`, cwd)]);
    for (const dir of dirs) {
      if (!(await isDir(dir))) continue;
      const report: ScanReport = await scanLocal(dir, { maxFiles: 300, deadline: started + BUDGET_MS.PostToolUse });
      const findings = shown(seen.fresh(report.findings, dir));
      if (!findings.length) continue;
      all.push(...findings);
      const subject = `the clone at ${JSON.stringify(clean(toPosix(dir)))} (${plural(report.files.length, "agent-facing file")})`;
      notes.push(formatContext(findings, { subject, fullReport: self, path: toPosix(dir), warnings: report.warnings }));
    }

    const named = AGENT_FILE_IN_COMMAND.exec(command);
    const reads = splitCommands(command).some((words) => {
      const w = words.filter((x, i) => i > 0 || !/^\w+=/.test(x));
      return READS_OUTPUT.test(w[0] ?? "") && (w[0]?.toLowerCase().replace(/\.exe$/, "") !== "git" || w[1] === "show");
    });
    const printed = printedText(stdout);
    if (named && printed.trim() && reads) {
      const name = named[1]!;
      const kind = classifyPath(name) ?? "agent";
      const report = scanText(name, printed, kind);
      const findings = shown(seen.fresh(report.findings, `output:${command}`));
      if (findings.length) {
        all.push(...findings);
        notes.push(formatContext(findings, { subject: `the ${name} text this command printed`, fullReport: `${self} on a saved copy of the file` }));
      }
    }
    await seen.save();
    if (!all.length) return null;
    return output(event, notes.join("\n\n"), all);
  }
  return null;
}

/** Entry point for `agent-trap-scan hook`. Always resolves; prints JSON only when there is something to say. */
export async function runHook(stdin: NodeJS.ReadableStream, stdout: NodeJS.WritableStream): Promise<void> {
  let raw = "";
  for await (const chunk of stdin) raw += chunk;
  let input: HookInput;
  try {
    input = JSON.parse(raw) as HookInput;
  } catch {
    return;
  }
  try {
    const out = await handleHook(input);
    if (out) stdout.write(`${JSON.stringify(out)}\n`);
  } catch (err) {
    process.stderr.write(`agent-trap-scan hook: ${(err as Error).message}\n`);
  }
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}
