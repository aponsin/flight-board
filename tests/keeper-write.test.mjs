// An install pack writes the keeper's prompt into its scheduled task (#C413, Security's six conditions): the owner's
// v3.20 paste didn't save. scripts/keeper-write.mjs keeps the task's front matter byte for byte, replaces the body,
// keeps a backup, never follows a symlink or writes over a file that changed meanwhile, and says ok or paste pending.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, realpathSync, statSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { writeKeeper } from "../scripts/keeper-write.mjs";
import { promptSha } from "../collector/keeper.mjs";

const SKILL = "~/.claude/scheduled-tasks/team-context-keeper/SKILL.md";
const FRONT = "---\nname: team-context-keeper\ndescription: Every 1 hour, send Manager every agent's context\ncron: 0 * * * *\n---\n";
const OLD = "You are the keeper.\n\n1. Load tools.\n";
const NEW = "You are the keeper.\n\n1. Load tools: ArtifactData.\n2. Watch the watchdog.\n";
const sha = (b) => createHash("sha256").update(b).digest("hex");

function setup(skillText = `${FRONT}\n${OLD}`) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "keeper-w-")));
  const dir = join(home, ".claude", "scheduled-tasks", "team-context-keeper");
  mkdirSync(dir, { recursive: true });
  const skill = join(dir, "SKILL.md");
  writeFileSync(skill, skillText, { mode: 0o600 });
  const prompt = join(home, "keeper-prompt-v321.txt");
  writeFileSync(prompt, NEW);
  return { home, dir, skill, prompt, promptFileSha: sha(Buffer.from(NEW)) };
}
const run = (s, extra = {}) => writeKeeper({ skill: SKILL, prompt: s.prompt, promptFileSha: s.promptFileSha, suffix: ".before-v321", home: s.home, ...extra });

test("the prompt goes in: front matter byte for byte, the new body, mode 0644, a backup, ok", () => {
  const s = setup();
  const r = run(s);
  assert.deepEqual(r, { ok: true, lines: ["keeper prompt: ok", `keeper backup: ${s.skill}.before-v321`] });
  const now = readFileSync(s.skill, "utf8");
  assert.ok(now.startsWith(FRONT), "front matter unchanged, byte for byte");
  assert.equal(now, `${FRONT}\n${NEW.trim()}\n`);
  assert.equal(promptSha(now), promptSha(NEW), "#C407's check will read it as the pack's prompt");
  assert.equal(statSync(s.skill).mode & 0o777, 0o644);
  assert.equal(readFileSync(`${s.skill}.before-v321`, "utf8"), `${FRONT}\n${OLD}`);
  assert.deepEqual(readdirSync(s.dir).filter((f) => f.endsWith(".tmp")), [], "no temp file left");
  const again = run(s);
  assert.equal(again.lines[0], "keeper prompt: ok", "a re-run is safe");
  assert.equal(readFileSync(`${s.skill}.before-v321`, "utf8"), `${FRONT}\n${OLD}`, "the first backup is kept");
});

test("each STOP writes nothing: wrong prompt, wrong path, a symlink, no front matter, too big, not a file", () => {
  const unchanged = (s, r, why) => { assert.equal(r.ok, false, why); assert.match(r.lines[0], /^STOP: .*; nothing written$/, why); assert.equal(readFileSync(s.skill, "utf8"), `${FRONT}\n${OLD}`, why); };
  let s = setup();
  unchanged(s, run(s, { promptFileSha: "0".repeat(64) }), "a prompt file that isn't the pack's");
  for (const bad of ["~/.claude/settings.json", "~/.claude/scheduled-tasks/../settings.json", "/etc/passwd", "~/x/SKILL.md"]) unchanged(s, run(s, { skill: bad }), bad);
  unchanged(s, run(s, { suffix: "/../x" }), "a suffix that is a path");
  s = setup();
  const away = join(s.home, "elsewhere.md");
  writeFileSync(away, `${FRONT}\n${OLD}`);
  const linkHome = realpathSync(mkdtempSync(join(tmpdir(), "keeper-l-")));
  mkdirSync(join(linkHome, ".claude", "scheduled-tasks", "team-context-keeper"), { recursive: true });
  symlinkSync(away, join(linkHome, ".claude", "scheduled-tasks", "team-context-keeper", "SKILL.md"));
  const r = run({ ...s, home: linkHome });
  assert.match(r.lines[0], /through a symlink; nothing written/);
  assert.equal(readFileSync(away, "utf8"), `${FRONT}\n${OLD}`, "the link's target untouched");
  s = setup(OLD);
  assert.match(run(s).lines[0], /no front matter; nothing written/);
  assert.equal(readFileSync(s.skill, "utf8"), OLD);
  s = setup(`${FRONT}\n${"x".repeat(70 * 1024)}`);
  assert.match(run(s).lines[0], /not a regular file of at most 64 KB/);
  const none = setup();
  assert.match(run({ ...none, home: realpathSync(mkdtempSync(join(tmpdir(), "keeper-n-"))) }).lines[0], /doesn't exist: save the keeper task once/);
});

test("the task's file changed while it ran (the app's Edit form saved): STOP, the app's save kept, no temp file", () => {
  const s = setup();
  const saved = `${FRONT}\nSomething the app just saved.\n`;
  const r = run(s, { between: () => writeFileSync(s.skill, saved) });
  assert.match(r.lines[0], /changed while this ran \(is its Edit form open in the app\?\); nothing written/);
  assert.equal(readFileSync(s.skill, "utf8"), saved);
  assert.deepEqual(readdirSync(s.dir).filter((f) => f.endsWith(".tmp")), []);
});

test("the CLI: one line per result, exit 0 or 1", () => {
  const s = setup();
  const cli = (args) => spawnSync(process.execPath, [new URL("../scripts/keeper-write.mjs", import.meta.url).pathname, ...args], { encoding: "utf8", env: { ...process.env, HOME: s.home } });
  const bad = cli([SKILL, s.prompt, "0".repeat(64), ".before-v321"]);
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /^STOP: /);
  const good = cli([SKILL, s.prompt, s.promptFileSha, ".before-v321"]);
  assert.equal(good.status, 0, good.stderr);
  assert.match(good.stdout, /^keeper prompt: ok\nkeeper backup: /);
});
