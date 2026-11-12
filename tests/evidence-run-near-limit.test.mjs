// #C962 (11-11: the evidence job failed 151 of 161 runs from 3:52 to 8:02 pm MT and the only line it left was "node exited 1"; good runs took 60 to 88 s
// against a 90 s limit). (a) a failed run says why, in the log and on the page's Probe chip; (b) a slow run is logged with where its time went, and shown.
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import { writeEvidence, readView, PROBE_SILENT_MS } from "../worker/board-store.mjs";
import { evidenceRefusal, runShape, STALE_AFTER_MS } from "../worker/board-rules.mjs";
import { headerHtml } from "../worker/page-header.mjs";
import { evidenceJob, childLine, plainLine, reportRunFailure, SLOW_RUN_MS, CHILD_LINE_MAX } from "../collector/probe-evidence.mjs";
import { runChild } from "../collector/probe-run.mjs";
import { JOBS } from "../worker/probe-jobs.mjs";

const T = 1_800_000_000_000;
const STATE = JSON.stringify({ v: 1, board: { boardId: "b", at: T, cardsCheckedAt: T }, cards: {}, agents: {} });
const job = (over = {}, posted = [], lines = []) => ({
  job: "evidence", base: "https://x.example", headers: {}, configPath: "/c", stateFile: "/s/state.json", build: async () => {}, ghCheck: () => true,
  read: (p) => { if (p === "/c") return JSON.stringify({ collector: { repoPath: "/r" } }); if (p === "/s/state.json") return STATE; throw new Error("none"); },
  deployRead: async () => ({ worker: "", tree: "" }), liveFetch: async () => ({ ok: false, status: 500 }),
  fetchImpl: async (url, o) => { posted.push(JSON.parse(o.body)); return { ok: true, status: 200 }; }, log: (l) => lines.push(l), ...over,
});

test("the child's last stderr line is what is kept: plain text, cut at 160, empty when it said nothing", () => {
  assert.equal(childLine({ stderr: "warming up\nstate: the state doesn't fit the plan (1 problem(s), first: agents.Security.card: not allowed)\n\n" }), "state: the state doesn't fit the plan (1 problem(s), first: agents.Security.card: not allowed)");
  assert.equal(childLine({ stderr: "a\u001b[31mb\u0000c\r\n" }), "a[31mbc", "control characters are dropped");
  assert.equal(childLine({ stderr: "ab ".repeat(100) }).length, CHILD_LINE_MAX, "cut at 160");
  assert.equal(childLine({ stderr: "" }), "");
  assert.equal(childLine(new Error("no stderr")), "");
  assert.equal(childLine(null), "");
});

// Checker F1 on fcaaa63: a crash outside the state child's handlers ends with Node's own "Node.js v24.21.0", which was shown instead of why.
test("a crash's reason is its Error line, not Node's version trailer, a stack frame or the source excerpt (a real child)", async () => {
  const child = await runChild(process.execPath, ["-e", "function f() { throw new Error('the state is wrong'); } f();"], {}).then(() => null, (e) => e);
  assert.ok(child, "the child failed");
  assert.match(child.stderr, /Node\.js v\d/, "a real crash does end with Node's version line");
  assert.equal(childLine(child), "Error: the state is wrong");
  const typed = await runChild(process.execPath, ["-e", "class StateError extends Error {}; throw new StateError('bad');"], {}).then(() => null, (e) => e);
  assert.match(childLine(typed), /^(Error|StateError): bad$/, "an error of a named class is read as an error line too");
  const ownLine = "state: the state doesn't fit the plan (1 problem(s), first: agents.Security.card: not allowed)";
  assert.equal(childLine({ stderr: `${ownLine}\n` }), ownLine, "the child's own line is still the reason");
  assert.equal(childLine({ stderr: `${ownLine}\nError: later noise\n    at x (file:1:1)\n\nNode.js v24.21.0\n` }), "Error: later noise", "the last of the two kinds");
  assert.equal(childLine({ stderr: "plain last words\nNode.js v24.21.0\n" }), "plain last words", "neither kind: the last line left");
  assert.equal(childLine({ stderr: "Node.js v24.21.0\n    at x (a:1:1)\n^^^\n" }), "", "nothing but the trailer, a frame and a caret");
});

