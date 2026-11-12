// #C996: which phase of the state child is slow. On 11-11 to 11-12 the evidence job's run took 77 to 90 s of a 90 s limit and the live log
// said only "state child 49691 ms, posts 15296 ms", never which part of the child. The child now ends with one "timing:" line (phase names and
// whole milliseconds, then counts) and the evidence job logs it. Nothing of a card, a session or a path may be in it.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { timingText } from "../collector/state.mjs";
import { evidenceJob, timingOf, TIMING_LINE } from "../collector/probe-evidence.mjs";

test("timingText: fixed phase words and whole numbers, nothing else", () => {
  const line = timingText(["caches=12", "repos=830", "cardStates=4100"], { fetch: 420.4, tips: 35.6 }, { cards: 61, tips: 188 });
  assert.equal(line, "timing: caches=12 repos=830 cardStates=4100 fetch=420 tips=36 cards#61 tips#188");
  assert.match(line, TIMING_LINE);
  // A name that is not a plain word is left out, a value that is not a number is 0, a negative one is 0.
  const odd = timingText(["ok=1", "../etc=2", "a b=3"], { "has space": 5, good: Number.NaN, neg: -4 }, { "card-name": 7, fine: Infinity });
  assert.equal(odd, "timing: ok=1 good=0 neg=0 fine#0");
  assert.match(odd, TIMING_LINE);
});

test("timingOf: only a line of exactly that shape is kept, the last one; a path, a name or extra words are not", () => {
  assert.equal(timingOf("state: written, 3 card(s)\ntiming: caches=1 repos=2 cards#3\n"), "timing: caches=1 repos=2 cards#3");
  assert.equal(timingOf("timing: a=1\ntiming: b=2\n"), "timing: b=2", "the last");
  for (const bad of ["timing: card=my-secret-card", "timing: path=/Users/someone/x", "timing: a=1 some words", "timing: A=1", "timing:", "timing: a=1e9", `timing: ${Array.from({ length: 41 }, (_, i) => `p${i}=1`).join(" ")}`, " not timing: a=1", `timing: a=${"9".repeat(10)}`]) {
    assert.equal(timingOf(bad), "", bad);
  }
  assert.equal(timingOf(undefined), "");
  assert.equal(timingOf(null), "");
});

const T = 1_800_000_000_000;
const STATE = JSON.stringify({ v: 1, board: { boardId: "b", at: T, cardsCheckedAt: T }, cards: {}, agents: {} });
const job = (over = {}, lines = []) => ({
  job: "evidence", base: "https://x.example", headers: {}, configPath: "/c", stateFile: "/s/state.json", build: async () => ({ stdout: "" }), ghCheck: () => true,
  read: (p) => { if (p === "/c") return JSON.stringify({ collector: { repoPath: "/r" } }); if (p === "/s/state.json") return STATE; throw new Error("none"); },
  deployRead: async () => ({ worker: "", tree: "" }), liveFetch: async () => ({ ok: false, status: 500 }),
  fetchImpl: async () => ({ ok: true, status: 200 }), log: (l) => lines.push(l), ...over,
});

test("the evidence job logs the child's timing line, from a finished run and from a failed one, and nothing else the child printed", async () => {
  const lines = [];
  await evidenceJob(job({ build: async () => ({ stdout: "state: written\ntiming: caches=1 repos=2 cards#3\nsecret words here\n" }) }, lines));
  assert.ok(lines.includes("state child timing: caches=1 repos=2 cards#3"), lines.join(" | "));
  assert.ok(!lines.some((l) => /secret words/.test(l)));
  const failed = [];
  await assert.rejects(evidenceJob(job({ build: async () => { throw Object.assign(new Error("exited 1"), { stderr: "Error: boom", stdout: "timing: failed=3 repos=2\n" }); } }, failed)), /exited 1/);
  assert.ok(failed.includes("state child timing: failed=3 repos=2"), failed.join(" | "));
  assert.ok(failed.includes("state child said: Error: boom"), "the reason is still logged");
  const quiet = [];
  await evidenceJob(job({ build: async () => ({ stdout: "timing: card=my-secret-card\n" }) }, quiet));
  assert.ok(!quiet.some((l) => /state child timing/.test(l) || /secret/.test(l)), "a line that is not of the shape is dropped");
});

test("the real state child ends with a timing line of the allowed shape, a phase for each stage, and counts", () => {
  const dir = mkdtempSync(join(tmpdir(), "fb-timing-"));
  try {
    const stateDir = join(dir, "state");
    mkdirSync(join(stateDir, "abc123", "mirror", "initiatives"), { recursive: true });
    const cfg = join(dir, "board.config.json");
    writeFileSync(cfg, JSON.stringify({ owner: "Sam", artifactUrl: ["https://claude.ai", "artifact", "abc123"].join("/"), gate: { stateDir }, roster: [] }));
    const r = spawnSync(process.execPath, [join(import.meta.dirname, "..", "collector", "state.mjs"), "--config", cfg, "--no-post", "--no-derive", "--no-fetch"], { encoding: "utf8", timeout: 60_000 });
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    const line = timingOf(r.stdout);
    assert.notEqual(line, "", r.stdout);
    for (const phase of ["caches", "repos", "merge", "cards", "sessions", "agents", "usage", "asks", "cardStates", "ship", "write", "fetch", "tips"]) assert.match(line, new RegExp(` ${phase}=\\d+`), phase);
    for (const count of ["cards", "all", "tips", "sessions", "ids", "ci", "waiting"]) assert.match(line, new RegExp(` ${count}#\\d+`), count);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
