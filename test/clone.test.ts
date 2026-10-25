import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { cloneTargets, humanishName, splitCommands } from "../src/clone.ts";

const cwd = resolve("/work");

describe("clone targets", () => {
  it("splits command lines", () => {
    assert.deepEqual(splitCommands(`cd "my dir" && git clone 'a b' x; echo done | cat`), [
      ["cd", "my dir"],
      ["git", "clone", "a b", "x"],
      ["echo", "done"],
      ["cat"],
    ]);
  });

  it("names the directory like git does", () => {
    assert.equal(humanishName("https://github.com/o/repo.git"), "repo");
    assert.equal(humanishName("git@github.com:o/repo.git"), "repo");
    assert.equal(humanishName("o/repo"), "repo");
    assert.equal(humanishName("/srv/repo/.git"), "repo");
  });

  it("finds git clone and gh repo clone targets", () => {
    assert.deepEqual(cloneTargets("git clone https://github.com/o/r.git", cwd), [join(cwd, "r")]);
    assert.deepEqual(cloneTargets("git clone --depth 1 -b main https://github.com/o/r.git dest", cwd), [join(cwd, "dest")]);
    assert.deepEqual(cloneTargets("git clone --depth=1 --filter=blob:none git@github.com:o/r.git", cwd), [join(cwd, "r")]);
    assert.deepEqual(cloneTargets("git -C /tmp clone https://github.com/o/r", cwd), [resolve("/tmp", "r")]);
    assert.deepEqual(cloneTargets("cd clones && gh repo clone o/r -- --depth 1", cwd), [join(cwd, "clones", "r")]);
    assert.deepEqual(cloneTargets("gh repo clone o/r there", cwd), [join(cwd, "there")]);
    assert.deepEqual(cloneTargets("GIT_TERMINAL_PROMPT=0 git clone https://x/o/r.git", cwd), [join(cwd, "r")]);
  });

  it("expands environment variables it knows and skips ones it does not", () => {
    assert.deepEqual(cloneTargets("git clone https://x/o/r.git $WL/r", cwd, { WL: resolve("/wl") }), [resolve("/wl", "r")]);
    assert.deepEqual(cloneTargets("git clone https://x/o/r.git $NOPE/r", cwd, {}), []);
  });

  it("ignores other commands", () => {
    assert.deepEqual(cloneTargets("git status && echo git clone", cwd), []);
    assert.deepEqual(cloneTargets("npm test", cwd), []);
  });
});
