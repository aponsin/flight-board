// #C1090: each card writes its docs/DATA.md "Changes" line to docs/DATA.d/<card id>.md and scripts/data-fragments.mjs folds the files in, so two branches that each
// add a line no longer conflict on the end of DATA.md.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, readdirSync, copyFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFragment, fragmentBullets, joinData, run } from "../scripts/data-fragments.mjs";

const line = (date, text = "something changed (#C7)") => `- ${date}: ${text}`;

test("readFragment: a card id's name and one dated line is a fragment; anything else is a named problem", () => {
  const ok = readFragment("some-card.md", `${line("2026-11-16", "a change (#C1090)")}\n`);
  assert.deepEqual([ok.id, ok.date, ok.num, ok.bullet], ["some-card", "2026-11-16", 1090, line("2026-11-16", "a change (#C1090)")]);
  assert.equal(readFragment("c.md", line("2026-11-16", "no card number")).num, Infinity);
  for (const [name, text, re] of [
    ["Some_Card.md", line("2026-11-16"), /file name must be <card id>\.md/],
    ["a.txt", line("2026-11-16"), /file name/],
    ["a.md", "", /empty/],
    ["a.md", `${line("2026-11-16")}\n${line("2026-11-16")}`, /one line/],
    ["a.md", "2026-11-16: no dash", /must start with "- YYYY-MM-DD: "/],
    ["a.md", "- not a date: x", /must start with/],
    ["a.md", "- 2026-11-16:", /must start with/],
    ["a.md", line("2026-13-01"), /not a date/],
    ["a.md", line("2026-11-32"), /not a date/],
  ]) assert.match(readFragment(name, text).problem ?? "", re, `${name} ${text}`);
});

test("fragmentBullets: oldest date first, then the lowest card number, then the file name; problems are listed apart", () => {
  const f = (name, date, n) => ({ name, text: line(date, n ? `x (#C${n})` : "x") });
  const { bullets, problems } = fragmentBullets([f("late.md", "2026-11-17", 5), f("b-two.md", "2026-11-16", 9), f("a-one.md", "2026-11-16", 3), f("zz-nonum.md", "2026-11-16"), f("aa-nonum.md", "2026-11-16"), { name: "bad.md", text: "nope" }]);
  assert.deepEqual(bullets, [line("2026-11-16", "x (#C3)"), line("2026-11-16", "x (#C9)"), line("2026-11-16", "x"), line("2026-11-16", "x"), line("2026-11-17", "x (#C5)")]);
  assert.equal(problems.length, 1);
});

test("joinData: the lines go after the last line, with one newline in between; none changes nothing", () => {
  assert.equal(joinData("a\nb\n", [line("2026-11-16")]), `a\nb\n${line("2026-11-16")}\n`);
  assert.equal(joinData("a\nb", [line("2026-11-16"), line("2026-11-17")]), `a\nb\n${line("2026-11-16")}\n${line("2026-11-17")}\n`);
  assert.equal(joinData("a\nb\n", []), "a\nb\n");
});

// A scratch repository: docs/DATA.md and an empty docs/DATA.d, committed on main.
function repo() {
  const D = mkdtempSync(join(tmpdir(), "data-frag-"));
  const git = (...a) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "user.email=t@example.com", "-c", "user.name=T", ...a], { cwd: D, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q", "-b", "main");
  mkdirSync(join(D, "docs/DATA.d"), { recursive: true });
  writeFileSync(join(D, "docs/DATA.md"), `# Data\n\n## Changes\n\n${line("2026-11-10", "the first line (#C1)")}\n${line("2026-11-12", "the second line (#C2)")}\n`);
  writeFileSync(join(D, "docs/DATA.d/README.md"), "not a fragment\n");
  git("add", "-A"); git("commit", "-qm", "base");
  return { D, git };
}

