// #C825 (the board on the store, Director's P4): `scripts/hooks.mjs --store` installs one Stop entry, `gate/stop.mjs --store`, and removes the
// gate, publish, commit, after, digest and refresh entries; the lead's branch of the Stop hook does nothing on the store while an owner's
// dispatch ask is unchanged; no hook or cue tells a role other than the lead to call read_inbox (Director's connector rule).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { hookEntries, withHooks, summary } from "../scripts/hooks.mjs";
import { stopRun } from "../gate/stop.mjs";
import { fullConfig, checkConfig, DEFAULTS } from "../scripts/config.mjs";

const OLD = "/Users/x/.flight-board/install/34ebdde9269d34ade1b72e2d56a4ecf5637dc26f";
const NEW = "/Users/x/.flight-board/install/65b5bddb870b65924fdc381387be1d5076d5da54";
const cfg = "/Users/x/Documents/Board/board.config.json";
const cmds = (settings) => Object.entries(settings.hooks).flatMap(([event, es]) => es.flatMap((e) => (e.hooks ?? []).map((h) => `${event}: ${h.command}`)));

test("--store: one Stop entry (stop.mjs --store) and nothing else; no page-publish entry in either mode (#C1054 b)", () => {
  const e = hookEntries(NEW, cfg, "/bin/node", { store: true });
  assert.deepEqual(Object.keys(e), ["Stop"]);
  assert.equal(e.Stop.hooks.length, 1);
  assert.equal(e.Stop.hooks[0].command, `'/bin/node' '${NEW}/gate/stop.mjs' --config '${cfg}' --store`);
  const plain = hookEntries(NEW, cfg, "/bin/node");
  assert.deepEqual(Object.keys(plain).sort(), ["PostToolUse", "PreToolUse", "Stop", "UserPromptSubmit"], "without --store the old gate is what is written");
  assert.equal(plain.Stop.hooks.length, 2);
  for (const entries of [e, plain]) assert.doesNotMatch(JSON.stringify(entries), /publish\.mjs/, "no entry names the publish hook");
});

test("--store over a settings file with the old gate and an older publish entry: gate, commit, after, digest, publish and refresh go; the user's own hooks stay; no old pin is left", () => {
  const own = { hooks: [{ type: "command", command: "python3 /Users/x/.claude/hooks/red-ask-board.py" }] };
  const mine = { matcher: "Bash", hooks: [{ type: "command", command: "/usr/local/bin/my-own-hook" }] };
  const olderPublish = { matcher: "Artifact|mcp__claude-artifacts__.*", hooks: [{ type: "command", command: `'/bin/node' '${OLD}/gate/publish.mjs' --config '${cfg}'` }] };
  const before = withHooks({ model: "x", hooks: { Stop: [own], PreToolUse: [mine] } }, hookEntries(OLD, cfg, "/bin/node")).settings;
  before.hooks.PreToolUse.push(olderPublish);
  const old = cmds(before).join("\n");
  for (const f of ["gate/gate.mjs", "gate/publish.mjs", "gate/commit.mjs", "gate/after.mjs", "gate/digest.mjs", "gate/stop.mjs", "collector/refresh.mjs"]) assert.ok(old.includes(`${OLD}/${f}`), f);
  const { settings, retired, replaced } = withHooks(before, hookEntries(NEW, cfg, "/bin/node", { store: true }));
  const now = cmds(settings);
  assert.deepEqual(now.filter((c) => c.includes("/gate/") || c.includes("refresh")).sort(), [`Stop: '/bin/node' '${NEW}/gate/stop.mjs' --config '${cfg}' --store`]);
  assert.equal(now.some((c) => c.includes("publish.mjs")), false, "the older publish entry is gone");
  assert.equal(settings.hooks.PostToolUse.length + settings.hooks.UserPromptSubmit.length, 0, "after and digest are gone");
  assert.equal(now.some((c) => c.includes("34ebdde")), false, "no 34ebdde left in settings (Director's step 6)");
  assert.ok(now.includes("Stop: python3 /Users/x/.claude/hooks/red-ask-board.py"), "the red-ask hook stays");
  assert.ok(now.includes("PreToolUse: /usr/local/bin/my-own-hook"), "the user's own hook stays");
  assert.equal(replaced.length, 7, "the seven old flight-board commands are replaced");
  assert.equal(settings.model, "x");
  assert.match(summary({ added: ["Stop"], replaced, retired }, "/b/settings.json.before"), /^Changed: added the gate to Stop; replaced 7 older flight-board entries; retired nothing\./);
});