// Checker LOW1 on fcaaa63 and Security's suggestion: what leaves the Mac holds no path and no token-like run.
test("the line that leaves is plain: a path is <path>, a token-like run is hidden, and the store's shape still takes it", () => {
  assert.equal(plainLine("ENOENT: no such file or directory, open '/Users/someone/Library/Application Support/x.json'"), "ENOENT: no such file or directory, open <path> <path>", "each word that holds a slash is a path");
  assert.doesNotMatch(plainLine("open '/Users/someone/secret folder/a'"), /someone|Users/);
  assert.doesNotMatch(plainLine("EACCES ~/.flight-board/abc/state.json and ./rel/path and C:/x/y"), /flight-board|rel|x\/y/);
  assert.equal(plainLine("key abcdefghijklmnopqrstuvwx ok"), "key <hidden> ok");
  assert.equal(plainLine("a 23-letter run abcdefghijklmnopqrstuvw is left"), "a 23-letter run abcdefghijklmnopqrstuvw is left");
  assert.equal(plainLine("tok_ABCDEF-ghijklmnop_abcdefghij!"), "<hidden>!");
  assert.equal(plainLine("x".repeat(500)), "<hidden>");
  assert.equal(plainLine("ab ".repeat(200)).length, CHILD_LINE_MAX);
  assert.equal(plainLine(null), "");
  for (const s of ["open '/Users/someone/x'", "key abcdefghijklmnopqrstuvwxyz0123", "a\u0000b"]) assert.equal(runShape({ ok: false, at: T, line: plainLine(s) }), true, s);
  const e = Object.assign(new Error("EACCES: permission denied, open '/Users/someone/x'"), { childLine: "" });
  const posted = [];
  return reportRunFailure(e, { base: "https://x.example", headers: {}, fetchImpl: async (u, o) => { posted.push(JSON.parse(o.body)); return { ok: true }; } }).then(() => {
    assert.doesNotMatch(posted[0].value.line, /someone|Users/, "the message fallback is cleaned too");
    assert.match(posted[0].value.line, /<path>/);
  });
});

test("a state child that fails leaves its last line in the log and on the error, and the run still fails", async () => {
  const lines = [], posted = [];
  const e = Object.assign(new Error("node exited 1"), { code: 1, stderr: "state: the state doesn't fit the plan (1 problem(s), first: agents.Security.card: not allowed)\n" });
  await assert.rejects(evidenceJob(job({ build: async () => { throw e; } }, posted, lines)), (err) => err.childLine.startsWith("state: the state doesn't fit the plan") && err.message === "node exited 1");
  assert.ok(lines.some((l) => l.startsWith("state child said: state: the state doesn't fit the plan")), lines.join(" | "));
  assert.equal(posted.some((b) => b.key === "run.evidence"), false, "nothing is posted by the job itself on a failure; the wrapper reports it");
  const quiet = [];
  await assert.rejects(evidenceJob(job({ build: async () => { throw new Error("node killed after 75000 ms"); } }, [], quiet)));
  assert.ok(!quiet.some((l) => /state child said/.test(l)), "no line when the child said nothing");
});

