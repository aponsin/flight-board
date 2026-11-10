// #C734: the deploy and tree pair scripts are FORWARD ONLY. The signed commit may be behind main (it must be ON main) and is checked out
// exactly; an older pair run after a newer one is refused with nothing changed. Real git on scratch repositories; fictional names.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, appendFileSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { prepareCheckout, forwardOnly } from "../scripts/pair/deploy.template.mjs";
import { treeStep } from "../scripts/pair/tree.template.mjs";
import { makePair } from "../scripts/pair/make-pair.mjs";

// origin (bare) with main = c1 <- c2 <- c3, and a branch "side" with a commit that is not on main.
function world() {
  const dir = mkdtempSync(join(tmpdir(), "fb-pair-"));
  const origin = join(dir, "origin.git"), work = join(dir, "work");
  const g = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  execFileSync("git", ["init", "-q", "--bare", origin]);
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  g(work, "config", "user.email", "t@example.com"); g(work, "config", "user.name", "T"); g(work, "remote", "add", "origin", origin);
  const commit = (n) => { appendFileSync(join(work, "f.txt"), `${n}\n`); g(work, "add", "-A"); g(work, "commit", "-qm", n); return g(work, "rev-parse", "HEAD"); };
  const c1 = commit("c1"), c2 = commit("c2"), c3 = commit("c3");
  g(work, "checkout", "-qb", "side", c1); const side = commit("side");
  g(work, "checkout", "-q", "main");
  g(work, "push", "-q", "origin", "main", "side");
  const tree = join(dir, "tree");
  return { dir, origin, tree, c1, c2, c3, side, from: join(dir, "x.from"), head: () => g(tree, "rev-parse", "HEAD"), git: (...a) => g(tree, ...a) };
}
const cloneAt = (w, sha) => { execFileSync("git", ["clone", "-q", w.origin, w.tree]); w.git("checkout", "-q", "--detach", sha); };

test("deploy: main ahead of the signed commit deploys exactly the signed commit; the signed tip deploys too", () => {
  const w = world();
  const r = prepareCheckout({ tree: w.tree, repo: w.origin, signed: w.c2 });
  assert.equal(r.ok, true, r.why); assert.equal(w.head(), w.c2, "exactly the signed commit, not main's tip");
  assert.equal(w.git("status", "--porcelain"), "");
  const r2 = prepareCheckout({ tree: w.tree, repo: w.origin, signed: w.c3 });
  assert.equal(r2.ok, true, r2.why); assert.equal(w.head(), w.c3);
});

test("deploy: a clone nothing was ever checked out in (a failed first run) has no floor, even though its HEAD sits at main's tip", () => {
  const w = world();
  execFileSync("git", ["clone", "-q", "--no-checkout", w.origin, w.tree]);
  assert.equal(w.head(), w.c3);
  const r = prepareCheckout({ tree: w.tree, repo: w.origin, signed: w.c2 });
  assert.equal(r.ok, true, r.why); assert.equal(w.head(), w.c2);
});

test("deploy: an older pair run after a newer one is refused, with nothing changed", () => {
  const w = world();
  assert.equal(prepareCheckout({ tree: w.tree, repo: w.origin, signed: w.c3 }).ok, true);
  const r = prepareCheckout({ tree: w.tree, repo: w.origin, signed: w.c2 });
  assert.equal(r.ok, false); assert.match(r.why, /older pair run after a newer one/);
  assert.equal(w.head(), w.c3, "the checkout did not move");
  assert.equal(w.git("status", "--porcelain"), "");
});

test("deploy: a commit that is not on main, an unknown commit, a short sha, and a checkout on another line are refused", () => {
  const w = world();
  const first = prepareCheckout({ tree: w.tree, repo: w.origin, signed: w.c1 });
  assert.equal(first.ok, true, first.why);
  const off = prepareCheckout({ tree: w.tree, repo: w.origin, signed: w.side });
  assert.equal(off.ok, false); assert.match(off.why, /not on main/); assert.equal(w.head(), w.c1);
  const unknown = prepareCheckout({ tree: w.tree, repo: w.origin, signed: "f".repeat(40) });
  assert.equal(unknown.ok, false); assert.match(unknown.why, /not in the repository/);
  assert.equal(prepareCheckout({ tree: w.tree, repo: w.origin, signed: w.c2.slice(0, 12) }).ok, false);
  w.git("checkout", "-q", "--detach", w.side);
  const other = prepareCheckout({ tree: w.tree, repo: w.origin, signed: w.c2 });
  assert.equal(other.ok, false); assert.match(other.why, /older pair/); assert.equal(w.head(), w.side);
});

