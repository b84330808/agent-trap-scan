// Runs git and gh by absolute path. On Windows a bare program name is also looked up in the current
// directory, so `git` inside a hostile checkout could be the checkout's own git.exe.
import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const found = new Map<string, string | null>();

/** Absolute path of a program on PATH, skipping relative PATH entries; null when there is none. */
export function findExecutable(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const key = `${name}\0${env.PATH ?? env.Path ?? ""}`;
  if (found.has(key)) return found.get(key)!;
  const dirs = (env.PATH ?? env.Path ?? "").split(delimiter).filter((d) => d && isAbsolute(d));
  const exts = process.platform === "win32" ? [".exe", ".com"] : [""];
  let hit: string | null = null;
  outer: for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      try {
        if (statSync(candidate).isFile()) {
          hit = candidate;
          break outer;
        }
      } catch {
        // not here
      }
    }
  }
  found.set(key, hit);
  return hit;
}

export async function runTool(name: string, args: string[], options: { timeout: number; maxBuffer?: number }): Promise<string> {
  const file = findExecutable(name);
  if (!file) throw new Error(`${name} not found on PATH`);
  const { stdout } = await execFileAsync(file, args, {
    timeout: options.timeout,
    maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
    windowsHide: true,
    // Never the scanned directory: some programs read config or plugins from their working directory.
    cwd: process.platform === "win32" ? (process.env.SystemRoot ?? undefined) : "/",
    env: { ...process.env, NoDefaultCurrentDirectoryInExePath: "1", GIT_TERMINAL_PROMPT: "0" },
  });
  return stdout;
}
