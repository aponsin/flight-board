// #C1334 (Release's #T2178, look OK on #C1322): the look-needs-screenshots rule forced a picture under every option, so a plain "changes" option carried
// the design's shot and read as if it were a different design. A plain "changes" option needs none as long as some option shows a picture; a look
// decision with no picture at all is still refused, and the A/B design choice with one picture each still passes.
import test from "node:test";
import assert from "node:assert/strict";
import { lookRefusal } from "../worker/board-rules.mjs";

const opt = (...labels) => labels.map((label, i) => ({ key: "ABCD"[i], label }));
const shot = (letter, label = "the page") => `fileidabcdefghijklmn ${letter}: ${label}`;
const texts = ["Is the layout OK on the Spanish page?"];

test("a plain changes option needs no picture while another option has one", () => {
  assert.equal(lookRefusal({ texts, options: opt("Looks right", "Changes"), shots: [shot("A")] }), null);
  assert.equal(lookRefusal({ texts, options: opt("Looks right", "changes needed"), shots: [shot("A")] }), null);
  assert.equal(lookRefusal({ texts, options: opt("Looks right", "Needs changes."), shots: [shot("A")] }), null);
  assert.equal(lookRefusal({ texts, options: opt("Looks right", "Changes", "Not now"), shots: [shot("A")] }), null, "with Not now too");
});

test("must still refuse: a look decision with no picture at all, a changes option or not", () => {
  assert.match(lookRefusal({ texts, options: opt("Looks right", "Changes"), shots: [] })?.detail, /missing: A, B\)/);
  assert.match(lookRefusal({ texts, options: opt("Changes", "Not now"), shots: [] })?.detail, /missing: A\)/, "changes is no exemption with nothing shown");
});

test("must still refuse: an option that only starts with the word changes, or a real look, still needs its picture", () => {
  assert.match(lookRefusal({ texts, options: opt("Looks right", "Changes the band to blue"), shots: [shot("A")] })?.detail, /missing: B\)/);
  assert.match(lookRefusal({ texts, options: opt("Blue band", "Green band"), shots: [shot("A")] })?.detail, /missing: B\)/);
});

test("must still allow: the A/B design choice with one picture each", () => {
  assert.equal(lookRefusal({ texts, options: opt("Blue band", "Green band"), shots: [shot("A"), shot("B")] }), null);
});
