import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { OVERLAP_MS, writeDeltaState, writeStamp } from "../collector/delta.mjs";

const COLLECT = new URL("../collector/collect.mjs", import.meta.url).pathname;
const run = (args, cwd) => spawnSync(process.execPath, [COLLECT, ...args], { cwd, encoding: "utf8", timeout: 60_000 });

function setup() {
  const base = mkdtempSync(join(tmpdir(), "c642-prep-"));
  const state = join(base, "state"), dir = join(state, "Board01");
  mkdirSync(dir, { recursive: true });
  const cfg = join(base, "board.config.json");
  writeFileSync(cfg, JSON.stringify({ owner: "Sam", artifactUrl: ["https:", "", "claude.ai", "artifact", "Board01"].join("/"), gate: { stateDir: state }, collector: { repoPath: "/nowhere", outDir: join(base, "out") } }));
  return { base, dir, cfg, done: () => rmSync(base, { recursive: true, force: true }) };
}

test("--prepare with no mirror asks for the whole board; with a merged mirror it asks for the delta since the last merged run, field by field", () => {
  const s = setup();
  try {
    const first = run(["--config", s.cfg, "--prepare"], s.dir);
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /^Export the board into: your scratchpad folder \+ \/flight-board-export\nMode: full\.\nSteps since: \d+\n$/);
    assert.equal(JSON.parse(readFileSync(join(s.dir, "export-since.json"), "utf8")).mode, "full");
    // A mirror made by the last full read, a run merged a half hour ago: a delta.
    mkdirSync(join(s.dir, "mirror", "initiatives"), { recursive: true });
    const ran = Date.now() - 30 * 60e3;
    writeDeltaState(s.dir, { at: ran, fullAt: Date.now() - 2 * 3600e3, lastPrepare: ran });
    writeStamp(join(s.dir, "mirror"), ran, ran);
    const next = run(["--config", s.cfg, "--prepare"], s.dir);
    assert.equal(next.status, 0, next.stderr);
    const lines = next.stdout.trim().split("\n");
    assert.equal(lines[0], "Export the board into: your scratchpad folder + /flight-board-export");
    assert.equal(lines[1], `Mode: delta, since ${ran - OVERLAP_MS}.`);
    assert.deepEqual(lines.slice(2).map((l) => l.replace(/\d+\]\]$/, "N]]")), [
      'Query steps: where [["at", ">=", N]]', 'Query messages: where [["at", ">=", N]]', 'Query ctx: where [["at", ">=", N]]',
      'Query initiatives: where [["updatedAt", ">=", N]]', 'Query waiting: where [["updatedAt", ">=", N]]', 'Query ideas: where [["updatedAt", ">=", N]]',
      'Query threads: where [["updatedAt", ">=", N]]', 'Query plan: where [["updatedAt", ">=", N]]',
    ]);
    assert.ok(!next.stdout.includes("Steps since"), "a delta carries its own times");
    assert.equal(JSON.parse(readFileSync(join(s.dir, "export-since.json"), "utf8")).mode, "delta");
    assert.ok(!next.stdout.includes("Read memory"), "no memory reads: the probe reads every role's context");
  } finally { s.done(); }
});

test("collect.mjs without --from-mirror refuses to take a delta or a nightly read as the whole board; the mirror is left as it was", () => {
  const s = setup();
  try {
    mkdirSync(join(s.dir, "mirror", "initiatives"), { recursive: true });
    writeFileSync(join(s.dir, "mirror", "initiatives", "keep.json"), "{}");
    writeFileSync(join(s.dir, "export-since.json"), JSON.stringify({ at: Date.now(), refs: {}, mode: "delta" }));
    const out = run(["--config", s.cfg, "--no-fetch"], s.dir);
    assert.equal(out.status, 1);
    assert.match(out.stderr, /this run exported a delta or a nightly read: the probe merges it/);
    assert.ok(existsSync(join(s.dir, "mirror", "initiatives", "keep.json")));
  } finally { s.done(); }
});

test("--probe-step --merge-only with nothing to merge prints nothing and writes nothing; with no mirror yet --from-mirror stops with the usual message", () => {
  const s = setup();
  try {
    const quiet = run(["--config", s.cfg, "--probe-step", "--merge-only", "--no-fetch"], s.dir);
    assert.equal(quiet.status, 0, quiet.stderr);
    assert.equal(quiet.stdout, "");
    assert.equal(existsSync(join(s.dir, "collector-lines.json")), false);
    const none = run(["--config", s.cfg, "--from-mirror", "--no-fetch"], s.dir);
    assert.equal(none.status, 1);
    assert.match(none.stderr, /no mirror at .*mirror: export the board first/);
  } finally { s.done(); }
});
