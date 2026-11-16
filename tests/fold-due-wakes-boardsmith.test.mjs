// #C1090: while the landing job's fresh report says 5 or more DATA fragments wait on main, the dispatch wakes Boardsmith once a day to cut the fold card (Manager: "so it
// wakes you rather than sitting in a log nobody reads"). As the daily check (#C1007): a card of its own, `fold-due-<MT day>`, state `fold` in dispatch-state.json.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchRun, foldDueCheck, foldDueId, landingFrom, LAND_REPORT_FILE } from "../collector/store-dispatch.mjs";
import { dispatchLine, DISPATCH_STATE_FILE } from "../gate/reset.mjs";

const MIN = 60e3, HOUR = 60 * MIN;
const AT = Date.UTC(2026, 10, 16, 20, 0); // 1 pm MT on 2026-11-16
const ROSTER = ["Manager", "Builder", "Boardsmith", "Ops"], LEAD = "Manager";
const scratch = [];
const dir = () => { const d = mkdtempSync(join(tmpdir(), "c1090-")); scratch.push(d); return d; };
test.after(() => { for (const d of scratch) rmSync(d, { recursive: true, force: true }); });
const read = (d, f) => JSON.parse(readFileSync(join(d, f), "utf8"));
const idle = (at, ago = 20 * MIN) => ({ state: "idle", since: at - ago, lastActivityAt: at - ago, card: null });
const view = (at, bs = idle(at)) => ({
  cards: [], asks: [], live: { state: "live", version: "v1.209.13", age: 1000 },
  evidence: { agents: { readAt: at - 10_000, value: { Boardsmith: bs, Manager: idle(at, MIN), Builder: idle(at), Ops: idle(at) } } },
});
const report = (d, at, over = {}) => writeFileSync(join(d, LAND_REPORT_FILE), JSON.stringify({ at, landed: [], refused: [], waiting: [], dataFragments: 6, foldDue: true, ...over }));
const run = (d, at, bs) => dispatchRun(view(at, bs), { dir: d, roster: ROSTER, lead: LEAD, now: at });
const mine = (r) => r.items.filter((i) => i.role === "Boardsmith");

test("landingFrom: foldDue only from a fresh report that says so with a count; a stale or odd one says nothing", () => {
  const r = (o) => landingFrom({ at: AT, landed: [], refused: [], waiting: [], ...o }, AT + MIN);
  assert.equal(r({ dataFragments: 6, foldDue: true }).foldDue, true);
  assert.equal(r({ dataFragments: 4, foldDue: false }).foldDue, false);
  assert.equal(r({ foldDue: true }).foldDue, false, "no count");
  assert.equal(r({ dataFragments: "6", foldDue: true }).foldDue, false, "a count that is no number");
  assert.equal(r({ dataFragments: 6, foldDue: "yes" }).foldDue, false, "foldDue is exactly true");
  assert.equal(landingFrom({ at: AT - 26 * MIN, dataFragments: 6, foldDue: true }, AT).foldDue, false, "a stale report");
  assert.equal(landingFrom(null, AT).foldDue, false);
  assert.equal(foldDueId("2026-11-16"), "fold-due-2026-11-16");
  for (const bad of [null, "", "2026-1-3", "x; rm", 5]) assert.equal(foldDueId(bad), null, String(bad));
});

test("a fresh FOLD DUE report wakes an idle Boardsmith once, with a line that says what to cut; nobody else", () => {
  const d = dir();
  report(d, AT - MIN);
  const r = run(d, AT);
  assert.equal(mine(r).length, 1);
  assert.equal(mine(r)[0].card, "fold-due-2026-11-16");
  assert.deepEqual(r.items.filter((i) => i.role !== "Boardsmith" && i.role !== "Ops"), [], "nobody else (Ops's own daily check is a different card)");
  const line = dispatchLine(mine(r)[0]);
  assert.match(line, /^DISPATCH fold-due-2026-11-16 at live: it FOLD DUE: 5 or more DATA fragments wait in docs\/DATA\.d on main; cut the fold card \(a Board-Id starting fold-data-fragments/);
  assert.match(line, /\(Boardsmith's turn;/);
  assert.equal(read(d, DISPATCH_STATE_FILE).fold.wokenAt, AT);
  // Still idle a minute later: the same item, the same since.
  const r2 = run(d, AT + MIN);
  assert.equal(mine(r2).length, 1);
  assert.equal(mine(r2)[0].since, mine(r)[0].since);
});

test("no report, a stale one, or one under the threshold wakes nobody", () => {
  const none = dir();
  assert.deepEqual(mine(run(none, AT)), []);
  const stale = dir();
  report(stale, AT - 26 * MIN);
  assert.deepEqual(mine(run(stale, AT)), []);
  const under = dir();
  report(under, AT - MIN, { dataFragments: 4, foldDue: false });
  assert.deepEqual(mine(run(under, AT)), []);
  assert.equal(read(under, DISPATCH_STATE_FILE).fold, undefined);
});

test("once Boardsmith has worked after the wake the day is done; the next day it wakes again while the fold is still due", () => {
  const d = dir();
  report(d, AT - MIN);
  assert.equal(mine(run(d, AT)).length, 1);
  assert.deepEqual(mine(run(d, AT + 3 * MIN, { state: "working", since: AT + 2 * MIN, lastActivityAt: AT + 2 * MIN, card: null })), []);
  report(d, AT + 5 * HOUR - MIN);
  assert.deepEqual(mine(run(d, AT + 5 * HOUR, idle(AT + 5 * HOUR, 4 * HOUR))), [], "done for the day");
  assert.equal(read(d, DISPATCH_STATE_FILE).fold.done, true);
  const next = AT + 24 * HOUR;
  report(d, next - MIN);
  const r = run(d, next, idle(next));
  assert.equal(mine(r).length, 1);
  assert.equal(mine(r)[0].card, "fold-due-2026-11-17");
});

test("when the report stops saying foldDue the state is dropped, so the next time it falls due it wakes again the same day", () => {
  const d = dir();
  report(d, AT - MIN);
  assert.equal(mine(run(d, AT)).length, 1);
  assert.deepEqual(mine(run(d, AT + 3 * MIN, { state: "working", since: AT + 2 * MIN, lastActivityAt: AT + 2 * MIN, card: null })), []);
  report(d, AT + 10 * MIN, { dataFragments: 0, foldDue: false });
  assert.deepEqual(mine(run(d, AT + 11 * MIN, idle(AT + 11 * MIN, 8 * MIN))), []);
  assert.equal(read(d, DISPATCH_STATE_FILE).fold, undefined);
  report(d, AT + 2 * HOUR);
  assert.equal(mine(run(d, AT + 2 * HOUR + MIN, idle(AT + 2 * HOUR + MIN, 30 * MIN))).length, 1, "due again: woken again");
});

test("foldDueCheck: nothing without a landing that says foldDue; a busy Boardsmith is woken when it goes idle", () => {
  assert.deepEqual(foldDueCheck(null, null, {}, AT), { card: null, fold: null });
  assert.deepEqual(foldDueCheck({ foldDue: false }, null, {}, AT), { card: null, fold: null });
  const busy = foldDueCheck({ foldDue: true }, null, { Boardsmith: { state: "working", since: AT - MIN, lastActivityAt: AT - MIN } }, AT);
  assert.equal(busy.card.turns[0].step, "folddue");
  assert.equal(busy.fold.done, false);
});
