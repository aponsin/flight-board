// #C1380 step 1: worker/reading.mjs says where a card is, once. Eleven real readings (tests/fixtures/readings-real.json: evidence values taken from the live board, the
// repository names made neutral) and the laws of the contract (docs/DATA.d/one-reading-module.md, section B): done implies live; a product card never has pack or install; a reading is
// never both stale and unknown; a stale reading is never working. Views are unchanged in step 1: nothing here reads the Worker, the page or the dispatch.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { reading, kindOf, withOf, STATES, WAITS } from "../worker/reading.mjs";

const FIX = JSON.parse(readFileSync(new URL("./fixtures/readings-real.json", import.meta.url), "utf8"));
const NOW = 1_795_208_000_000;
const run = (id, over = {}) => { const f = FIX[id]; return reading({ ...f.card, ...(over.card ?? {}) }, over.evidence === undefined ? f.evidence : over.evidence, over.claims ?? [], over.agents ?? {}, over.config ?? {}, over.now ?? NOW, over.ctx ?? {}); };
const shape = (r) => `${r.phase}/${r.state}/${r.wait}/${r.with}`;

test("real readings: each of the known cases reads as the contract says", () => {
  const want = {
    "refactor-step1-store": "live/done/null/Release",
    "board-deploy-rollback": "ship/waiting/pack/Release",             // a board card on main, no pack: it waits for the pack (a closed card with a ship reading is not done: done means live)
    "pickup-door-session": "ship/waiting/deploy/Release",            // a product card closed at ship under #C1104: waits for its deploy, never a pack or an install
    "handoff-self-clear": "live/done/null/Release",
    "renewal-reminder-30-days": "ship/waiting/deploy/Release",
    "idle-stall-counts-done-cards": "ship/waiting/land/Release",      // signed, its commit not on main (behind it): waits for the landing
    "rc-field-after-clear": "checker/rework/null/Boardsmith",         // findings on its tip: with its owner again, whatever phase is lit
    "outreach-split-plans-store": "language/waiting/turn/Linguist",
    "scout-offer-launch-price": "build/waiting/turn/Reviewer",
    "c733-seen-time-test": "live/done/null/Release",
    "referral-program-idea": "live/done/null/Release",                // a commit inside a group head (behind a merge) that reads live
  };
  for (const [id, shapeWant] of Object.entries(want)) assert.equal(shape(run(id)), shapeWant, id);
});

test("every field is there, and the value sets are the contract's", () => {
  for (const id of Object.keys(FIX)) {
    const r = run(id);
    for (const k of ["phase", "state", "wait", "with", "working", "since", "asOf", "why"]) assert.ok(k in r, `${id}: ${k}`);
    assert.ok(STATES.includes(r.state), r.state); assert.ok(r.wait === null || WAITS.includes(r.wait), r.wait);
    assert.equal(typeof r.why, "string"); assert.ok(r.why.length > 0);
    assert.equal(r.asOf, FIX[id].evidence.at, "asOf is the reading's own time when fresh");
  }
});

test("laws, on every fixture and on perturbed copies: done implies live; a product card never has pack or install; never stale and unknown; a stale reading is not working", () => {
  const agents = { Checker: { state: "working", card: "x" }, Boardsmith: { state: "working", card: "x" } };
  for (const id of Object.keys(FIX)) {
    const f = FIX[id];
    const variants = [{}, { evidence: { ...f.evidence, stale: true, staleSince: NOW - 3600e3 } }, { evidence: { ...f.evidence, stale: true } }, { card: { repo: "widgets" } }, { card: { repo: "nowhere" }, config: { repos: [{ name: "flight-board", kind: "board" }, { name: "widgets", kind: "product" }] } }, { evidence: { ...f.evidence, shipping: true, ci: "queued" } }, { agents: Object.fromEntries(Object.keys({ ...agents, [f.card.owner_role]: 1 }).map((r) => [r, { state: "working", card: f.card.id }])) }];
    for (const v of variants) {
      const card = { ...f.card, ...(v.card ?? {}) }, r = reading(card, v.evidence ?? f.evidence, [], v.agents ?? {}, v.config ?? {}, NOW, {});
      const label = `${id} ${JSON.stringify(Object.keys(v))}`;
      if (r.state === "done") assert.ok(r.phase === "live" || !(v.evidence ?? f.evidence).headSha, `done implies live: ${label}`);
      if (kindOf(card, v.config ?? {}) === "product") assert.ok(r.wait !== "pack" && r.wait !== "install", `a product card has no pack or install: ${label}`);
      assert.ok(!(r.stale === true && r.state === "unknown" && "staleSince" in r), `stale and unknown never both: ${label}`);
      if (r.stale === true) assert.equal(r.working, false, `a stale reading is not working: ${label}`);
      if (r.state === "unknown") assert.ok(!("staleSince" in r), `unknown carries no staleSince: ${label}`);
      assert.ok(STATES.includes(r.state));
    }
  }
});