test("two branches that each add a fragment merge with no conflict, and the fold writes both lines in date order after the old ones", () => {
  const { D, git } = repo();
  try {
    git("switch", "-q", "-c", "card-b");
    writeFileSync(join(D, "docs/DATA.d/card-b.md"), `${line("2026-11-16", "B, landed second (#C20)")}\n`);
    git("add", "-A"); git("commit", "-qm", "b");
    git("switch", "-q", "main"); git("switch", "-q", "-c", "card-a");
    writeFileSync(join(D, "docs/DATA.d/card-a.md"), `${line("2026-11-15", "A, an earlier day (#C30)")}\n`);
    git("add", "-A"); git("commit", "-qm", "a");
    git("merge", "-q", "--no-edit", "card-b"); // would conflict on the end of DATA.md if both had appended there
    assert.deepEqual(readdirSync(join(D, "docs/DATA.d")).sort(), ["README.md", "card-a.md", "card-b.md"]);
    assert.equal(run(["--check"], D).code, 0);
    const r = run(["--write"], D);
    assert.equal(r.code, 0, r.out);
    assert.equal(readFileSync(join(D, "docs/DATA.md"), "utf8"), `# Data\n\n## Changes\n\n${line("2026-11-10", "the first line (#C1)")}\n${line("2026-11-12", "the second line (#C2)")}\n${line("2026-11-15", "A, an earlier day (#C30)")}\n${line("2026-11-16", "B, landed second (#C20)")}\n`);
    assert.deepEqual(readdirSync(join(D, "docs/DATA.d")), ["README.md"], "the fragments are gone, the README stays");
  } finally { rmSync(D, { recursive: true, force: true }); }
});

test("the same two branches appending to the end of DATA.md DO conflict (why the fragments exist)", () => {
  const { D, git } = repo();
  try {
    git("switch", "-q", "-c", "x"); writeFileSync(join(D, "docs/DATA.md"), readFileSync(join(D, "docs/DATA.md"), "utf8") + `${line("2026-11-16", "X (#C20)")}\n`); git("commit", "-qam", "x");
    git("switch", "-q", "main"); git("switch", "-q", "-c", "y"); writeFileSync(join(D, "docs/DATA.md"), readFileSync(join(D, "docs/DATA.md"), "utf8") + `${line("2026-11-16", "Y (#C21)")}\n`); git("commit", "-qam", "y");
    assert.throws(() => git("merge", "-q", "--no-edit", "x"));
  } finally { rmSync(D, { recursive: true, force: true }); }
});

test("run: no flag prints the result and changes nothing; no fragments leaves DATA.md byte for byte; --check names every bad file", () => {
  const { D } = repo();
  try {
    const before = readFileSync(join(D, "docs/DATA.md"), "utf8");
    assert.deepEqual(run([], D), { code: 0, out: before });
    assert.equal(run(["--write"], D).out, "0 DATA fragment(s) folded into docs/DATA.md\n");
    assert.equal(readFileSync(join(D, "docs/DATA.md"), "utf8"), before);
    writeFileSync(join(D, "docs/DATA.d/ok-card.md"), `${line("2026-11-16")}\n`);
    writeFileSync(join(D, "docs/DATA.d/bad-one.md"), "not a line\n");
    writeFileSync(join(D, "docs/DATA.d/Bad_Two.md"), `${line("2026-11-16")}\n`);
    writeFileSync(join(D, "docs/DATA.d/.hidden"), "ignored\n");
    const c = run(["--check"], D);
    assert.equal(c.code, 1); assert.match(c.out, /Bad_Two\.md/); assert.match(c.out, /bad-one\.md/); assert.doesNotMatch(c.out, /ok-card|hidden/);
    assert.equal(run(["--write"], D).code, 1, "a bad file stops --write: nothing is folded or deleted");
    assert.equal(readFileSync(join(D, "docs/DATA.md"), "utf8"), before);
    assert.ok(existsSync(join(D, "docs/DATA.d/ok-card.md")));
  } finally { rmSync(D, { recursive: true, force: true }); }
});

