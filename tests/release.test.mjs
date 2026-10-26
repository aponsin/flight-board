// Board releases by the release role (scripts/board-release.mjs, #C276): what it refuses, before it pushes anything.
import test from "node:test";
import assert from "node:assert/strict";
import { verdict, settingsBlock, stepsOf } from "../scripts/board-release.mjs";

const TASK = (json, steps) => `# The collector's run\n\n## The task itself\n\n  \`\`\`json\n  ${json}\n  \`\`\`\n\n## The steps\n\n${steps}\n`;
const good = {
  forward: true,
  notes: { security: "SECURE\n\nby Security", checker: "PASS Full\n\nby Checker" },
  pinned: "a".repeat(40),
  changed: ["collector/derive.mjs", "page/board.template.html", "collector/TASK.md"],
  owned: ["gate/gate.mjs", "gate/rules.mjs", "collector/fence.mjs", "collector/collect.mjs", "scripts/config.mjs"],
  settingsChanged: false,
  stepsChanged: true,
  prompt: "/srv/notes/collector-prompt-v16.txt",
};

test("a signed commit that touches nothing pinned goes out: the page, the collector's own code and its steps", () => {
  assert.deepEqual(verdict(good), { ok: true, refusals: [], promptNeeded: true });
  assert.deepEqual(verdict({ ...good, stepsChanged: false, prompt: undefined }), { ok: true, refusals: [], promptNeeded: false });
});

test("refused, naming each file, when anything the owner's install pins changed: the gate, the fence, or what they import", () => {
  const v = verdict({ ...good, changed: [...good.changed, "gate/rules.mjs", "collector/collect.mjs"] });
  assert.equal(v.ok, false);
  assert.match(v.refusals.join("\n"), /owner's install.*gate\/rules\.mjs, collector\/collect\.mjs/);
});

test("refused when the collector's settings (TASK.md's settings block) changed: they are the owner's", () => {
  assert.match(verdict({ ...good, settingsChanged: true }).refusals.join(), /collector\/TASK\.md.*settings/);
});

test("refused without both sign-offs on this exact commit, off main's line, or with no pinned commit to compare", () => {
  assert.match(verdict({ ...good, notes: { ...good.notes, security: null } }).refusals.join(), /SECURE/);
  assert.match(verdict({ ...good, notes: { ...good.notes, security: "NOT SECURE: x" } }).refusals.join(), /SECURE/);
  assert.match(verdict({ ...good, notes: { ...good.notes, checker: "FAIL: y" } }).refusals.join(), /PASS/);
  assert.match(verdict({ ...good, notes: { ...good.notes, checker: undefined } }).refusals.join(), /PASS/);
  assert.match(verdict({ ...good, forward: false }).refusals.join(), /origin\/main/);
  assert.match(verdict({ ...good, pinned: null, changed: null }).refusals.join(), /no pinned commit/);
});

test("refused when the task's steps changed and no prompt file is given", () => {
  assert.match(verdict({ ...good, prompt: undefined }).refusals.join(), /--prompt/);
});

test("TASK.md: the settings block and the steps are read apart, so a change to one never passes for the other", () => {
  const a = TASK('{ "allow": ["A"] }', "1. Export."), b = TASK('{ "allow": ["A", "B"] }', "1. Export."), c = TASK('{ "allow": ["A"] }', "1. Export, then work.");
  assert.notEqual(settingsBlock(a), settingsBlock(b));
  assert.equal(settingsBlock(a), settingsBlock(c));
  assert.equal(stepsOf(a), stepsOf(b));
  assert.notEqual(stepsOf(a), stepsOf(c));
  assert.equal(settingsBlock("no block"), "");
  assert.equal(stepsOf(null), "");
});
