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
  cards, asks: [], stackSwitch: [{ repo: "board", stack: on ? 1 : 0 }, { repo: "product", stack: 0 }],
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
  assert.match(dispatchLine(build), new RegExp(`it ${DISPATCH_STEPS.build.replace(/[()]/g, "\\$&")}; stack mode is on, the stack branch is build/stack: one commit per card, rebased on its tip before you push \\(Boardsmith's turn;`));
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
