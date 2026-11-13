// #C982 (split from #C880): no reading said a board deploy failed, so the header could not show it. The owner's deploy file now leaves its last result
// (board-deploy-last.json { ok, at, line }), the probe posts it as evidence deploy.last, and the header shows "Deploy failed: <reason>" until a later deploy
// succeeds. Must still allow, as tests: a successful deploy (nothing shown), no deploy yet (nothing shown), an older failure followed by a success (cleared).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import { writeEvidence, readView } from "../worker/board-store.mjs";
import { evidenceRefusal, deployLastShape } from "../worker/board-rules.mjs";
import { headerHtml } from "../worker/page-header.mjs";
import { evidenceJob, deployLastWrite, DEPLOY_LAST_FILE } from "../collector/probe-evidence.mjs";
import { recordLast, LAST_FILE, deployRun } from "../scripts/pair/deploy.template.mjs";

const T = 1_800_000_000_000;
const TOKEN = "cf-token-SECRET123456", ACCOUNT = "9".repeat(32);

test("recordLast leaves { ok, at, line } in plain text of up to 160 characters, overwritten by each run, and a write that fails never throws", () => {
  assert.equal(LAST_FILE, DEPLOY_LAST_FILE, "the deploy file and the probe name the same file");
  const writes = [];
  const fs = { writeFileSync: (p, t) => writes.push([p, JSON.parse(t)]) };
  recordLast({ fs, here: "/o", ok: false, line: `migration exited 1:\n\tboom ${"x".repeat(300)}é`, now: T });
  assert.equal(writes[0][0], "/o/board-deploy-last.json");
  assert.deepEqual(Object.keys(writes[0][1]), ["ok", "at", "line"]);
  assert.equal(writes[0][1].ok, false); assert.equal(writes[0][1].at, T);
  assert.ok(writes[0][1].line.length <= 160 && /^[\x20-\x7e]*$/.test(writes[0][1].line), "plain and cut");
  assert.match(writes[0][1].line, /^migration exited 1: boom x+/);
  recordLast({ fs, here: "/o", ok: true, line: "DEPLOY OK: the Worker carries abcd1234", now: T + 1 });
  assert.deepEqual(writes[1][1], { ok: true, at: T + 1, line: "DEPLOY OK: the Worker carries abcd1234" });
  assert.doesNotThrow(() => recordLast({ fs: { writeFileSync() { throw new Error("EACCES"); } }, here: "/o", ok: true, line: "x" }));
  assert.doesNotThrow(() => recordLast({ fs: {}, here: "/o", ok: true, line: "x" }), "no writer at all");
});

test("the deploy run records its failure with the token taken out, and a success that follows overwrites it", () => {
  const SIGNED = "d".repeat(40), writes = [], lines = [];
  const fs = { existsSync: () => true, lstatSync: () => { throw new Error("ENOENT"); }, readFileSync: () => { throw new Error("ENOENT"); }, writeFileSync: (p, t) => writes.push([p, t]) };
  const fail = deployRun({ here: "/o", spawn: () => ({ status: 1, stdout: "", stderr: "" }), fs, say: (l) => lines.push(l), prepare: () => ({ ok: false, why: `the checkout ${TOKEN} is dirty` }), signed: SIGNED });
  assert.equal(fail.ok, false);
  const last = writes.filter(([p]) => p === "/o/board-deploy-last.json");
  assert.equal(last.length, 1);
  assert.equal(JSON.parse(last[0][1]).ok, false);
  assert.match(JSON.parse(last[0][1]).line, /dirty/);
  assert.ok(!last[0][1].includes("Paste this line to Manager"), "the reason, not the boilerplate");
  const ok = deployRun({ here: "/o", spawn: (cmd, args) => (cmd === "git" ? { status: 0, stdout: `${SIGNED}\n` } : { status: 0, stdout: "Current Version ID: 12345678-1234-1234-1234-123456789abc", stderr: "" }), fs, say: () => {}, prepare: () => ({ ok: true }), signed: SIGNED });
  assert.equal(ok.ok, true);
  const lastOk = writes.filter(([p]) => p === "/o/board-deploy-last.json").at(-1);
  assert.equal(JSON.parse(lastOk[1]).ok, true, "the last write is the success: the earlier failure is replaced");
});