test("a product repository word never starts a board's pack or install, a board card does, and a board card past the pack waits for the install", () => {
  const e = FIX["board-deploy-rollback"].evidence;
  assert.equal(run("board-deploy-rollback", { evidence: { ...e, packed: true } }).wait, "install");
  const past = run("board-deploy-rollback", { evidence: { ...e, packed: true, installed: true } });
  assert.ok(past.wait !== "pack" && past.wait !== "install", "installed: nothing of the board's own is left to wait for; it reads live at the next reading");
  assert.equal(run("board-deploy-rollback", { evidence: { ...e, noInstall: true } }).wait, "deploy", "docs and tests only: no pack, no install");
  assert.equal(run("board-deploy-rollback", { card: { repo: "widgets" } }).wait, "deploy");
});

test("closed means live: a card closed at ship reads as waiting for its deploy, not done (the 71 of the audit)", () => {
  const r = run("pickup-door-session");
  assert.equal(r.state, "waiting"); assert.equal(r.wait, "deploy");
  assert.equal(run("pickup-door-session", { evidence: { ...FIX["handoff-self-clear"].evidence } }).state, "done", "the same card reads done once its reading is live");
});

test("a typed-done card with no commit of its own is done", () => {
  const r = reading({ id: "memo", repo: "flight-board", owner_role: "Manager", done_at: NOW - 1 }, null, [], {}, {}, NOW);
  assert.equal(r.state, "done");
});

test("queued: nothing pushed yet; the wait is a turn only when its owner is on another card", () => {
  const card = { id: "fresh", repo: "flight-board", owner_role: "Boardsmith" };
  assert.equal(reading(card, null, [], {}, {}, NOW).state, "queued");
  assert.equal(reading(card, null, [], {}, {}, NOW).wait, null);
  const busy = reading(card, null, [], { Boardsmith: { state: "working", card: "other" } }, {}, NOW);
  assert.equal(busy.state, "queued"); assert.equal(busy.wait, "turn"); assert.equal(busy.working, false);
});

test("unknown: a repository word the config's list does not know, never read as board", () => {
  const config = { repos: [{ name: "flight-board", kind: "board" }, { name: "widgets", kind: "product" }] };
  assert.equal(kindOf({ repo: "widgets" }, config), "product");
  assert.equal(kindOf({ repo: "acme/flight-board.git" }, config), "board");
  assert.equal(kindOf({ repo: "mystery" }, config), null);
  const r = run("pickup-door-session", { card: { repo: "mystery" }, config });
  assert.equal(r.state, "unknown"); assert.match(r.why, /mystery/); assert.equal(r.kind, null);
  assert.equal(kindOf({ repo: "mystery" }, {}), "product", "with no list in the config the word lists answer, as today");
});

test("stale: with an earlier good reading it keeps its last good state and carries the mark; with none it is unknown; never working", () => {
  const e = FIX["board-deploy-rollback"].evidence;
  const good = run("board-deploy-rollback", { evidence: { ...e, stale: true, staleSince: NOW - 600e3 }, agents: { Release: { state: "working", card: "board-deploy-rollback" } } });
  assert.equal(good.state, "waiting"); assert.equal(good.wait, "pack"); assert.equal(good.stale, true); assert.equal(good.staleSince, NOW - 600e3);
  assert.equal(good.asOf, NOW - 600e3, "asOf is the oldest source: the stale mark's time"); assert.equal(good.working, false);
  const never = run("board-deploy-rollback", { evidence: { ...e, stale: true } });
  assert.equal(never.state, "unknown"); assert.equal(never.stale, true); assert.ok(!("staleSince" in never));
  const liveStale = run("refactor-step1-store", { evidence: { ...FIX["refactor-step1-store"].evidence, stale: true, staleSince: NOW - 1 } });
  assert.notEqual(liveStale.state, "done", "a stale reading never closes a card: done needs a fresh read");
});

