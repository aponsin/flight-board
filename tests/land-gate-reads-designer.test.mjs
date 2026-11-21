// #C1407 (11-20 about 10 pm MT: Release's dry run for #C1406 at 261814e7 said "my gate did not ask for Designer", yet the tip changed page/board.template.html and Designer had put FINDINGS on that exact tip; Manager
// stopped the land by hand): the landing gate reads Designer's note (refs/notes/designer). A tip with Designer's FINDINGS is refused; a tip that changes page/ is refused without Designer's LOOK-OK on it (or on an earlier
// commit of the line with no change to page/ since); a page-free tip lands without Designer. The rule is collector/signoff.mjs's, read by the release tool's verdict and the landing job's plan. Real git for the facts.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { designerFacts, designerRefusals, DESIGNER_COPY } from "../collector/signoff.mjs";
import { verdict } from "../scripts/board-release.mjs";
import { landPlan } from "../scripts/board-land.mjs";

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "fb-designer-")), g = (args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  g(["init", "-q", "-b", "main"]); g(["config", "user.email", "t@example.com"]); g(["config", "user.name", "T"]);
  mkdirSync(join(dir, "page")); mkdirSync(join(dir, "worker"));
  writeFileSync(join(dir, "page/board.template.html"), "page\n"); writeFileSync(join(dir, "worker/a.mjs"), "a\n");
  g(["add", "-A"]); g(["commit", "-qm", "start"]);
  const main = g(["rev-parse", "HEAD"]);
  const commit = (file, msg) => { appendFileSync(join(dir, file), "x\n"); g(["add", "-A"]); g(["commit", "-qm", msg]); return g(["rev-parse", "HEAD"]); };
  const note = (sha, text) => g(["notes", "--ref=board-release/designer", "add", "-f", "-m", text, sha]);
  const quiet = (args) => { try { return g(args); } catch { return null; } };
  g(["checkout", "-qb", "build/a-card"]);
  return { main, commit, note, quiet, facts: (tip) => designerFacts({ quiet, main, tip }) };
}
const PAGE = "page/board.template.html", CODE = "worker/a.mjs";

test("the rule: FINDINGS refuses whatever the tip changes; a page change needs a LOOK-OK on the tip or an earlier one with no page change since; a page-free tip needs nothing; an unread fact is no pass", () => {
  assert.deepEqual(designerRefusals({ note: "FINDINGS #C1406: three findings", touchesPage: false, okBefore: false }).length, 1, "FINDINGS on a page-free tip");
  assert.match(designerRefusals({ note: "FINDINGS #C1406", touchesPage: true, okBefore: true })[0], /FINDINGS note stands on this tip/);
  assert.equal(designerRefusals({ note: null, touchesPage: true, okBefore: false }).length, 1, "a page change with no note");
  assert.match(designerRefusals({ note: null, touchesPage: true, okBefore: false })[0], /changes page\/ and has no LOOK-OK from Designer/);
  assert.deepEqual(designerRefusals({ note: "LOOK-OK #C1406: seen", touchesPage: true, okBefore: false }), []);
  assert.deepEqual(designerRefusals({ note: null, touchesPage: true, okBefore: true }), [], "an earlier LOOK-OK with no page change since");
  assert.deepEqual(designerRefusals({ note: null, touchesPage: false, okBefore: false }), [], "a page-free tip needs no Designer");
  assert.deepEqual(designerRefusals({ note: "LOOKS-OK-ish", touchesPage: false, okBefore: false }), []);
  assert.equal(designerRefusals({ note: "LOOKS-OK-ish", touchesPage: true, okBefore: false }).length, 1, "only the word LOOK-OK counts");
  assert.equal(designerRefusals({ note: null, touchesPage: null, okBefore: false }).length, 1, "a diff that could not be read is no pass");
  assert.deepEqual(designerRefusals(null), [], "no facts, no check (an older caller)");
});

