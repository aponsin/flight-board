// Pull request approvals as Approval asks (#C727, board parity C4): the ask's checked parts, the old page's panel fed from them,
// its Approve and Withdraw through the write router, a push to a new head, and Release's ship-start check.
import test from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import { drawPage } from "./helpers/draw-page.mjs";
import worker from "../worker/board-worker.mjs";
import { askRefusal, withdrawRefusal } from "../worker/board-rules.mjs";
import { answerAsk, withdrawAsk, closeAsk, readView } from "../worker/board-store.mjs";
import { compatView } from "../worker/compat-view.mjs";
import { approvalFor } from "../worker/compat-approvals.mjs";
import { checkApproval } from "../scripts/approvals-check.mjs";

const NOW = Date.now();
const H1 = "a".repeat(40), H2 = "b".repeat(40);
const URL12 = "https://github.com/example/sites/pull/12";
const approval = (head = H1, extra = {}) => ({ type: "Approval", title: "Add Pro Shop", pr: 12, head, url: URL12, ...extra });
const WHO = { owner: { who: "owner", role: "owner" }, reviewer: { who: "Reviewer", role: "agent" }, builder: { who: "Builder", role: "agent" }, release: { who: "Release", role: "agent" } };
const make = () => {
  const env = { DB: makeDb() };
  const call = (as, path, init = {}) => worker.fetch(new Request(`https://board.test${path}`, init.method === "POST" ? { ...init, headers: { "content-type": "application/json", "x-as": as, ...init.headers } } : { ...init, headers: { "x-as": as, ...init.headers } }), env, null, NOW, async (req) => WHO[req.headers.get("x-as")] ?? null);
  const tool = async (as, name, args) => (await (await call(as, "/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) })).json()).result.structuredContent;
  const write = async (w, as = "owner") => { const r = await call(as, "/api/compat/write", { method: "POST", body: JSON.stringify(w) }); return { status: r.status, body: await r.json().catch(() => null) }; };
  const compat = async () => (await (await call("owner", "/api/compat")).json()).collections;
  return { env, call, tool, write, compat };
};
const approve = (head = H1) => ({ op: "set", path: "approvals/pr12", data: { number: 12, head, at: NOW, by: "Owner" } });
const withdraw = { op: "delete", path: "approvals/pr12" };

test("an Approval carries the pull request, its full head and its own link, and is asked by Reviewer or the lead", () => {
  const ok = { ...approval(), asked_by: "Reviewer" };
  assert.equal(askRefusal(ok, NOW), null);
  assert.equal(askRefusal({ ...ok, asked_by: "Manager" }, NOW), null);
  assert.equal(askRefusal({ ...ok, asked_by: "Builder" }, NOW).rule, "approval-asker");
  assert.equal(askRefusal({ ...ok, head: "abc1234" }, NOW).rule, "approval-shape", "a short head");
  assert.equal(askRefusal({ ...ok, head: "A".repeat(40) }, NOW).rule, "approval-shape", "upper case is not git's");
  assert.equal(askRefusal({ ...ok, pr: "12" }, NOW).rule, "approval-shape");
  assert.equal(askRefusal({ ...ok, url: "https://github.com/example/sites/pull/13" }, NOW).rule, "approval-shape", "the link is that pull request's");
  assert.equal(askRefusal({ ...ok, url: "https://evil.example/example/sites/pull/12" }, NOW).rule, "approval-shape");
  assert.equal(askRefusal({ ...ok, url: `${URL12}/files` }, NOW).rule, "approval-shape");
  assert.equal(askRefusal({ ...ok, url: undefined }, NOW).rule, "ask-missing-part");
  assert.equal(askRefusal({ ...ok, card: "x", version: "1.0.0" }, NOW).rule, "unknown-field", "the old parts are gone");
});

test("Withdraw is the owner's, on an open approved Approval only", () => {
  const a = { id: "t1", type: "Approval", answered_at: NOW, closed_at: null };
  assert.equal(withdrawRefusal(a, "owner"), null);
  assert.equal(withdrawRefusal(a, "agent").rule, "withdraw-not-owner");
  assert.equal(withdrawRefusal({ ...a, answered_at: null }, "owner").rule, "withdraw-not-approved");
  assert.equal(withdrawRefusal({ ...a, closed_at: NOW }, "owner").rule, "ask-already-closed");
  assert.equal(withdrawRefusal({ ...a, type: "Decision" }, "owner").rule, "withdraw-not-approval");
  assert.equal(withdrawRefusal(null, "owner").rule, "ask-unknown");
});

test("an Approval is in the panel, not in Needs you; Approve answers it for that head only; Withdraw clears it; Approve again works", async () => {
  const { tool, write, compat } = make();
  const r = await tool("reviewer", "ask", approval());
  assert.equal(r.ok, true, JSON.stringify(r));
  let c = await compat();
  assert.equal(c.waiting.length, 0, "not in Needs you");
  assert.deepEqual(c.agentPrs, [{ id: "pr12", number: 12, title: "Add Pro Shop", url: URL12, head: H1, signedHead: H1, signedAt: NOW, review: "ok", at: NOW }]);
  assert.deepEqual(c.approvals, []);
  assert.equal((await write(approve(H2))).body.refused.rule, "approval-unknown", "a head nobody asked about");
  assert.equal((await write({ op: "set", path: "approvals/pr12", data: { number: 13, head: H1 } })).body.refused.rule, "approval-shape");
  assert.equal((await write(approve())).status, 200);
  c = await compat();
  assert.deepEqual(c.approvals, [{ id: "pr12", number: 12, head: H1, at: NOW, by: "owner" }]);
  assert.equal((await write(approve())).body.refused.rule, "ask-already-answered");
  assert.equal((await write(withdraw)).status, 200);
  c = await compat();
  assert.deepEqual(c.approvals, []); assert.equal(c.agentPrs.length, 1, "it waits for his Approve again");
  assert.equal((await write(withdraw)).body.refused.rule, "withdraw-not-approved");
  assert.equal((await write(approve())).status, 200, "approve again after a withdraw");
  assert.equal((await write(approve(), "reviewer")).status, 403, "only the owner writes through the page's router");
});

test("an Approval takes only Approve: Done, Ack or a note through Needs you are refused; an agent cannot answer or withdraw", async () => {
  const { env, tool, write, call } = make();
  const { id } = await tool("reviewer", "ask", approval());
  assert.equal((await write({ op: "update", path: `waiting/${id}`, data: { response: { status: "done", note: "", at: 1 } } })).body.refused.rule, "approval-answer");
  assert.equal((await answerAsk(env.DB, NOW, "owner", { id, answer: "Approve" })).ok, true);
  assert.equal((await withdrawAsk(env.DB, NOW, "Reviewer", id, "agent")).refused.rule, "withdraw-not-owner");
  assert.equal((await withdrawAsk(env.DB, NOW, "owner", id, "owner")).ok, true);
  const row = await env.DB.prepare("SELECT answered_at, answer, withdrawn_at, withdrawn_by FROM asks WHERE id = ?").bind(id).first();
  assert.deepEqual(row, { answered_at: null, answer: null, withdrawn_at: NOW, withdrawn_by: "owner" });
  const rpc = await (await call("reviewer", "/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "answer", arguments: { id, answer: "Approve" } } }) })).json();
  assert.equal(rpc.result, undefined, "an agent has no answer tool"); assert.ok(rpc.error, JSON.stringify(rpc));
});

test("a closed Approval takes no answer, even unanswered (merged or replaced)", async () => {
  const { env, tool } = make();
  const { id } = await tool("reviewer", "ask", approval());
  assert.equal((await tool("reviewer", "ask_close", { id })).ok, true, "an Approval closes unanswered");
  const r = await answerAsk(env.DB, NOW, "owner", { id, answer: "Approve" });
  assert.equal(r.refused?.rule, "approval-answer", JSON.stringify(r));
});

test("asked again for an approved head after its ask closed: the panel shows it unapproved, as Release reads it", async () => {
  const { env, tool, write, compat } = make();
  const old = await tool("reviewer", "ask", approval(H1));
  await write(approve(H1));
  await tool("reviewer", "ask_close", { id: old.id });
  await tool("reviewer", "ask", approval(H1));
  const c = await compat();
  assert.deepEqual(c.agentPrs.map((p) => p.head), [H1]);
  assert.deepEqual(c.approvals, [], "not shown approved");
  assert.equal(approvalFor((await readView(env.DB, NOW)).asks, 12, H1).ok, false);
  assert.equal((await write(approve(H1))).status, 200, "he can approve it");
});

test("Withdraw clears every open approval of the pull request, an older head's too", async () => {
  const { env, tool, write } = make();
  await tool("reviewer", "ask", approval(H1));
  await write(approve(H1));
  await tool("reviewer", "ask", approval(H2));
  await write(approve(H2));
  assert.equal((await write(withdraw)).status, 200);
  const asks = (await readView(env.DB, NOW)).asks;
  assert.equal(approvalFor(asks, 12, H1).ok, false, "the older head no longer counts");
  assert.equal(approvalFor(asks, 12, H2).ok, false);
});

test("Release's script run as a command: no arguments is exit 2 with a usage line, also through a path with a space and a symlink", async () => {
  const { spawnSync } = await import("node:child_process");
  const { mkdtempSync, symlinkSync, mkdirSync } = await import("node:fs");
  const { join, resolve } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { fileURLToPath } = await import("node:url");
  const real = resolve(fileURLToPath(new URL("../scripts/approvals-check.mjs", import.meta.url)));
  const dir = join(mkdtempSync(join(tmpdir(), "c727-")), "a space");
  mkdirSync(dir);
  const link = join(dir, "check.mjs");
  symlinkSync(real, link);
  for (const path of [real, link]) {
    const r = spawnSync(process.execPath, [path], { encoding: "utf8", env: { ...process.env, BOARD_CONNECTOR_URL: "" } });
    assert.equal(r.status, 2, `${path}: ${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /^usage: /);
  }
  const missing = spawnSync(process.execPath, [real, "12", H1, "--connector-file", join(dir, "none")], { encoding: "utf8" });
  assert.equal(missing.status, 2); assert.match(missing.stdout, /^could not read /);
  // With the address from BOARD_CONNECTOR_URL only (no --connector-file), the pull request number is still read (Checker on #C727):
  // the run reaches the network, which here is a host that does not exist.
  const envOnly = spawnSync(process.execPath, [real, "12", H1], { encoding: "utf8", env: { ...process.env, BOARD_CONNECTOR_URL: "https://board.invalid/mcp/x" } });
  assert.equal(envOnly.status, 2); assert.match(envOnly.stdout, /^could not reach the board/); assert.doesNotMatch(envOnly.stdout, /usage/);
});

test("a push: Reviewer asks for the new head and closes the old ask; the panel says Approve again; the old approval no longer counts", async () => {
  const { env, tool, write, compat } = make();
  const old = await tool("reviewer", "ask", approval(H1));
  assert.equal((await write(approve(H1))).status, 200);
  await tool("reviewer", "ask", approval(H2));
  assert.equal((await tool("reviewer", "ask_close", { id: old.id })).ok, true);
  const c = await compat();
  assert.deepEqual(c.agentPrs.map((p) => p.head), [H2]);
  assert.deepEqual(c.approvals.map((a) => a.head), [H1], "the old approval, for the old head");
  const drawn = drawPage(c, { host: "store" });
  assert.equal(drawn.els.agentprs.hidden, false);
  assert.match(drawn.els.agentprs.innerHTML, /Approve again/);
  assert.match(drawn.els.agentprs.innerHTML, new RegExp(`data-head="${H2}"`));
  assert.match(drawn.els.agentprs.innerHTML, /pushed after your approval of <code>aaaaaaa<\/code>/);
  const view = await readView(env.DB, NOW);
  assert.equal(approvalFor(view.asks, 12, H2).ok, false); assert.match(approvalFor(view.asks, 12, H2).why, /has not approved/);
  assert.match(approvalFor(view.asks, 12, H1).why, /closed/);
  assert.equal((await write(approve(H1))).body.refused.rule, "approval-unknown", "the closed ask takes no approval");
  assert.equal((await answerAsk(env.DB, NOW, "owner", { id: old.id, answer: "Approve" })).refused.rule, "ask-already-answered");
  assert.equal((await write(approve(H2))).status, 200);
  assert.equal(approvalFor((await readView(env.DB, NOW)).asks, 12, H2).ok, true);
});

test("the panel shows an approved pull request apart with its Withdraw; a merged one (closed) leaves the panel", async () => {
  const { env, tool, write, compat } = make();
  const { id } = await tool("reviewer", "ask", approval());
  await write(approve());
  let d = drawPage(await compat(), { host: "store" });
  assert.match(d.els.agentprs.innerHTML, /1 approved: merge at the next ship/);
  assert.match(d.els.agentprs.innerHTML, /data-gpw="1" data-n="12"/);
  assert.equal((await closeAsk(env.DB, NOW, "Release", id, "agent")).refused.rule, "close-not-yours", "Release closes through Reviewer or the lead");
  assert.equal((await tool("reviewer", "ask_close", { id })).ok, true);
  d = drawPage(await compat(), { host: "store" });
  assert.equal(d.els.agentprs.hidden, true);
});

test("approvalFor: approved at that head, or why not; nothing but an answered, open ask at that head counts", async () => {
  const { env, tool, write } = make();
  assert.match(approvalFor([], 12, H1).why, /no Approval ask/);
  assert.match(approvalFor([], 12, "abc").why, /40-character/);
  for (const short of ["a".repeat(12), "a".repeat(39), "A".repeat(40)]) assert.match(approvalFor([{ type: "Approval", num: 1, body: JSON.stringify({ pr: 12, head: short }), answered_at: NOW, answer: "Approve", answered_by: "owner" }], 12, short).why, /40-character/, `head ${short.length} long`);
  const forged = { id: "t9", type: "Approval", num: 9, body: JSON.stringify({ pr: 12, head: H1 }), answered_at: NOW, answer: "Approve", answered_by: "Reviewer" };
  assert.equal(approvalFor([forged], 12, H1).ok, false, "only the owner's answer counts");
  const { id } = await tool("reviewer", "ask", approval());
  assert.match(approvalFor((await readView(env.DB, NOW)).asks, 12, H1).why, /has not approved/);
  await write(approve());
  assert.deepEqual(approvalFor((await readView(env.DB, NOW)).asks, 12, H1), { ok: true, id, at: NOW, by: "owner" });
  await write(withdraw);
  assert.match(approvalFor((await readView(env.DB, NOW)).asks, 12, H1).why, /withdrew/);
  assert.match(approvalFor((await readView(env.DB, NOW)).asks, 13, H1).why, /no Approval ask for pull request 13/);
});

test("Release's script reads the store through the connector as Release, prints one line and never the address", async () => {
  const { env, tool, write } = make();
  await tool("reviewer", "ask", approval());
  await write(approve());
  const view = await readView(env.DB, NOW);
  const URL = "https://board.test/mcp/s3cr3t-value";
  const sent = [];
  const fetchImpl = async (url, init) => { sent.push({ url, body: JSON.parse(init.body) }); return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result: { structuredContent: view } }) }; };
  const ok = await checkApproval({ pr: 12, head: H1, url: URL, fetchImpl });
  assert.equal(ok.code, 0); assert.match(ok.line, /^approved: pull request 12 at aaaaaaaaaaaa/);
  assert.deepEqual(sent[0].body.params, { name: "read_view", arguments: { as: "Release" } });
  const no = await checkApproval({ pr: 12, head: H2, url: URL, fetchImpl });
  assert.equal(no.code, 1); assert.match(no.line, /^not approved: /);
  for (const r of [ok, no]) assert.doesNotMatch(r.line, /s3cr3t/);
  assert.equal((await checkApproval({ pr: 12, head: H1, url: undefined, fetchImpl })).code, 2);
  assert.equal((await checkApproval({ pr: 12, head: "abc", url: URL, fetchImpl })).code, 2);
  const down = await checkApproval({ pr: 12, head: H1, url: URL, fetchImpl: async () => { throw new TypeError("fetch failed"); } });
  assert.equal(down.code, 2); assert.doesNotMatch(down.line, /s3cr3t/);
  assert.equal((await checkApproval({ pr: 12, head: H1, url: URL, fetchImpl: async () => ({ ok: false, status: 404 }) })).code, 2);
});
