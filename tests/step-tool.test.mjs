// The step tool (board parity, after B4b): an agent logs a start or an end of a phase with the old step log's wait column; the card's wait
// ("release" / "install") for a card of another repository read at ship. Fictional cards.
import test from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import { createCard, writeEvidence, writeStep, readView, wakeAsk } from "../worker/board-store.mjs";
import { stepRefusal } from "../worker/board-rules.mjs";
import { compatView, derivedDoc } from "../worker/compat-view.mjs";
import { TOOLS } from "../worker/board-worker.mjs";

const NOW = 1_800_000_000_000, MIN = 60_000;
const rows = async (db) => (await db.prepare("SELECT card_id, phase, kind, at, who, source, wait FROM phase_history ORDER BY at, id").all()).results;

test("the tool is offered to agents only, takes no `who`, and names its parts", () => {
  const t = TOOLS.find((x) => x.name === "step");
  assert.deepEqual(t.roles, ["agent"]);
  assert.deepEqual(Object.keys(t.inputSchema.properties).sort(), ["at", "init", "kind", "phase", "wait"]);
  assert.deepEqual(t.inputSchema.required, ["init", "phase", "kind", "wait"], "only waits are logged: a work phase is the probe's");
  assert.deepEqual(t.inputSchema.properties.wait.enum, ["busy", "gate", "decision"]);
});

test("a step is stored with the writer that authenticated, the wait, and the time; a repeat is stored once", async () => {
  const db = makeDb();
  await createCard(db, NOW, "Manager", { id: "card-a", title: "A card" });
  assert.deepEqual(await writeStep(db, NOW, "Builder", { init: "card-a", phase: "build", kind: "start", wait: "gate", at: NOW - 5 * MIN }), { ok: true });
  assert.deepEqual(await writeStep(db, NOW, "Builder", { init: "card-a", phase: "build", kind: "start", wait: "busy", at: NOW - 5 * MIN }), { ok: true }, "two waits at one time are two rows");
  await writeStep(db, NOW, "Builder", { init: "card-a", phase: "build", kind: "start", wait: "busy", at: NOW - 5 * MIN });
  await writeStep(db, NOW, "Builder", { init: "card-a", phase: "build", kind: "end", wait: "gate" });
  assert.deepEqual(await rows(db), [
    { card_id: "card-a", phase: "build", kind: "start", at: NOW - 5 * MIN, who: "Builder", source: "tool", wait: "gate" },
    { card_id: "card-a", phase: "build", kind: "start", at: NOW - 5 * MIN, who: "Builder", source: "tool", wait: "busy" },
    { card_id: "card-a", phase: "build", kind: "end", at: NOW, who: "Builder", source: "tool", wait: "gate" },
  ]);
  const view = await readView(db, NOW);
  assert.equal(view.history.find((h) => h.wait === "busy").phase, "build");
  const steps = compatView(view).collections.steps;
  assert.deepEqual(steps.map((s) => s.wait), ["gate", "busy", "gate"], "the old page reads the wait from the step");
});

test("every way of being wrong is refused by name and stores nothing", async () => {
  const db = makeDb();
  await createCard(db, NOW, "Manager", { id: "card-a", title: "A card" });
  const ok = { init: "card-a", phase: "build", kind: "start", wait: "busy" };
  const bad = [
    [{ ...ok, init: "Bad Id" }, "step-card"], [{ ...ok, phase: "nope" }, "step-phase"], [{ ...ok, kind: "middle" }, "step-kind"],
    [{ ...ok, wait: "sleeping" }, "step-wait"], [{ init: "card-a", phase: "build", kind: "start" }, "step-wait"], [{ ...ok, wait: null }, "step-wait"], [{ ...ok, at: NOW + 5 * MIN }, "step-at"], [{ ...ok, at: NOW - 8 * 86_400_000 }, "step-at"],
    [{ ...ok, at: 1.5 }, "step-at"], [{ ...ok, who: "Manager" }, "unknown-field"], [{ ...ok, init: "card-zzz" }, "step-card-unknown"],
    [null, "step-shape"], [[ok], "step-shape"],
  ];
  for (const [a, rule] of bad) { const r = await writeStep(db, NOW, "Builder", a); assert.equal(r.ok, false, JSON.stringify(a)); assert.equal(r.refused?.rule ?? r.rule, rule, JSON.stringify(a)); }
  assert.deepEqual(await rows(db), []);
  assert.equal(stepRefusal(ok, NOW), null);
  assert.equal(stepRefusal({ ...ok, at: NOW }, NOW), null);
});

