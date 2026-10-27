// The lead can't end a turn while the owner's word waits (#C297, part C): every lead turn reads the board's messages, and
// a thread whose newest message is the owner's, 5 minutes on, with no later lead message (this turn's writes count),
// refuses the stop. And a "Board thread [id]" ping counts only as the page writes it, never quoted in another text.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fullConfig } from "../scripts/config.mjs";
import { stopCheck } from "../gate/stop.mjs";
import { openOwnerWords } from "../gate/owner-waits.mjs";

const URL_ = "https://claude.ai/" + "artifact/TestBoard01";
const config = fullConfig({ artifactUrl: URL_ });
const NOW = 1_800_000_000_000, MIN = 60e3, DAY = 864e5;
const msg = (thread, from, at, extra = {}) => ({ id: `m${at}`, thread, from, text: "x", at, ...extra });
const QUERY = { action: "query", collection: "messages", query: { where: [["at", ">", NOW - DAY]] } };
const read = (docs, input = QUERY, id = "r1", body = null) => [
  { type: "assistant", message: { content: [{ type: "tool_use", id, name: "ArtifactData", input: { url: URL_, ...input } }] } },
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: body ?? `${docs.length} documents from collection "messages":\n=== BEGIN ARTIFACT DB x ===\n${docs.map((d) => JSON.stringify({ id: d.id, data: d, version: 1 })).join("\n")}\n=== END ARTIFACT DB x ===` }] } },
];
const write = (data, doc_id = "m-new") => ({ type: "assistant", message: { content: [{ type: "tool_use", id: "w1", name: "ArtifactData", input: { url: URL_, action: "set", collection: "messages", doc_id, data } }] } });
const turn = (parts, text = "status?", title = "Manager") => [
  { type: "custom-title", customTitle: title },
  { type: "user", message: { content: [{ type: "text", text }] } },
  ...parts,
  { type: "assistant", message: { content: [{ type: "text", text: "Done." }] } },
];
const check = (lines) => stopCheck(lines, { config, now: NOW });

test("openOwnerWords: the owner's word last, 5 minutes on; a lead message after it (by time or after:) or the owner's close ends it", () => {
  const o = { owner: "Owner", now: NOW };
  assert.deepEqual(openOwnerWords([msg("t-1", "Owner", NOW - 6 * MIN)], o).map((w) => w.thread), ["t-1"]);
  assert.deepEqual(openOwnerWords([msg("t-1", "Owner", NOW - 4 * MIN)], o), [], "4 minutes");
  assert.deepEqual(openOwnerWords([msg("t-1", "Owner", NOW - 9 * MIN), msg("t-1", "Manager", NOW - 8 * MIN)], o), []);
  assert.deepEqual(openOwnerWords([msg("t-1", "Owner", NOW - 9 * MIN), msg("t-1", "Manager", NOW - 10 * MIN, { after: `m${NOW - 9 * MIN}` })], o), [], "an answer naming the message comes after it, whatever its clock");
  assert.deepEqual(openOwnerWords([msg("t-1", "Owner", NOW - 9 * MIN, { resolved: true })], o), [], "the owner closed it");
  assert.deepEqual(openOwnerWords([msg("a", "Owner", NOW - 60 * MIN), msg("a", "Manager", NOW - 50 * MIN), msg("a", "Owner", NOW - 7 * MIN)], o).map((w) => w.thread), ["a"], "a follow-up after an answer");
});

test("every lead turn reads the board's messages, a day back and not one thread only, before it ends", () => {
  assert.match(check(turn([])).join(), /read the board's messages this turn/);
  assert.match(check(turn(read([], { action: "query", collection: "messages", query: { where: [["thread", "==", "t-1"]] } }))).join(), /read the board's messages this turn/, "one thread only");
  assert.match(check(turn(read([], { action: "query", collection: "messages", query: { where: [["at", ">", NOW - 2 * 3600e3]] } }))).join(), /read the board's messages this turn/, "two hours only");
  assert.deepEqual(check(turn(read([]))), []);
  assert.deepEqual(check(turn(read([], { action: "list", collection: "messages" }))), [], "a list reads them all");
  assert.deepEqual(check(turn([], "status?", "Builder")), [], "the lead only");
});

test("an owner message 5+ minutes old with no lead answer refuses the stop until this turn answers in its thread", () => {
  const waiting = read([msg("t-1793000000000", "Owner", NOW - 6 * MIN), msg("ask-1", "Owner", NOW - 9 * MIN), msg("ask-1", "Manager", NOW - 8 * MIN)]);
  const errs = check(turn(waiting));
  assert.equal(errs.length, 1);
  assert.match(errs[0], /the owner's message in thread t-1793000000000 has waited 6 min/);
  assert.deepEqual(check(turn([...waiting, write({ thread: "t-1793000000000", from: "Manager", text: "Here.", at: NOW })])), [], "answered this turn");
  assert.match(check(turn([...waiting, write({ thread: "ask-1", from: "Manager", text: "x", at: NOW })])).join(), /t-1793000000000/, "an answer elsewhere doesn't count");
  assert.deepEqual(check(turn(read([msg("t-2", "Owner", NOW - 4 * MIN)]))), [], "under 5 minutes");
});

test("a read saved to files (out_dir) counts the same", () => {
  const dir = mkdtempSync(join(tmpdir(), "fb-msgs-"));
  try {
    mkdirSync(join(dir, "messages"));
    const m = msg("t-5", "Owner", NOW - 20 * MIN);
    writeFileSync(join(dir, "messages", `${m.id}.json`), JSON.stringify({ id: m.id, data: m }));
    const body = `1 document from collection "messages" saved:\n"${join(dir, "messages", `${m.id}.json`)}"`;
    assert.match(check(turn(read([], { ...QUERY, out_dir: dir }, "r1", body))).join(), /thread t-5 has waited 20 min/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a ping counts only as the page writes it: a line that starts 'Board thread [id]: <owner>:', never quoted in another session's message or mid-line (Manager's false positive)", () => {
  const plan = 'Another Claude session sent a message:\n<cross-session-message from="x" name="Boardsmith">\nToday the page pings you per owner message ("Board thread [id]: …"), but the ping can fail.\nBoard thread [w9]: Owner: even at a line\'s start\n</cross-session-message>';
  assert.deepEqual(check(turn(read([]), plan)), [], "another session's text is never the owner's");
  assert.deepEqual(check(turn(read([]), 'The format is "Board thread [id]: …" as you know.')), [], "mid-line");
  assert.match(check(turn(read([]), "Board thread [w1]: Owner: Which button?")).join(), /the owner wrote in thread w1/);
  assert.match(check(turn(read([]), "Board thread [w2] #T12: Owner: (new question) and this?")).join(), /thread w2/, "with its number and kind");
  assert.match(check(turn(read([]), "[Artifact comment sent to Claude]\n> Board thread [w3]: Owner: quoted by the comment")).join(), /thread w3/);
});
