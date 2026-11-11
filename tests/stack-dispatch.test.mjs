// #C859 slice 3 (stack mode, design 3): with the board repository's switch on, the builder's wake names the stack branch, a card outside the
// stack is told to re-cut it, and Checker and Security are woken once, for the stack tip, when no card of the repository has a build turn left.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchRun, turnsOf } from "../collector/store-dispatch.mjs";
import { dispatchLine, DISPATCH_STEPS } from "../gate/reset.mjs";

const NOW = 1_800_000_000_000, MIN = 60e3;
const ROSTER = ["Manager", "Boardsmith", "Checker", "Security", "Release"], LEAD = "Manager";
const TIP = "abcdef012345";
const idle = { state: "idle", lastActivityAt: NOW - 2 * MIN, since: NOW - 2 * MIN };
const card = (id, extra = {}) => ({ id, num: Number(id.replace(/\D/g, "")) || null, owner_role: "Boardsmith", review_level: "Quick", waiting_on: null, paused: 0, dropped: 0, repo: "", ...extra });
const world = ({ cards, ev = {}, on = true }) => ({
  cards, asks: [], stackSwitch: [{ repo: "board", stack: on, set_by: "default", set_at: 0 }, { repo: "product", stack: false, set_by: "default", set_at: 0 }],
  evidence: { agents: { readAt: NOW - 5_000, value: Object.fromEntries(ROSTER.map((r) => [r, idle])) }, ...Object.fromEntries(Object.entries(ev).map(([id, v]) => [`cards.${id}`, { readAt: NOW - 5_000, value: v }])) },
});
const items = (v) => dispatchRun(v, { dir: mkdtempSync(join(tmpdir(), "sd-")), roster: ROSTER, lead: LEAD, now: NOW }).items;
const who = (v) => items(v).map((i) => `${i.card}:${i.role}:${i.step}`).sort();
const inStack = (extra = {}) => ({ lit: ["checker"], phase: "checker", headSha12: "111111111111", signed: [], onMain: false, stack: { tip: TIP, size: 2, branch: "build/stack" }, ...extra });

test("switch on: the builder's wake names the stack branch, and the line says one commit per card", () => {
  const v = world({ cards: [card("c1-one"), card("c2-two")], ev: { "c1-one": inStack(), "c2-two": inStack({ phase: "build", lit: [] }) } });
  const build = items(v).find((i) => i.step === "build");
  assert.equal(build.card, "c2-two");
  assert.equal(build.stack, "build/stack");
  assert.match(dispatchLine(build), new RegExp(`it ${DISPATCH_STEPS.build.replace(/[()]/g, "\\$&")}; stack mode is on, the stack branch is build/stack: one commit per card, rebased on its tip; push with node scripts\\/stack-ready\\.mjs --config <the board\\.config\\.json path of your wake-watch line> \\(it pushes the branch and decides by itself whether cards are still queued\\) \\(Boardsmith's turn;`));
});

