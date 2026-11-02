// The probe's own readings (#C592 keeper, #C593 watchdog, #C595 usage): context from the transcript's usage fields, the
// reset asked once per crossing, stuck roles, the daily usage tile; all numbers, times and enums through the state's
// allowlist, and the lead's wake watch printing a CONTEXT RESET line once per ask.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contextTokens, ctxReadings, resetAsks, stuckReadings, usageReading, STEP_MS, USER_MS, WEEK_MS } from "../collector/readings.mjs";
import { createHash } from "node:crypto";
import { checkConfig } from "../scripts/config.mjs";
import { usageTile, nextReset, scriptMatches, buildState } from "../collector/state.mjs";
import { stateErrors, pickState } from "../collector/state-schema.mjs";
import { resetPending, resetSeen, resetLine } from "../gate/reset.mjs";
import { tick } from "../scripts/wake-watch.mjs";
import { changeKey } from "../worker/state-worker.mjs";
import { loadNames } from "./harness.mjs";

const T = 1_800_000_000_000;
const asst = (usage) => ({ type: "assistant", message: { usage, content: [] } });

test("a role's context is its last assistant entry's input, cache read and cache creation tokens", () => {
  assert.equal(contextTokens([asst({ input_tokens: 5, cache_read_input_tokens: 90, cache_creation_input_tokens: 5 }), { type: "user", message: {} }]), 100);
  assert.equal(contextTokens([asst({ input_tokens: 1 }), asst({ input_tokens: 7, cache_read_input_tokens: 3 })]), 10, "the newest");
  assert.equal(contextTokens([{ type: "user", message: {} }]), null);
  assert.equal(contextTokens([asst({ input_tokens: -4, cache_read_input_tokens: "x" })]), null, "odd numbers count for nothing");
});

test("ctx: percent of the window, over at resetAt; an odd role or count is dropped", () => {
  const c = ctxReadings({ tokens: { Builder: 400000, Checker: 100000, "bad role": 5, Odd: 1.5 }, resetAt: 400000, now: T });
  assert.deepEqual(c, { Builder: { pct: 40, tokens: 400000, at: T, over: true }, Checker: { pct: 10, tokens: 100000, at: T, over: false } });
});

test("a reset is asked once per crossing, and again only after the role came back under", () => {
  const over = { Builder: { over: true }, Checker: { over: false } };
  const first = resetAsks(over, null, T);
  assert.deepEqual(first, { roles: { Builder: T }, fresh: ["Builder"] });
  const again = resetAsks(over, { roles: first.roles }, T + 60e3);
  assert.deepEqual(again, { roles: { Builder: T }, fresh: [] }, "no second ask while it stays over");
  const back = resetAsks({ Builder: { over: false } }, { roles: first.roles }, T + 120e3);
  assert.deepEqual(back, { roles: {}, fresh: [] }, "under: forgotten");
  assert.deepEqual(resetAsks(over, { roles: { Builder: T + 9e9 } }, T).fresh, ["Builder"], "a time in the future is no ask");
  assert.deepEqual(resetAsks(over, { roles: [1] }, T).fresh, ["Builder"], "an odd file is none");
});

test("stuck: over 45 min on one working step, or over 15 min on a call the owner must answer; the lead never on a step", () => {
  const agents = {
    AA: { state: "working", since: T - STEP_MS - 1, card: "a-card" },
    BB: { state: "working", since: T - STEP_MS + 60e3, card: null },
    CC: { state: "idle", since: T - 9e9, card: null },
    Manager: { state: "working", since: T - 9e9, card: null },
    DD: { state: "working", since: T - 60e3, card: "d-card" },
  };
  const prompts = { DD: T - USER_MS - 1, BB: T - USER_MS + 1000 };
  assert.deepEqual(stuckReadings({ agents, prompts, now: T, lead: "Manager" }), {
    AA: { kind: "step", card: "a-card", since: T - STEP_MS - 1 },
    DD: { kind: "user", card: "d-card", since: T - USER_MS - 1 },
  });
});

