// #C1111: each role's model and effort are checked every run. Models and effort drift after a crash and were re-checked by hand. The board config says what each
// role is meant to run on (roleSessions), the app's session files say what its open session runs on (model, effort), the probe posts the pair as
// session.checks, and the page shows a drift red with the fix, a role with no open session amber, and nothing chosen grey. Remote Control is not read (a
// session file the probe can read does not carry it: #C865's spike).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkConfig, fullConfig } from "../scripts/config.mjs";
import { appSessions } from "../collector/state.mjs";
import { roleSessionsWrite, configuredRoles, newestRoleSessions } from "../collector/role-sessions.mjs";
import { evidenceJob } from "../collector/probe-evidence.mjs";
import { sessionChecksShape, evidenceRefusal } from "../worker/board-rules.mjs";
import { probeDoc } from "../worker/compat-view.mjs";
import { loadNames } from "./harness.mjs";

const T = 1_800_000_000_000, H = 3_600_000;
const cfgOf = (roleSessions) => JSON.stringify({ roleSessions });
const sess = (title, model, effort, at, extra = {}) => ({ id: `local_${title}_${at}`, title, transcript: "t", cwd: "/x", at, model, effort, ...extra });
const write = (config, sessions) => roleSessionsWrite(config, { sessions, now: T })?.value;
const OPUS = "claude-opus-5-5", SON = "claude-sonnet-5-5";

test("config: roleSessions defaults to none, and a list of { role, model?, effort? } with plain words is accepted", () => {
  assert.deepEqual(fullConfig({}).roleSessions, []);
  assert.deepEqual(checkConfig({ roleSessions: [{ role: "Manager", model: OPUS, effort: "medium" }, { role: "Checker 2", effort: "high" }, { role: "Release", model: null }] }), []);
});

test("config: every way to get a role wrong is refused, one test line each", () => {
  const bad = (v, re) => assert.ok(checkConfig({ roleSessions: v }).some((e) => re.test(e)), JSON.stringify(v));
  bad("x", /roleSessions: a list/);
  bad(Array.from({ length: 21 }, (_, i) => ({ role: `R${i}` })), /up to 20/);
  bad(["x"], /an object/);
  bad([{ role: "<b>" }], /\.role/);
  bad([{}], /\.role/);
  bad([{ role: "A" }, { role: "A" }], /listed twice/);
  bad([{ role: "A", model: "claude opus" }], /\.model/);
  bad([{ role: "A", effort: "extreme" }], /\.effort/);
  bad([{ role: "A", effort: 3 }], /\.effort/);
  bad([{ role: "A", mdoel: "x" }], /unknown field "mdoel"/);
});

