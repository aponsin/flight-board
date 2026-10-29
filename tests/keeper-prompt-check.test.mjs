// The keeper's saved prompt is checked (#C407): the owner's v3.20 keeper paste didn't save, the task ran v3.19's prompt,
// and nothing noticed until Security looked. Each Collector run compares the task's saved prompt (SKILL.md, without the
// app's front matter) with the sha256 of the prompt the owner's install shipped; derived/all.keeper says only whether
// it matches, the lead gets a KEEPER line, and the page shows the owner a red line with the command that copies the file.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { promptBody, promptSha, keeperCheck, keeperLine, readSkill, MAX_SKILL } from "../collector/keeper.mjs";
import { fullConfig, checkConfig } from "../scripts/config.mjs";
import { loadNames } from "./harness.mjs";

const T = 1_800_000_000_000;
const V320 = "You are the Team context keeper.\n\n1. Load tools: ArtifactData.\n";
const V319 = "You are the Team context keeper.\n\n1. Load tools.\n";
const saved = (body) => `---\nname: team-context-keeper\ndescription: Every 1 hour\n---\n\n${body}`;
const keeper = { skill: "~/.claude/scheduled-tasks/team-context-keeper/SKILL.md", prompt: "~/Documents/Team/keeper-prompt-v320.txt", promptSha256: promptSha(V320) };
const config = fullConfig({ collector: { keeper } });

test("the prompt as the task holds it: front matter dropped, CRLF as LF, trimmed; one sha256 for both sides", () => {
  assert.equal(promptBody(saved(V320)), V320.trim());
  assert.equal(promptBody(V320), V320.trim(), "the pack's file has no front matter");
  assert.equal(promptSha(saved(V320).replace(/\n/g, "\r\n")), promptSha(V320));
  assert.equal(promptSha(saved(V320) + "\n\n"), promptSha(V320), "a trailing blank line the editor adds");
  assert.notEqual(promptSha(saved(V319)), promptSha(V320));
  assert.match(promptSha(V320), /^[0-9a-f]{64}$/);
});

// A home of its own: ~/.claude/scheduled-tasks/team-context-keeper/SKILL.md and the config's folder ~/Documents/Team.
function home() {
  const h = realpathSync(mkdtempSync(join(tmpdir(), "keeper-")));
  mkdirSync(join(h, ".claude", "scheduled-tasks", "team-context-keeper"), { recursive: true });
  mkdirSync(join(h, "Documents", "Team"), { recursive: true });
  writeFileSync(join(h, "Documents", "Team", "keeper-prompt-v320.txt"), V320);
  return { h, skill: join(h, ".claude", "scheduled-tasks", "team-context-keeper", "SKILL.md"), configDir: join(h, "Documents", "Team") };
}

test("the check: the saved prompt matches or not; off, or no file to read, says nothing", () => {
  const { h, skill, configDir } = home();
  assert.equal(keeperCheck(config, T, { home: h, configDir }), null, "no task saved yet");
  writeFileSync(skill, saved(V320));
  assert.deepEqual(keeperCheck(config, T, { home: h, configDir }), { ok: true, at: T });
  writeFileSync(skill, saved(V319));
  assert.deepEqual(keeperCheck(config, T, { home: h, configDir }), { ok: false, at: T }, "the v3.20 paste that didn't save");
  assert.equal(keeperCheck(fullConfig({}), T, { home: h, configDir }), null, "off by default");
});

// Security's conditions on f30fb84: no probe of any other file, nothing that blocks or eats memory.
test("only a regular file of at most 64 KB inside scheduled-tasks is read; anything else reports nothing", () => {
  const { h, skill, configDir } = home();
  const outside = join(h, "secret.md");
  writeFileSync(outside, saved(V320));
  symlinkSync(outside, skill);
  assert.equal(readSkill(keeper.skill, h), null, "a symlink out of scheduled-tasks");
  assert.equal(keeperCheck(config, T, { home: h, configDir }), null);
  rmSync(skill);
  symlinkSync("/dev/zero", skill);
  assert.equal(readSkill(keeper.skill, h), null, "a device");
  rmSync(skill);
  execFileSync("mkfifo", [skill]);
  assert.equal(readSkill(keeper.skill, h), null, "a FIFO: never opened to block");
  rmSync(skill);
  writeFileSync(skill, "x".repeat(MAX_SKILL + 1));
  assert.equal(readSkill(keeper.skill, h), null, "over 64 KB");
  writeFileSync(skill, saved(V320).padEnd(MAX_SKILL, " "));
  assert.equal(promptSha(readSkill(keeper.skill, h)), promptSha(V320), "64 KB exactly is read");
  rmSync(skill);
  mkdirSync(skill);
  assert.equal(readSkill(keeper.skill, h), null, "a folder");
  for (const p of ["~/.claude/scheduled-tasks/../settings.json", "~/secret.md", "~/.claude/scheduled-tasks/a/b/SKILL.md", "/etc/passwd"]) assert.equal(readSkill(p, h), null, p);
  // The task folder itself a symlink out of scheduled-tasks (Security: realpath, so a symlink can't escape).
  const away = join(h, "away");
  mkdirSync(away);
  writeFileSync(join(away, "SKILL.md"), saved(V320));
  symlinkSync(away, join(h, ".claude", "scheduled-tasks", "linked"));
  assert.equal(readSkill("~/.claude/scheduled-tasks/linked/SKILL.md", h), null, "a task folder linked out");
});

