import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { scanFile } from "../src/scan.ts";
import { REAL_CASES } from "./fixtures/real-world.ts";

describe("text seen in real repositories", () => {
  for (const c of REAL_CASES) {
    it(c.name, () => {
      const findings = scanFile({ path: c.path, text: c.text, kind: c.kind });
      const got = findings.map((f) => `${f.rule}:${f.severity}`);
      for (const e of c.expect) {
        const hit = findings.find((f) => f.rule === e.rule && (!e.severity || f.severity === e.severity));
        assert.ok(hit, `expected ${e.rule}${e.severity ? `:${e.severity}` : ""} in ${JSON.stringify(got)} (${c.source})`);
      }
      for (const rule of c.absent ?? []) assert.ok(!findings.some((f) => f.rule === rule), `${rule} should not fire: ${JSON.stringify(got)}`);
      if (c.onlyInfo) assert.deepEqual(findings.filter((f) => f.severity !== "info").map((f) => f.rule), [], `only policy findings expected (${c.source})`);
    });
  }

  it("every case links to a pinned commit", () => {
    for (const c of REAL_CASES) assert.match(c.source, /^https:\/\/github\.com\/[^/]+\/[^/]+\/blob\/[0-9a-f]{40}\/.+#L\d+/, c.name);
  });
});
