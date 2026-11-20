// #C1164 (Manager's audit 11-17): waiting_on had five readings (the dispatch, the stall rules, the open-group rule and next-card pick, the page) and a sixth in gate/reset.mjs. Now ONE:
// worker/held-by.mjs isHeldBy. The same card reads the same everywhere for "waiting on the owner", "next is Checker", "Boardsmith: next" and empty. No Stalled definition change (DATA.md): only WHO
// is held is read in one place; what is exempt from Stalled is as before.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isHeldBy, heldFor } from "../worker/held-by.mjs";
import * as rules from "../worker/board-rules.mjs";
import { initiativeDoc } from "../worker/compat-view.mjs";
import { dispatchRun, dispatchInput } from "../collector/store-dispatch.mjs";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import { createCard, updateCard } from "../worker/board-store.mjs";
import { dispatchItems } from "../gate/reset.mjs";

const T = 1_800_000_000_000, MIN = 60e3, ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("isHeldBy: words that do not start with the role hold the card for that role; its own pointer and empty hold nothing", () => {
  const card = (w) => ({ owner_role: "Boardsmith", waiting_on: w });
  assert.equal(isHeldBy(card("waiting on the owner")), "waiting on the owner");
  assert.equal(isHeldBy(card("next is Checker")), "next is Checker");
  assert.equal(isHeldBy(card("  Checker: Full review  ")), "Checker: Full review", "trimmed");
  assert.equal(isHeldBy(card("Boardsmith: next")), null, "the owner's own pointer");
  assert.equal(isHeldBy(card("Boardsmith")), null);
  for (const empty of ["", "   ", null, undefined, 7]) assert.equal(isHeldBy(card(empty)), null, String(empty));
  assert.equal(isHeldBy(null), null);
  // from another role's side: the card that waits on "Checker: ..." is held for the owner but not for Checker
  assert.equal(isHeldBy(card("Checker: Full review"), "Checker"), null);
  assert.equal(isHeldBy(card("Checker: Full review"), "Security"), "Checker: Full review");
  assert.equal(heldFor({ who: "Boardsmith", waitingOn: "waiting on the owner" }), "waiting on the owner");
  assert.equal(heldFor({ who: "Boardsmith", waitingOn: "Boardsmith: next" }), null);
  assert.equal(heldFor({ who: "Boardsmith", waitingOn: null }, "Checker"), null);
  assert.equal(rules.isHeldBy, isHeldBy, "board-rules re-exports the one function");
});

test("isHeld (blocked or held on someone), the view's heldBy and the dispatch gate agree for each wording", () => {
  for (const [w, held] of [["waiting on the owner", true], ["next is Checker", true], ["Boardsmith: next", false], ["", false], [null, false]]) {
    const c = { id: "c1-one", num: 1, title: "t", owner_role: "Boardsmith", waiting_on: w, paused: 0, dropped: 0, review_level: "Quick" };
    assert.equal(rules.isHeld(c), held, `isHeld ${w}`);
    assert.equal(!!initiativeDoc(c, undefined).heldBy, held, `the view's heldBy ${w}`);
    const { items } = dispatchItems({ cards: [{ id: "c1-one", who: "Boardsmith", status: "active", num: 1, waitingOn: w, turns: [{ role: "Boardsmith", phase: "build", step: "build" }] }], agents: { Boardsmith: { state: "idle", lastActivityAt: T - 30 * MIN, since: T - 30 * MIN } }, now: T, roster: ["Manager", "Boardsmith"], lead: "Manager" });
    assert.equal(items.length === 0, held, `the dispatch gate ${w}`);
  }
});

