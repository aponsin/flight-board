// collapse-next-held (#C935, the owner's pick B): a card row keeps its phase strip, badges, the "Held: <reason>" words and an open ask's red
// line in view; the Next line and the held end time sit behind one "Details" fold beside "Start a thread".
import test from "node:test";
import assert from "node:assert/strict";
import { loadBoard } from "./harness.mjs";

const DAY = 86_400_000;
const b = loadBoard();
const draw = (f) => { b.state.steps = []; b.state.waiting = []; b.state.derived = []; return b.initRow(b.gates(b.enrich({ id: "x", level: "Quick", customerText: false, skip: ["plan"], status: "active", name: "X", ...f }))); };
const parts = (html) => {
  const meta = html.match(/<div class="i-meta">([\s\S]*?)<\/div><div class="i-acts">/);
  const acts = html.match(/<div class="i-acts">([\s\S]*)<\/div><\/div>$/);
  assert.ok(meta && acts, "the row has a meta line and an actions row");
  return { meta: meta[1], acts: acts[1] };
};

test("Next and the full Held line are inside the Details fold, which sits beside the thread fold", () => {
  const { meta, acts } = parts(draw({ nextNote: "Builder pushes the branch", nextNoteAt: Date.now() - 60_000, waitingOn: "the owner", checkAt: Date.now() + DAY }));
  assert.ok(!/Next:/.test(meta), "Next is not in the always-visible meta line");
  assert.ok(!/, until /.test(meta), "the end time is not in the meta line");
  assert.match(meta, /<span class="held-line">Held: the owner<\/span>/, "the Held reason words stay in view");
  assert.match(acts, /<details class="i-det" data-id="idet-x"><summary>Details<\/summary>/);
  assert.match(acts, /Next: <b>Builder pushes the branch<\/b>/);
  assert.match(acts, /<span class="held-line">Until: /, "the fold says only when the hold ends");
  assert.ok(!/Held: the owner/.test(acts), "the reason is not repeated inside the fold");
  assert.ok(acts.indexOf('class="i-det"') < acts.indexOf('class="i-thread"'), "Details comes before the thread fold, in the same row");
  assert.match(acts, /<summary>Start a thread<\/summary>/);
});

test("a card with nothing to fold has no Details button; a Next line alone gets one", () => {
  assert.ok(!/i-det/.test(draw({})), "no Next, no hold: no button");
  const { meta, acts } = parts(draw({ nextNote: "Check the diff", nextNoteAt: Date.now() - 1000 }));
  assert.ok(!/Next:/.test(meta));
  assert.match(acts, /<details class="i-det"/);
});

test("a hold with no end text to hide leaves the held words in view and only Next in Details", () => {
  const { meta, acts } = parts(draw({ nextNote: "n", nextNoteAt: Date.now() - 1000, blocked: "keys", status: "blocked" }));
  assert.match(meta, /Held: keys/);
  assert.ok(!/until no end set/.test(meta));
  assert.match(acts, /Until: no end set/);
});

test("an open ask's red line, the phase strip and the badges stay in view", () => {
  b.state.derived = [{ id: "all", cards: { x: { red: ["An ask for the owner is open on this card: answer it to go on"] } } }];
  b.state.steps = []; b.state.waiting = [];
  const html = b.initRow(b.gates(b.enrich({ id: "x", level: "Quick", customerText: false, skip: ["plan"], status: "active", name: "X", nextNote: "n", nextNoteAt: Date.now() - 1000 })));
  const { meta, acts } = parts(html);
  assert.match(meta, /class="redline"[\s\S]*An ask for the owner is open/);
  assert.ok(!/redline/.test(acts), "the red line is not folded away");
  assert.match(html, /<div class="track">/, "the phase strip is still drawn");
});

test("the card's text is escaped inside the fold like everywhere else", () => {
  const { acts } = parts(draw({ nextNote: "<img src=x onerror=1>", nextNoteAt: Date.now() - 1000, waitingOn: "<b>x</b>", checkAt: Date.now() + DAY }));
  assert.ok(!/<img src=x/.test(acts));
  assert.match(acts, /&lt;img src=x/);
  const held = parts(draw({ nextNote: "n", nextNoteAt: Date.now() - 1000, waitingOn: "x", holdEnd: "<b>t1</b>" })).acts;
  assert.ok(!/<b>t1<\/b>/.test(held) && /Until: &lt;b&gt;t1/.test(held), "the end text is escaped too");
});
