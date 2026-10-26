// Finds where a shell command line clones repositories to (git clone, gh repo clone).
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

export type Shell = "bash" | "powershell";

/**
 * Splits a command line into simple commands and their words. Good enough for clone lines, not a shell.
 * In bash a backslash escapes the next character (inside double quotes only $ ` " \ and newline);
 * in PowerShell the escape is a backtick and a backslash is an ordinary character (C:\work\repo).
 */
export function splitCommands(line: string, shell: Shell = "bash"): string[][] {
  const escape = shell === "powershell" ? "`" : "\\";
  const commands: string[][] = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  let quote: '"' | "'" | null = null;
  const endWord = () => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length) commands.push(words);
    words = [];
  };
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === escape && quote === '"' && i + 1 < line.length && (shell === "powershell" || '$`"\\\n'.includes(line[i + 1]!))) word += line[++i];
      else word += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      inWord = true;
    } else if (ch === escape && i + 1 < line.length && line[i + 1] !== "\n") {
      word += line[++i];
      inWord = true;
    } else if (ch === "&" || ch === "|" || ch === ";" || ch === "\n" || ch === "(" || ch === ")") {
      endCommand();
    } else if (/\s/.test(ch)) {
      endWord();
    } else {
      word += ch;
      inWord = true;
    }
  }
  endCommand();
  return commands;
}

const GIT_CLONE_VALUE_FLAGS = new Set([
  "-b",
  "--branch",
  "-o",
  "--origin",
  "-u",
  "--upload-pack",
  "--reference",
  "--reference-if-able",
  "--separate-git-dir",
  "--depth",
  "--shallow-since",
  "--shallow-exclude",
  "-c",
  "--config",
  "--filter",
  "-j",
  "--jobs",
  "--template",
  "--server-option",
  "--bundle-uri",
  "--revision",
  "--ref-format",
]);

const GIT_GLOBAL_VALUE_FLAGS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"]);

/** Directory git picks when none is given: `https://x/y/repo.git` -> `repo`. */
export function humanishName(repo: string): string {
  let s = repo.replace(/[/\\]+$/, "").replace(/\/\.git$/, "").replace(/\.git$/, "").replace(/\.bundle$/, "");
  s = s.split(/[/\\:]/).pop() ?? s;
  return s;
}

function expand(word: string, env: NodeJS.ProcessEnv): string | null {
  let s = word;
  if (s === "~" || s.startsWith("~/")) s = homedir() + s.slice(1);
  let missing = false;
  s = s.replace(/\$\{(\w+)\}|\$(\w+)/g, (_, a: string | undefined, b: string | undefined) => {
    const v = env[(a ?? b)!];
    if (v === undefined) missing = true;
    return v ?? "";
  });
  if (missing) return null;
  // Git Bash on Windows writes C:\x as /c/x.
  if (process.platform === "win32") s = s.replace(/^\/([a-zA-Z])(?=\/|$)/, "$1:");
  return s;
}

function at(cwd: string, dir: string): string {
  return isAbsolute(dir) ? resolve(dir) : resolve(cwd, dir);
}

/** Absolute paths a command line clones into, resolved against `cwd` (and any `cd` before the clone). */
export function cloneTargets(line: string, cwd: string, env: NodeJS.ProcessEnv = process.env, shell: Shell = "bash"): string[] {
  const targets: string[] = [];
  let here = cwd;
  for (const words of splitCommands(line, shell)) {
    let w = words;
    while (w.length && /^\w+=/.test(w[0]!)) w = w.slice(1);
    const cmd = w[0]?.replace(/\.exe$/i, "");
    if (!cmd) continue;

    if ((cmd === "cd" || cmd === "Set-Location" || cmd === "pushd") && w[1]) {
      const dir = expand(w[1] === "-Path" ? (w[2] ?? "") : w[1], env);
      if (dir) here = at(here, dir);
      continue;
    }

    if (cmd === "git") {
      let i = 1;
      let gitCwd = here;
      while (i < w.length && w[i]!.startsWith("-")) {
        const flag = w[i]!;
        if (flag === "-C" && w[i + 1]) {
          const dir = expand(w[i + 1]!, env);
          if (dir) gitCwd = at(gitCwd, dir);
        }
        i += GIT_GLOBAL_VALUE_FLAGS.has(flag) && !flag.includes("=") ? 2 : 1;
      }
      if (w[i] !== "clone") continue;
      const positional: string[] = [];
      let onlyPositional = false;
      for (let j = i + 1; j < w.length; j++) {
        const word = w[j]!;
        if (!onlyPositional && word === "--") onlyPositional = true;
        else if (!onlyPositional && word.startsWith("-")) {
          if (GIT_CLONE_VALUE_FLAGS.has(word)) j++;
        } else positional.push(word);
      }
      if (!positional[0]) continue;
      const dir = expand(positional[1] ?? humanishName(positional[0]), env);
      if (dir) targets.push(at(gitCwd, dir));
      continue;
    }

    if (cmd === "gh" && w[1] === "repo" && w[2] === "clone") {
      const positional: string[] = [];
      for (let j = 3; j < w.length; j++) {
        const word = w[j]!;
        if (word === "--") break;
        if (word.startsWith("-")) {
          if (word === "-u" || word === "--upstream-remote-name") j++;
          continue;
        }
        positional.push(word);
      }
      if (!positional[0]) continue;
      const dir = expand(positional[1] ?? humanishName(positional[0]), env);
      if (dir) targets.push(at(here, dir));
    }
  }
  return [...new Set(targets)];
}
