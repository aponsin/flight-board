// #C663: the board writes of a ship and of an install as one ready db_write batch (scripts/ship-batch.mjs). Fictional cards,
// commits and ids. The batch is what the role applies as is, so the gate must accept every op of it.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fullConfig } from "../scripts/config.mjs";
import { writeErrors, mirrorErrors } from "../gate/rules.mjs";
import { cardsNamed, shipBatch, installBatch, asCall, parseVersions, VERSIONS_HELP } from "../scripts/ship-batch.mjs";

const PATTERN = "([A-Za-z0-9._/-]+)@([0-9a-f]{7,40})";
const config = fullConfig({ owner: "Sam", roster: ["Manager", "Builder", "Release", "Security"], artifactSlug: ["11ff6eeb", "bfd4", "4ffa", "96ed", "8a144a6b7f97"].join("-"), collector: { shippedPattern: PATTERN } });
const NOW = Date.UTC(2030, 0, 1, 4, 0) + 12345;
const card = (id, num, extra = {}) => ({ id, num, name: id, status: "active", phase: "security", size: "S", level: "Full", who: "Builder", ...extra });
const cards = [card("menu-fix", 701), card("tabs-fix", 702, { phase: "checker" }), card("note-fix", 703), card("old-one", 704, { status: "done", phase: "live" }), card("bystander", 705)];
// Real shapes: a card cited in passing, a ship commit naming branch@sha, a closed card, half matches.
const commits = [
  { sha: "a".repeat(40), subject: "#C701: the menu follows the order", body: "Board-Id: menu-fix" },
  { sha: "b".repeat(40), subject: "v1.200.0: some/branch@abcdef12", body: "" },
  { sha: "c".repeat(40), subject: "#C702: fit Builder's #C703 Worker", body: "" },
  { sha: "d".repeat(40), subject: "Reword", body: "Board-Id: note-fix\n" },
  { sha: "e".repeat(40), subject: "#C704: already closed", body: "" },
  { sha: "f".repeat(40), subject: "Mentions #C7050 and a#C705 only", body: "" },
  { sha: "1".repeat(40), subject: "#C551 (Manager): drop #C701's 8 leftover lines", body: "Also see #C703 and #C705." },
  { sha: "7".repeat(40), subject: "Add the thing", body: "Board-Id: bystander" },
  { sha: "8".repeat(40), subject: "v1.200.1: build/thing@7777777", body: "" },
];
const derived = { "menu-fix": { phase: "ship" }, "tabs-fix": { phase: "live" }, "note-fix": { phase: "security" }, bystander: { phase: "ship" } };