const readOf = (text) => (p) => { if (p === `/cfg/${DEPLOY_LAST_FILE}`) { if (text instanceof Error) throw text; return text; } throw new Error("none"); };

test("the probe posts the deploy file's result as deploy.last: a failure with its reason, a success, and nothing when there is no file or it is not ours", () => {
  const w = (text) => deployLastWrite({ configPath: "/cfg/board.config.json", read: readOf(text) });
  assert.deepEqual(w(JSON.stringify({ ok: false, at: T, line: "deploy exited 1: boom" })), { key: "deploy.last", value: { ok: false, at: T, line: "deploy exited 1: boom" } });
  assert.deepEqual(w(JSON.stringify({ ok: true, at: T })), { key: "deploy.last", value: { ok: true, at: T } }, "a success carries no line");
  assert.equal(w(new Error("ENOENT")), null, "no deploy yet");
  for (const bad of ["", "not json", "null", "[]", '{"ok":"no","at":1}', '{"ok":true}', '{"ok":true,"at":"x"}']) assert.equal(w(bad), null, bad);
  const path = w(JSON.stringify({ ok: false, at: T, line: "ENOENT /Users/someone/Documents/x " + "k".repeat(30) })).value.line;
  assert.match(path, /<path>/); assert.doesNotMatch(path, /Users|kkkkkkkkkkkkkkkkkkkkkkkk/, "a path is <path>, a token-like run is hidden");
  assert.equal(w(JSON.stringify({ ok: false, at: T, line: "word ".repeat(100) })).value.line.length, 160, "cut at 160");
  assert.equal(w(JSON.stringify({ ok: false, at: T, line: "y".repeat(500) })).value.line, "<hidden>", "a long unbroken run is token-like: hidden");
  assert.equal(deployLastShape(w(JSON.stringify({ ok: false, at: T, line: "<script>alert(1)</script>" })).value), true, "what leaves always fits the store's shape");
});

const STATE = JSON.stringify({ v: 1, board: { boardId: "b", at: T, cardsCheckedAt: T }, cards: {}, agents: {} });
const job = (files, posted = [], over = {}) => ({
  job: "evidence", base: "https://x.example", headers: {}, configPath: "/cfg/board.config.json", stateFile: "/s/state.json", build: async () => {}, ghCheck: () => true,
  read: (p) => { if (p === "/cfg/board.config.json") return JSON.stringify({ collector: { repoPath: "/r" } }); if (p === "/s/state.json") return STATE; if (p in files) return files[p]; throw new Error("none"); },
  deployRead: async () => ({ worker: "", tree: "" }), liveFetch: async () => ({ ok: false, status: 500 }),
  fetchImpl: async (url, o) => { posted.push(JSON.parse(o.body)); return { ok: true, status: 200 }; }, log: () => {}, ...over,
});

test("the evidence job posts deploy.last when the file is there, never for the usage job, and a missing file adds no key", async () => {
  const file = { [`/cfg/${DEPLOY_LAST_FILE}`]: JSON.stringify({ ok: false, at: T, line: "deploy exited 1" }) };
  const posted = [];
  await evidenceJob(job(file, posted));
  assert.deepEqual(posted.find((b) => b.key === "deploy.last").value, { ok: false, at: T, line: "deploy exited 1" });
  const none = [];
  await evidenceJob(job({}, none));
  assert.equal(none.some((b) => b.key === "deploy.last"), false, "no deploy yet: no key");
  const usage = [];
  await evidenceJob(job(file, usage, { job: "usage" })).catch(() => {});
  assert.equal(usage.some((b) => b.key === "deploy.last"), false, "only the evidence job");
});

test("the store takes deploy.last only from the probe and only in its shape", async () => {
  assert.equal(evidenceRefusal("deploy.last", { ok: false, at: T, line: "why" }, "probe"), null);
  assert.equal(evidenceRefusal("deploy.last", { ok: true, at: T }, "probe"), null);
  assert.equal(evidenceRefusal("deploy.last", { ok: false, at: T }, "Manager")?.rule, "only-probe-writes-status");
  for (const bad of [null, [], "x", {}, { ok: "no", at: T }, { ok: false }, { ok: false, at: T, line: "x".repeat(161) }, { ok: false, at: T, line: "tab\there" }, { ok: false, at: T, extra: 1 }, { ok: false, at: T, line: 5 }]) {
    assert.equal(evidenceRefusal("deploy.last", bad, "probe")?.rule, "deploy-last-shape", JSON.stringify(bad));
  }
  const db = makeDb();
  assert.equal((await writeEvidence(db, T, "probe", "deploy.last", { ok: false, at: T, line: "why" })).ok, true);
  assert.equal((await readView(db, T + 1000)).evidence["deploy.last"].value.line, "why", "the view carries it with its reading time");
  assert.equal(typeof (await readView(db, T + 1000)).evidence["deploy.last"].readAt, "number");
});

