// #C661: the gate refuses a card write whose phase is not one of the board's phases, and the refusal names the form for a card
// waiting for the install ("ship" with wait "install"). Fictional board and card.
import test from "node:test";
import assert from "node:assert/strict";
import { fullConfig } from "../scripts/config.mjs";
import { writeErrors } from "../gate/rules.mjs";

const config = fullConfig({ artifactUrl: "https://claude.ai/" + "artifact/TestBoard01" });
const now = Date.UTC(2030, 0, 1, 4, 0);
const who = { role: "Smith", manager: false };
const lead = { role: "Lead", manager: true };
const write = (op, data, w = who) => writeErrors({ op, collection: "initiatives", doc_id: "card-x", data: { updatedAt: now, ...data } }, { config, who: w, now });
const unknown = (errs) => errs.filter((e) => /unknown phase/.test(e));

test("a card write with a phase the board does not list is refused, and the refusal names the waiting-for-install form", () => {
  for (const op of ["set", "update"]) {
    const errs = unknown(write(op, { phase: "install" }));
    assert.equal(errs.length, 1, op);
    assert.match(errs[0], /"install"/);
    assert.match(errs[0], /plan, build, test, language, checker, security, ship, live/, "the board's phases are listed");
    assert.match(errs[0], /"ship" with wait "install"/, "the way to say waiting for the install");
  }
  assert.equal(unknown(write("update", { phase: "install" }, lead)).length, 1, "the lead too");
});

test("every listed phase passes, and so does a write that names no phase (or a null one)", () => {
  for (const p of config.phases.map((x) => x[0])) assert.deepEqual(unknown(write("update", { phase: p })), [], p);
  assert.deepEqual(unknown(write("update", { name: "x" })), []);
  assert.deepEqual(unknown(write("update", { phase: null })), []);
  assert.deepEqual(unknown(write("update", { phase: "ship", wait: "install" })), [], "the form the refusal names passes");
});

test("a long or odd phase is cut and quoted in the message; a delete is not checked; another collection is not touched", () => {
  const long = unknown(write("update", { phase: "x".repeat(200) }))[0];
  assert.ok(long.length < 400, "cut");
  // A hard delete is refused earlier (tombstone it), with its own message; a tombstone naming no phase passes.
  assert.deepEqual(unknown(writeErrors({ op: "delete", collection: "initiatives", doc_id: "card-x", data: { phase: "install" } }, { config, who: lead, now })), []);
  assert.deepEqual(unknown(write("update", { deleted: true })), []);
  assert.deepEqual(unknown(writeErrors({ op: "set", collection: "waiting", doc_id: "w", data: { updatedAt: now, phase: "install" } }, { config, who, now })), []);
});
