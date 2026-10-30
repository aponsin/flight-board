// The keeper wakes every session it resets (#C379, Director for the owner): the 05:12Z wave of 2026-10-28 reset the
// lead with the others, nobody sent the pickups, and the reset sessions sat idle with Remote Control off. The keeper's
// prompt (keeper/TASK.md) now picks its own wave back up in the same run, the lead last, Director never cued.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const doc = readFileSync(new URL("../keeper/TASK.md", import.meta.url), "utf8");
const prompt = doc.match(/## Prompt\n\n```\n([\s\S]*?)\n```/)[1];
const step = (n) => prompt.match(new RegExp(`^${n}\\. ([\\s\\S]*?)(?=^\\d+\\. |(?![\\s\\S]))`, "m"))[1];

test("the run that cues a reset waits for it and sends the pickup itself", () => {
  assert.match(step(6), /in this run/);
  assert.match(step(6), /run_in_background: true/, "a background sleep: a foreground one is refused");
  assert.match(step(6), /idle and whose Messages are under 5,000 tokens has reset: send it exactly "\/pickup <Title>"/);
  assert.match(step(6), /at most 8 waits/, "bounded: a reset that never comes doesn't hold the run");
  assert.match(step(6), /"not reset"/);
});

test("the lead is never in the wave: cued last, after the wave is picked up, and picked up the same way", () => {
  assert.match(step(5), /except Manager/);
  assert.match(step(7), /^Manager last, and only after the wave/);
  assert.match(step(7), /report \(step 8\) first, [^"]*"pickup sent"[^"]*, then exactly "CONTEXT RESET"/, "the cue is the last message it gets");
  assert.match(step(7), /"\/pickup Manager"/);
  assert.ok(prompt.indexOf("7. Manager last") > prompt.indexOf("6. Pick the wave back up"));
});

test("Director is never measured, cued or messaged, so never reset in a wave with the lead", () => {
  assert.match(step(2), /Never measure, cue or message Director/);
  assert.doesNotMatch(step(2), /title is one of:[^.]*Director/);
});

test("a reset is told by the Messages category, never the total (Checker on a307d81: ~88k of overhead in a cleared session)", () => {
  assert.match(step(3), /"Messages" category \(none listed counts as 0\)/);
  assert.match(step(4), /idle \(not working\) and whose Messages are under 5,000 tokens/);
  assert.doesNotMatch(prompt, /under 25,000 tokens/, "the total never falls that low");
});

// #C401: "/pickup Reviewer" went out three runs in a row to a session already picked up (idle, 91k, Messages under 5k):
// low Messages alone isn't "reset". Manager's pick B (after Checker on c70dfb1: a saved entry left out every agent that
// resets itself on its own cue): the lead records pickedAt for each pickup the report lists, and step 4 skips a session
// picked up since its last reset (pickedAt set, no activity more than 30 minutes past it); no pickedAt, a pickup.
test("a pickup from an earlier run skips a session picked up since its reset (pickedAt), and the lead records pickedAt", () => {
  assert.match(step(1), /select:[^"]*mcp__ccd_session_mgmt__send_message,ArtifactData"/, "the keeper reads the board");
  assert.match(step(2), /note each one's lastActivityAt/);
  assert.match(step(4), /ArtifactData get, url \{\{BOARD\}\}, collection "meta", doc_id "context"; read it, never write it/);
  assert.match(step(4), /agents\.<Title>\.pickedAt there is a time \(milliseconds\) and the session's lastActivityAt \(from step 2\) is no more than 30 minutes after it\. Send that one nothing/);
  assert.match(step(4), /A missing pickedAt still gets the pickup \(an agent that reset itself on its own cue\)/);
  assert.doesNotMatch(step(4), /Never send it to a session with no saved entry/, "a self-reset has no saved entry (Checker on c70dfb1)");
  assert.match(step(8), /for each pickup sent, set pickedAt to now \(milliseconds\) and delete its saved, savedTokens and savedPct/);
  assert.match(step(7), /with Manager listed under "pickup sent" \(it is picked up next\)/, "the lead's own pickup gets a pickedAt too");
  assert.match(doc, /`\{\{BOARD\}\}` \(the board's link/);
});

// The keeper's step 4 as a rule, over runs (times in minutes).
const MIN = 60e3;
const pickups = (sessions, agents) => sessions.filter((s) => s.idle && s.messages < 5000 && !(typeof agents[s.title]?.pickedAt === "number" && s.lastActivityAt <= agents[s.title].pickedAt + 30 * MIN)).map((s) => `/pickup ${s.title}`);

test("the keeper's reset, picked up once: a second run sends none", () => {
  const agents = {};
  const reviewer = { title: "Reviewer", idle: true, messages: 3100, lastActivityAt: 0 };
  assert.deepEqual(pickups([reviewer], agents), ["/pickup Reviewer"], "run 1: owed");
  agents.Reviewer = { pickedAt: 1 * MIN }; // step 8: the lead records it
  reviewer.lastActivityAt = 3 * MIN; // it read the pickup and went idle, Messages still under 5,000
  assert.deepEqual(pickups([reviewer], agents), [], "run 2: none");
  assert.deepEqual(pickups([reviewer], agents), [], "run 3: none");
});

test("the self-reset path: an agent that resets itself on its own cue is still picked up", () => {
  const builder = { title: "Builder", idle: true, messages: 900, lastActivityAt: 0 };
  assert.deepEqual(pickups([builder], {}), ["/pickup Builder"], "never picked up before: no pickedAt, a pickup");
  // Picked up at 0, worked for hours up to the limit, then handed off and cleared itself at 5 h.
  const agents = { Builder: { pickedAt: 0 } };
  builder.lastActivityAt = 300 * MIN;
  assert.deepEqual(pickups([builder], agents), ["/pickup Builder"], "a reset after the last pickup: picked up again");
  agents.Builder.pickedAt = 301 * MIN;
  builder.lastActivityAt = 303 * MIN;
  assert.deepEqual(pickups([builder], agents), [], "and only once");
  assert.deepEqual(pickups([{ ...builder, idle: false }, { ...builder, messages: 40000, lastActivityAt: 999 * MIN }], {}), [], "working, or not reset: none");
});

test("no ArtifactData allow rule: one can't be limited to a get (Security on c70dfb1)", () => {
  assert.match(doc, /the task has no ArtifactData allow rule/);
  assert.match(doc, /tell Security before anyone widens anything/);
  assert.doesNotMatch(doc, /permissions allow ArtifactData get/);
});

// #C399 (the owner's 600k in #T1038): the limit is the config's resetAt, filled in where the lead saves the prompt.
test("the reset limit is the config's resetAt ({{RESET_AT}}), or 80% of a 200k window; the lead's the same; no number left", () => {
  assert.match(step(5), /\{\{RESET_AT\}\} tokens or more \(or 80% of a 200k window\)/);
  assert.match(step(7), /at \{\{RESET_AT\}\} tokens or more/);
  assert.doesNotMatch(prompt, /\d00,000 tokens/, "no limit written into the prompt itself");
  assert.match(doc, /`\{\{RESET_AT\}\}` \(board\.config\.json's `resetAt`/);
});

test("the task may run only the exact command 'sleep 120' (Security on a307d81)", () => {
  assert.match(doc, /allow Bash for exactly the command `sleep 120` \(an exact rule\), never Bash in general/);
});

test("the report names what was picked up and what didn't reset, and asks for #C374's save count", () => {
  assert.match(step(8), /\| pickup sent: <Title>, … \(or none\) \| not reset: <Title>, … \(or none\) \|/);
  assert.match(step(8), /for each reset sent that isn't picked up yet \(not reset\), set saved with savedTokens and savedPct/, "#C401: only the ones still owed a pickup");
});

// #C456 (#T1147): at 13:00Z on 2026-10-30 the keeper measured 3 of 15 agents. ~95 finished scheduled-task runs filled
// the list, and the seven agents idle since 01:51Z sat at places 84-91, past limit 50. And its one-folder filter never
// kept Boardsmith, whose folder is the board's own repository. Now limit 100, any of the team's folders, and a role it
// can't find is named in the report instead of silently left out.
test("the keeper lists 100 sessions, keeps any of the team's folders, and reports a role it didn't find", () => {
  assert.match(step(2), /list_sessions \(limit 100;/);
  assert.doesNotMatch(prompt, /limit 50/);
  assert.match(step(2), /whose cwd contains one of: \{\{FOLDERS\}\}/);
  assert.doesNotMatch(doc, /\{\{FOLDER\}\}/, "the one-folder placeholder is gone everywhere, the dry run's included");
  assert.match(doc, /`\{\{FOLDERS\}\}` \(#C456/, "the header says how the lead fills it");
  assert.match(step(2), /A title in that list with no such session is missing/);
  assert.match(step(8), /\| missing: <Title>, … \(or none\)\. Update the board's/, "the report's last field");
  assert.match(step(8), /"all" lists every session measured/);
});

// The keeper's step 2 as a rule, on the 19:31Z list's shape: helper runs first, the idle agents far down.
const keep = (list, folders, roles) => list.filter((s) => !s.isArchived && folders.some((f) => s.cwd.includes(f)) && roles.includes(s.title));
test("on a crowded list: limit 50 loses the idle agents, limit 100 keeps them, and Boardsmith is kept by its folder", () => {
  const roles = ["Manager", "Security", "Boardsmith"], folders = ["team", "flight-board"];
  const runs = Array.from({ length: 82 }, (_, i) => ({ title: i % 2 ? "Collector" : "Team: context keeper", cwd: "/Users/x/Code/team", isArchived: false }));
  const list = [{ title: "Manager", cwd: "/Users/x/Code/team" }, { title: "Boardsmith", cwd: "/Users/x/Code/flight-board" }, ...runs, { title: "Security", cwd: "/Users/x/Code/team" }].map((s) => ({ isArchived: false, ...s }));
  const found = (n) => keep(list.slice(0, n), folders, roles).map((s) => s.title).join();
  assert.equal(found(50), "Manager,Boardsmith", "Security is past place 50");
  assert.equal(found(100), "Manager,Boardsmith,Security");
  assert.equal(keep(list, ["team"], roles).map((s) => s.title).join(), "Manager,Security", "the old one-folder filter drops Boardsmith");
  const missing = roles.filter((r) => !keep(list.slice(0, 50), folders, roles).some((s) => s.title === r));
  assert.equal(missing.join(), "Security", "what the report's missing field would name at limit 50");
});

test("the keeper still never clears a session or touches Remote Control", () => {
  assert.match(prompt, /Never clear a session yourself, never touch Remote Control/);
  assert.doesNotMatch(prompt, /clear_session|set_remote_control/);
});

test("a dry run on a test role is the acceptance, before the live task changes", () => {
  assert.match(doc, /## Dry run \(the acceptance\)[\s\S]*"\/pickup Rehearsal"[\s\S]*Remote Control is on again/);
});

// #C411 (the stuck-agent watchdog stopped for 18 h and nobody knew): the keeper checks it every run, first, with the
// tested script under an exact allow rule, and pushes its one line to the owner and Manager.
test("the watchdog check: step 1 loads PushNotification and runs {{WATCHDOG}}; the step text comes from the config", async () => {
  const { watchdogStep } = await import("../collector/keeper.mjs");
  const { fullConfig, checkConfig } = await import("../scripts/config.mjs");
  assert.match(step(1), /select:[^"]*PushNotification[^"]*"/);
  assert.match(step(1), /Then the watchdog: \{\{WATCHDOG\}\}\s*$/);
  assert.match(doc, /`\{\{WATCHDOG\}\}` \(#C411/, "the header says how the lead fills it");
  const watchdog = { script: "/Users/x/Code/team/scripts/watchdog-watch.mjs", state: "/Users/x/.claude/scheduled-tasks/team-agent-watchdog/state.json", alert: "/Users/x/.claude/scheduled-tasks/team-context-keeper/watchdog-alert.json" };
  // #C443: between warnings the script prints "watchdog late, already warned at hh:mm" every run: the summary's, never a push.
  assert.equal(watchdogStep(fullConfig({ collector: { keeper: { watchdog } } })), `run exactly (one Bash call, nothing around it) "node ${watchdog.script} ${watchdog.state} ${watchdog.alert}". If it prints a line starting with "watchdog late, already warned", don't push or send it: put that exact line in your run summary. Any other line: send that exact line as ONE PushNotification (status proactive) and, as its own message, to the session titled "Manager". If it prints nothing, put "watchdog on time" in your run summary and go on.`);
  assert.equal(watchdogStep(fullConfig({})), "none.", "no watchdog configured: nothing to run");
  assert.deepEqual(checkConfig({ collector: { keeper: { watchdog } } }), []);
  assert.deepEqual(checkConfig({ collector: { keeper: { watchdog: null } } }), []);
  const BAD = "collector.keeper.watchdog: { script: /…/<name>.mjs, state: /…/<name>.json, alert: /…/<name>.json } (absolute paths), or null";
  for (const bad of [{ ...watchdog, script: "~/x.mjs" }, { ...watchdog, state: "/a b/state.json" }, { ...watchdog, alert: "/x/../y.json" }, { ...watchdog, script: "/x/y.sh" }, { ...watchdog, state: "/x/$(id).json" }, { ...watchdog, extra: "/x.json" }, { script: watchdog.script }, "node x"])
    assert.deepEqual(checkConfig({ collector: { keeper: { watchdog: bad } } }), [BAD], JSON.stringify(bad));
});
