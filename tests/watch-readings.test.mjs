// #C1005 part c: the watchdog task's restart and prompt-ledger steps as probe readings (no script of another repository). Pure rules, the schema, and the stall
// rows Manager's batch gets (told once each).
import test from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import { restartReading, ledgerReading, watchReading, QUIET_MS } from "../collector/watch-readings.mjs";
import { stateErrors, pickState } from "../collector/state-schema.mjs";
import { buildState } from "../collector/state.mjs";
import { watchWakes, RESTART_LINE } from "../worker/push-rules.mjs";
import { wakeAsk, takeInbox } from "../worker/board-store.mjs";
import { checkConfig } from "../scripts/config.mjs";

const T = Date.UTC(2026, 10, 12, 19, 0), DAY = 864e5;
const line = (o) => JSON.stringify({ at: new Date(T - 60e3).toISOString(), ...o });

test("restart: the sessions the probe knew are all gone and some run; the first run, no one running and a partial change are none", () => {
  assert.deepEqual(restartReading({ ids: ["a", "b"], before: {} }), { restart: false, ids: ["a", "b"] }, "first run");
  assert.equal(restartReading({ ids: ["x", "y"], before: { ids: ["a", "b"] } }).restart, true);
  assert.deepEqual(restartReading({ ids: ["x", "y"], before: { ids: ["a", "b"] } }).ids, ["x", "y"], "the new ones are kept");
  assert.equal(restartReading({ ids: ["a", "y"], before: { ids: ["a", "b"] } }).restart, false, "one of them is still there");
  const none = restartReading({ ids: [], before: { ids: ["a", "b"] } });
  assert.deepEqual(none, { restart: false, ids: ["a", "b"] }, "nobody running: no restart yet, and the old ids are kept");
  assert.equal(restartReading({ ids: ["x"], before: none }).restart, true, "a return after a gap reads against them");
  assert.equal(restartReading({ ids: [1, null, ""], before: { ids: ["a"] } }).restart, false, "odd ids are no ids");
});

test("ledger: the first run takes the length only; later runs count prompts by role and tool, other notifications apart, idle_prompt not at all", () => {
  const first = ledgerReading({ lines: [line({ who: "Builder", tool: "Bash" })], before: undefined, now: T, running: 0 });
  assert.equal(first.seen, 1); assert.equal(first.ledger, undefined, "history is not new");
  const lines = [line({ who: "Builder", tool: "Bash" }), line({ who: "Builder", tool: "Bash", command: "echo SECRET-VALUE" }), line({ who: "Builder", tool: "Bash" }), line({ who: "Checker", tool: "Write" }), line({ kind: "other", type: "idle_prompt" }), line({ kind: "other", type: "permission_x", message: "SECRET-MESSAGE" }), "not json", line({ who: "bad role!", tool: "a b" })];
  const r = ledgerReading({ lines, before: { seen: 0 }, now: T, running: 0 });
  assert.deepEqual(r.ledger, { prompts: [{ role: "Builder", tool: "Bash", n: 3 }, { role: "Unknown", tool: "other", n: 1 }, { role: "Checker", tool: "Write", n: 1 }], others: 1 });
  assert.equal(r.seen, lines.length);
  assert.doesNotMatch(JSON.stringify(r), /SECRET/, "no command and no message leaves");
  assert.equal(ledgerReading({ lines, before: { seen: lines.length }, now: T, running: 0 }).ledger, undefined, "nothing new");
  assert.equal(ledgerReading({ lines: lines.slice(0, 2), before: { seen: 7 }, now: T, running: 0 }).ledger.prompts[0].n, 2, "a ledger started again: all of it is new");
});

test("ledger silent: 24 h with no line while agents work, told once per newest line; none running, or a fresh line, is no silence", () => {
  const old = new Date(T - QUIET_MS).toISOString(), recent = new Date(T - QUIET_MS + 60e3).toISOString();
  const quiet = ledgerReading({ lines: [JSON.stringify({ who: "Builder", tool: "Bash", at: old })], before: { seen: 1 }, now: T, running: 3 });
  assert.deepEqual(quiet.silence, { since: T - QUIET_MS, days: 1, running: 3 });
  assert.equal(quiet.quiet, old);
  assert.equal(ledgerReading({ lines: [JSON.stringify({ who: "Builder", tool: "Bash", at: old })], before: { seen: 1, quiet: old }, now: T, running: 3 }).silence, undefined, "told once");
  assert.equal(ledgerReading({ lines: [JSON.stringify({ who: "Builder", tool: "Bash", at: recent })], before: { seen: 1 }, now: T, running: 3 }).silence, undefined, "23h59");
  assert.equal(ledgerReading({ lines: [JSON.stringify({ at: old })], before: { seen: 1 }, now: T, running: 0 }).silence, undefined, "no agent working");
  const empty = ledgerReading({ lines: [], before: { seen: 0 }, now: T, running: 2 });
  assert.deepEqual(empty.silence, { since: null, days: null, running: 2 }); assert.equal(empty.quiet, "none");
});

test("watchReading: nothing to say is null; the restart, the ledger and the silence ride one reading", () => {
  assert.equal(watchReading({ now: T, restart: false, ledger: { seen: 3, quiet: null } }), null);
  const w = watchReading({ now: T, restart: true, ledger: { ledger: { prompts: [], others: 2 }, silence: { since: null, days: null, running: 1 } } });
  assert.deepEqual(w, { at: T, restart: true, ledger: { prompts: [], others: 2 }, quiet: { since: null, days: null, running: 1 } });
});

