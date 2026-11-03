// #C648 (the owner: an easy way to tell the cards about the platform from the cards about the board itself): each card shows a
// small badge next to its number, the platform's name or "Flight-Board", worked out from the card's repo field, else from the
// board's builder role (owning it or having logged a build step on it), else the platform. The cards' search finds it by the
// same words. The names and the builder roles come from the board's config (repos: platform, board, builders), never from the
// page or this file (Checker: nothing about the team enters the repository), so the tests use a made-up platform name.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadNames } from "./harness.mjs";
import { buildPage } from "../scripts/build-page.mjs";
import { checkConfig, fullConfig } from "../scripts/config.mjs";

const page = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
const PLATFORM = "Harbor";
const REPOS = { platform: PLATFORM, board: "Flight-Board", builders: ["Boardsmith"] };
const built = (repos) => buildPage(page, { title: "Test", owner: "Sam", ...(repos ? { repos } : {}) });
const card = (id, num, fields = {}) => ({ id, num, name: `Card ${num}`, size: "S", level: "Quick", status: "active", phase: "build", skip: ["plan"], who: "Builder", ...fields });
function board(initRaw, steps = [], repos = REPOS) {
  const b = loadNames(["initRow", "cardRepo", "repoBadge", "gates", "enrich", "initHit", "setInitSearch", "renderBoard", "tabCounts"], {}, built(repos));
  Object.assign(b.state, { initRaw, initiatives: initRaw, steps, waiting: [], derived: [], messages: [], threads: [] });
  return b;
}
const row = (b, id) => b.initRow(b.gates(b.enrich(b.state.initRaw.find((i) => i.id === id))));

test("a card's repo field decides first; the builder role comes next; the platform is the default", () => {
  const b = board([
    card("site-photos", 1),
    card("board-badge", 2, { who: "Boardsmith" }),
    card("in-review", 3, { who: "Checker" }),
    card("explicit-fb", 4, { repo: "flight-board" }),
    card("explicit-site", 5, { repo: PLATFORM.toLowerCase(), who: "Boardsmith" }),
  ], [{ init: "in-review", phase: "build", kind: "start", who: "Boardsmith", at: 1 }]);
  const repo = (id) => b.cardRepo(b.state.initRaw.find((i) => i.id === id));
  assert.equal(repo("site-photos"), PLATFORM, "no signal: the platform");
  assert.equal(repo("board-badge"), "Flight-Board", "owned by the board's builder");
  assert.equal(repo("in-review"), "Flight-Board", "now with a reviewer, but the builder logged its build step");
  assert.equal(repo("explicit-fb"), "Flight-Board", "its own repo field");
  assert.equal(repo("explicit-site"), PLATFORM, "its own repo field wins over the owner");
});

test("a build step by someone else does not make a card Flight-Board", () => {
  const b = board([card("site-photos", 1)], [{ init: "site-photos", phase: "build", kind: "start", who: "Builder", at: 1 }, { init: "site-photos", phase: "checker", kind: "start", who: "Boardsmith", at: 2 }]);
  assert.equal(b.cardRepo(b.state.initRaw[0]), PLATFORM);
});

