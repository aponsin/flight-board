// #C663: the board writes of a ship and of an install as one ready db_write batch (scripts/ship-batch.mjs). Fictional cards,
// commits and ids. The batch is what the role applies as is, so the gate must accept every op of it.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fullConfig } from "../scripts/config.mjs";
import { writeErrors, mirrorErrors } from "../gate/rules.mjs";
import { cardsNamed, shipBatch, installBatch, asCall } from "../scripts/ship-batch.mjs";

const config = fullConfig({ owner: "Sam", roster: ["Manager", "Builder", "Release", "Security"], artifactSlug: ["11ff6eeb", "bfd4", "4ffa", "96ed", "8a144a6b7f97"].join("-") });
const NOW = Date.UTC(2030, 0, 1, 4, 0) + 12345;
const card = (id, num, extra = {}) => ({ id, num, name: id, status: "active", phase: "security", size: "S", level: "Full", who: "Builder", ...extra });
const cards = [card("menu-fix", 701), card("tabs-fix", 702, { phase: "checker" }), card("note-fix", 703), card("old-one", 704, { status: "done", phase: "live" }), card("bystander", 705)];
const commits = [
  { sha: "a".repeat(40), subject: "#C701: the menu follows the order", body: "Board-Id: menu-fix" },
  { sha: "b".repeat(40), subject: "v1.200.0: some/branch@abcdef12", body: "" },
  { sha: "c".repeat(40), subject: "Fix the tabs (#C702)", body: "" },
  { sha: "d".repeat(40), subject: "Reword", body: "Board-Id: note-fix\n" },
  { sha: "e".repeat(40), subject: "#C704: already closed", body: "" },
  { sha: "f".repeat(40), subject: "Mentions #C7050 and a#C705 only", body: "" },
];

test("cardsNamed: by #C<num> in a subject or body and by a Board-Id trailer; open cards only; no half matches", () => {
  const named = cardsNamed(commits, cards);
  assert.deepEqual(named.map((n) => n.card.id), ["menu-fix", "tabs-fix", "note-fix"], "closed cards and half matches are left out");
  assert.deepEqual(named[0].commits, ["aaaaaaaa"], "a card named twice in one commit counts once");
  assert.deepEqual(cardsNamed([{ sha: "1".repeat(40), subject: "#C1234567 is not card 123456", body: "" }], [card("big", 123456)]), [], "a longer number is another number");
  assert.deepEqual(cardsNamed([], cards), []);
  assert.deepEqual(cardsNamed(undefined, cards), []);
});

test("shipBatch: a ship step per named card, exact; the card update only where a version is given; no wait field anywhere", () => {
  const r = shipBatch({ version: "1.200.0", sha: "9".repeat(40), commits, cards, config, now: NOW, versions: { "menu-fix": 7 } });
  assert.deepEqual(r.named, ["menu-fix", "tabs-fix", "note-fix"]);
  const steps = r.ops.filter((o) => o.path.startsWith("steps/"));
  assert.deepEqual(steps.map((o) => o.path), [`steps/menu-fix-ship-start-${NOW}`, `steps/tabs-fix-ship-start-${NOW}`, `steps/note-fix-ship-start-${NOW}`]);
  assert.deepEqual(steps[0], { op: "set", path: `steps/menu-fix-ship-start-${NOW}`, data: { at: NOW, init: "menu-fix", kind: "start", phase: "ship", who: "Release" } });
  const updates = r.ops.filter((o) => o.path.startsWith("initiatives/"));
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0], { op: "update", path: "initiatives/menu-fix", ifVersion: 7, data: { nextNote: "v1.200.0 (99999999) is on main.", nextNoteAt: NOW, updatedAt: NOW, phase: "ship" } });
  assert.equal(r.left.length, 2);
  assert.match(r.left.join("\n"), /tabs-fix: its card .* no version given/);
  assert.doesNotMatch(JSON.stringify(r.ops), /"wait"/, "phase ship alone: the page derives Waiting for install");
  const full = shipBatch({ version: "1.200.0", sha: "9".repeat(40), commits, cards, config, now: NOW, versions: { "menu-fix": 7, "tabs-fix": 3, "note-fix": 9 } });
  assert.deepEqual(full.left, []);
  assert.equal(full.ops.find((o) => o.path === "initiatives/tabs-fix").data.phase, undefined, "a card two steps behind keeps what the repository derives");
  assert.equal(full.ops.length, 6);
});

