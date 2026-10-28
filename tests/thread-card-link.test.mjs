// A thread follows what it became (#C364, the owner's B in #T973 and #T979). "Waiting on Manager" is now "With the
// team": the threads Manager is answering ("Manager answering") and those that became a card still in flight
// ("→ #C356 · Build · ~01:30", the tag opening the card; the card shows its #T back). Once the card is live, Manager's
// 'live' moves it to Needs you for the owner's Ack. A thread's badge is its latest state (Question, Building #C356,
// Answer, Live, Decision) and its buttons follow: Answer and Live an Ack that closes it, Decision its options, Building
// none. After the owner sends a new thread, the box says where it landed until his next keystroke.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadNames } from "./harness.mjs";

const page = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
const T = Date.now();
const msg = (thread, from, text, at, extra = {}) => ({ id: `m${at}${from}${thread}`, thread, from, text, at, ...extra });
const cards = () => [
  { id: "card-356", num: 356, name: "Thread links", size: "M", status: "active", phase: "build", thread: "t-b", etaLive: T + 2 * 36e5, createdAt: T - 9e5 },
  { id: "card-357", num: 357, name: "Shipped one", size: "S", status: "done", phase: "live", thread: "t-l", doneAt: T - 3e5 },
  { id: "card-358", num: 358, name: "Two threads", size: "S", status: "active", phase: "checker", threads: ["t-m", "t-qb"], etaLive: T + 36e5 },
  { id: "card-359", num: 359, name: "Live, no word yet", size: "S", status: "done", phase: "live", thread: "t-lk", doneAt: T - 2e5 },
];
function board() {
  const b = loadNames(["threadState", "waitsOn", "threadRow", "threadsHtml", "tabsHtml", "youItems", "tabCounts", "closeWrites", "optionText", "initRow", "trefPlace", "sentLine", "ntReceiptClear"]);
  Object.assign(b.state, {
    steps: [], derived: [], todo: [], ideas: [], waiting: [],
    initRaw: cards(), initiatives: cards(),
    messages: [
      msg("t-q", "Owner", "Can the board show ETAs?", T - 6e5),
      msg("t-b", "Owner", "Link threads to cards", T - 9e5), msg("t-b", "Manager", "Card #C356, Boardsmith builds it", T - 8e5, { kind: "building" }),
      msg("t-m", "Owner", "Two at once", T - 9e5), msg("t-m", "Manager", "One card for both", T - 8e5),
      msg("t-qb", "Owner", "Also this", T - 9e5), msg("t-qb", "Manager", "Folded in", T - 8e5, { kind: "building" }), msg("t-qb", "Owner", "And when?", T - 7e5),
      msg("t-l", "Owner", "Fix the pill", T - 9e5), msg("t-l", "Manager", "Card #C357", T - 8e5, { kind: "building" }), msg("t-l", "Manager", "Live now", T - 2e5, { kind: "live" }),
      msg("t-lk", "Owner", "Fix the count", T - 9e5), msg("t-lk", "Manager", "Card #C359", T - 8e5, { kind: "building" }),
      msg("t-a", "Owner", "Is it Tuesday?", T - 5e5), msg("t-a", "Manager", "Yes", T - 4e5),
      msg("t-d", "Owner", "Which colour?", T - 5e5), msg("t-d", "Manager", "Pick one", T - 4e5, { kind: "decision", options: [{ key: "A", label: "Red" }, { key: "B", label: "Blue <b>" }] }),
    ],
    threads: [{ id: "t-b", num: 979 }, { id: "t-q", num: 980 }],
  });
  return b;
}
const rowOf = (b, id) => b.threadRow(id, T);

test("a thread's state is its latest: Question, Building, Answer, Live, Decision", () => {
  const b = board();
  const s = (id) => b.threadState(id, T);
  assert.equal(s("t-q"), "question", "the owner's word is the last");
  assert.equal(s("t-b"), "building", "it became #C356, in flight");
  assert.equal(s("t-m"), "building", "a card listing it in threads: [], in flight, though Manager's word names no kind");
  assert.equal(s("t-qb"), "question", "the owner asked again under a building thread");
  assert.equal(s("t-l"), "live", "Manager posted live");
  assert.equal(s("t-lk"), "live", "its card went live before Manager's word: never stuck as building");
  assert.equal(s("t-a"), "answer", "Manager's word with no kind informs");
  assert.equal(s("t-d"), "decision");
});

test("With the team holds the threads Manager is answering and those that became a card in flight; Needs you the rest", () => {
  const b = board();
  for (const id of ["t-q", "t-b", "t-m", "t-qb"]) assert.equal(b.waitsOn(id, T), "lead", id);
  for (const id of ["t-l", "t-lk", "t-a", "t-d"]) assert.equal(b.waitsOn(id, T), "answered", id);
  assert.deepEqual([...b.youItems(T, "").answered].sort(), ["t-a", "t-d", "t-l", "t-lk"]);
  assert.equal(b.tabCounts(T, "").lead, 4);
  assert.equal(JSON.stringify(b.trefPlace("t-b", T)), '{"tab":"lead"}', "a #T link to a building thread opens With the team");
  assert.equal(JSON.stringify(b.trefPlace("t-l", T)), '{"tab":"you"}');
});

test("the tab, its badge and its empty line say 'With the team'", () => {
  const b = board();
  assert.match(b.tabsHtml(T), /data-tab="lead">With the team <span/);
  assert.doesNotMatch(page, /"Waiting on Manager"\]/);
  assert.match(rowOf(b, "t-q"), /<span class="t-badge open">with the team<\/span>/);
  b.state.messages = [];
  assert.match(b.threadsHtml(T), /<div class="empty">Nothing with the team\.<\/div>/);
});

