// #C667 (the owner in #T1437): a thread's type label follows what is needed now, not the kind of the item that began it.
// A decision he has picked stops saying Decision once anyone posts after the pick; a thread where Manager only reports is an
// Ack, and a new open question in it is a Question. Which threads sit under Needs you does not change.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadNames } from "./harness.mjs";

const page = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
const T = Date.now();
const msg = (thread, from, text, at, extra = {}) => ({ id: `m${at}${from}${thread}`, thread, from, text, at, ...extra });
const PICK = T - 3e5;
const ask = (kind, extra = {}) => ({ id: "w-1", kind, text: "Pick one", since: T - 6e5, ...extra });
const picked = (kind = "decision") => ask(kind, { response: { status: "ok", at: PICK } });
function board(waiting, messages = []) {
  const b = loadNames(["askHtml", "threadRow", "askNeed", "waitsOn", "youItems", "threadState"]);
  Object.assign(b.state, { steps: [], derived: [], todo: [], ideas: [], initRaw: [], initiatives: [], threads: [], waiting, messages });
  return b;
}
const chip = (html) => html.match(/<span class="kind ([^"]*)">([^<]*)(?:<span|<\/span>)/).slice(1, 3).join("|");
const askChip = (w, messages) => chip(board([w], messages).askHtml(w, new Set()));
const rowChip = (w, messages) => chip(board([w], messages).threadRow(w.id, T, "panel", w));

test("an ask waiting for the owner keeps its own kind: Decision, Your click, Session", () => {
  assert.equal(askChip(ask("decision"), []), "decision|Decision");
  assert.equal(askChip(ask("action"), []), "action|Your click");
  assert.equal(askChip(ask("session"), []), "session|Session");
  assert.equal(askChip(ask("answer"), []), "answer|Answer", "an ask whose own kind is an answer is unchanged");
});

test("a decision he picked still says Decision until someone posts after the pick, then it follows the newest word", () => {
  const w = picked();
  assert.equal(askChip(w, []), "decision|Decision", "no word after the pick");
  assert.equal(askChip(w, [msg("w-1", "Manager", "Before the pick", PICK - 1e3)]), "decision|Decision", "a word BEFORE the pick does not count");
  assert.equal(askChip(w, [msg("w-1", "Owner", "Looks fine, thanks for that", PICK + 1e3)]), "conversation|Conversation", "he posts after the pick");
  assert.equal(askChip(w, [msg("w-1", "Manager", "Noted, building it", PICK + 1e3)]), "answer|Ack", "Manager only reports");
  assert.equal(askChip(w, [msg("w-1", "Manager", "Which colour next?", PICK + 1e3)]), "question|Question", "Manager asks something");
  assert.equal(askChip(w, [msg("w-1", "Owner", "Can it be bigger?", PICK + 1e3)]), "question|Question", "he asks something");
  assert.equal(askChip(w, [msg("w-1", "Manager", "Pick again", PICK + 1e3, { kind: "decision", options: [{ key: "A", label: "x" }] })]), "decision|Decision", "a new open decision");
  assert.equal(askChip(w, [msg("w-1", "Manager", "Card #C1", PICK + 1e3, { kind: "building" })]), "building|Building");
  assert.equal(askChip(w, [msg("w-1", "Manager", "Live now", PICK + 1e3, { kind: "live" })]), "live|Live");
});

test("only the NEWEST word after the pick counts, whoever wrote it", () => {
  const w = picked();
  const m = [msg("w-1", "Manager", "Which colour next?", PICK + 1e3), msg("w-1", "Owner", "Blue", PICK + 2e3)];
  assert.equal(askChip(w, m), "conversation|Conversation", "his answer closed the question");
  m.push(msg("w-1", "Manager", "Done, see the page", PICK + 3e3));
  assert.equal(askChip(w, m), "answer|Ack");
});

test("the same label on the thread row that draws a closed ask", () => {
  const w = picked();
  assert.equal(rowChip(w, [msg("w-1", "Owner", "Thanks", PICK + 1e3)]), "conversation|Conversation");
  assert.equal(rowChip(w, [msg("w-1", "Manager", "Noted", PICK + 1e3)]), "answer|Ack");
  assert.equal(rowChip(w, []), "decision|Decision");
});

test("a thread where Manager only reports is an Ack; a new open question in it is a Question", () => {
  const b = board([], [msg("t-a", "Owner", "Is it Tuesday?", T - 5e5), msg("t-a", "Manager", "Yes", T - 4e5)]);
  assert.equal(chip(b.threadRow("t-a", T)), "answer|Ack");
  b.state.messages.push(msg("t-a", "Owner", "And Wednesday?", T - 3e5));
  assert.equal(chip(b.threadRow("t-a", T)), "question|Question");
});

test("Needs you lists the same threads as before: a Manager word after the pick still brings the decision back to the owner", () => {
  const w = picked();
  const b = board([w], [msg("w-1", "Manager", "Noted, building it", PICK + 1e3)]);
  assert.equal(b.waitsOn("w-1", T), "you", "an unread Manager word keeps it under Needs you");
  assert.deepEqual(b.youItems(T, "").asks.map((x) => x.id), ["w-1"]);
  const c = board([w], [msg("w-1", "Owner", "Thanks", PICK + 1e3)]);
  assert.equal(c.waitsOn("w-1", T), "lead", "his own word is the last: with the team, as before");
});

// Designer on ba0cc20: Ack (and Live) are green on a green fill; --ok on --ok-soft is 4.33:1 in light, under 4.5 at .72rem. The
// chips use --ok-ink, which passes in both modes.
const lum = (hex) => { const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
test("the green chips (Ack, Live) pass 4.5:1 in light and dark", () => {
  const blocks = [...page.matchAll(/--ok:(#\w{6}); --ok-ink:(#\w{6}); --ok-soft:(#\w{6});/g)].map((m) => ({ ink: m[2], soft: m[3] }));
  assert.equal(blocks.length, 3, "the light root, the dark media block and the dark theme block each set --ok-ink");
  for (const b of blocks) assert.ok(ratio(b.ink, b.soft) >= 4.5, `${b.ink} on ${b.soft}: ${ratio(b.ink, b.soft).toFixed(2)}`);
  assert.match(page, /\.kind\.answer\{background:var\(--ok-soft\);color:var\(--ok-ink\)\}/);
  assert.match(page, /\.kind\.live\{background:var\(--ok-soft\);color:var\(--ok-ink\)\}/);
});

test("the chip is computed in one place and both chips use it", () => {
  assert.match(page, /function askNeed\(w\)/);
  assert.match(page, /const nk=askNeed\(w\);\s*const head=`<span class="kind \$\{esc\(chipClass\(nk\)\)\}">/);
  assert.match(page, /const nk=ask\?askNeed\(ask\):null;/);
  assert.match(page, /\.kind\.later,\.kind\.conversation\{/);
});
