import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { OVERLAP_MS, writeDeltaState, writeStamp } from "../collector/delta.mjs";

const COLLECT = new URL("../collector/collect.mjs", import.meta.url).pathname;
const run = (args, cwd) => spawnSync(process.execPath, [COLLECT, ...args], { cwd, encoding: "utf8", timeout: 60_000 });

function setup(gate = {}) {
  const base = mkdtempSync(join(tmpdir(), "c642-prep-"));
  const state = join(base, "state"), dir = join(state, "Board01");
  mkdirSync(dir, { recursive: true });
  const cfg = join(base, "board.config.json");
  writeFileSync(cfg, JSON.stringify({ owner: "Sam", artifactUrl: ["https:", "", "claude.ai", "artifact", "Board01"].join("/"), gate: { stateDir: state, ...gate }, collector: { repoPath: "/nowhere", outDir: join(base, "out") } }));
  return { base, dir, cfg, done: () => rmSync(base, { recursive: true, force: true }) };
}

const W = (field, n = "N") => `[{"field": "${field}", "op": ">=", "value": ${n}}]`;
const mark = (dir) => JSON.parse(readFileSync(join(dir, "export-since.json"), "utf8"));

test("--prepare with no mirror starts a sweep (first page, no delta); with a merged mirror it asks for the delta since the last merged run, field by field", () => {
  const s = setup({ requireUpdatedAt: true });
  try {
    const first = run(["--config", s.cfg, "--prepare"], s.dir);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(first.stdout, "Export the board into: your scratchpad folder + /flight-board-export\nMode: sweep, no delta.\nSweep initiatives: limit 150, cursor none\n");
    const m1 = mark(s.dir);
    assert.equal(m1.mode, "sweep");
    assert.deepEqual(m1.sweep, { startedAt: m1.at, fresh: true, stage: 0, collection: "initiatives", limit: 150, cursor: null });
    // A mirror made by the last sweep, a run merged a half hour ago: a delta.
    mkdirSync(join(s.dir, "mirror", "initiatives"), { recursive: true });
    const ran = Date.now() - 30 * 60e3;
    writeDeltaState(s.dir, { at: ran, fullAt: Date.now() - 2 * 3600e3, lastPrepare: ran, sweep: null });
    writeStamp(join(s.dir, "mirror"), ran, ran);
    const next = run(["--config", s.cfg, "--prepare"], s.dir);
    assert.equal(next.status, 0, next.stderr);
    const lines = next.stdout.trim().split("\n");
    assert.equal(lines[0], "Export the board into: your scratchpad folder + /flight-board-export");
    assert.equal(lines[1], `Mode: delta, since ${ran - OVERLAP_MS}.`);
    assert.deepEqual(lines.slice(2).map((l) => l.replace(/\d+\}\]$/, "N}]")), [
      `Query steps: where ${W("at")}`, `Query messages: where ${W("at")}`, `Query ctx: where ${W("at")}`,
      `Query initiatives: where ${W("updatedAt")}`, `Query waiting: where ${W("updatedAt")}`, `Query ideas: where ${W("updatedAt")}`,
      `Query threads: where ${W("updatedAt")}`, `Query plan: where ${W("updatedAt")}`,
    ]);
    assert.ok(!next.stdout.includes("Sweep"), "no sweep going, none due");
    assert.equal(mark(s.dir).mode, "delta");
    assert.equal(mark(s.dir).sweep, null);
    assert.deepEqual(mark(s.dir).queries.map((q) => [q.collection, q.field, q.since]), ["steps", "messages", "ctx", "initiatives", "waiting", "ideas", "threads", "plan"].map((c) => [c, ["steps", "messages", "ctx"].includes(c) ? "at" : "updatedAt", ran - OVERLAP_MS]), "the mark carries the queries, so the probe knows which recorded calls the plan asked for");
    assert.ok(!next.stdout.includes("Read memory"), "no memory reads: the probe reads every role's context");
  } finally { s.done(); }
});

test("--prepare names the going sweep's next page, the cursor and all, in the mark and on the line; the steps page reads by at", () => {
  const s = setup({ requireUpdatedAt: true });
  try {
    mkdirSync(join(s.dir, "mirror", "initiatives"), { recursive: true });
    const ran = Date.now() - 30 * 60e3;
    writeDeltaState(s.dir, { at: ran, fullAt: Date.now() - 2 * 3600e3, lastPrepare: ran, sweep: { startedAt: ran - 600e3, stage: 3, cursor: "cur_9=", runs: 0 } });
    writeStamp(join(s.dir, "mirror"), ran, ran);
    const out = run(["--config", s.cfg, "--prepare"], s.dir);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /^Sweep messages: limit 300, cursor cur_9=$/m);
    assert.deepEqual(mark(s.dir).sweep, { startedAt: ran - 600e3, fresh: false, stage: 3, collection: "messages", limit: 300, cursor: "cur_9=" });
    writeDeltaState(s.dir, { at: ran, fullAt: Date.now() - 2 * 3600e3, lastPrepare: ran, sweep: { startedAt: ran - 600e3, stage: 7, cursor: null, runs: 0 } });
    const steps = run(["--config", s.cfg, "--prepare"], s.dir);
    assert.match(steps.stdout, new RegExp(`^Sweep steps: limit 300, cursor none, where ${W("at", "\\d+").replace(/[[\]]/g, "\\$&")}$`, "m"));
  } finally { s.done(); }
});

test("--prepare plans nothing whenever gate.requireUpdatedAt is not true, mirror or not (the pack order is enforced in code)", () => {
  for (const gate of [{}, { requireUpdatedAt: false }]) {
    const s = setup(gate);
    try {
      mkdirSync(join(s.dir, "mirror", "initiatives"), { recursive: true });
      const ran = Date.now() - 30 * 60e3;
      writeDeltaState(s.dir, { at: ran, fullAt: Date.now() - 2 * 3600e3, lastPrepare: ran, sweep: null });
      writeStamp(join(s.dir, "mirror"), ran, ran);
      const out = run(["--config", s.cfg, "--prepare"], s.dir);
      assert.equal(out.status, 0, out.stderr);
      assert.equal(out.stdout, "Export the board into: your scratchpad folder + /flight-board-export\nMode: off.\n");
      assert.equal(mark(s.dir).mode, "off");
      assert.equal(mark(s.dir).sweep, null);
    } finally { s.done(); }
  }
});

test("collect.mjs without --from-mirror refuses to take a delta or a nightly read as the whole board; the mirror is left as it was", () => {
  const s = setup();
  try {
    mkdirSync(join(s.dir, "mirror", "initiatives"), { recursive: true });
    writeFileSync(join(s.dir, "mirror", "initiatives", "keep.json"), "{}");
    writeFileSync(join(s.dir, "export-since.json"), JSON.stringify({ at: Date.now(), refs: {}, mode: "delta" }));
    const out = run(["--config", s.cfg, "--no-fetch"], s.dir);
    assert.equal(out.status, 1);
    assert.match(out.stderr, /this run exported a delta or a sweep page: the probe merges it/);
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
