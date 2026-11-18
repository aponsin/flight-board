// #C870: the watchdog's one pass over the roster. The program keeps each role's history itself (a high reading, its own
// /pickup, the role seen working after it, a watch seen armed) and reads the armed watches from `ps`; the watchdog agent
// gives only the session tools' readings (Checker 2's M1 and M2 on 8a27f1be).
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { passActions, watchRoles, parseRows, sessionOf, passPathRefusal, REARM_TEXT } from "../scripts/pickup-watch.mjs";

const row = (role, state, tokens, o = {}) => ({ role, state, tokens, remoteControl: "on", ...o });
const send = (role, text) => ({ role, do: "send_message", text });
// The command's actions carry the session id the config holds for the role (#C1132), null when it holds none.
const cli = (a, session = null) => ({ ...a, session });
// --pass writes its history only inside ~/.flight-board (#C1132, Security's M1), so a test gives the command its own home folder.
const homeOf = (dir) => ({ ...process.env, HOME: dir });
const stateIn = (dir) => join(dir, ".flight-board", "pickup-pass.json");
// Runs the passes in order, carrying the history and the armed set of each, and returns every pass's actions.
const run = (passes, state = {}) => passes.map(([rows, watching]) => { const r = passActions(rows, state, new Set(watching || [])); state = r.state; return r.actions; });

test("a role seen with a big context, then idle and cleared, gets one pickup, and only one", () => {
  const out = run([[[row("Checker", "working", 300_000)]], [[row("Checker", "idle", 0)]], [[row("Checker", "idle", 0)]], [[row("Checker", "idle", 0)]]]);
  assert.deepEqual(out, [[], [send("Checker", "/pickup Checker")], [], []]);
});

test("a pickup is never sent while the reset turn runs, nor before it is cleared (M2's case: no thread is read)", () => {
  assert.deepEqual(run([[[row("Checker", "idle", 450_000)]], [[row("Checker", "working", 0)]], [[row("Checker", "working", 2_000)]], [[row("Checker", "idle", 300_000)]]]), [[], [], [], []]);
});

test("a role whose history never held a big context gets none (a first run on a cleared session can't tell)", () => {
  assert.deepEqual(run([[[row("Checker", "idle", 0)]], [[row("Checker", "idle", 3_000)]]]), [[], []]);
});

test("the next clear is picked up again, and only after a new big context", () => {
  const out = run([[[row("Checker", "idle", 200_000)]], [[row("Checker", "idle", 0)]], [[row("Checker", "idle", 0)]], [[row("Checker", "idle", 150_000)]], [[row("Checker", "idle", 100)]]]);
  assert.deepEqual(out, [[], [send("Checker", "/pickup Checker")], [], [], [send("Checker", "/pickup Checker")]]);
});

test("M1: three passes send at most one re-arm; a role with no watch ever seen (Manager) is never told", () => {
  const cycle = (watch) => [[[row("Rx", "idle", 300_000)], watch], [[row("Rx", "idle", 0)], []], [[row("Rx", "working", 20_000)], []], [[row("Rx", "idle", 30_000)], []], [[row("Rx", "idle", 30_000)], []], [[row("Rx", "idle", 30_000)], []]];
  const withWatch = run(cycle(["Rx"])), without = run(cycle([]));
  assert.deepEqual(withWatch, [[], [send("Rx", "/pickup Rx")], [], [send("Rx", REARM_TEXT)], [], []]);
  assert.equal(withWatch.flat().filter((a) => a.text === REARM_TEXT).length, 1);
  assert.deepEqual(without, [[], [send("Rx", "/pickup Rx")], [], [], [], []]);
});

test("Checker 2's M1 on 222aa055: an hourly pass never sees the pickup turn; Messages grown from 0 to FRESH or more prove it ran, and the re-arm goes once", () => {
  const out = run([[[row("Rx", "working", 300_000)], ["Rx"]], [[row("Rx", "idle", 0)], []], [[row("Rx", "idle", 40_000)], []], [[row("Rx", "idle", 40_000)], []], [[row("Rx", "idle", 40_000)], []]]);
  assert.deepEqual(out, [[], [send("Rx", "/pickup Rx")], [send("Rx", REARM_TEXT)], [], []]);
  assert.deepEqual(run([[[row("Rx", "working", 300_000)], ["Rx"]], [[row("Rx", "idle", 0)], []], [[row("Rx", "idle", 4_999)], []], [[row("Rx", "idle", 0)], []]]), [[], [send("Rx", "/pickup Rx")], [], []], "a queued pickup stays near 0: not proof");
});