test("the evidence's own phase rows still land, once, beside the tool's (the rebuilt table and its key)", async () => {
  const db = makeDb();
  await createCard(db, NOW, "Manager", { id: "card-a", title: "A card" });
  await writeEvidence(db, NOW, "probe", "cards.card-a", { lit: ["build"], phase: "build" });
  await writeEvidence(db, NOW, "probe", "cards.card-a", { lit: ["build"], phase: "build" });
  await writeEvidence(db, NOW + MIN, "probe", "cards.card-a", { lit: ["checker"], phase: "checker" });
  const r = await rows(db);
  assert.deepEqual(r.map((x) => [x.phase, x.kind, x.source, x.wait]), [["build", "start", "evidence", null], ["build", "end", "evidence", null], ["checker", "start", "evidence", null]]);
});

// Checker's findings on 142d810: an agent's wait step is not the lit phase. It must not change who the lit phase's end is written for (F1),
// restart or silence another lane's stall clock (F2), or be taken for the phase the card was in at its first reading (F3).
test("F1: a wait started at the lit phase does not change whose end the phase gets", async () => {
  const db = makeDb();
  await createCard(db, NOW, "Manager", { id: "card-a", title: "A card" });
  await writeEvidence(db, NOW, "probe", "agents", { Checker: { state: "working", tool: "Bash", card: "card-a", since: NOW } });
  await writeEvidence(db, NOW, "probe", "cards.card-a", { lit: ["checker"], phase: "checker" });
  await writeStep(db, NOW + MIN, "Manager", { init: "card-a", phase: "checker", kind: "start", wait: "gate", at: NOW + MIN });
  await writeEvidence(db, NOW + 5 * MIN, "probe", "cards.card-a", { lit: ["security"], phase: "security" });
  const end = (await rows(db)).find((r) => r.phase === "checker" && r.kind === "end" && r.source === "evidence");
  assert.equal(end.who, "Checker", "the end belongs to the agent that started the phase, not to the one who logged a wait");
});

test("F2: another agent's wait start at the phase does not restart or silence the stall clock", async () => {
  const db = makeDb();
  await createCard(db, NOW, "Manager", { id: "card-a", title: "A card", owner_role: "Boardsmith" });
  await writeEvidence(db, NOW, "probe", "cards.card-a", { lit: ["checker"], phase: "checker", ci: "none" });
  await writeEvidence(db, NOW, "probe", "agents", { Checker: { state: "idle", tool: null, card: null, since: NOW } });
  assert.equal((await wakeAsk(db, NOW + 10 * MIN)).count, 0, "10 min: not yet");
  await writeStep(db, NOW + 14 * MIN, "Builder", { init: "card-a", phase: "checker", kind: "start", wait: "busy", at: NOW + 14 * MIN });
  assert.equal((await wakeAsk(db, NOW + 20 * MIN)).count, 1, "20 min of waiting at checker: a stall, whatever a wait step says at minute 14");
});

test("F3: at the first reading the card's previous phase is the history's last probe row, not an agent's wait start", async () => {
  const db = makeDb();
  await createCard(db, NOW, "Manager", { id: "card-a", title: "A card" });
  // The history already holds the import's open build phase; then an agent logs a wait at security; then the probe's first reading comes.
  await db.prepare("INSERT INTO phase_history (card_id, phase, kind, at, who, source) VALUES ('card-a', 'build', 'start', ?, 'Builder', 'import')").bind(NOW - 60 * MIN).run();
  await writeStep(db, NOW - 10 * MIN, "Manager", { init: "card-a", phase: "security", kind: "start", wait: "decision", at: NOW - 10 * MIN });
  await writeEvidence(db, NOW, "probe", "cards.card-a", { lit: ["checker"], phase: "checker" });
  const ends = (await rows(db)).filter((r) => r.kind === "end" && r.source === "evidence");
  assert.deepEqual(ends.map((r) => r.phase), ["build"], "the open build phase ends; the wait at security is not the phase the card was in");
});

// A card with a repo of its own, read at ship: waits for a board release until it is on main, then for the owner's deploy.
async function shipView({ repo, onMain, phase = "ship" }) {
  const db = makeDb();
  await createCard(db, NOW, "Manager", { id: "card-a", title: "A card", ...(repo ? { repo } : {}) });
  await writeEvidence(db, NOW, "probe", "cards.card-a", { lit: [phase], phase, ...(onMain === undefined ? {} : { onMain }) });
  return derivedDoc({ ...(await readView(db, NOW)), now: NOW }).cards["card-a"];
}
test("the card's wait: release before it is on main, install once it is; none for a live card, a card with no repo word, or no reading of main", async () => {
  assert.equal((await shipView({ repo: "flight-board", onMain: false })).wait, "release");
  assert.equal((await shipView({ repo: "flight-board", onMain: true })).wait, "install");
  assert.equal((await shipView({ repo: "flight-board", onMain: true, phase: "live" })).wait, undefined);
  assert.equal((await shipView({ repo: "flight-board", onMain: true, phase: "checker" })).wait, undefined);
  assert.equal((await shipView({ onMain: true })).wait, undefined, "the team's own flow: Release ships it, no wait word");
  assert.equal((await shipView({ repo: "flight-board" })).wait, undefined);
});
