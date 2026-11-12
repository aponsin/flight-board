// #C924: the deploy over SSH. (1) wrangler gets the owner's Cloudflare token from the private settings file (board.private.json, mode 600,
// outside any repository) and nothing ever prints it; without the file the browser login stays, and the failure line names the file and the two
// values. (2) board-deploy.mjs <pc n> checks the pair's two files against the pair's own steps file, runs deploy then tree, stops at the first
// failure. No wrangler, no network, no Cloudflare: spawn and fs are injected, or the files are stubs.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, chmodSync, existsSync, copyFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { spawnSync, execFileSync } from "node:child_process";
import { makePair } from "../scripts/pair/make-pair.mjs";
import { makeAll, stepsText } from "../scripts/make-pair.mjs";
import { boardDeploy, boardRollback, readSteps } from "../scripts/pair/board-deploy.mjs";
import { lintPack } from "../scripts/pack-lint.mjs";
import { scanCommit, neverCommit, NEVER_COMMIT } from "../scripts/scan.mjs";

const sha256 = (t) => createHash("sha256").update(t).digest("hex");
// Obviously fake, built from pieces: the shapes the deploy file accepts, nothing real.
const TOKEN = "fake" + "-token-" + "123";
const ACCOUNT = "a1b2c3d4".repeat(4);
const SIGNED = "d".repeat(40);
const UUID = "11111111-2222-3333-4444-555555555555";
const OK_TEXT = "the Worker carries <sha>; now run the tree step";

// The deploy file as the pair maker generates it, imported from a temp folder.
const gen = mkdtempSync(join(tmpdir(), "fb-c924-gen-"));
const files = makePair({ name: "pc34", card: "#C924", what: "test", signed: SIGNED, deployOk: OK_TEXT, treeOk: "board-store-v4 moved" });
writeFileSync(join(gen, "board-store-deploy-pc34.mjs"), files["board-store-deploy-pc34.mjs"]);
const { deployRun, loadCloudflare, redact } = await import(pathToFileURL(join(gen, "board-store-deploy-pc34.mjs")).href);

const DIR = "/owner/board", FILE = `${DIR}/board.private.json`;
const GOOD = JSON.stringify({ cloudflareApiToken: TOKEN, cloudflareAccountId: ACCOUNT });

// An in-memory folder and a fake spawn. o.file: { mode, text } for the settings file (null: none); o.git: folders that hold a .git;
// o.mig / o.dep: what wrangler's migration and deploy return (or a function that throws).
function world(o = {}) {
  const file = o.file === undefined ? { mode: 0o600, text: GOOD } : o.file;
  const reads = [], writes = [], lines = [], calls = [];
  const fs = {
    existsSync: (p) => p === `${DIR}/board.config.json` || (o.git ?? []).includes(p),
    lstatSync: (p) => { if (p === FILE && file) return { isFile: () => !o.notFile, mode: 0o100000 | file.mode }; throw new Error("ENOENT"); },
    readFileSync: (p) => { reads.push(p); if (p === FILE && file) return file.text; throw new Error("ENOENT"); },
    writeFileSync: (p, t) => writes.push([p, t]),
  };
  const run = (x) => (typeof x === "function" ? x() : x);
  const spawn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    if (cmd === "git") return { status: 0, stdout: `${SIGNED}\n` };
    if (cmd === "node") return { status: 0, stdout: "", stderr: "" };
    if (args.includes("migrations")) return run(o.mig) ?? { status: 0 };
    return run(o.dep) ?? { status: 0, stdout: `Current Version ID: ${UUID}\n`, stderr: "" };
  };
  const go = () => deployRun({ here: DIR, spawn, fs, say: (l) => lines.push(l), prepare: () => ({ ok: true }) });
  return { go, reads, writes, lines, calls, wrangler: () => calls.filter((c) => c.cmd === "npx") };
}
const all = (w) => JSON.stringify([w.lines, w.writes, w.calls.map((c) => [c.cmd, c.args])]);

test("with the token in the private file, each wrangler call carries both variables, and nothing prints, writes or passes the token as an argument", () => {
  const w = world();
  const r = w.go();
  assert.equal(r.ok, true, r.line);
  assert.equal(w.wrangler().length, 2, "the migration and the deploy");
  for (const c of w.wrangler()) {
    assert.equal(c.opts.env.CLOUDFLARE_API_TOKEN, TOKEN);
    assert.equal(c.opts.env.CLOUDFLARE_ACCOUNT_ID, ACCOUNT);
  }
  assert.ok(!all(w).includes(TOKEN), "the token is in no printed line, no written file and no argument");
  assert.ok(w.lines.at(-1).startsWith("DEPLOY OK: "), "the last line is the DEPLOY OK line");
  // #C982: besides the marker, the one file the run leaves is its last result (board-deploy-last.json), which the token is not in (the line above checks every write).
  assert.deepEqual(w.writes.map((x) => x[0]), [`${DIR}/board-store-deploy-pc34.done`, `${DIR}/board-deploy-last.json`], "the files written are the marker, which holds the signed sha, and the last result");
  assert.equal(w.writes[0][1], `${SIGNED}\n`);
  assert.equal(JSON.parse(w.writes[1][1]).ok, true);
  // The build and git calls are not given the credentials.
  for (const c of w.calls.filter((x) => x.cmd !== "npx")) assert.equal(c.opts.env, undefined);
});

