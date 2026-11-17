// #C1166 (1): every reader of a commit's Board-Id trailer takes git's reading (the last paragraph, key without case, a card-id value).
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boardIdsOf, boardIdOf } from "../collector/board-id.mjs";
import { boardIdOf as deriveReads } from "../collector/derive.mjs";
import { boardIdOf as stateReads } from "../collector/state.mjs";

const CASES = [
  ["s\n\nBoard-Id: card-a\nCo-Authored-By: x\n", ["card-a"]],
  ["s\n\nBoard-Id: card-a\n\nCo-Authored-By: x\n", []],            // the id is in a middle paragraph: git reads no trailer there
  ["s\n\nbody\n\nBoard-Id: card-a\n", ["card-a"]],
  ["s\n\nboard-id: card-a\n", ["card-a"]],                         // git matches the key without case
  ["Board-Id: card-a\n", []],                                      // a lone first paragraph is the subject
  ["s\n\nBoard-Id: card-a\nBoard-Id: card-b\n", ["card-a", "card-b"]],
  ["s\n\nBoard-Id: Card-A\n", []],                                 // not a card id
  ["s\n\nBoard-Id: card-a\n more\n", []],                          // a folded line is another value
  ["s\r\n\r\nBoard-Id: card-a\r\n", ["card-a"]],
  ["", []], [null, []],
];

test("boardIdsOf reads the last paragraph's Board-Id lines, as git does", () => {
  for (const [message, want] of CASES) assert.deepEqual(boardIdsOf(message), want, JSON.stringify(message));
  assert.equal(boardIdOf("s\n\nBoard-Id: card-a\nBoard-Id: card-b\n"), "card-b", "the last one, as stack-ready and the release job read it");
  assert.equal(boardIdOf("s"), null);
});

test("the probe's readers are the one reading: derive, state and git itself agree on every case", () => {
  const dir = mkdtempSync(join(tmpdir(), "bid-"));
  for (const [message, want] of CASES) {
    if (typeof message !== "string" || !message.trim() || message.includes("\r")) continue;
    assert.equal(deriveReads(message), want.at(-1) ?? null);
    assert.equal(stateReads(message), want.at(-1) ?? null);
    const file = join(dir, "m.txt");
    writeFileSync(file, message);
    const git = execFileSync("git", ["interpret-trailers", "--parse", "--only-trailers", file], { encoding: "utf8" }).split("\n").filter((l) => /^board-id:/i.test(l)).map((l) => l.replace(/^[^:]*:\s*/, "").trim()).filter((v) => /^[a-z0-9][a-z0-9-]{0,63}$/.test(v));
    assert.deepEqual(boardIdsOf(message), git, `git agrees on ${JSON.stringify(message)}`);
  }
});
