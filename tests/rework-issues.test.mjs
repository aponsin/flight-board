// A rework is counted (#C468, board-issue-kinds; the owner's #T1170: #C465 went back for Designer's two findings and his
// own menu decision, and nothing asked anyone to count them). A rework signal is a review's end whose note starts
// "FINDINGS", or a second build start on a card that already has a review step. The Collector tells the lead
// "REWORK #C465: record its issues"; the gate refuses the lead's next update of that card until its issues' total is
// higher than before, with issuesAt set. The cards stay the lead's: no reviewer writes card fields.
import test from "node:test";
import assert from "node:assert/strict";
import { fullConfig } from "../scripts/config.mjs";
import { reworkOwed, issueTotal } from "../collector/rework.mjs";
import { mirrorErrors } from "../gate/rules.mjs";
import { nudges } from "../collector/nudges.mjs";

const config = fullConfig({ owner: "Owner" });
const MIN = 60e3, NOW = 1_800_000_000_000;
const step = (phase, kind, who, at, extra = {}) => ({ init: "c-465", phase, kind, who, at, ...extra });
const steps = [step("build", "start", "Builder", NOW - 60 * MIN), step("build", "end", "Builder", NOW - 40 * MIN),
  step("checker", "start", "Designer", NOW - 38 * MIN), step("checker", "end", "Designer", NOW - 35 * MIN, { note: "FINDINGS @1b18a850: menu collapses at 1280" })];
const card = { id: "c-465", num: 465, name: "Work page", size: "M", status: "active", phase: "build", who: "Builder", plan: "p", issues: { bugs: 0, security: 0, language: 0 } };
const mirror = (c = card, s = steps) => ({ docs: { initiatives: [c], steps: s, derived: [], messages: [], waiting: [], plan: [{ id: "p" }] } });
const MANAGER = { role: "Manager", manager: true };
const upd = (data) => ({ op: "update", collection: "initiatives", doc_id: "c-465", data });
const errs = (data, m = mirror(), who = MANAGER) => mirrorErrors(upd(data), { config, mirror: m, now: NOW, who }).filter((e) => /rework/.test(e));

test("the signals: a FINDINGS review end, or a build start after a review step; none on a clean run", () => {
  assert.equal(reworkOwed(card, steps, config)?.at, NOW - 35 * MIN, "Designer's FINDINGS");
  assert.equal(reworkOwed(card, steps.slice(0, 3), config), null, "a review open, no finding yet");
  const pass = [...steps.slice(0, 3), step("checker", "end", "Designer", NOW - 35 * MIN, { note: "LOOK-OK" })];
  assert.equal(reworkOwed(card, pass, config), null, "a review that passed");
  const rebuilt = [...pass, step("build", "start", "Builder", NOW - 30 * MIN)];
  assert.equal(reworkOwed(card, rebuilt, config)?.kind, "build", "a second build start after a review");
  assert.equal(reworkOwed(card, [step("build", "start", "Builder", NOW - 60 * MIN), step("test", "start", "Builder", NOW - 50 * MIN), step("build", "start", "Builder", NOW - 45 * MIN)], config), null, "test is the builder's lane, not a review");
  assert.equal(reworkOwed({ ...card, status: "done" }, steps, config), null, "a closed card owes nothing");
  assert.equal(reworkOwed(card, steps.map((s) => ({ ...s, init: "other" })), config), null, "another card's steps");
});

test("recorded: issuesAt at or after the signal; a card counted before this rule (issues, no issuesAt) is taken as counted", () => {
  assert.equal(reworkOwed({ ...card, issues: { design: 2 }, issuesAt: NOW - 30 * MIN }, steps, config), null);
  assert.ok(reworkOwed({ ...card, issues: { design: 2 }, issuesAt: NOW - 50 * MIN }, steps, config), "counted before this finding");
  assert.equal(reworkOwed({ ...card, issues: { design: 2, owner: 1 } }, steps, config), null, "#C465 as the board holds it");
  assert.equal(issueTotal({ bugs: 1, design: 2, owner: "x", security: -1 }), 3, "only whole counts of 0 or more");
});

test("the gate refuses the lead's next update until the count goes up with issuesAt, and says what to add", () => {
  const [e] = errs({ nextNote: "ships next" });
  assert.match(e, /^#C465 went back for rework \(FINDINGS by Designer at \d\d:\d\d UTC\): record it in this update: issues with a higher total than its 0 \(bugs, security, language, design, owner\) and issuesAt: now in ms/);
  assert.equal(errs({ issues: { design: 2 } }).length, 1, "issuesAt is needed too");
  assert.equal(errs({ issues: { bugs: 0 }, issuesAt: NOW }).length, 1, "the total must go up");
  assert.equal(errs({ issues: { ...card.issues, junk: 5 }, issuesAt: NOW }).length, 1, "only the known kinds count (Security on 505d4901)");
  assert.equal(errs({ issues: { ...card.issues, design: 2, owner: 1 }, issuesAt: NOW - 34 * MIN, nextNote: "x" }).length, 0, "counted: anything goes");
  assert.equal(errs({ issues: { design: 1 }, issuesAt: NOW - 36 * MIN }).length, 1, "an issuesAt before the finding");
  assert.equal(errs({ nextNote: "x" }, mirror(card, steps.slice(0, 3))).length, 0, "no signal: no rule");
  assert.equal(errs({ nextNote: "x" }, mirror(), { role: "Builder" }).length, 0, "only the lead's writes are held; the reviewers write no card fields");
  const batchStep = { op: "set", collection: "steps", doc_id: "s1", data: step("checker", "end", "Checker", NOW - MIN, { note: "FINDINGS @abc: x" }) };
  const counted = { ...card, issues: { design: 2 }, issuesAt: NOW - 30 * MIN };
  assert.equal(mirrorErrors(upd({ nextNote: "x" }), { config, mirror: mirror(counted), batch: [batchStep], now: NOW, who: MANAGER }).filter((x) => /rework/.test(x)).length, 1, "a finding in the same batch counts");
});

test("the Collector tells the lead: REWORK #C465: record its issues", () => {
  const { lines } = nudges({ config, docs: { initiatives: [card], steps, messages: [], waiting: [] }, now: NOW });
  assert.ok(lines.some((l) => /^NUDGE REWORK #C465: record its issues \(FINDINGS by Designer at \d\d:\d\d UTC\)/.test(l)), lines.join("\n"));
  const done = nudges({ config, docs: { initiatives: [{ ...card, issues: { design: 2 }, issuesAt: NOW - 30 * MIN }], steps, messages: [], waiting: [] }, now: NOW }).lines;
  assert.ok(!done.some((l) => /REWORK/.test(l)), "counted: no nudge");
});