test("the token never appears in a failure: wrangler's own output, a spawn error, a thrown error", () => {
  const cases = {
    "deploy output echoes it": { dep: { status: 1, stdout: `error with ${TOKEN} and ${ACCOUNT}`, stderr: `Authorization: Bearer ${TOKEN}` } },
    "deploy spawn error": { dep: { status: null, error: new Error(`spawn failed for ${TOKEN}`) } },
    "migration spawn error": { mig: { status: null, error: new Error(`cannot start ${TOKEN}`) } },
    "a thrown error": { dep: () => { throw new Error(`boom ${TOKEN}`); } },
    "deployed but no id": { dep: { status: 0, stdout: `${TOKEN} deployed`, stderr: "" } },
  };
  for (const [why, o] of Object.entries(cases)) {
    const w = world(o);
    const r = w.go();
    assert.equal(r.ok, false, why);
    assert.match(r.line, /^DEPLOY FAILED: /, why);
    assert.ok(!all(w).includes(TOKEN) && !all(w).includes(ACCOUNT), `${why}: the token and the account id are in nothing printed`);
    assert.ok(!r.line.includes(TOKEN), why);
  }
  assert.equal(redact(`a ${TOKEN} b ${TOKEN}`, { CLOUDFLARE_API_TOKEN: TOKEN }), "a [hidden] b [hidden]");
  assert.equal(redact("plain", null), "plain");
});

test("a settings file readable by group or others is refused: named, with chmod 600, never read, nothing run, no contents printed", () => {
  for (const mode of [0o644, 0o640, 0o604, 0o660, 0o666, 0o755]) {
    const w = world({ file: { mode, text: GOOD } });
    const r = w.go();
    assert.equal(r.ok, false);
    assert.ok(r.line.includes(FILE) && r.line.includes(`chmod 600 ${FILE}`), r.line);
    assert.deepEqual(w.reads, [], `mode ${mode.toString(8)}: the file is not opened`);
    assert.equal(w.calls.length, 0, "no command was run");
    assert.ok(!all(w).includes(TOKEN) && !all(w).includes(ACCOUNT), "no contents printed");
  }
  assert.equal(world({ file: { mode: 0o600, text: GOOD } }).go().ok, true, "600 is accepted");
  assert.equal(world({ file: { mode: 0o400, text: GOOD } }).go().ok, true, "400 (read only) is accepted");
});

test("the settings file is read only from outside a repository, and never through a link", () => {
  const w = world({ git: [`${DIR}/.git`] });
  assert.equal(w.go().ok, false);
  assert.match(w.lines[0], /inside a git repository/);
  assert.deepEqual(w.reads, []);
  const up = world({ git: ["/owner/.git"] });
  assert.equal(up.go().ok, false, "a repository further up counts too");
  assert.deepEqual(up.reads, []);
  const link = world({ notFile: true });
  assert.equal(link.go().ok, false);
  assert.match(link.lines[0], /not a plain file/);
  assert.deepEqual(link.reads, []);
});

test("a bad settings file is refused without echoing a value: not JSON, one value only, a malformed token or account", () => {
  const bad = [
    ["{ not json " + TOKEN, /not valid JSON/],
    [JSON.stringify({ cloudflareApiToken: TOKEN }), /needs both/],
    [JSON.stringify({ cloudflareAccountId: ACCOUNT }), /needs both/],
    [JSON.stringify({ cloudflareApiToken: TOKEN + " with spaces", cloudflareAccountId: ACCOUNT }), /cloudflareApiToken in .* is not a Cloudflare API token/],
    [JSON.stringify({ cloudflareApiToken: TOKEN, cloudflareAccountId: "short" + ACCOUNT }), /cloudflareAccountId in .* is not an account id/],
    [JSON.stringify([TOKEN]), /must be a JSON object/],
  ];
  for (const [text, re] of bad) {
    const w = world({ file: { mode: 0o600, text } });
    const r = w.go();
    assert.equal(r.ok, false, text);
    assert.match(r.line, re);
    assert.equal(w.calls.length, 0);
    assert.ok(!r.line.includes(TOKEN) && !r.line.includes(ACCOUNT) && !r.line.includes("short"), "no value in the line");
  }
});

test("no token: today's behaviour (no environment added), and a failure line that names the file and both variables, not only login", () => {
  for (const o of [{ file: null }, { file: { mode: 0o600, text: "{}" } }, { file: { mode: 0o600, text: JSON.stringify({ cloudflareApiToken: "", cloudflareAccountId: "" }) } }]) {
    const ok = world(o);
    assert.equal(ok.go().ok, true);
    for (const c of ok.wrangler()) assert.equal(c.opts.env, undefined, "the options are exactly as before: wrangler's own login applies");
    assert.ok(!ok.lines.some((l) => l.startsWith("Cloudflare:")), "no token line");
    for (const fail of [{ mig: { status: 1 } }, { dep: { status: 1, stdout: "", stderr: "Not logged in" } }]) {
      const w = world({ ...o, ...fail });
      const r = w.go();
      assert.equal(r.ok, false);
      assert.ok(r.line.includes(FILE) && r.line.includes("cloudflareApiToken") && r.line.includes("cloudflareAccountId") && r.line.includes("chmod 600"), r.line);
      assert.ok(r.line.includes("wrangler@4.150.0 login"), "the login is still named as the other way");
    }
  }
  // With a token the hint is not added (the token was used, so "fill the file" would mislead).
  assert.ok(!world({ mig: { status: 1 } }).go().line.includes("If wrangler is not signed in"));
});

