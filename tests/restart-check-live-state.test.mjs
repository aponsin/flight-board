// #C861 Checker 2: restart-check.mjs (what every pack's restart step runs) reads the live state through scripts/live-state.mjs: with the store collector's folder
// beside the dead old one, it reads the store's. Run through the command line on a temp home, with a ps that lists nothing, so only the state decides.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const ID = "abc123";
const quietPs = () => { const d = mkdtempSync(join(tmpdir(), "rc-ps-")); writeFileSync(join(d, "ps"), "#!/bin/sh\nexit 0\n"); chmodSync(join(d, "ps"), 0o755); return `${d}:${process.env.PATH}`; };
const shipping = (at) => ({ board: { at }, agents: { Release: { state: "working", card: "c1", since: at - 60e3 } }, cards: { c1: { phase: "ship", num: 77 } } });
const quiet = (at) => ({ board: { at }, agents: { Release: { state: "idle" } }, cards: {} });
function setup(raw) {
  const home = mkdtempSync(join(tmpdir(), "rc-home-")), conf = join(home, "c.json"), base = join(home, ".flight-board");
  writeFileSync(conf, JSON.stringify({ artifactUrl: `https://claude.ai/artifact/${ID}`, ...raw }));
  const put = (dir, state) => { mkdirSync(join(dir, ID), { recursive: true }); writeFileSync(join(dir, ID, "state.json"), JSON.stringify(state)); };
  const run = () => spawnSync(process.execPath, [new URL("../scripts/restart-check.mjs", import.meta.url).pathname, "--config", conf], { encoding: "utf8", env: { ...process.env, HOME: home, PATH: quietPs() } });
  return { base, put, run, home };
}

test("with the store's folder beside the dead old one and no gate.stateDir set, the store's state decides: Release working on a ship card holds the restart", () => {
  const { base, put, run } = setup({});
  put(base, quiet(Date.now()));                       // the old collector's file: fresh-looking and quiet
  put(join(base, `${ID}-store`), shipping(Date.now())); // the store's file: Release is on a ship card
  const r = run();
  assert.equal(r.status, 3);
  assert.match(r.stdout, /^wait: Release is working on #C77/);
});

test("a gate.stateDir the config sets wins over the store's folder", () => {
  const { base, put, run, home } = setup({ gate: { stateDir: "~/.fb-own" } });
  put(join(home, ".fb-own"), quiet(Date.now()));
  put(base, shipping(Date.now()));
  put(join(base, `${ID}-store`), shipping(Date.now()));
  const r = run();
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^ok: no ship running/);
});

test("no store folder: the old path is read, as before", () => {
  const { base, put, run } = setup({});
  put(base, shipping(Date.now()));
  assert.equal(run().status, 3);
});

test("the command line reads the state through the shared helper, not its own copy of the path", () => {
  const src = readFileSync(new URL("../scripts/restart-check.mjs", import.meta.url), "utf8");
  const code = src.split("\n").filter((l) => !l.trimStart().startsWith("//")).join("\n");
  assert.match(code, /liveStateFile\(config, raw\)/);
  assert.doesNotMatch(code, /join\(home\(config\.gate\.stateDir\), boardId\(config\), "state\.json"\)/);
});
