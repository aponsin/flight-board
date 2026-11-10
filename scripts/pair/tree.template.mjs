// Run by the owner in Terminal (@@CARD@@), the DELTA tree step: `node @@FILE@@ update` or `... back`. Made from scripts/pair/tree.template.mjs by
// scripts/pair/make-pair.mjs. FORWARD ONLY (#C734).
// update: moves the probe's code tree (board-store-v4, which the three launchd jobs run from: evidence, usage, ask) to exactly @@SHORT@@. That
//         commit has to be ON main (an ancestor of the fetched main; main may be ahead of it). It is refused when the tree is not behind
//         it (an older pair run after a newer one), when the tree is already there, or when it has local changes. It writes down which
//         commit it started from in @@FROM@@ (outside the tree, so the tree stays clean), then moves it.
// back:   moves it back to the commit it started from (read from that file) and removes the file. It refuses if the file is missing, if
//         the tree is not at @@SHORT@@, or if the recorded commit is not behind it. Each job start is a fresh process, so the next run
//         uses whichever code is checked out.
// It changes nothing else: no launchd job, no installed copy, no remote system, no data.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const NEW = "@@SIGNED@@", REF = "main";
const SUCCESS = "@@SUCCESS@@";

// @@GUARD-START@@
// The forward-only rule, over a git runner git(...args) -> { status, stdout }: the signed commit is on the fetched main (an ancestor of its
// tip, or the tip itself) and the commit now checked out, if there is one, is an ancestor of it (or it). Moves nothing.
export function forwardOnly(git, signed, ref = "main") {
  if (!/^[0-9a-f]{40}$/.test(String(signed))) return { ok: false, why: "the signed commit is not a full sha" };
  const f = git("fetch", "origin", ref);
  if (f.status !== 0) return { ok: false, why: `git fetch exited ${f.status}` };
  const tip = String(git("rev-parse", "FETCH_HEAD").stdout ?? "").trim();
  if (!/^[0-9a-f]{40}$/.test(tip)) return { ok: false, why: "the fetched main has no commit" };
  if (git("cat-file", "-e", `${signed}^{commit}`).status !== 0) return { ok: false, why: `the signed commit (${signed.slice(0, 8)}) is not in the repository` };
  if (git("merge-base", "--is-ancestor", signed, tip).status !== 0) return { ok: false, why: `the signed commit (${signed.slice(0, 8)}) is not on main` };
  const cur = git("rev-parse", "--verify", "-q", "HEAD^{commit}");
  // A checkout never checked out (a fresh --no-checkout clone, or one a failed run left) has an empty index and no floor: its HEAD is only
  // where the clone found main, not a deploy.
  const files = git("ls-files");
  const current = cur.status === 0 && files.status === 0 && String(files.stdout).trim() !== "" ? String(cur.stdout).trim() : null;
  if (current && git("merge-base", "--is-ancestor", current, signed).status !== 0) return { ok: false, why: `the checkout is at ${current.slice(0, 8)}, which is not behind the signed commit (${signed.slice(0, 8)}): an older pair run after a newer one` };
  return { ok: true, tip, current };
}
// @@GUARD-END@@

// update or back on the tree at `tree`, remembering the start in `fromFile`. { ok, why, to }; nothing is changed unless ok.
export function treeStep({ mode, tree, fromFile, signed = NEW, ref = REF }) {
  const git = (...a) => spawnSync("git", ["-C", tree, ...a], { encoding: "utf8" });
  if (!["update", "back"].includes(mode)) return { ok: false, why: "say update or back" };
  const head = String(git("rev-parse", "HEAD").stdout).trim();
  if (git("status", "--porcelain").stdout.trim() !== "") return { ok: false, why: "the tree has local changes; nothing was changed" };
  let to;
  if (mode === "update") {
    if (head === signed) return { ok: false, why: `the tree is already at ${signed.slice(0, 8)}; nothing was changed` };
    const g = forwardOnly(git, signed, ref);
    if (!g.ok) return { ok: false, why: `${g.why}; nothing was changed` };
    if (g.current !== head) return { ok: false, why: "the tree has no commit checked out; nothing was changed" };
    to = signed;
  } else {
    if (head !== signed) return { ok: false, why: `the tree is not at ${signed.slice(0, 8)}; nothing was changed` };
    if (!existsSync(fromFile)) return { ok: false, why: `${fromFile.split("/").pop()} is missing, so the commit to go back to is not known; nothing was changed` };
    to = readFileSync(fromFile, "utf8").trim();
    if (!/^[0-9a-f]{40}$/.test(to) || git("cat-file", "-e", `${to}^{commit}`).status !== 0 || git("merge-base", "--is-ancestor", to, signed).status !== 0) return { ok: false, why: `${fromFile.split("/").pop()} does not hold a commit behind ${signed.slice(0, 8)}; nothing was changed` };
  }
  if (mode === "update") writeFileSync(fromFile, `${head}\n`);
  const c = git("checkout", "--detach", to);
  if (c.status !== 0) { if (mode === "update") unlinkSync(fromFile); return { ok: false, why: `git checkout exited ${c.status}` }; }
  if (String(git("rev-parse", "HEAD").stdout).trim() !== to) return { ok: false, why: "the tree did not move" };
  if (mode === "back") unlinkSync(fromFile);
  return { ok: true, to };
}

function main() {
  // The folder this file sits in (the owner's board folder, where the checkout and the start file are).
  const HERE = dirname(fileURLToPath(import.meta.url));
  const TREE = `${HERE}/board-store-v4`;
  const FROM_FILE = `${HERE}/@@FROM@@`;
  const mode = process.argv[2];
  const r = treeStep({ mode, tree: TREE, fromFile: FROM_FILE });
  if (!r.ok) { console.log(`TREE FAILED: ${r.why}. Paste this line to Manager.`); process.exit(1); }
  console.log(`TREE OK: board-store-v4 is at ${r.to.slice(0, 7)}${mode === "update" ? ` (${SUCCESS}). Undo: node @@FILE@@ back` : " (where it started)"}.`);
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
