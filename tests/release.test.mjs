// Board releases by the release role (scripts/board-release.mjs, #C276): what it refuses, before it pushes anything,
// and what it reads from the owner's install rather than from its caller. Fictional paths and sessions.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { verdict, settingsBlock, stepsOf, pageCapabilities, renderPrompt, configFromSettings, leadFromSettings, PAGE_CAPABILITIES, RELEASE_ENTRIES } from "../scripts/board-release.mjs";
import { importClosure, OWNER_ENTRIES } from "../scripts/current.mjs";

const TASK = (json, steps) => `# The collector's run\n\n## The task itself\n\n  \`\`\`json\n  ${json}\n  \`\`\`\n\n## The steps\n\n${steps}\n`;
const good = {
  forward: true,
  notes: { security: "SECURE\n\nby Security", checker: "PASS Full\n\nby Checker" },
  pinned: "a".repeat(40),
  changed: ["collector/derive.mjs", "page/board.template.html", "collector/TASK.md", "collector/PROMPT.txt"],
  owned: ["gate/gate.mjs", "gate/rules.mjs", "collector/fence.mjs", "collector/collect.mjs", "scripts/config.mjs", "scripts/board-release.mjs", "scripts/current.mjs"],
  settingsChanged: false,
  stepsChanged: true,
  promptChanged: true,
  capabilities: ["db", "comments", "assets", "downloads"],
};

test("a signed commit that touches nothing pinned goes out: the page, the collector's own code, its steps with their prompt", () => {
  assert.deepEqual(verdict(good), { ok: true, refusals: [], promptNeeded: true });
  assert.deepEqual(verdict({ ...good, stepsChanged: false, promptChanged: false }), { ok: true, refusals: [], promptNeeded: false });
  assert.deepEqual(verdict({ ...good, stepsChanged: false }), { ok: true, refusals: [], promptNeeded: true }, "a reworded prompt alone goes out too");
});

