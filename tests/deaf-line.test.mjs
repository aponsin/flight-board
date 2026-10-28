// The deaf line (#C392): the owner's word with nothing from Manager after it, 30 minutes on, means Manager's board pings
// may be off, and only the owner can turn them back on (their own message to Manager with the board's link). The page
// says so at the top, with that command to copy, until Manager answers or raises waiting/rearm-pings itself.
import test from "node:test";
import assert from "node:assert/strict";
import { loadNames } from "./harness.mjs";

const T = 1_800_000_000_000, MIN = 60e3;
const msg = (thread, from, at, extra = {}) => ({ id: `m${at}-${thread}`, thread, from, text: "x", at, ...extra });
const board = (st = {}) => { const b = loadNames(["deafLine", "renderStuck", "CONFIG"]); b.CONFIG.artifactUrl = "https://claude.ai/artifact/AbC12"; Object.assign(b.state, st); return b; };
const CMD = "Turn the board's comment auto-replies back on: https://claude.ai/artifact/AbC12";

test("30 minutes of the owner's word with nothing from Manager: the line, with the command to copy", () => {
  const b = board({ messages: [msg("t-1", "Owner", T - 31 * MIN)] });
  const html = b.deafLine(T);
  assert.match(html, /Manager has said nothing for 31 min/);
  assert.match(html, /board pings may be off/);
  assert.ok(html.includes(`<code>${CMD.replace("'", "&#39;")}</code>`), html);
  assert.ok(html.includes(`data-copy="${CMD.replace("'", "&#39;")}"`), "a Copy button");
  assert.equal(board({ messages: [msg("t-1", "Owner", T - 29 * MIN)] }).deafLine(T), "", "29 minutes: not yet");
  assert.equal(board({ messages: [msg("t-1", "Owner", T - 31 * MIN), msg("t-1", "Manager", T - 5 * MIN)] }).deafLine(T), "", "answered");
  assert.notEqual(board({ messages: [msg("t-1", "Owner", T - 31 * MIN), msg("t-1", "Checker", T - 5 * MIN)] }).deafLine(T), "", "another role's word isn't Manager's");
  assert.equal(board({ messages: [msg("t-1", "Owner", T - 31 * MIN, { resolved: true })] }).deafLine(T), "", "the owner closed it");
  assert.equal(board({ messages: [msg("t-1", "Owner", T - 25 * 60 * MIN)] }).deafLine(T), "", "over a day old");
});

test("an answered ask counts too; the line goes once Manager has raised the re-arm ask", () => {
  const ask = { id: "ask-a", kind: "decision", response: { status: "chose", at: T - 40 * MIN } };
  assert.match(board({ waiting: [ask] }).deafLine(T), /for 40 min/);
  assert.equal(board({ waiting: [{ ...ask, done: true }] }).deafLine(T), "");
  assert.equal(board({ waiting: [ask], messages: [msg("ask-a", "Manager", T - MIN)] }).deafLine(T), "");
  assert.equal(board({ waiting: [ask, { id: "rearm-pings", kind: "action" }] }).deafLine(T), "", "Manager's own ask holds the command now");
});

// Checker's FINDINGS on 26bca32: each of these waits on nobody, and raised the line.
test("as the rest of the page: a settled ask, an answer ordered after the owner's word, a done item's thread", () => {
  const ack = { id: "a1", kind: "answer", response: { status: "ack", at: T - 40 * MIN } };
  assert.equal(board({ waiting: [ack] }).deafLine(T), "", "the owner's Ack settles an answer");
  assert.equal(board({ waiting: [{ id: "a2", kind: "action", response: { status: "done", note: "thanks", at: T - 40 * MIN } }] }).deafLine(T), "", "a Done with a thanks");
  assert.notEqual(board({ waiting: [{ id: "a3", kind: "decision", response: { status: "done", at: T - 40 * MIN } }] }).deafLine(T), "", "a decision's Done waits");
  const early = [msg("t-1", "Owner", T - 40 * MIN, { id: "o1" }), msg("t-1", "Manager", T - 40 * MIN - 2000, { id: "l1", after: "o1" })];
  assert.equal(board({ messages: early }).deafLine(T), "", "the lead's answer names the owner's word");
  assert.equal(board({ messages: [msg("ship", "Owner", T - 40 * MIN)], initRaw: [{ id: "ship", status: "done" }] }).deafLine(T), "", "its card is done");
  assert.equal(board({ messages: [msg("idea", "Owner", T - 40 * MIN)], ideas: [{ id: "idea", done: true }] }).deafLine(T), "", "its idea is done");
  assert.equal(board({ waiting: [ack], messages: [msg("a1", "Owner", T - 30 * MIN, { text: "thanks!" })] }).deafLine(T), "", "an Ack word on a settled ask");
  assert.notEqual(board({ waiting: [ack], messages: [msg("a1", "Owner", T - 30 * MIN, { text: "wait, why?" })] }).deafLine(T), "", "a real question after it");
});

test("the stuck line's place shows it, alone or under the stuck lines", () => {
  const b = board({ messages: [msg("t-1", "Owner", Date.now() - 45 * MIN)] });
  b.renderStuck();
  assert.equal(b.els.stuck.hidden, false);
  assert.match(b.els.stuck.innerHTML, /class="deaf"/);
  const quiet = board();
  quiet.renderStuck();
  assert.equal(quiet.els.stuck.hidden, true);
});
