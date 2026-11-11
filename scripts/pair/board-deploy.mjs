// One short command per pair (#C924), for the owner at a laptop over SSH: `node board-deploy.mjs pc34 <deploySha> <treeSha>`, run in the folder
// this file sits in (the owner's board folder). It is the same for every pair: scripts/make-pair.mjs copies it there byte for byte as
// board-deploy.mjs and puts its sha256 in the pair's steps file, whose first command checks it and PASTES both other hashes on the same line, so
// what runs is bound to what Security signed out of band, never to a steps file on a disk anything can write. It does exactly what the two
// hash-checked lines of the steps file do, in order:
//   1. it refuses (CHECK FAILED, nothing run) unless each given hash is 64 hex characters and is the sha256 of the file on disk
//      (board-store-deploy-pc34.mjs, board-store-tree-pc34.mjs), and unless the pair's steps file (board-store-pc34-steps.md, next to it) names the
//      same two hashes; a steps file that disagrees is refused, naming both. Without the two hashes it prints a usage line, exits 2, runs nothing;
//   2. it runs the deploy file, then the tree file with `update`, and stops at the first one that fails (the second never runs after a failed
//      first). Each prints its own DEPLOY OK or TREE OK line, which are the last lines printed.
// Line 3 (the hooks) stays by hand: this file only prints that it is still to be run, and the exact line to paste, taken from the steps file.
// It opens no browser and needs no display: wrangler gets the owner's Cloudflare token from board.private.json (the deploy file reads it);
// without that file the deploy file's own login applies. It reads, prints and writes no secret.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HASH = /^[0-9a-f]{64}$/;

// What a pair's steps file says about its files: { deploy, tree, hooksLine } (hashes), or { why }. Nothing here runs anything.
export function readSteps(text, name) {
  const files = { deploy: `board-store-deploy-${name}.mjs`, tree: `board-store-tree-${name}.mjs` };
  const full = /^Full sha256: (.+?)\.?$/m.exec(text)?.[1];
  if (!full) return { why: `the steps file has no "Full sha256:" line` };
  const listed = Object.fromEntries(full.split(", ").map((p) => p.trim().split(" ")).filter((p) => p.length === 2 && HASH.test(p[1])).map(([k, h]) => [k, h]));
  const out = {};
  for (const kind of ["deploy", "tree"]) {
    const f = files[kind];
    // The hash in the file's own hash-checked line: the one the owner would check by hand.
    const m = new RegExp(`shasum -a 256 ${f.replace(/\./g, "\\.")} \\| cut -c1-64\\)" = ([0-9a-f]{64}) \\]`).exec(text);
    if (!m || !listed[kind]) return { why: `the steps file does not carry a hash for ${f}` };
    if (m[1] !== listed[kind]) return { why: `the steps file names two different hashes for ${f}` };
    out[kind] = m[1];
  }
  const hooks = `board-store-hooks-${name}.mjs`;
  out.hooksLine = text.split("\n").find((l) => l.startsWith("if [ ") && l.includes(`shasum -a 256 ${hooks} `)) ?? null;
  return out;
}

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

// Runs the pair `name` in `dir`. { ok, code }. spawn, read and exists are injectable (the tests need no wrangler, no network, no Cloudflare);
// say gets each printed line. It never prints a hash-checked file's contents.
// deploySha and treeSha are the two hashes pasted on the command line (required): they, never the steps file on disk, say what is signed.
export function boardDeploy({ name, dir, deploySha, treeSha, spawn = spawnSync, read = readFileSync, exists = existsSync, say = console.log, node = process.execPath }) {
  const refuse = (why) => { say(`CHECK FAILED: ${why}. Nothing was run. Paste this line to Manager.`); return { ok: false, code: 1 }; };
  const usage = "usage: node board-deploy.mjs pc<n> <deploy sha256> <tree sha256>   (all three are on the pasted line, for example pc34)";
  if (!/^pc\d{1,6}$/.test(String(name)) || deploySha === undefined || treeSha === undefined) { say(usage); return { ok: false, code: 2 }; }
  const given = { deploy: String(deploySha), tree: String(treeSha) };
  if (!HASH.test(given.deploy) || !HASH.test(given.tree)) { say("CHECK FAILED: a hash on the command line is not 64 hex characters. Nothing was run."); say(usage); return { ok: false, code: 2 }; }
  const stepsFile = `board-store-${name}-steps.md`;
  if (!exists(join(dir, stepsFile))) return refuse(`${stepsFile} is not in this folder`);
  const steps = readSteps(String(read(join(dir, stepsFile), "utf8")), name);
  if (steps.why) return refuse(steps.why);
  const files = [["deploy", `board-store-deploy-${name}.mjs`, []], ["tree", `board-store-tree-${name}.mjs`, ["update"]]];
  // The steps file must agree with the pasted hashes; it is never the source of them.
  for (const [kind, f] of files) {
    if (steps[kind] !== given[kind]) return refuse(`the steps file names ${steps[kind]} for ${f} but the command line gives ${given[kind]}`);
  }
  // Every file is checked before anything runs, so a changed tree file is found before the deploy has moved anything.
  for (const [kind, f] of files) {
    let bytes;
    try { bytes = read(join(dir, f)); } catch { return refuse(`${f} cannot be read`); }
    if (sha256(bytes) !== given[kind]) return refuse(`${f} is not the signed file`);
  }
  say(`${name}: line 1 (deploy), then line 2 (tree); each file matches its signed hash.`);
  say(steps.hooksLine ? `Line 3 (hooks) is still to be run by hand, after this finishes. Paste this line:\n${steps.hooksLine}` : "This pair has no hooks step: nothing is left to run by hand.");
  for (const [, f, args] of files) {
    const r = spawn(node, [join(dir, f), ...args], { cwd: dir, stdio: "inherit" });
    // The file printed its own failure line (DEPLOY FAILED / TREE FAILED); the next one never runs.
    if (r.status !== 0) { say(`Stopped: ${f} did not finish (exit ${r.status ?? r.error?.message ?? "none"}). Nothing after it was run.`); return { ok: false, code: 1 }; }
  }
  return { ok: true, code: 0 };
}

// Run as a script (compared by real path: a folder reached through a link, as /tmp is on a Mac, must still run, never print nothing and exit 0).
const asScript = (() => { try { return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (asScript) {
  const r = boardDeploy({ name: process.argv[2], deploySha: process.argv[3], treeSha: process.argv[4], dir: dirname(realpathSync(fileURLToPath(import.meta.url))) });
  if (!r.ok) process.exit(r.code);
}