test("cardsNamed: only by a subject that starts #C<num>:, a Board-Id trailer, or a ship commit's branch@sha; a card cited in passing is not named", () => {
  const r = cardsNamed(commits, cards, PATTERN);
  assert.deepEqual(r.named.map((n) => n.card.id), ["menu-fix", "tabs-fix", "note-fix", "bystander"], "mid-subject and body mentions name nobody");
  assert.deepEqual(r.named[0].commits, ["aaaaaaaa"], "a card named twice in one commit counts once; the mention in commit 1 is not a naming");
  assert.deepEqual(r.named[1].commits, ["cccccccc"], "'#C702: fit Builder's #C703 Worker' names 702 only");
  assert.deepEqual(r.named[3].commits, ["77777777", "88888888"], "the ship commit names the card of the commit at its sha");
  assert.deepEqual(r.unmatched.map((u) => u.sha), ["eeeeeeee"], "a citation that is no open card is listed, a branch that is no card is not");
  assert.equal(r.unmatched[0].missing, false, "a closed card is on the board: not missing");
  assert.equal(cardsNamed([{ sha: "5".repeat(40), subject: "#C799: no such card", body: "" }], cards).unmatched[0].missing, true, "a card the board does not hold is missing");
  assert.deepEqual(cardsNamed([{ sha: "1".repeat(40), subject: "#C1234567: is not card 123456", body: "" }], [card("big", 123456)]).named, [], "a longer number is another number");
  assert.deepEqual(cardsNamed([], cards).named, []);
  assert.deepEqual(cardsNamed(undefined, cards).named, []);
  const noPattern = cardsNamed(commits, cards, "");
  assert.deepEqual(noPattern.named.map((n) => n.card.id), ["menu-fix", "tabs-fix", "note-fix", "bystander"], "bystander is also named by its own trailer");
  assert.deepEqual(cardsNamed([{ sha: "9".repeat(40), subject: "v1.0.0: x/y@9999999", body: "" }, { sha: "2".repeat(40), subject: "x", body: "" }], cards, "(").named, [], "a bad pattern names nothing");
  assert.deepEqual(cardsNamed([{ sha: "4".repeat(40), subject: "Docs", body: "We drop the Board-Id: menu-fix line when squashing" }], cards).named, [], "a trailer is a line of its own");
  assert.deepEqual(cardsNamed([{ sha: "6".repeat(40), subject: "notes: see #C575: done", body: "" }], [card("worker-card", 575)]).named, [], "'#C575:' in the middle of a subject names nothing (the anchor)");
  const byBranch = cardsNamed([{ sha: "3".repeat(40), subject: "v1.0.0: build/note-fix@3030303", body: "" }], cards, PATTERN);
  assert.deepEqual(byBranch.named.map((n) => n.card.id), ["note-fix"], "a branch whose last segment is the card id names it");
});

test("shipBatch: a ship END step per signed named card, exact; the card update only where a version is given; no wait field anywhere", () => {
  const r = shipBatch({ version: "1.200.0", sha: "9".repeat(40), commits, cards, config, now: NOW, versions: { "menu-fix": 7 }, derived });
  assert.deepEqual(r.named, ["menu-fix", "tabs-fix", "bystander"], "note-fix is on security by the repository's reading: no ship step");
  const steps = r.ops.filter((o) => o.path.startsWith("steps/"));
  assert.deepEqual(steps.map((o) => o.path), [`steps/menu-fix-ship-end-${NOW}`, `steps/tabs-fix-ship-end-${NOW}`, `steps/bystander-ship-end-${NOW}`]);
  assert.deepEqual(steps[0], { op: "set", path: `steps/menu-fix-ship-end-${NOW}`, data: { at: NOW, init: "menu-fix", kind: "end", phase: "ship", who: "Release" } }, "Release logs the ship's start itself; the batch carries its end");
  const updates = r.ops.filter((o) => o.path.startsWith("initiatives/"));
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0], { op: "update", path: "initiatives/menu-fix", ifVersion: 7, data: { nextNote: "v1.200.0 (99999999) is on main.", nextNoteAt: NOW, updatedAt: NOW, phase: "ship" } });
  assert.equal(r.left.length, 3);
  assert.match(r.left.join("\n"), /tabs-fix: its card .* no version given/);
  assert.match(r.left.join("\n"), /note-fix: named by a commit, but the repository's reading is "security"/);
  assert.deepEqual(r.unmatched.map((u) => u.sha), ["eeeeeeee"]);
  assert.doesNotMatch(JSON.stringify(r.ops), /"wait"/, "phase ship alone: the page derives Waiting for install");
  assert.doesNotMatch(JSON.stringify(r.ops), /shippedAt/, "shippedAt is the probe's");
  const full = shipBatch({ version: "1.200.0", sha: "9".repeat(40), commits, cards, config, now: NOW, versions: { "menu-fix": 7, "tabs-fix": 3, bystander: 2 }, derived });
  assert.equal(full.left.length, 1, "only the unsigned card is left");
  assert.equal(full.ops.find((o) => o.path === "initiatives/tabs-fix").data.phase, "ship", "a card several phases behind (a Quick one on checker) moves to ship too, the repository reading ship or later");
  assert.equal(shipBatch({ version: "1.200.0", sha: "9".repeat(40), commits, cards: [...cards.slice(0, 1), card("tabs-fix", 702, { phase: "live" }), ...cards.slice(2)], config, now: NOW, versions: { "menu-fix": 7, "tabs-fix": 3, bystander: 2 }, derived }).ops.find((o) => o.path === "initiatives/tabs-fix").data.phase, undefined, "a card already on or past ship keeps its phase");
  assert.equal(full.ops.length, 6);
  const none = shipBatch({ version: "1.200.0", sha: "9".repeat(40), commits, cards, config, now: NOW, versions: { "menu-fix": 7 } });
  assert.deepEqual(none.ops, [], "with no reading of the repository nothing is a ship");
  assert.equal(none.left.length, 4);
});

