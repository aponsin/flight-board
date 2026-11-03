// #C619: an open card with no owner or no ETA shows red on its row, and the probe lists every such card for the lead's watch.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boardTruth } from "../collector/readings.mjs";
import { truthPending, truthSeen, truthLine, TRUTH_FILE, TRUTH_SEEN_FILE, GAP_AGAIN_MS } from "../gate/reset.mjs";
import { tick } from "../scripts/wake-watch.mjs";
import { checkWrites } from "../gate/rules.mjs";
import { fullConfig } from "../scripts/config.mjs";
import { loadBoard, loadNames, step } from "./harness.mjs";

const T = 1_800_000_000_000, MIN = 60e3;

// ---- the probe's list
test("boardTruth lists an open card with no owner, no ETA or neither, by card, after ship and close", () => {
  const states = { "board-a": { headSha12: "a1b2c3d4e5f6", phase: "ship", onMain: false } };
  const cards = [
    { id: "zed", status: "active", who: "Builder", etaLive: T },
    { id: "no-owner", status: "active", who: "", etaLive: T },
    { id: "no-eta", status: "active", who: "Builder" },
    { id: "neither", status: "queued" },
    { id: "blank-owner", status: "active", who: "  ", etaLive: T },
    { id: "bad-eta", status: "active", who: "Builder", etaLive: "soon" },
  ];
  assert.deepEqual(boardTruth({ states, shipPhase: "ship", livePhase: "live", cards }), [
    { kind: "ship", card: "board-a", sha: "a1b2c3d4e5f6" },
    { kind: "gap", card: "bad-eta", miss: "eta" },
    { kind: "gap", card: "blank-owner", miss: "owner" },
    { kind: "gap", card: "neither", miss: "owner eta" },
    { kind: "gap", card: "no-eta", miss: "eta" },
    { kind: "gap", card: "no-owner", miss: "owner" },
  ]);
});

test("boardTruth leaves out done and dropped cards and entries that are not cards; at most 20 in all", () => {
  const cards = [{ id: "d", status: "done" }, { id: "x", status: "dropped" }, { id: "Bad Card!", status: "active" }, null, "str", { status: "active" }];
  assert.deepEqual(boardTruth({ states: {}, shipPhase: "ship", livePhase: "live", cards }), []);
  const many = Array.from({ length: 30 }, (_, n) => ({ id: `card-${String(n).padStart(2, "0")}`, status: "active" }));
  assert.equal(boardTruth({ states: {}, shipPhase: "ship", livePhase: "live", cards: many }).length, 20);
  assert.deepEqual(boardTruth({ states: {}, shipPhase: "ship", livePhase: "live" }), [], "no cards given: no gaps");
});

// ---- the lead's watch
test("a GAP line names what is missing, and what to write", () => {
  assert.equal(truthLine({ kind: "gap", card: "c1", miss: "owner" }), "GAP c1: no owner; write who on the card");
  assert.equal(truthLine({ kind: "gap", card: "c1", miss: "eta" }), "GAP c1: no ETA; write etaLive on the card");
  assert.equal(truthLine({ kind: "gap", card: "c1", miss: "owner eta" }), "GAP c1: no owner and no ETA; write who and etaLive on the card");
});

test("a GAP line repeats every 30 minutes until the card has both; a different miss is a new line at once", () => {
  const dir = mkdtempSync(join(tmpdir(), "fb-gap-"));
  const write = (items) => writeFileSync(join(dir, TRUTH_FILE), JSON.stringify({ at: T, items }));
  const roster = ["Manager", "Builder"];
  write([{ kind: "gap", card: "c1", miss: "owner eta" }]);
  assert.match(tick(dir, T, 1, roster), /^GAP c1: no owner and no ETA/, "no Release on the roster needed");
  assert.equal(tick(dir, T + 5 * MIN, 1, roster), null, "five minutes on: nothing");
  assert.equal(tick(dir, T + 29 * MIN + 59e3, 1, roster), null, "just under thirty minutes");
  assert.match(tick(dir, T + 30 * MIN, 1, roster), /^GAP c1/, "thirty minutes: again");
  assert.equal(tick(dir, T + 40 * MIN, 1, roster), null, "the clock restarts at each print");
  write([{ kind: "gap", card: "c1", miss: "eta" }]);
  assert.match(tick(dir, T + 41 * MIN, 1, roster), /^GAP c1: no ETA/, "the owner is written, the ETA still missing: a new line");
  write([]);
  assert.equal(tick(dir, T + 42 * MIN, 1, roster), null, "both written: gone");
  write([{ kind: "gap", card: "c1", miss: "eta" }]);
  assert.match(tick(dir, T + 43 * MIN, 1, roster), /^GAP c1/, "a card that loses its ETA again is asked at once");
});

