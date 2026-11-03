// #C632: every open flight-board card read null (no branch, no sign-off) because the probe handed cards with no repo field
// and no listed id prefix to the team's own repository. A card now belongs to the repository whose branches name it; and
// when no open card past plan shows a branch commit for 10 minutes the chip goes red and the lead's watch prints one line.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadNames } from "./harness.mjs";
import { cardStates, buildState } from "../collector/state.mjs";
import { stateErrors } from "../collector/state-schema.mjs";
import { evidenceAt, noEvidenceSince, noEvidencePending, noEvidenceLine, NOEVIDENCE_FILE, EVIDENCE_STALE_MS } from "../gate/reset.mjs";
import { tick } from "../scripts/wake-watch.mjs";
import { fullConfig } from "../scripts/config.mjs";

const NOW = 1_800_000_000_000, MIN = 60e3;
const hh = (t) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const SHA = "a".repeat(40);

const config = fullConfig({ collector: { repoPath: "/x", repos: [{ name: "flight-board", path: "/y", idPrefixes: ["board-"], notes: { checker: "refs/notes/checker" } }] } });
const gitStub = (args) => { throw new Error("no git here"); };
const repo = (branches) => ({ git: gitStub, tips: branches.map((b) => ({ branch: b, sha: SHA, at: NOW - MIN, message: "" })), main: "main", remote: "origin", notes: {}, ids: {} });

test("a card with no repo field and no listed prefix finds its branch in the repository that has one", () => {
  const repos = { "": repo(["main", "admin/other"]), "flight-board": repo(["main", "build/roster-all-owners"]) };
  const out = cardStates({ cards: [{ id: "roster-all-owners", num: 633, phase: "build" }], config, repos, now: NOW });
  assert.equal(out["roster-all-owners"].headSha12, "a".repeat(12), "found in the flight-board repository");
});

test("the team's own repository still wins when it has the branch, and a card nobody has a branch for stays as declared", () => {
  const repos = { "": repo(["main", "build/both"]), "flight-board": repo(["main", "build/both"]) };
  const out = cardStates({ cards: [{ id: "both", phase: "build" }, { id: "nowhere", phase: "plan" }], config, repos, now: NOW });
  assert.equal(out.both.headSha12, "a".repeat(12));
  assert.equal(out.nowhere.headSha12, null);
  assert.equal(out.nowhere.phase, "plan");
});

test("a card with its own repo field or a listed prefix is not looked up elsewhere", () => {
  const repos = { "": repo(["main", "build/board-x"]), "flight-board": repo(["main"]) };
  const out = cardStates({ cards: [{ id: "board-x", phase: "build" }], config, repos, now: NOW });
  assert.equal(out["board-x"].headSha12, null, "board- is the flight-board repository's: no tip there, as before");
});

test("evidenceAt: now when enough open cards past plan are too few to say or one shows a commit; else the last time, the clock starting at the first empty run", () => {
  const c = (phase, headSha12 = null) => ({ phase, headSha12 });
  const blind = { a: c("build"), b: c("test"), d: c("checker") };
  assert.equal(evidenceAt({ a: c("build"), b: c("plan") }, NOW, null), NOW, "fewer than three past plan: nothing to say");
  assert.equal(evidenceAt({ ...blind, e: c("build", "b".repeat(12)) }, NOW, NOW - 30 * MIN), NOW, "one card shows a commit");
  assert.equal(evidenceAt(blind, NOW, NOW - 12 * MIN), NOW - 12 * MIN, "nothing: the last time stays");
  assert.equal(evidenceAt(blind, NOW, null), NOW, "no earlier time: the clock starts now");
  assert.equal(evidenceAt(blind, NOW, NOW + MIN), NOW, "a time in the future is none");
  assert.equal(noEvidenceSince(NOW - 11 * MIN, NOW), NOW - 11 * MIN);
  assert.equal(noEvidenceSince(NOW - 9 * MIN, NOW), null);
  assert.equal(EVIDENCE_STALE_MS, 10 * MIN);
});

test("the state carries evidenceAt, and a probe without it still fits", () => {
  const s = buildState({ id: "flight-board", now: NOW, probe: null, pageVersion: null, cards: {}, agents: {}, evidence: NOW - MIN });
  assert.equal(s.board.evidenceAt, NOW - MIN);
  const old = structuredClone(s); delete old.board.evidenceAt;
  assert.deepEqual(stateErrors(old), []);
  const bad = structuredClone(s); bad.board.evidenceAt = "a while ago";
  assert.ok(stateErrors(bad).length);
});

test("the lead's watch prints one NOEVIDENCE line per outage and again only for a new one", () => {
  const dir = mkdtempSync(join(tmpdir(), "noev-"));
  const put = (since) => writeFileSync(join(dir, NOEVIDENCE_FILE), JSON.stringify({ since, at: NOW }));
  put(null);
  assert.equal(tick(dir, NOW), null, "no outage");
  put(NOW - 12 * MIN);
  assert.equal(tick(dir, NOW), noEvidenceLine(NOW - 12 * MIN));
  assert.equal(tick(dir, NOW + MIN), null, "once per outage");
  put(null);
  assert.equal(tick(dir, NOW + 2 * MIN), null, "evidence is back");
  put(NOW + 3 * MIN);
  assert.equal(tick(dir, NOW + 14 * MIN), noEvidenceLine(NOW + 3 * MIN), "a new outage");
  assert.match(noEvidenceLine(NOW), /^NOEVIDENCE: .* since \d\d:\d\d UTC/);
  assert.equal(noEvidencePending({ since: NOW }, { since: NOW }), false);
  assert.equal(noEvidencePending({ since: "x" }, null), false, "only a time is an outage");
  assert.ok(readFileSync(join(dir, "no-evidence-seen.json"), "utf8").includes(String(NOW + 3 * MIN)));
});

test("the chip goes red 10 minutes after the last time a card showed evidence, and says when", () => {
  const now = Date.now();
  const make = (extra) => {
    const b = loadNames(["managerChip", "set:(p)=>{probe=p}"]);
    b.state.messages = [];
    b.set({ v: 1, board: { at: now, wakeAliveAt: now - 5e3, wakeSeenAt: null, ...extra }, cards: {}, agents: {} });
    return JSON.parse(JSON.stringify(b.managerChip(now)));
  };
  assert.equal(make({ evidenceAt: now - 9 * MIN }).text, "Manager listening", "inside 10 minutes");
  assert.deepEqual(make({ evidenceAt: now - 11 * MIN }), { cls: "bad", text: `Card checks found nothing since ${hh(now - 11 * MIN)}` });
  assert.equal(make({}).text, "Manager listening", "a probe from before #C632 says nothing of it");
  assert.equal(make({ evidenceAt: now - 11 * MIN, wakeAliveAt: null }).text, "Manager not listening · say wake up the team", "the Manager's red comes first");
});