test("no re-arm while the watch is armed, nor before the role was seen working after the pickup", () => {
  assert.deepEqual(run([[[row("Rx", "idle", 300_000)], ["Rx"]], [[row("Rx", "idle", 0)], []], [[row("Rx", "idle", 0)], []]]), [[], [send("Rx", "/pickup Rx")], []], "idle again at once: the pickup turn may not have begun");
  assert.deepEqual(run([[[row("Rx", "idle", 300_000)], ["Rx"]], [[row("Rx", "idle", 0)], []], [[row("Rx", "working", 20_000)], ["Rx"]], [[row("Rx", "idle", 30_000)], ["Rx"]]]), [[], [send("Rx", "/pickup Rx")], [], []]);
});

test("Remote Control off is set on; on, connecting and unavailable are left alone", () => {
  assert.deepEqual(passActions([row("Checker", "working", 9_000, { remoteControl: "off" })]).actions, [{ role: "Checker", do: "set_remote_control", on: true }]);
  for (const s of ["on", "connecting", "unavailable", undefined]) assert.deepEqual(passActions([row("Checker", "working", 9_000, { remoteControl: s })]).actions, []);
});

test("a spaced role name is kept, an odd one or an unreadable row is dropped", () => {
  assert.deepEqual(run([[[row("Checker 2", "working", 300_000)]], [[row("Checker 2", "idle", 0)]]])[1], [send("Checker 2", "/pickup Checker 2")]);
  assert.deepEqual(passActions([row("bad!role", "idle", 0), null, {}, "x"]).actions, []);
  assert.deepEqual(passActions("nope").actions, []);
});

test("Security's L3 and L1: a role name is 2 to 24 characters, and a role outside the roster gets nothing", () => {
  const long = "A" + "b".repeat(23), tooLong = "A" + "b".repeat(24);
  assert.deepEqual(run([[[row(long, "working", 300_000)]], [[row(long, "idle", 0)]]])[1], [send(long, `/pickup ${long}`)]);
  assert.deepEqual(run([[[row(tooLong, "working", 300_000)]], [[row(tooLong, "idle", 0)]]]), [[], []]);
  assert.deepEqual(run([[[row("X", "working", 300_000)]], [[row("X", "idle", 0)]]]), [[], []]);
  const roster = new Set(["Checker"]);
  let r = passActions([row("Checker", "working", 300_000), row("Stranger", "working", 300_000, { remoteControl: "off" })], {}, new Set(), roster);
  r = passActions([row("Checker", "idle", 0), row("Stranger", "idle", 0, { remoteControl: "off" })], r.state, new Set(), roster);
  assert.deepEqual(r.actions, [send("Checker", "/pickup Checker")], "Stranger is on no roster: no pickup, no Remote Control");
  assert.equal(r.state.Stranger, undefined);
});

test("the command takes the rows from a file and the roster from the config; no readable roster means nothing is sent", () => {
  const dir = mkdtempSync(join(tmpdir(), "pickup-pass-")), state = stateIn(dir), rows = join(dir, "rows.json"), cfg = join(dir, "board.config.json");
  const cmd = (rs, ...extra) => { writeFileSync(rows, JSON.stringify(rs)); return execFileSync("node", ["scripts/pickup-watch.mjs", "--pass", "unused", "--rows-file", rows, "--state", state, ...extra], { cwd: new URL("..", import.meta.url), encoding: "utf8", env: homeOf(dir) }).trim(); };
  writeFileSync(cfg, JSON.stringify({ roster: ["Zed Probe"] }));
  assert.equal(cmd([row("Zed Probe", "working", 300_000), row("Other", "working", 300_000)], "--config", cfg), "[]");
  assert.equal(cmd([row("Zed Probe", "idle", 0), row("Other", "idle", 0)], "--config", cfg), JSON.stringify([cli(send("Zed Probe", "/pickup Zed Probe"))]));
  assert.equal(cmd([row("Zed Probe", "idle", 0)], "--config", join(dir, "missing.json")), "[]", "a config that can't be read sends nothing");
  writeFileSync(cfg, JSON.stringify({ nope: 1 }));
  assert.equal(cmd([row("Zed Probe", "idle", 0)], "--config", cfg), "[]", "a config with no roster sends nothing");
});