test("nothing follows a symbolic link, and a folder where a file belongs is named (as changelog.mjs)", () => {
  const { D } = repo(), out = mkdtempSync(join(tmpdir(), "data-frag-out-"));
  try {
    writeFileSync(join(out, "outside.md"), `${line("2026-11-16", "from outside")}\n`);
    symlinkSync(join(out, "outside.md"), join(D, "docs/DATA.d/linked.md"));
    const a = run(["--check"], D);
    assert.equal(a.code, 1); assert.match(a.out, /linked\.md: must be a plain file, not a symbolic link/);
    rmSync(join(D, "docs/DATA.d/linked.md"));
    mkdirSync(join(D, "docs/DATA.d/a-folder.md"));
    assert.match(run(["--check"], D).out, /a-folder\.md: must be a plain file, not a folder/);
    rmSync(join(D, "docs/DATA.d/a-folder.md"), { recursive: true });
    rmSync(join(D, "docs/DATA.d"), { recursive: true }); symlinkSync(out, join(D, "docs/DATA.d"));
    assert.match(run(["--check"], D).out, /docs\/DATA\.d: must be a plain folder, not a symbolic link/);
    rmSync(join(D, "docs/DATA.d"));
    rmSync(join(D, "docs/DATA.md")); symlinkSync(join(out, "outside.md"), join(D, "docs/DATA.md"));
    assert.match(run([], D).out, /docs\/DATA\.md: must be a plain file, not a symbolic link/);
    assert.ok(existsSync(join(out, "outside.md")), "nothing outside was touched");
  } finally { rmSync(D, { recursive: true, force: true }); rmSync(out, { recursive: true, force: true }); }
});

test("this repository's own docs/DATA.d passes --check, and docs/DATA.md ends with a newline so a fold appends cleanly", () => {
  const root = new URL("..", import.meta.url).pathname;
  const r = run(["--check"], root);
  assert.equal(r.code, 0, r.out);
  assert.ok(readFileSync(join(root, "docs/DATA.md"), "utf8").endsWith("\n"));
});

// #C1153 (Checker 2's LOW on #C1152): the print mode (no flag) wrote the folded DATA.md to stdout and then called process.exit, which cut the output at the pipe's
// 64 KB buffer when the reader was slower than the writer. The script now sets process.exitCode and ends by itself. The reader below holds its first read back,
// so the pipe fills; it runs a copy of the script in a temp root with a DATA.md well over 64 KB.
test("print mode writes the whole folded DATA.md to a slow pipe, past 64 KB, and exits with its code (#C1153)", async () => {
  const D = realpathSync(mkdtempSync(join(tmpdir(), "datafrag-pipe-")));
  try {
    mkdirSync(join(D, "scripts")); mkdirSync(join(D, "docs/DATA.d"), { recursive: true });
    copyFileSync(new URL("../scripts/data-fragments.mjs", import.meta.url), join(D, "scripts/data-fragments.mjs"));
    const base = `# Data\n\n${Array.from({ length: 3000 }, (_, i) => `- 2026-11-01: an older change number ${i} that is long enough to fill a pipe (#C${i})`).join("\n")}\n`;
    assert.ok(base.length > 150_000);
    writeFileSync(join(D, "docs/DATA.md"), base);
    writeFileSync(join(D, "docs/DATA.d/new-card.md"), `${line("2026-11-17", "the new line (#C9999)")}\n`);
    const child = spawn(process.execPath, [join(D, "scripts/data-fragments.mjs")], { stdio: ["ignore", "pipe", "inherit"] });
    child.stdout.pause();
    const chunks = [];
    const done = new Promise((resolve) => child.on("close", (code) => resolve(code)));
    await new Promise((r) => setTimeout(r, 400));
    child.stdout.on("data", (c) => chunks.push(c));
    child.stdout.resume();
    const code = await done;
    const out = Buffer.concat(chunks).toString("utf8");
    assert.equal(code, 0);
    assert.ok(out.length > 150_000, `only ${out.length} characters came through`);
    assert.ok(out.endsWith(`${line("2026-11-17", "the new line (#C9999)")}\n`), "the folded line is at the end: the print was not cut");
  } finally { rmSync(D, { recursive: true, force: true }); }
});
