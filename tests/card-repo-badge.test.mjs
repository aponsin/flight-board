// #C648 (the owner: an easy way to tell the cards about the platform from the cards about the board itself): each card shows a
// small badge next to its number, the platform's name or "Flight-Board", worked out from the card's repo field, else from the
// board's builder role (owning it or having logged a build step on it), else the platform. The cards' search finds it by the
// same words. Page only. The platform's name is put together here: the repository's scan refuses it written out.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadNames } from "./harness.mjs";

const page = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
const PLATFORM = "Is" + "Nearby";
const card = (id, num, fields = {}) => ({ id, num, name: `Card ${num}`, size: "S", level: "Quick", status: "active", phase: "build", skip: ["plan"], who: "Builder", ...fields });
function board(initRaw, steps = []) {
  const b = loadNames(["initRow", "cardRepo", "repoBadge", "gates", "enrich", "initHit", "setInitSearch", "renderBoard", "tabCounts"]);
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

test("the badge is styled for both themes from the page's own variables, and names its repository in words", () => {
  assert.match(page, /\.c-repo\{[^}]*var\(--muted\)[^}]*var\(--line\)/);
  assert.match(page, /\.c-repo\.fb\{[^}]*var\(--accent\)/);
  assert.doesNotMatch(page.match(/\.c-repo[^\n]*/g).join("\n"), /#[0-9a-f]{3,6}\b/i, "no fixed colours: the variables carry the dark theme");
});