// #C1132: the scheduled watchdog may not use a file tool (#C443), so the rows come as one argument of plain words and numbers: --rows 'Role,state,tokens,remoteControl;...'.
test("parseRows keeps only a row of exactly four fields of the right shapes; a quote, a space outside the role or a stray word drops the row", () => {
  const pr = (role, state, tokens, remoteControl) => ({ role, state, tokens, remoteControl });
  assert.deepEqual(parseRows("Manager,idle,1200,on;Checker 2,working,70000,off"), [pr("Manager", "idle", 1200, "on"), pr("Checker 2", "working", 70000, "off")]);
  for (const bad of ["Manager,idle,1200", "Manager,idle,1200,on,x", "Manager,sleeping,1,on", "Manager,idle,-1,on", "Manager,idle,1e3,on", `Manager,idle,${"1".repeat(10)},on`,"Manager, idle,1,on", "Man'ager,idle,1,on", "Manager,idle,1,o'n", "Manager,idle,1,on off", "Manager,idle,1,", "Manager,idle,1,1on", "M,idle,1,on", "Manager,idle,1,$(x)", "Manager;idle", "", null, undefined]) assert.deepEqual(parseRows(bad), [], JSON.stringify(bad));
  assert.deepEqual(parseRows("Manager,idle,1,on;bad row;Security,idle,2,off"), [pr("Manager", "idle", 1, "on"), pr("Security", "idle", 2, "off")], "a bad row costs only itself");
  assert.equal(parseRows(Array.from({ length: 80 }, (_, i) => `Role${i},idle,1,on`).join(";")).length, 40, "at most 40 rows");
});

test("the command takes --rows with no file and no JSON: the same actions as the rows file, and the roster still limits the roles", () => {
  const dir = mkdtempSync(join(tmpdir(), "pickup-pass-")), state = stateIn(dir), cfg = join(dir, "board.config.json");
  writeFileSync(cfg, JSON.stringify({ roster: ["Zed Probe", "Checker 2"] }));
  const cmd = (arg, ...extra) => execFileSync("node", ["scripts/pickup-watch.mjs", "--pass", "x", "--rows", arg, "--state", state, "--config", cfg, ...extra], { cwd: new URL("..", import.meta.url), encoding: "utf8", env: homeOf(dir) }).trim();
  assert.equal(cmd("Zed Probe,working,300000,on;Other,working,300000,on;Checker 2,idle,10,off"), JSON.stringify([cli({ role: "Checker 2", do: "set_remote_control", on: true })]), "Other is off the roster; Checker 2 is on it and is switched on");
  assert.equal(cmd("Zed Probe,idle,0,on;Other,idle,0,on"), JSON.stringify([cli(send("Zed Probe", "/pickup Zed Probe"))]), "the history of the first pass holds: Zed Probe was big, now cleared");
  assert.equal(cmd("Zed Probe,idle,0,on"), "[]", "once per clear");
  assert.equal(cmd("not a row"), "[]", "no valid row is nothing");
});

test("each action carries the session id the config's rosterSessions holds for its role, only a plain local session id, else null", () => {
  assert.equal(sessionOf({ Checker: "local_7a92d362-282d-44e7-8b7e-806070f2ad6d" }, "Checker"), "local_7a92d362-282d-44e7-8b7e-806070f2ad6d");
  for (const bad of ["7a92d362-282d-44e7-8b7e-806070f2ad6d", "local_7a92d362", "local_7a92d362-282d-44e7-8b7e-806070f2ad6d; rm", "../local_7a92d362-282d-44e7-8b7e-806070f2ad6d", 5, null, ""]) assert.equal(sessionOf({ Checker: bad }, "Checker"), null, JSON.stringify(bad));
  assert.equal(sessionOf({}, "Checker"), null);
  assert.equal(sessionOf({ Checker: "local_7a92d362-282d-44e7-8b7e-806070f2ad6d" }, "toString"), null, "an inherited key is no entry");
  const dir = mkdtempSync(join(tmpdir(), "pickup-pass-")), state = stateIn(dir), cfg = join(dir, "board.config.json");
  const id ="local_7a92d362-282d-44e7-8b7e-806070f2ad6d";
  writeFileSync(cfg, JSON.stringify({ roster: ["Checker 2", "Security"], rosterSessions: { "Checker 2": id, Security: "not an id" } }));
  const out = JSON.parse(execFileSync("node", ["scripts/pickup-watch.mjs", "--pass", "x", "--rows", "Checker 2,idle,10,off;Security,idle,10,off", "--state", state, "--config", cfg], { cwd: new URL("..", import.meta.url), encoding: "utf8", env: homeOf(dir) }));
  assert.deepEqual(out, [cli({ role: "Checker 2", do: "set_remote_control", on: true }, id), cli({ role: "Security", do: "set_remote_control", on: true }, null)]);
});

