// #C976 (Director check 1c; Manager's A): a board card on main and not yet deployed has its own wait row on ship, wait "install", so the time
// to the owner's install is stored. Must still allow, as tests: a product card (no install wait), a board card already live (its wait row
// closed), and the old rows left as they are (no backfill). The page's step log does not draw the new rows.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import { createCard, writeEvidence, readView, writeStep } from "../worker/board-store.mjs";
import { installWaitStep, INSTALL_WAIT } from "../worker/board-rules.mjs";
import { compatView } from "../worker/compat-view.mjs";

const T = 1_800_000_000_000;
const at = (p, onMain) => ({ lit: [p], phase: p, ...(onMain === undefined ? {} : { onMain }) });
const waits = async (db, id) => (await db.prepare("SELECT phase, kind, at, who, source, wait FROM phase_history WHERE card_id = ? AND wait IS NOT NULL ORDER BY id").bind(id).all()).results;
async function seed() {
  const db = makeDb();
  assert.equal((await createCard(db, T, "Manager", { id: "board-c", title: "A board card", owner_role: "Builder", repo: "flight-board" })).ok, true);
  assert.equal((await createCard(db, T, "Manager", { id: "prod-c", title: "A product card", owner_role: "Builder" })).ok, true);
  return db;
}

test("installWaitStep: start when a board card at ship is on main and none is open; end when that stops; nothing otherwise", () => {
  assert.equal(installWaitStep({ repo: "flight-board", next: "ship", onMain: true, open: false }), "start");
  assert.equal(installWaitStep({ repo: "flight-board", next: "ship", onMain: true, open: true }), null, "already waiting");
  for (const s of [{ next: "live", onMain: true }, { next: "ship", onMain: false }, { next: "checker", onMain: false }, { next: "ship", onMain: undefined }]) {
    assert.equal(installWaitStep({ repo: "flight-board", ...s, open: true }), "end", JSON.stringify(s));
    assert.equal(installWaitStep({ repo: "flight-board", ...s, open: false }), null, JSON.stringify(s));
  }
  for (const repo of [null, undefined, ""]) assert.equal(installWaitStep({ repo, next: "ship", onMain: true, open: false }), null, "a product card never waits on an install");
  assert.equal(INSTALL_WAIT, "install");
});

test("a board card: the wait opens when it is read on main at ship, once, and closes when it goes live", async () => {
  const db = await seed();
  await writeEvidence(db, T + 1, "probe", "cards.board-c", at("ship", false));
  assert.deepEqual(await waits(db, "board-c"), [], "signed but not on main: it waits for a release, not the install");
  await writeEvidence(db, T + 2, "probe", "cards.board-c", at("ship", true));
  await writeEvidence(db, T + 3, "probe", "cards.board-c", at("ship", true));
  assert.deepEqual(await waits(db, "board-c"), [{ phase: "ship", kind: "start", at: T + 2, who: "owner", source: "evidence", wait: "install" }], "one start, not one per reading");
  await writeEvidence(db, T + 9, "probe", "cards.board-c", at("live", true));
  assert.deepEqual((await waits(db, "board-c")).map((r) => [r.kind, r.at]), [["start", T + 2], ["end", T + 9]], "closed when live");
  await writeEvidence(db, T + 10, "probe", "cards.board-c", at("live", true));
  assert.equal((await waits(db, "board-c")).length, 2, "a live card adds nothing more");
});

test("a board card that leaves main at ship (a re-cut) closes the wait, and a new landing opens another", async () => {
  const db = await seed();
  await writeEvidence(db, T + 1, "probe", "cards.board-c", at("ship", true));
  await writeEvidence(db, T + 2, "probe", "cards.board-c", at("ship", false));
  await writeEvidence(db, T + 3, "probe", "cards.board-c", at("ship", true));
  assert.deepEqual((await waits(db, "board-c")).map((r) => [r.kind, r.at]), [["start", T + 1], ["end", T + 2], ["start", T + 3]]);
});

