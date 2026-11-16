// The mutant runner (#C1115, the owner's pick A on the Director's proposal). A mutation check used to be a builder or a checker disabling a guard by hand and
// running the WHOLE suite once per guard: 30 mutants took 75 minutes, and nothing counted them. This does it in one command, in temp copies:
//   node scripts/mutant-run.mjs --spec mutants.json [--repo <checkout>] [--concurrency 8] [--full-cmd "npm test"] [--out results.json]
// The spec is what the builder lists for each new guard: { "mutants": [{ "id": "M1", "file": "worker/board-rules.mjs", "line": 123, "find": "exact text on
// that line", "replace": "text to put there (omit it to disable the whole line with a comment)", "tests": ["tests/x.test.mjs"] }] }. For each mutant it
//   (1) REFUSES, running nothing, when the edit matches nothing: the line is not there, `find` is not on it, or the result is the same file (a no-op mutant
//       "survives" every suite);
//   (2) applies the edit to a TEMP COPY of the checkout (the checkout is never touched) and runs ONLY the named tests there, 8 mutants at a time, with a
//       private TMPDIR; the mutant must make one of them fail (exit non-zero with at least one test run);
//   (3) re-runs any mutant the named tests did not kill against the FULL suite, and reports it as a SURVIVOR only when the full suite passes too (a mutant the full
//       suite kills was only missing from the builder's list of tests: reported "killed by the full suite only", with the test files that failed).
// Prints one line per mutant and ends with "mutation check: pass" (no survivor and no refusal) or "mutation check: FAIL"; --out writes the same as JSON,
// with the milliseconds each mutant took, so a review's ETA can count mutants at their measured time (worker/board-rules.mjs).
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, existsSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_CONCURRENCY = 8;
const SAFE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._\/-]{1,200}$/;
const TEST_FILE = /^tests\/[A-Za-z0-9._\/-]{1,150}\.test\.mjs$/;

// The spec's shape; returns the list of problems (empty: usable). Paths stay inside the checkout and tests are test files.
export function specErrors(spec) {
  const out = [];
  if (!spec || typeof spec !== "object" || !Array.isArray(spec.mutants) || !spec.mutants.length) return ["the spec is { mutants: [ ... ] } with at least one mutant"];
  if (spec.mutants.length > 200) out.push("at most 200 mutants in one spec");
  const ids = new Set();
  for (const [i, m] of spec.mutants.entries()) {
    const at = `mutant ${i + 1}${typeof m?.id === "string" ? ` (${m.id})` : ""}`;
    if (!m || typeof m !== "object") { out.push(`${at}: not an object`); continue; }
    if (typeof m.id !== "string" || !/^[A-Za-z0-9._-]{1,40}$/.test(m.id)) out.push(`${at}: id is a short plain word`);
    else if (ids.has(m.id)) out.push(`${at}: id used twice`); else ids.add(m.id);
    if (typeof m.file !== "string" || !SAFE_PATH.test(m.file)) out.push(`${at}: file is a path inside the checkout`);
    if (!Number.isInteger(m.line) || m.line < 1) out.push(`${at}: line is the 1-based line number`);
    if (typeof m.find !== "string" || !m.find) out.push(`${at}: find is the exact text on that line`);
    if (m.replace !== undefined && typeof m.replace !== "string") out.push(`${at}: replace is text`);
    if (!Array.isArray(m.tests) || !m.tests.length || !m.tests.every((t) => typeof t === "string" && TEST_FILE.test(t))) out.push(`${at}: tests are the test files that must catch it (tests/<name>.test.mjs)`);
  }
  return out;
}