// Security's M1 and L1 on d71cebd6: the command is pre-approved as a prefix rule, so it takes no path that reaches outside the board's own folder.
test("passPathRefusal: --state only as ~/.flight-board/pickup-pass.json and not a symlink; --config only as board.config.json; --rows and --rows-file not together", () => {
  const home = mkdtempSync(join(tmpdir(), "pickup-home-"));
  const ok = (extra = {}) => passPathRefusal({ home, ...extra });
  assert.equal(ok(), null);
  assert.equal(ok({ state: join(home, ".flight-board", "pickup-pass.json"), config: "/x/y/board.config.json", rows: "a" }), null);
  for (const state of [join(home, ".claude", "settings.json"), join(home, ".flight-board", "..", "x.json"), join(home, ".flight-board"), join(home, ".flight-board", "x.txt"), join(home, ".flight-board-evil", "x.json"), "/etc/passwd", "state.json", join(home, ".flight-board") + "/../.claude/settings.json",
    // Security's M1 on 112256ee: other .json files in the board folder hold live state (land-holds, stack-switch, dispatch-*, current/package.json): not allowed either.
    join(home, ".flight-board", "land-holds.json"), join(home, ".flight-board", "stack-switch.json"), join(home, ".flight-board", "dispatch-x.json"), join(home, ".flight-board", "current", "package.json"), join(home, ".flight-board", "sub", "pickup-pass.json")]) assert.match(ok({ state }) ?? "", /--state may only be/, state);
  for (const config of ["/x/myboard.config.json", "/x/board.config.json.bak","/x/other.json", "/x/settings.json", "/x/board.config.json/.."]) assert.match(ok({ config }) ?? "", /--config must name a file called board\.config\.json/, config);
  assert.match(ok({ rows: "a", rowsFile: "b" }) ?? "", /together/);
  mkdirSync(join(home, ".flight-board"), { recursive: true });
  symlinkSync(join(home, "elsewhere.json"), join(home, ".flight-board", "link.json"));
  symlinkSync(join(home, "elsewhere.json"), join(home, ".flight-board", "pickup-pass.json"));
  assert.match(ok({ state: join(home, ".flight-board", "pickup-pass.json") }) ?? "", /symbolic link/);
});

test("the command refuses a --state outside ~/.flight-board: it prints [] and creates and writes nothing (Security reproduced the overwrite)", () => {
  const dir = mkdtempSync(join(tmpdir(), "pickup-pass-")), cfg = join(dir, "board.config.json"), outside = join(dir, "new-folder", "target.json");
  writeFileSync(cfg, JSON.stringify({ roster: ["Zed Probe"] }));
  const victim = join(dir, "victim.json"); writeFileSync(victim, "keep me");
  const run = (...a) => spawnSync("node", ["scripts/pickup-watch.mjs", "--pass", "x", "--rows", "Zed Probe,idle,0,off", "--config", cfg, ...a], { cwd: new URL("..", import.meta.url), encoding: "utf8", env: homeOf(dir) });
  for (const state of [outside, victim]) {
    const r = run("--state", state);
    assert.equal(r.stdout.trim(), "[]");
    assert.match(r.stderr, /--state may only be/);
  }
  assert.equal(existsSync(join(dir, "new-folder")), false, "no folder was made");
  assert.equal(readFileSync(victim, "utf8"), "keep me", "no file was overwritten");
  const both = run("--rows-file", victim);
  assert.equal(both.stdout.trim(), "[]");
  assert.match(both.stderr, /together/);
  const okRun = run("--state", stateIn(dir));
  assert.equal(JSON.parse(okRun.stdout).length, 1, "inside the folder it works as before");
  assert.equal(existsSync(stateIn(dir)), true);
  const odd = spawnSync("node", ["scripts/pickup-watch.mjs", "--pass", "x", "--rows", "Zed Probe,idle,0,off", "--config", victim], { cwd: new URL("..", import.meta.url), encoding: "utf8", env: homeOf(dir) });
  assert.equal(odd.stdout.trim(), "[]");
  assert.match(odd.stderr, /board\.config\.json/);
});