test("refused, naming each file, when anything the owner's install pins changed: the gate, the fence, what they import, and the release tool itself", () => {
  const v = verdict({ ...good, changed: [...good.changed, "gate/rules.mjs", "collector/collect.mjs", "scripts/board-release.mjs"] });
  assert.equal(v.ok, false);
  assert.match(v.refusals.join("\n"), /owner's install.*gate\/rules\.mjs, collector\/collect\.mjs, scripts\/board-release\.mjs/);
});

test("the release tool and everything it imports are the owner's (Security B): a release can't loosen the next one", () => {
  const read = (f) => { try { return readFileSync(new URL(`../${f}`, import.meta.url), "utf8"); } catch { return null; } };
  const owned = importClosure([...OWNER_ENTRIES, ...RELEASE_ENTRIES], read);
  for (const f of ["scripts/board-release.mjs", "scripts/current.mjs", "scripts/hooks.mjs", "scripts/config.mjs", "scripts/scan.mjs"]) assert.ok(owned.includes(f), f);
  assert.ok(!owned.includes("collector/PROMPT.txt") && !owned.includes("page/board.template.html"), "the prompt and the page stay the release role's");
});

test("#C278 (Security): the fence takes only collector/export.mjs, which imports nothing; the pinned set is exactly this list", () => {
  const read = (f) => { try { return readFileSync(new URL(`../${f}`, import.meta.url), "utf8"); } catch { return null; } };
  assert.doesNotMatch(read("collector/export.mjs"), /^\s*(import|export\s.*\sfrom)\b/m, "export.mjs imports nothing");
  assert.deepEqual(importClosure(["collector/fence.mjs"], read), ["collector/context.mjs", "collector/export.mjs", "collector/fence.mjs", "scripts/config.mjs"]);
  // A new import from a pinned file into the collector's code re-pins it, and this list says so.
  assert.deepEqual(importClosure([...OWNER_ENTRIES, ...RELEASE_ENTRIES], read), [
    "collector/context.mjs", "collector/export.mjs", "collector/fence.mjs", "collector/refresh.mjs", "collector/text.mjs",
    "gate/after.mjs", "gate/digest.mjs", "gate/gate.mjs", "gate/live.mjs", "gate/owner-waits.mjs", "gate/plan.mjs", "gate/rules.mjs", "gate/session.mjs", "gate/stop.mjs", "gate/traffic.mjs",
    "hooks/red-ask-board.py", "scripts/board-release.mjs", "scripts/config.mjs", "scripts/current.mjs", "scripts/hooks.mjs", "scripts/scan.mjs",
  ]);
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

test("refused when the task's steps changed but its prompt (collector/PROMPT.txt) didn't (Security E)", () => {
  assert.match(verdict({ ...good, promptChanged: false }).refusals.join(), /PROMPT\.txt/);
});

test("refused when the page would need a capability beyond the fixed four (Security D: a new one is the owner's)", () => {
  assert.deepEqual(PAGE_CAPABILITIES, ["db", "comments", "assets", "downloads"]);
  assert.match(verdict({ ...good, capabilities: [...good.capabilities, "mcp"] }).refusals.join(), /capabilit.*mcp/);
  const page = 'a(await claude.use("db")); b(claude.use( "comments" )); c(claude.use(`assets`)); d(claude.use("db"))';
  assert.deepEqual(pageCapabilities(page), ["assets", "comments", "db"]);
  assert.deepEqual(pageCapabilities(readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8")), ["assets", "comments", "db", "downloads"]);
  // A name the scan can't read is refused as one (Checker's probe): a variable, a bracketed use, an unquoted name.
  for (const page of ['const n = "camera"; claude.use(n)', 'claude["use"]("location")', "claude['use']('x')", "claude.use (`a${b}`)"])
    assert.ok(pageCapabilities(page).includes("(a name the page computes)"), page);
  assert.match(verdict({ ...good, capabilities: pageCapabilities("claude.use(n)") }).refusals.join(), /computes/);
});

test("the prompt: the repository's template with the team's values filled in; a placeholder left over refuses", () => {
  const values = { CONFIG: "/srv/team/board.config.json", BOARD: "https://example.com/board", LEAD_ROLE: "Manager", LEAD: "local_lead-1", CURRENT: "/srv/fb/current", OUT: "/srv/fb/out" };
  const text = renderPrompt(readFileSync(new URL("../collector/PROMPT.txt", import.meta.url), "utf8"), values);
  assert.match(text, /^You are the Collector\. With config \/srv\/team\/board\.config\.json and the board https:\/\/example\.com\/board,/);
  assert.match(text, /node \/srv\/fb\/current\/collector\/collect\.mjs --config \/srv\/team\/board\.config\.json --prepare/);
  assert.match(text, /file_path \/srv\/fb\/out\/derived-all\.json/);
  assert.match(text, /Message only Manager, by its session id local_lead-1\./);
  assert.ok(!text.includes("{{"));
  assert.throws(() => renderPrompt("x {{NOPE}} y", values), /NOPE/);
  assert.throws(() => renderPrompt("x {{LEAD}}", { ...values, LEAD: "" }), /LEAD/);
});

test("the config and the lead come from the owner's install, never from the caller", () => {
  const settings = JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ command: "'/n/node' '/u/.flight-board/install/" + "b".repeat(40) + "/gate/gate.mjs' --config '/srv/team/board.config.json'" }] }] } });
  assert.equal(configFromSettings(settings), "/srv/team/board.config.json");
  assert.equal(configFromSettings("{}"), null);
  const collector = JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ command: "'/n/node' '/i/collector/fence.mjs' --config '/c' --send-to local_lead-1 || exit 2" }] }] } });
  assert.equal(leadFromSettings(collector), "local_lead-1");
  assert.equal(leadFromSettings("{}"), null);
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
