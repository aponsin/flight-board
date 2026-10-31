// Which comment thread the owner's pings for an item go to (#C509) is the board's page's alone (#C515, Security's LOW on
// 10cd2d8d): pingThreads/<ref>.threadId pointed elsewhere by an agent would land the owner's pings anchored in another
// thread. The gate refuses every agent write to pingThreads, the lead's too; the page writes it through its own db.
import test from "node:test";
import assert from "node:assert/strict";
import { fullConfig } from "../scripts/config.mjs";
import { checkWrites, writeErrors } from "../gate/rules.mjs";
import { writesOf } from "../gate/gate.mjs";

const config = fullConfig({ artifactUrl: "https://claude.ai/" + "artifact/TestBoard01" });
const now = 1_793_000_000_000;
const lead = { role: "Manager", manager: true }, agent = { role: "Builder", manager: false };
const point = { op: "set", collection: "pingThreads", doc_id: "t-1", data: { threadId: "th_another", at: now } };

test("an agent's set, update or delete on pingThreads is refused, the lead's too", () => {
  for (const who of [agent, lead]) {
    for (const w of [point, { ...point, op: "update" }, { op: "delete", collection: "pingThreads", doc_id: "t-1" }]) {
      const e = writeErrors(w, { config, who, now });
      assert.equal(e.length, 1, `${who.role} ${w.op}`);
      assert.match(e[0], /^only the board.s page writes pingThreads/);
    }
  }
});

test("refused through the whole gate, alone or inside a batch with writes that pass", () => {
  assert.equal(checkWrites([point], { config, who: lead, now, state: {} }).errors.length, 1);
  const step = { op: "set", collection: "steps", doc_id: "x-build-start-1", data: { init: "x", phase: "build", who: "Builder", kind: "start", at: now - 1 } };
  const batch = writesOf({ action: "batch", writes: [step, { ...point, doc_id: "ctx-Builder" }] });
  const e = checkWrites(batch, { config, who: agent, now, state: {} }).errors;
  assert.ok(e.some((x) => /^pingThreads\/ctx-Builder: only the board.s page writes pingThreads/.test(x)), e.join("\n"));
});

test("other collections are untouched: an agent still logs a step", () => {
  const step = { op: "set", collection: "steps", doc_id: "x-build-start-1", data: { init: "x", phase: "build", who: "Builder", kind: "start", at: now - 1 } };
  assert.deepEqual(writeErrors(step, { config, who: agent, now }), []);
});