// #C1132: the doc is pasted into the watchdog task, so it must fit that task's rules: no file tool, one bare command, and every tool it calls loaded in its step 1.
test("the watchdog doc fits the task: no file tool, the --rows command, the tools it calls loaded, Checker 2 in the title list", () => {
  const doc = readFileSync(new URL("../docs/watchdog-pickup-pass.md", import.meta.url), "utf8");
  assert.doesNotMatch(doc.replace(/no file tool[^.]*\./gi, ""), /Write tool|--rows-file|scratch file/i, "no step writes a file");
  assert.match(doc, /pinned-run\.mjs pickup-watch --pass x --rows '<the rows>' --config <the path of board\.config\.json/);
  const line = doc.match(/"select:([^"]+)"/)?.[1] ?? "";
  for (const tool of ["list_sessions", "list_events", "get_usage", "get_session", "set_remote_control"]) assert.ok(line.split(",").includes(`mcp__ccd_session_mgmt__${tool}`), `${tool} is loaded`);
  for (const tool of ["PushNotification", "SendMessage"]) assert.ok(line.split(",").includes(tool), `${tool} is loaded`);
  assert.match(doc, /Designer, Checker 2\./, "Checker 2 is in the title list");
  assert.match(doc, /Bash\(node ~\/\.flight-board\/current\/scripts\/pinned-run\.mjs pickup-watch:\*\)/, "the command is named for pre-approval");
  // #C1226: the stable entry only. The 12:04 run hit a prompt on the old form, so no line of the doc may run either script by its own path through current.
  assert.doesNotMatch(doc, /node ~\/\.flight-board\/current\/scripts\/(pickup|prompt)-watch\.mjs/, "no run through current's own copy");
  assert.doesNotMatch(doc, /\/Users\//, "no home path in a committed file (the pre-push scan holds the owner's name)");
});

// #C1154 (11-17, 8:04 am: the hourly watchdog ran a bare `cat` of board.config.json, which was not pre-approved, so the run stopped on its own permission prompt and reported
// it as a stuck agent): the pass text must never send the task to read the config. The roster comes from the program (--config is a path argument), not from the task.
test("the watchdog doc never has the task read board.config.json: the pass is told so, and no step reads the config (#C1154)", () => {
  const doc = readFileSync(new URL("../docs/watchdog-pickup-pass.md", import.meta.url), "utf8");
  assert.match(doc, /Never open `board\.config\.json` yourself/, "the pass says so");
  assert.match(doc, /no `cat`, no file tool/);
  assert.doesNotMatch(doc, /For each role on the roster in `board\.config\.json`/, "the old wording that sent the run to the file");
});