test("shipBatch: a card cited in passing in a ship's commits gets no step and no phase", () => {
  const onlyMentions = [{ sha: "5".repeat(40), subject: "#C573: fit Builder's #C575 Worker", body: "" }];
  const two = [card("worker-fit", 573), card("worker-card", 575, { phase: "security" })];
  const r = shipBatch({ version: "1.200.0", sha: "9".repeat(40), commits: onlyMentions, cards: two, config, now: NOW, versions: { "worker-fit": 1, "worker-card": 1 }, derived: { "worker-fit": { phase: "ship" }, "worker-card": { phase: "ship" } } });
  assert.deepEqual(r.named, ["worker-fit"]);
  assert.ok(!r.ops.some((o) => /worker-card/.test(o.path)), "#C575 is only cited");
});

test("shipBatch --partial: a build step with the note and the card's nextNote; the phase is left alone, no ship step", () => {
  const r = shipBatch({ version: "1.200.0", sha: "9".repeat(40), commits, cards, config, now: NOW, versions: { "menu-fix": 7, "tabs-fix": 3, bystander: 2 }, derived, partial: ["menu-fix"] });
  const menu = r.ops.filter((o) => /menu-fix/.test(o.path));
  assert.equal(menu.length, 2);
  assert.equal(menu[0].path, `steps/menu-fix-build-start-${NOW}`);
  assert.equal(menu[0].data.phase, "build");
  assert.match(menu[0].data.note, /holds part of this card/);
  assert.equal(menu[1].data.phase, undefined, "the phase is left alone");
  assert.match(menu[1].data.nextNote, /holds part of this card/);
  assert.ok(!r.ops.some((o) => o.path === `steps/menu-fix-ship-end-${NOW}`));
  assert.ok(r.ops.some((o) => o.path === `steps/tabs-fix-ship-end-${NOW}`), "the other cards ship as usual");
  assert.deepEqual(r.badPartial, [], "every --partial id is named");
  assert.deepEqual(shipBatch({ version: "1.200.0", sha: "9".repeat(40), commits, cards, config, now: NOW, versions: {}, derived, partial: ["menu-fx", "note-fix"] }).badPartial, ["menu-fx"], "a typo is reported, not ignored");
  const noVer = shipBatch({ version: "1.200.0", sha: "9".repeat(40), commits, cards, config, now: NOW, versions: {}, derived: {}, partial: ["menu-fix"] });
  assert.equal(noVer.ops.length, 1);
  assert.match(noVer.left.join("\n"), /menu-fix: its card \(nextNote\) is not in this batch/);
});

