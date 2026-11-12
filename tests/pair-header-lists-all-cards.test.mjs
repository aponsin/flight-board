// #C1014: make-pair's makeAll cut the card list of a pair's headers at 120 characters, so pc46's headers read "#C880 and," and dropped #C967. The list is
// whole now; one longer than the template's limit is refused, naming why, with nothing written.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { makeAll } from "../scripts/make-pair.mjs";
import { CARD_MAX } from "../scripts/pair/make-pair.mjs";

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "fb-pair-hdr-"));
  const bare = join(dir, "origin.git"), work = join(dir, "work"), out = join(dir, "out");
  mkdirSync(out);
  const g = (...a) => execFileSync("git", ["-c", "user.email=none", "-c", "user.name=T", "-c", "commit.gpgsign=false", ...a], { cwd: work, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  g("remote", "add", "origin", bare);
  const commit = (subject) => { writeFileSync(join(work, "f"), subject); g("add", "-A"); g("commit", "-qm", subject); return g("rev-parse", "HEAD"); };
  return { g, work, out, commit };
}
// pair 1 on a base commit, then `ids` landed commits and pair 2 on the last one
function pairWith(ids) {
  const { g, work, out, commit } = repo();
  const base = commit("base (#C1)");
  g("push", "-q", "origin", "main");
  assert.equal(makeAll({ repo: work, sha: base, n: 1, out }).ok, true);
  let tip = base;
  for (const id of ids) tip = commit(`landed (#C${id})`);
  g("push", "-q", "origin", "main");
  return { r: makeAll({ repo: work, sha: tip, n: 2, out }), out };
}
const header = (out, f) => readFileSync(join(out, f), "utf8").split("\n").slice(0, 4).join("\n");

test("a short list reads as it did: ids joined with and", () => {
  const { r, out } = pairWith([880, 967]);
  assert.equal(r.ok, true, r.why);
  assert.match(header(out, "board-store-deploy-pc2.mjs"), /#C880 and #C967/);
});

test("a long list is whole in the deploy and tree headers: every card named, none cut, no dangling 'and'", () => {
  const ids = Array.from({ length: 60 }, (_, i) => 900 + i); // 60 cards: past the old 120-character cut and past a sentence's 300 characters
  const { r, out } = pairWith(ids);
  assert.equal(r.ok, true, r.why);
  const list = ids.map((i) => `#C${i}`).join(" and ");
  assert.ok(list.length > 300 && list.length <= CARD_MAX, "the list is longer than a sentence's limit and within the card list's");
  for (const f of ["board-store-deploy-pc2.mjs", "board-store-tree-pc2.mjs"]) {
    const text = readFileSync(join(out, f), "utf8");
    assert.ok(text.includes(list), `${f} holds the whole list`);
    assert.doesNotMatch(text, /#C\d+ and[,.)]/, "no list ends on a dangling 'and'");
    if (f.includes("deploy")) assert.ok(text.includes(`(${list}, 60 commits since`), "the list is followed by the commit count, whole");
  }
});

test("a list longer than the template's limit is refused, saying why, and nothing of that pair is written", () => {
  const ids = Array.from({ length: 200 }, (_, i) => 1000 + i);
  assert.ok(ids.map((i) => `#C${i}`).join(" and ").length > CARD_MAX);
  const { r, out } = pairWith(ids);
  assert.equal(r.ok, false);
  assert.match(r.why, /cannot name every card/);
  assert.ok(!readdirSync(out).some((f) => /pc2/.test(f)), "no pc2 file was written");
});