// #C1156 (Checker 2's LOW on #C1154): the first guard caught only the words cat, read and open, so a line such as "look up the roster in board.config.json" or a jq read of it
// still passed and would stop the hourly run on a prompt again. So now an ALLOW LIST: the only lines of the doc that may name board.config.json are these exact ones (each
// anchored at the start of its line, with the words that must follow), and any other line that names it fails. A new line that must name it is added here on purpose.
export const CONFIG_LINES_ALLOWED = [
  /^For each session step 2 kept \(its title is a role of the roster; a role with no session is left out\)\. \*\*Never open `board\.config\.json` yourself\*\* \(#C1154: a bare `cat` of it$/,
  /^ {3}`node ~\/\.flight-board\/current\/scripts\/pinned-run\.mjs pickup-watch --pass x --rows '<the rows>' --config <the path of board\.config\.json, the same one the task's prompt-watch step names>`$/,
  /^ {3}is required and must be a file named `board\.config\.json`; pass no `--state` \(the history is `~\/\.flight-board\/pickup-pass\.json`; the$/,
  /^one bare command the owner pre-approved, no step uses a file tool, no step reads `board\.config\.json` \(the config is a path argument to a pinned script, never read with `cat` or any shell$/,
];
// The lines of a doc that name the config but match no allowed line.
export const strayConfigLines = (doc, allowed = CONFIG_LINES_ALLOWED) => doc.split("\n").filter((l) => /board\.config/i.test(l) && !allowed.some((re) => re.test(l)));

test("the watchdog doc names board.config.json only on the allowed lines; any other line that names it fails (#C1156)", () => {
  const doc = readFileSync(new URL("../docs/watchdog-pickup-pass.md", import.meta.url), "utf8");
  assert.deepEqual(strayConfigLines(doc), [], "a line names the config that is not on the allow list");
  // No dead entry: each allowed line is really in the doc, once.
  for (const re of CONFIG_LINES_ALLOWED) assert.equal(doc.split("\n").filter((l) => re.test(l)).length, 1, String(re));
});

test("the allow list refuses the lines the first guard let through: a lookup, a jq read, a cat, and a bad line that borrows a safe word (#C1156)", () => {
  const ok = "one bare command the owner pre-approved, no step uses a file tool, no step reads `board.config.json` (the config is a path argument to a pinned script, never read with `cat` or any shell";
  assert.deepEqual(strayConfigLines(ok), []);
  for (const bad of [
    "Look up the roster in board.config.json before you start.",
    "Run jq '.roster' board.config.json to get the roles.",
    "cat ~/Documents/x/board.config.json",
    "Check the roster in `board.config.json` (never read it twice).",
    "Get the sessions from the BOARD.CONFIG.JSON file.",
    `${ok} and then read it`,
  ]) assert.deepEqual(strayConfigLines(`a\n${bad}\nb`), [bad], bad);
});

test("watchRoles reads --role from the wake-watch lines of ps, quoted or not, and tells Checker from Checker 2", () => {
  const ps = [
    "node /Users/x/.flight-board/install/abc/scripts/wake-watch.mjs --config /c/board.config.json --role Boardsmith --once",
    "node /i/scripts/wake-watch.mjs --config '/c/board.config.json' --role 'Checker 2' --once",
    "node /i/scripts/wake-watch.mjs --role Checker",
    "grep --role Manager something-else.mjs",
    "grep wake-watch.mjs --role Security",
    "/usr/bin/tail -f /logs/wake-watch.mjs.log --role Release",
    "/opt/homebrew/bin/node /i/scripts/wake-watch.mjs --role Release --once",
  ].join("\n");
  assert.deepEqual([...watchRoles(ps)].sort(), ["Boardsmith", "Checker", "Checker 2", "Release"], "node lines only: grep and tail lines naming the script add no role (Checker 2's L1)");
  assert.deepEqual([...watchRoles("")], []);
});

test("the command keeps the history in its state file and prints the actions as JSON; anything unreadable is []", () => {
  const dir = mkdtempSync(join(tmpdir(), "pickup-pass-")), file = stateIn(dir), cfg = join(dir, "board.config.json");
  writeFileSync(cfg, JSON.stringify({ roster: ["Zed Probe"] }));
  const bare = (arg) => execFileSync("node", ["scripts/pickup-watch.mjs", "--pass", arg, "--state", file], { cwd: new URL("..", import.meta.url), encoding: "utf8", env: homeOf(dir) }).trim();
  const cmd = (arg) => execFileSync("node", ["scripts/pickup-watch.mjs", "--pass", arg, "--state", file, "--config", cfg], { cwd: new URL("..", import.meta.url), encoding: "utf8", env: homeOf(dir) }).trim();
  assert.equal(bare(JSON.stringify([row("Zed Probe", "working", 300_000)])), "[]");
  assert.equal(bare(JSON.stringify([row("Zed Probe", "idle", 0, { remoteControl: "off" })])), "[]", "Security's INFO 1: with no --config nothing is sent, not even a Remote Control");
  assert.equal(cmd(JSON.stringify([row("Zed Probe", "working", 300_000)])), "[]");
  assert.equal(cmd(JSON.stringify([row("Zed Probe", "idle", 0)])), JSON.stringify([cli(send("Zed Probe", "/pickup Zed Probe"))]));
  assert.equal(cmd(JSON.stringify([row("Zed Probe", "idle", 0)])), "[]", "the second pass finds the pickup in the file");
  assert.equal(JSON.parse(readFileSync(file, "utf8"))["Zed Probe"].sent, true);
  assert.equal(cmd("not json"), "[]");
  assert.equal(cmd("{}"), "[]");
  writeFileSync(file, "not json");
  assert.equal(cmd(JSON.stringify([row("Zed Probe", "idle", 0)])), "[]", "a broken file is an empty history");
});
