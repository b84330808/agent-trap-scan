export { scanFile, scanFiles, summarize, type ScanOptions } from "./scan.ts";
export { scanGitHub, scanLocal, scanTarget, scanText, type TargetOptions } from "./report.ts";
export { formatContext, formatJson, formatText } from "./format.ts";
export { handleHook, type HookInput, type HookOutput } from "./hook.ts";
export { classifyPath } from "./surface.ts";
export { parseGitHubTarget } from "./sources/github.ts";
export { BUILTIN_RULES, RULES, type Rule } from "./rules.ts";
export type { Category, FileKind, Finding, ScanReport, Scope, Severity, SourceFile } from "./types.ts";
export { VERSION } from "./version.ts";
