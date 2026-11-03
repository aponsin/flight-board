import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawnSync, execFileSync } from "node:child_process";
import { scratchRoot, EXPORT_NAME } from "../collector/collect.mjs";
import { writeDeltaState, writeStamp, readDeltaState } from "../collector/delta.mjs";
import { collectorEntry } from "../collector/state.mjs";

const COLLECT = new URL("../collector/collect.mjs", import.meta.url).pathname;
const uid = process.getuid();
const put = (root, c, id, doc) => { mkdirSync(join(root, c), { recursive: true }); writeFileSync(join(root, c, `${id}.json`), JSON.stringify(doc)); };

// A board folder with a repository (one commit on main, no remote), a mirror that a full read made, and a Collector run's sealed delta.
function setup() {
  const base = mkdtempSync(join(tmpdir(), "c642-probe-"));
  const repo = join(base, "repo"), state = join(base, "state"), dir = join(state, "Board01"), out = join(base, "out");
  mkdirSync(repo, { recursive: true });
  const git = (...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q", "-b", "main");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "start");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  mkdirSync(dir, { recursive: true });
  const cfg = join(base, "board.config.json");
  writeFileSync(cfg, JSON.stringify({ owner: "Sam", artifactUrl: ["https:", "", "claude.ai", "artifact", "Board01"].join("/"), gate: { stateDir: state }, collector: { repoPath: repo, outDir: out } }));
  const ran = Date.now() - 40 * 60e3;
  put(join(dir, "mirror"), "initiatives", "old-card", { name: "old", status: "active", phase: "plan", level: "Quick", size: "S", who: "Builder", updatedAt: ran });
  for (const c of ["waiting", "ideas", "messages", "ctx", "steps", "derived"]) mkdirSync(join(dir, "mirror", c), { recursive: true });
  writeStamp(join(dir, "mirror"), ran, ran);
  writeDeltaState(dir, { at: ran, fullAt: ran, lastPrepare: ran });
  const root = scratchRoot(dir, uid);
  return { base, dir, out, cfg, root, ran, done: () => rmSync(base, { recursive: true, force: true }) };
}
const probe = (s, ...extra) => spawnSync(process.execPath, [COLLECT, "--config", s.cfg, "--probe-step", "--no-fetch", ...extra], { cwd: s.dir, encoding: "utf8", timeout: 120_000 });

test("--probe-step: merges a sealed delta, derives from the mirror, writes derived-all.json and the lines for the lead; a second look does nothing more", () => {
  const s = setup();
  const session = join(s.root, `c642-test-${process.pid}-${Date.now()}`);
  try {
    const at = Date.now() - 60e3;
    writeFileSync(join(s.dir, "export-since.json"), JSON.stringify({ at, refs: {}, mode: "delta" }));
    const exp = join(session, "scratchpad", EXPORT_NAME);
    put(exp, "initiatives", "new-card", { name: "new", status: "active", phase: "plan", level: "Quick", size: "S", who: "Builder", updatedAt: at + 1 });
    put(exp, "derived", "all", { at });
    const first = probe(s);
    assert.equal(first.status, 0, first.stderr + first.stdout);
    assert.match(first.stdout, /merged a delta export \(2 written, 0 removed, 0 old steps dropped\)/);
    assert.ok(existsSync(join(s.dir, "mirror", "initiatives", "new-card.json")), "the delta is in the mirror");
    assert.ok(existsSync(join(s.dir, "mirror", "initiatives", "old-card.json")), "and the rest stays");
    const derived = JSON.parse(readFileSync(join(s.out, "derived-all.json"), "utf8"));
    assert.ok(Object.keys(derived.cards).includes("new-card") && Object.keys(derived.cards).includes("old-card"), "derived from the merged mirror");
    assert.equal(readDeltaState(s.dir).at, at);
    assert.ok(JSON.parse(readFileSync(join(s.dir, "derive-run.json"), "utf8")).at > 0);
    assert.equal(existsSync(exp), false, "the merged export is gone");
    // A minute later: nothing to merge, the derive is not due.
    const second = probe(s);
    assert.equal(second.status, 0, second.stderr);
    assert.doesNotMatch(second.stdout, /merged a/);
    assert.doesNotMatch(second.stdout, /Derived/, "no derive until it is ten minutes old or a merge changes the mirror");
  } finally { rmSync(session, { recursive: true, force: true }); s.done(); }
});

test("--probe-step --merge-only merges and makes the derive due, but derives nothing itself", () => {
  const s = setup();
  const session = join(s.root, `c642-test-${process.pid}-${Date.now()}`);
  try {
    const at = Date.now() - 30e3;
    writeFileSync(join(s.dir, "export-since.json"), JSON.stringify({ at, refs: {}, mode: "delta" }));
    const exp = join(session, "scratchpad", EXPORT_NAME);
    put(exp, "steps", "s1", { at: at + 5, init: "x", kind: "start", phase: "build", who: "Builder" });
    put(exp, "derived", "all", { at });
    const merged = probe(s, "--merge-only");
    assert.equal(merged.status, 0, merged.stderr);
    assert.match(merged.stdout, /merged a delta export/);
    assert.equal(existsSync(join(s.out, "derived-all.json")), false, "no derive in the merge-only call");
    assert.equal(JSON.parse(readFileSync(join(s.dir, "derive-run.json"), "utf8")).at, 0, "but it is due now");
    const derive = probe(s);
    assert.equal(derive.status, 0, derive.stderr);
    assert.match(derive.stdout, /Derived \d+ open card/);
    assert.ok(existsSync(join(s.out, "derived-all.json")));
  } finally { rmSync(session, { recursive: true, force: true }); s.done(); }
});

test("the pinned probe reaches the collector's code only by a child process: merge first, derive after the state is posted", () => {
  const src = readFileSync(new URL("../collector/state.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(src, /from "\.\/(collect|delta)\.mjs"/, "state.mjs imports none of the release's collector files: the owner's pinned install stays what Security signed");
  assert.match(src, /\[collectorEntry\(\), "--config", process\.argv\[at \+ 1\], "--probe-step", \.\.\.extra/);
  const merge = src.indexOf('probeStep(["--merge-only"])'), cards = src.indexOf("// The cards on the last export"), post = src.indexOf("await postState(fetch"), derive = src.lastIndexOf("deriveStep();");
  assert.ok(merge > 0 && merge < cards, "the mirror is merged before this minute reads its cards");
  assert.ok(derive > post, "the derive runs after the state is posted, which it must not delay");
  assert.match(src, /\.\.\.\(fetchIt \? \["--no-fetch"\] : \[\]\)/, "the probe has just fetched: the derive does not fetch again");
});

test("collectorEntry: always the install's own collect.mjs, never the current link's copy (Security, #C420 condition A)", () => {
  const code = `/home/u/.flight-board/install/${"a".repeat(40)}`;
  assert.equal(collectorEntry(code), `${code}/collector/collect.mjs`);
  assert.equal(collectorEntry(), fileURLToPath(new URL("../collector/collect.mjs", import.meta.url)), "the default is this install's own code, the file beside state.mjs");
  assert.equal(collectorEntry.length <= 1, true, "it takes no link and no existence check to be fooled by");
  const src = readFileSync(new URL("../collector/state.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(src, /collectorEntry\([^)]*current/, "no call hands it the current link");
});

test("lines the derive finds reach the lead: a nudge-worthy card is saved for the wake watch, once", () => {
  const s = setup();
  const session = join(s.root, `c642-test-${process.pid}-${Date.now()}`);
  try {
    const at = Date.now() - 20e3;
    writeFileSync(join(s.dir, "export-since.json"), JSON.stringify({ at, refs: {}, mode: "delta" }));
    const exp = join(session, "scratchpad", EXPORT_NAME);
    // An open card past its ETA by two hours: the Collector's NUDGE overdue line.
    put(exp, "initiatives", "late-card", { name: "late", status: "active", phase: "build", level: "Quick", size: "S", who: "Builder", etaLive: at - 2 * 3600e3, createdAt: at - 5 * 3600e3, updatedAt: at });
    put(exp, "derived", "all", { at });
    const out = probe(s);
    assert.equal(out.status, 0, out.stderr);
    const saved = JSON.parse(readFileSync(join(s.dir, "collector-lines.json"), "utf8"));
    assert.ok(saved.lines.some((l) => /^NUDGE .*late-card/.test(l)), saved.lines.join(" | "));
    assert.ok(saved.lines.every((l) => /^(CONFLICT|LIVE BUT OPEN|NUDGE|KEEPER|MIRROR DRIFT)\b/.test(l)));
    assert.match(out.stdout, /line\(s\) for the lead's watch|Derived/);
  } finally { rmSync(session, { recursive: true, force: true }); s.done(); }
});
