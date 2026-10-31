// A rearm ask's "type: <line>" step gets a Copy button for exactly that line (#C524): the owner pastes Manager's rearm line
// into its chat after a clear, and copying it by hand from a step's prose took the trailing note along. Fictional board.
import test from "node:test";
import assert from "node:assert/strict";
import { loadNames } from "./harness.mjs";

const URL_ = "https://claude.ai/" + "artifact/TestBoard01";
const LINE = `watch the flight board ${URL_}`;
const T = 1_800_000_000_000;
const rearm = (steps, more = {}) => ({ id: "manager-rearm-watch-1", kind: "action", rearm: true, since: T, text: "Manager can't hear the board", steps, ...more });
const copies = (html) => [...html.matchAll(/<div class="cmd"><code>([^<]*)<\/code><button type="button" class="copy" data-copy="([^"]*)">Copy<\/button><\/div>/g)].map((m) => [m[1], m[2]]);

test("typeLine: what follows 'type:', to the end of its first link; else to the step's end", () => {
  const b = loadNames(["typeLine"]);
  assert.equal(b.typeLine(`1. In the Manager session, type: ${LINE}`), LINE);
  assert.equal(b.typeLine(`1. In the Manager session, type: ${LINE} (the full address, not the board's name: a pasted link that turns into a title doesn't count)`), LINE, "the note after the link isn't the line");
  assert.equal(b.typeLine(`type: ${LINE}.`), LINE, "a sentence's full stop isn't the link's");
  assert.equal(b.typeLine("In Terminal, type: npm run board -- --check"), "npm run board -- --check", "no link: to the end");
  assert.equal(b.typeLine("2. Press Done here."), "");
  assert.equal(b.typeLine(""), "");
});

test("a rearm ask: the step with 'type:' gets the line and Copy; the other step nothing", () => {
  const b = loadNames(["askHtml"]);
  const w = rearm([{ text: `1. In the Manager session, type: ${LINE} (the full address)` }, { text: "2. Press Done here." }]);
  Object.assign(b.state, { waiting: [w], messages: [], threads: [{ id: w.id, num: 9, title: "Rearm" }] });
  assert.deepEqual(copies(b.askHtml(w, new Set())), [[LINE, LINE]]);
  const s = rearm([`1. In the Manager session, type: ${LINE}`, "2. Press Done here."]);
  assert.deepEqual(copies(b.askHtml(s, new Set())), [[LINE, LINE]], "string steps too");
});

test("no button without rearm: true, and a step's own cmd isn't doubled", () => {
  const b = loadNames(["askHtml"]);
  Object.assign(b.state, { waiting: [], messages: [], threads: [] });
  assert.deepEqual(copies(b.askHtml(rearm([{ text: `type: ${LINE}` }], { rearm: undefined }), new Set())), []);
  assert.deepEqual(copies(b.askHtml(rearm([{ text: `type: ${LINE}` }], { rearm: "yes" }), new Set())), [], "only the boolean true");
  assert.deepEqual(copies(b.askHtml(rearm([{ text: `type: ${LINE}`, cmd: "the cmd" }]), new Set())), [["the cmd", "the cmd"]], "the step's cmd is the one shown");
});

test("the line is escaped where it's drawn and copied raw", () => {
  const b = loadNames(["askHtml"]);
  Object.assign(b.state, { waiting: [], messages: [], threads: [] });
  const html = b.askHtml(rearm([{ text: `type: say "hi" & <go> ${URL_}` }]), new Set());
  assert.deepEqual(copies(html), [[`say &quot;hi&quot; &amp; &lt;go&gt; ${URL_}`, `say &quot;hi&quot; &amp; &lt;go&gt; ${URL_}`]]);
});

test("a click on it copies exactly the line and says Copied", async () => {
  let copied = null;
  const b = loadNames(["askHtml"], { navigator: { clipboard: { writeText: async (t) => { copied = t; } } } });
  const btn = { dataset: { copy: LINE }, textContent: "Copy", closest: (s) => (s === ".copy" ? btn : null) };
  for (const fn of b.listeners.click ?? []) fn({ target: btn, preventDefault() {} });
  await null; await null;
  assert.equal(copied, LINE);
  assert.equal(btn.textContent, "Copied");
});
