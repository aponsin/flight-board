// #C842: the spend script counts a call once (a message is written as one line per content block), counts subagent transcripts
// under their parent session, and lists cache_read apart. A fixed set of transcripts pins the total.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const line = (id, rid, out, extra = {}) => JSON.stringify({ timestamp: "2026-11-10T12:00:00.000Z", requestId: rid, message: { id, model: "claude-opus-5-5", usage: { input_tokens: 10, cache_creation_input_tokens: 100, output_tokens: out, cache_read_input_tokens: 1000, ...extra } } });

test("one message in three lines counts once (with the most output); a subagent file adds its calls; cache_read stays apart", () => {
  const home = mkdtempSync(join(tmpdir(), "spend-"));
  const proj = join(home, ".claude", "projects", "-work-thing");
  mkdirSync(join(proj, "sess1", "subagents"), { recursive: true });
  // m1 is written as three lines (output grows 1, 4, 20): 10 + 100 + 5*20 = 210. m2: 10 + 100 + 5*2 = 120.
  writeFileSync(join(proj, "sess1.jsonl"), [line("m1", "r1", 1), line("m1", "r1", 4), line("m1", "r1", 20), line("m2", "r2", 2)].join("\n") + "\n");
  writeFileSync(join(proj, "sess1", "subagents", "agent-a.jsonl"), line("s1", "r9", 3) + "\n"); // 10 + 100 + 15 = 125
  const r = spawnSync("python3", ["-I", join(import.meta.dirname, "..", "scripts", "spend-by-source.py"), "--json", "--since", "2026-11-09T02:00"], { env: { ...process.env, HOME: home }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.total_weighted, 210 + 120 + 125);
  assert.equal(out.rows.length, 1, "the subagent belongs to its parent session");
  assert.equal(out.rows[0].calls, 3);
  assert.equal(out.rows[0].cache_read, 3000, "cache_read is listed, not weighed");
});
