// #C889: make-pair compares with the last pair that RAN (it has its .done marker), says the new pair replaces each pair nobody ran, and writes
// the hooks step when a hook file changed since then. Real git: a bare origin and a clone.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { makeAll, lastPair, neverRun, HOOK_ENTRIES, HOOK_READS } from "../scripts/make-pair.mjs";

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "fb-pair-ran-"));
  const bare = join(dir, "origin.git"), work = join(dir, "work"), out = join(dir, "out");
  mkdirSync(out);
  const g = (...a) => execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=T", "-c", "commit.gpgsign=false", ...a], { cwd: work, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  g("remote", "add", "origin", bare);
  const commit = (subject, files) => { for (const [f, t] of Object.entries(files)) { mkdirSync(join(work, f, ".."), { recursive: true }); writeFileSync(join(work, f), t); } g("add", "-A"); g("commit", "-qm", subject); const sha = g("rev-parse", "HEAD"); g("push", "-q", "origin", "main"); return sha; };
  const ran = (n) => writeFileSync(join(out, `board-store-deploy-pc${n}.done`), /const SIGNED = "([0-9a-f]{40})"/.exec(readFileSync(join(out, `board-store-deploy-pc${n}.mjs`), "utf8"))[1] + "\n");
  return { g, work, out, commit, ran };
}
const sha256 = (t) => createHash("sha256").update(t).digest("hex");

test("the last pair is the highest one with a .done marker, and the never-run pairs after it are named", () => {
  const { work, out, commit, ran } = repo();
  const a = commit("first (#C100)", { "worker/a.mjs": "1\n" });
  assert.equal(makeAll({ repo: work, sha: a, n: 1, out }).ok, true);
  ran(1);
  const b = commit("second (#C101)", { "worker/a.mjs": "2\n" });
  assert.equal(makeAll({ repo: work, sha: b, n: 2, out }).ok, true);
  const c = commit("third (#C102)", { "worker/a.mjs": "3\n" });
  assert.equal(makeAll({ repo: work, sha: c, n: 3, out }).ok, true);
  assert.deepEqual(lastPair(out, 4), { n: 1, sha: a }, "pc2 and pc3 never ran: pc1 is the last pair");
  assert.deepEqual(neverRun(out, 4), [{ n: 3, sha: c }, { n: 2, sha: b }]);
  assert.deepEqual(neverRun(out, 2), [], "nothing between pc1 and pc2");
  ran(3);
  assert.deepEqual(lastPair(out, 4), { n: 3, sha: c });
  assert.deepEqual(neverRun(out, 4), []);
});

