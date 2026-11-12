// Board releases by the release role (scripts/board-release.mjs, #C276): what it refuses, before it pushes anything,
// and what it reads from the owner's install rather than from its caller. Fictional paths and sessions.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { verdict, supersededBy, settingsBlock, stepsOf, pageCapabilities, renderPrompt, configFromSettings, leadFromSettings, PAGE_CAPABILITIES, RELEASE_ENTRIES } from "../scripts/board-release.mjs";
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

// #C738: tonight Release landed v1 of a card after its v2 was pushed. A tip is refused when a newer -vN branch of the same card is on origin.
const H = (c) => String(c).repeat(40);
test("a v1 tip after a v2 is pushed is refused, naming the newer branch; the newest tip, a re-cut at the same commit and other cards are not", () => {
  const heads = [{ branch: "build/c9-thing", sha: H("1") }, { branch: "build/c9-thing-v2", sha: H("2") }, { branch: "build/c8-other", sha: H("3") }, { branch: "build/c9-thing-v10", sha: H("4") }];
  assert.equal(supersededBy(heads, H("1")), "build/c9-thing-v10", "v1 (no suffix), the newest named: v10 beats v2");
  assert.equal(supersededBy(heads, H("2")), "build/c9-thing-v10");
  assert.equal(supersededBy(heads, H("4")), null, "the newest is not superseded");
  assert.equal(supersededBy(heads, H("3")), null, "another card's branch is not touched by c9's");
  assert.equal(supersededBy(heads, H("5")), null, "a commit that is no branch tip is left to the other checks");
  assert.equal(supersededBy([{ branch: "build/c9-thing", sha: H("1") }, { branch: "build/c9-thing-v2", sha: H("2") }, { branch: "build/c9-thing-v3", sha: H("1") }], H("1")), null, "v3 is the same commit as v1: one release");
  assert.equal(supersededBy([{ branch: "build/c9-thing-v2", sha: H("2") }, { branch: "build/c9-thing-v22", sha: H("3") }], H("2")), "build/c9-thing-v22", "v22 is newer than v2");
  assert.equal(supersededBy([{ branch: "build/c9-thing-v2", sha: H("2") }, { branch: "build/c9-thing-v2x", sha: H("3") }], H("2")), null, "v2x is another name, not a version");
  assert.equal(supersededBy(null, H("1")), null); assert.equal(supersededBy([{ branch: 5, sha: "x" }], H("1")), null);
  const v = verdict({ ...good, superseded: "build/c9-thing-v2" });
  assert.equal(v.ok, false); assert.match(v.refusals.join(), /superseded.*build\/c9-thing-v2.*release that one/);
  assert.equal(verdict({ ...good, superseded: null }).ok, true);
});

test("a signed commit that touches nothing pinned goes out: the page, the collector's own code, its steps with their prompt", () => {
  assert.deepEqual(verdict(good), { ok: true, refusals: [], promptNeeded: true });
  assert.deepEqual(verdict({ ...good, stepsChanged: false, promptChanged: false }), { ok: true, refusals: [], promptNeeded: false });
  assert.deepEqual(verdict({ ...good, stepsChanged: false }), { ok: true, refusals: [], promptNeeded: true }, "a reworded prompt alone goes out too");
});