test("the badge sits right after the card's number in its row, as text, with the repository in its title", () => {
  const b = board([card("site-photos", 11), card("board-badge", 12, { who: "Boardsmith" })]);
  assert.match(row(b, "site-photos"), new RegExp(`#C11<span class="i-ic" aria-hidden="true">↻</span></button> <span class="c-repo" title="[^"]*${PLATFORM}[^"]*">${PLATFORM}</span> <strong>`));
  assert.match(row(b, "board-badge"), /#C12<span class="i-ic" aria-hidden="true">↻<\/span><\/button> <span class="c-repo fb" title="[^"]*Flight-Board[^"]*">Flight-Board<\/span> <strong>/);
});

test("a done card, whose number is plain text and not the check button, shows the badge too", () => {
  const b = board([card("old-site", 21, { status: "done", phase: "live", doneAt: Date.now() - 3600e3 }), card("old-board", 22, { status: "done", phase: "live", doneAt: Date.now() - 3600e3, who: "Boardsmith" })]);
  assert.doesNotMatch(row(b, "old-site"), /data-check=/, "the plain number");
  assert.match(row(b, "old-site"), new RegExp(`#C21</span> <span class="c-repo"[^>]*>${PLATFORM}</span>`));
  assert.match(row(b, "old-board"), /#C22<\/span> <span class="c-repo fb"[^>]*>Flight-Board<\/span>/);
});

test("the cards' search finds a repository by its name", () => {
  const b = board([card("site-photos", 11, { name: "Photos" }), card("board-badge", 12, { name: "Badge", who: "Boardsmith" })]);
  const [site, fb] = b.state.initRaw;
  assert.equal(b.initHit(fb, "flight-board"), true);
  assert.equal(b.initHit(site, "flight-board"), false);
  assert.equal(b.initHit(site, PLATFORM.toLowerCase()), true);
  assert.equal(b.initHit(fb, PLATFORM.toLowerCase()), false);
});

test("the names and the builder roles come from the config: another config names another platform and another builder", () => {
  const b = board([card("a", 1), card("b", 2, { who: "Smith" }), card("c", 3, { who: "Boardsmith" })], [], { platform: "Quay", board: "Dock", builders: ["Smith"] });
  const repo = (id) => b.cardRepo(b.state.initRaw.find((i) => i.id === id));
  assert.deepEqual(["a", "b", "c"].map(repo), ["Quay", "Dock", "Quay"], "Boardsmith builds nothing here: only the configured role does");
});

test("a config with no repos key gets generic names and no builder role: every card is the platform's", () => {
  const b = board([card("a", 1, { who: "Boardsmith" }), card("b", 2, { repo: "flight-board" })], [], null);
  assert.equal(b.cardRepo(b.state.initRaw[0]), "Platform");
  assert.equal(b.cardRepo(b.state.initRaw[1]), "Flight-Board", "its own repo field still names the board");
  assert.equal(fullConfig({}).repos.platform, "Platform");
  assert.deepEqual(fullConfig({}).repos.builders, []);
});

test("neither the page nor this card's tests name the platform: the names are the config's", () => {
  const line = page.split("\n").find((l) => l.includes("const REPOS=")) ?? "";
  assert.ok(line.includes("CONFIG.repos"), "the page reads the config's repos");
  assert.ok(!/Boardsmith/.test(line) && !/"\s*\+\s*"/.test(line), "no builder role and no name put together from parts on that line");
  assert.ok(!/const PLATFORM_REPO\s*=\s*"/.test(page) && !/FLIGHT_BOARD_BUILDERS\s*=\s*\[\s*"/.test(page), "no literal platform name or builder list");
});

test("the config check takes a repos key and refuses a bad one", () => {
  assert.deepEqual(checkConfig({ title: "T", owner: "O", repos: REPOS }), []);
  assert.deepEqual(checkConfig({ title: "T", owner: "O", repos: { platform: "Quay" } }), [], "a part left out takes its default");
  const bad = (repos) => checkConfig({ title: "T", owner: "O", repos }).join("\n");
  assert.match(bad("x"), /repos: an object/);
  assert.match(bad({ colour: "red" }), /unknown field "colour"/);
  assert.match(bad({ platform: "" }), /repos\.platform/);
  assert.match(bad({ platform: 5 }), /repos\.platform/);
  assert.match(bad({ board: "a<b" }), /repos\.board/);
  assert.match(bad({ platform: "x".repeat(41) }), /repos\.platform/);
  assert.match(bad({ platform: "Dock", board: "dock" }), /different names/);
  assert.match(bad({ builders: "Smith" }), /repos\.builders/);
  assert.match(bad({ builders: ["<b>"] }), /repos\.builders/);
  assert.match(bad({ builders: Array(21).fill("Smith") }), /repos\.builders/);
});

test("the badge is styled for both themes from the page's own variables, and names its repository in words", () => {
  assert.match(page, /\.c-repo\{[^}]*var\(--muted\)[^}]*var\(--line\)/);
  assert.match(page, /\.c-repo\.fb\{[^}]*var\(--accent\)/);
  assert.doesNotMatch(page.match(/\.c-repo[^\n]*/g).join("\n"), /#[0-9a-f]{3,6}\b/i, "no fixed colours: the variables carry the dark theme");
});
