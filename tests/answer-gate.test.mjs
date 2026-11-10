// #C582 held Manager's turn while a waiting item the owner answered was still open. #C825 (the board on the store) took the rule out of
// the red-ask Stop hook: the store answers and closes by its own tools and keeps no mirror to read. This file pins that it is gone.
// Made-up transcripts and a made-up mirror under a fresh HOME, as tests/red-ask.test.mjs does.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, utimesSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HOOK = fileURLToPath(new URL("../hooks/red-ask-board.py", import.meta.url));
const R = 1793600000000;
// waiting: { id: doc }, threads: { id: { num, title } }, messages: { id: doc }; calls: ArtifactData inputs this turn made;
// ageMin: how old the mirror's files are (they are fresh unless a test says). The hook's stderr lands in `lastErr`.
let lastErr = "";
// live (#C676): what the Stop gate's live check kept for Manager in <board>/live.json: { checkedAgoS, asks: [..] }.
function verdict({ title = "Manager", waiting = {}, threads = {}, messages = {}, calls = [], ageMin = 0, live = null } = {}) {
  const home = mkdtempSync(join(tmpdir(), "fb-answergate-"));
  try {
    const mirror = join(home, ".flight-board", "BOARD", "mirror");
    const when = new Date(Date.now() - ageMin * 60000);
    for (const [coll, docs] of [["waiting", waiting], ["threads", threads], ["messages", messages]]) {
      mkdirSync(join(mirror, coll), { recursive: true });
      for (const [id, d] of Object.entries(docs)) { const f = join(mirror, coll, `${id}.json`); writeFileSync(f, JSON.stringify(d)); utimesSync(f, when, when); }
    }
    if (live) { mkdirSync(join(home, ".flight-board", "BOARD"), { recursive: true }); writeFileSync(join(home, ".flight-board", "BOARD", "live.json"), JSON.stringify({ Manager: { checkedAt: Date.now() - live.checkedAgoS * 1000, msgs: [], asks: (live.asks ?? []).map(({ seenAgoS, ...a }) => (seenAgoS === undefined ? a : { ...a, seenAt: Date.now() - seenAgoS * 1000 })) } })); }
    const lines = [
      { type: "custom-title", customTitle: title },
      { type: "user", message: { content: [{ type: "text", text: "status" }] } },
      { type: "assistant", message: { content: calls.map((input, n) => ({ type: "tool_use", id: `t${n}`, name: "ArtifactData", input })) } },
      { type: "assistant", message: { content: [{ type: "text", text: "Done." }] } },
    ];
    const path = join(home, "s.jsonl");
    writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const r = spawnSync("python3", [HOOK], { input: JSON.stringify({ transcript_path: path }), encoding: "utf8", env: { ...process.env, CLAUDE_CODE_AUTO_COMPACT_WINDOW: "", HOME: home } });
    assert.equal(r.status, 0, r.stderr);
    lastErr = r.stderr;
    return r.stdout.trim() ? JSON.parse(r.stdout).reason : "";
  } finally { rmSync(home, { recursive: true, force: true }); }
}
const answered = { text: "Which one?", kind: "decision", response: { choice: "A", status: "chose", at: R }, respondedAt: R };

test("an answered but open item in the mirror no longer holds Manager's turn, whoever the session is (#C825)", () => {
  for (const title of ["Manager", "Boardsmith", ""]) {
    assert.equal(verdict({ title, waiting: { "pick-one": answered }, threads: { "pick-one": { num: 1372, title: "Run the old release tool once?" } } }), "", title || "(untitled)");
  }
  assert.equal(lastErr, "", "and it says nothing on stderr about a mirror");
  const src = readFileSync(HOOK, "utf8");
  assert.doesNotMatch(src, /answered_open|MIRROR_STALE_MIN|live\.json|respondedAt/);
});
