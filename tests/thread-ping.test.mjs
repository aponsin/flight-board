// A Ping on a thread Manager hasn't answered (#C372, the owner in t-1793156758845): when the owner's message is a
// thread's newest and 10 minutes or more have passed, the row offers Ping. A press sends Manager the thread again through
// the reply route ("Board ping [<id>]: waiting N min: <first words>") and, once sent, records threadPings/<id> {at}; the
// row then says "Pinged HH:MM" until Manager answers. At most one ping per 10 minutes per thread.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadNames } from "./harness.mjs";

const page = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
const T = Date.now(), MIN = 60e3;
const msg = (thread, from, text, at, extra = {}) => ({ id: `m${at}${from}${thread}`, thread, from, text, at, ...extra });
function board(pings = []) {
  const b = loadNames(["threadRow", "pingState", "threadPingText", "threadPingWrites", "hhmm"]);
  Object.assign(b.state, {
    steps: [], derived: [], todo: [], ideas: [], waiting: [], initRaw: [], initiatives: [], threads: [{ id: "t-q", num: 990 }],
    messages: [
      msg("t-q", "Owner", "Can the board show who reviews each card, and when they last looked at it, on the card itself?", T - 12 * MIN),
      msg("t-new", "Owner", "Quick one", T - 9 * MIN),
      msg("t-a", "Owner", "Is it Tuesday?", T - 30 * MIN), msg("t-a", "Manager", "Yes", T - 25 * MIN),
    ],
    threadPings: pings,
  });
  return b;
}
const row = (b, id, now = T) => b.threadRow(id, now);
const PING = (id) => `<button type="button" class="t-ping" data-tping="${id}" title="Send Manager this thread again">Ping</button>`;

test("Ping shows once the owner's word has waited 10 minutes, and only then", () => {
  const b = board();
  assert.equal(b.pingState("t-q", T).show, "ping");
  assert.ok(row(b, "t-q").includes(PING("t-q")));
  assert.equal(b.pingState("t-new", T).show, null, "9 minutes: not yet");
  assert.ok(!row(b, "t-new").includes("data-tping"));
  assert.ok(row(b, "t-new", T + MIN).includes(PING("t-new")), "at 10 minutes");
  assert.equal(b.pingState("t-a", T).show, null, "Manager's word is the newest: nothing to ping");
  assert.ok(!row(b, "t-a").includes("data-tping"));
});

test("after a ping: 'Pinged HH:MM' until Manager answers; one ping per 10 minutes", () => {
  const b = board([{ id: "t-q", at: T - 2 * MIN }]);
  assert.deepEqual({ ...b.pingState("t-q", T) }, { show: "pinged", at: T - 2 * MIN });
  const r = row(b, "t-q");
  assert.ok(r.includes(`<span class="t-pinged">Pinged ${b.hhmm(T - 2 * MIN)}</span>`), r);
  assert.ok(!r.includes("data-tping"), "no second ping within 10 minutes");
  assert.ok(row(b, "t-q", T + 8 * MIN).includes(PING("t-q")), "10 minutes after the ping, again");
  assert.ok(row(b, "t-q", T + 8 * MIN).includes("Pinged "), "still saying when it was pinged");
  b.state.messages.push(msg("t-q", "Manager", "On it", T - MIN));
  assert.equal(b.pingState("t-q", T).show, null, "Manager answered: no ping, no 'Pinged'");
  assert.ok(!/t-ping/.test(row(b, "t-q")));
  // The owner writes again after the ping: the old ping is for an older word, and the clock starts from the new one.
  const c = board([{ id: "t-q", at: T - 40 * MIN }]);
  assert.equal(c.pingState("t-q", T).show, "ping", "a ping from before the owner's newest word doesn't count");
  assert.ok(!row(c, "t-q").includes("Pinged"));
  assert.equal(board([{ id: "t-q", at: "soon" }]).pingState("t-q", T).show, "ping", "a ping without a time is none");
});

test("the ping text: the thread id, how long it has waited, the first words of the owner's newest word", () => {
  const b = board();
  assert.equal(b.threadPingText("t-q", T), "Board ping [t-q]: waiting 12 min: Can the board show who reviews each card, and when they last looked at it, on…", "cut at a word, within 80 characters");
  assert.equal(b.threadPingText("t-new", T + MIN), "Board ping [t-new]: waiting 10 min: Quick one");
  b.state.messages.push(msg("t-l", "Owner", "line one\nline two", T - 70 * MIN));
  assert.equal(b.threadPingText("t-l", T), "Board ping [t-l]: waiting 70 min: line one line two", "one line");
});

test("a sent ping is recorded as threadPings/<id> {at}; only a thread id makes a document id", () => {
  const b = board();
  assert.deepEqual(JSON.parse(JSON.stringify(b.threadPingWrites("t-q", T))), [{ op: "set", path: "threadPings/t-q", data: { at: T } }]);
  assert.deepEqual(JSON.parse(JSON.stringify(b.threadPingWrites("../meta/x", T))), []);
  assert.match(page, /"timings","ctxRequests","checkRequests","threadPings"\]\.forEach\(sub\)/, "the page reads the pings");
  assert.match(page, /threadPings:\[\]\}/);
});

test("pressing Ping sends first and records only what was sent; the row doesn't open", () => {
  const h = page.slice(page.indexOf('closest("[data-tping]")'));
  assert.ok(h.length > 0 && page.includes('closest("[data-tping]")'));
  const body = h.slice(0, 700);
  assert.match(body, /e\.preventDefault\(\)/, "a button in the row's summary must not fold it open");
  assert.match(body, /prepAnchor\(b\)[\s\S]*sendPing\(anchor,threadPingText\(id,now\)\)[\s\S]*if\(sent\)await applyWrites\(threadPingWrites\(id,now\)\)/);
  assert.match(body, /pingState\(id,now\)\.show!=="ping"/, "re-checked on press: a double click sends once");
  assert.match(body, /lastPing="";const anchor=await prepAnchor\(b\)/, "Checker on 7b85ba9: 'Not sent' names this press's reason, never an older one");
});

test("Ping reads as a button beside the status pills, with a ~40 px hit area (Designer on 7b85ba9)", () => {
  const css = (page.match(/\.t-ping\{[^}]*\}/) || [""])[0];
  assert.match(css, /background:var\(--accent-soft\)/, "filled, unlike the outlined 'with the team' pill");
  assert.match(css, /border-radius:4px/, "a button's corners, not a pill's");
  assert.match(css, /position:relative/);
  assert.match(page, /\.t-ping::after\{content:"";position:absolute;inset:-11px -6px\}/, "the hit area grows, the look doesn't");
});
