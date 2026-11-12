// changelog-no-recut (#C1019): a card writes its changelog bullet to CHANGELOG.d/<card id>.md, and scripts/changelog.mjs joins them, so a re-cut onto a
// newer main never conflicts on CHANGELOG.md (Checker 2: every landing conflicted every waiting branch on that file alone).
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readCardFile, cardBullets, joinChangelog, run, DIR, FILE } from "../scripts/changelog.mjs";

const HERE = dirname(fileURLToPath(import.meta.url)), ROOT = join(HERE, "..");
const BASE = "# Changelog\n\n## 0.3.4 - Unreleased\n\n- An old bullet (old-card, #C900).\n- An older bullet (older-card, #C899).\n\n## 0.3.3\n\n- Shipped (#C800).\n";

test("readCardFile: a card id's file holding exactly one bullet; anything else is named and refused", () => {
  assert.deepEqual(readCardFile("some-card.md", "- Did a thing (some-card, #C1020).\n"), { id: "some-card", bullet: "- Did a thing (some-card, #C1020).", num: 1020 });
  assert.equal(readCardFile("some-card.md", "- no number here\n").num, -1);
  for (const [name, text, why] of [
    ["Some-Card.md", "- x\n", /file name/], ["some card.md", "- x\n", /file name/], ["some-card.txt", "- x\n", /file name/], ["-a.md", "- x\n", /file name/], ["../x.md", "- x\n", /file name/],
    ["a.md", "", /empty/], ["a.md", "\n", /empty/], ["a.md", "- one\n- two\n", /one bullet on one line/], ["a.md", "- one\r\n", /one bullet on one line/],
    ["a.md", "one\n", /start with/], ["a.md", "-no space\n", /start with/], ["a.md", "- \n", /start with/],
  ]) assert.match(readCardFile(name, text).problem ?? "", why, `${name} ${JSON.stringify(text)}`);
});

test("cardBullets: newest first by the first #C number, highest first; no number last, by file name; problems are listed, not joined", () => {
  const r = cardBullets([
    { name: "b-card.md", text: "- B (#C1020).\n" }, { name: "z-none.md", text: "- Z none.\n" }, { name: "a-card.md", text: "- A (#C1030) and also #C5.\n" },
    { name: "a-none.md", text: "- A none.\n" }, { name: "bad.md", text: "two\nlines\n" }, { name: "c-card.md", text: "- C (#C1020).\n" },
  ]);
  assert.deepEqual(r.bullets, ["- A (#C1030) and also #C5.", "- B (#C1020).", "- C (#C1020).", "- A none.", "- Z none."]);
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0], /^bad\.md: /);
});

test("joinChangelog: the bullets go straight under the Unreleased heading, above the bullets already there; nothing else moves", () => {
  const out = joinChangelog(BASE, ["- New two (#C1021).", "- New one (#C1020)."]);
  assert.equal(out, "# Changelog\n\n## 0.3.4 - Unreleased\n\n- New two (#C1021).\n- New one (#C1020).\n- An old bullet (old-card, #C900).\n- An older bullet (older-card, #C899).\n\n## 0.3.3\n\n- Shipped (#C800).\n");
  assert.equal(joinChangelog(BASE, []), BASE, "no files, no change");
  assert.throws(() => joinChangelog("# Changelog\n\n## 0.3.3\n\n- x\n", ["- y"]), /no "## ... Unreleased" heading/);
  assert.equal(joinChangelog("## Unreleased\n- x\n", ["- y"]), "## Unreleased\n- y\n- x\n", "a heading with no blank line under it");
});

function sandbox(files = {}) {
  const root = mkdtempSync(join(tmpdir(), "fb-c1019-"));
  writeFileSync(join(root, FILE), BASE);
  mkdirSync(join(root, DIR));
  for (const [n, t] of Object.entries(files)) writeFileSync(join(root, DIR, n), t);
  return root;
}

