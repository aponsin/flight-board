// #C923: the deaf line (#C392) named the frozen artifact on the store page, which has no such command. On the store there is
// no deaf line; its own line reads store facts only (an answer Manager has not taken), and points to the header's line.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { drawPage, TEMPLATE } from "./helpers/draw-page.mjs";
import { compatView, waitingDoc } from "../worker/compat-view.mjs";

const NOW = Date.now(), MIN = 60e3;
const ART = "https://claude.ai/artifact/AbC12";
const ask = (o) => ({ id: "ask-a", num: 7, type: "Decision", title: "Pick", asked_by: "Manager", card_id: null, body: JSON.stringify({ question: "Which hero?", options: ["Blue", "Green"] }), eta_at: null, eta_precondition: null, created_at: NOW - 90 * MIN, answered_at: null, answer: "", closed_at: null, answer_taken_at: null, ...o });
const view = (asks) => ({ tag: "t", now: NOW, live: { state: "unknown", age: null }, cards: [], asks, lists: [], evidence: {} });
const draw = (asks, host = "store") => { const { collections, probe } = compatView(view(asks)); return drawPage(collections, { probe, host, config: { artifactUrl: ART } }); };
const answered = (o) => ask({ answered_at: NOW - 40 * MIN, answer: "Blue", ...o });

test("on the store page an answer Manager took but did not close shows no banner", () => {
  const d = draw([answered({ answer_taken_at: NOW - 39 * MIN })]);
  assert.equal(d.els.stuck.hidden, true);
  assert.doesNotMatch(d.html, /class="deaf"/);
});

test("on the store page an answer untaken past the minutes shows 'has not taken your answer', pointing to the header, with no link", () => {
  const d = draw([answered()]);
  assert.match(d.els.stuck.innerHTML, /Manager has not taken your answer for 40 min/);
  assert.match(d.els.stuck.innerHTML, /"Manager not listening" line at the top/);
  assert.doesNotMatch(d.els.stuck.innerHTML, /claude\.ai|artifact|data-copy|<code>/);
  assert.equal(draw([answered({ answered_at: NOW - 10 * MIN })]).els.stuck.hidden, true, "10 minutes: not yet");
  assert.equal(draw([answered({ closed_at: NOW - MIN })]).els.stuck.hidden, true, "closed");
});

test("the compat view says whether an answer was taken, and nothing else about it", () => {
  assert.equal(waitingDoc(answered()).response.taken, false);
  assert.equal(waitingDoc(answered({ answer_taken_at: NOW })).response.taken, true);
  assert.equal(waitingDoc(ask()).response, undefined);
});

test("no store page prints the artifact's link, whatever the owner's words and answers", () => {
  const { collections, probe } = compatView({ ...view([answered(), answered({ id: "ask-b", answer_taken_at: NOW })]) });
  collections.messages = [{ id: "m1", thread: "t-1", from: "Owner", text: "hello", at: NOW - 45 * MIN }];
  const d = drawPage(collections, { probe, host: "store", config: { artifactUrl: ART } });
  assert.ok(!d.html.includes("AbC12") && !d.html.includes(ART), "no artifact link on the store page");
  assert.ok(!d.attrs.includes("AbC12"));
  // the frozen artifact page keeps its own banner, with the command
  const a = drawPage({ ...collections, waiting: [], messages: [{ id: "m2", thread: "t-1", from: "Owner", text: "hello", at: NOW - 45 * MIN }] }, { probe: null, host: null, config: { artifactUrl: ART } });
  assert.ok(a.els.stuck.innerHTML.includes(ART), "the artifact board still names its link");
  assert.match(a.els.stuck.innerHTML, /board pings may be off/);
});

// Prevention (#C923): every line the stuck strip can draw has a row in docs/PARITY.md, so no line is added to the page
// without saying what it does on the store.
test("every line the stuck strip draws has a docs/PARITY.md row", () => {
  const parity = readFileSync(new URL("../docs/PARITY.md", import.meta.url), "utf8");
  const rowFor = { stuckLines: "Manager stuck on", liveStuckLines: "waiting on you since", deafLine: "Manager silent", keeperLine: "Keeper line", liveE2eLine: "daily full test run" };
  const strip = TEMPLATE.match(/function renderStuck\(\)\{([^\n]*)/)[1];
  const drawn = [...new Set([...strip.matchAll(/\b([a-z]\w*Lines?)\(/g)].map((m) => m[1]))];
  assert.deepEqual(drawn.sort(), Object.keys(rowFor).sort(), "renderStuck draws these lines; a new one needs a row and an entry here");
  const rows = parity.split("\n").filter((l) => l.startsWith("|"));
  for (const [fn, words] of Object.entries(rowFor)) {
    assert.ok(new RegExp(`function ${fn}\\(`).test(TEMPLATE), `${fn} is in the page`);
    assert.ok(rows.some((r) => r.split("|")[1].includes(words)), `${fn}: no PARITY.md row whose Item has "${words}"`);
  }
});
