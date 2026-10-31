// A READY left on a branch a later READY of the same card replaced never holds a shipped card open (#C494, Manager: the
// gate refused closing #C479 as live, "the repository says ship (READY at 0e4536fa)"). #C479's READY on
// demos/yogamason-makaan-words was re-cut as demos/yogamason-makaan-words-v2 (the same change, rebased onto v1.167.0,
// its CHANGELOG block resolved again, so no changeId matches) and that one shipped. A card's tip not on main is
// superseded once a newer commit of the same card is on main: one of its own tips, or a re-cut branch "<id>-v<N>".
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fullConfig } from "../scripts/config.mjs";
import { collect, inRepo } from "../collector/collect.mjs";

const T0 = 1_790_000_000;
const ID = "yogamason-makaan-words";
function repo() {
  const dir = mkdtempSync(join(tmpdir(), "fb-superseded-"));
  const work = join(dir, "repo"), bare = join(dir, "origin.git");
  let at = T0;
  const g = (args) => execFileSync("git", args, { cwd: work, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_COMMITTER_DATE: `${at} +0000`, GIT_AUTHOR_DATE: `${at} +0000` } });
  execFileSync("git", ["init", "-q", "--bare", bare]);
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  g(["config", "user.email", "t@example.com"]); g(["config", "user.name", "T"]); g(["remote", "add", "origin", bare]);
  const write = (t, files, msg) => { at = T0 + t; for (const [f, text] of Object.entries(files)) writeFileSync(join(work, f), text); g(["add", "-A"]); g(["commit", "-qm", msg]); return g(["rev-parse", "HEAD"]).trim(); };
  const sign = (sha) => g(["notes", "--ref=checker", "add", "-m", "PASS Quick", sha]);
  const sync = () => { g(["push", "-q", "--all", "-f", "origin"]); g(["push", "-q", "-f", "origin", "refs/notes/*:refs/notes/*"]); g(["fetch", "-q", "--prune", "origin"]); g(["fetch", "-q", "origin", "+refs/notes/*:refs/notes/flight-board/*"]); };
  write(0, { "CHANGELOG.md": "Newest first.\n\n## Unreleased\n\n### Fixed\n- P80 (#C473).\n", "site.json": "{\"p81\":\"Deck\"}\n" }, "start");
  return { dir, g, write, sign, sync, git: g, main: () => g(["rev-parse", "main"]).trim() };
}
// #C479: the READY (signed, no trailer) on the card's branch; v1.167.0 releases the Unreleased block on main; the re-cut
// on main resolves the CHANGELOG again (its own Unreleased heading), signed, and ships.
const WORDS = "{\"p81\":\"The Trex deck we built from the ground up\"}\n";
function c479({ ship = true } = {}) {
  const r = repo();
  r.g(["checkout", "-qb", `demos/${ID}`]);
  const ready = r.write(10, { "CHANGELOG.md": "Newest first.\n\n## Unreleased\n\n### Changed\n- P81-P87 in Makaan's words (#C479).\n\n### Fixed\n- P80 (#C473).\n", "site.json": WORDS }, "Yogamason: P81-P87 descriptions in Makaan's own words (#C479)");
  r.sign(ready);
  r.g(["checkout", "-q", "main"]);
  r.write(20, { "CHANGELOG.md": "Newest first.\n\n## 1.167.0\n\n### Fixed\n- P80 (#C473).\n" }, "v1.167.0: build/draft-photo-pinned@c8345cc2");
  r.g(["checkout", "-qb", `demos/${ID}-v2`]);
  const recut = r.write(30, { "CHANGELOG.md": "Newest first.\n\n## Unreleased\n\n### Changed\n- P81-P87 in Makaan's words (#C479).\n\n## 1.167.0\n\n### Fixed\n- P80 (#C473).\n", "site.json": WORDS }, "Yogamason: P81-P87 descriptions in Makaan's own words (#C479)");
  r.sign(recut);
  r.g(["checkout", "-q", "main"]);
  if (ship) { r.g(["merge", "-q", "--ff-only", `demos/${ID}-v2`]); r.write(40, { "VERSION": "1.167.2\n" }, "v1.167.2: demos/yogamason-makaan-words-v2@" + recut.slice(0, 8)); }
  r.sync();
  return { r, ready, recut };
}
const card = (id = ID) => ({ id, status: "active", level: "Quick", size: "XS", skip: ["plan", "language", "security"], phase: "ship" });
const cfg = (r) => fullConfig({ owner: "Sam", collector: { repoPath: r.dir, notes: { checker: "refs/notes/checker" }, deployWorkflow: "CI" } });
const run = (r, cards, more = {}) => collect({ config: cfg(r), cards, git: r.git, gh: () => JSON.stringify([{ headSha: r.main() }]), now: 1, ...more });