test("the command line: no flag prints the joined changelog and changes nothing; --check names bad files; --write folds the files in and deletes them, once", () => {
  const root = sandbox({ "card-a.md": "- A (#C1021).\n", "card-b.md": "- B (#C1022).\n" });
  try {
    const printed = run([], root);
    assert.equal(printed.code, 0);
    assert.equal(printed.out, joinChangelog(BASE, ["- B (#C1022).", "- A (#C1021)."]));
    assert.equal(readFileSync(join(root, FILE), "utf8"), BASE, "printing writes nothing");
    assert.deepEqual(readdirSync(join(root, DIR)).sort(), ["card-a.md", "card-b.md"]);
    assert.equal(run(["--check"], root).code, 0);
    const folded = run(["--write"], root);
    assert.equal(folded.code, 0);
    assert.equal(readFileSync(join(root, FILE), "utf8"), printed.out, "what --write stores is what the plain run printed");
    assert.deepEqual(readdirSync(join(root, DIR)), [], "the folded files are gone");
    const again = run(["--write"], root);
    assert.equal(again.code, 0);
    assert.equal(readFileSync(join(root, FILE), "utf8"), printed.out, "a second fold adds nothing");
    writeFileSync(join(root, DIR, "Bad Name.md"), "- x\n");
    writeFileSync(join(root, DIR, "ok-card.md"), "- fine (#C1).\n");
    const checked = run(["--check"], root);
    assert.equal(checked.code, 1);
    assert.match(checked.out, /Bad Name\.md: the file name/);
    const refused = run(["--write"], root);
    assert.equal(refused.code, 1, "a bad file stops the fold");
    assert.equal(readFileSync(join(root, FILE), "utf8"), printed.out, "and nothing was written");
    assert.ok(existsSync(join(root, DIR, "ok-card.md")), "and nothing was deleted");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a missing CHANGELOG.d folder is no files; the file's own README is not a card file", () => {
  const root = sandbox({ "README.md": "not a card\n" });
  try {
    assert.equal(run(["--check"], root).code, 0);
    rmSync(join(root, DIR), { recursive: true });
    assert.deepEqual(run([], root), { code: 0, out: BASE });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const git = (cwd, ...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=none", "-c", "commit.gpgsign=false", ...a], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

test("the point: two branches that each add a card file re-cut onto each other with a plain cherry-pick and no conflict; two that each edit CHANGELOG.md do conflict", () => {
  const root = mkdtempSync(join(tmpdir(), "fb-c1019-git-"));
  try {
    git(root, "init", "-q", "-b", "main");
    writeFileSync(join(root, FILE), BASE);
    mkdirSync(join(root, DIR));
    writeFileSync(join(root, DIR, ".gitkeep"), "");
    writeFileSync(join(root, "code.txt"), "base\n");
    git(root, "add", "-A"); git(root, "commit", "-q", "-m", "base");
    // The old way: both cards edit the same place in CHANGELOG.md.
    for (const [b, n] of [["old-a", "A"], ["old-b", "B"]]) {
      git(root, "checkout", "-q", "-b", b, "main");
      writeFileSync(join(root, FILE), BASE.replace("- An old bullet", `- ${n} (#C10${n === "A" ? 21 : 22}).\n- An old bullet`));
      git(root, "commit", "-qam", `old ${n}`);
    }
    git(root, "checkout", "-q", "old-a");
    const old = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=none", "cherry-pick", "old-b"], { cwd: root, encoding: "utf8" });
    assert.notEqual(old.status, 0, "the old way conflicts");
    assert.match(old.stdout + old.stderr, /CONFLICT.*CHANGELOG\.md/);
    git(root, "cherry-pick", "--abort");
    // The new way: each card adds its own file (and some code of its own).
    for (const [b, id, n] of [["new-a", "card-a", 1021], ["new-b", "card-b", 1022]]) {
      git(root, "checkout", "-q", "-b", b, "main");
      writeFileSync(join(root, DIR, `${id}.md`), `- ${id} (#C${n}).\n`);
      writeFileSync(join(root, `${id}.txt`), "code\n");
      git(root, "add", "-A"); git(root, "commit", "-qm", `new ${id}`);
    }
    git(root, "checkout", "-q", "new-a");
    git(root, "cherry-pick", "new-b"); // throws on a conflict
    assert.deepEqual(readdirSync(join(root, DIR)).filter((n) => n !== ".gitkeep").sort(), ["card-a.md", "card-b.md"]);
    assert.equal(readFileSync(join(root, FILE), "utf8"), BASE, "CHANGELOG.md itself was never touched");
    const joined = run([], root);
    assert.equal(joined.out, joinChangelog(BASE, ["- card-b (#C1022).", "- card-a (#C1021)."]), "both bullets, intact, newest first");
    // .gitkeep is not a card file.
    assert.equal(run(["--check"], root).code, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("this repository: every card file here is a card id's single bullet, CHANGELOG.md has an Unreleased heading to join under, and the join reads", () => {
  assert.equal(run(["--check"], ROOT).code, 0, run(["--check"], ROOT).out);
  const joined = run([], ROOT);
  assert.equal(joined.code, 0, joined.out);
  const base = readFileSync(join(ROOT, FILE), "utf8");
  assert.ok(joined.out.length >= base.length);
  assert.equal(joined.out.split("\n").filter((l) => l.startsWith("- ")).length, base.split("\n").filter((l) => l.startsWith("- ")).length + readdirSync(join(ROOT, DIR)).filter((n) => n.endsWith(".md") && n !== "README.md").length, "each card file adds exactly one bullet");
});