test("real files: a 600 file works, a 644 file is refused, and the token is in no file the run leaves", () => {
  const dir = mkdtempSync(join(tmpdir(), "fb-c924-real-"));
  writeFileSync(join(dir, "board.config.json"), "{}\n");
  writeFileSync(join(dir, "board.private.json"), GOOD);
  const spawn = (cmd, args) => (cmd === "git" ? { status: 0, stdout: `${SIGNED}\n` } : cmd === "node" ? { status: 0 } : args.includes("migrations") ? { status: 0 } : { status: 0, stdout: `Current Version ID: ${UUID}` });
  const lines = [];
  const run = () => deployRun({ here: dir, spawn, say: (l) => lines.push(l), prepare: () => ({ ok: true }) });
  chmodSync(join(dir, "board.private.json"), 0o644);
  const r1 = run();
  assert.equal(r1.ok, false);
  assert.ok(r1.line.includes(join(dir, "board.private.json")) && r1.line.includes("chmod 600"));
  assert.ok(!existsSync(join(dir, "board-store-deploy-pc34.done")));
  chmodSync(join(dir, "board.private.json"), 0o600);
  assert.equal(run().ok, true);
  assert.equal(readFileSync(join(dir, "board-store-deploy-pc34.done"), "utf8"), `${SIGNED}\n`);
  for (const f of readdirSync(dir)) if (f !== "board.private.json") assert.ok(!readFileSync(join(dir, f), "utf8").includes(TOKEN), `${f} holds no token`);
  assert.ok(!lines.join("\n").includes(TOKEN));
  // A link to the file is refused.
  const dir2 = mkdtempSync(join(tmpdir(), "fb-c924-link-"));
  writeFileSync(join(dir2, "board.config.json"), "{}\n");
  writeFileSync(join(dir2, "real.json"), GOOD); chmodSync(join(dir2, "real.json"), 0o600);
  symlinkSync(join(dir2, "real.json"), join(dir2, "board.private.json"));
  assert.equal(deployRun({ here: dir2, spawn, say: () => {}, prepare: () => ({ ok: true }) }).ok, false);
});

