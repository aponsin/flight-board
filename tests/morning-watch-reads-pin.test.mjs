// #C1205: pickup-watch and prompt-watch run from one stable entry (scripts/pinned-run.mjs) that reads the install the owner's hooks pin and runs that install's copy, so the owner's
// permission rules and the morning task name the entry once and never change per pack. Real files in a temp install folder; fictional shas.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { pinnedScript, main, RUNNABLE } from "../scripts/pinned-run.mjs";

const ENTRY = fileURLToPath(new URL("../scripts/pinned-run.mjs", import.meta.url));
const REPO = fileURLToPath(new URL("..", import.meta.url));
const PIN_A = "a".repeat(40), PIN_B = "b".repeat(40);
const settings = (...pins) => JSON.stringify({ hooks: { Stop: pins.map((p) => ({ command: `node /home/x/.flight-board/install/${p}/gate/stop.mjs` })) } });
// An install folder: install/<sha>/scripts/<name>.mjs for each pin, each printing which copy ran and its arguments; a `current` copy that must never run.
function install(pins = [PIN_A, PIN_B]) {
  const root = mkdtempSync(join(tmpdir(), "fb-pinrun-")), installRoot = join(root, "install");
  const put = (dir, tag) => { mkdirSync(join(dir, "scripts"), { recursive: true }); for (const n of RUNNABLE) writeFileSync(join(dir, "scripts", `${n}.mjs`), `console.log(${JSON.stringify(tag)} + " ${n} " + JSON.stringify(process.argv.slice(2)));process.exit(process.argv[2]==="fail"?3:0);`); };
  for (const p of pins) put(join(installRoot, p), p.slice(0, 4));
  put(join(root, "current"), "CURRENT");
  return { root, installRoot };
}
const run = (argv, opts) => { const out = [], err = []; const code = main(argv, { ...opts, err: (s) => err.push(s), run: (cmd, args) => { const r = spawnSync(cmd, args, { encoding: "utf8" }); out.push(r.stdout); return r; } }); return { code, out: out.join(""), err: err.join("") }; };

test("the entry runs the pinned install's copy of the script, with its arguments, and never current's", () => {
  const { installRoot } = install();
  for (const [pin, tag] of [[PIN_A, "aaaa"], [PIN_B, "bbbb"]]) for (const name of RUNNABLE) {
    const r = run([name, "--x", "1"], { settingsText: settings(pin), installRoot });
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out.trim(), `${tag} ${name} ["--x","1"]`);
    assert.doesNotMatch(r.out, /CURRENT/);
  }
});

test("the entry's rule text is the same for two different pins: only the script it reaches changes", () => {
  const { installRoot } = install();
  const rule = `node ~/.flight-board/current/scripts/pinned-run.mjs pickup-watch`;
  const a = pinnedScript({ settingsText: settings(PIN_A), installRoot, name: "pickup-watch" }), b = pinnedScript({ settingsText: settings(PIN_B), installRoot, name: "pickup-watch" });
  assert.ok(a.file.includes(PIN_A) && b.file.includes(PIN_B) && a.file !== b.file);
  assert.equal(rule.includes(PIN_A) || rule.includes(PIN_B), false, "no sha in the entry's path");
});

test("no pin, two different pins, or no settings: it refuses, runs nothing and exits 1", () => {
  const { installRoot } = install();
  for (const [label, settingsText] of [["no settings", null], ["no pin", "{}"], ["two pins", settings(PIN_A, PIN_B)]]) {
    const r = run(["pickup-watch"], { settingsText, installRoot });
    assert.equal(r.code, 1, label); assert.equal(r.out, "", label); assert.match(r.err, /pinned-run: .*nothing run/, label);
  }
});

test("a name not on the list is refused, whatever it looks like (a path, a script of the install, an empty word)", () => {
  const { installRoot } = install();
  for (const name of ["../current/scripts/pickup-watch", "wake-watch", "pickup-watch.mjs", "/etc/passwd", "", undefined]) {
    const r = run([name], { settingsText: settings(PIN_A), installRoot });
    assert.equal(r.code, 1, String(name)); assert.equal(r.out, "", String(name)); assert.match(r.err, /not one of pickup-watch, prompt-watch/);
  }
});

test("a pinned install with no such script, or whose script is a link out of it, runs nothing", () => {
  const { root, installRoot } = install([PIN_A]);
  assert.match(run(["pickup-watch"], { settingsText: settings(PIN_B), installRoot }).err, /has no scripts\/pickup-watch\.mjs/);
  const c = join(root, "current", "scripts", "pickup-watch.mjs"), out = join(installRoot, PIN_B, "scripts");
  mkdirSync(out, { recursive: true }); symlinkSync(c, join(out, "pickup-watch.mjs"));
  const r = run(["pickup-watch"], { settingsText: settings(PIN_B), installRoot });
  assert.equal(r.code, 1); assert.equal(r.out, ""); assert.match(r.err, /link out of it/);
});

test("the script's exit code passes through, and a script that cannot start is a refusal", () => {
  const { installRoot } = install();
  assert.equal(run(["prompt-watch", "fail"], { settingsText: settings(PIN_A), installRoot }).code, 3);
  const r = main(["pickup-watch"], { settingsText: settings(PIN_A), installRoot, err() {}, run: () => ({ error: new Error("spawn failed") }) });
  assert.equal(r, 1);
});

test("each real script does its work through the entry: the same output and exit code as run directly", () => {
  const root = mkdtempSync(join(tmpdir(), "fb-pinrun-real-")), installRoot = join(root, "install");
  mkdirSync(installRoot); symlinkSync(REPO, join(installRoot, PIN_A));
  // The command the entry runs is the same node + the pinned file: the entry's own process, fed a fake settings through a home folder.
  const home = join(root, "home"); mkdirSync(join(home, ".claude"), { recursive: true }); writeFileSync(join(home, ".claude", "settings.json"), settings(PIN_A));
  mkdirSync(join(home, ".flight-board"), { recursive: true }); symlinkSync(installRoot, join(home, ".flight-board", "install"));
  const readings = '[{"state":"idle","tokens":0}]';
  const direct = spawnSync(process.execPath, [join(REPO, "scripts", "pickup-watch.mjs"), readings], { encoding: "utf8" });
  const through = spawnSync(process.execPath, [ENTRY, "pickup-watch", readings], { encoding: "utf8", env: { ...process.env, HOME: home } });
  assert.equal(direct.stdout.trim(), "send");
  assert.equal(through.stdout, direct.stdout); assert.equal(through.status, direct.status);
  const none = join(root, "no-such.json");
  const d2 = spawnSync(process.execPath, [join(REPO, "scripts", "prompt-watch.mjs"), "--config", none], { encoding: "utf8" });
  const t2 = spawnSync(process.execPath, [ENTRY, "prompt-watch", "--config", none], { encoding: "utf8", env: { ...process.env, HOME: home } });
  assert.equal(t2.stdout, d2.stdout); assert.equal(t2.status, d2.status);
});
