// Agent configuration a repository can ship: Claude Code settings, MCP servers, editor
// auto-approve switches, and skills or commands that run shell commands when they load.
import { RULES } from "./rules.ts";
import type { Finding, Severity, SourceFile } from "./types.ts";

type ConfigFinding = Omit<Finding, "file" | "scope" | "url" | "excerpt"> & { excerpt?: string };

/** Parses JSON with comments and trailing commas (VS Code style). Returns undefined if it is not JSON. */
export function parseJsonc(text: string): unknown {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      out += ch;
      if (ch === "\\") out += text[++i] ?? "";
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const comment = text.slice(i, end === -1 ? text.length : end + 2);
      out += comment.replace(/[^\n]/g, " ");
      i = end === -1 ? text.length : end + 1;
    } else out += ch;
  }
  try {
    return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
  } catch {
    return undefined;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 1-based line of the first occurrence of `needle` (or of any of several), else 1. */
function lineOf(text: string, ...needles: string[]): number {
  for (const needle of needles) {
    if (!needle) continue;
    const at = text.indexOf(needle);
    if (at !== -1) return text.slice(0, at).split("\n").length;
  }
  return 1;
}

function short(s: string, max = 160): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const DOWNLOAD_RULES = new Set(["pipe-to-shell", "npx-yes", "run-latest"]);
const DOWNLOAD_PATTERNS = RULES.filter((r) => DOWNLOAD_RULES.has(r.id)).flatMap((r) => r.patterns.map((p) => new RegExp(p.source, p.flags.replace("g", ""))));

/** True when a command line fetches code from the network and runs it. */
export function downloadsAndRuns(command: string): boolean {
  return DOWNLOAD_PATTERNS.some((re) => re.test(command));
}

function commandLine(server: Record<string, unknown>): string {
  const args = Array.isArray(server.args) ? server.args.map(String) : [];
  return [String(server.command ?? ""), ...args].join(" ").trim();
}

const SHELL_TOOL = /^(?:Bash|PowerShell|Shell|terminal|run_in_terminal)$/i;

function permissionSeverity(entry: string): Severity | null {
  const m = /^(\w+)(?:\((.*)\))?$/.exec(entry.trim());
  if (!m) return null;
  const [, tool, spec] = m;
  const unrestricted = spec === undefined || /^\s*\*?\s*$/.test(spec) || spec.trim() === ":*";
  if (tool === "*" || (SHELL_TOOL.test(tool!) && unrestricted)) return "high";
  // "Bash(curl:*)" or "Bash(node *)": any download or any script, not one named command.
  if (SHELL_TOOL.test(tool!) && /^\s*(?:curl|wget|sh|bash|zsh|python[0-9.]*|node|npx|pnpx|bunx|uvx|deno|eval|iex|pwsh|powershell)(?::\*|\s+\*|\*)\s*$/.test(spec!)) {
    return "high";
  }
  if (/^WebFetch$/i.test(tool!) && unrestricted) return "medium";
  return null;
}

const RISKY_ENV =
  /^(?:ANTHROPIC_BASE_URL|ANTHROPIC_API_URL|ANTHROPIC_BEDROCK_BASE_URL|ANTHROPIC_VERTEX_BASE_URL|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_API_KEY|OPENAI_BASE_URL|OPENAI_API_BASE|OPENAI_API_KEY|HTTPS?_PROXY|ALL_PROXY|NODE_OPTIONS|NODE_TLS_REJECT_UNAUTHORIZED|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|REQUESTS_CA_BUNDLE|OTEL_EXPORTER_OTLP_\w*ENDPOINT|OTEL_EXPORTER_OTLP_HEADERS|CLAUDE_CODE_USE_BEDROCK|CLAUDE_CODE_USE_VERTEX)$/i;

function claudeSettings(file: SourceFile, data: Record<string, unknown>): ConfigFinding[] {
  const out: ConfigFinding[] = [];
  const text = file.text;
  if (/settings\.local\.json$/i.test(file.path)) {
    out.push({
      rule: "config-permissions",
      category: "agent-config",
      severity: "low",
      title: "Committed personal Claude Code settings (settings.local.json)",
      line: 1,
    });
  }

  if (isRecord(data.hooks)) {
    for (const [event, groups] of Object.entries(data.hooks)) {
      if (!Array.isArray(groups)) continue;
      for (const group of groups) {
        if (!isRecord(group) || !Array.isArray(group.hooks)) continue;
        for (const hook of group.hooks) {
          if (!isRecord(hook)) continue;
          const what =
            hook.type === "http"
              ? `POST to ${String(hook.url ?? "")}`
              : typeof hook.command === "string"
                ? [hook.command, ...(Array.isArray(hook.args) ? hook.args.map(String) : [])].join(" ")
                : String(hook.prompt ?? hook.type ?? "");
          out.push({
            rule: "config-hooks",
            category: "agent-config",
            severity: downloadsAndRuns(what) ? "high" : "medium",
            title: `Claude Code ${event} hook runs when you work in this repo`,
            detail: short(`${typeof group.matcher === "string" && group.matcher ? `[${group.matcher}] ` : ""}${what}`),
            line: lineOf(text, typeof hook.command === "string" ? JSON.stringify(hook.command).slice(1, -1) : "", String(hook.url ?? ""), `"${event}"`),
          });
        }
      }
    }
  }

  const perms = isRecord(data.permissions) ? data.permissions : {};
  for (const entry of Array.isArray(perms.allow) ? perms.allow : []) {
    if (typeof entry !== "string") continue;
    const sev = permissionSeverity(entry);
    if (!sev) continue;
    out.push({
      rule: "config-permissions",
      category: "agent-config",
      severity: sev,
      title: "Repository settings pre-approve tool calls without a prompt",
      detail: `permissions.allow: ${entry}`,
      line: lineOf(text, JSON.stringify(entry)),
    });
  }
  if (perms.defaultMode === "bypassPermissions" || perms.defaultMode === "dontAsk" || perms.defaultMode === "auto") {
    out.push({
      rule: "config-permissions",
      category: "agent-config",
      severity: "high",
      title: "Repository settings turn off permission prompts",
      detail: `permissions.defaultMode: ${String(perms.defaultMode)}`,
      line: lineOf(text, '"defaultMode"'),
    });
  }
  if (Array.isArray(perms.additionalDirectories) && perms.additionalDirectories.length) {
    out.push({
      rule: "config-permissions",
      category: "agent-config",
      severity: "low",
      title: "Repository settings give the agent access to directories outside the repo",
      detail: `permissions.additionalDirectories: ${perms.additionalDirectories.map(String).join(", ")}`,
      line: lineOf(text, '"additionalDirectories"'),
    });
  }

  if (data.enableAllProjectMcpServers === true) {
    out.push({
      rule: "config-mcp",
      category: "agent-config",
      severity: "high",
      title: "Repository settings start every MCP server in .mcp.json without asking",
      detail: "enableAllProjectMcpServers: true",
      line: lineOf(text, '"enableAllProjectMcpServers"'),
    });
  }
  if (Array.isArray(data.enabledMcpjsonServers) && data.enabledMcpjsonServers.length) {
    out.push({
      rule: "config-mcp",
      category: "agent-config",
      severity: "medium",
      title: "Repository settings pre-approve MCP servers",
      detail: `enabledMcpjsonServers: ${data.enabledMcpjsonServers.map(String).join(", ")}`,
      line: lineOf(text, '"enabledMcpjsonServers"'),
    });
  }

  if (isRecord(data.env)) {
    for (const [key, value] of Object.entries(data.env)) {
      if (!RISKY_ENV.test(key)) continue;
      out.push({
        rule: "config-env",
        category: "agent-config",
        severity: "high",
        title: "Repository settings change where agent traffic goes or how TLS is checked",
        detail: `env.${key}: ${short(String(value), 80)}`,
        line: lineOf(text, `"${key}"`),
      });
    }
  }

  const helpers: Array<[string, unknown]> = [
    ["apiKeyHelper", data.apiKeyHelper],
    ["awsAuthRefresh", data.awsAuthRefresh],
    ["awsCredentialExport", data.awsCredentialExport],
    ["otelHeadersHelper", data.otelHeadersHelper],
    ["statusLine", isRecord(data.statusLine) ? data.statusLine.command : undefined],
  ];
  for (const [key, value] of helpers) {
    if (typeof value !== "string" || !value.trim()) continue;
    out.push({
      rule: "config-command",
      category: "agent-config",
      severity: key === "statusLine" ? "medium" : "high",
      title: `Repository settings run a ${key} command`,
      detail: short(value),
      line: lineOf(text, `"${key}"`),
    });
  }

  const plugins = isRecord(data.enabledPlugins) ? Object.keys(data.enabledPlugins) : [];
  const markets = isRecord(data.extraKnownMarketplaces) ? Object.keys(data.extraKnownMarketplaces) : [];
  if (plugins.length || markets.length) {
    out.push({
      rule: "config-plugins",
      category: "agent-config",
      severity: "medium",
      title: "Repository settings enable plugins or add plugin marketplaces",
      detail: short([...plugins.map((p) => `plugin ${p}`), ...markets.map((m) => `marketplace ${m}`)].join(", ")),
      line: lineOf(text, '"enabledPlugins"', '"extraKnownMarketplaces"'),
    });
  }
  return out;
}

function mcpServers(file: SourceFile, data: Record<string, unknown>): ConfigFinding[] {
  const out: ConfigFinding[] = [];
  const servers = isRecord(data.mcpServers) ? data.mcpServers : isRecord(data.servers) ? data.servers : null;
  if (!servers) return out;
  for (const [name, server] of Object.entries(servers)) {
    if (!isRecord(server)) continue;
    const local = typeof server.command === "string";
    const command = local ? commandLine(server) : "";
    const downloads = local && downloadsAndRuns(command);
    out.push({
      rule: "config-mcp",
      category: "agent-config",
      severity: downloads ? "high" : local ? "medium" : "low",
      title: downloads
        ? `Defines MCP server "${name}", which downloads a package and runs it`
        : local
          ? `Defines MCP server "${name}", a local program the agent can start`
          : `Defines remote MCP server "${name}"`,
      detail: short(local ? command : String(server.url ?? server.serverUrl ?? "")),
      line: lineOf(file.text, `"${name}"`),
    });
  }
  return out;
}

function vscodeSettings(file: SourceFile, data: Record<string, unknown>): ConfigFinding[] {
  const out: ConfigFinding[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (!/autoApprove|autoapprove/i.test(key)) continue;
    const on = value === true || (isRecord(value) && Object.values(value).some((v) => v === true)) || (Array.isArray(value) && value.length > 0);
    if (!on) continue;
    out.push({
      rule: "config-permissions",
      category: "agent-config",
      severity: "high",
      title: "Editor settings auto-approve agent tool calls",
      detail: short(`${key}: ${JSON.stringify(value)}`),
      line: lineOf(file.text, `"${key}"`),
    });
  }
  if (isRecord(data.mcp)) out.push(...mcpServers(file, data.mcp));
  return out;
}

const SKILL_PATH = /(^|\/)(?:SKILL\.md|\.claude\/(?:commands|agents|skills)\/.+\.md|\.cursor\/commands\/.+\.md|\.github\/prompts\/.+\.md|commands\/[^/]+\.md)$/i;

function frontmatter(text: string): { body: string; lines: number } | null {
  const m = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(text);
  return m ? { body: m[1]!, lines: m[0].split("\n").length - 1 } : null;
}

function skillChecks(file: SourceFile): ConfigFinding[] {
  const out: ConfigFinding[] = [];
  const text = file.text.replace(/\r\n?/g, "\n");
  const fm = frontmatter(text);
  if (fm) {
    const tools = /^allowed-tools:\s*(.*(?:\n[ \t]+-.*)*)/m.exec(fm.body);
    if (tools) {
      const entries = tools[1]!.split(/[\n,]|\s(?=[A-Z]\w*(?:\(|\s|$))/).map((s) => s.replace(/^\s*-\s*/, "").replace(/["']/g, "").trim()).filter(Boolean);
      const risky = entries.find((e) => permissionSeverity(e) === "high");
      if (risky) {
        out.push({
          rule: "skill-allowed-tools",
          category: "agent-config",
          severity: "medium",
          title: "Skill or command pre-approves shell commands without a prompt",
          detail: `allowed-tools: ${risky}`,
          line: lineOf(text, "allowed-tools"),
        });
      }
    }
    if (/^hooks:/m.test(fm.body)) {
      out.push({
        rule: "config-hooks",
        category: "agent-config",
        severity: "medium",
        title: "Skill or agent registers hooks that run commands",
        line: lineOf(text, "hooks:"),
      });
    }
  }
  // `!`command`` and ```! blocks run before the skill text reaches the model.
  const lines = text.split("\n");
  let fenceBang = false;
  lines.forEach((line, i) => {
    if (/^\s*```!/.test(line)) {
      fenceBang = true;
      return;
    }
    if (fenceBang) {
      if (/^\s*```/.test(line)) fenceBang = false;
      else if (line.trim()) {
        out.push({
          rule: "skill-shell-injection",
          category: "agent-config",
          severity: "medium",
          title: "Skill or command runs a shell command as soon as it loads",
          detail: short(line),
          line: i + 1,
        });
      }
      return;
    }
    for (const m of line.matchAll(/(?:^|[^\w`])!`([^`\n]+)`/g)) {
      out.push({
        rule: "skill-shell-injection",
        category: "agent-config",
        severity: "medium",
        title: "Skill or command runs a shell command as soon as it loads",
        detail: short(m[1]!),
        line: i + 1,
      });
    }
  });
  return out;
}

export function configFindings(file: SourceFile): ConfigFinding[] {
  const path = file.path.toLowerCase();
  if (SKILL_PATH.test(file.path)) return skillChecks(file);
  if (!/\.jsonc?$/.test(path)) return [];
  const data = parseJsonc(file.text);
  if (!isRecord(data)) return [];
  if (/(^|\/)\.claude\/settings(\.local)?\.json$/.test(path)) return claudeSettings(file, data);
  if (/(^|\/)\.vscode\/settings\.json$/.test(path)) return vscodeSettings(file, data);
  if (/(^|\/)(?:\.mcp\.json|mcp\.json|mcp_settings\.json|settings\.json)$/.test(path)) return mcpServers(file, data);
  return [];
}
