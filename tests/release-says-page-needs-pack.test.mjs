// #C1042: the link move says when a change is not live until the owner's pack (a page-only landing included), and "the next collector run uses it" only when it is.
import test from "node:test";
import assert from "node:assert/strict";
import { goesLive } from "../scripts/current.mjs";

test("a page-only landing says it needs the owner's pack, not 'the next collector run'", () => {
  const s = goesLive(["page/board.template.html", "tests/x.test.mjs"], []);
  assert.match(s, /Needs the owner's pack \(pc<N>\)/);
  assert.match(s, /page\/board\.template\.html/);
  assert.doesNotMatch(s, /^The next collector run uses it/);
});

test("a hook file or an owner-closure file says the same", () => {
  assert.match(goesLive(["hooks/red-ask-board.py"], []), /Needs the owner's pack/);
  assert.match(goesLive(["collector/state.mjs"], ["collector/state.mjs"]), /Needs the owner's pack/);
});

test("a collector-only landing (or nothing known) still says the next collector run uses it", () => {
  assert.equal(goesLive(["collector/derive.mjs", "tests/a.test.mjs"], ["collector/state.mjs"]), "The next collector run uses it.");
  assert.equal(goesLive(null, []), "The next collector run uses it.");
});