test("a pair that follows a never-run pair lists everything since the last one that ran and says it replaces it", () => {
  const { work, out, commit, ran } = repo();
  const a = commit("first (#C100)", { "f": "1\n" });
  assert.equal(makeAll({ repo: work, sha: a, n: 1, out }).ok, true);
  ran(1);
  const b = commit("a migration (#C200)", { "worker/migrations/0030_x.sql": "select 1;\n" });
  assert.equal(makeAll({ repo: work, sha: b, n: 2, out }).ok, true);
  const c = commit("docs only (#C201)", { "docs/x.md": "d\n" });
  const r = makeAll({ repo: work, sha: c, n: 3, out });
  assert.equal(r.ok, true, r.why);
  const steps = readFileSync(join(out, "board-store-pc3-steps.md"), "utf8");
  assert.match(steps, /pc3 REPLACES pc2 \(never run/);
  assert.match(steps, /do not run it/);
  assert.match(steps, new RegExp(`Changed since ${a.slice(0, 8)} \\(pc1, the last pair that ran\\):`));
  assert.match(steps, /- a migration \(#C200\)/, "pc2's commit is listed again");
  assert.match(steps, /- docs only \(#C201\)/);
  assert.match(steps, /A database migration is part of this deploy: answer y/, "pc2's migration is still to go out");
  assert.match(steps, /deploy it first \(line 1\)/, "pc2's Worker change is still to go out");
  assert.doesNotMatch(steps, /No Worker code changes/);
});

test("with every earlier pair run, the steps do not mention a replaced pair", () => {
  const { work, out, commit, ran } = repo();
  const a = commit("first (#C100)", { "f": "1\n" });
  assert.equal(makeAll({ repo: work, sha: a, n: 1, out }).ok, true);
  ran(1);
  const b = commit("docs (#C101)", { "docs/x.md": "d\n" });
  assert.equal(makeAll({ repo: work, sha: b, n: 2, out }).ok, true);
  const steps = readFileSync(join(out, "board-store-pc2-steps.md"), "utf8");
  assert.doesNotMatch(steps, /REPLACES/);
  assert.match(steps, new RegExp(`Changed since ${a.slice(0, 8)} \\(pc1\\):`));
  assert.match(steps, /Two lines, in this order/);
});

test("no hook file changed: no hooks file and no third line", () => {
  const { work, out, commit, ran } = repo();
  const a = commit("first (#C100)", { "gate/stop.mjs": "1\n" });
  assert.equal(makeAll({ repo: work, sha: a, n: 1, out }).ok, true);
  ran(1);
  const b = commit("probe (#C101)", { "collector/p.mjs": "1\n", "gate/reset.mjs": "1\n" });
  assert.equal(makeAll({ repo: work, sha: b, n: 2, out }).ok, true);
  assert.deepEqual(readdirSync(out).filter((f) => f.includes("hooks")), []);
  const steps = readFileSync(join(out, "board-store-pc2-steps.md"), "utf8");
  assert.doesNotMatch(steps, /Line 3/);
  assert.match(steps, /Two lines, in this order/);
});


const CUE_OLD = "c".repeat(64);
const HOOKS_OLD = (sha) => `// The hooks step of pair pc7 (old comment that says hook files unchanged), for flight-board main ${sha}. Run by the owner in Terminal AFTER the pair's two lines\n// (deploy, then tree): \`node board-store-hooks-pc7.mjs\`. Pin ${sha.slice(0, 8)} and ${sha.slice(0, 7)}. Not pc70.\nconst SIGNED = "${sha}";\nconst CUE_SHA = "${CUE_OLD}";\nconst backup = "settings.json.before-pc7";\n`;
// A repo whose two gate entries import tools.mjs, which imports a collector file (two levels down), as the real ones do.
const GATE = { "gate/stop.mjs": 'import { c } from "./tools.mjs";\nexport const s = c;\n', "gate/publish.mjs": 'import { c } from "./tools.mjs";\n', "gate/tools.mjs": 'import { d } from "../collector/fence.mjs";\nexport const c = d;\n', "collector/fence.mjs": "export const d = 1;\n", "gate/reset.mjs": "export const r = 1;\n", "hooks/send-refused-cue.py": "cue one\n", "scripts/wake-watch.mjs": "export const w = 1;\n", "gate/wake.mjs": "export const w = 1;\n", "gate/commit.mjs": "export const k = 1;\n", "page/board.template.html": "<p>1</p>\n" };
function gateRepo(n0 = 1) {
  const r = repo();
  const a = r.commit("first (#C100)", GATE);
  assert.equal(makeAll({ repo: r.work, sha: a, n: n0, out: r.out }).ok, true);
  r.ran(n0);
  writeFileSync(join(r.out, "board-store-hooks-pc7.mjs"), HOOKS_OLD("1".repeat(40)));
  return { ...r, a };
}

test("a gate/stop.mjs change writes the hooks file from the last one, moves the pin, the cue hash and the pair number, and adds line 3", () => {
  const { work, out, commit } = gateRepo();
  const b = commit("the stop hook (#C101)", { "gate/stop.mjs": 'import { c } from "./tools.mjs";\nexport const s = c + 1;\n', "hooks/send-refused-cue.py": "cue two\n" });
  const r = makeAll({ repo: work, sha: b, n: 8, out });
  assert.equal(r.ok, true, r.why);
  const hooks = readFileSync(join(out, "board-store-hooks-pc8.mjs"), "utf8");
  assert.match(hooks, new RegExp(`^// The hooks step of pair pc8 .* for flight-board main ${b}\\.`));
  assert.ok(!hooks.includes("old comment"), "the first comment line is made fresh");
  assert.ok(hooks.includes(`const SIGNED = "${b}";`));
  assert.ok(hooks.includes(`const CUE_SHA = "${sha256("cue two\n")}";`), "the cue hash is the new cue's, not the old one");
  assert.ok(!hooks.includes(CUE_OLD));
  assert.ok(hooks.includes("node board-store-hooks-pc8.mjs") && hooks.includes("settings.json.before-pc8"));
  const rest = hooks.split("\n").slice(1).join("\n");
  assert.ok(!rest.includes("pc7.mjs") && !rest.includes("before-pc7"), "no old pair number is left past the first line");
  assert.ok(rest.includes("Not pc70."), "pc7 is replaced only as a whole number: pc70 is not touched");
  assert.ok(!hooks.includes("1".repeat(7)), "no trace of the old pin");
  const h = sha256(hooks);
  assert.equal(r.files["board-store-hooks-pc8.mjs"], h);
  const steps = readFileSync(join(out, "board-store-pc8-steps.md"), "utf8");
  assert.match(steps, /Three lines \(the third installs the hooks/);
  assert.match(steps, /## Line 3: hooks/);
  assert.ok(steps.includes(`shasum -a 256 board-store-hooks-pc8.mjs | cut -c1-64)" = ${h} ]; then node board-store-hooks-pc8.mjs;`));
  assert.match(steps, /Hook files changed since .*: gate\/stop\.mjs, hooks\/send-refused-cue\.py/);
  assert.match(steps, new RegExp(`hooks ${h}\\.`));
});

test("a change to a file the gate scripts import counts, one level down (gate/tools.mjs) and two levels down (collector/fence.mjs)", () => {
  for (const [file, text] of [["gate/tools.mjs", 'import { d } from "../collector/fence.mjs";\nexport const c = d + 1;\n'], ["collector/fence.mjs", "export const d = 2;\n"]]) {
    const { work, out, commit } = gateRepo();
    const b = commit(`change ${file} (#C101)`, { [file]: text });
    const r = makeAll({ repo: work, sha: b, n: 8, out });
    assert.equal(r.ok, true, `${file}: ${r.why}`);
    assert.ok(readdirSync(out).includes("board-store-hooks-pc8.mjs"), `${file}: the hooks file is written`);
    assert.match(readFileSync(join(out, "board-store-pc8-steps.md"), "utf8"), new RegExp(`Hook files changed since .*: ${file.replace(".", "\\.")}`));
  }
});

test("a file the gate scripts do not import, and a hook-free change, write no hooks file", () => {
  const { work, out, commit } = gateRepo();
  const b = commit("reset and a doc (#C101)", { "gate/reset.mjs": "export const r = 2;\n", "docs/x.md": "d\n" });
  assert.equal(makeAll({ repo: work, sha: b, n: 8, out }).ok, true);
  assert.deepEqual(readdirSync(out).filter((f) => f.includes("hooks-pc8")), []);
});

test("a hooks/ file or the installer counts too; with no earlier hooks file nothing is written and the reason is given", () => {
  for (const file of ["hooks/send-refused-cue.py", "scripts/hooks.mjs"]) {
    const { work, out, commit } = gateRepo();
    const b = commit(`change ${file} (#C101)`, { [file]: "changed\n" });
    rmSync(join(out, "board-store-hooks-pc7.mjs"));
    const before = readdirSync(out).sort();
    const r = makeAll({ repo: work, sha: b, n: 8, out });
    assert.equal(r.ok, false, file);
    assert.match(r.why, /no earlier board-store-hooks-pc<n>\.mjs/);
    assert.deepEqual(readdirSync(out).sort(), before, "nothing written");
    writeFileSync(join(out, "board-store-hooks-pc7.mjs"), HOOKS_OLD("2".repeat(40)));
    assert.equal(makeAll({ repo: work, sha: b, n: 8, out }).ok, true, file);
    assert.ok(readdirSync(out).includes("board-store-hooks-pc8.mjs"));
  }
});

test("a .done file that does not hold the pair's signed sha is not a run", () => {
  const { work, out, commit } = repo();
  const a = commit("first (#C100)", { "f": "1\n" });
  assert.equal(makeAll({ repo: work, sha: a, n: 1, out }).ok, true);
  writeFileSync(join(out, "board-store-deploy-pc1.done"), a + "\n");
  const b = commit("second (#C101)", { "f": "2\n" });
  assert.equal(makeAll({ repo: work, sha: b, n: 2, out }).ok, true);
  for (const body of ["", "done\n", "f".repeat(40) + "\n"]) {
    writeFileSync(join(out, "board-store-deploy-pc2.done"), body);
    assert.deepEqual(lastPair(out, 3), { n: 1, sha: a }, `pc2's marker holds ${JSON.stringify(body)}: pc1 is still the last pair that ran`);
    assert.deepEqual(neverRun(out, 3), [{ n: 2, sha: b }]);
  }
  writeFileSync(join(out, "board-store-deploy-pc2.done"), b + "\n");
  assert.deepEqual(lastPair(out, 3), { n: 2, sha: b });
});

test("the entries are what scripts/hooks.mjs writes, the wake-watch script the gate hands every agent, and the run-time read of the page template (Security R1b)", () => {
  const hooks = readFileSync(new URL("../scripts/hooks.mjs", import.meta.url), "utf8");
  const written = [...hooks.matchAll(/cmd\("([^"]+)"(?:\s*,\s*"([^"]+)")?/g)].map((m) => `${m[2] ?? "gate"}/${m[1]}`);
  assert.ok(written.length >= 6, `found the cmd() entries (${written.join(", ")})`);
  for (const f of written) assert.ok(HOOK_ENTRIES.includes(f), `${f} is written into settings.json by scripts/hooks.mjs and must be an entry`);
  assert.ok(HOOK_ENTRIES.includes("scripts/wake-watch.mjs") && HOOK_ENTRIES.includes("collector/fence.mjs"));
  assert.deepEqual(HOOK_READS, ["page/board.template.html"]);
});

test("a change to scripts/wake-watch.mjs, to the fence, or to the page template the pinned scripts read gives a hooks line", () => {
  for (const [file, text] of [["scripts/wake-watch.mjs", 'import { w } from "../gate/wake.mjs";\nexport const x = w + 1;\n'], ["collector/fence.mjs", "export const d = 3;\n"], ["page/board.template.html", "<p>2</p>\n"], ["gate/commit.mjs", "export const k = 2;\n"]]) {
    const { work, out, commit } = gateRepo();
    const b = commit(`change ${file} (#C101)`, { [file]: text });
    const r = makeAll({ repo: work, sha: b, n: 8, out });
    assert.equal(r.ok, true, `${file}: ${r.why}`);
    assert.ok(readdirSync(out).includes("board-store-hooks-pc8.mjs"), `${file}: the hooks file is written`);
  }
});
