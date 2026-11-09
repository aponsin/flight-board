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
