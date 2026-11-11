// #C919: a thread where nothing is addressed to the owner sits under "Team notes", beside Needs you and Later, with its
// card's one-line title; a Manager answer or an ask for him moves it back to his view.
import test from "node:test";
import assert from "node:assert/strict";
import { loadNames } from "./harness.mjs";

const T = 1_800_000_000_000;
const NAMES = ["tabCounts", "tabsHtml", "teamHtml", "threadSets", "waitsOn", "youCount", "OWNER", "set:(s)=>{Object.assign(state,s)}"];
const msg = (thread, from, text, at, extra = {}) => ({ id: `m${at}${from}`, thread, from, text, at, ...extra });
const board = (st) => { const b = loadNames(NAMES); b.set(st); return b; };
const card = { id: "card-x", thread: "t-9", num: 901, name: "Fix the footer link", status: "active", phase: "build" };

test("an agent-only thread is listed under Team notes with its card's title, and under neither Needs you nor With the team", () => {
  const b = board({ initRaw: [card], initiatives: [card], messages: [msg("t-9", "Builder", "pushed the footer fix", T - 2e5), msg("t-9", "Checker", "looked fine", T - 1e5)] });
  const s = b.threadSets(T);
  assert.deepEqual([...s.team], ["t-9"]);
  assert.deepEqual([...s.open], []);
  assert.deepEqual([...s.answered], []);
  assert.equal(b.youCount(T, ""), 0);
  const c = JSON.parse(JSON.stringify(b.tabCounts(T)));
  assert.equal(c.team, 1);
  assert.equal(c.you, 0);
  assert.match(b.teamHtml(T), /Fix the footer link/);
  assert.match(b.tabsHtml(T), /Team notes <span class="tcount">1<\/span>/);
  assert.match(b.tabsHtml(T), /data-tab="later"[^>]*>Later[\s\S]*data-tab="team"[^>]*>Team notes/, "beside Later");
});

test("a Manager answer in it moves it out of Team notes and back to the owner's view", () => {
  const b = board({ initRaw: [card], initiatives: [card], messages: [msg("t-9", "Builder", "pushed", T - 2e5)] });
  assert.equal(b.threadSets(T).team.length, 1);
  b.state.messages.push(msg("t-9", "Manager", "Shipped it.", T - 1e3, { kind: "answer" }));
  const s = b.threadSets(T);
  assert.equal(s.team.length, 0);
  assert.equal(s.open.length + s.answered.length, 1, "now in the owner's lists");
  assert.match(b.teamHtml(T), /No team notes/);
});

test("an ask for the owner on the thread, or any word of his, keeps it out of Team notes", () => {
  const ask = { id: "t-ask1", kind: "decision", text: "Pick one", options: [{ key: "A", label: "a" }, { key: "B", label: "b" }], since: T - 5e5 };
  let b = board({ waiting: [ask], messages: [msg("t-ask1", "Builder", "note", T - 4e5)] });
  assert.equal(b.threadSets(T).team.length, 0, "an open ask for him");
  b = board({ messages: [msg("t-own", "Owner", "hi", T - 4e5), msg("t-own", "Builder", "note", T - 3e5)] });
  assert.equal(b.threadSets(T).team.length, 0, "his own thread");
});