test("refused, naming each file, when anything the owner's install pins changed: the gate, the fence, what they import, and the link move", () => {
  const v = verdict({ ...good, changed: [...good.changed, "gate/rules.mjs", "collector/collect.mjs", "scripts/current.mjs"] });
  assert.equal(v.ok, false);
  assert.match(v.refusals.join("\n"), /owner's install.*gate\/rules\.mjs, collector\/collect\.mjs, scripts\/current\.mjs/);
});

test("the landing job, the link move and what the owner's hooks import are the owner's (Security B); the release tool itself is not (#C1043, the owner chose B on #T1903)", () => {
  const read = (f) => { try { return readFileSync(new URL(`../${f}`, import.meta.url), "utf8"); } catch { return null; } };
  const owned = importClosure([...OWNER_ENTRIES, ...RELEASE_ENTRIES], read);
  assert.ok(!owned.includes("scripts/board-release.mjs") && !RELEASE_ENTRIES.includes("scripts/board-release.mjs"), "the release tool self-updates on land");
  for (const f of ["scripts/board-land.mjs", "scripts/current.mjs", "scripts/hooks.mjs", "scripts/config.mjs", "scripts/scan.mjs"]) assert.ok(owned.includes(f), f);
  assert.ok(!owned.includes("collector/PROMPT.txt") && !owned.includes("page/board.template.html"), "the prompt and the page stay the release role's");
});

test("#C967 (Security F1): the landing job runs from the linked copy, so a commit that changes it is refused like a change to the release tool", () => {
  const read = (f) => { try { return readFileSync(new URL(`../${f}`, import.meta.url), "utf8"); } catch { return null; } };
  const owned = importClosure([...OWNER_ENTRIES, ...RELEASE_ENTRIES], read);
  assert.ok(RELEASE_ENTRIES.includes("scripts/board-land.mjs"));
  assert.ok(owned.includes("scripts/board-land.mjs"));
  const v = verdict({ ...good, owned, changed: ["scripts/board-land.mjs"] });
  assert.equal(v.ok, false);
  assert.match(v.refusals.join("\n"), /owner's install.*scripts\/board-land\.mjs/);
});

test("#C653 (Security): the publish hook and the page build it runs are the owner's, so a release that changes one is refused", () => {
  const read = (f) => { try { return readFileSync(new URL(`../${f}`, import.meta.url), "utf8"); } catch { return null; } };
  const owned = importClosure([...OWNER_ENTRIES, ...RELEASE_ENTRIES], read);
  assert.ok(OWNER_ENTRIES.includes("gate/publish.mjs"), "a registered hook of its own, no other entry imports it");
  assert.ok(OWNER_ENTRIES.includes("gate/commit.mjs"), "#C649: the commit gate is a registered hook of its own too");
  for (const f of ["gate/publish.mjs", "gate/commit.mjs", "gate/build-steps.mjs", "scripts/build-page.mjs", "scripts/fixtures.mjs", "scripts/pack-label.mjs", "gate/tools.mjs"]) {
    assert.ok(owned.includes(f), f);
    const v = verdict({ ...good, owned, changed: [f] });
    assert.equal(v.ok, false, f);
    assert.match(v.refusals.join("\n"), new RegExp(`owner's install.*${f.replace(/[./]/g, "\\$&")}`), f);
  }
  assert.ok(!owned.includes("page/board.template.html"), "the page template is still the release role's: it moves with the link");
});

test("#C278 (Security): the fence takes only collector/export.mjs, which imports nothing; the pinned set is exactly this list", () => {
  const read = (f) => { try { return readFileSync(new URL(`../${f}`, import.meta.url), "utf8"); } catch { return null; } };
  assert.doesNotMatch(read("collector/export.mjs"), /^\s*(import|export\s.*\sfrom)\b/m, "export.mjs imports nothing");
  assert.deepEqual(importClosure(["collector/fence.mjs"], read), ["collector/export.mjs", "collector/fence.mjs", "scripts/config.mjs"]);
  // A new import from a pinned file into the collector's code re-pins it, and this list says so.
  assert.deepEqual(importClosure([...OWNER_ENTRIES, ...RELEASE_ENTRIES], read), [
    "collector/after-ship.mjs", "collector/collect.mjs", "collector/context.mjs", "collector/delta.mjs", "collector/derive.mjs", "collector/expected.mjs", "collector/export.mjs", "collector/facts.mjs", "collector/fence.mjs", "collector/keeper.mjs", "collector/nudges.mjs", "collector/owner-push.mjs", "collector/pairs.mjs", "collector/pickup.mjs", "collector/plan-state.mjs", "collector/prompt-alarm.mjs", "collector/readings.mjs", "collector/refresh.mjs", "collector/review-paths.mjs", "collector/rework.mjs", "collector/stack.mjs", "collector/state-schema.mjs", "collector/state.mjs", "collector/text.mjs", "collector/timings.mjs",
    "gate/after.mjs", "gate/agent-prs.mjs", "gate/build-steps.mjs", "gate/card-rules.mjs", "gate/commit.mjs", "gate/digest.mjs", "gate/gate.mjs", "gate/live.mjs", "gate/owner-waits.mjs", "gate/plan.mjs", "gate/publish.mjs", "gate/reset.mjs", "gate/rules.mjs", "gate/session.mjs", "gate/stop.mjs", "gate/tools.mjs", "gate/traffic.mjs", "gate/wake.mjs",
    "hooks/red-ask-board.py", "scripts/board-land.mjs", "scripts/build-page.mjs", "scripts/config.mjs", "scripts/current.mjs", "scripts/fixtures.mjs", "scripts/hooks.mjs", "scripts/pack-label.mjs", "scripts/scan.mjs", "scripts/state-install.mjs", "scripts/thread-ids.mjs", "scripts/wake-watch.mjs",
    "worker/state-worker.mjs", "worker/team-time.mjs",
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

test("refused when the page would need a capability beyond the fixed five (Security D: a new one is the owner's; mcp came with #C420's pack)", () => {
  assert.deepEqual(PAGE_CAPABILITIES, ["db", "comments", "assets", "downloads", "mcp"]);
  assert.match(verdict({ ...good, capabilities: [...good.capabilities, "room"] }).refusals.join(), /capabilit.*room/);
  const page = 'a(await claude.use("db")); b(claude.use( "comments" )); c(claude.use(`assets`)); d(claude.use("db"))';
  assert.deepEqual(pageCapabilities(page), ["assets", "comments", "db"]);
  assert.deepEqual(pageCapabilities(readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8")), ["assets", "comments", "db", "downloads", "mcp"]);
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
  assert.match(text, /set derived\/all with data exactly \{"fromFile": true\}/, "#C668: the run types no summary");
  // The file is named once, as the file_path of ArtifactData's set (#C710: the tool reads it itself); the run is never told to read it.
  assert.equal((text.match(/derived-all\.json/g) ?? []).length, 1, "and reads no file");
  assert.match(text, /file_path \/srv\/fb\/out\/derived-all\.json, and if_version/);
  assert.ok(!/\bRead (the|that) |Read tool/.test(text));
  assert.match(text, /Send no messages and call no session tool: the probe works the board out and tells Manager\./);
  assert.ok(!text.includes("local_lead-1"), "the Collector is given no session to message");
  assert.ok(!text.includes("{{"));
  assert.throws(() => renderPrompt("x {{NOPE}} y", values), /NOPE/);
  assert.throws(() => renderPrompt("x {{LEAD}}", { ...values, LEAD: "" }), /LEAD/);
});

test("on the store the config is named by the hooks that remain (stop.mjs --store, publish.mjs), not only by the removed gate.mjs", () => {
  const sha = "c".repeat(40);
  const hooks = (...cmds) => JSON.stringify({ hooks: { Stop: [{ hooks: cmds.map((command) => ({ type: "command", command })) }] } });
  const stop = `'/n/node' '/u/.flight-board/install/${sha}/gate/stop.mjs' --config '/srv/team/board.config.json' --store`;
  const publish = `'/n/node' '/u/.flight-board/install/${sha}/gate/publish.mjs' --config '/srv/team/board.config.json'`;
  assert.equal(configFromSettings(hooks(stop, publish)), "/srv/team/board.config.json");
  assert.equal(configFromSettings(hooks(stop)), "/srv/team/board.config.json");
  assert.equal(configFromSettings(hooks(publish)), "/srv/team/board.config.json");
  assert.equal(configFromSettings(hooks("python3 ~/.claude/hooks/red-ask-board.py")), null, "a hook that is not the board's names no config");
  // The script anchor: another hook's --config earlier in the file (or on the same line) is not the board's config (Security's mutant /--config '([^']+)'/).
  const other = `'/n/node' '/elsewhere/other-hook.mjs' --config '/elsewhere/x.json'`;
  assert.equal(configFromSettings(hooks(other, stop)), "/srv/team/board.config.json", "the first --config in the file is not necessarily the board's");
  assert.equal(configFromSettings(hooks(other, publish)), "/srv/team/board.config.json");
  assert.equal(configFromSettings(hooks(other)), null, "a --config on a hook that is not the gate's names no config");
  // Checker: a non-gate script that takes --config, first (prompt-watch.mjs in the real settings), must not be read as the board's config.
  assert.equal(configFromSettings(hooks(`'/n/node' '/u/.flight-board/current/scripts/prompt-watch.mjs' --config '/other.json'`, stop, publish)), "/srv/team/board.config.json");
  // Two gate hooks that name different configs name none: the release refuses rather than read whichever is first.
  const stopElsewhere = `'/n/node' '/u/.flight-board/install/${sha}/gate/stop.mjs' --config '/elsewhere/other.config.json' --store`;
  assert.equal(configFromSettings(hooks(stop, stopElsewhere)), null);
  assert.equal(configFromSettings(hooks(stopElsewhere, publish)), null);
  assert.equal(configFromSettings(hooks(`'/n/node' '/u/.flight-board/install/${sha}/gate/other.mjs' --config '/elsewhere/x.json'`, stop)), "/srv/team/board.config.json", "a gate script that is not gate, stop or publish does not count");
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