test("deploy: a dirty checkout and an unreachable repository are refused", () => {
  const w = world();
  assert.equal(prepareCheckout({ tree: w.tree, repo: w.origin, signed: w.c2 }).ok, true);
  appendFileSync(join(w.tree, "f.txt"), "local\n");
  const dirty = prepareCheckout({ tree: w.tree, repo: w.origin, signed: w.c3 });
  assert.equal(dirty.ok, false); assert.match(dirty.why, /local changes/);
  const gone = prepareCheckout({ tree: join(w.dir, "never"), repo: join(w.dir, "no-such.git"), signed: w.c2 });
  assert.equal(gone.ok, false); assert.match(gone.why, /clone exited/);
});

test("tree: main ahead of the signed commit moves the tree to exactly the signed commit, and back returns it", () => {
  const w = world(); cloneAt(w, w.c1);
  const up = treeStep({ mode: "update", tree: w.tree, fromFile: w.from, signed: w.c2 });
  assert.equal(up.ok, true, up.why); assert.equal(w.head(), w.c2);
  assert.equal(readFileSync(w.from, "utf8").trim(), w.c1);
  const back = treeStep({ mode: "back", tree: w.tree, fromFile: w.from, signed: w.c2 });
  assert.equal(back.ok, true, back.why); assert.equal(w.head(), w.c1); assert.equal(existsSync(w.from), false);
});

test("tree: an older pair run after a newer one is refused with nothing changed; so is a tree already there", () => {
  const w = world(); cloneAt(w, w.c3);
  const old = treeStep({ mode: "update", tree: w.tree, fromFile: w.from, signed: w.c2 });
  assert.equal(old.ok, false); assert.match(old.why, /older pair run after a newer one/);
  assert.equal(w.head(), w.c3); assert.equal(existsSync(w.from), false, "no start was recorded");
  w.git("checkout", "-q", "--detach", w.c2);
  const same = treeStep({ mode: "update", tree: w.tree, fromFile: w.from, signed: w.c2 });
  assert.equal(same.ok, false); assert.match(same.why, /already at/); assert.equal(existsSync(w.from), false);
});

test("tree: a signed commit off main, a tree on another line, a dirty tree, and a bad back are refused", () => {
  const w = world(); cloneAt(w, w.c1);
  assert.equal(treeStep({ mode: "update", tree: w.tree, fromFile: w.from, signed: w.side }).ok, false, "side is not on main");
  w.git("checkout", "-q", "--detach", w.side);
  const other = treeStep({ mode: "update", tree: w.tree, fromFile: w.from, signed: w.c2 });
  assert.equal(other.ok, false); assert.equal(w.head(), w.side);
  w.git("checkout", "-q", "--detach", w.c1);
  appendFileSync(join(w.tree, "f.txt"), "local\n");
  assert.match(treeStep({ mode: "update", tree: w.tree, fromFile: w.from, signed: w.c2 }).why, /local changes/);
  w.git("checkout", "-q", "--", "f.txt");
  assert.equal(treeStep({ mode: "update", tree: w.tree, fromFile: w.from, signed: w.c2 }).ok, true);
  writeFileSync(w.from, `${w.c3}\n`); // a recorded start that is not behind the signed commit
  assert.match(treeStep({ mode: "back", tree: w.tree, fromFile: w.from, signed: w.c2 }).why, /does not hold a commit behind/);
  assert.equal(w.head(), w.c2);
  assert.equal(treeStep({ mode: "sideways", tree: w.tree, fromFile: w.from, signed: w.c2 }).ok, false);
  const none = join(w.dir, "none.from");
  assert.match(treeStep({ mode: "back", tree: w.tree, fromFile: none, signed: w.c2 }).why, /is missing/);
});

