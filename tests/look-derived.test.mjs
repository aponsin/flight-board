// A look decision is derived, never taken on the writer's word (#C344, the Director's card): its text or title names a
// look word (decisions.lookWords), or its card is in a visual lane (decisions.visualLanes); it then needs a picture per
// option, as before. An ask never sends the owner off the board to chat (decisions.offBoard). The page shows each
// option's picture beside its button.
import test from "node:test";
import assert from "node:assert/strict";
import { fullConfig, checkConfig, DEFAULTS } from "../scripts/config.mjs";
import { checkWrites } from "../gate/rules.mjs";
import { loadBoard, renderWaitingHtml, step } from "./harness.mjs";

const NOW = 1_800_000_123_457;
const config = fullConfig({ artifactUrl: "https://claude.ai/" + "artifact/TestBoard01", decisions: { visualLanes: ["Designer", "Demos"] } });
const lead = { role: "Manager", manager: true };
const two = [{ key: "A", label: "one" }, { key: "B", label: "two" }];
const pics = [{ url: "/_blob/abcdefgh", option: "A" }, { url: "/_blob/ijklmnop", option: "B" }];
const ask = (data, id = "w") => ({ op: "set", collection: "waiting", doc_id: id, data: { kind: "decision", since: NOW, done: false, text: "Pick one", options: two, ...data } });
const card = (id, who, extra = {}) => ({ id, name: id, size: "S", status: "active", who, ...extra });
const seen = { docs: { initiatives: [card("c-design", "Designer"), card("c-gate", "Boardsmith"), card("c-review", "Checker")], steps: [step("c-review", "build", "Demos", "start", NOW - 9e6), step("c-review", "build", "Demos", "end", NOW - 8e6)], waiting: [] }, at: NOW - 6e5, atBy: {} };
const errs = (writes, { cfg = config, s = seen } = {}) => checkWrites([].concat(writes), { config: cfg, who: lead, now: NOW, state: {}, mirror: null, seen: s }).errors.join(" | ");
const LOOK = /a look decision needs a screenshot for each option \(missing: A, B\)/;

test("a decision whose text or title names a look word needs a picture per option, whatever look says", () => {
  assert.match(errs(ask({ text: "Which hero photo goes first?" })), LOOK);
  assert.match(errs(ask({ title: "Banner: A or B?" })), LOOK);
  assert.match(errs(ask({ text: "The mock-ups are in the thread: which one?" })), LOOK, "a plural and a hyphen");
  assert.match(errs(ask({ text: "Is 12px enough?" })), LOOK, "px after a number");
  assert.match(errs(ask({ text: "Which text size reads best?" })), LOOK, "a two-word entry");
  assert.match(errs(ask({ text: "Which button colour?", look: false })), LOOK, "look: false no longer unmakes one");
  assert.match(errs(ask({ text: "Anything", look: true })), LOOK, "look: true still makes one");
  assert.doesNotMatch(errs(ask({ text: "Which hero photo goes first?", images: pics })), /look decision/);
});

test("a look word counts only as a whole word; a decision with none, off the visual lanes, is no look", () => {
  assert.doesNotMatch(errs(ask({ text: "Ship v1.2 today or tomorrow?" })), /look decision/);
  assert.doesNotMatch(errs(ask({ text: "Raise the bandwidth cap?" })), /look decision/, "band inside a word");
  assert.doesNotMatch(errs(ask({ text: "Fix the iconography docs?", initiative: "c-gate" })), /look decision/, "icon inside a word");
});

test("Manager: a device or 'looks good?' question is no look by its words: phone, laptop and looks are off the list", () => {
  assert.doesNotMatch(errs(ask({ text: "Which phone number goes on the contact form?", options: [...two, { key: "C", label: "Something else" }] })), /look decision/);
  assert.doesNotMatch(errs(ask({ text: "The fix looks good on my laptop: ship it today or tomorrow?" })), /look decision/);
  for (const w of ["phone", "laptop", "looks"]) assert.ok(!DEFAULTS.decisions.lookWords.includes(w), w);
  for (const w of ["button", "photo"]) assert.ok(DEFAULTS.decisions.lookWords.includes(w), w);
});