test("each With the team row says which: Manager answering, or the card it became with its phase and ETA", () => {
  const b = board();
  assert.match(rowOf(b, "t-q"), /<div class="w-sub t-with">Manager answering<\/div>/);
  assert.match(rowOf(b, "t-qb"), /<div class="w-sub t-with">Manager answering<\/div>/);
  const r = rowOf(b, "t-b");
  assert.match(r, /<div class="w-sub t-with">→ <a href="#" class="t-ref c-ref" data-tref="card-356">#C356<\/a> · Build · ~\d/, "the tag opens the card");
  assert.match(rowOf(b, "t-m"), /data-tref="card-358">#C358<\/a> · Checker · ~\d/);
  assert.doesNotMatch(rowOf(b, "t-a"), /t-with/, "Needs you rows carry no such line");
});

test("the badge is the state; the buttons follow it", () => {
  const b = board();
  const chip = (id) => (rowOf(b, id).match(/<span class="kind[^"]*">[^<]*<\/span>/) || [""])[0];
  assert.equal(chip("t-q"), '<span class="kind question">Question</span>');
  assert.equal(chip("t-b"), '<span class="kind building">Building #C356</span>');
  assert.equal(chip("t-l"), '<span class="kind live">Live</span>');
  assert.equal(chip("t-a"), '<span class="kind answer">Answer</span>');
  assert.equal(chip("t-d"), '<span class="kind decision">Decision</span>');
  const has = (id, attr) => new RegExp(`${attr}="${id}"`).test(rowOf(b, id));
  for (const id of ["t-l", "t-lk", "t-a"]) {
    assert.ok(has(id, "data-tack"), `${id}: Ack`);
    assert.ok(!has(id, "data-tclose"), `${id}: Ack is its close`);
  }
  assert.match(rowOf(b, "t-a"), /<button type="button" class="ok" data-tack="t-a" data-where="panel">Ack<\/button>/);
  const d = rowOf(b, "t-d");
  assert.match(d, /data-topt="t-d" data-choice="A" data-where="panel"><b>A<\/b> Red<\/button>/);
  assert.match(d, /data-choice="B" data-where="panel"><b>B<\/b> Blue &lt;b&gt;<\/button>/, "escaped");
  assert.ok(!has("t-d", "data-tack"), "a decision is picked, not acked");
  for (const id of ["t-b", "t-m"]) {
    assert.ok(has(id, "data-tsend"), `${id}: the owner can still write`);
    for (const a of ["data-tack", "data-tclose", "data-topt"]) assert.ok(!has(id, a), `${id}: building shows no ${a}`);
  }
  assert.ok(has("t-q", "data-tclose"), "a question keeps Close");
});

test("Ack closes the thread with one click, no note; an option sends the owner's pick", () => {
  const b = board();
  const [w] = b.closeWrites("t-a", T, "x1", "Ack.");
  assert.deepEqual(JSON.parse(JSON.stringify(w)), { op: "set", path: `messages/m${T}-x1`, data: { thread: "t-a", from: "Owner", text: "Ack.", at: T, resolved: true } });
  assert.equal(b.closeWrites("t-a", T, "x1")[0].data.text, "Closed.", "Close unchanged");
  assert.equal(b.optionText("t-d", "B"), "Chose B: Blue <b>");
  assert.equal(b.optionText("t-d", "Z"), null, "not one of its options");
  assert.match(page, /closest\("\[data-tack\]"\)[\s\S]{0,400}closeWrites\(id,Date\.now\(\),Math\.random\(\)\.toString\(36\)\.slice\(2,8\),"Ack\."\)/);
  assert.match(page, /closest\("\[data-topt\]"\)[\s\S]{0,400}optionText\(id,b\.dataset\.choice\)[\s\S]{0,300}sendThread\(b,id,/);
});

test("the card shows the thread it came from, which opens it", () => {
  const b = board();
  assert.match(b.initRow(b.state.initiatives[0]), /<span class="c-from">from <a href="#" class="t-ref" data-tref="t-b">#T979<\/a><\/span>/);
  assert.doesNotMatch(b.initRow(b.state.initiatives[2]), /c-from/, "threads with no number yet: nothing to show");
});

test("after sending, the new-thread box says where it landed, until the next keystroke", () => {
  const b = board();
  assert.equal(b.sentLine("t-b", "sent"), '<span class="receipt">Sent · in <a href="#" class="t-ref" data-tref="t-b">With the team →</a></span>');
  assert.match(b.sentLine("t-new", "batch"), /^<span class="receipt">Saved · in <a href="#" class="t-ref" data-tref="t-new">With the team →<\/a>\. Manager reads it at its next check \(within 5 minutes\)\.<\/span>$/, "not yet on the board: it lands in With the team");
  assert.match(b.sentLine("t-new", "unsent", "refused: <x>"), /Saved · in .*With the team →<\/a>\. Not sent to Manager \(refused: &lt;x&gt;\); Manager picks it up at its next check\./);
  const m = b.document.getElementById("ntmsg");
  m.innerHTML = b.sentLine("t-b", "sent");
  b.ntReceiptClear();
  assert.equal(m.innerHTML, "");
  m.innerHTML = "photo.heic: HEIC photos can't be stored here.";
  b.ntReceiptClear();
  assert.notEqual(m.innerHTML, "", "a file's error stays");
  assert.match(page, /key==="new"\)\{msg\.innerHTML=sentLine\(id,/);
  assert.match(page, /if\(e\.target&&e\.target\.id==="nttext"\)\{ntHas\(\);ntReceiptClear\(\)\}/);
});
