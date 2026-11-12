// scripts/changelog.mjs follows no symbolic link and never crashes on a folder (Security's LOW and Checker 2's LOW on #C1019). A committed link could fold a
// one-line file from outside the repository into CHANGELOG.md, or make --write delete files outside it; a folder inside CHANGELOG.d threw EISDIR.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, readFiles, DIR, FILE } from "../scripts/changelog.mjs";

const BASE = "# Changelog\n\n## 0.3.4 - Unreleased\n\n- An old bullet (old-card, #C900).\n\n## 0.3.3\n\n- Shipped (#C800).\n";

// A repository folder and, beside it, an "outside" folder holding one-line card files the run must never touch.
function world() {
  const top = mkdtempSync(join(tmpdir(), "fb-links-")), root = join(top, "repo"), outside = join(top, "outside");
  mkdirSync(root); mkdirSync(outside);
  writeFileSync(join(root, FILE), BASE);
  writeFileSync(join(outside, "secret-card.md"), "- Outside bullet that must not be folded (secret-card, #C9999).\n");
  writeFileSync(join(outside, "other-card.md"), "- Another outside bullet (other-card, #C9998).\n");
  return { top, root, outside };
}
const gone = (w) => rmSync(w.top, { recursive: true, force: true });
const outsideIntact = (w) => assert.deepEqual(readdirSync(w.outside).sort(), ["other-card.md", "secret-card.md"], "the files outside the repository are still there");

test("a folder inside CHANGELOG.d is named, never a crash; real files beside it are still read", () => {
  const w = world();
  try {
    mkdirSync(join(w.root, DIR)); mkdirSync(join(w.root, DIR, "sub-folder"));
    writeFileSync(join(w.root, DIR, "real-card.md"), "- Real (real-card, #C1100).\n");
    const r = run(["--check"], w.root);
    assert.equal(r.code, 1);
    assert.match(r.out, /sub-folder: must be a plain file, not a folder/);
    assert.doesNotMatch(r.out, /real-card/, "the real file is fine");
    assert.deepEqual(readFiles(w.root).files.map((f) => f.name), ["real-card.md"]);
    const w2 = run(["--write"], w.root);
    assert.equal(w2.code, 1, "a bad entry stops the fold");
    assert.equal(readFileSync(join(w.root, FILE), "utf8"), BASE);
    assert.ok(existsSync(join(w.root, DIR, "real-card.md")), "and nothing was deleted");
  } finally { gone(w); }
});

test("a card file that is a symbolic link is refused: not folded, and --write never touches its target", () => {
  const w = world();
  try {
    mkdirSync(join(w.root, DIR));
    symlinkSync(join(w.outside, "secret-card.md"), join(w.root, DIR, "secret-card.md"));
    writeFileSync(join(w.root, DIR, "real-card.md"), "- Real (real-card, #C1100).\n");
    const c = run(["--check"], w.root);
    assert.equal(c.code, 1);
    assert.match(c.out, /secret-card\.md: must be a plain file, not a symbolic link/);
    const printed = run([], w.root);
    assert.equal(printed.code, 1, "a plain run refuses too");
    assert.doesNotMatch(printed.out, /Outside bullet/);
    const wr = run(["--write"], w.root);
    assert.equal(wr.code, 1);
    assert.equal(readFileSync(join(w.root, FILE), "utf8"), BASE, "CHANGELOG.md was not written");
    assert.ok(existsSync(join(w.outside, "secret-card.md")), "the target is untouched");
    outsideIntact(w);
  } finally { gone(w); }
});

test("a dangling link, and a link to a folder, are named as links", () => {
  const w = world();
  try {
    mkdirSync(join(w.root, DIR));
    symlinkSync(join(w.top, "nowhere.md"), join(w.root, DIR, "dangling-card.md"));
    symlinkSync(w.outside, join(w.root, DIR, "folder-link"));
    const c = run(["--check"], w.root);
    assert.equal(c.code, 1);
    assert.match(c.out, /dangling-card\.md: must be a plain file, not a symbolic link/);
    assert.match(c.out, /folder-link: must be a plain file, not a symbolic link/);
    outsideIntact(w);
  } finally { gone(w); }
});

test("CHANGELOG.d itself a link to an outside folder is refused: nothing read from it, and --write deletes nothing there", () => {
  const w = world();
  try {
    symlinkSync(w.outside, join(w.root, DIR));
    for (const args of [["--check"], [], ["--write"]]) {
      const r = run(args, w.root);
      assert.equal(r.code, 1, JSON.stringify(args));
      assert.match(r.out, /CHANGELOG\.d: must be a plain folder, not a symbolic link/);
      assert.doesNotMatch(r.out, /Outside bullet/);
    }
    assert.equal(readFileSync(join(w.root, FILE), "utf8"), BASE);
    outsideIntact(w);
  } finally { gone(w); }
});

test("CHANGELOG.md a link is refused: --write never writes through it", () => {
  const w = world();
  try {
    const target = join(w.outside, "real-changelog.md");
    writeFileSync(target, BASE);
    rmSync(join(w.root, FILE)); symlinkSync(target, join(w.root, FILE));
    mkdirSync(join(w.root, DIR));
    writeFileSync(join(w.root, DIR, "real-card.md"), "- Real (real-card, #C1100).\n");
    for (const args of [[], ["--write"]]) {
      const r = run(args, w.root);
      assert.equal(r.code, 1, JSON.stringify(args));
      assert.match(r.out, /CHANGELOG\.md: must be a plain file, not a symbolic link/);
    }
    assert.equal(readFileSync(target, "utf8"), BASE, "the target was not written");
    assert.ok(existsSync(join(w.root, DIR, "real-card.md")), "and the card file was not deleted");
  } finally { gone(w); }
});

test("plain files and a plain folder still work, and a missing CHANGELOG.d is no files", () => {
  const w = world();
  try {
    assert.deepEqual(readFiles(w.root), { files: [], problems: [] });
    mkdirSync(join(w.root, DIR));
    writeFileSync(join(w.root, DIR, "real-card.md"), "- Real (real-card, #C1100).\n");
    assert.equal(run(["--check"], w.root).code, 0);
    assert.equal(run(["--write"], w.root).code, 0);
    assert.match(readFileSync(join(w.root, FILE), "utf8"), /- Real \(real-card, #C1100\)\.\n- An old bullet/);
    assert.deepEqual(readdirSync(join(w.root, DIR)), []);
  } finally { gone(w); }
});