test("a decision on a card in a visual lane is a look, by the card's who or whoever built it", () => {
  assert.match(errs(ask({ text: "Ship v1.2 today or tomorrow?", initiative: "c-design" })), LOOK);
  assert.match(errs(ask({ text: "Ship v1.2 today or tomorrow?", initiative: "c-review" })), LOOK, "Demos built it; Checker holds it now");
  assert.doesNotMatch(errs(ask({ text: "Ship v1.2 today or tomorrow?", initiative: "c-gate" })), /look decision/);
  assert.match(errs([{ op: "set", collection: "initiatives", doc_id: "c-new", data: card("c-new", "Demos") }, ask({ text: "Ship today?", initiative: "c-new" })], { s: { docs: { initiatives: [], steps: [], waiting: [] } } }), LOOK, "a card made in the same batch");
  assert.doesNotMatch(errs(ask({ text: "Ship today?", initiative: "c-design" }), { s: null }), /look decision/, "no board seen: words only");
});

// Checker's FINDINGS on 001aaa6a: an update went unchecked. It is laid over the ask the board holds (and this batch's
// earlier writes), and the result checked, when it touches what makes a look or its pictures.
const asks = [{ id: "w-plain", kind: "decision", text: "Which plan do we pick?", options: two, since: NOW - 6e5, done: false }, { id: "w-look", kind: "decision", text: "Which hero do we keep?", options: two, images: pics, since: NOW - 6e5, done: false }, { id: "w-old", kind: "decision", text: "Which hero, from before the rule?", options: two, since: NOW - 6e5, done: false }];
const withAsks = { ...seen, docs: { ...seen.docs, waiting: asks } };
const upd = (id, data) => ({ op: "update", collection: "waiting", doc_id: id, data });

test("Checker 1: an update that makes a plain decision a look one needs its pictures", () => {
  assert.match(errs(upd("w-plain", { text: "Which hero photo do we keep?" }), { s: withAsks }), LOOK);
  assert.match(errs(upd("w-plain", { initiative: "c-design" }), { s: withAsks }), LOOK, "moved onto a visual lane's card");
  assert.doesNotMatch(errs(upd("w-plain", { text: "Which hero photo do we keep?", images: pics }), { s: withAsks }), /look decision/);
});

test("Checker 2: an update can't take a look decision's pictures away", () => {
  assert.match(errs(upd("w-look", { images: [] }), { s: withAsks }), LOOK);
  assert.match(errs(upd("w-look", { images: { __delete__: true } }), { s: withAsks }), LOOK);
  assert.match(errs([{ op: "set", collection: "waiting", doc_id: "w-new", data: { kind: "decision", since: NOW, done: false, text: "Which hero?", options: two, images: pics } }, upd("w-new", { images: [] })], { s: withAsks }), LOOK, "an earlier set in the batch counts");
});

test("Checker 3: an option added by an update needs its picture", () => {
  assert.match(errs(upd("w-look", { options: [...two, { key: "C", label: "Something new" }] }), { s: withAsks }), /missing: C\)/);
});

test("an update that touches nothing a look depends on passes, and closing an ask always does", () => {
  assert.doesNotMatch(errs(upd("w-old", { ping: "sent" }), { s: withAsks }), /look decision/, "an ask from before the rule");
  assert.doesNotMatch(errs(upd("w-old", { done: true, doneAt: NOW }), { s: withAsks }), /look decision/);
  assert.doesNotMatch(errs(upd("w-look", { images: [], done: true }), { s: withAsks }), /look decision/);
});

test("the lists come from the config: an empty word list or no visual lanes derives nothing", () => {
  const none = fullConfig({ artifactUrl: config.artifactUrl, decisions: { lookWords: [], visualLanes: [] } });
  assert.doesNotMatch(errs(ask({ text: "Which hero photo goes first?", initiative: "c-design" }), { cfg: none }), /look decision/);
  assert.ok(DEFAULTS.decisions.lookWords.includes("screenshot"));
  assert.deepEqual(DEFAULTS.decisions.visualLanes, [], "lanes are the team's: none by default");
});