test("usage: top five as shares by role, scheduled and other; pace from the plan's week; amber at 1.3x, red at 1.6x", () => {
  const rows = [
    { source: "(untitled)", share: 0.28 }, { source: "scheduled: context keeper", share: 0.19 }, { source: "scheduled: Collector", share: 0.11 },
    { source: "Manager", share: 0.09 }, { source: "Security", share: 0.04 }, { source: "Ops", share: 0.03 }, { source: "Nobody", share: 0.2 },
  ];
  const roster = ["Manager", "Security", "Ops"];
  const half = { weekPct: 65, resetsAt: T + WEEK_MS / 2 };
  const u = usageReading({ rows, roster, plan: half, now: T });
  assert.deepEqual(u.top, [{ src: "other", pct: 48 }, { src: "scheduled", pct: 30 }, { src: "Manager", pct: 9 }, { src: "Security", pct: 4 }, { src: "Ops", pct: 3 }]);
  assert.equal(u.pace, 130);
  assert.equal(u.level, "amber");
  assert.equal(usageReading({ rows, roster, plan: { weekPct: 80, resetsAt: T + WEEK_MS / 2 }, now: T }).level, "red");
  assert.equal(usageReading({ rows, roster, plan: { weekPct: 50, resetsAt: T + WEEK_MS / 2 }, now: T }).level, "ok");
  const none = usageReading({ rows, roster, plan: null, now: T });
  assert.deepEqual([none.weekPct, none.pace, none.level], [null, null, "ok"], "no plan reading: no pace, no colour");
  assert.equal(usageReading({ rows: "x", roster, plan: null, now: T }).top.length, 0);
});

test("the usage script runs once a day, keeps its rows, and a failing script leaves the last tile", () => {
  const dir = mkdtempSync(join(tmpdir(), "usage-"));
  const calls = [];
  const run = (args) => { calls.push(args); return JSON.stringify({ rows: [{ source: "Manager", share: 0.5 }, { source: "scheduled: x", share: 0.5 }] }); };
  const a = usageTile({ script: "/s/spend.py", scriptOk: true, dir, roster: ["Manager"], now: T, run });
  assert.ok(a.save && a.save.ranAt);
  assert.deepEqual(calls[0].slice(0, 3), ["-I", "/s/spend.py", "--json"]);
  writeFileSync(join(dir, "usage.json"), JSON.stringify({ ranAt: T, rows: a.rows }));
  const b = usageTile({ script: "/s/spend.py", scriptOk: true, dir, roster: ["Manager"], now: T + 3600e3, run });
  assert.equal(b.save, null);
  assert.equal(calls.length, 1, "not again within a day");
  // A failing script is tried again after an hour, then two, to a day: not every minute (Checker).
  const bad = []; const fail = () => { bad.push(1); throw new Error("no"); };
  const at = T + 25 * 3600e3, kept = { ranAt: T, rows: a.rows, total: null, resetsAt: null };
  writeFileSync(join(dir, "usage.json"), JSON.stringify(kept));
  const c = usageTile({ script: "/s/spend.py", scriptOk: true, dir, roster: ["Manager"], now: at, run: fail });
  assert.equal(bad.length, 1);
  assert.equal(c.tile.top[0].pct, 50, "the last rows stand");
  assert.deepEqual([c.save.failUntil, c.save.wait], [at + 3600e3, 7200e3]);
  writeFileSync(join(dir, "usage.json"), JSON.stringify(c.save));
  for (let m = 1; m < 60; m++) usageTile({ script: "/s/spend.py", scriptOk: true, dir, roster: ["Manager"], now: at + m * 60e3, run: fail });
  assert.equal(bad.length, 1, "59 more minutes: not one more try");
  const d = usageTile({ script: "/s/spend.py", scriptOk: true, dir, roster: ["Manager"], now: at + 3600e3, run: fail });
  assert.equal(bad.length, 2, "an hour on: tried again");
  assert.deepEqual([d.save.failUntil, d.save.wait], [at + 3600e3 + 7200e3, 4 * 3600e3], "and the wait doubles");
  // A script that isn't the pinned one is never run.
  const unpinned = usageTile({ script: "/s/spend.py", scriptOk: false, dir: mkdtempSync(join(tmpdir(), "usage-")), roster: ["Manager"], now: T, run });
  assert.equal(unpinned.tile, null);
  assert.equal(calls.length, 1, "run was never called for it");
  assert.equal(usageTile({ script: "", dir: mkdtempSync(join(tmpdir(), "usage-")), roster: [], now: T, run }).tile, null, "no script, no tile");
});

