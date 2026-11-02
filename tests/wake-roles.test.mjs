// Roles to wake after a crash or a reset (#C583, Manager's design): the probe lists the roster roles with no open session;
// those with work waiting (wake-by-need) are asked for as "WAKE <role>", the rest are one "ROSTER missing" line; each once
// per spell, printed by the lead's wake watch. A script can't message a session, so the lead sends the wakes.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wakeNeeds, askOnce } from "../collector/readings.mjs";
import { tick } from "../scripts/wake-watch.mjs";

const T = 1_800_000_000_000;
const roster = ["Manager", "Builder", "Checker", "Security", "Release"];

test("a roster role with no open session and a card of its own is to be woken; the others are only missing", () => {
  const agents = { Builder: { state: "idle" } };
  const cards = [{ who: "Checker", status: "queued" }, { who: "Release", status: "done" }, { who: "Builder", status: "active" }, { who: "Security", status: "paused" }, null];
  assert.deepEqual(wakeNeeds({ roster, agents, cards, lead: "Manager" }), { wake: ["Checker"], missing: ["Release", "Security"] });
  assert.deepEqual(wakeNeeds({ roster, agents: {}, cards: [], lead: "Manager" }), { wake: [], missing: ["Builder", "Checker", "Release", "Security"] }, "the lead is never listed");
  assert.deepEqual(wakeNeeds({ roster: ["bad role", "Ok"], agents: {}, cards: [{ who: "Ok", status: "queued" }] }), { wake: ["Ok"], missing: [] }, "an odd role name is dropped");
});

test("a role is asked once per spell, and again after it was back", () => {
  const first = askOnce(["Checker"], null, T);
  assert.deepEqual(first, { roles: { Checker: T }, fresh: ["Checker"] });
  assert.deepEqual(askOnce(["Checker"], { roles: first.roles }, T + 60e3), { roles: { Checker: T }, fresh: [] }, "not again while missing");
  assert.deepEqual(askOnce([], { roles: first.roles }, T + 120e3), { roles: {}, fresh: [] }, "back: forgotten");
  assert.deepEqual(askOnce(["Checker"], { roles: {} }, T + 180e3).fresh, ["Checker"], "gone again: asked again");
});

test("with the config's roster the watch names only roster roles: a planted file can't wake or reset a stranger", () => {
  const dir = mkdtempSync(join(tmpdir(), "roster-"));
  writeFileSync(join(dir, "context-reset.json"), JSON.stringify({ at: T, roles: { Builder: T, Stranger: T } }));
  writeFileSync(join(dir, "wake-roles.json"), JSON.stringify({ at: T, roles: { Checker: T, Intruder: T }, missing: { Mallory: T } }));
  writeFileSync(join(dir, "owner-asks.json"), JSON.stringify({ at: T, asks: [{ card: "a-card", role: "Builder", since: T }, { card: "b-card", role: "Eve", since: T }] }));
  const out = tick(dir, T, 1, ["Builder", "Checker"]).split("\n");
  assert.equal(out.length, 3);
  assert.ok(out.some((l) => l.startsWith("CONTEXT RESET Builder")));
  assert.ok(out.some((l) => l.startsWith("WAKE Checker")));
  assert.ok(out.some((l) => l.startsWith("ASK Builder a-card")));
  assert.equal(out.some((l) => /Stranger|Intruder|Mallory|Eve/.test(l)), false);
  assert.match(tick(mkdtempSync(join(tmpdir(), "roster-")), T, 1, ["Builder"]) ?? "none", /none/);
});

test("the wake watch prints WAKE lines and one ROSTER line, once", () => {
  const dir = mkdtempSync(join(tmpdir(), "wake-roles-"));
  assert.equal(tick(dir, T), null);
  writeFileSync(join(dir, "wake-roles.json"), JSON.stringify({ at: T, roles: { Checker: T }, missing: { Release: T, Security: T } }));
  assert.equal(tick(dir, T + 1000), "WAKE Checker: no open session and it has work; wake it\nROSTER missing: Release, Security (no open session, no work waiting)");
  assert.equal(tick(dir, T + 2000), null, "printed once");
  writeFileSync(join(dir, "wake-roles.json"), JSON.stringify({ at: T, roles: { Checker: T, Release: T + 5 }, missing: { Security: T } }));
  assert.equal(tick(dir, T + 3000), "WAKE Release: no open session and it has work; wake it", "Release now has work; Checker and Security are not repeated");
  assert.match(readFileSync(join(dir, "wake-roles-seen.json"), "utf8"), /Release/);
});
