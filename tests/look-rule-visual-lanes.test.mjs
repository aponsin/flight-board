// #C956 (Checker's LOW on #C952): the old gate also held a Decision on a card of one of the team's visual lanes (config decisions.visualLanes) to a
// picture per option, whatever its words said; the store's rule read the look words only. The probe now posts the lanes as evidence `look`, and
// the store applies the rule to a Decision whose card is owned by a role in that list.
import test from "node:test";
import assert from "node:assert/strict";
import { createAsk, createCard, writeEvidence, askFromTool } from "../worker/board-store.mjs";
import { askRefusal, evidenceRefusal, lookRefusal, inVisualLane } from "../worker/board-rules.mjs";
import { lookWrite, evidenceJob } from "../collector/probe-evidence.mjs";
import { makeDb } from "./helpers/d1-sqlite.mjs";

const NOW = 1_800_000_000_000;
const RED = "redredredredred01", BLUE = "blueblueblueblue02";
// A Decision about nothing visual: no look word in its title or question.
const plain = (extra = {}) => ({ type: "Decision", title: "Which order?", asked_by: "Manager", question: "First the left one or the right one?", options: ["Left", "Right"], recommended: "Left", ...extra });
async function seeded({ lanes } = {}) {
  const db = makeDb();
  for (const id of [RED, BLUE]) await db.prepare("INSERT INTO files (id, name, type, size, sha256, added_by, added_at) VALUES (?, ?, 'image/png', 10, '', 'Manager', ?)").bind(id, `${id}.png`, NOW).run();
  for (const [id, owner] of [["design-card", "Designer"], ["demo-card", "Demos"], ["code-card", "Boardsmith"]]) assert.equal((await createCard(db, NOW, "Manager", { id, title: id, owner_role: owner })).ok, true);
  if (lanes) assert.equal((await writeEvidence(db, NOW, "probe", "look", { visualLanes: lanes })).ok, true);
  return db;
}

test("the probe posts the config's lanes under look: the list, an empty list when none are set, and nothing for a config it cannot read", () => {
  assert.deepEqual(lookWrite(JSON.stringify({ decisions: { visualLanes: ["Designer", "Demos"] } })), { key: "look", value: { visualLanes: ["Designer", "Demos"] } });
  assert.deepEqual(lookWrite(JSON.stringify({ decisions: { lookWords: ["hero"] } })), { key: "look", value: { visualLanes: [] } }, "no lanes set: an empty list, so a lane taken out stops counting");
  assert.deepEqual(lookWrite(JSON.stringify({})), { key: "look", value: { visualLanes: [] } });
  const logs = [];
  assert.equal(lookWrite("not json", { log: (l) => logs.push(l) }), null);
  assert.equal(lookWrite(JSON.stringify({ decisions: { visualLanes: "Designer" } }), { log: (l) => logs.push(l) }), null, "not a list");
  assert.equal(lookWrite(JSON.stringify({ decisions: { visualLanes: ["<b>"] } })), null, "a name the config refuses");
  assert.equal(lookWrite(JSON.stringify({ decisions: { visualLanes: Array.from({ length: 21 }, (_, i) => `R${i}`) } })), null, "more than 20");
  assert.equal(logs.length, 2);
});

test("the evidence job posts look with the evidence, from the board config it reads, and a config it cannot read posts none", async () => {
  const CONFIG = JSON.stringify({ collector: { repoPath: "/r" }, decisions: { visualLanes: ["Designer", "Demos"] } });
  const read = (cfg) => (p) => { if (p === "/c") { if (cfg === null) throw new Error("none"); return cfg; } if (p === "/s/state.json") return JSON.stringify({ v: 1, board: { boardId: "b", at: 1 }, cards: {}, agents: {} }); throw new Error("none"); };
  const posted = [];
  const run = (cfg) => evidenceJob({
    job: "evidence", base: "https://x.example", headers: {}, configPath: "/c", stateFile: "/s/state.json", build: async () => {}, read: read(cfg), ghCheck: () => true,
    deployRead: async () => ({ worker: "", tree: "" }), liveFetch: async () => ({ ok: false, status: 500 }), log: () => {},
    fetchImpl: async (url, o) => { posted.push(JSON.parse(o.body)); return { ok: true, status: 200 }; }, e2e: { read: () => { throw new Error("none"); } },
  });
  await run(CONFIG);
  assert.deepEqual(posted.find((b) => b.key === "look")?.value, { visualLanes: ["Designer", "Demos"] });
  posted.length = 0;
  await run(null);
  assert.equal(posted.some((b) => b.key === "look"), false, "no config read: nothing posted, the store keeps its last list");
});

test("the store takes look only from the probe, and only as { visualLanes: up to 20 names }", () => {
  assert.equal(evidenceRefusal("look", { visualLanes: ["Designer"] }, "probe"), null);
  assert.equal(evidenceRefusal("look", { visualLanes: [] }, "probe"), null);
  assert.equal(evidenceRefusal("look", { visualLanes: ["Designer"] }, "Manager")?.rule, "only-probe-writes-status");
  for (const bad of [null, [], "x", {}, { visualLanes: "Designer" }, { visualLanes: [1] }, { visualLanes: ["<b>"] }, { visualLanes: ["A"], extra: 1 }, { visualLanes: Array.from({ length: 21 }, (_, i) => `R${i}`) }]) assert.equal(evidenceRefusal("look", bad, "probe")?.rule, "look-shape", JSON.stringify(bad));
});