test("the pinned script: its sha256 is the config's, or it is not run; a script needs its pin in the config", () => {
  const dir = mkdtempSync(join(tmpdir(), "usage-"));
  const file = join(dir, "spend.py");
  writeFileSync(file, "print('x')\n");
  const sha = createHash("sha256").update("print('x')\n").digest("hex");
  assert.equal(scriptMatches(file, sha), true);
  assert.equal(scriptMatches(file, "0".repeat(64)), false, "another file's hash");
  assert.equal(scriptMatches(file, ""), false, "no pin, no run");
  assert.equal(scriptMatches("", sha), false);
  assert.equal(scriptMatches(join(dir, "missing.py"), sha), false);
  const bad = (k) => checkConfig({ collector: k });
  assert.match(bad({ usageScript: "/s/spend.py" }).join(), /needs collector\.usageScriptSha256/);
  assert.deepEqual(bad({ usageScript: "/s/spend.py", usageScriptSha256: sha }), []);
  assert.match(bad({ usageScriptSha256: "abc" }).join(), /64 hex digits/);
});

test("the probe never cues the lead to reset", () => {
  const ctx = ctxReadings({ tokens: { Manager: 900000, Builder: 900000 }, resetAt: 400000, now: T });
  const noLead = Object.fromEntries(Object.entries(ctx).filter(([role]) => role !== "Manager"));
  assert.deepEqual(resetAsks(noLead, null, T).fresh, ["Builder"]);
  assert.match(readFileSync(new URL("../collector/state.mjs", import.meta.url), "utf8"), /resetAsks\(Object\.fromEntries\(Object\.entries\(ctx\)\.filter\(\(\[role\]\) => role !== config\.gate\.managerRole\)\)/, "state.mjs filters the lead out");
});

test("the week is the config's: the script is asked from the last reset, week % and pace come from quota and reset, a new week runs again", () => {
  const dir = mkdtempSync(join(tmpdir(), "usage-"));
  const calls = [];
  const run = (args) => { calls.push(args); return JSON.stringify({ total_weighted: 650, rows: [{ source: "Manager", share: 1 }] }); };
  const reset = "2027-01-15T17:00Z";
  const nextAt = Date.parse(reset) + 7 * 24 * 3600e3;
  const now = nextAt - 3.5 * 24 * 3600e3;
  assert.equal(nextReset(reset, now), nextAt, "any one reset anchors every week");
  assert.equal(nextReset(reset, Date.parse(reset) - 1), Date.parse(reset));
  assert.equal(nextReset("", now), null);
  const a = usageTile({ script: "/s/spend.py", scriptOk: true, dir, roster: ["Manager"], now, run, quota: 1000, resetAt: reset });
  assert.equal(calls[0][4], new Date(nextAt - WEEK_MS).toISOString().slice(0, 16), "since the last reset");
  assert.deepEqual([a.tile.weekPct, a.tile.pace, a.tile.level], [65, 130, "amber"], "65% used at half the week: 1.3x");
  writeFileSync(join(dir, "usage.json"), JSON.stringify({ ranAt: now, rows: a.rows, total: a.total, resetsAt: a.resetsAt }));
  assert.equal(usageTile({ script: "/s/spend.py", scriptOk: true, dir, roster: ["Manager"], now: now + 3600e3, run, quota: 1000, resetAt: reset }).save, null);
  assert.equal(calls.length, 1);
  const rolled = usageTile({ script: "/s/spend.py", scriptOk: true, dir, roster: ["Manager"], now: nextAt + 3600e3, run, quota: 1000, resetAt: reset });
  assert.ok(rolled.save && rolled.save.ranAt, "the week turned: run again at once");
  assert.equal(usageTile({ script: "/s/spend.py", scriptOk: true, dir: mkdtempSync(join(tmpdir(), "usage-")), roster: ["Manager"], now, run, quota: 0, resetAt: reset }).tile.weekPct, null, "no quota, no percent");
});

test("the state carries ctx, stuck and usage only as the schema allows", () => {
  const base = { id: "b", now: T, probe: null, pageVersion: null, cards: {}, agents: {} };
  const s = buildState({ ...base, ctx: { Builder: { pct: 40, tokens: 400000, at: T, over: true } }, stuck: { AA: { kind: "user", card: null, since: T } }, usage: { at: T, weekPct: 50, pace: 130, level: "amber", top: [{ src: "other", pct: 48 }] } });
  assert.deepEqual(Object.keys(s).sort(), ["agents", "board", "cards", "ctx", "stuck", "usage", "v"]);
  assert.deepEqual(Object.keys(buildState(base)).sort(), ["agents", "board", "cards", "v"], "a probe without them still fits");
  const bad = (patch) => stateErrors({ ...structuredClone(s), ...patch });
  assert.ok(bad({ ctx: { Builder: { pct: 400, tokens: 1, at: T, over: true } } }).length);
  assert.ok(bad({ ctx: { "a b": { pct: 1, tokens: 1, at: T, over: true } } }).length);
  assert.ok(bad({ stuck: { AA: { kind: "because the build is slow", card: null, since: T } } }).length, "no free text in a kind");
  assert.ok(bad({ usage: { ...s.usage, level: "purple" } }).length);
  assert.ok(bad({ usage: { ...s.usage, top: [{ src: "Manager says hi", pct: 1 }] } }).length, "a source is a word");
  assert.ok(bad({ usage: { ...s.usage, top: Array.from({ length: 6 }, () => ({ src: "other", pct: 1 })) } }).length || pickState({ ...s, usage: { ...s.usage, top: Array.from({ length: 6 }, () => ({ src: "other", pct: 1 })) } }) === null);
  assert.ok(bad({ extra: 1 }).length);
  assert.equal(pickState({ ...s, ctx: { Builder: { ...s.ctx.Builder, note: "hi" } } }), null, "an extra key in a record is refused");
});

test("the Worker's change key moves for a reset, a stuck role or the usage colour, not for a one-point context drift", () => {
  const s = (patch) => pickState({ ...buildState({ id: "b", now: T, probe: null, pageVersion: null, cards: {}, agents: {} }), ...patch });
  const ctx = (pct, over) => ({ ctx: { Builder: { pct, tokens: pct * 1e4, at: T, over } } });
  assert.equal(changeKey(s(ctx(41, false))), changeKey(s(ctx(43, false))));
  assert.notEqual(changeKey(s(ctx(41, false))), changeKey(s(ctx(41, true))));
  assert.notEqual(changeKey(s({})), changeKey(s({ stuck: { AA: { kind: "step", card: null, since: T } } })));
  const u = (level) => ({ usage: { at: T, weekPct: 1, pace: 100, level, top: [] } });
  assert.notEqual(changeKey(s(u("ok"))), changeKey(s(u("red"))));
});

test("CONTEXT RESET: the lead's wake watch prints one line per role asked, once, with the wake line first", () => {
  const dir = mkdtempSync(join(tmpdir(), "reset-"));
  assert.equal(tick(dir, T), null);
  writeFileSync(join(dir, "context-reset.json"), JSON.stringify({ at: T, roles: { Builder: T, Checker: T, "bad role": T } }));
  assert.equal(tick(dir, T + 1000), `${resetLine("Builder")}\n${resetLine("Checker")}`);
  assert.equal(tick(dir, T + 2000), null, "printed once");
  writeFileSync(join(dir, "context-reset.json"), JSON.stringify({ at: T, roles: { Builder: T + 5 } }));
  assert.equal(tick(dir, T + 3000), resetLine("Builder"), "a new crossing asks again");
  assert.deepEqual(resetPending({ roles: { A1: 5 } }, resetSeen({ roles: { A1: 5 } }, null, ["A1"])), []);
  assert.match(readFileSync(join(dir, "reset-seen.json"), "utf8"), /Builder/);
  assert.match(resetLine("Builder"), /^CONTEXT RESET Builder/);
});

const page = (probe) => {
  const b = loadNames(["liveCtx", "liveStuck", "liveUsage", "liveStuckLines", "planTile", "ctxAgents", "set:(p)=>{probe=p}"]);
  b.set(probe);
  return b;
};
const NOW = Date.now();
const live = (extra) => ({ v: 1, board: { at: NOW }, cards: {}, agents: {}, ...extra });
const json = (v) => JSON.parse(JSON.stringify(v));

test("the page: a fresh probe's context replaces an older tile and keeps its saved flag; an odd or stale one is ignored", () => {
  const b = page(live({ ctx: { Builder: { pct: 41, tokens: 410000, at: NOW }, "bad role": { pct: 1, tokens: 1, at: NOW }, Odd: { pct: 400, tokens: 1, at: NOW } } }));
  b.state.meta = [{ id: "context", at: NOW - 3600e3, agents: { Builder: { pct: 10, tokens: 100000, at: NOW - 3600e3, saved: true } } }];
  b.state.ctx = [];
  assert.deepEqual(json(b.liveCtx(NOW)), { Builder: { pct: 41, tokens: 410000, at: NOW } });
  assert.deepEqual(json(b.ctxAgents(NOW).Builder), { pct: 41, tokens: 410000, at: NOW, saved: true });
  b.set({ ...live({ ctx: { Builder: { pct: 41, tokens: 410000, at: NOW } } }), board: { at: NOW - 10 * 60e3 } });
  assert.deepEqual(json(b.liveCtx(NOW)), {}, "no fresh state, no live context");
});

test("the page: stuck roles show as lines, red for the owner's; the usage tile takes its colour from the level", () => {
  const b = page(live({ stuck: { Builder: { kind: "step", card: "a-card", since: NOW - 3600e3 }, Checker: { kind: "user", card: null, since: NOW - 1800e3 }, Bad: { kind: "free text", card: null, since: NOW } } }));
  const lines = json(b.liveStuckLines(NOW));
  assert.equal(lines.length, 2);
  assert.deepEqual(lines.map((l) => l.you), [false, true], "oldest first; waiting on the owner is a You line");
  assert.match(lines[0].text, /^Builder has been on one step since .* \(a-card\)\.$/);
  assert.match(lines[1].text, /^Checker has been waiting on you since /);
  const u = page(live({ usage: { at: NOW, weekPct: 70, pace: 160, level: "red", top: [{ src: "Manager", pct: 9 }, { src: "bad src!", pct: 1 }] } }));
  const html = u.planTile();
  assert.match(html, /class="tot plan red"/);
  assert.match(html, /70%/);
  assert.match(html, /1\.6x pace/);
  assert.match(html, /Manager 9%/);
  assert.doesNotMatch(html, /bad src/);
  assert.equal(page(live({})).planTile(), "", "no reading, no tile");
  assert.match(page(live({ usage: { at: NOW, weekPct: null, pace: null, level: "ok", top: [] } })).planTile(), /no plan reading/);
});
