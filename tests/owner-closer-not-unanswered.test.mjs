// #C1039 (the owner, 11-12 ~2:50 pm MT: #T1880, #T1887, #T1892, #T1893 showed red "unanswered" and "Manager answering" though Manager had
// answered each; the owner's newest word in every one was a closer). After the team spoke, his word that asks nothing leaves the thread
// answered; a real follow-up still turns red. The rule is an ALLOW list (Checker's F1 on 2f61681c: a list of words to refuse passed 19 of 21
// follow-ups): the whole message is closer words and fillers, or exactly one of the options Manager offered, or a promise to report back.
import test from "node:test";
import assert from "node:assert/strict";
import { loadNames } from "./harness.mjs";

const m = (thread, from, text, at, extra = {}) => ({ id: `m${thread}${at}`, thread, from, text, at, ...extra });
const board = (threads) => {
  const b = loadNames(["threadOpen", "threadOf", "ackOnly", "itemOf", "ownerCloser", "pickOptions", "threadState"]);
  Object.assign(b.state, { waiting: [], initRaw: [], initiatives: [], todo: [], ideas: [], threads: [], messages: threads.flat() });
  return b;
};
const OPTIONS = [{ key: "A", label: "Ship it Monday" }, { key: "B", label: "Keep it hourly until #C1005" }, { key: "C", label: "Red" }];
// A thread: the owner asks, Manager answers (with options when asked), the owner's newest word is `last`.
const thread = (id, last, extra = {}, { options = null, opening = "Did the badge clear?" } = {}) =>
  [m(id, "Owner", opening, 1), m(id, "Manager", "Yes, it is live.", 2, options ? { options, kind: "decision" } : {}), m(id, "Owner", last, 3, extra)];
const answered = (words, opts) => { const b = board(words.map((w, i) => thread(`t-${i}`, w, {}, opts))); return words.map((w, i) => [w, !b.threadOpen(`t-${i}`)]); };

test("the owner's real closers of 11-12 stay answered; \"will do... but the badge doesn't agree\" turns it red", () => {
  const closers = ["ok", "Ack.", "Closed.", "archived it", "I'll try the reset when I am closer to 100% usage. I'll let you know", "Chose B: Keep it hourly until #C1005", "Done"];
  const follow = "will do... but the badge doesn't agree";
  const b = board([...closers.map((c, i) => thread(`t-real${i}`, c, {}, { options: OPTIONS })), thread("t-follow", follow, {}, { options: OPTIONS })]);
  closers.forEach((c, i) => assert.equal(b.threadOpen(`t-real${i}`), false, c));
  assert.equal(b.threadOpen("t-follow"), true, follow);
  assert.equal(b.threadState("t-follow"), "question");
});

test("more closers stay answered, two of them joined too (Checker's F2)", () => {
  const closers = ["ok.", "OK!", "thanks", "Thank you", "got it", "I will let you know", "I'll check", "archived", "I archived it already", "deleted it", "I'll look later",
    "ok thanks", "great, thanks", "got it, thanks", "sounds good", "thanks a lot", "noted, thanks", "done, closed it", "will do", "seen it already"];
  for (const [w, ok] of answered(closers)) assert.equal(ok, true, w);
});

test("a follow-up that is not on the allow list turns red, whatever it begins with (Checker's F1 probe)", () => {
  const real = ["thanks, revert it", "thanks, now do C1040", "removed it, restore it", "closed it, reopen #T1900", "thanks. Next: ship v2", "seen it. Wrong.", "I'll check, it's broken",
    "ok, but can you also fix the badge", "Please add a Close button", "thanks, but the badge is still red", "archived it, please add X", "thanks, fix it", "I'll check, also add X",
    "ok\nAnd one more thing: add the date", "x".repeat(200), "ok, hide the other three too", "done, now archive the rest", "thanks, make it blue", "got it, send me the link",
    "I'll let you know what I think but change the colour please", "I'll try the reset. Revert the badge. I'll let you know", "I tried it but it is still red, I'll let you know",
    "please fix the badge, I'll let you know", "I don't think that is right, I'll let you know", "I'll let you know what I think of it", "Is it live?"];
  for (const [w, ok] of answered(real, { options: OPTIONS })) assert.equal(ok, false, w.replace(/\n/g, "\\n").slice(0, 50));
  const withFile = board([thread("t-f", "ok", { assets: [{ name: "shot.png" }] })]);
  assert.equal(withFile.threadOpen("t-f"), true, "a file with it is not a closer");
});

test("a decision pick is a closer only as exactly one of the options Manager offered, with nothing after it (Checker's F1 on picks)", () => {
  const picks = [["Chose B: Keep it hourly until #C1005", true], ["Chose A: Ship it Monday", true], ["chose B: Keep it hourly until #C1005", false],
    ["Chose B: Red\nAlso add the date please", false], ["Chose C: Red, but first fix the badge and tell me when done", false], ["Chose C: Red also add the date", false],
    ["Chose D: Blue", false], ["Chose B: Red", false], ["I chose B", false], ["Chose C: Red", true]];
  const b = board(picks.map(([p], i) => thread(`t-${i}`, p, {}, { options: OPTIONS })));
  picks.forEach(([p, want], i) => assert.equal(!b.threadOpen(`t-${i}`), want, p.replace(/\n/g, "\\n")));
  const none = board([thread("t-n", "Chose B: Keep it hourly until #C1005")]);
  assert.equal(none.threadOpen("t-n"), true, "Manager offered no options: a pick of the owner's own typing is his word");
});

test("a closer needs the team to have spoken: the owner's own lone 'ok' still waits; a resolved or empty thread is unchanged", () => {
  const b = board([[m("t-a", "Owner", "I'll let you know", 1)], [m("t-b", "Owner", "archived it", 1), m("t-b", "Owner", "ok", 2)], []]);
  assert.equal(b.threadOpen("t-a"), true, "nobody has answered");
  assert.equal(b.threadOpen("t-b"), true, "only the owner's own words");
  assert.equal(b.threadOpen("t-none"), false);
  const c = board([[m("t-x", "Owner", "Q?", 1), m("t-x", "Manager", "A", 2), m("t-x", "Owner", "ok", 3, { resolved: true })]]);
  assert.equal(c.threadOpen("t-x"), false);
});