// Security on 3465988 (LOW 2): an older pair's back must not roll the tree behind a newer pair: pc10 update, pc11 update, pc10 back.
test("tree: an older pair's back after a newer pair's update is refused, and the tree does not move", () => {
  const w = world(); cloneAt(w, w.c1);
  const from10 = join(w.dir, "pc10.from"), from11 = join(w.dir, "pc11.from");
  assert.equal(treeStep({ mode: "update", tree: w.tree, fromFile: from10, signed: w.c2 }).ok, true);
  assert.equal(treeStep({ mode: "update", tree: w.tree, fromFile: from11, signed: w.c3 }).ok, true);
  const back10 = treeStep({ mode: "back", tree: w.tree, fromFile: from10, signed: w.c2 });
  assert.equal(back10.ok, false); assert.match(back10.why, /is not at/);
  assert.equal(w.head(), w.c3, "the tree stays on the newer pair's commit"); assert.equal(existsSync(from10), true, "its record is kept");
  assert.equal(treeStep({ mode: "back", tree: w.tree, fromFile: from11, signed: w.c3 }).ok, true);
  assert.equal(w.head(), w.c2);
});

// Security on 3465988 (LOW 3): a failed fetch leaves an old FETCH_HEAD; the guard must stop there, not judge the old one as main.
test("the guard stops on a failed fetch, even with an old FETCH_HEAD that would pass", () => {
  const w = world(); cloneAt(w, w.c1);
  w.git("fetch", "origin", "main"); // FETCH_HEAD is now main's tip
  const real = (...a) => spawnSync("git", ["-C", w.tree, ...a], { encoding: "utf8" });
  assert.equal(forwardOnly(real, w.c2).ok, true, "with a working fetch it passes");
  const broken = (...a) => (a[0] === "fetch" ? { status: 128, stdout: "", stderr: "unreachable" } : real(...a));
  const r = forwardOnly(broken, w.c2);
  assert.equal(r.ok, false); assert.match(r.why, /git fetch exited 128/);
});

test("the pair maker: both files carry the same guard, parse, and refuse values that could break out of a string", () => {
  const files = makePair({ name: "pc10", card: "#C734", what: "a test pair", signed: "a".repeat(40), deployOk: "Worker deployed.", treeOk: "tree moved" });
  const [deploy, tree] = [files["board-store-deploy-pc10.mjs"], files["board-store-tree-pc10.mjs"]];
  const guard = (t) => /\/\/ @@GUARD-START@@\n([\s\S]*?)\/\/ @@GUARD-END@@/.exec(t)?.[1];
  assert.ok(guard(deploy).includes("export function forwardOnly")); assert.equal(guard(deploy), guard(tree), "one rule in both files");
  assert.ok(deploy.includes(`"${"a".repeat(40)}"`) && tree.includes("board-store-tree-pc10.from"));
  const dir = mkdtempSync(join(tmpdir(), "fb-pairfiles-"));
  for (const [f, text] of Object.entries(files)) { writeFileSync(join(dir, f), text); const c = spawnSync("node", ["--check", join(dir, f)], { encoding: "utf8" }); assert.equal(c.status, 0, c.stderr); }
  const base = { name: "pc10", card: "#C734", what: "w", signed: "a".repeat(40), deployOk: "ok", treeOk: "ok" };
  // Security on 3465988: U+2028 and U+2029 end a // comment in JS, so live code could follow one in a file nobody can see it in.
  const hidden = ["#C1 globalThis.x = 1;", "#C1 globalThis.x = 1;", "a\u0000b", "a\u0007b", "a\u007fb", "café", "a\tb"];
  for (const v of hidden) for (const k of ["card", "what", "deployOk", "treeOk"]) assert.throws(() => makePair({ ...base, [k]: v }), undefined, `${k}: ${JSON.stringify(v)}`);
  for (const bad of [{ what: 'x"; process.exit(0); "' }, { card: "a\nb" }, { deployOk: "`$(x)`" }, { treeOk: "@@SIGNED@@" }, { signed: "abc" }, { name: "../x" }]) assert.throws(() => makePair({ ...base, ...bad }), undefined, JSON.stringify(bad));
  mkdirSync(join(dir, "ok"));
});

test("the pair maker refuses a backslash (one ending a value would escape the closing quote), a $ and a @@ in every text value (Security's LOW on 93877f5)", () => {
  const base = { name: "pc10", card: "#C734", what: "w", signed: "a".repeat(40), deployOk: "ok", treeOk: "ok" };
  for (const v of ["ends with a backslash\\", "a \\ in the middle", "\\", "costs $5", "$", "a@@b", "@@"]) for (const k of ["card", "what", "deployOk", "treeOk"]) assert.throws(() => makePair({ ...base, [k]: v }), undefined, `${k}: ${JSON.stringify(v)}`);
  assert.doesNotThrow(() => makePair(base), "the plain values still make a pair");
});