// The dispatch and the stall line over the same rows (the harness of stall-dispatch-parity.test.mjs): a group card with a waiting_on.
const ROSTER = ["Manager", "Boardsmith", "Builder", "Checker"], idleNow = { state: "idle", lastActivityAt: T - 2 * MIN, since: T - 2 * MIN };
const PUSHED = { lit: ["build", "checker"], phase: "checker", headSha12: "abcdef012345", signed: [], onMain: false };
const row = ([id, batch, pos, extra = {}]) => ({ id, num: Number(id.replace(/\D/g, "")), owner_role: "Boardsmith", review_level: "Quick", waiting_on: null, paused: 0, dropped: 0, repo: "", queue_pos: pos, updated_at: T - MIN, ...(batch ? { batch } : {}), ...extra });
function viewOf(cards, ev) {
  return { cards, asks: [], stackSwitch: [{ repo: "board", stack: false, set_by: "default", set_at: 0 }], evidence: { agents: { readAt: T - 5_000, value: { Boardsmith: idleNow, Builder: idleNow, Checker: idleNow, Manager: idleNow } }, ...Object.fromEntries(Object.entries(ev).map(([id, value]) => [`cards.${id}`, { value, readAt: T - 5_000 }])) } };
}
function both(specs, ev = { "c1-one": PUSHED }) {
  const cards = specs.map(row);
  const view = { cards, asks: [], stackSwitch: [{ repo: "board", stack: false, set_by: "default", set_at: 0 }], evidence: { agents: { readAt: T - 5_000, value: { Boardsmith: idleNow, Builder: idleNow, Checker: idleNow, Manager: idleNow } }, ...Object.fromEntries(Object.entries(ev).map(([id, value]) => [`cards.${id}`, { value, readAt: T - 5_000 }])) } };
  const dispatched = dispatchRun(view, { dir: mkdtempSync(join(tmpdir(), "c1164-")), roster: ROSTER, lead: "Manager", now: T }).items.filter((i) => i.role === "Boardsmith").map((i) => i.card)[0] ?? null;
  const lines = rules.stalledWaits({ now: T, cards, evidence: ev, agents: { Boardsmith: { state: "idle", tool: null, card: null, since: T - 40 * MIN }, Manager: idleNow, Builder: idleNow, Checker: idleNow }, openAskCards: new Set(), unansweredAskCards: new Set(), phaseStart: new Map(), endsPassed: new Set(), groupOrder: [], stackOn: false })
    .filter((s) => s.role === "Boardsmith" && /queued, next #C\d+$/.test(s.reason));
  const num = lines.length ? Number(/next #C(\d+)$/.exec(lines[0].reason)[1]) : null;
  return [dispatched, num === null ? null : cards.find((c) => c.num === num).id];
}
// g1: c1 pushed (the group has started); c2 is in it, unbuilt; c3 is a loose card. A held c2 leaves the loose card to build; an unheld c2 keeps the group open (nothing else to build).
const grp = (w) => [["c1-one", "g1-open", 1], ["c2-two", "g1-open", 2, { waiting_on: w }], ["c3-three", null, 1]];
test("the open-group rule, the dispatch and the stall line read waiting_on the same: held on the owner or on Checker lets the loose card build, the owner's own pointer or nothing keeps the group open", () => {
  assert.deepEqual(both(grp("waiting on the owner")), ["c3-three", "c3-three"]);
  assert.deepEqual(both(grp("next is Checker")), ["c3-three", "c3-three"]);
  assert.deepEqual(both(grp("Boardsmith: next")), ["c2-two", "c2-two"], "not held: the group's own card is the one to build, and the loose card waits");
  assert.deepEqual(both(grp("")), ["c2-two", "c2-two"]);
});

test("a card held on someone raises no 'waits at' stall, the owner's own pointer does: stalledWaits reads isHeldBy", () => {
  const stalls = (w) => rules.stalledWaits({ now: T + rules.STALL_AFTER_MS * 2, cards: [{ id: "c", num: 5, owner_role: "Boardsmith", waiting_on: w }], evidence: { c: { lit: ["build"] } }, openAskCards: new Set(), phaseStart: new Map([["c|build", T]]), agents: { Boardsmith: { state: "idle", since: T } } });
  assert.deepEqual(stalls("waiting on the owner"), [], "held: no stall");
  assert.deepEqual(stalls("next is Checker"), [], "held: no stall");
  assert.equal(stalls("").length, 1, "with no hold the same card does raise a stall");
  assert.deepEqual(stalls("Boardsmith: next"), stalls(""), "the owner's own pointer reads as no hold");
});

// Checker 2's LOW 1 on 72925255: two sites the card names had no test (dropping either survived). The review queue (dispatchInput): a card held for Checker is not in Checker's queue; the stall line's
// next-card pick for a card in rework (stalledWaits' fixable): a held rework card is not the next card, in the dispatch and in the stall line alike.
test("the review queue skips a card held for that reviewer, and the next-card pick skips a held rework card", () => {
  const queue = (w) => dispatchInput(viewOf([row(["c1-one", null, 1, { waiting_on: w }])], { "c1-one": PUSHED }), T, { lead: "Manager", reviewers: null, roster: ROSTER }).queues.Checker ?? [];
  assert.deepEqual(queue(""), [1], "not held: in Checker's queue");
  assert.deepEqual(queue("Checker: Full review"), [1], "the pointer names Checker: not held for Checker");
  assert.deepEqual(queue("waiting on the owner"), [], "held for the reviewer");
  assert.deepEqual(queue("next is Security"), [], "held for the reviewer");
  const fix = { lit: ["build", "checker"], phase: "checker", headSha12: "abcdef012345", findings: ["checker"], signed: [], onMain: false };
  const next = (w) => both([["c3-three", null, 2], ["c6-six", null, 1, { waiting_on: w }]], { "c6-six": fix });
  assert.deepEqual(next(""), ["c6-six", "c6-six"], "a rework card is the next card in both");
  assert.deepEqual(next("waiting on the owner"), ["c3-three", "c3-three"], "held: the loose card in both");
});

test("isHeldBy with an empty role: nothing is exempt, every words-bearing waiting_on holds (Checker 2's LOW 3)", () => {
  assert.equal(isHeldBy({ owner_role: "", waiting_on: "next is Checker" }), "next is Checker");
  assert.equal(isHeldBy({ waiting_on: "next is Checker" }), "next is Checker", "no owner role at all");
  assert.equal(isHeldBy({ owner_role: "Boardsmith", waiting_on: "x" }, ""), "x", "an empty role passed on purpose");
  assert.equal(isHeldBy({ owner_role: "", waiting_on: "" }), null);
});

// Checker 2's LOW 2: the store's hold bookkeeping goes by the words, so a create and an update of the same own-pointer write the same held_at and hold_until.
test("hold bookkeeping is the same on create and update for an own-pointer waiting_on (held_at and hold_until set by the words, not by who they name)", async () => {
  const db = makeDb();
  const made = await createCard(db, T, "Manager", { id: "own-ptr", title: "t", owner_role: "Boardsmith", repo: "flight-board", waiting_on: "Boardsmith: next", check_at: null });
  assert.equal(made.ok, true, JSON.stringify(made));
  const made2 = await createCard(db, T, "Manager", { id: "own-ptr2", title: "t", owner_role: "Boardsmith", repo: "flight-board" });
  assert.equal(made2.ok, true, JSON.stringify(made2));
  assert.equal((await updateCard(db, T + 1, "Manager", { id: "own-ptr2", waiting_on: "Boardsmith: next" })).ok, true);
  const read = async (id) => await db.prepare("SELECT held_at IS NOT NULL AS h, hold_until IS NOT NULL AS u FROM cards WHERE id = ?").bind(id).first();
  assert.deepEqual(await read("own-ptr"), await read("own-ptr2"), "created with it and updated to it leave the same bookkeeping");
  assert.deepEqual(await read("own-ptr"), { h: 1, u: 1 });
});

// No second copy of the rule: every file that reads a card's words for "who it waits on" goes through held-by.mjs.
test("no file keeps its own startsWith test on waiting_on or waitingOn; the page reads the view's heldBy, not the owner's name", () => {
  const files = (d, ext) => readdirSync(join(ROOT, d), { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith(ext)).map((e) => join(d, e.name));
  const own = [];
  for (const f of [...files("worker", ".mjs"), ...files("collector", ".mjs"), ...files("gate", ".mjs"), ...files("scripts", ".mjs")]) {
    if (f === join("worker", "held-by.mjs")) continue;
    readFileSync(join(ROOT, f), "utf8").split("\n").forEach((l, n) => { if (/waiting(_o|O)n[^\n]*\.trim\(\)\.startsWith\(/.test(l) || /waiting(_o|O)n\.startsWith\(/.test(l)) own.push(`${f}:${n + 1}`); });
  }
  assert.deepEqual(own, [], "a card's waiting_on is read only through isHeldBy / heldFor");
  const page = readFileSync(join(ROOT, "page", "board.template.html"), "utf8");
  const fn = (name) => new RegExp(`function ${name}\\([^)]*\\)\\{[\\s\\S]*?\\n`).exec(page)?.[0] ?? "";
  assert.match(page, /function stalled\(i\)\{[^\n]*i\.heldBy/, "stalled() reads the view's heldBy");
  // #C1301: gapRed is gone; heldOnPurpose now ends where the next comment, "// Stalled:", begins.
  assert.match(fn("heldOnPurpose") + page.slice(page.indexOf("function heldOnPurpose"), page.indexOf("// Stalled:")), /i\.heldBy/, "heldOnPurpose reads it");
  assert.doesNotMatch(page.slice(page.indexOf("function heldOnPurpose"), page.indexOf("// Stalled:")), /waitingOn/, "heldOnPurpose has no waitingOn rule of its own");
});
