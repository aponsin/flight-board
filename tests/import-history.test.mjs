// The one-time import of the old step log as phase history (#C723 B3b): only the carried cards' start/end steps, once, as import rows.
import test from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import { plan, toSql } from "../collector/import-mirror.mjs";
import { writeEvidence } from "../worker/board-store.mjs";

const docs = {
  initiatives: { open: { name: "Open card", status: "active", level: "Quick", size: "S", num: 5, createdAt: 1 }, finished: { name: "Done card", status: "done", num: 4, createdAt: 1 } },
  steps: {
    a: { init: "open", phase: "build", kind: "start", at: 1000, who: "Builder" },
    b: { init: "open", phase: "build", kind: "end", at: 2000, who: "Builder" },
    c: { init: "open", phase: "checker", kind: "start", at: 2000, who: "Checker" },
    d: { init: "finished", phase: "build", kind: "start", at: 900, who: "Builder" },
    e: { init: "open", phase: "build", kind: "start", at: 1500, who: "Builder", wait: true },
    f: { init: "open", phase: "nonsense", kind: "start", at: 3000, who: "Builder" },
    g: { init: "open", phase: "build", kind: "ping", at: 3000, who: "Builder" },
  },
};

test("the carried card's start and end steps become import rows in time order; a done card's, a wait and nonsense are not carried", () => {
  const p = plan(docs, {});
  assert.deepEqual(p.history.map((h) => [h.card_id, h.phase, h.kind, h.at, h.who, h.source]), [
    ["open", "build", "start", 1000, "Builder", "import"], ["open", "build", "end", 2000, "Builder", "import"], ["open", "checker", "start", 2000, "Checker", "import"]]);
  assert.equal(p.skipped.steps, 1);
  assert.deepEqual(p.refused.filter((r) => r.kind === "step").map((r) => r.rule), ["step-shape", "step-shape", "step-shape"]);
});

test("done cards come in as history cards (not store cards) with their steps; a dropped one or one with no done time does not", () => {
  const done = (n, extra = {}) => ({ name: `Done ${n}`, status: "done", level: "Quick", size: "S", num: n, createdAt: 1000, doneAt: 9000, ...extra });
  const steps = {};
  for (const id of ["d1", "d2"]) ["plan", "build", "checker", "ship", "live"].forEach((ph, i) => { steps[`${id}-${ph}-s`] = { init: id, phase: ph, kind: "start", at: 1000 + i * 1000, who: "X" }; steps[`${id}-${ph}-e`] = { init: id, phase: ph, kind: "end", at: 1900 + i * 1000, who: "X" }; });
  const p = plan({ initiatives: { d1: done(1), d2: done(2), dropped: done(3, { dropped: true }), noTime: done(4, { doneAt: undefined }) }, steps }, {});
  assert.deepEqual(p.historyCards.map((h) => [h.id, h.title, h.size, h.review_level, h.done_at]), [["d1", "Done 1", "S", "Quick", 9000], ["d2", "Done 2", "S", "Quick", 9000]]);
  assert.equal(p.cards.length, 0); assert.equal(p.history.length, 20);
});

test("with done cards imported, the old page has medians: a card in build gets an ETA instead of a dash", async () => {
  const { readView } = await import("../worker/board-store.mjs"), { createCard } = await import("../worker/board-store.mjs");
  const { compatView } = await import("../worker/compat-view.mjs"), { render } = await import("../scripts/fixtures.mjs");
  const { readFileSync } = await import("node:fs");
  const H = 3_600_000, now = Date.now(), steps = {};
  const phases = ["plan", "build", "language", "checker", "security", "ship", "live"];
  for (const id of ["d1", "d2", "d3"]) phases.forEach((ph, i) => { steps[`${id}${ph}s`] = { init: id, phase: ph, kind: "start", at: now - 400 * H + i * H, who: "X" }; steps[`${id}${ph}e`] = { init: id, phase: ph, kind: "end", at: now - 400 * H + i * H + 0.9 * H, who: "X" }; });
  const done = (n) => ({ name: `Done ${n}`, status: "done", level: "Full", size: "S", num: n, createdAt: now - 401 * H, doneAt: now - 390 * H });
  const db = makeDb();
  const sql = toSql(plan({ initiatives: { d1: done(1), d2: done(2), d3: done(3) }, steps }, {}));
  for (const s of sql.split("\n").filter((l) => l.startsWith("INSERT"))) await db.prepare(s).run();
  await createCard(db, now - 3 * H, "Manager", { id: "live-card", title: "Live card", size: "S", review_level: "Full", owner_role: "Builder" });
  await writeEvidence(db, now - H, "probe", "cards.live-card", { lit: ["build"] });
  const c = compatView(await readView(db, now)).collections;
  assert.equal(c.initiatives.filter((i) => i.status === "done").length, 3);
  const board = render(readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8"), c).board;
  // With medians the ETA box reads "Live in <time>" with a real time; without them it reads "ETA" and a dash.
  const eta = /<div class="eta"><div class="lbl">([^<]*)<\/div><div class="big"[^>]*>([^<]*)<\/div>/.exec(board.slice(board.indexOf('data-card="live-card"')));
  assert.deepEqual([eta?.[1], /\d/.test(eta?.[2] ?? "")], ["Live in", true]);
});

test("the SQL runs twice with the same result, and a later evidence change adds its rows after the imported ones", async () => {
  const db = makeDb(); const sql = toSql(plan(docs, {}));
  for (let i = 0; i < 2; i++) db.exec ? db.exec(sql) : await Promise.all(sql.split("\n").filter(Boolean).map((s) => db.prepare(s).run()));
  const count = async () => (await db.prepare("SELECT COUNT(*) AS n FROM phase_history").first()).n;
  assert.equal(await count(), 3);
  // The first reading after the import: the history already has checker open, so the same phase adds nothing.
  await writeEvidence(db, 5000, "probe", "cards.open", { lit: ["checker"] });
  assert.equal(await count(), 3);
  // A later change ends checker (as its imported start's role) and starts security.
  await writeEvidence(db, 6000, "probe", "cards.open", { lit: ["security"] });
  const rows = (await db.prepare("SELECT phase, kind, who, source FROM phase_history WHERE at = 6000 ORDER BY id").all()).results;
  assert.deepEqual(rows, [{ phase: "checker", kind: "end", who: "Checker", source: "evidence" }, { phase: "security", kind: "start", who: "Security", source: "evidence" }]);
});