test("every op of a ship batch is accepted by the gate for the Release role, as the board holds the cards", () => {
  // The reviews are signed by the time a card ships (#C671: a ship step, start or end, needs them): an end step for each, as the board holds them.
  const reviews = cards.flatMap((c) => ["checker", "security", "language", "design"].map((p) => ({ id: `${c.id}-${p}-end-1`, init: c.id, kind: "end", phase: p, who: "Reviewer", at: 1 })));
  const steps = [...cards.map((c) => ({ id: `${c.id}-build-end-1`, init: c.id, kind: "end", phase: "build", who: "Builder", at: 1 })), ...reviews, ...cards.map((c) => ({ id: `${c.id}-ship-start-2`, init: c.id, kind: "start", phase: "ship", who: "Release", at: 2 }))];
  // ... and the gate counts only the signed notes, which the probe's derived cards carry as reviews { phase: ms }.
  const signed = Object.fromEntries(Object.entries(derived).map(([id, d]) => [id, { ...d, reviews: { checker: 1, security: 1, language: 1, design: 1 } }]));
  const mirror = { docs: { initiatives: cards, steps, messages: [], waiting: [], derived: [{ id: "all", cards: signed }] }, at: NOW };
  for (const partial of [[], ["menu-fix"]]) {
    const r = shipBatch({ version: "1.200.0", sha: "9".repeat(40), commits, cards, config, now: NOW, versions: { "menu-fix": 7, "tabs-fix": 3, bystander: 9 }, derived, partial });
    const writes = r.ops.map((o) => { const [collection, doc_id] = o.path.split("/"); return { op: o.op, collection, doc_id, data: o.data }; });
    const who = { role: "Release", manager: false };
    for (const w of writes) {
      const e = [...writeErrors(w, { config, who, now: NOW }), ...mirrorErrors(w, { config, mirror, batch: writes, who, now: NOW })];
      assert.deepEqual(e, [], `${w.collection}/${w.doc_id}`);
    }
  }
});

test("installBatch: a live end step and the closing card update per pack card; a watch stays open; doneWhen is the lead's", () => {
  const pack = [card("menu-fix", 701, { phase: "live" }), card("watched", 710, { phase: "live" }), card("lined", 711, { phase: "live", doneWhen: ["page"] }), card("counted", 712, { phase: "live", issues: { a: 1 } }), card("gone", 713, { status: "done" })];
  const r = installBatch({ cards: pack, watch: ["watched"], config, now: NOW, versions: { "menu-fix": 2, counted: 5 } });
  assert.deepEqual(r.closing, ["menu-fix", "counted"]);
  assert.deepEqual(r.ops.map((o) => `${o.op} ${o.path}`), [`set steps/menu-fix-live-end-${NOW}`, "update initiatives/menu-fix", `set steps/counted-live-end-${NOW}`, "update initiatives/counted"]);
  assert.deepEqual(r.ops[1].data, { phase: "live", status: "done", doneAt: NOW, updatedAt: NOW });
  assert.deepEqual(r.ops[3].data, { phase: "live", status: "done", doneAt: NOW, updatedAt: NOW, issuesAt: NOW }, "issuesAt only where issues were counted");
  assert.equal(r.ops[1].ifVersion, 2);
  assert.match(r.left.join("\n"), /watched: stays open/);
  assert.match(r.left.join("\n"), /lined: has doneWhen lines/);
  assert.equal(installBatch({ cards: pack, watch: [], config, now: NOW }).ops.filter((o) => o.path.startsWith("initiatives/")).length, 0, "no versions: steps only, the cards are named in left");
  assert.deepEqual(asCall("slug", [1]), { slug: "slug", ops: [1] });
});

test("parseVersions: a map or a db_query list; anything else is null; bad versions are skipped", () => {
  assert.deepEqual(parseVersions({ a: 3, b: "x", c: 0, d: 1.5 }), { a: 3 });
  assert.deepEqual(parseVersions([{ id: "a", version: 2 }, { path: "initiatives/b", version: 5 }, { id: "c" }, null, 4]), { a: 2, b: 5 });
  assert.equal(parseVersions("nope"), null);
  assert.equal(parseVersions(null), null);
  assert.match(VERSIONS_HELP, /ONE db_query/);
});