test("the seen file keeps the miss in place of a sha; odd gap entries are dropped", () => {
  const asked = { items: [{ kind: "gap", card: "c1", miss: "owner" }, { kind: "gap", card: "c2", miss: "everything" }, { kind: "gap", card: "Bad Card!", miss: "eta" }, { kind: "gap", card: "c3" }] };
  assert.deepEqual(truthPending(asked, null, T).map((a) => a.card), ["c1"]);
  assert.deepEqual(truthSeen(asked, null, [{ kind: "gap", card: "c1" }], T), { items: { "gap c1": { sha: "owner", at: T } } });
  assert.deepEqual(truthPending(asked, truthSeen(asked, null, [{ kind: "gap", card: "c1" }], T), T + GAP_AGAIN_MS - 1), []);
  assert.ok(TRUTH_SEEN_FILE);
});

// ---- the page
const row = (b, i) => b.initRow(i);

test("an open card with no owner is flagged 'no owner', and its row goes red", () => {
  const b = loadBoard();
  const now = Date.now();
  b.state.steps = [];
  b.state.waiting = [];
  const i = b.gates(b.enrich({ id: "x", level: "Quick", customerText: false, skip: ["plan"], status: "active", name: "X", etaLive: now + 3600e3, nextNote: "n", nextNoteAt: now, phase: "build" }));
  assert.ok(!i.who, "nobody on it");
  assert.ok([...b.gaps(i)].includes("no owner"), [...b.gaps(i)].join(", "));
  assert.match(row(b, i), /class="i-row gap-red"/);
  assert.match(row(b, i), /Manager missed: [^<]*no owner/);
});

test("a card with an owner and an ETA keeps a plain row; a card with no ETA goes red too", () => {
  const b = loadBoard();
  const now = Date.now();
  const mk = (fields) => { b.state.steps = [step("x", "build", "Admin", "start", now)]; b.state.waiting = []; return b.gates(b.enrich({ id: "x", level: "Quick", customerText: false, skip: ["plan"], status: "active", name: "X", nextNote: "n", nextNoteAt: now, ...fields })); };
  const ok = mk({ etaLive: now + 3600e3 });
  assert.equal(ok.who, "Admin");
  assert.deepEqual([...b.gaps(ok)], []);
  assert.match(row(b, ok), /class="i-row"/);
  const noEta = mk({ etaLive: undefined });
  assert.ok([...b.gaps(noEta)].includes("no ETA"));
  assert.match(row(b, noEta), /class="i-row gap-red"/);
});

test("only the two gaps that leave a card without a name or a time go red; the others stay a line of text", () => {
  const { gapRed } = loadNames(["gapRed"]);
  assert.equal(gapRed(["no owner"]), true);
  assert.equal(gapRed(["next step over 1 h old", "no ETA"]), true);
  assert.equal(gapRed(["no next step", "no review level", "ETA passed", "never started"]), false);
  assert.equal(gapRed([]), false);
});

test("no 'no owner' for a card waiting in a known wait, one up next between phases, or one being worked by the live state; never a done card", () => {
  const b = loadBoard();
  const now = Date.now();
  b.state.waiting = [];
  const base = { id: "x", level: "Quick", customerText: false, skip: ["plan"], name: "X", etaLive: now + 3600e3, nextNote: "n", nextNoteAt: now };
  b.state.steps = [step("x", "build", "Admin", "start", now), step("x", "build", "Admin", "end", now + 1), step("x", "checker", "Checker", "start", now + 2), step("x", "checker", "Checker", "end", now + 3)];
  const upNext = b.gates(b.enrich({ ...base, status: "active" }));
  assert.equal(upNext.upNext, true);
  assert.ok(![...b.gaps(upNext)].includes("no owner"), "up next between phases");
  assert.ok(![...b.gaps({ ...upNext, status: "done" })].includes("no owner"), "done");
  assert.ok(![...b.gaps({ ...base, status: "queued", phase: "build" })].includes("no owner"), "queued behind a busy agent");
});

// ---- the gate keeps letting a card be written before it is handed to anyone
test("the gate does not refuse a new card for 'no owner': the page flags it, the probe lists it", () => {
  const config = fullConfig({ artifactUrl: "https://claude.ai/" + "artifact/TestBoard01" }), now = Date.now() - 1234;
  const card = { name: "X", size: "S", status: "active", level: "Quick", etaLive: Date.now() + 6e5, nextNote: "n", nextNoteAt: now, plan: "keep-lights-on" };
  const { errors } = checkWrites([{ op: "set", collection: "initiatives", doc_id: "x", data: card }], { config, who: { role: config.gate.managerRole, manager: true }, now, state: {} });
  assert.deepEqual(errors, [], "a card with no who passes the gate");
});
