// Wake only for the lead (#C678): a nudge or conflict about one agent's card goes to that agent's watch, not the lead's,
// unless the agent has no open session or is not on the roster; a bare Ack, Close or Done... (the page's side is in
// board-wake.test.mjs). Here: the marker, the two readers, and the lines the probe prints.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fullConfig } from "../scripts/config.mjs";
import { nudges, roleFor } from "../collector/nudges.mjs";
import { routeOf, routedLine, linesFor, linesPending, linesSeen, linesSeenFile, LINES_FILE, LINES_SEEN_FILE, WAKE_ROLES_FILE } from "../gate/reset.mjs";
import { tick, roleTick } from "../scripts/wake-watch.mjs";

const config = fullConfig({ owner: "Sam", roster: ["Manager", "Builder", "Checker"], collector: { repoPath: "/x", deployWorkflow: "CI" } });
const HOUR = 3600e3, NOW = 100 * HOUR;
const card = (extra = {}) => ({ id: "menu", num: 700, status: "active", phase: "ship", size: "S", who: "Builder", doneWhen: ["a", "b"], ...extra });
const nudgeLines = (k) => nudges({ config, docs: { initiatives: [k], steps: [], ctx: [] }, now: NOW, state: {} }).lines;

test("the marker: kind, @Role, a space; anything else is not routed", () => {
  assert.equal(routedLine("NUDGE", "Builder", "menu: x"), "NUDGE @Builder menu: x");
  assert.equal(routeOf("NUDGE @Builder menu: x"), "Builder");
  assert.equal(routeOf("CONFLICT @Checker menu: x"), "Checker");
  for (const l of ["NUDGE menu: x", "NUDGE @ menu", "KEEPER @Builder x", "NUDGE @Bad!Role x", "NUDGE @Builder"]) assert.equal(routeOf(l), null, l);
});

test("roleFor: a plain role name that is not the lead", () => {
  assert.equal(roleFor("Builder", config), "Builder");
  assert.equal(roleFor("Manager", config), null, "the lead reads its own");
  for (const bad of [undefined, null, 4, "", "has space", "x".repeat(40), "@x"]) assert.equal(roleFor(bad, config), null);
});

test("linesFor: the lead keeps unmarked lines and those whose role is away, off the roster or the lead; a role gets its own", () => {
  const lines = ["NUDGE @Builder a", "NUDGE @Checker b", "CONFLICT @Ghost c", "CONFLICT d", "NUDGE @Manager e"];
  const lead = { lead: "Manager", roster: ["Manager", "Builder", "Checker"], away: ["Checker"] };
  assert.deepEqual(linesFor(lines, null, lead), ["NUDGE @Checker b", "CONFLICT @Ghost c", "CONFLICT d", "NUDGE @Manager e"]);
  assert.deepEqual(linesFor(lines, "Builder"), ["NUDGE @Builder a"]);
  assert.deepEqual(linesFor(lines, "Checker"), ["NUDGE @Checker b"]);
});

test("the Collector marks a nudge about one agent's card for that agent, and says it once, with nothing to forward", () => {
  const out = nudgeLines(card({ phase: "live" }));
  assert.equal(out.length, 1);
  assert.match(out[0], /^NUDGE @Builder HALF-LIVE menu \(#C700\)/);
  const lead = nudgeLines(card({ phase: "live", who: "Manager" }));
  assert.match(lead[0], /^NUDGE HALF-LIVE menu/, "a card of the lead's is the lead's own");
  const nobody = nudgeLines(card({ phase: "live", who: undefined }));
  assert.match(nobody[0], /^NUDGE HALF-LIVE menu/);
});

test("a forward-to nudge goes straight to the role it named", () => {
  const steps = [{ id: "s1", init: "menu", phase: "live", kind: "end", who: "Release", version: "1.2.3", at: NOW - HOUR }];
  const cfg = fullConfig({ owner: "Sam", roster: ["Manager", "Release"], collector: { repoPath: "/x", deployWorkflow: "CI", livePhase: "live" } });
  const out = nudges({ config: cfg, docs: { initiatives: [card({ phase: "live", doneWhen: undefined })], steps, ctx: [] }, now: NOW, state: {}, releaseTimes: {} }).lines;
  const routed = out.filter((l) => routeOf(l) === "Release");
  if (routed.length) { assert.equal(routed.length, 1); assert.doesNotMatch(routed[0], /forward to/); assert.match(routed[0], /ship times/); }
});

function folder() { const d = mkdtempSync(join(tmpdir(), "wake678-")); return d; }
const batchFile = (dir, lines, at = 1000) => writeFileSync(join(dir, LINES_FILE), JSON.stringify({ at, lines }));

test("the lead's watch skips a line marked for an agent with an open session, and prints one for an agent that has none", () => {
  const dir = folder();
  try {
    batchFile(dir, ["NUDGE @Builder one", "NUDGE @Checker two", "NUDGE three"]);
    writeFileSync(join(dir, WAKE_ROLES_FILE), JSON.stringify({ at: 1, roles: ["Checker"], missing: [] }));
    const out = tick(dir, 5000, 4242, ["Manager", "Builder", "Checker"], "Manager");
    assert.match(out, /NUDGE @Checker two/);
    assert.match(out, /NUDGE three/);
    assert.doesNotMatch(out, /@Builder/);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, LINES_SEEN_FILE), "utf8")), linesSeen({ at: 1000 }), "the batch is marked seen");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the agent's own watch prints the lines marked for it, once per batch, and not the lead's lines", () => {
  const dir = folder();
  try {
    batchFile(dir, ["NUDGE @Builder one", "CONFLICT @Builder two", "NUDGE @Checker other", "NUDGE for the lead"]);
    const out = roleTick(dir, "Builder", 5000, 4242);
    assert.equal(out, "NUDGE @Builder one\nCONFLICT @Builder two");
    assert.ok(existsSync(join(dir, linesSeenFile("Builder"))));
    assert.equal(roleTick(dir, "Builder", 6000, 4242), null, "the same batch is not printed twice");
    batchFile(dir, ["NUDGE @Builder fresh"], 2000);
    assert.equal(roleTick(dir, "Builder", 7000, 4242), "NUDGE @Builder fresh", "a new batch is");
    batchFile(dir, ["NUDGE @Checker other"], 3000);
    assert.equal(roleTick(dir, "Checker", 8000, 4242), "NUDGE @Checker other", "each role has its own seen file");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("linesPending with a role never returns another's line", () => {
  assert.deepEqual(linesPending({ at: 1, lines: ["NUDGE @Builder a", "NUDGE b"] }, null, { role: "Builder" }), ["NUDGE @Builder a"]);
  assert.deepEqual(linesPending({ at: 1, lines: ["NUDGE @Builder a"] }, { at: 1 }, { role: "Builder" }), []);
});