// A scratch repository, a mirror and a config on disk, for the command line.
function rig({ derivedCards = derived, mirrorCards = cards, absent = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "fb-shipbatch-"));
  const run = (cmd, args) => spawnSync(cmd, args, { cwd: dir, encoding: "utf8" });
  run("git", ["init", "-q", "-b", "main"]);
  const commit = (msg) => run("git", ["-c", "user.email=a@example.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", msg]);
  commit("base");
  const base = run("git", ["rev-parse", "HEAD"]).stdout.trim();
  commit("#C701: the menu follows the order");
  commit("#C702: fit Builder's #C703 Worker");
  commit("#C704: already closed");
  if (absent) commit("#C799: a card the board does not have");
  const head = run("git", ["rev-parse", "HEAD"]).stdout.trim();
  const state = join(dir, "state");
  const boardUrl = "https://claude.ai/" + "artifact/TestBoard01";
  const mdir = join(state, "TestBoard01", "mirror");
  mkdirSync(join(mdir, "initiatives"), { recursive: true });
  mkdirSync(join(mdir, "derived"), { recursive: true });
  for (const c of mirrorCards) { const { id, ...rest } = c; writeFileSync(join(mdir, "initiatives", `${id}.json`), JSON.stringify(rest)); }
  writeFileSync(join(mdir, "derived", "all.json"), JSON.stringify({ cards: derivedCards }));
  const cfg = join(dir, "board.config.json");
  writeFileSync(cfg, JSON.stringify({ artifactUrl: boardUrl, artifactSlug: config.artifactSlug, owner: "Sam", roster: config.roster, gate: { stateDir: state }, collector: { shippedPattern: PATTERN } }));
  writeFileSync(join(dir, "versions.json"), JSON.stringify({ "menu-fix": 4, "tabs-fix": 8 }));
  const script = new URL("../scripts/ship-batch.mjs", import.meta.url).pathname;
  const ship = (extra = [], { now = Date.now() } = {}) => spawnSync("node", [script, "ship", "--config", cfg, "--repo", dir, "--range", `${base}..${head}`, "--version", "1.200.0", "--now", String(now), ...extra], { encoding: "utf8" });
  return { dir, ship, script, cfg, base, head };
}