const base = { id: "flight-board", now: T, probe: "probe.mjs", pageVersion: null, cards: {}, agents: {} };
test("the schema: a good watch fits and is copied field by field; a bad one is refused, and buildState drops it instead of failing the state", () => {
  const good = { at: T, restart: true, ledger: { prompts: [{ role: "Builder", tool: "Bash", n: 2 }], others: 0 }, quiet: { since: T - 2 * DAY, days: 2, running: 3 } };
  const s = buildState({ ...base, watch: good });
  assert.deepEqual(s.watch, good);
  assert.deepEqual(stateErrors(s), []);
  for (const bad of [{ at: T, extra: 1 }, { restart: true }, { at: T, restart: false }, { at: T, ledger: { prompts: [{ role: "Builder", tool: "has space", n: 1 }], others: 0 } }, { at: T, ledger: { prompts: Array.from({ length: 13 }, () => ({ role: "Builder", tool: "Bash", n: 1 })), others: 0 } }, { at: T, ledger: { prompts: [{ role: "Builder", tool: "Bash", n: 1, command: "x" }], others: 0 } }, { at: T, quiet: { since: "x", days: 1, running: 1 } }]) {
    assert.ok(stateErrors({ ...s, watch: bad }).length, JSON.stringify(bad));
    assert.equal(buildState({ ...base, watch: bad }).watch, undefined, "dropped, the state still builds");
  }
  assert.equal(pickState({ ...s, extra: 1 }), null);
});

test("config: collector.promptLedger is an absolute .jsonl path or empty", () => {
  const cfg = (promptLedger) => ({ owner: "Sam", collector: { repoPath: "/x", notes: { checker: "refs/notes/checker", security: "refs/notes/security" }, deployWorkflow: "CI", promptLedger } });
  assert.ok(!checkConfig(cfg("/Users/x/ledger/prompts.jsonl")).some((p) => /promptLedger/.test(p)));
  assert.ok(!checkConfig(cfg("")).some((p) => /promptLedger/.test(p)));
  for (const bad of ["prompts.jsonl", "/a/../b.jsonl", "/a/b.txt", 5, "/a/./b.jsonl"]) assert.ok(checkConfig(cfg(bad)).some((p) => /collector\.promptLedger/.test(p)), String(bad));
});

test("the stall rows: one per event, keyed by the reading, with roles and counts only", () => {
  const w = watchWakes({ watch: { at: T, restart: true, ledger: { prompts: [{ role: "Builder", tool: "Bash", n: 3 }], others: 2 }, quiet: { since: T - 2 * DAY, days: 2, running: 3 } } });
  assert.deepEqual(w.map((x) => x.card_id), [`watch:restart:${T}`, `watch:ledger:${T}`, `watch:quiet:${T - 2 * DAY}`]);
  assert.equal(w[0].reason, RESTART_LINE);
  assert.equal(w[1].reason, "Permission prompts since the last check: Builder Bash x3 | 2 other notifications");
  assert.match(w[2].reason, /^Prompt ledger silent: no line since .* MT \(2 days\) while 3 agent session\(s\) ran\./);
  assert.match(watchWakes({ watch: { at: T, quiet: { since: null, days: null, running: 1 } } })[0].reason, /no line at all while 1 agent/);
  for (const bad of [null, [], { at: "x", restart: true }, { at: T }, { at: T, restart: "yes" }, { at: T, restart: 1 }, { at: T, ledger: { prompts: [{ role: "x y", tool: "Bash", n: 1 }], others: 0 } }]) assert.deepEqual(watchWakes({ watch: bad }), [], JSON.stringify(bad));
});

test("Manager's batch: each watch line once, from a fresh reading only", async () => {
  const MIN = 60e3, db = makeDb();
  const put = (key, value, at) => db.prepare("INSERT OR REPLACE INTO evidence (key, value, read_at) VALUES (?, ?, ?)").bind(key, JSON.stringify(value), at).run();
  await put("board", { boardId: "flight-board", at: T }, T);
  await put("watch", { at: T, restart: true, ledger: { prompts: [{ role: "Builder", tool: "Bash", n: 1 }], others: 0 } }, T);
  await wakeAsk(db, T);
  const mine = (inbox) => inbox.stalls.filter((s) => /app restarted|Permission prompts since/.test(s.reason ?? ""));
  assert.equal(mine(await takeInbox(db, T + MIN)).length, 2);
  await put("watch", { at: T, restart: true, ledger: { prompts: [{ role: "Builder", tool: "Bash", n: 1 }], others: 0 } }, T + 2 * MIN);
  await wakeAsk(db, T + 2 * MIN);
  assert.equal(mine(await takeInbox(db, T + 3 * MIN)).length, 0, "told once");
  const stale = makeDb();
  await stale.prepare("INSERT INTO evidence (key, value, read_at) VALUES ('watch', ?, ?)").bind(JSON.stringify({ at: T, restart: true }), T - 20 * MIN).run();
  await wakeAsk(stale, T);
  assert.equal(mine(await takeInbox(stale, T + MIN)).length, 0, "a stale reading makes none");
});
