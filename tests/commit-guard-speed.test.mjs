// #C1289, two follow-ups from the board-ack-ships reviews.
// (1) Security's LOW on #C1285: the first-push hook's heredoc-masking regex ran on every Bash command and went quadratic on many unterminated "<<" (a contrived 200 KB command took 6.9 s). A command
//     that does not hold both "git" and "commit" is not scanned at all.
// (2) Designer's note on #C1288: on the narrow 8-tile product track the tile read "RELEASE SH…"; under 760 px the " ships" is hidden, so "Release" shows whole.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { boardIdRefusal } from "../gate/first-push.mjs";
import { loadNames } from "./harness.mjs";

test("a huge command of unterminated heredoc starts, with no git commit in it, is let through at once (it is not scanned)", () => {
  const cmd = "cat <<X\n".repeat(25_000); // about 200 KB
  const t0 = performance.now();
  assert.equal(boardIdRefusal(cmd), null);
  const ms = performance.now() - t0;
  assert.ok(ms < 1000, `took ${Math.round(ms)} ms`);
});

test("a command with git but no commit, or commit but no git, is not scanned either; a git commit still is", () => {
  const huge = "cat <<X\n".repeat(25_000);
  for (const cmd of [`git log --grep="Board-Id: C1274"\n${huge}`, `echo commit "Board-Id: C1274"\n${huge}`]) {
    const t0 = performance.now();
    assert.equal(boardIdRefusal(cmd), null);
    assert.ok(performance.now() - t0 < 1000);
  }
  assert.ok(boardIdRefusal('git commit -m "x\n\nBoard-Id: C1274"'), "a real commit with a bad id is still refused");
  assert.equal(boardIdRefusal('git commit -m "x\n\nBoard-Id: good-id"'), null);
});

test("a product card's release tile draws the role and a hidable ' ships' part; the page hides it under 760 px; the status line keeps the full sentence", () => {
  const b = loadNames(["initRow", "gates", "enrich", "state"], {});
  const old = Date.now() - 5 * 3_600_000;
  b.state.derived = [{ id: "all", cards: { r2: { phase: "ship", wait: "release", evidence: "e" } } }];
  b.state.steps = []; b.state.waiting = [];
  const html = b.initRow(b.gates(b.enrich({ id: "r2", level: "Quick", customerText: false, skip: ["plan"], status: "active", name: "X", nextNote: "x", nextNoteAt: old, createdAt: old, etaLive: Date.now() + 1 })));
  assert.match(html, /<small class="rs">Release<span class="sl"> ships<\/span><\/small>/);
  assert.match(html, /Queued for Release(?:'|&#39;)s product ship/);
  const template = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
  assert.match(template, /@media \(max-width:760px\)\{[^}]*\.step small\.rs \.sl[^}]*display:none/);
});