// The mutated source, or a refusal. With no `replace` the line is disabled: `find` is replaced by an empty statement and the rest of the line commented out.
export function applyMutant(source, m) {
  const lines = String(source).split("\n");
  const line = lines[m.line - 1];
  if (line === undefined) return { refused: `line ${m.line} is past the end of ${m.file} (${lines.length} lines): the edit matches nothing` };
  const at = line.indexOf(m.find);
  if (at < 0) return { refused: `${m.file}:${m.line} does not contain the text to change (${JSON.stringify(m.find.slice(0, 60))}): the edit matches nothing` };
  const indent = /^\s*/.exec(line)[0];
  const next = m.replace === undefined ? `${indent}// MUTANT ${m.id}: ${line.trim()}` : line.slice(0, at) + m.replace + line.slice(at + m.find.length);
  if (next === line) return { refused: `${m.file}:${m.line}: the edit leaves the line as it was (a no-op mutant survives every suite)` };
  lines[m.line - 1] = next;
  return { text: lines.join("\n") };
}

// The checkout as a REAL working tree in a fresh temp folder: a local clone at its HEAD (so a test that reads git history, notes or the branch finds them), then the
// working tree's own changes laid over it (modified and new files copied, deleted ones removed), so the copy is exactly what the builder has on disk. A checkout with
// no commit yet falls back to its files copied without history. node_modules is linked, not copied.
function copyTree(repo, to) {
  const git = (args, cwd = repo) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  let cloned = false;
  try {
    git(["rev-parse", "--verify", "-q", "HEAD"]);
    execFileSync("git", ["clone", "-q", "--local", "--no-hardlinks", repo, to], { stdio: ["ignore", "pipe", "pipe"] });
    try { git(["fetch", "-q", repo, "+refs/notes/*:refs/notes/*"], to); } catch { /* no notes refs */ }
    cloned = true;
  } catch { /* no HEAD, or not cloneable: the plain copy below */ }
  // `diff HEAD` (not `ls-files --modified`, which compares with the INDEX and misses a staged edit or a staged new file) lists every change against HEAD, deletions too.
  const lay = cloned ? git(["diff", "--name-only", "-z", "HEAD"]) + "\0" + git(["ls-files", "-z", "--others", "--exclude-standard"]) : git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
  for (const f of new Set(lay.split("\0").filter(Boolean))) {
    if (!SAFE_PATH.test(f) && /(^|\/)\.\.(\/|$)/.test(f)) continue;
    const src = join(repo, f), dst = join(to, f);
    if (!existsSync(src)) { if (cloned) rmSync(dst, { force: true }); continue; } // deleted in the working tree
    try { mkdirSync(dirname(dst), { recursive: true }); copyFileSync(src, dst); } catch { /* unreadable: skip */ }
  }
  if (existsSync(join(repo, "node_modules"))) try { symlinkSync(join(repo, "node_modules"), join(to, "node_modules")); } catch { /* none */ }
}

// Runs a command in `cwd`; resolves { code, out, ms }. A private TMPDIR keeps a suite's temp files out of the way of the other copies.
function run(cmd, args, cwd, tmp, timeoutMs) {
  return new Promise((done) => {
    const t0 = Date.now();
    // NODE_TEST_CONTEXT is removed, or a run started from inside a node --test file would report nothing and exit 0 (a mutant would "survive").
    const env = { ...process.env, TMPDIR: tmp }; delete env.NODE_TEST_CONTEXT;
    const child = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const keep = (b) => { out += b; if (out.length > 4e6) out = out.slice(-2e6); };
    child.stdout.on("data", keep); child.stderr.on("data", keep);
    const timer = setTimeout(() => { out += "\n[mutant runner: timed out]"; child.kill("SIGKILL"); }, timeoutMs);
    child.on("close", (code) => { clearTimeout(timer); done({ code: code ?? 1, out, ms: Date.now() - t0 }); });
    child.on("error", (e) => { clearTimeout(timer); done({ code: 1, out: String(e), ms: Date.now() - t0 }); });
  });
}
const testsRun = (out) => Number(/^ℹ tests (\d+)/m.exec(out)?.[1] ?? 0);
const failedFiles = (out) => [...new Set([...out.matchAll(/^test at (tests\/[A-Za-z0-9._\/-]+\.test\.mjs)/gm)].map((m) => m[1]))];