test("the token is in no generated pair file or steps text: only the file name and the two variable names", () => {
  const steps = stepsText({ name: "pc34", sha: SIGNED, prev: null, commits: [], paths: [], deploySha: "a".repeat(64), treeSha: "b".repeat(64), folder: "~/board", hooksSha: "c".repeat(64), hookPaths: ["hooks/x.py"], boardDeploySha: "e".repeat(64) });
  for (const [name, text] of [...Object.entries(files), ["steps", steps]]) {
    assert.ok(!text.includes(TOKEN) && !text.includes(ACCOUNT), `${name}: no token, no account id`);
    assert.ok(!/CLOUDFLARE_API_TOKEN\s*[:=]\s*["'`][^"'`]+["'`]/.test(text), `${name}: no variable is given a literal value`);
  }
  assert.ok(steps.includes("~/board/board.private.json") && steps.includes("cloudflareApiToken") && steps.includes("cloudflareAccountId"), "the steps file names the file and both values");
  assert.ok(!files["board-store-tree-pc34.mjs"].includes("CLOUDFLARE"), "the tree file has no part in it");
  // No file: no creds, and nothing is read.
  assert.deepEqual(loadCloudflare({ dir: DIR, fs: { lstatSync: () => { throw new Error("ENOENT"); }, existsSync: () => false, readFileSync: () => assert.fail("read") } }), { ok: true, creds: null, file: FILE });
});

// ---------------------------------------------------------------------------------------------------------------- board-deploy.mjs

const NAME = "pc34";
const DEPLOY_F = `board-store-deploy-${NAME}.mjs`, TREE_F = `board-store-tree-${NAME}.mjs`, HOOKS_F = `board-store-hooks-${NAME}.mjs`;
const bd = readFileSync(new URL("../scripts/pair/board-deploy.mjs", import.meta.url));
// A folder like the owner's: stub deploy and tree files that leave a marker when they run, a hooks file, the generic script and a steps file in
// the real form (stepsText), unless `tamper` changes a file after the hashes were taken.
// `restamp`: the attack, a writer of the folder changes the file AND the steps file's two hash lines together (the steps then match the disk).
// The returned `hashes` are the signed ones (of the untampered files): what the pasted line carries.
function folder({ deployBody, treeBody, tamper = {}, noHooks = false, restamp = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "fb-c924-dir-"));
  const stub = (marker, ok, code = 0) => `import { writeFileSync } from "node:fs";\nwriteFileSync(new URL("./${marker}", import.meta.url), process.argv.slice(2).join(" ") + "\\n");\nconsole.log("${ok}");\nprocess.exit(${code});\n`;
  const text = { [DEPLOY_F]: deployBody ?? stub("deploy.ran", "DEPLOY OK: stub deployed"), [TREE_F]: treeBody ?? stub("tree.ran", "TREE OK: stub moved"), [HOOKS_F]: "// hooks\n" };
  const hashes = [sha256(text[DEPLOY_F]), sha256(text[TREE_F])];
  const inSteps = restamp ? [sha256(tamper[DEPLOY_F] ?? text[DEPLOY_F]), sha256(tamper[TREE_F] ?? text[TREE_F])] : hashes;
  const steps = stepsText({ name: NAME, sha: SIGNED, prev: null, commits: [], paths: [], deploySha: inSteps[0], treeSha: inSteps[1], folder: dir, hooksSha: noHooks ? null : sha256(text[HOOKS_F]), hookPaths: ["hooks/x.py"], boardDeploySha: sha256(bd) });
  for (const [f, t] of Object.entries(text)) writeFileSync(join(dir, f), tamper[f] ?? t);
  writeFileSync(join(dir, "board-deploy.mjs"), bd);
  writeFileSync(join(dir, `board-store-${NAME}-steps.md`), steps);
  return { dir, steps, hashes, ran: (m) => existsSync(join(dir, m)) };
}
const bin = (dir) => { // fake open / xdg-open that leave a marker if anything tries to open a browser
  const b = join(dir, "bin"); mkdirSync(b, { recursive: true });
  for (const n of ["open", "xdg-open", "sensible-browser"]) { writeFileSync(join(b, n), `#!/bin/sh\necho opened > "${join(dir, "browser.opened")}"\n`); chmodSync(join(b, n), 0o755); }
  return b;
};
const sh = (dir, line, env = {}) => spawnSync("sh", ["-c", line], { cwd: dir, encoding: "utf8", env: { PATH: `${bin(dir)}:${process.env.PATH}`, SSH_CONNECTION: "10.0.0.2 51234 10.0.0.3 22", ...env } });
// #C921: the line names board-deploy.mjs by the folder's full path.
const oneLiner = (steps) => steps.split("\n").find((l) => l.startsWith("if [ ") && l.includes("/board-deploy.mjs | cut"));
// Runs board-deploy.mjs as the pasted line does: name, deploy hash, tree hash (`hashes` null: no hash arguments).
const runBd = (f, hashes = f.hashes, name = NAME, env = {}) => spawnSync(process.execPath, [join(f.dir, "board-deploy.mjs"), name, ...(hashes ?? [])], { cwd: f.dir, encoding: "utf8", env: { PATH: `${bin(f.dir)}:${process.env.PATH}`, SSH_CONNECTION: "10.0.0.2 51234 10.0.0.3 22", ...env } });

test("steps file: the one-line command first, with board-deploy.mjs's own hash and the exact check form; the two long lines stay below it, unchanged", () => {
  const { steps, dir } = folder();
  const h = sha256(bd);
  const dh = steps.match(/shasum -a 256 \S*\/board-store-deploy-pc34\.mjs \| cut -c1-64\)" = ([0-9a-f]{64}) \]/)[1];
  const th = steps.match(/shasum -a 256 \S*\/board-store-tree-pc34\.mjs \| cut -c1-64\)" = ([0-9a-f]{64}) \]/)[1];
  // #C921: every file by the folder's full path, so the line runs from any folder.
  assert.equal(oneLiner(steps), `if [ "$(shasum -a 256 ${dir}/board-deploy.mjs | cut -c1-64)" = ${h} ]; then node ${dir}/board-deploy.mjs ${NAME} ${dh} ${th}; else echo 'CHECK FAILED: board-deploy.mjs is not the signed file. Paste this line to Manager.'; fi`);
  assert.ok(!/shasum -c/.test(steps) && !/echo "[0-9a-f]{64} {2}/.test(steps), "never the echo-into-shasum -c form");
  // The by-hand lines: as before #C924, with the full path (#C921).
  assert.ok(steps.includes(`if [ "$(shasum -a 256 ${dir}/${DEPLOY_F} | cut -c1-64)" = ${dh} ]; then node ${dir}/${DEPLOY_F}; else echo 'CHECK FAILED: ${DEPLOY_F} is not the signed file. Paste this line to Manager.'; fi\n`));
  assert.ok(steps.includes(`if [ "$(shasum -a 256 ${dir}/${TREE_F} | cut -c1-64)" = ${th} ]; then node ${dir}/${TREE_F} update; else echo 'CHECK FAILED: ${TREE_F} is not the signed file. Paste this line to Manager.'; fi\n`));
  assert.ok(steps.indexOf("board-deploy.mjs |") < steps.indexOf(`${DEPLOY_F} |`), "the one command comes first");
  assert.match(steps, new RegExp(`Full sha256: deploy ${dh}, tree ${th}, board-deploy ${h}, hooks [0-9a-f]{64}\\.`));
  assert.deepEqual(lintPack(oneLiner(steps)), [], "the pack lint is clean on the new line");
  assert.deepEqual(lintPack(steps.split("\n").filter((l) => l.startsWith("if [ ")).join("\n")), []);
});

test("by hand, the two long lines still run as before: line 1 then line 2 print their OK lines; a changed file prints CHECK FAILED and runs nothing", () => {
  const f = folder();
  const lines = f.steps.split("\n").filter((l) => l.startsWith("if [ ") && l.includes(DEPLOY_F) || l.startsWith("if [ ") && l.includes(`${TREE_F} update`));
  assert.equal(lines.length, 2);
  const a = sh(f.dir, lines[0]); assert.match(a.stdout, /DEPLOY OK: stub deployed/); assert.ok(f.ran("deploy.ran"));
  const b = sh(f.dir, lines[1]); assert.match(b.stdout, /TREE OK: stub moved/); assert.equal(readFileSync(join(f.dir, "tree.ran"), "utf8"), "update\n");
  const t = folder({ tamper: { [DEPLOY_F]: "// changed\n" } });
  const c = sh(t.dir, t.steps.split("\n").find((l) => l.startsWith("if [ ") && l.includes(DEPLOY_F)));
  assert.match(c.stdout, new RegExp(`CHECK FAILED: ${DEPLOY_F} is not the signed file`)); assert.ok(!t.ran("deploy.ran"));
});

test("the one-line command runs both lines over SSH (SSH_CONNECTION set, no display), ends with DEPLOY OK then TREE OK, never opens a browser, and only names line 3 (prints no hooks line to paste)", () => {
  const f = folder();
  const r = sh(f.dir, oneLiner(f.steps));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const out = r.stdout.trim().split("\n");
  assert.match(out.at(-2), /^DEPLOY OK: stub deployed/);
  assert.match(out.at(-1), /^TREE OK: stub moved/);
  assert.ok(f.ran("deploy.ran") && f.ran("tree.ran"));
  assert.ok(!f.ran("browser.opened"), "nothing tried to open a browser");
  const hookLine = f.steps.split("\n").find((l) => l.startsWith("if [ ") && l.includes(HOOKS_F));
  assert.ok(hookLine, "the fixture steps file has a hooks line");
  assert.ok(r.stdout.includes("Line 3 (hooks), if the pair's post has one, is still to be run by hand") && !r.stdout.includes(hookLine) && !r.stdout.includes(HOOKS_F), "line 3 is named, and no line or hooks name is printed from the steps file");
  assert.ok(!r.stdout.includes("DISPLAY"));
  const none = folder({ noHooks: true });
  assert.match(runBd(none).stdout, /paste it from the pair's post/);
});

test("a changed deploy or tree file is refused with CHECK FAILED and nothing runs, not even the other file", () => {
  for (const f of [DEPLOY_F, TREE_F]) {
    const w = folder({ tamper: { [f]: "// changed after signing\nconsole.log('DEPLOY OK: fake');\n" } });
    const r = runBd(w);
    assert.equal(r.status, 1);
    assert.match(r.stdout, new RegExp(`^CHECK FAILED: ${f} is not the signed file\\. Nothing was run\\. Paste this line to Manager\\.`, "m"));
    assert.ok(!w.ran("deploy.ran") && !w.ran("tree.ran"), `${f}: nothing ran`);
  }
  // board-deploy.mjs itself changed: the one-liner's own check refuses it.
  const w = folder();
  writeFileSync(join(w.dir, "board-deploy.mjs"), bd + "\n// x\n");
  const r = sh(w.dir, oneLiner(w.steps));
  assert.match(r.stdout, /CHECK FAILED: board-deploy\.mjs is not the signed file/);
  assert.ok(!w.ran("deploy.ran"));
});

test("line 2 never runs after a failed line 1; line 1's failure line is the last word", () => {
  const w = folder({ deployBody: 'console.log("DEPLOY FAILED: stub. Nothing further was run. Paste this line to Manager.");\nprocess.exit(1);\n' });
  const r = runBd(w);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /DEPLOY FAILED: stub/);
  assert.ok(!w.ran("tree.ran"), "the tree step did not run");
  assert.doesNotMatch(r.stdout, /TREE OK/);
  assert.match(r.stdout, /Stopped: board-store-deploy-pc34\.mjs did not finish/);
  // And a failed line 2 is reported, with the deploy having run.
  const t = folder({ treeBody: 'console.log("TREE FAILED: stub. Paste this line to Manager.");\nprocess.exit(1);\n' });
  const r2 = runBd(t);
  assert.equal(r2.status, 1); assert.ok(t.ran("deploy.ran")); assert.match(r2.stdout, /TREE FAILED/);
});

test("board-deploy over injected spawn: the two files in order as plain node runs, tree with update, no other command, no browser, whatever the environment", () => {
  const { dir, hashes } = folder();
  const [deploySha, treeSha] = hashes;
  const calls = [], lines = [];
  const spawn = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { status: 0 }; };
  const r = boardDeploy({ name: NAME, dir, deploySha, treeSha, spawn, say: (l) => lines.push(l), node: "node" });
  assert.equal(r.ok, true);
  assert.deepEqual(calls.map((c) => [c.cmd, c.args.map((a) => a.split("/").pop())]), [["node", [DEPLOY_F]], ["node", [TREE_F, "update"]]]);
  for (const c of calls) { assert.equal(c.opts.stdio, "inherit"); assert.equal(c.opts.env, undefined, "the environment is passed on as it is"); }
  assert.ok(!JSON.stringify(calls.map((c) => [c.cmd, ...c.args.map((a) => a.split("/").pop())])).match(/login|open|browser|npx|wrangler/), "no login, no browser, no wrangler from this script");
  // A failing first spawn stops the run.
  const seen = [];
  const r2 = boardDeploy({ name: NAME, dir, deploySha, treeSha, spawn: (c, a) => { seen.push(a[0].split("/").pop()); return { status: 1 }; }, say: () => {}, node: "node" });
  assert.equal(r2.ok, false); assert.deepEqual(seen, [DEPLOY_F]);
  // A spawn that could not start at all stops it too.
  const seen2 = [];
  assert.equal(boardDeploy({ name: NAME, dir, deploySha, treeSha, spawn: (c, a) => { seen2.push(1); return { status: null, error: new Error("ENOENT") }; }, say: () => {}, node: "node" }).ok, false);
  assert.equal(seen2.length, 1);
});

test("board-deploy refuses a wrong argument, a missing steps file, and a steps file whose two hashes disagree or are missing", () => {
  const { dir, steps, hashes } = folder();
  const [deploySha, treeSha] = hashes;
  const say = [];
  for (const bad of [undefined, "", "34", "pc", "pc34; rm", "../pc34", "PC34"]) {
    assert.equal(boardDeploy({ name: bad, dir, deploySha, treeSha, spawn: () => assert.fail("ran"), say: (l) => say.push(l) }).code, 2, String(bad));
  }
  assert.equal(boardDeploy({ name: "pc99", dir, deploySha, treeSha, spawn: () => assert.fail("ran"), say: (l) => say.push(l) }).ok, false);
  assert.match(say.at(-1), /CHECK FAILED: board-store-pc99-steps\.md is not in this folder/);
  const dh = steps.match(/Full sha256: deploy ([0-9a-f]{64})/)[1];
  const variants = {
    "two different deploy hashes": steps.replace(`Full sha256: deploy ${dh}`, `Full sha256: deploy ${"0".repeat(64)}`),
    "no Full line": steps.replace(/^Full sha256:.*$/m, ""),
    "no hash-checked line for the tree": steps.split("\n").filter((l) => !l.includes(`${TREE_F} | cut`)).join("\n"),
  };
  for (const [why, text] of Object.entries(variants)) {
    writeFileSync(join(dir, `board-store-${NAME}-steps.md`), text);
    const r = boardDeploy({ name: NAME, dir, deploySha, treeSha, spawn: () => assert.fail("ran"), say: (l) => say.push(l) });
    assert.equal(r.ok, false, why); assert.match(say.at(-1), /^CHECK FAILED: /, why);
  }
  assert.equal(readSteps("nothing", NAME).why.includes("Full sha256"), true);
});

test("#C921: readSteps reads a hash line that names the file by a full or ~ path; Still allowed: the bare name", () => {
  const [d, t] = ["a".repeat(64), "b".repeat(64)];
  const text = (pre) => [DEPLOY_F, TREE_F].map((f, i) => `if [ "$(shasum -a 256 ${pre}${f} | cut -c1-64)" = ${[d, t][i]} ]; then node ${pre}${f}; fi`).join("\n") + `\nFull sha256: deploy ${d}, tree ${t}.\n`;
  for (const pre of ["", "/Users/o/board/", "~/Documents/Board/"]) {
    const r = readSteps(text(pre), NAME);
    assert.equal(r.deploy, d, pre); assert.equal(r.tree, t, pre);
  }
  // A path is not a way round the check: another file's name with the right ending, or a quote or space in the folder, does not read.
  for (const pre of ["/x/evil-", "/x y/", "\"/x/"]) assert.ok(readSteps(text(pre), NAME).why, pre);
});

test("make-pair copies board-deploy.mjs byte for byte and puts its sha256 in the steps file's one-line command", () => {
  const dir = mkdtempSync(join(tmpdir(), "fb-c924-mk-"));
  const bare = join(dir, "origin.git"), work = join(dir, "work"), out = join(dir, "out");
  mkdirSync(out);
  const g = (...a) => execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=T", "-c", "commit.gpgsign=false", ...a], { cwd: work, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  g("remote", "add", "origin", bare);
  writeFileSync(join(work, "f"), "1\n"); g("add", "-A"); g("commit", "-qm", "base (#C100)"); g("push", "-q", "origin", "main");
  const sha = g("rev-parse", "HEAD");
  const r = makeAll({ repo: work, sha, n: 34, out });
  assert.equal(r.ok, true, r.why);
  assert.ok(readFileSync(join(out, "board-deploy.mjs")).equals(bd), "byte-identical");
  assert.equal(r.files["board-deploy.mjs"], sha256(bd));
  const steps = readFileSync(join(out, "board-store-pc34-steps.md"), "utf8");
  const dsha = sha256(readFileSync(join(out, "board-store-deploy-pc34.mjs"))), tsha = sha256(readFileSync(join(out, "board-store-tree-pc34.mjs")));
  assert.ok(oneLiner(steps).includes(`= ${sha256(bd)} ]; then node ${out}/board-deploy.mjs pc34 ${dsha} ${tsha};`), "the line carries all three hashes, in place");
  // The real generated pair is readable by the script: both hashes agree and match the files written.
  const parsed = readSteps(steps, "pc34");
  assert.equal(parsed.deploy, dsha);
  assert.equal(parsed.tree, tsha);
  assert.equal(parsed.hooksLine, undefined);
  // The generated deploy file and board-deploy.mjs parse.
  for (const f of ["board-deploy.mjs", "board-store-deploy-pc34.mjs", "board-store-tree-pc34.mjs"]) execFileSync(process.execPath, ["--check", join(out, f)], { stdio: "pipe" });
  // The pair folder is not a repository, so a real private file there would be read; here only the steps are checked for the file name.
  assert.ok(steps.includes("board.private.json"));
});

test("the private settings file is never committed: the push scan names it by its file name and never reads it", () => {
  assert.deepEqual(NEVER_COMMIT, ["board.private.json"]);
  assert.equal(neverCommit("board.private.json"), true);
  assert.equal(neverCommit("some/folder/board.private.json"), true);
  assert.equal(neverCommit("board.config.json"), false);
  const asked = [];
  const git = (args) => { asked.push(args.join(" ")); return args[0] === "diff-tree" ? "board.private.json\0docs/x.md\0" : args[0] === "cat-file" ? "plain text\n" : "subject\nname <a@example.com>\nname <a@example.com>"; };
  const hits = scanCommit("a".repeat(40), [], git);
  assert.ok(hits.some((h) => h.where.endsWith(":board.private.json") && /private settings file/.test(h.what)));
  assert.ok(!asked.some((a) => a.includes("board.private.json") && a.startsWith("cat-file")), "its text was never read");
});

test("the attack: a changed deploy or tree file with the steps file's hash lines edited to match is REFUSED, because the pasted hash differs; nothing runs", () => {
  for (const f of [DEPLOY_F, TREE_F]) {
    const w = folder({ tamper: { [f]: "// attacker's file\nconsole.log('DEPLOY OK: fake');\n" }, restamp: true });
    // The steps file really does agree with the disk now (the attacker's edit is complete as far as the disk goes).
    const parsed = readSteps(readFileSync(join(w.dir, `board-store-${NAME}-steps.md`), "utf8"), NAME);
    assert.equal(parsed[f === DEPLOY_F ? "deploy" : "tree"], sha256(readFileSync(join(w.dir, f))), "the steps file matches the changed file");
    const r = runBd(w);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, /^CHECK FAILED: /m);
    assert.match(r.stdout, /Nothing was run/);
    assert.ok(!w.ran("deploy.ran") && !w.ran("tree.ran"), `${f}: nothing ran`);
  }
});

test("a steps file that disagrees with the pasted hashes is refused, naming both", () => {
  const w = folder();
  const other = "9".repeat(64);
  const r = runBd(w, [other, w.hashes[1]]);
  assert.equal(r.status, 1);
  assert.ok(r.stdout.includes(w.hashes[0]) && r.stdout.includes(other), "both hashes are named");
  assert.ok(!w.ran("deploy.ran") && !w.ran("tree.ran"));
});

test("the hashes are required: none or one is a usage line, exit 2, nothing runs", () => {
  for (const hashes of [null, [], [sha256("x")]]) {
    const w = folder();
    const r = runBd(w, hashes);
    assert.equal(r.status, 2, JSON.stringify(hashes));
    assert.match(r.stdout, /^usage: node board-deploy\.mjs pc<n> <deploy sha256> <tree sha256>/m);
    assert.ok(!w.ran("deploy.ran") && !w.ran("tree.ran"));
  }
});

test("a malformed hash is refused and nothing runs: short, long, upper case, not hex, with spaces", () => {
  const w = folder();
  const good = w.hashes[0];
  for (const bad of [good.slice(1), good + "0", good.toUpperCase(), "z".repeat(64), `${good.slice(0, 63)} `, "", "-c"]) {
    for (const hashes of [[bad, w.hashes[1]], [w.hashes[0], bad]]) {
      const r = runBd(w, hashes);
      assert.notEqual(r.status, 0, JSON.stringify(hashes));
      assert.ok(/CHECK FAILED|usage:/.test(r.stdout), r.stdout);
      assert.ok(!w.ran("deploy.ran") && !w.ran("tree.ran"));
    }
  }
});

test("the matching case still runs both lines through the pasted line, ending with DEPLOY OK then TREE OK", () => {
  const w = folder();
  const r = runBd(w);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const out = r.stdout.trim().split("\n");
  assert.match(out.at(-2), /^DEPLOY OK: /);
  assert.match(out.at(-1), /^TREE OK: /);
  assert.ok(w.ran("deploy.ran") && w.ran("tree.ran"));
});

test("the generated one-liner carries all three hashes in the right places, and run through sh against a rewritten folder it refuses", () => {
  const w = folder();
  const line = oneLiner(w.steps);
  const [d, t] = w.hashes;
  assert.equal(line, `if [ "$(shasum -a 256 ${w.dir}/board-deploy.mjs | cut -c1-64)" = ${sha256(bd)} ]; then node ${w.dir}/board-deploy.mjs ${NAME} ${d} ${t}; else echo 'CHECK FAILED: board-deploy.mjs is not the signed file. Paste this line to Manager.'; fi`);
  // The pasted line from the real steps file, against a folder an attacker rewrote (file and steps file together).
  const a = folder({ tamper: { [TREE_F]: "// attacker\nconsole.log('TREE OK: fake');\n" }, restamp: true });
  // #C921: the line names its folder, so it is pointed at the rewritten one.
  const stale = line.replaceAll(w.dir, a.dir).replace(new RegExp(`${NAME} [0-9a-f]{64} [0-9a-f]{64};`), `${NAME} ${d} ${t};`);
  const r = sh(a.dir, stale);
  assert.match(r.stdout, /CHECK FAILED/);
  assert.ok(!a.ran("deploy.ran") && !a.ran("tree.ran"));
});

test("copying the script is the only way it travels: it names no secret and no real account", () => {
  const text = bd.toString("utf8");
  assert.ok(!/CLOUDFLARE_API_TOKEN|cloudflareApiToken/.test(text.replace(/^\/\/.*$/gm, "")), "no credential handling in the generic script's code");
  assert.ok(!/process\.env/.test(text), "it reads no environment");
});

// ---------------------------------------------------------------------------------------------------------------- #C928: the rollback form
// The undo with the same token: the deploy file's `rollback` (rollbackRun) and board-deploy.mjs's `rollback pc<n> <deploy sha256>`.
const { rollbackRun } = await import(pathToFileURL(join(gen, "board-store-deploy-pc34.mjs")).href);
const CONFIG = `${DIR}/board-store-pa/worker/wrangler.board.toml`, MARKER = `${DIR}/board-store-deploy-pc34.done`;

// An in-memory folder for rollbackRun: o.checkout false (no deploy checkout), o.marker false (no marker), o.file as in world().
function rworld(o = {}) {
  const file = o.file === undefined ? { mode: 0o600, text: GOOD } : o.file;
  const lines = [], calls = [], removed = [];
  const fs = {
    existsSync: (p) => (p === CONFIG && o.checkout !== false) || (p === MARKER && o.marker !== false),
    lstatSync: (p) => { if (p === FILE && file) return { isFile: () => true, mode: 0o100000 | file.mode }; throw new Error("ENOENT"); },
    readFileSync: (p) => { if (p === FILE && file) return file.text; throw new Error("ENOENT"); },
    unlinkSync: (p) => removed.push(p),
  };
  const spawn = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return typeof o.wr === "function" ? o.wr() : o.wr ?? { status: 0 }; };
  return { go: () => rollbackRun({ here: DIR, spawn, fs, say: (l) => lines.push(l) }), lines, calls, removed };
}

test("rollback with the token: one pinned wrangler rollback on the checkout's config, both variables in its environment, the marker removed, nothing prints the token", () => {
  const w = rworld();
  const r = w.go();
  assert.equal(r.ok, true, r.line);
  assert.equal(w.calls.length, 1, "wrangler rollback and nothing else");
  assert.deepEqual([w.calls[0].cmd, w.calls[0].args], ["npx", ["--yes", "wrangler@4.150.0", "rollback", "--config", CONFIG]]);
  assert.equal(w.calls[0].opts.stdio, "inherit", "wrangler's own confirmation prompt reaches the owner");
  assert.equal(w.calls[0].opts.env.CLOUDFLARE_API_TOKEN, TOKEN);
  assert.equal(w.calls[0].opts.env.CLOUDFLARE_ACCOUNT_ID, ACCOUNT);
  assert.deepEqual(w.removed, [MARKER], "the tree step refuses until line 1 runs again");
  assert.match(w.lines.at(-1), /^ROLLBACK OK: .*tree step refuses until line 1 runs again/);
  assert.ok(!JSON.stringify([w.lines, w.calls.map((c) => [c.cmd, c.args])]).includes(TOKEN), "the token is in no line and no argument");
});

test("rollback with no token file: wrangler's own login, no environment added; a marker that is not there is no failure", () => {
  const w = rworld({ file: null, marker: false });
  const r = w.go();
  assert.equal(r.ok, true, r.line);
  assert.equal(w.calls[0].opts.env, undefined);
  assert.deepEqual(w.removed, []);
  assert.match(w.lines[0], /No token in .*board\.private\.json/);
});

test("rollback that fails says so and keeps the marker: wrangler exits 1, cannot start, or prints the token; no checkout; a settings file others can read", () => {
  const cases = {
    "wrangler exits 1": { wr: { status: 1 } },
    "wrangler cannot start": { wr: { status: null, error: new Error(`cannot start ${TOKEN}`) } },
    "wrangler throws": { wr: () => { throw new Error(`boom ${TOKEN} ${ACCOUNT}`); } },
    "no deploy checkout": { checkout: false },
    "a settings file others can read": { file: { mode: 0o644, text: GOOD } },
  };
  for (const [why, o] of Object.entries(cases)) {
    const w = rworld(o);
    const r = w.go();
    assert.equal(r.ok, false, why);
    assert.match(r.line, /^ROLLBACK FAILED: /, why);
    assert.deepEqual(w.removed, [], `${why}: the marker stays, the Worker was not put back`);
    assert.ok(!JSON.stringify([w.lines, w.calls.map((c) => [c.cmd, c.args])]).includes(TOKEN) && !JSON.stringify(w.lines).includes(ACCOUNT), `${why}: no token and no account id in anything printed`);
    if (o.checkout === false || o.file) assert.equal(w.calls.length, 0, `${why}: wrangler was not run`);
  }
});

test("board-deploy rollback form: checks the deploy file against the pasted hash and the steps file, then runs that file with rollback and nothing else", () => {
  const f = folder();
  const [deploySha] = f.hashes;
  const calls = [], lines = [];
  const spawn = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { status: 0 }; };
  const r = boardRollback({ name: NAME, dir: f.dir, deploySha, spawn, say: (l) => lines.push(l), node: "node" });
  assert.equal(r.ok, true);
  assert.deepEqual(calls.map((c) => [c.cmd, c.args.map((a) => a.split("/").pop())]), [["node", [DEPLOY_F, "rollback"]]]);
  assert.equal(calls[0].opts.stdio, "inherit"); assert.equal(calls[0].opts.env, undefined, "the environment is passed on as it is: the deploy file adds the token");
  // a failing run is reported and returns not ok
  assert.equal(boardRollback({ name: NAME, dir: f.dir, deploySha, spawn: () => ({ status: 1 }), say: (l) => lines.push(l), node: "node" }).code, 1);
  assert.match(lines.at(-1), /rollback did not finish/);
});

test("board-deploy rollback form refuses and runs nothing: usage, a bad hash, a missing or disagreeing steps file, a changed deploy file", () => {
  const f = folder();
  const [deploySha] = f.hashes;
  const say = [], none = () => assert.fail("ran");
  assert.equal(boardRollback({ name: NAME, dir: f.dir, spawn: none, say: (l) => say.push(l) }).code, 2, "no hash");
  assert.equal(boardRollback({ name: "pc34; x", dir: f.dir, deploySha, spawn: none, say: (l) => say.push(l) }).code, 2, "bad name");
  assert.equal(boardRollback({ name: NAME, dir: f.dir, deploySha: deploySha.toUpperCase(), spawn: none, say: (l) => say.push(l) }).code, 2, "upper case hash");
  assert.equal(boardRollback({ name: "pc99", dir: f.dir, deploySha, spawn: none, say: (l) => say.push(l) }).ok, false);
  assert.match(say.at(-1), /CHECK FAILED: board-store-pc99-steps\.md is not in this folder/);
  assert.equal(boardRollback({ name: NAME, dir: f.dir, deploySha: "0".repeat(64), spawn: none, say: (l) => say.push(l) }).ok, false);
  assert.match(say.at(-1), /the steps file names .* but the command line gives/);
  const g = folder({ tamper: { [DEPLOY_F]: "// changed\n" } });
  assert.equal(boardRollback({ name: NAME, dir: g.dir, deploySha: g.hashes[0], spawn: none, say: (l) => say.push(l) }).ok, false);
  assert.match(say.at(-1), /is not the signed file/);
});

test("the steps file gives the undo as a one-command line bound to the deploy hash; run against a changed board-deploy.mjs it refuses", () => {
  const f = folder();
  const undo = f.steps.split("\n").find((l) => l.startsWith("if [ ") && l.includes("board-deploy.mjs rollback "));
  assert.ok(undo, "the undo line is in the steps");
  assert.ok(undo.includes(`board-deploy.mjs rollback ${NAME} ${f.hashes[0]};`), "it carries the deploy file's hash");
  assert.ok(f.steps.includes("npx wrangler@4.150.0 rollback --config"), "the by-hand undo stays");
  assert.equal(oneLiner(f.steps).includes(" rollback "), false, "the deploy one-liner is still first and unchanged");
  const tampered = folder();
  writeFileSync(join(tampered.dir, "board-deploy.mjs"), "// changed\n");
  const r = sh(tampered.dir, undo.replaceAll(f.dir, tampered.dir));
  assert.match(r.stdout, /CHECK FAILED/);
  assert.ok(!tampered.ran("deploy.ran"));
});

test("a real run of the rollback form against a stub deploy file passes `rollback` and opens no browser", () => {
  const stub = `import { writeFileSync } from "node:fs";\nwriteFileSync(new URL("./deploy.ran", import.meta.url), process.argv.slice(2).join(" ") + "\\n");\nconsole.log("ROLLBACK OK: stub");\n`;
  const f = folder({ deployBody: stub });
  const r = spawnSync(process.execPath, [join(f.dir, "board-deploy.mjs"), "rollback", NAME, f.hashes[0]], { cwd: f.dir, encoding: "utf8", env: { PATH: `${bin(f.dir)}:${process.env.PATH}`, SSH_CONNECTION: "10.0.0.2 51234 10.0.0.3 22" } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(readFileSync(join(f.dir, "deploy.ran"), "utf8"), "rollback\n");
  assert.ok(!existsSync(join(f.dir, "browser.opened")));
  assert.match(r.stdout, /ROLLBACK OK: stub/);
  assert.equal(spawnSync(process.execPath, [join(f.dir, "board-deploy.mjs"), "rollback", NAME, "0".repeat(64)], { cwd: f.dir, encoding: "utf8" }).status, 1, "a hash the steps file does not name: refused, exit 1");
});
