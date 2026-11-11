// #C858: a board-repository landing wakes the builder to build the deploy pair, once for the repository (not once per landed card), and the line
// names the step. Landed and not deployed names the builder; deployed (live) names nobody.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchRun } from "../collector/store-dispatch.mjs";
import { dispatchLine, DISPATCH_STEPS } from "../gate/reset.mjs";

const NOW = 1_800_000_000_000, MIN = 60e3;
const ROSTER = ["Manager", "Boardsmith", "Checker", "Release"], LEAD = "Manager";
const SHA = "d71c01c6341b";
const idle = { state: "idle", lastActivityAt: NOW - 2 * MIN, since: NOW - 2 * MIN };
const card = (num, extra = {}) => ({ id: `c${num}-thing`, num, owner_role: "Boardsmith", review_level: "Quick", waiting_on: null, paused: 0, dropped: 0, repo: "flight-board", ...extra });
const landed = { lit: ["ship"], phase: "ship", headSha12: SHA, signed: ["checker", "security"], onMain: true };
const world = (cards, ev) => ({
  cards, asks: [], stackSwitch: [],
  evidence: { agents: { readAt: NOW - 5_000, value: Object.fromEntries(ROSTER.map((r) => [r, idle])) }, ...Object.fromEntries(Object.entries(ev).map(([id, v]) => [`cards.${id}`, { readAt: NOW - 5_000, value: v }])) },
});
const items = (v) => dispatchRun(v, { dir: mkdtempSync(join(tmpdir(), "pw-")), roster: ROSTER, lead: LEAD, now: NOW }).items;

test("landed and not deployed names the builder, once for the repository: the newest landed card carries the pair", () => {
  const v = world([card(848), card(849), card(853)], { "c848-thing": landed, "c849-thing": landed, "c853-thing": landed });
  const got = items(v);
  assert.deepEqual(got.map((i) => `${i.card}:${i.role}:${i.step}`), ["c853-thing:Boardsmith:pair"]);
});

test("the line names the step: landed, not deployed, build the pair, and the pack if hooks changed", () => {
  const [i] = items(world([card(853)], { "c853-thing": landed }));
  const line = dispatchLine(i);
  assert.equal(line, `DISPATCH #C853 at ship: ${SHA} signed by Checker and Security; it ${DISPATCH_STEPS.pair} (Boardsmith's turn; pushing your own build branch, sending READY and taking your next queued card need no go from anyone, act on this)`);
  assert.match(line, /is landed and not deployed: build the deploy pair \(node scripts\/make-pair\.mjs <sha> <n>\) and, if hooks changed, the pack/);
});

test("deployed (live) names nobody, and a card with no repo word is the lead's to close", () => {
  assert.deepEqual(items(world([card(853)], { "c853-thing": { ...landed, lit: ["live"], phase: "live" } })), []);
  assert.deepEqual(items(world([card(853, { repo: "" })], { "c853-thing": landed })), []);
});

test("another builder's landed cards keep their own pair; an unlanded card is not folded into it", () => {
  const v = world([card(850, { owner_role: "Checker" }), card(851), card(852)], { "c850-thing": landed, "c851-thing": landed, "c852-thing": { lit: ["ship"], phase: "ship", headSha12: SHA, signed: ["checker"], onMain: false } });
  assert.deepEqual(items(v).map((i) => `${i.card}:${i.role}:${i.step}`).sort(), ["c850-thing:Checker:pair", "c851-thing:Boardsmith:pair", "c852-thing:Release:land"].sort());
});