test("#C914: with the switch on a builder's line names the stack-ready command even before any stack branch exists; not for a reviewer, not with the switch off", () => {
  const v = world({ cards: [card("c1-one")], ev: {} });
  const [build] = items(v);
  assert.equal(build.stackMode, true);
  assert.match(dispatchLine(build), /; stack mode is on: push with node scripts\/stack-ready\.mjs --config <the board\.config\.json path of your wake-watch line> \(it pushes the branch and decides by itself whether cards are still queued\) \(Boardsmith's turn;/);
  const review = items(world({ cards: [card("c1-one")], ev: { "c1-one": inStack({ stack: undefined }) } }))[0];
  assert.equal(review.role, "Checker");
  assert.equal(review.stackMode, undefined);
  assert.doesNotMatch(dispatchLine(review), /stack-ready/);
  assert.doesNotMatch(dispatchLine(items(world({ on: false, cards: [card("c1-one")], ev: {} }))[0]), /stack-ready/);
});

// #C953 (seen 11-11 ~2:20 pm MT): a flight-board card was told to stack on the stack branch of Builder's product cards (no repo word).
// The branch a card is told to join belongs to its own repository.
test("#C953: a stack branch is named only to cards of its own repository; a card with no same-repo stack builds from main", () => {
  const product = (id, extra = {}) => card(id, { owner_role: "Builder", repo: null, ...extra });
  const board = (id, extra = {}) => card(id, { repo: "flight-board", ...extra });
  const mixed = world({ cards: [product("c930-prod"), product("c951-prod"), board("c928-board")], ev: { "c930-prod": inStack({ stack: { tip: TIP, size: 2, branch: "build/product-stack" } }), "c951-prod": inStack({ phase: "build", lit: [], stack: { tip: TIP, size: 2, branch: "build/product-stack" } }) } });
  const withBuilder = (v) => ({ ...v, evidence: { ...v.evidence, agents: { readAt: NOW - 5_000, value: { ...v.evidence.agents.value, Builder: idle } } } });
  const byId = (v, id) => dispatchRun(withBuilder(v), { dir: mkdtempSync(join(tmpdir(), "sd-")), roster: [...ROSTER, "Builder"], lead: LEAD, now: NOW }).items.find((i) => i.card === id && i.step === "build");
  assert.equal(byId(mixed, "c928-board").stack, undefined, "the board card is not told to stack on the product branch");
  assert.equal(byId(mixed, "c928-board").stackMode, true, "it still pushes with the stack-ready command; with no base it builds from main");
  assert.doesNotMatch(dispatchLine(byId(mixed, "c928-board")), /product-stack/);
  assert.equal(byId(mixed, "c951-prod").stack, "build/product-stack", "the product stack is unchanged");
  // Same repository, as today: two flight-board cards stack on each other's branch; so do two cards with no repo word.
  const same = world({ cards: [board("c1-one"), board("c2-two")], ev: { "c1-one": inStack(), "c2-two": inStack({ phase: "build", lit: [] }) } });
  assert.equal(byId(same, "c2-two").stack, "build/stack");
  const none = world({ cards: [product("c3-one"), product("c4-two")], ev: { "c3-one": inStack(), "c4-two": inStack({ phase: "build", lit: [] }) } });
  assert.equal(byId(none, "c4-two").stack, "build/stack");
  // And the other way round: a flight-board stack is not named to a product card.
  const flip = world({ cards: [board("c5-board"), product("c6-prod")], ev: { "c5-board": inStack({ stack: { tip: TIP, size: 2, branch: "build/board-stack" } }), "c6-prod": inStack({ phase: "build", lit: [], stack: undefined }) } });
  assert.equal(byId(flip, "c6-prod").stack, undefined);
});

test("switch off: nothing about a stack in any turn or line (today's dispatch)", () => {
  const v = world({ on: false, cards: [card("c1-one"), card("c2-two")], ev: { "c1-one": inStack(), "c2-two": inStack({ phase: "build", lit: [] }) } });
  for (const i of items(v)) { assert.equal(i.stack, undefined); assert.doesNotMatch(dispatchLine(i), /stack/); }
});

test("a card outside the stack is told to re-cut it on the stack tip", () => {
  const v = world({ cards: [card("c1-one"), card("c3-out")], ev: { "c1-one": inStack(), "c3-out": { lit: ["checker"], phase: "checker", headSha12: "222222222222", signed: [], stack: { outside: true, branch: "build/stack" } } } });
  const out = items(v).find((i) => i.card === "c3-out");
  assert.equal(out.step, "outside");
  assert.equal(out.role, "Boardsmith");
  assert.match(dispatchLine(out), /it is outside the stack \(its branch was not cut from the stack tip\); re-cut it on the stack tip and push; stack mode is on, the stack branch is build\/stack/);
});

test("reviewers are held while a card of the repository still has a build turn, then woken once for the stack tip", () => {
  const two = [card("c1-one"), card("c2-two")];
  const waiting = world({ cards: [...two, card("c4-next")], ev: { "c1-one": inStack(), "c2-two": inStack() } });
  assert.deepEqual(who(waiting), ["c4-next:Boardsmith:build"], "a card with nothing pushed is queued: no review yet");
  const done = world({ cards: two, ev: { "c1-one": inStack(), "c2-two": inStack() } });
  assert.deepEqual(who(done), ["c1-one:Checker:review", "c2-two:Checker:review"]);
  assert.ok(items(done).every((i) => i.sha === TIP), "the review names the stack tip, not each card's own commit");
});

test("a card that is in no stack (or in another repository) is not held by the build queue", () => {
  const lone = { lit: ["checker"], phase: "checker", headSha12: "333333333333", signed: [], onMain: false };
  const v = world({ cards: [card("c1-lone"), card("c4-next")], ev: { "c1-lone": lone } });
  assert.deepEqual(who(v), ["c1-lone:Checker:review", "c4-next:Boardsmith:build"]);
  const product = world({ cards: [card("c5-prod", { repo: "site-one" }), card("c1-one"), card("c2-two"), card("c4-next")], ev: { "c5-prod": { ...lone, stack: { tip: TIP, size: 2 } }, "c1-one": inStack(), "c2-two": inStack() } });
  assert.ok(who(product).includes("c5-prod:Checker:review"), "a product card's review is not held by a board card's build turn");
  assert.equal(items(product).find((i) => i.card === "c5-prod").sha, "333333333333", "and its stack evidence is not read: the switch for it is off");
});

test("turnsOf with no stack context is what it was: the owner builds, nothing added", () => {
  assert.deepEqual(turnsOf(card("c1-one"), null), [{ role: "Boardsmith", phase: "build", step: "build" }]);
});