// runMutants({ repo, spec, concurrency, fullCmd, timeoutMs, log }) -> { results: [{ id, status, detail, ms }], pass }
// status: killed | killed-by-full-suite-only | survivor | refused | error
export async function runMutants({ repo, spec, concurrency = DEFAULT_CONCURRENCY, fullCmd = ["npm", "test"], timeoutMs = 20 * 60e3, log = () => {} }) {
  const bad = specErrors(spec);
  if (bad.length) return { results: [], pass: false, errors: bad };
  const root = resolve(repo), results = new Map(), work = [];
  // (1) the refusals first, before anything runs
  for (const m of spec.mutants) {
    let source = null;
    try { source = readFileSync(join(root, m.file), "utf8"); } catch { /* none */ }
    if (source === null) { results.set(m.id, { id: m.id, status: "refused", detail: `${m.file} is not in the checkout`, ms: 0 }); continue; }
    const made = applyMutant(source, m);
    if (made.refused) results.set(m.id, { id: m.id, status: "refused", detail: made.refused, ms: 0 });
    else work.push({ m, text: made.text });
  }
  if (results.size) { for (const r of results.values()) log(r); return { results: spec.mutants.map((m) => results.get(m.id) ?? { id: m.id, status: "not run", detail: "another mutant was refused: nothing ran", ms: 0 }), pass: false }; }
  // (2) the named tests, `concurrency` at a time, each worker with its own copy of the checkout
  const base = mkdtempSync(join(tmpdir(), "mutant-run-"));
  const survivors = [];
  try {
    // The baseline: every named test file, once, in an unmutated copy. If they do not all pass there (or none runs), a "kill" would only be that failure showing again,
    // so nothing is judged: every mutant is an error naming what failed.
    const named = [...new Set(work.flatMap(({ m }) => m.tests))];
    const b0 = join(base, "baseline"), t0 = join(base, "tmp-baseline");
    mkdirSync(b0); mkdirSync(t0); copyTree(root, b0);
    const r0 = await run(process.execPath, ["--test", ...named], b0, t0, timeoutMs);
    if (testsRun(r0.out) === 0 || r0.code !== 0) {
      const why = testsRun(r0.out) === 0 ? `no test ran (${named.join(", ")})` : `they fail in the unmutated copy: ${failedFiles(r0.out).join(", ") || "(see the suite's output)"}`;
      const list = spec.mutants.map((m) => ({ id: m.id, status: "error", detail: `the named tests do not pass before any mutation, so nothing can be judged: ${why}`, ms: 0 }));
      for (const r of list) log(r);
      return { results: list, pass: false };
    }
    const n = Math.max(1, Math.min(concurrency, work.length));
    const slots = Array.from({ length: n }, (_, i) => { const dir = join(base, `copy-${i}`); mkdirSync(dir); copyTree(root, dir); mkdirSync(join(base, `tmp-${i}`)); return { dir, tmp: join(base, `tmp-${i}`) }; });
    let next = 0;
    await Promise.all(slots.map(async (slot) => {
      while (next < work.length) {
        const { m, text } = work[next++];
        const target = join(slot.dir, m.file), original = readFileSync(target, "utf8");
        writeFileSync(target, text);
        const r = await run(process.execPath, ["--test", ...m.tests], slot.dir, slot.tmp, timeoutMs);
        writeFileSync(target, original);
        let res;
        // (the baseline above has shown the named tests run and pass, so a failure here is the mutant's, a crash on load included)
        if (r.code !== 0) res = { id: m.id, status: "killed", detail: `failed: ${failedFiles(r.out).join(", ") || m.tests.join(", ")}`, ms: r.ms };
        else { res = { id: m.id, status: "survivor?", detail: "the named tests passed with it", ms: r.ms }; survivors.push({ m, text }); }
        results.set(m.id, res);
        if (res.status !== "survivor?") log(res);
      }
    }));
    // (3) every mutant the named tests missed meets the full suite before it is reported
    // The copy is a clone, but a test that depends on the builder's own git state (branch, remotes, hooks) can still fail there with or without a mutant: the unmutated copy runs the full suite first (once, and only
    // when there is a survivor), and a mutant counts as killed only by a test file that passes in that baseline and fails with it.
    let baseline = null;
    const fresh = (name) => { const dir = join(base, name), tmp = join(base, `tmp-${name}`); rmSync(dir, { recursive: true, force: true }); mkdirSync(dir); mkdirSync(tmp, { recursive: true }); copyTree(root, dir); return { dir, tmp }; };
    for (const { m, text } of survivors) {
      if (baseline === null) { const b = fresh("full-base"); const r0 = await run(fullCmd[0], fullCmd.slice(1), b.dir, b.tmp, timeoutMs); baseline = { code: r0.code, files: new Set(failedFiles(r0.out)) }; }
      const { dir, tmp } = fresh("full");
      writeFileSync(join(dir, m.file), text);
      const r = await run(fullCmd[0], fullCmd.slice(1), dir, tmp, timeoutMs);
      const t = results.get(m.id);
      const ms = t.ms + r.ms;
      const now = failedFiles(r.out), fresh1 = now.filter((f) => !baseline.files.has(f));
      // killed there: a test file that passed in the baseline fails now; with a clean baseline any failure counts, parsed or not
      const killed = r.code !== 0 && testsRun(r.out) > 0 && (baseline.code === 0 || fresh1.length > 0);
      const res = killed
        ? { id: m.id, status: "killed-by-full-suite-only", detail: `the named tests missed it; the full suite failed in: ${fresh1.join(", ") || "(see the suite's output)"}: add one of these to its tests`, ms }
        : { id: m.id, status: "survivor", detail: baseline.code === 0 ? "the named tests and the full suite both pass with it" : `the named tests pass with it, and the full suite fails in nothing it did not already fail in without it (${baseline.files.size} files fail in the unmutated copy)`, ms };
      results.set(m.id, res); log(res);
    }
  } finally { rmSync(base, { recursive: true, force: true }); }
  const list = spec.mutants.map((m) => results.get(m.id));
  return { results: list, pass: list.every((r) => r.status === "killed" || r.status === "killed-by-full-suite-only") };
}

