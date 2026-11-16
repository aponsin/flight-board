// #C864 step 2a: the live probe (collector/state.mjs, collector/probe-board.mjs) no longer imports the old gate (gate/gate.mjs) or the
// old exporter (collector/export.mjs); `home` lives in scripts/config.mjs and PUBLISHED_FILE in collector/state-schema.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { home } from "../scripts/config.mjs";
import { home as gateHome } from "../gate/gate.mjs";
import { PUBLISHED_FILE } from "../collector/state-schema.mjs";
import { PUBLISHED_FILE as EXPORT_PUBLISHED_FILE } from "../collector/export.mjs";

const src = (p) => readFileSync(fileURLToPath(new URL(`../${p}`, import.meta.url)), "utf8");

test("the live probe's files import neither gate/gate.mjs nor collector/export.mjs", () => {
  for (const f of ["collector/state.mjs", "collector/probe-board.mjs"]) {
    const imports = src(f).split("\n").filter((l) => /^\s*import\b|\bawait import\(/.test(l)).join("\n");
    assert.doesNotMatch(imports, /gate\/gate\.mjs|\.\/export\.mjs/, f);
  }
});

test("the probe runs no collect.mjs child: no merge step, no derive step, no collectorEntry (#C864 step 2b)", () => {
  const s = src("collector/state.mjs");
  assert.doesNotMatch(s, /collectorEntry|--probe-step|--merge-only|deriveStep|probeStep/);
  assert.doesNotMatch(src("collector/probe-evidence.mjs"), /--no-derive/);
});

test("home is one function: config.mjs's, which gate.mjs re-exports; a leading ~ only", () => {
  assert.equal(gateHome, home);
  assert.match(home("~/x"), /^\/.+\/x$/);
  assert.equal(home("/a/~/b"), "/a/~/b");
  assert.equal(home("~other/x"), "~other/x");
});

test("the two copies of PUBLISHED_FILE are the same name", () => {
  assert.equal(PUBLISHED_FILE, EXPORT_PUBLISHED_FILE);
});