test("the page turns a failed deploy.last the probe read under 5 minutes ago into the header's deployFailed; a success, an old reading or none gives null", () => {
  const src = readFileSync(new URL("../worker/page.mjs", import.meta.url), "utf8");
  assert.match(src, /view\.evidence\["deploy\.last"\]/);
  assert.match(src, /dl\.value\.ok === false && Date\.now\(\) - dl\.readAt <= 300000 \? \(dl\.value\.line \|\| "failed"\) : null/, "failed, fresh by the probe's reading time");
  assert.match(src, /headerHtml\(\{ live, probe, deployFailed \}/);
  // The same expression, run: the cases the card names.
  const expr = /const dl = view\.evidence\["deploy\.last"\], deployFailed = (.*);\n/.exec(src)[1];
  const run = (view, now) => new Function("view", "Date", `const dl = view.evidence["deploy.last"]; return ${expr};`)(view, { now: () => now });
  assert.equal(run({ evidence: { "deploy.last": { value: { ok: false, at: T - 864e5, line: "deploy exited 1" }, readAt: T - 30_000 } } }, T), "deploy exited 1", "an old failure still read a minute ago is shown");
  assert.equal(run({ evidence: { "deploy.last": { value: { ok: false, at: T }, readAt: T } } }, T), "failed", "no line: failed");
  assert.equal(run({ evidence: { "deploy.last": { value: { ok: true, at: T, line: "DEPLOY OK" }, readAt: T } } }, T), null, "a successful deploy: nothing");
  assert.equal(run({ evidence: {} }, T), null, "no deploy yet: nothing");
  assert.equal(run({ evidence: { "deploy.last": { value: { ok: false, at: T, line: "x" }, readAt: T - 301_000 } } }, T), null, "a reading over 5 minutes old (the probe stopped reading it)");
});

test("the header shows Deploy failed: <reason> and nothing else for a healthy board; the reason is escaped; the label stays when the detail drops", () => {
  const live = { state: "live", version: "v1", age: 1000 }, probe = { state: "ok", lastAt: T };
  const html = (deployFailed) => headerHtml({ live, probe, ...(deployFailed === undefined ? {} : { deployFailed }) });
  assert.doesNotMatch(html(), /Deploy failed/, "no deploy yet or a success: nothing");
  assert.doesNotMatch(html(null), /Deploy failed/);
  const bad = html("deploy exited 1: boom");
  assert.match(bad, /<span class="chip bad" title="Deploy failed: deploy exited 1: boom"><span class="dot"><\/span><span class="lbl">Deploy failed<\/span><span class="detail">deploy exited 1: boom<\/span><\/span>/);
  assert.match(html("<img src=x>"), /&lt;img src=x&gt;/);
  // Checker 2's F1 LOW on 81d976c4: the reason can carry the deploy tool's error text, and deployLastShape allows < > & ". Both places are escaped.
  const hostile = html(`x <b>&"y`);
  assert.match(hostile, /title="Deploy failed: x &lt;b&gt;&amp;&quot;y"/, "the title");
  assert.match(hostile, /<span class="detail">x &lt;b&gt;&amp;&quot;y<\/span>/, "the detail");
  assert.doesNotMatch(hostile, /x <b>/, "no raw tag from the reason");
  assert.match(html(""), /<span class="detail">failed<\/span>/, "an empty reason reads failed");
  assert.ok(bad.indexOf("Deploy failed") > bad.indexOf("Manager") && bad.indexOf("Deploy failed") < bad.indexOf('class="chip ver"'), "after Manager, before the version");
  assert.equal((html("x").match(/class="hd"/g) ?? []).length, 1, "still one header row");
});