test("the prompt file must sit in the config's own folder; otherwise nothing is reported", () => {
  const { h, skill, configDir } = home();
  writeFileSync(skill, saved(V319));
  const elsewhere = fullConfig({ collector: { keeper: { ...keeper, prompt: "~/Downloads/keeper-prompt-v320.txt" } } });
  assert.equal(keeperCheck(elsewhere, T, { home: h, configDir }), null);
  assert.deepEqual(keeperCheck(config, T, { home: h, configDir }), { ok: false, at: T }, "in the config's folder");
});

test("the lead's line names the prompt file, never the task's text", () => {
  assert.equal(keeperLine(config, { ok: false, at: T }), "KEEPER the context keeper's saved prompt isn't the installed one: the owner pastes keeper-prompt-v320.txt into the keeper task and saves (the board shows the command that copies it)");
  assert.equal(keeperLine(config, { ok: true, at: T }), null);
  assert.equal(keeperLine(config, null), null);
});

test("its config: three fields all set or none; paths a shell can take unquoted; 64 hex", () => {
  assert.deepEqual(fullConfig({}).collector.keeper, { skill: "", prompt: "", promptSha256: "", watchdog: null });
  assert.deepEqual(checkConfig({ collector: { keeper } }), []);
  assert.deepEqual(checkConfig({ collector: { keeper: { skill: "", prompt: "", promptSha256: "" } } }), []);
  assert.deepEqual(checkConfig({ collector: { keeper: { ...keeper, promptSha256: "" } } }), ["collector.keeper: skill, prompt and promptSha256 all set, or none"]);
  for (const bad of ["~/a b.txt", "~/x;rm -rf ~.txt", "~/$(id).txt", "../x.txt", "~/a/../b.txt", "~/a/./b.txt", "a\nb.txt", "`x`.txt", "~/x.md", "/tmp/x.txt", "x.txt"])
    assert.ok(checkConfig({ collector: { keeper: { ...keeper, prompt: bad } } }).includes("collector.keeper.prompt: a .txt file under ~ (letters, digits, . _ - /), or empty"), bad);
  for (const bad of ["~/secret.md", "/etc/passwd", "~/.claude/scheduled-tasks/../settings.json", "~/.claude/scheduled-tasks/a/b/SKILL.md", "~/.claude/scheduled-tasks/A/SKILL.md", "/dev/zero"])
    assert.ok(checkConfig({ collector: { keeper: { ...keeper, skill: bad } } }).includes("collector.keeper.skill: ~/.claude/scheduled-tasks/<task>/SKILL.md, or empty"), bad);
  assert.deepEqual(checkConfig({ collector: { keeper: { ...keeper, promptSha256: "ABC" } } }), ["collector.keeper.promptSha256: 64 hex digits, or empty"]);
  assert.deepEqual(checkConfig({ collector: { keeper: { ...keeper, extra: 1 } } }), ["collector.keeper: { skill, prompt, promptSha256, watchdog }"]);
});

const board = (keeperDoc, cfg = keeper) => {
  const b = loadNames(["keeperLine", "renderStuck", "CONFIG"]);
  b.CONFIG.collector = { ...(b.CONFIG.collector ?? {}), keeper: cfg };
  b.state.derived = keeperDoc === undefined ? [] : [{ id: "all", at: T, cards: {}, keeper: keeperDoc }];
  return b;
};
const CMD = "pbcopy &lt; ~/Documents/Team/keeper-prompt-v320.txt";

test("the page: a red line with the copy command when the saved prompt doesn't match; nothing otherwise", () => {
  const html = board({ ok: false, at: T }).keeperLine();
  assert.match(html, /^<div class="deaf">The context keeper's saved prompt isn't the one your install shipped/);
  assert.match(html, /You: copy keeper-prompt-v320\.txt with this in a terminal, paste it into the team-context-keeper task's prompt and Save\./);
  assert.ok(html.includes(`<code>${CMD}</code>`) && html.includes(`data-copy="${CMD}"`), html);
  assert.equal(board({ ok: true, at: T }).keeperLine(), "");
  assert.equal(board(undefined).keeperLine(), "", "an older Collector: no word");
  assert.equal(board({ ok: false, at: T }, { skill: "", prompt: "", promptSha256: "" }).keeperLine(), "", "off in this page's config");
  assert.equal(board({ ok: false, at: T }, { ...keeper, prompt: "~/x; rm -rf ~" }).keeperLine(), "", "a path the config check refuses is never drawn");
  assert.equal(board({ ok: "false" }).keeperLine(), "", "only a false ok");
});