test("a failed run reports why to the store as run.evidence; a store that does not answer cannot hold the wrapper", async () => {
  const posted = [];
  await reportRunFailure(Object.assign(new Error("node exited 1"), { childLine: "state: bad (first: agents.X.card: not allowed)" }), { base: "https://x.example", headers: {}, fetchImpl: async (u, o) => { posted.push(JSON.parse(o.body)); return { ok: true }; } });
  assert.equal(posted.length, 1);
  assert.equal(posted[0].key, "run.evidence");
  assert.equal(posted[0].value.ok, false);
  assert.equal(posted[0].value.line, "state: bad (first: agents.X.card: not allowed)");
  assert.equal(runShape(posted[0].value), true, "what the probe sends is what the Worker takes");
  const fell = [];
  await reportRunFailure(new Error("evidence write cards.x answered 500"), { base: "https://x.example", headers: {}, fetchImpl: async (u, o) => { fell.push(JSON.parse(o.body)); return { ok: true }; } });
  assert.equal(fell[0].value.line, "evidence write cards.x answered 500", "no child line: the error's own message");
  const t0 = Date.now();
  await reportRunFailure(new Error("x"), { base: "https://x.example", headers: {}, waitMs: 30, fetchImpl: () => new Promise(() => {}) });
  assert.ok(Date.now() - t0 < 1000, "a store that never answers is waited for only waitMs");
  await reportRunFailure(new Error("x"), { base: "https://x.example", headers: {}, fetchImpl: async () => { throw new Error("down"); } });
});

test("a normal run is quiet and posts run.evidence ok without slow; a run past 150 s is logged with where the time went and posts slow", async () => {
  assert.equal(SLOW_RUN_MS, 150_000, "warn past 150 s of the 170 s limit (#C996's stopgap; it was 75 s of 90 s)");
  mock.timers.enable({ apis: ["Date"], now: T });
  try {
    const lines = [], posted = [];
    await evidenceJob(job({ build: async () => { mock.timers.tick(20_000); } }, posted, lines));
    const ok = posted.find((b) => b.key === "run.evidence").value;
    assert.equal(ok.ok, true);
    assert.equal(ok.slow, undefined, "under the line: no slow mark");
    assert.equal(runShape(ok), true);
    assert.ok(!lines.some((l) => /slow run/.test(l)), "no alert for a normal run: " + lines.join(" | "));

    const slowLines = [], slowPosted = [];
    await evidenceJob(job({ build: async () => { mock.timers.tick(SLOW_RUN_MS + 5000); } }, slowPosted, slowLines));
    const slow = slowPosted.find((b) => b.key === "run.evidence").value;
    assert.equal(slow.slow, true);
    assert.equal(slow.stateMs, SLOW_RUN_MS + 5000);
    assert.equal(runShape(slow), true);
    const line = slowLines.find((l) => /slow run/.test(l));
    assert.match(line, /slow run: 155 s of 170 s \(state child 155000 ms, posts \d+ ms\)/);
  } finally { mock.timers.reset(); }
});

test("the usage job gets no run.evidence key and no slow line", async () => {
  const lines = [], posted = [];
  await evidenceJob(job({ job: "usage", build: async () => {}, read: (p) => { if (p === "/c") return JSON.stringify({ collector: { repoPath: "/r" } }); if (p === "/s/state.json") return STATE; throw new Error("none"); } }, posted, lines)).catch(() => {});
  assert.equal(posted.some((b) => b.key === "run.evidence"), false);
});

test("the store takes run.evidence only from the probe and only in its shape, and it is no heartbeat", async () => {
  assert.equal(evidenceRefusal("run.evidence", { ok: false, at: T, line: "agents.Security.card: not allowed" }, "probe"), null);
  assert.equal(evidenceRefusal("run.evidence", { ok: true, at: T, ms: 61000, stateMs: 40000, slow: true }, "probe"), null);
  assert.equal(evidenceRefusal("run.evidence", { ok: false, at: T }, "Manager")?.rule, "only-probe-writes-status");
  for (const bad of [null, [], "x", {}, { ok: "no", at: T }, { ok: false }, { ok: false, at: T, line: "x".repeat(161) }, { ok: false, at: T, line: "tab\there" }, { ok: false, at: T, extra: 1 }, { ok: true, at: T, slow: false }, { ok: true, at: T, ms: "1" }]) assert.equal(evidenceRefusal("run.evidence", bad, "probe")?.rule, "run-shape", JSON.stringify(bad));
  const db = makeDb();
  assert.equal((await writeEvidence(db, T, "probe", "run.evidence", { ok: false, at: T, line: "why" })).ok, true);
  assert.equal((await readView(db, T + 1000)).probe.state, "silent", "a failing report alone is not a heartbeat");
});