test("every op of a ship batch is accepted by the gate for the Release role, as the board holds the cards", () => {
  const steps = [...cards.map((c) => ({ id: `${c.id}-build-end-1`, init: c.id, kind: "end", phase: "build", who: "Builder", at: 1 }))];
  const mirror = { docs: { initiatives: cards, steps, messages: [], waiting: [], derived: [{ id: "all", cards: {} }] }, at: NOW };
  const r = shipBatch({ version: "1.200.0", sha: "9".repeat(40), commits, cards, config, now: NOW, versions: { "menu-fix": 7, "tabs-fix": 3, "note-fix": 9 } });
  const writes = r.ops.map((o) => { const [collection, doc_id] = o.path.split("/"); return { op: o.op, collection, doc_id, data: o.data }; });
  const who = { role: "Release", manager: false };
  for (const w of writes) {
    const e = [...writeErrors(w, { config, who, now: NOW }), ...mirrorErrors(w, { config, mirror, batch: writes, who, now: NOW })];
    assert.deepEqual(e, [], `${w.collection}/${w.doc_id}`);
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

test("the command line prints the batch for a commit range and saves it; a bad argument stops with a reason", () => {
  const dir = mkdtempSync(join(tmpdir(), "fb-shipbatch-"));
  const run = (cmd, args) => spawnSync(cmd, args, { cwd: dir, encoding: "utf8" });
  run("git", ["init", "-q", "-b", "main"]);
  const commit = (msg) => run("git", ["-c", "user.email=a@example.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", msg]);
  commit("base");
  const base = run("git", ["rev-parse", "HEAD"]).stdout.trim();
  commit("#C701: the menu follows the order");
  commit("v1.200.0: some/branch@abcdef12\n\nBoard-Id: note-fix");
  const head = run("git", ["rev-parse", "HEAD"]).stdout.trim();
  const state = join(dir, "state");
  const boardUrl = "https://claude.ai/" + "artifact/TestBoard01";
  mkdirSync(join(state, "TestBoard01", "mirror", "initiatives"), { recursive: true });
  for (const c of cards) { const { id, ...rest } = c; writeFileSync(join(state, "TestBoard01", "mirror", "initiatives", `${id}.json`), JSON.stringify(rest)); }
  const cfg = join(dir, "board.config.json");
  writeFileSync(cfg, JSON.stringify({ artifactUrl: boardUrl, artifactSlug: config.artifactSlug, owner: "Sam", roster: config.roster, gate: { stateDir: state } }));
  writeFileSync(join(dir, "versions.json"), JSON.stringify({ "menu-fix": 4, "note-fix": 8 }));
  const out = join(dir, "batch.json");
  const script = new URL("../scripts/ship-batch.mjs", import.meta.url).pathname;
  const r = spawnSync("node", [script, "ship", "--config", cfg, "--repo", dir, "--range", `${base}..${head}`, "--version", "1.200.0", "--versions", join(dir, "versions.json"), "--now", String(NOW), "--out", out], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const call = JSON.parse(r.stdout);
  assert.equal(call.slug, config.artifactSlug);
  assert.deepEqual(call.ops.map((o) => o.path), [`steps/menu-fix-ship-start-${NOW}`, "initiatives/menu-fix", `steps/note-fix-ship-start-${NOW}`, "initiatives/note-fix"].sort((a, b) => 0));
  assert.equal(call.ops.find((o) => o.path === "initiatives/menu-fix").ifVersion, 4);
  assert.equal(JSON.parse(require_read(out)).ops.length, 4, "saved");
  const bad = spawnSync("node", [script, "ship", "--config", cfg, "--repo", dir, "--range", "nope", "--version", "1.200.0"], { encoding: "utf8" });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /^STOP: ship needs --range/);
  assert.equal(spawnSync("node", [script, "wat"], { encoding: "utf8" }).status, 1);
});

import { readFileSync } from "node:fs";
function require_read(p) { return readFileSync(p, "utf8"); }