test("real git: this #C1406 case is refused, a page-free tip passes without Designer, and a LOOK-OK tip passes", () => {
  const s = scratch();
  const pageTip = s.commit(PAGE, "A page change");
  assert.equal(designerRefusals(s.facts(pageTip)).length, 1, "a page change with no note");
  s.note(pageTip, "FINDINGS #C1406 build/x at 261814e7: three findings\nF1 the owner's name is cut");
  assert.match(designerRefusals(s.facts(pageTip))[0], /FINDINGS/, "this #C1406 case: Designer's FINDINGS on the exact tip");
  s.note(pageTip, "LOOK-OK #C1406: F1-F3 fixed\nDesigner");
  assert.deepEqual(designerRefusals(s.facts(pageTip)), [], "a LOOK-OK tip");
  const s2 = scratch();
  const codeTip = s2.commit(CODE, "A Worker change");
  assert.deepEqual(designerRefusals(s2.facts(codeTip)), [], "a page-free tip lands without Designer");
  assert.equal(s2.facts(codeTip).touchesPage, false);
});

test("real git: a LOOK-OK on an earlier commit of the line covers the tip only with no change to page/ since", () => {
  const s = scratch();
  const first = s.commit(PAGE, "A page change");
  s.note(first, "LOOK-OK #C1406: seen");
  const second = s.commit(CODE, "Then a Worker change");
  assert.equal(s.facts(second).okBefore, true);
  assert.deepEqual(designerRefusals(s.facts(second)), [], "no page change since the LOOK-OK");
  const third = s.commit(PAGE, "Then another page change");
  assert.equal(s.facts(third).okBefore, false);
  assert.equal(designerRefusals(s.facts(third)).length, 1, "a page change after the LOOK-OK needs its own");
  assert.equal(designerRefusals(designerFacts({ quiet: () => null, main: "x", tip: "y" })).length, 1, "git that fails reads no page fact: a refusal, never a pass");
  assert.equal(DESIGNER_COPY, "refs/notes/board-release/designer");
});

test("the release tool's verdict carries the refusals, and passes when there are none; a caller with no designer facts is as before", () => {
  const base = { forward: true, notes: { checker: "PASS", security: "SECURE" }, pinned: "abc", changed: [], owned: [], capabilities: [], mcpErrors: [] };
  assert.equal(verdict(base).ok, true, "no designer facts: as before");
  const refused = verdict({ ...base, designer: { note: "FINDINGS #C1406", touchesPage: true, okBefore: false } });
  assert.equal(refused.ok, false);
  assert.match(refused.refusals.join("\n"), /Designer's FINDINGS/);
  assert.equal(verdict({ ...base, designer: { note: null, touchesPage: true, okBefore: false } }).ok, false, "a page change with no LOOK-OK");
  assert.equal(verdict({ ...base, designer: { note: "LOOK-OK", touchesPage: true, okBefore: false } }).ok, true);
  assert.equal(verdict({ ...base, designer: { note: null, touchesPage: false, okBefore: false } }).ok, true, "a page-free tip");
});

test("the landing job's plan blocks a tip with Designer's FINDINGS or a page change with no LOOK-OK, and tries the rest", () => {
  const now = 1_800_000_000_000, holds = { at: now, cards: { "a-card": "" } };
  const head = (designer, extra = {}) => ({ branch: "build/a-card", sha: "a".repeat(40), notes: { checker: "PASS #C1406", security: "SECURE #C1406" }, cards: ["a-card"], onMain: false, forward: true, ahead: 1, dataLines: 0, designer, ...extra });
  const plan = (designer) => landPlan({ heads: [head(designer)], holds, now });
  const findings = plan({ note: "FINDINGS #C1406", touchesPage: true, okBefore: false });
  assert.equal(findings.try.length, 0);
  assert.match(findings.blocked[0].reasons[0], /Designer's FINDINGS/, "a refusal Release must see");
  assert.equal(plan({ note: null, touchesPage: true, okBefore: false }).blocked.length, 1, "a page change with no LOOK-OK");
  assert.equal(plan({ note: "LOOK-OK #C1406", touchesPage: true, okBefore: false }).try.length, 1, "a LOOK-OK tip is tried");
  assert.equal(plan({ note: null, touchesPage: false, okBefore: false }).try.length, 1, "a page-free tip is tried without Designer");
  assert.equal(landPlan({ heads: [head(undefined)], holds, now }).try.length, 1, "a head with no designer facts (an older caller) asks nothing more here");
});
