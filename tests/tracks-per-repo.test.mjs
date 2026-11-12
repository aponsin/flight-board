// #C969 (tracks per repository): each card draws its own repository's track. A platform card keeps the board's phases unchanged, so
// nothing is hidden; a board card has the same list with Ship called "Land" (a board card's ship is Release landing it on main) and Pack and
// Install before Live, drawn unlit (lighting them from evidence is #C1020). A card whose repository the page does not know falls back to the
// platform's list. On the phone the tiles split into even rows, never one lone tile on a row (Designer). The tests use a made-up platform name:
// the names come from the config, never the page.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadNames } from "./harness.mjs";
import { buildPage } from "../scripts/build-page.mjs";

const page = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
const PHASES = [["plan", "Plan"], ["build", "Build"], ["test", "Test"], ["language", "Linguist"], ["design", "Design"], ["checker", "Checker"], ["security", "Security"], ["ship", "Ship"], ["live", "Live"]];
const REPOS = { platform: "Harbor", board: "Flight-Board", builders: ["Boardsmith"] };
const built = (phases = PHASES) => buildPage(page, { title: "Test", owner: "Sam", phases, repos: REPOS });
const card = (id, num, fields = {}) => ({ id, num, name: `Card ${num}`, size: "S", level: "Quick", status: "active", phase: "build", skip: [], who: "Builder", ...fields });
function board(initRaw, phases) {
  const b = loadNames(["initRow", "trackFor", "evenPer", "gates", "enrich", "PHASES", "branchTracks"], {}, built(phases));
  Object.assign(b.state, { initRaw, initiatives: initRaw, steps: [], waiting: [], derived: [], messages: [], threads: [] });
  return b;
}
const of = (b, id) => b.state.initRaw.find((i) => i.id === id);
const row = (b, id) => b.initRow(b.gates(b.enrich(of(b, id))));
// Spread first: the page's arrays come from its own realm (vm), and deepStrictEqual compares prototypes.
const keys = (t) => [...t].map(([k]) => k), labels = (t) => [...t].map(([, l]) => l);
const tiles = (html) => [...html.matchAll(/<div class="(step[^"]*)" title="([^":|]*)/g)].map((m) => ({ cls: m[1], label: m[2] }));

test("a product card and a board card each draw their own list", () => {
  const b = board([card("site", 1), card("board", 2, { repo: "flight-board" })]);
  assert.deepEqual(keys(b.trackFor(of(b, "site"))), PHASES.map(([k]) => k), "the product keeps every phase of today's list");
  assert.deepEqual(labels(b.trackFor(of(b, "site"))), PHASES.map(([, l]) => l));
  assert.deepEqual(keys(b.trackFor(of(b, "board"))), ["plan", "build", "test", "language", "design", "checker", "security", "ship", "pack", "install", "live"]);
  // A card with no test evidence has Test skipped by enrich, and a skipped Test is not drawn (as before): the rest is drawn in order.
  assert.deepEqual(tiles(row(b, "site")).map((t) => t.label), PHASES.map(([, l]) => l).filter((l) => l !== "Test"), "the row draws the product's list");
  assert.deepEqual(tiles(row(b, "board")).map((t) => t.label), ["Plan", "Build", "Linguist", "Design", "Checker", "Security", "Land", "Pack", "Install", "Live"]);
});

test("ship shows as Land on a board card only", () => {
  const b = board([card("site", 1, { phase: "ship" }), card("board", 2, { repo: "flight-board", phase: "ship" }), card("by-role", 3, { who: "Boardsmith" })]);
  assert.match(row(b, "board"), /title="Land[^"]*">Land/);
  assert.doesNotMatch(row(b, "board"), />Ship</);
  assert.match(row(b, "site"), /title="Ship[^"]*">Ship/);
  assert.doesNotMatch(row(b, "site"), />Land<|>Pack<|>Install</);
  assert.ok(labels(b.trackFor(of(b, "by-role"))).includes("Land"), "a card the board's builder owns is a board card too (cardRepo)");
});

test("a card whose repository the page does not know falls back to today's list", () => {
  const b = board([card("other", 1, { repo: "someone/elsewhere" }), card("none", 2, { repo: "" })]);
  assert.equal(b.trackFor(of(b, "other")), b.PHASES);
  assert.equal(b.trackFor(of(b, "none")), b.PHASES);
});

test("Pack and Install are never lit by this card's code: not when done, not when the card is at live, not as the current phase", () => {
  const T = Date.now();
  const b = board([
    card("done", 1, { repo: "flight-board", status: "done", phase: "live", doneAt: T - 3600e3 }),
    card("at-live", 2, { repo: "flight-board", phase: "live" }),
    card("building", 3, { repo: "flight-board" }),
  ]);
  for (const id of ["done", "at-live", "building"]) {
    const t = tiles(row(b, id)).filter((x) => x.label === "Pack" || x.label === "Install");
    assert.equal(t.length, 2, `${id}: both drawn`);
    for (const x of t) assert.equal(x.cls, "step unlit", `${id}: ${x.label} stays unlit`);
  }
  const done = tiles(row(b, "done"));
  assert.match(done.find((x) => x.label === "Land").cls, /^step done\b/, "the rest of a done card still reads done");
});

test("a branch track of a board card follows the same list", () => {
  const b = board([card("board", 2, { repo: "flight-board" })]);
  const html = b.branchTracks([{ name: "board", phase: "ship", onMain: false, seen: [] }, { name: "board-v2", phase: "build", onMain: false, seen: [] }], [], b.trackFor(of(b, "board")));
  assert.match(html, /title="Land">Land/);
  assert.equal((html.match(/class="step unlit"/g) || []).length, 4, "Pack and Install unlit on each of the two branches");
  assert.doesNotMatch(b.branchTracks([{ name: "x", phase: "build", onMain: false, seen: [] }], []), /Land|unlit/, "without a card's list: today's");
});

test("a config that already lists pack or install keeps its own list: no second tile", () => {
  const phases = [["build", "Build"], ["ship", "Ship"], ["pack", "Pack"], ["live", "Live"]];
  const b = board([card("board", 2, { repo: "flight-board" }), card("site", 1)], phases);
  assert.deepEqual(keys(b.trackFor(of(b, "board"))), ["build", "ship", "pack", "live"]);
  // Checker 2 LOW on c27c686d: a pack the config lists is the config's own phase, drawn like any other on every card, never the unlit tile.
  for (const id of ["board", "site"]) {
    const pack = tiles(row(b, id)).find((x) => x.label === "Pack");
    assert.ok(pack, `${id}: Pack is drawn`);
    assert.notEqual(pack.cls, "step unlit", `${id}: the config's own Pack is not the unlit tile`);
  }
  assert.doesNotMatch(b.branchTracks([{ name: "x", phase: "build", onMain: false, seen: [] }], [], b.PHASES), /unlit/, "nor on a branch track");
});

test("on the phone the tiles split into even rows, at most 4 a row, no lone tile", () => {
  const b = board([card("site", 1), card("board", 2, { repo: "flight-board" }), card("no-test", 3, { skip: ["test"] })]);
  const rows = (n, per) => Array.from({ length: Math.ceil(n / per) }, (_, r) => Math.min(per, n - r * per));
  // Up to 12 tiles (the longest track today is 11, a board card's with Test).
  for (let n = 1; n <= 12; n++) {
    const per = b.evenPer(n), r = rows(n, per);
    assert.ok(per >= 1 && per <= 4, `${n} tiles: at most 4 a row`);
    assert.ok(n === 1 || !r.includes(1), `${n} tiles: no lone tile (${r.join(", ")})`);
    assert.equal(r.length, Math.ceil(n / 4), `${n} tiles: no more rows than 4 a row needs (${r.join(", ")})`);
  }
  assert.equal(b.evenPer(9), 3, "9 tiles: 3, 3, 3");
  assert.equal(b.evenPer(11), 4, "11 tiles: 4, 4, 3");
  assert.match(row(b, "site"), /class="track" style="--per:4"/, "Test skipped and not drawn: 8 tiles, 4 and 4");
  assert.match(row(b, "board"), /class="track" style="--per:4"/, "10 tiles: 4, 4, 2");
  assert.match(row(b, "no-test"), /class="track" style="--per:4"/);
  const t = board([card("testing", 4, { phase: "test" })]);
  assert.equal(tiles(row(t, "testing")).length, 9, "a card at Test draws it");
  assert.match(row(t, "testing"), /class="track" style="--per:3"/, "9 tiles: 3, 3, 3, never 4, 4, 1");
});

test("the unlit tile is styled from the page's own variables, and the page names no repository itself", () => {
  // #C1020 (Designer): a dotted outline in --muted, faded, so unlit reads unlike skipped (dashed --line, struck through).
  assert.match(page, /\.step\.unlit\{[^}]*color:var\(--muted\)[^}]*dotted var\(--muted\)/);
  assert.doesNotMatch(page.match(/\.step\.unlit[^\n]*/g).join("\n"), /#[0-9a-f]{3,6}\b/i);
  const fn = page.split("\n").find((l) => l.startsWith("function trackFor(")) ?? "";
  assert.ok(fn.includes("BOARD_REPO") && !/Flight-Board|flight-board/.test(fn), "the board is known by the config's name");
});