// The summary lines: one per mutant, the median time per mutant, and the verdict.
export function summary(results, pass) {
  const lines = results.map((r) => `${r.status.toUpperCase().padEnd(26)} ${r.id}: ${r.detail}${r.ms ? ` (${(r.ms / 1000).toFixed(1)} s)` : ""}`);
  const ms = results.map((r) => r.ms).filter((x) => x > 0).sort((a, b) => a - b);
  if (ms.length) lines.push(`${results.length} mutants, median ${(ms[Math.floor(ms.length / 2)] / 1000).toFixed(1)} s each`);
  const only = results.filter((r) => r.status === "killed-by-full-suite-only").length;
  lines.push(pass ? `mutation check: pass${only ? ` (${only} killed only by the full suite: fix their test lists)` : ""}` : "mutation check: FAIL");
  return lines;
}

function arg(argv, name, dflt) { const i = argv.indexOf(name); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : dflt; }
async function main(argv) {
  const specPath = arg(argv, "--spec");
  if (!specPath) { console.error("usage: node scripts/mutant-run.mjs --spec mutants.json [--repo <checkout>] [--concurrency 8] [--full-cmd \"npm test\"] [--out results.json]"); return 2; }
  let spec; try { spec = JSON.parse(readFileSync(specPath, "utf8")); } catch (e) { console.error(`cannot read the spec: ${e.message}`); return 2; }
  const concurrency = Number(arg(argv, "--concurrency", DEFAULT_CONCURRENCY));
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) { console.error("--concurrency is 1 to 32"); return 2; }
  const fullCmd = String(arg(argv, "--full-cmd", "npm test")).trim().split(/\s+/);
  const r = await runMutants({ repo: arg(argv, "--repo", process.cwd()), spec, concurrency, fullCmd, log: (x) => console.error(`... ${x.status} ${x.id}`) }); // progress on stderr; the summary below is the answer
  if (r.errors) { for (const e of r.errors) console.error(e); return 2; }
  for (const l of summary(r.results, r.pass)) console.log(l);
  const out = arg(argv, "--out");
  if (out) writeFileSync(out, JSON.stringify({ at: Date.now(), pass: r.pass, results: r.results }, null, 1));
  return r.pass ? 0 : 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).then((c) => process.exit(c));