test("a Decision on a card of a visual lane needs a picture per option, though its words are not about the look; a lane's second role too", async () => {
  const db = await seeded({ lanes: ["Designer", "Demos"] });
  for (const card of ["design-card", "demo-card"]) {
    const bad = await createAsk(db, NOW, plain({ card_id: card }));
    assert.equal(bad.ok, false, card);
    assert.equal(bad.refused.rule, "look-needs-screenshots");
    assert.match(bad.refused.detail, /missing: A, B\)/);
    const part = await createAsk(db, NOW, plain({ card_id: card, screenshots: [`${RED} A: left`] }));
    assert.match(part.refused.detail, /missing: B\)/);
    const ok = await createAsk(db, NOW, plain({ card_id: card, screenshots: [`${RED} A: left`, `${BLUE} B: right`] }));
    assert.equal(ok.ok, true, JSON.stringify(ok));
  }
  const viaThread = await askFromTool(db, NOW, "Manager", plain({ card_id: "design-card", related_thread: "none" }));
  assert.equal(viaThread.refused?.rule, "look-needs-screenshots", "Manager's Decision with related_thread none goes through the same rule");
});

// Checker F1 on 9ca3004: askFromTool's related_thread path checks the lane once, before postMessage (which reads words only). Dropping lookContext
// there left every test green, because the none path was covered by createAsk's own check.
test("a Decision posted in a known thread (related_thread, not none) on a lane card needs its pictures too, and posts with them", async () => {
  const db = await seeded({ lanes: ["Designer"] });
  const bad = await askFromTool(db, NOW, "Manager", plain({ card_id: "design-card", related_thread: "code-card" }));
  assert.equal(bad.ok, false);
  assert.equal(bad.refused?.rule, "look-needs-screenshots", JSON.stringify(bad));
  const other = await askFromTool(db, NOW, "Manager", plain({ card_id: "code-card", related_thread: "design-card" }));
  assert.equal(other.ok, true, "a card outside the lanes is not held to it: " + JSON.stringify(other));
  const ok = await askFromTool(db, NOW, "Manager", plain({ card_id: "design-card", related_thread: "code-card", screenshots: [`${RED} A: left`, `${BLUE} B: right`] }));
  assert.equal(ok.ok, true, JSON.stringify(ok));
});

test("must still allow: a non-look Decision on a card outside the lanes, one with no card, a lane card's Decision with a picture per option or with Something else / Not now, and a config with no lanes", async () => {
  const db = await seeded({ lanes: ["Designer", "Demos"] });
  assert.equal((await createAsk(db, NOW, plain({ card_id: "code-card" }))).ok, true, "a card of another role");
  assert.equal((await createAsk(db, NOW, plain())).ok, true, "no card");
  assert.equal((await createAsk(db, NOW, plain({ card_id: "design-card", options: ["Left", "Something else"], recommended: "Left", screenshots: [`${RED} A: left`] }))).ok, true, "Something else needs none");
  assert.equal((await createAsk(db, NOW, plain({ card_id: "design-card", options: ["Left", "Not now"], recommended: "Left", screenshots: [`${RED} A: left`] }))).ok, true, "Not now needs none");
  const empty = await seeded({ lanes: [] });
  assert.equal((await createAsk(empty, NOW, plain({ card_id: "design-card" }))).ok, true, "an empty lane list covers nothing");
  const never = await seeded();
  assert.equal((await createAsk(never, NOW, plain({ card_id: "design-card" }))).ok, true, "no look evidence posted yet: the words decide alone, as before");
  // The words still decide on a card outside the lanes.
  assert.equal((await createAsk(db, NOW, plain({ card_id: "code-card", title: "Which hero?" }))).refused?.rule, "look-needs-screenshots");
});

test("a lane taken out of the config stops counting at the next post, and an import (now = null) keeps its shape", async () => {
  const db = await seeded({ lanes: ["Designer"] });
  assert.equal((await createAsk(db, NOW, plain({ card_id: "design-card" }))).ok, false);
  assert.equal((await writeEvidence(db, NOW + 1, "probe", "look", { visualLanes: [] })).ok, true);
  assert.equal((await createAsk(db, NOW, plain({ card_id: "design-card" }))).ok, true);
  assert.equal(askRefusal(plain({ card_id: "design-card" }), null, { lanes: ["Designer"], cardOwner: "Designer" }), null, "an import is not held to the live rule");
});

test("the pure parts: inVisualLane and lookRefusal with lane", () => {
  assert.equal(inVisualLane("Designer", ["Designer"]), true);
  assert.equal(inVisualLane("Designer", []), false);
  assert.equal(inVisualLane(null, ["Designer"]), false);
  assert.equal(inVisualLane("Designer", undefined), false);
  const opts = [{ key: "A", label: "Left" }, { key: "B", label: "Right" }];
  assert.equal(lookRefusal({ texts: ["Which order?"], options: opts, shots: [], lane: true })?.rule, "look-needs-screenshots");
  assert.equal(lookRefusal({ texts: ["Which order?"], options: opts, shots: [] }), null);
});