// Checker F1 on 027616a: the open-row read looks at install rows only. A newer step-tool wait (a busy start, or a busy end) must not
// stop the install wait opening, open a second one, or stop it closing.
test("a newer step-tool wait never changes the install wait: it still opens once and closes once", async () => {
  const db = await seed();
  await writeEvidence(db, T + 1, "probe", "cards.board-c", at("ship", false));
  assert.equal((await writeStep(db, T + 2, "Release", { init: "board-c", phase: "ship", kind: "start", wait: "busy" })).ok, true);
  await writeEvidence(db, T + 3, "probe", "cards.board-c", at("ship", true));
  assert.deepEqual((await waits(db, "board-c")).filter((r) => r.wait === INSTALL_WAIT).map((r) => [r.kind, r.at]), [["start", T + 3]], "an open busy start does not stop the install wait opening");
  assert.equal((await writeStep(db, T + 4, "Release", { init: "board-c", phase: "ship", kind: "end", wait: "busy" })).ok, true);
  await writeEvidence(db, T + 5, "probe", "cards.board-c", at("ship", true));
  assert.deepEqual((await waits(db, "board-c")).filter((r) => r.wait === INSTALL_WAIT).map((r) => [r.kind, r.at]), [["start", T + 3]], "a newer busy end does not open a second install wait");
  assert.equal((await writeStep(db, T + 6, "Release", { init: "board-c", phase: "ship", kind: "start", wait: "busy" })).ok, true);
  await writeEvidence(db, T + 7, "probe", "cards.board-c", at("live", true));
  await writeEvidence(db, T + 8, "probe", "cards.board-c", at("live", true));
  assert.deepEqual((await waits(db, "board-c")).filter((r) => r.wait === INSTALL_WAIT).map((r) => [r.kind, r.at]), [["start", T + 3], ["end", T + 7]], "a newer busy start does not stop it closing, once");
});

test("a product card at ship and on main gets no install wait", async () => {
  const db = await seed();
  await writeEvidence(db, T + 1, "probe", "cards.prod-c", at("ship", true));
  await writeEvidence(db, T + 2, "probe", "cards.prod-c", at("live", true));
  assert.deepEqual(await waits(db, "prod-c"), []);
});

test("the probe's own rows and the step tool's waits are untouched, and the page's step log leaves the install rows out", async () => {
  const db = await seed();
  await writeEvidence(db, T + 1, "probe", "cards.board-c", at("ship", true));
  assert.equal((await writeStep(db, T + 2, "Release", { init: "board-c", phase: "ship", kind: "start", wait: "busy" })).ok, true);
  assert.equal((await writeStep(db, T + 2, "Release", { init: "board-c", phase: "ship", kind: "start", wait: "install" })).ok, false, "the tool cannot write an install wait");
  const probeRows = (await db.prepare("SELECT phase, kind FROM phase_history WHERE card_id = 'board-c' AND wait IS NULL ORDER BY id").all()).results;
  assert.ok(probeRows.some((r) => r.phase === "ship" && r.kind === "start"), "the probe's ship row is there, wait empty");
  const view = compatView(await readView(db, T + 3));
  const steps = (view.collections?.steps ?? view.steps ?? []).filter((s) => s.init === "board-c");
  assert.ok(steps.some((s) => s.wait === "busy"), "the tool's wait is drawn");
  assert.ok(!steps.some((s) => s.wait === "install"), "the install wait is stored, not drawn");
});

test("migration 0028 copies every row as it is (old ship rows keep their empty wait, other waits keep theirs) and allows install", () => {
  const dir = fileURLToPath(new URL("../worker/migrations/", import.meta.url));
  // #C987: 0028 by name, not as the newest file (0029 came after it).
  const files = readdirSync(dir).filter((n) => n.endsWith(".sql")).sort();
  const at = files.indexOf("0028_install_wait.sql");
  assert.ok(at > 0, "0028 is there");
  const sql = new DatabaseSync(":memory:");
  for (const f of files.slice(0, at)) sql.exec(readFileSync(dir + f, "utf8"));
  const ins = sql.prepare("INSERT INTO phase_history (card_id, phase, kind, at, who, source, wait) VALUES (?, ?, ?, ?, ?, ?, ?)");
  ins.run("old-c", "ship", "start", T, "Release", "evidence", null);
  ins.run("old-c", "ship", "start", T, "Release", "tool", "gate");
  ins.run("old-c", "build", "end", T - 5, "Builder", "import", null);
  assert.throws(() => ins.run("old-c", "ship", "start", T + 1, "owner", "evidence", "install"), /CHECK/, "before 0028 install is refused");
  const before = sql.prepare("SELECT * FROM phase_history ORDER BY id").all().map((r) => ({ ...r }));
  sql.exec(readFileSync(dir + files[at], "utf8"));
  assert.deepEqual(sql.prepare("SELECT * FROM phase_history ORDER BY id").all().map((r) => ({ ...r })), before, "no backfill, nothing changed");
  ins.run("old-c", "ship", "start", T + 1, "owner", "evidence", "install");
  assert.throws(() => ins.run("old-c", "ship", "start", T + 2, "owner", "evidence", "waiting"), /CHECK/, "other words still refused");
  assert.throws(() => ins.run("old-c", "ship", "start", T, "Release", "evidence", null), /UNIQUE/, "the unique key is back");
});