test("the command line prints the batch for a commit range and saves it; unmatched citations go to stderr", () => {
  const { dir, ship } = rig();
  const out = join(dir, "batch.json");
  const r = ship(["--versions", join(dir, "versions.json"), "--out", out]);
  assert.equal(r.status, 0, r.stderr);
  const call = JSON.parse(r.stdout);
  assert.equal(call.slug, config.artifactSlug);
  assert.deepEqual(call.ops.map((o) => o.path).sort(), ["initiatives/menu-fix", "initiatives/tabs-fix", `steps/menu-fix-ship-end-${call.ops[0].data.at}`, `steps/tabs-fix-ship-end-${call.ops[0].data.at}`].sort());
  assert.equal(call.ops.find((o) => o.path === "initiatives/menu-fix").ifVersion, 4);
  assert.equal(JSON.parse(readFileSync(out, "utf8")).ops.length, 4, "saved");
  assert.match(r.stderr, /unmatched: commit \w{8} cites #C704, which is no open card on the board/, "a closed card is only listed");
  assert.doesNotMatch(r.stdout, /note-fix/, "#C703 is cited, not named");
});

test("the command line: --partial writes the build step; a bad argument stops with a reason", () => {
  const { dir, ship, script } = rig();
  const r = ship(["--versions", join(dir, "versions.json"), "--partial", "menu-fix"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(JSON.parse(r.stdout).ops.some((o) => /^steps\/menu-fix-build-start-/.test(o.path)));
  const bad = spawnSync("node", [script, "ship", "--config", join(dir, "board.config.json"), "--repo", dir, "--range", "nope", "--version", "1.200.0", "--versions", join(dir, "versions.json")], { encoding: "utf8" });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /^STOP: ship needs --range/);
  assert.equal(spawnSync("node", [script, "wat"], { encoding: "utf8" }).status, 1);
});

test("the command line stops without --versions, on an empty versions file, and on a card with no version", () => {
  const { dir, ship } = rig();
  const none = ship([]);
  assert.equal(none.status, 1);
  assert.match(none.stderr, /^STOP: --versions is required: run ONE db_query/);
  writeFileSync(join(dir, "empty.json"), "{}");
  const empty = ship(["--versions", join(dir, "empty.json")]);
  assert.equal(empty.status, 1);
  assert.match(empty.stderr, /holds no card version/);
  writeFileSync(join(dir, "partial.json"), JSON.stringify([{ id: "menu-fix", version: 4 }]));
  const miss = ship(["--versions", join(dir, "partial.json")]);
  assert.equal(miss.status, 1);
  assert.match(miss.stderr, /no version for tabs-fix/);
  assert.equal(miss.stdout, "", "nothing is printed");
});

test("the command line stops when the mirror is older than gate.mirrorMaxAgeMin, and with no mirror", () => {
  const { dir, ship } = rig();
  const fresh = ship(["--versions", join(dir, "versions.json")]);
  assert.equal(fresh.status, 0, fresh.stderr);
  // The CARDS are old while derived/all (rewritten every collector run) is new: that mirror is stale (Checker: it passed, with a
  // card made after the cards were last written missing). A back-dated --now does not make it fresh: the clock is the real one.
  const cdir = join(dir, "state", "TestBoard01", "mirror", "initiatives"), old = new Date(Date.now() - 7 * 3600e3);
  for (const f of readdirSync(cdir)) utimesSync(join(cdir, f), old, old);
  const stale = ship(["--versions", join(dir, "versions.json")]);
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /^STOP: the mirror's cards were last written 4\d\d minutes ago \(more than gate.mirrorMaxAgeMin, 75\)/);
  assert.equal(stale.stdout, "");
  const backdated = ship(["--versions", join(dir, "versions.json")], { now: Date.now() - 7 * 3600e3 });
  assert.equal(backdated.status, 1, "a back-dated --now does not rescue an old mirror");
  const emptyDir = rig({ mirrorCards: [] });
  assert.match(emptyDir.ship(["--versions", join(emptyDir.dir, "versions.json")]).stderr, /^STOP: the mirror's cards were last written never/, "no card file at all is stale");
  const other = rig();
  writeFileSync(other.cfg, JSON.stringify({ artifactUrl: "https://claude.ai/" + "artifact/Elsewhere99", artifactSlug: config.artifactSlug, owner: "Sam", roster: config.roster, gate: { stateDir: join(other.dir, "state") } }));
  const none = other.ship(["--versions", join(other.dir, "versions.json")]);
  assert.equal(none.status, 1);
  assert.match(none.stderr, /^STOP: no mirror of the board/);
});

test("the command line stops on a citation of a card the mirror does not hold, and on a --partial id no commit names", () => {
  const a = rig({ absent: true });
  const r = a.ship(["--versions", join(a.dir, "versions.json")]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^STOP: commit \w{8} cites #C799: the mirror holds no such card \(it is behind, or the citation is wrong\)/);
  assert.equal(r.stdout, "");
  const { dir, ship } = rig();
  const typo = ship(["--versions", join(dir, "versions.json"), "--partial", "menu-fx"]);
  assert.equal(typo.status, 1);
  assert.match(typo.stderr, /^STOP: --partial names menu-fx, which no commit of the range names/);
  assert.equal(typo.stdout, "");
});

test("the command line: a card the repository does not put on ship is left out with its reason", () => {
  const { dir, ship } = rig({ derivedCards: { "menu-fix": { phase: "security" }, "tabs-fix": { phase: "ship" } } });
  const r = ship(["--versions", join(dir, "versions.json")]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!JSON.parse(r.stdout).ops.some((o) => /menu-fix/.test(o.path)));
  assert.match(r.stderr, /left out: menu-fix: named by a commit, but the repository's reading is "security"/);
});