test("the page reads run.evidence into the probe it draws: a failure gives why, a slow run gives slow, only a reading under 5 minutes old counts", () => {
  const src = readFileSync(new URL("../worker/page.mjs", import.meta.url), "utf8");
  assert.match(src, /view\.evidence\["run\.evidence"\]/);
  assert.match(src, /Date\.now\(\) - rr\.value\.at <= 300000/);
  assert.match(src, /rv\.ok === false \? \{ \.\.\.probe0, why: rv\.line \|\| "failed" \}/);
  assert.match(src, /rv\.slow \? \{ \.\.\.probe0, slow: Math\.round\(\(rv\.ms \|\| 0\) \/ 1000\) \}/);
  assert.match(src, /headerHtml\(\{ live, probe(, deployFailed)? \}/, "the header gets the probe with the reading in it (and, since #C982, the deploy's failure)");
});

// Checker 2 on 4998fec: the page's two client-side edges were 180000 and turning one back survived the suite. They are the store's own (STALE_AFTER_MS
// for the Live now reading, PROBE_SILENT_MS for the probe), so a drift between the page and the store fails here.
test("the page's client edges for Live now and for a silent probe are the store's 5 minutes, not 3", () => {
  const src = readFileSync(new URL("../worker/page.mjs", import.meta.url), "utf8");
  assert.equal(STALE_AFTER_MS, 5 * 60_000);
  assert.equal(PROBE_SILENT_MS, 5 * 60_000);
  assert.match(src, /Date\.now\(\) - lr\.readAt > 300000 \? "stale" : "live"/, "Live now goes stale on screen after 5 minutes");
  assert.match(src, /Date\.now\(\) - \(view\.probe\.lastAt \|\| 0\) > 300000 \? \{ state: "silent"/, "the probe reads silent on screen after 5 minutes");
  assert.doesNotMatch(src, /> 180000/, "no 3-minute edge is left in the page");
});

test("the header says why the probe is failing, or that it is slow; nothing for a healthy one", () => {
  const live = { state: "live", version: "v1", age: 1000 };
  const html = (probe) => headerHtml({ live, probe });
  assert.doesNotMatch(html({ state: "ok", lastAt: T }), /Probe/);
  const fail = html({ state: "ok", lastAt: T, why: "state: bad (first: agents.Security.card: not allowed)" });
  assert.match(fail, /<span class="chip bad" title="probe failing: state: bad \(first: agents\.Security\.card: not allowed\)">/);
  const both = html({ state: "silent", since: T, why: "node exited 1" });
  assert.match(both, /silent since \d{1,2}:\d\d [ap]m MT: node exited 1/);
  const slow = html({ state: "ok", lastAt: T, slow: 155 });
  assert.match(slow, /<span class="chip warn" title="probe slow: 155 s of 170">/);
  // The limit in the text is the job table's, not a number typed in the header (#C996: it said "of 90" after the limit moved).
  const was = JOBS.evidence.limitSec;
  try { JOBS.evidence.limitSec = 99; assert.match(html({ state: "ok", lastAt: T, slow: 80 }), /probe slow: 80 s of 99">/); } finally { JOBS.evidence.limitSec = was; }
  assert.match(html({ state: "silent", since: T }), /<span class="chip bad" title="probe silent since \d{1,2}:\d\d [ap]m MT">/, "silent alone reads as before");
  assert.match(html({ state: "ok", why: "<img src=x>" }), /&lt;img src=x&gt;/, "the line is escaped");
});