test("#C479: the old READY at 0e4536fa is superseded by the re-cut that shipped: the card reads live, no 2-branches line", () => {
  const { r, ready, recut } = c479();
  try {
    const { doc, conflicts } = run(r, [card()]);
    const d = doc.cards[ID];
    assert.equal(d.phase, "live", d.evidence);
    assert.equal(d.head, recut);
    assert.match(d.evidence, new RegExp(`demos/${ID} at ${ready.slice(0, 8)} is superseded: demos/${ID}-v2 at ${recut.slice(0, 8)} is on main`));
    assert.ok(!conflicts.some((l) => /branches/.test(l)), conflicts.join("\n"));
    assert.deepEqual(doc.liveButOpen, [ID], "the lead is told to close it, and the gate's close rule reads live");
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});

test("#C479: a live state still reading the old READY doesn't hold it at ship", () => {
  const { r, ready } = c479();
  try {
    const liveState = { cards: { [ID]: { phase: "ship", headSha12: ready.slice(0, 12) } } };
    assert.equal(run(r, [card()], { liveState }).doc.cards[ID].phase, "live");
    const moved = { cards: { [ID]: { phase: "checker", headSha12: "fedcbafedcba" } } };
    assert.equal(run(r, [card()], { liveState: moved }).doc.cards[ID].phase, "checker", "any other live reading is still taken");
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});

test("new work on the old branch after the re-cut shipped holds the card there, the re-cut no second branch", () => {
  const { r } = c479();
  try {
    r.g(["checkout", "-q", `demos/${ID}`]);
    const rework = r.write(50, { "site.json": "{\"p81\":\"a rework\"}\n" }, "a rework (#C479)");
    r.sign(rework); r.sync();
    const { doc, conflicts } = run(r, [card()]);
    assert.equal(doc.cards[ID].head, rework);
    assert.notEqual(doc.cards[ID].phase, "live");
    assert.ok(!conflicts.some((l) => /branches/.test(l)), conflicts.join("\n"));
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});

test("a re-cut not on main yet supersedes nothing: the card reads from its own READY, as before, with no second branch", () => {
  const { r, ready } = c479({ ship: false });
  try {
    const { doc, conflicts } = run(r, [card()]);
    assert.equal(doc.cards[ID].head, ready);
    assert.equal(doc.cards[ID].phase, "ship", doc.cards[ID].evidence);
    assert.ok(!conflicts.some((l) => /branches/.test(l)), conflicts.join("\n"));
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});

test("a branch named <id>-v2 that is another card on the board is that card's, not a re-cut", () => {
  const { r, ready } = c479();
  try {
    const d = run(r, [card(), card(`${ID}-v2`)]).doc.cards[ID];
    assert.equal(d.head, ready);
    assert.notEqual(d.phase, "live");
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});

test("two of the card's own READYs: the older one, not on main, is superseded once the newer one is", () => {
  const r = repo();
  try {
    r.g(["checkout", "-qb", "build/own-card"]);
    r.write(10, { "a.md": "first cut\n" }, "first cut\n\nBoard-Id: own-card");
    r.g(["checkout", "-q", "main"]); r.write(20, { "CHANGELOG.md": "other\n" }, "another card");
    r.g(["checkout", "-qb", "build/again/own-card"]);
    r.write(30, { "a.md": "second cut\n" }, "second cut\n\nBoard-Id: own-card");
    r.g(["checkout", "-q", "main"]); r.g(["merge", "-q", "--ff-only", "build/again/own-card"]);
    r.sync();
    const { doc, conflicts } = run(r, [card("own-card")]);
    assert.equal(doc.cards["own-card"].phase, "live", doc.cards["own-card"].evidence);
    assert.ok(!conflicts.some((l) => /branches/.test(l)), conflicts.join("\n"));
    // A commit on the old branch after the shipped one is new work: it holds the card, as before.
    r.g(["checkout", "-q", "build/own-card"]); r.write(40, { "a.md": "a rework\n" }, "rework\n\nBoard-Id: own-card"); r.sync();
    assert.notEqual(run(r, [card("own-card")]).doc.cards["own-card"].phase, "live");
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});

test("a card in another repository (inRepo) is read the same way", () => {
  const { r, recut } = c479();
  try {
    const config = fullConfig({ owner: "Sam", collector: { repos: [{ name: "demos", path: r.dir, notes: { checker: "refs/notes/checker" }, idPrefixes: ["yogamason-"] }] } });
    const d = inRepo(card(), config.collector.repos[0], { git: r.git, installed: r.main() }, config, 1, new Set([ID]));
    assert.equal(d.phase, "live", d.evidence);
    assert.equal(d.head, recut);
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});