test("working: the role it is with has a session on it, or CI or a ship run is going", () => {
  const id = "outreach-split-plans-store";
  assert.equal(run(id).working, false);
  const on = run(id, { agents: { Linguist: { state: "working", card: id } } });
  assert.equal(on.state, "working"); assert.equal(on.working, true); assert.equal(on.with, "Linguist");
  assert.equal(run(id, { agents: { Linguist: { state: "working", card: "other" } } }).wait, "turn", "the role is on another card: it waits its turn");
  assert.equal(run(id, { agents: { Linguist: { state: "idle", card: id } } }).working, false);
  assert.equal(run(id, { evidence: { ...FIX[id].evidence, ci: "queued" } }).state, "working");
  assert.equal(run(id, { evidence: { ...FIX[id].evidence, shipping: true } }).working, true);
  const rw = run("rc-field-after-clear", { agents: { Boardsmith: { state: "working", card: "rc-field-after-clear" } } });
  assert.equal(rw.state, "rework"); assert.equal(rw.working, true, "working is true in rework too");
});

test("with: the claim holder on the tip, else the repository's reviewer, else the lane; the owner of the board at install and ask", () => {
  const f = FIX["rc-field-after-clear"], card = f.card;
  const e = { ...f.evidence, rework: false, findings: [] };
  const claim = { sha: e.headSha, card_id: card.id, checker: "Checker 2", released_at: null };
  assert.equal(reading(card, e, [claim], {}, {}, NOW).with, "Checker 2", "the open claim names it as itself");
  assert.equal(reading(card, e, [{ ...claim, released_at: 1 }], {}, {}, NOW).with, "Checker", "a released claim holds nothing");
  assert.equal(reading(card, e, [], {}, { reviewers: { "flight-board": "Checker 2" } }, NOW).with, "Checker 2");
  assert.equal(withOf({ id: "a", owner_role: "Builder" }, null, "install", "install", "waiting", [], { owner: "Owner" }), "Owner");
  assert.equal(withOf({ id: "a", owner_role: "Builder" }, null, "ship", "ask", "waiting", [], { owner: "Owner" }), "Owner");
  assert.equal(withOf({ id: "a", owner_role: "Builder" }, null, "build", null, "waiting", [], {}), "Builder");
  assert.equal(withOf({ id: "a", owner_role: "Builder" }, null, "ship", null, "waiting", [], {}), "Release");
});

test("waits: ask, hold and group each explain a card standing still, in that order", () => {
  const id = "outreach-split-plans-store";
  const ask = run(id, { ctx: { asks: [{ card_id: id, num: 2194 }] } });
  assert.equal(ask.wait, "ask"); assert.equal(ask.ask, 2194); assert.equal(ask.with, "owner");
  assert.equal(run(id, { card: { check_at: NOW + 3600e3 } }).wait, "hold");
  const e = FIX["idle-stall-counts-done-cards"].evidence;
  const peers = [{ id: "idle-stall-counts-done-cards", batch: "g" }, { id: "mate", batch: "g" }];
  const grp = reading({ ...FIX["idle-stall-counts-done-cards"].card, batch: "g" }, { ...e, phase: "checker", lit: ["checker"], stack: { tip: "t", size: 2 }, onMain: false }, [], {}, {}, NOW, { cards: peers, evidence: { mate: { lit: ["build"] } } });
  assert.equal(grp.wait, "group");
  assert.equal(run(id, { card: { check_at: NOW + 3600e3 }, ctx: { asks: [{ card_id: id, num: 1 }] } }).wait, "ask", "an ask outranks a hold");
});

test("stuck: nobody on it, over twice the phase's median, and no wait explains it", () => {
  const id = "outreach-split-plans-store";
  const ctx = (since) => ({ phaseStart: new Map([[`${id}|language`, since]]), medians: { language: 600e3 } });
  assert.equal(run(id, { ctx: ctx(NOW - 1300e3) }).state, "stuck");
  assert.equal(run(id, { ctx: ctx(NOW - 1100e3) }).state, "waiting", "under twice the median it is waiting its turn");
  assert.equal(run(id, { ctx: ctx(NOW - 1300e3), agents: { Linguist: { state: "working", card: id } } }).state, "working", "an agent on it keeps it working, slow or not");
  assert.equal(run(id, { ctx: { ...ctx(NOW - 1300e3), asks: [{ card_id: id, num: 1 }] } }).state, "waiting", "a wait explains it: not stuck");
  assert.equal(run(id, { ctx: ctx(NOW - 1300e3) }).since, NOW - 1300e3);
});

test("the module imports nothing of the collector and no other file exports its rules (step 1: the module stands alone)", () => {
  const src = readFileSync(new URL("../worker/reading.mjs", import.meta.url), "utf8");
  for (const m of src.matchAll(/^import .* from "([^"]+)";?$/gm)) assert.match(m[1], /^\.\/[a-z-]+\.mjs$/, m[1]);
  assert.ok(!/from "\.\.\//.test(src));
});
