// #C1167 (Checker 2, 11-17): `node ~/.flight-board/current/scripts/group-check.mjs read ...` did nothing and exited 0. The script's own "am I the main file" check compared the path as typed (the
// `current` link) with import.meta.url, the real file, so main() never ran and nothing said so. One helper reads both sides by real path (scripts/is-main.mjs); every script that
// had the bug uses it, and a lint fails any script that compares process.argv[1] with no real path.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { isMain } from "../scripts/is-main.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const tmp = () => mkdtempSync(join(tmpdir(), "c1167-"));

test("isMain: the file node was started with, by its real path; a link to it is it; another file, a missing path or none is not", () => {
  const dir = tmp();
  const file = join(dir, "a.mjs"), other = join(dir, "b.mjs"), link = join(dir, "link.mjs");
  writeFileSync(file, ""); writeFileSync(other, ""); symlinkSync(file, link);
  const url = pathToFileURL(file).href;
  assert.equal(isMain(url, file), true, "the path itself");
  assert.equal(isMain(url, link), true, "a symlink to it (the bug: false)");
  assert.equal(isMain(url, join(dir, "nosuchfolder", "a.mjs")), false, "a path that does not resolve is not the file");
  assert.equal(isMain(url, other), false);
  assert.equal(isMain(url, join(dir, "missing.mjs")), false);
  assert.equal(isMain(url, ""), false);
  assert.equal(isMain(url, undefined), false);
  const folder = join(dir, "real"); mkdirSync(folder); writeFileSync(join(folder, "c.mjs"), "");
  symlinkSync(folder, join(dir, "folderlink"));
  assert.equal(isMain(pathToFileURL(join(folder, "c.mjs")).href, join(dir, "folderlink", "c.mjs")), true, "a link to the folder holding it");
});

// The scripts that compared argv[1] with no real path. Each is run as it is and through a symlink, with no arguments, in an empty folder with an empty HOME: the two runs must say and do the same.
const FIXED = ["scripts/post-commit-push.mjs", "scripts/changelog.mjs", "scripts/push-keys.mjs", "scripts/make-pair.mjs", "scripts/mutant-run.mjs", "scripts/group-check.mjs", "scripts/data-fragments.mjs", "scripts/pair/make-pair.mjs", "collector/probe-board.mjs", "collector/probe-evidence.mjs", "collector/fence.mjs"];

test("each script that had the bug does the same through a symlink as run directly (it printed nothing and exited 0 through one)", () => {
  for (const rel of FIXED) {
    const work = tmp(), home = tmp();
    const link = join(work, "linked.mjs");
    symlinkSync(join(ROOT, rel), link);
    const run = (file) => { const r = spawnSync(process.execPath, [file], { cwd: work, encoding: "utf8", timeout: 30000, env: { PATH: process.env.PATH, HOME: home, FB_NO_WIP_PUSH: "1" } }); return [r.status, r.stdout.replaceAll(work, "<w>"), r.stderr.replaceAll(work, "<w>").replaceAll(join(ROOT, rel), "<f>").replaceAll(link, "<f>")]; };
    const direct = run(join(ROOT, rel)), through = run(link);
    assert.deepEqual(through, direct, `${rel}: through a symlink it must do what it does directly`);
  }
});

test("the lint: no script, collector, gate, keeper or worker file compares process.argv[1] with a path it has not resolved (a new one fails here)", () => {
  const offenders = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) { if (name !== "node_modules") walk(p); continue; }
      if (!p.endsWith(".mjs")) continue;
      readFileSync(p, "utf8").split("\n").forEach((line, i) => {
        if (!line.includes("process.argv[1]") || /^\s*\/\//.test(line)) return;
        const resolved = /realpathSync\(process\.argv\[1\]/.test(line) || /\breal\(process\.argv\[1\]\)/.test(line) || /isMain\(/.test(line);
        const message = /NOT RUN/.test(line); // pair/*.template: the message when the real paths differ
        if (!resolved && !message) offenders.push(`${relative(ROOT, p)}:${i + 1}: ${line.trim().slice(0, 100)}`);
      });
    }
  };
  for (const d of ["scripts", "collector", "gate", "keeper", "worker"]) { try { walk(join(ROOT, d)); } catch { /* no such folder */ } }
  assert.deepEqual(offenders, [], "compare real paths: import { isMain } from scripts/is-main.mjs and write if (isMain(import.meta.url))");
});