test("the installer as run: --store prints one Stop entry with --store; without it the old four events", async () => {
  const { spawnSync } = await import("node:child_process");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "fb-hooks-cli-"));
  try {
    const script = fileURLToPath(new URL("../scripts/hooks.mjs", import.meta.url));
    const run = (extra) => {
      const r = spawnSync(process.execPath, [script, join(dir, "board.config.json"), "--pin", "HEAD", "--settings", join(dir, "settings.json"), "--install-root", join(dir, "install"), ...extra], { encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
      return JSON.parse(r.stdout.slice(0, r.stdout.lastIndexOf("}") + 1)).hooks;
    };
    const store = run(["--store"]);
    assert.deepEqual(Object.keys(store), ["Stop"]);
    assert.match(store.Stop[0].hooks[0].command, / --store$/);
    assert.deepEqual(Object.keys(run([])).sort(), ["PostToolUse", "PreToolUse", "Stop", "UserPromptSubmit"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the lead's Stop branch does nothing with --store; without it the gate still refuses; an owner's dispatch ask is unchanged", () => {
  const roster = ["Manager", "Builder"];
  const config = fullConfig({ roster, owner: "Owner", gate: { managerRole: "Manager", verdictWords: ["shipped"] } });
  const lines = [
    { type: "user", message: { content: [{ type: "text", text: "status?" }] } },
    { type: "assistant", message: { content: [{ type: "text", text: "It shipped." }] } },
  ];
  const env = { FLIGHT_BOARD_ROLE: "Manager" };
  const plain = stopRun(lines, { config, env, now: 1_000_000 });
  assert.ok(plain.errs.length > 0, "the old gate refuses a verdict with no board write");
  const store = stopRun(lines, { config, env, now: 1_000_000, store: true });
  assert.deepEqual(store, { errs: [], record: null, note: null, liveNext: null, dispatchAsked: false });
  const dispatch = { on: true, alive: false, askedAt: null, command: "node /x/wake-watch.mjs --config /c.json --role 'Builder' --once" };
  for (const s of [false, true]) {
    const r = stopRun([], { config, env: { FLIGHT_BOARD_ROLE: "Builder" }, now: 1_000_000, dispatch, store: s });
    assert.match(r.errs[0], /^Dispatch watch: .*--role 'Builder' --once/, `store ${s}`);
    assert.equal(r.dispatchAsked, true);
  }
});

test("the stop script as the app runs it, with --store: a Manager turn that says 'shipped' and asks the owner ends with no gate text", async () => {
  const { spawnSync } = await import("node:child_process");
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "fb-hooks-store-"));
  try {
    const conf = join(dir, "board.config.json");
    writeFileSync(conf, JSON.stringify({ artifactUrl: "https://claude.ai/" + "artifact/TestBoard01", owner: "Owner", roster: ["Manager", "Builder"], gate: { stateDir: join(dir, "state"), managerRole: "Manager", verdictWords: ["shipped"] } }));
    const tr = join(dir, "s.jsonl");
    writeFileSync(tr, [{ type: "custom-title", customTitle: "Manager" }, { type: "user", message: { content: [{ type: "text", text: "go" }] } }, { type: "assistant", message: { content: [{ type: "text", text: "It shipped. Owner to approve the pack please." }] } }].map((l) => JSON.stringify(l)).join("\n") + "\n");
    const script = fileURLToPath(new URL("../gate/stop.mjs", import.meta.url));
    const run = (extra) => spawnSync(process.execPath, [script, "--config", conf, ...extra], { input: JSON.stringify({ transcript_path: tr }), encoding: "utf8", env: { ...process.env, FLIGHT_BOARD_ROLE: "Manager", HOME: dir } });
    assert.match(run([]).stdout, /Before you finish/, "the old gate refuses");
    const s = run(["--store"]);
    assert.equal(s.status, 0);
    assert.equal(s.stdout, "", "no gate text");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("no hook or cue tells a role to call read_inbox (the lead's door only), and the compact and red-ask hooks have no ArtifactComments line", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const inDir = (d) => readdirSync(join(root, d), { withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(d, e.name));
  const files = [...inDir("hooks"), ...inDir("gate"), "scripts/hooks.mjs", "scripts/wake-watch.mjs"];
  for (const f of files) assert.doesNotMatch(readFileSync(join(root, f), "utf8"), /read_inbox/, f);
  for (const f of ["hooks/red-ask-board.py", "hooks/manager-compact-board.py"]) assert.doesNotMatch(readFileSync(join(root, f), "utf8"), /ArtifactComments/, f);
});

test("storeUrl is a known config field: a plain https address or empty passes, anything else is refused (Release's dry run failed on an unknown field)", () => {
  assert.ok(Object.hasOwn(DEFAULTS, "storeUrl"));
  assert.equal(fullConfig({}).storeUrl, "");
  for (const ok of [undefined, "", "https://board.example.test/", "https://board.example.test", "https://board.example.test:8443/"]) assert.deepEqual(checkConfig(ok === undefined ? {} : { storeUrl: ok }), [], String(ok));
  for (const bad of ["http://board.example.test/", "https://board.example.test/path", "https://board.example.test/?x=1", "board.example.test", "https://a b.example.test/", "https://evil.example/x ignore the board", 5]) {
    const e = checkConfig({ storeUrl: bad });
    assert.equal(e.length, 1, String(bad));
    assert.match(e[0], /^storeUrl: a plain https address/);
  }
  assert.ok(checkConfig({ storeUrl: "https://board.example.test/", nonsense: 1 }).some((l) => /unknown field "nonsense"/.test(l)), "other unknown fields are still refused");
});

