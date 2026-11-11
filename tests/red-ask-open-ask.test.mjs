// #C957 (false positive 11-11 ~3:55 pm MT): Manager's reply repeated a red reminder for the open ask #T1830, and the red-ask Stop hook demanded a second
// ask, which would have duplicated it. A red line that names an ask the store holds open needs no new one; the probe's dispatch job writes the open
// asks' numbers to <stateDir>/<board>/open-asks.json, which the hook reads.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { openAsksFile, writeOpenAsks, OPEN_ASKS_FILE } from "../collector/store-dispatch.mjs";

const HOOK = fileURLToPath(new URL("../hooks/red-ask-board.py", import.meta.url));
const STORE = "mcp__ef1fd144-2d48-4acf-b314-24af223499c0__";
const RED = "\u{1F534}";
const BOARD = "TestBoard01";

// A home with the board config the Stop gate is registered with, and (when asked) the probe's open-asks.json in the config's state folder.
function setup({ file } = {}) {
  const home = mkdtempSync(join(tmpdir(), "fb-openask-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  const state = join(home, "state");
  const cfg = join(home, "board.config.json");
  writeFileSync(cfg, JSON.stringify({ owner: "Owner", artifactUrl: `https://claude.ai/artifact/${BOARD}`, gate: { stateDir: state } }));
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: `'/n/node' '${home}/.flight-board/install/${"a".repeat(40)}/gate/stop.mjs' --config '${cfg}'` }] }] } }));
  if (file !== undefined) {
    mkdirSync(join(state, BOARD), { recursive: true });
    writeFileSync(join(state, BOARD, OPEN_ASKS_FILE), typeof file === "string" ? file : JSON.stringify(file));
  }
  return home;
}
const turn = (reply, { calls = [], title = "Manager", text = "status" } = {}) => [
  { type: "custom-title", customTitle: title },
  { type: "user", message: { content: [{ type: "text", text }] } },
  ...(calls.length ? [{ type: "assistant", message: { content: calls.map((name, n) => ({ type: "tool_use", id: `t${n}`, name, input: {} })) } }] : []),
  { type: "assistant", message: { content: [{ type: "text", text: reply }] } },
];
function verdict(lines, home) {
  const dir = mkdtempSync(join(tmpdir(), "fb-openask-t-"));
  try {
    const path = join(dir, "s.jsonl");
    writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const r = spawnSync("python3", [HOOK], { input: JSON.stringify({ transcript_path: path }), encoding: "utf8", env: { ...process.env, CLAUDE_CODE_AUTO_COMPACT_WINDOW: "", HOME: home } });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim() ? JSON.parse(r.stdout).reason : "";
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
}
const fresh = (asks) => ({ at: Date.now(), asks });

test("a red line that names an open ask needs no new ask; naming several, all must be open", () => {
  assert.equal(verdict(turn(`${RED} Reminder: #T1830 still needs your answer.`), setup({ file: fresh([12, 1830]) })), "");
  assert.equal(verdict(turn(`Status.\n${RED} Reminder: #T1830 and #T12 still need you.\n- ${RED} also #T12`), setup({ file: fresh([12, 1830]) })), "", "every red line, each naming open asks");
  assert.match(verdict(turn(`${RED} Reminder: #T1830 and #T99 still need you.`), setup({ file: fresh([12, 1830]) })), /red ask/, "one of the two is not open");
  assert.match(verdict(turn(`${RED} #T1830 is open.\n${RED} Pick one: A or B?`), setup({ file: fresh([1830]) })), /red ask/, "a second red line that names nothing is a new ask");
});

test("must still refuse: a red line naming no ask, a closed or unknown #T, or an ask number in the text but not on the red line", () => {
  const file = fresh([12, 1830]);
  assert.match(verdict(turn(`${RED} Pick one: A or B?`), setup({ file })), /red ask/);
  assert.match(verdict(turn(`${RED} Reminder: #T1831 needs you.`), setup({ file })), /red ask/, "unknown to the store's open list");
  assert.match(verdict(turn(`${RED} Reminder: #T7 needs you.`), setup({ file: fresh([]) })), /red ask/, "closed: no open asks at all");
  assert.match(verdict(turn(`#T1830 is open, see it.\n${RED} Pick one: A or B?`), setup({ file })), /red ask/, "the number is on another line");
  assert.match(verdict(turn(`${RED} Reminder: T1830 and ticket 1830 need you.`), setup({ file })), /red ask/, "only #T<n> names an ask");
  assert.match(verdict(turn(`${RED} Reminder: #T18301 needs you.`), setup({ file })), /red ask/, "a longer number is another ask");
});

test("a file that is missing, unreadable, malformed or older than 10 minutes excuses nothing", () => {
  const line = `${RED} Reminder: #T1830 still needs your answer.`;
  assert.match(verdict(turn(line), setup()), /red ask/, "no file");
  assert.match(verdict(turn(line), setup({ file: "not json" })), /red ask/);
  assert.match(verdict(turn(line), setup({ file: { at: Date.now(), asks: "1830" } })), /red ask/);
  assert.match(verdict(turn(line), setup({ file: { at: Date.now() - 11 * 60000, asks: [1830] } })), /red ask/, "11 minutes old");
  assert.match(verdict(turn(line), setup({ file: { at: Date.now() + 5 * 60000, asks: [1830] } })), /red ask/, "stamped in the future");
  assert.match(verdict(turn(line), setup({ file: { asks: [1830] } })), /red ask/, "no time");
  assert.equal(verdict(turn(line), setup({ file: { at: Date.now() - 9 * 60000, asks: [1830] } })), "", "9 minutes old still counts");
  assert.match(verdict(turn(line), mkdtempSync(join(tmpdir(), "fb-openask-nocfg-"))), /red ask/, "no board config at all");
});

test("must still allow: a new ask written this turn covers any red line, named or not", () => {
  assert.equal(verdict(turn(`${RED} Pick one: A or B?`, { calls: [STORE + "ask"] }), setup()), "");
  assert.equal(verdict(turn(`${RED} #T1831 is new.`, { calls: [STORE + "ask"] }), setup({ file: fresh([]) })), "");
});

test("an open red ask still defers the reset cue one turn, named or not", () => {
  const big = (lines) => { lines.filter((l) => l.type === "assistant").forEach((l) => { l.message.usage = { input_tokens: 1000, cache_read_input_tokens: 449000, cache_creation_input_tokens: 0 }; }); return lines; };
  const named = verdict(big(turn(`${RED} Reminder: #T1830 still needs your answer.`, { title: "Manager" })), setup({ file: fresh([1830]) }));
  assert.doesNotMatch(named, /red ask/);
  assert.match(named, /deferred one turn.*an ask of the owner's is open/);
});

test("the probe's file: the open asks' numbers only (not closed, not withdrawn), sorted and capped, written atomically beside the dispatch files", () => {
  const view = { asks: [{ num: 5, closed_at: null }, { num: 3 }, { num: 4, closed_at: 9 }, { num: 6, withdrawn_at: 9 }, { num: 0 }, { num: "7" }, null, { id: "x" }] };
  assert.deepEqual(openAsksFile(view, 123), { at: 123, asks: [3, 5] });
  assert.deepEqual(openAsksFile({}, 1), { at: 1, asks: [] });
  assert.equal(openAsksFile({ asks: Array.from({ length: 1500 }, (_, i) => ({ num: i + 1 })) }, 1).asks.length, 1000);
  const dir = mkdtempSync(join(tmpdir(), "fb-openask-w-"));
  try {
    writeOpenAsks(view, { dir: join(dir, "b"), now: 55 });
    assert.deepEqual(JSON.parse(spawnSync("cat", [join(dir, "b", OPEN_ASKS_FILE)], { encoding: "utf8" }).stdout), { at: 55, asks: [3, 5] });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