test("appSessions keeps effort as a plain word (else null), beside the model", () => {
  const root = mkdtempSync(join(tmpdir(), "roles-")), org = join(root, "a".repeat(8) + "-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "b".repeat(8) + "-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
  try {
    mkdirSync(org, { recursive: true });
    const file = (n, extra) => writeFileSync(join(org, `local_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa${n}.json`), JSON.stringify({ title: `S${n}`, cliSessionId: `cccccccc-cccc-4ccc-8ccc-ccccccccccc${n}`, cwd: "/Users/x/Code/r", lastActivityAt: T, ...extra }));
    file(1, { model: OPUS, effort: "xhigh", prompt: "secret words" });
    file(2, { effort: "extreme\nline" });
    file(3, { effort: 5 });
    file(4, {});
    const rows = Object.fromEntries(appSessions(root).map((s) => [s.title, s]));
    assert.equal(rows.S1.effort, "xhigh");
    for (const t of ["S2", "S3", "S4"]) assert.equal(rows[t].effort, null, t);
    assert.ok(!JSON.stringify(rows.S1).includes("secret"), "nothing else of the file is kept");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the reading takes the newest open session of each configured role, and says when a role has none", () => {
  const v = write(cfgOf([{ role: "Manager", model: OPUS, effort: "medium" }, { role: "Release", model: SON, effort: "low" }, { role: "Security", model: OPUS }]), [
    sess("Manager", SON, "high", T - 5 * H), sess("Manager", OPUS, "medium", T - H), sess("Release", SON, "low", T - 2 * H), sess("Designer", OPUS, "high", T)]);
  assert.deepEqual(v, { at: T, roles: [
    { role: "Manager", chosen: OPUS, ran: OPUS, chosenEffort: "medium", ranEffort: "medium", at: T - H },
    { role: "Release", chosen: SON, ran: SON, chosenEffort: "low", ranEffort: "low", at: T - 2 * H },
    { role: "Security", chosen: OPUS, ran: null, chosenEffort: null, ranEffort: null, at: null }] });
  assert.equal(sessionChecksShape(v), true, "what the probe posts is what the store accepts");
  assert.ok(!JSON.stringify(v).includes("Designer"), "a session whose title is not in the config is never listed");
});

test("a title that only contains the role name is not that role's session; an unusable config posts nothing and says why", () => {
  assert.equal(newestRoleSessions([sess("Manager 2", OPUS, "low", T), sess("My Manager", OPUS, "low", T)], ["Manager"]).size, 0);
  assert.equal(write("{}", [sess("Manager", OPUS, "low", T)]), undefined, "no list: nothing posted");
  assert.equal(write(cfgOf([]), []), undefined);
  const logs = [];
  for (const c of ["not json", cfgOf("x"), cfgOf([{ role: "<b>" }]), cfgOf([{ role: "A" }, { role: "A" }]), cfgOf([{ role: "A", effort: "extreme" }]), cfgOf([{ role: "A", prompt: "extra" }]), cfgOf(Array.from({ length: 21 }, (_, i) => ({ role: `R${i}` })))]) assert.equal(roleSessionsWrite(c, { sessions: [], now: T, log: (l) => logs.push(l) }), null, c);
  assert.equal(logs.length, 7, "each says why");
  assert.equal(configuredRoles(cfgOf([])).length, 0);
});

test("the evidence job posts session.checks with the late writes before live; an archived session is not read; a failing read posts none but breaks nothing", async () => {
  const state = { v: 1, board: { boardId: "x".repeat(22), at: T, probe: "p".repeat(40), pageVersion: null }, cards: {}, agents: {} };
  const go = async (openSessionsRead) => {
    const posted = [];
    await evidenceJob({ job: "evidence", base: "https://x.test", headers: {}, configPath: "/c.json", stateFile: "/s.json", build: async () => {}, openSessionsRead, sessionsRead: () => [sess("Manager", "claude-haiku-5-5", "low", T)],
      read: (p) => (p === "/c.json" ? JSON.stringify({ roleSessions: [{ role: "Manager", model: OPUS, effort: "medium" }], collector: { liveUrl: "https://live.test/" } }) : JSON.stringify(state)), liveFetch: async () => ({ ok: true, json: async () => ({ version: "1.0.0" }) }),
      fetchImpl: async (_u, o) => { posted.push(JSON.parse(o.body)); return { ok: true, status: 200 }; } });
    return posted;
  };
  const ok = await go(() => [sess("Manager", SON, "medium", Date.now() - H)]);
  const keys = ok.map((b) => b.key);
  assert.ok(keys.indexOf("session.checks") >= 0 && keys.indexOf("session.checks") < keys.indexOf("live"), keys.join(","));
  const roles = ok.find((b) => b.key === "session.checks").value.roles;
  assert.deepEqual([roles[0].ran, roles[0].ranEffort], [SON, "medium"], "read from the open sessions, not the schedule reader that counts archived runs");
  const failed = (await go(() => { throw new Error("no folder"); })).map((b) => b.key);
  assert.ok(!failed.includes("session.checks") && failed.includes("live"));
});

test("the store accepts the shape and refuses anything else: words, model and effort names and times only", () => {
  const good = { at: T, roles: [{ role: "Manager", chosen: OPUS, ran: null, chosenEffort: "medium", ranEffort: "low", at: T }] };
  assert.equal(sessionChecksShape(good), true);
  assert.equal(evidenceRefusal("session.checks", good, "probe"), null);
  const r = good.roles[0];
  const bad = [null, [], { at: T }, { at: "x", roles: [] }, { at: T, roles: "x" }, { ...good, extra: 1 },
    { at: T, roles: Array.from({ length: 21 }, () => r) },
    { at: T, roles: [{ ...r, role: "<b>" }] }, { at: T, roles: [{ ...r, chosen: "m\nx" }] }, { at: T, roles: [{ ...r, ran: { x: 1 } }] },
    { at: T, roles: [{ ...r, chosenEffort: "extreme" }] }, { at: T, roles: [{ ...r, ranEffort: "extreme" }] }, { at: T, roles: [{ ...r, ranEffort: "high\nx" }] }, { at: T, roles: [{ ...r, ranEffort: undefined }] }, { at: T, roles: [{ ...r, at: "x" }] }, { at: T, roles: [{ ...r, prompt: "secret" }] }];
  for (const v of bad) assert.equal(sessionChecksShape(v), false, JSON.stringify(v));
  assert.notEqual(evidenceRefusal("session.checks", bad[3], "probe"), null, "a bad value is refused");
  assert.notEqual(evidenceRefusal("session.checks", good, "agent"), null, "only the probe writes evidence");
});

test("the page's probe document carries session.checks at any age, so the page can say the reading is old", () => {
  const view = (readAt) => ({ now: T, evidence: { "session.checks": { value: { at: T - 100 * H, roles: [] }, readAt } }, cards: [] });
  assert.deepEqual(probeDoc(view(T - 100 * H)).sessionChecks, { at: T - 100 * H, roles: [] });
  assert.equal(probeDoc({ now: T, evidence: {}, cards: [] }).sessionChecks, undefined);
});

// The page.
const page = (sessionChecks, at = T) => {
  const b = loadNames(["roleVerdict", "roleSessionsHtml", "probeEvent", "SCHED_OLD"], { Date: class extends Date { constructor(...a) { a.length ? super(...a) : super(at); } static now() { return at; } } });
  b.probeEvent({ type: "data", result: { payload: { v: 1, board: { boardId: "TestBoard42xyz", at, probe: null, pageVersion: null }, cards: {}, agents: {}, ...(sessionChecks ? { sessionChecks } : {}) } } }, {});
  return b;
};
const role = (chosen, ran, chosenEffort, ranEffort, at = T - H) => ({ role: "Manager", chosen, ran, chosenEffort, ranEffort, at });

test("the verdict: matching is green; another model or effort is red with the fix; no open session or an unread field is amber; nothing chosen is grey", () => {
  const b = page(null), v = (t) => JSON.parse(JSON.stringify(b.roleVerdict(t)));
  assert.deepEqual(v(role(OPUS, OPUS, "medium", "medium")), { c: "ok", txt: `✓ ${OPUS} · medium` }, "the green chip says it in words too");
  assert.deepEqual(v(role(OPUS, OPUS, null, "high")), { c: "ok", txt: `✓ ${OPUS}` }, "a field not chosen is not checked");
  const m = v(role(OPUS, SON, "medium", "medium"));
  assert.equal(m.c, "bad");
  assert.match(m.txt, new RegExp(`model ${SON}, chosen ${OPUS}: set the model to ${OPUS} in the app's model menu`));
  assert.match(v(role(OPUS, OPUS, "medium", "high")).txt, /effort high, chosen medium: set the effort to medium in the app's effort menu/);
  const both = v(role(OPUS, SON, "medium", "high"));
  assert.equal(both.c, "bad"); assert.match(both.txt, /model [\s\S]*; effort /);
  assert.deepEqual(v(role(OPUS, null, "medium", null, null)), { c: "warn", txt: "no open session" });
  assert.deepEqual(v(role(OPUS, null, null, "low")), { c: "warn", txt: "not read from the session" });
  assert.deepEqual(v(role(null, OPUS, null, "low")), { c: "mute", txt: "nothing chosen" });
});

// Checker 2's M1: the panel is part of the Crew view itself, not only a function that draws it.
test("the Crew view carries the Sessions panel with a red row for a drifted role, and none when there is no reading", () => {
  const now = Date.now();
  const crew = (sessionChecks) => {
    const b = loadNames(["crewHtml", "roleSessionsHtml", "roleVerdict", "probeEvent", "SCHED_OLD"]);
    Object.assign(b.state, { plan: [], ideas: [], threads: [], waiting: [], derived: [], initiatives: [], meta: [{ id: "context", at: now - 6e4, agents: { Manager: { pct: 44, tokens: 439048, at: now - 6e4 } } }], ctx: [] });
    b.probeEvent({ type: "data", result: { payload: { v: 1, board: { boardId: "TestBoard42xyz", at: now, probe: null, pageVersion: null }, cards: {}, agents: {}, ...(sessionChecks ? { sessionChecks } : {}) } } }, {});
    return b.crewHtml(now);
  };
  const html = crew({ at: now - H, roles: [role(OPUS, SON, "medium", "medium", now - H)] });
  assert.match(html, /<div class="panel sm" data-roles>[\s\S]*data-role="Manager"[\s\S]*sm-chip bad">model claude-sonnet-5-5, chosen claude-opus-5-5/);
  assert.match(html, /data-agent="Manager"/, "the same Crew view still has its tiles");
  assert.doesNotMatch(crew(null), /data-roles/);
});

test("the page draws one chip per role, says when the reading is over 36 h old, and draws nothing with no reading or no role", () => {
  const html = page({ at: T - 10 * H, roles: [role(OPUS, SON, "medium", "medium"), { ...role(OPUS, OPUS, null, null), role: "Release" }] }).roleSessionsHtml(T);
  assert.match(html, /data-role="Manager"[\s\S]*sm-chip bad">model claude-sonnet-5-5, chosen claude-opus-5-5/);
  assert.match(html, /data-role="Release"[\s\S]*sm-chip ok">✓ /);
  assert.doesNotMatch(html, /session reading old/);
  assert.match(page({ at: T - 37 * H, roles: [role(OPUS, OPUS, null, null)] }).roleSessionsHtml(T), /session reading old/);
  assert.equal(page(null).roleSessionsHtml(T), "");
  assert.equal(page({ at: T, roles: [] }).roleSessionsHtml(T), "");
  const evil = page({ at: T, roles: [{ role: "<img>", chosen: "<b>", ran: "<i>", chosenEffort: null, ranEffort: null, at: T }] }).roleSessionsHtml(T);
  assert.match(evil, /class="sm-id">&lt;img&gt;<\/span>/);
  assert.doesNotMatch(evil, /<img>|<i>|<b>/, "no raw tag from a word reaches the page");
});
