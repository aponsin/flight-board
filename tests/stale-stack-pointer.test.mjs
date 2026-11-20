// #C1327 (Demos, 11-20: with no open stack head the watch told #C1326 to re-cut on build/ship-v1.215.7, a branch not on origin, 11 versions behind main): a stack
// branch is named only when an OPEN card still in the stack carries it. A live card's, a closed card's and an outside card's own leftover evidence name nothing.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchRun } from "../collector/store-dispatch.mjs";
import { dispatchLine } from "../gate/reset.mjs";

const NOW = 1_800_000_000_000, MIN = 60e3;
const ROSTER = ["Manager", "Boardsmith", "Checker", "Security", "Release"], LEAD = "Manager";
const TIP = "abcdef012345", STALE = "build/ship-v1.215.7";
const idle = { state: "idle", lastActivityAt: NOW - 2 * MIN, since: NOW - 2 * MIN };
const card = (id, extra = {}) => ({ id, num: Number(id.replace(/\D/g, "")) || null, owner_role: "Boardsmith", review_level: "Quick", waiting_on: null, paused: 0, dropped: 0, repo: "", ...extra });
const world = ({ cards, ev }) => ({
  cards, asks: [], stackSwitch: [{ repo: "board", stack: true, set_by: "default", set_at: 0 }, { repo: "product", stack: false, set_by: "default", set_at: 0 }],
  evidence: { agents: { readAt: NOW - 5_000, value: Object.fromEntries(ROSTER.map((r) => [r, idle])) }, ...Object.fromEntries(Object.entries(ev).map(([id, v]) => [`cards.${id}`, { readAt: NOW - 5_000, value: v }])) },
});
const items = (v) => dispatchRun(v, { dir: mkdtempSync(join(tmpdir(), "sd-")), roster: ROSTER, lead: LEAD, now: NOW }).items;
const live = { lit: ["live"], phase: "live", headSha12: "111111111111", signed: [], onMain: true, stack: { tip: TIP, size: 2, branch: STALE } };
const outside = { lit: ["checker"], phase: "checker", headSha12: "222222222222", signed: [], onMain: false, stack: { outside: true, branch: STALE } };
const outLine = (v, id) => dispatchLine(items(v).find((i) => i.card === id));

test("a live card's leftover stack branch is not named to an outside card; the line says to cut from main", () => {
  const v = world({ cards: [card("c1-old"), card("c2-out")], ev: { "c1-old": live, "c2-out": outside } });
  const line = outLine(v, "c2-out");
  assert.doesNotMatch(line, /ship-v1\.215\.7/);
  assert.match(line, /no open stack; cut it from main and push/);
});

test("a closed or dropped card's stack branch is not named either", () => {
  for (const gone of [{ done_at: 1 }, { dropped: 1 }]) {
    const v = world({ cards: [card("c1-old", gone), card("c2-out")], ev: { "c1-old": { ...live, phase: "build", lit: [], onMain: false }, "c2-out": outside } });
    assert.doesNotMatch(outLine(v, "c2-out"), /ship-v1\.215\.7/);
  }
});

test("another outside card's branch is not named to an outside card either", () => {
  const v = world({ cards: [card("c1-out"), card("c2-out")], ev: { "c1-out": outside, "c2-out": outside } });
  assert.doesNotMatch(outLine(v, "c2-out"), /ship-v1\.215\.7/);
  assert.match(outLine(v, "c1-out"), /no open stack; cut it from main and push/);
});

test("must still name the branch of an open stack member", () => {
  const open = { lit: ["checker"], phase: "checker", headSha12: "111111111111", signed: [], onMain: false, stack: { tip: TIP, size: 2, branch: "build/stack" } };
  const v = world({ cards: [card("c1-one"), card("c2-out")], ev: { "c1-one": open, "c2-out": outside } });
  assert.match(outLine(v, "c2-out"), /re-cut it on the stack tip and push; stack mode is on, the stack branch is build\/stack/);
});