test("an ask that sends the owner off the board to chat is refused, in any of its texts", () => {
  const OFF = /sends the owner off the board \("[^"]+"\): the board is the place: attach it/;
  assert.match(errs(ask({ text: "The shots are in Manager chat: which one?", images: pics })), OFF);
  assert.match(errs({ op: "set", collection: "waiting", doc_id: "w", data: { kind: "answer", since: NOW, done: false, text: "See chat for the log.", question: "q" } }), OFF);
  assert.match(errs({ op: "set", collection: "waiting", doc_id: "w", data: { kind: "action", since: NOW, done: false, text: "Run it", steps: ["Paste the command I put in the chat"] } }), OFF);
  assert.match(errs({ op: "update", collection: "waiting", doc_id: "w", data: { text: "Details in chat." } }), OFF, "an update too");
  assert.match(errs(ask({ options: [{ key: "A", label: "one" }, { key: "B", label: "talk it over in chat" }] })), OFF, "an option's label");
  assert.doesNotMatch(errs(ask({ text: "Which chatbot vendor: A or B?", options: two })), /off the board/, "chat inside a word");
  assert.doesNotMatch(errs({ op: "update", collection: "waiting", doc_id: "w", data: { done: true } }), /off the board/, "closing an ask is untouched");
});

test("the config: decisions holds short word lists and role names", () => {
  assert.deepEqual(checkConfig({ decisions: { lookWords: ["hero"], visualLanes: ["Designer"], offBoard: ["in chat"] } }), []);
  assert.ok(checkConfig({ decisions: { colour: 1 } }).some((p) => p.includes('decisions: unknown field "colour"')));
  assert.ok(checkConfig({ decisions: { lookWords: [""] } }).some((p) => p.startsWith("decisions.lookWords")));
  assert.ok(checkConfig({ decisions: { visualLanes: ["<b>"] } }).some((p) => p.startsWith("decisions.visualLanes")));
  assert.equal(fullConfig({ decisions: { visualLanes: ["X"] } }).decisions.lookWords.length > 0, true, "defaults kept under a partial decisions");
});

test("the page derives a look as the gate does: words, or the card's lane", () => {
  const b = loadBoard();
  const gap = (w) => [...b.waitGaps({ kind: "decision", text: "Ship today?", ...w })].includes("no screenshots");
  assert.ok(gap({ text: "Which hero photo?" }));
  assert.ok(gap({ text: "Which hero photo?", look: false }));
  assert.ok(!gap({}));
  b.state.initiatives = [card("c-design", "Designer")];
  assert.ok(!gap({ initiative: "c-design" }), "the template's own config has no lanes");
});

test("the page shows each option's picture beside its button", () => {
  const html = renderWaitingHtml([{ id: "w1", kind: "decision", text: "Which hero?", options: two, images: [...pics, { url: "/_blob/qrstuvwx", label: "today" }], since: Date.now(), done: false }]);
  for (const [k, u] of [["A", "abcdefgh"], ["B", "ijklmnop"]]) {
    assert.match(html, new RegExp(`<div class="opt-line"><div class="opt-shots">.*?data-full="/_blob/${u}".*?</div><button type="button" class="opt" data-act="chose" data-choice="${k}"`), `option ${k}`);
  }
  assert.doesNotMatch(html, /<div class="shot-opt">/, "the option pictures aren't drawn twice");
  assert.match(html, /<div class="shots">.*data-full="\/_blob\/qrstuvwx"/s, "a picture for no option stays above");
});

test("an answered decision keeps its pictures, by option, above the sent line", () => {
  const html = renderWaitingHtml([{ id: "w1", kind: "decision", text: "Which hero?", options: two, images: pics, since: Date.now(), done: false, response: { status: "chose", choice: "A", at: Date.now() } }]);
  assert.match(html, /<div class="shot-opt">Option A<\/div>/);
  assert.doesNotMatch(html, /opt-line/);
});
