// The count next to "Initiatives in flight" (#C295, the owner's ask): the number of cards the list below it shows, in a
// badge drawn like the board's others (.t-badge, which only badge() writes), hidden when nothing is in flight.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadBoard } from "./harness.mjs";

const html = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
const card = (id, status) => ({ id, name: id, status, level: "Quick", phase: "build", skip: [] });

function render(cards) {
  const els = new Map(), b = loadBoard({ els });
  b.state.initRaw = cards;
  b.renderAll();
  return els.get("initcount");
}

test("the heading carries a count badge right after its text", () => {
  assert.ok(html.includes(`<h2 id="h-init">Initiatives in flight<span class="h-count" id="initcount" hidden></span></h2>`));
});

test("the badge shows how many cards are in flight, the same cards the list draws; done ones never", () => {
  const c = render([card("a", "active"), card("b", "queued"), card("c", "paused"), card("d", "done")]);
  assert.equal(c.textContent, "3");
  assert.equal(c.hidden, false);
});

test("nothing in flight: no badge", () => {
  const c = render([card("d", "done")]);
  assert.equal(c.textContent, "");
  assert.equal(c.hidden, true);
});
