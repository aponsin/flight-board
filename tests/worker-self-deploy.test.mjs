// #C968 (the owner chose B on #T1837 and accepted change 4 on #T1779): the board Worker deploys itself from a signed main, in Cloudflare's own Git build.
// scripts/self-deploy-gate.mjs decides (main's tip, Security's SECURE and Checker's PASS on the exact commit, forward of the Worker's BUILD_SHA);
// scripts/self-deploy-run.mjs deploys only behind the gate's marker; the Worker's push tells the owner's phone (tests/owner-phone-push.test.mjs).
// Must still refuse: an unsigned or non-tip commit, a commit behind the Worker, a BUILD_SHA it cannot read, a deploy with no marker, a token in any line.
// Must still allow: a signed main tip ahead of the Worker (deploys), and the same commit twice (nothing to do, exit 0).
import test from "node:test";
import assert from "node:assert/strict";
import { gateVerdict, currentBuildSha, scriptName, skipsInstall, lineBase, gatherFacts } from "../scripts/self-deploy-gate.mjs";
import { selfDeployRun, redact, WRANGLER } from "../scripts/self-deploy-run.mjs";

const A = "a".repeat(40), B = "b".repeat(40), C = "c".repeat(40);
const ok = { security: "SECURE #C968: reviewed\nmore", checker: "PASS Full at aaaa" };
const facts = (over = {}) => ({ commit: A, tip: A, notes: ok, current: B, descends: true, skipInstall: true, range: [], ...over });

test("a signed main tip ahead of the Worker passes; the same commit as the Worker is nothing to deploy", () => {
  assert.deepEqual(gateVerdict(facts()), { ok: true, same: false, refusals: [] });
  const same = gateVerdict(facts({ current: A, descends: true }));
  assert.equal(same.ok, true); assert.equal(same.same, true);
});

test("must still refuse: a commit that is not main's tip, or whose tip is unreadable", () => {
  assert.match(gateVerdict(facts({ tip: C })).refusals[0], /not main's tip/);
  assert.match(gateVerdict(facts({ tip: null })).refusals[0], /tip could not be read/);
  assert.equal(gateVerdict(facts({ tip: "main" })).ok, false);
});

test("must still refuse: no SECURE or no PASS on the commit, a STOP or FINDINGS, a note whose first line only mentions the word", () => {
  for (const notes of [{ checker: ok.checker, security: null }, { checker: null, security: ok.security }, { checker: "STOP: withdrawn", security: ok.security },
    { checker: ok.checker, security: "FINDINGS: F1" }, { checker: ok.checker, security: "not SECURE" }, { checker: "PASSED", security: ok.security }, { checker: "\nPASS", security: ok.security }, {}]) {
    const v = gateVerdict(facts({ notes }));
    assert.equal(v.ok, false, JSON.stringify(notes));
  }
  assert.match(gateVerdict(facts({ notes: { checker: ok.checker, security: null } })).refusals.join(), /no SECURE/);
  assert.match(gateVerdict(facts({ notes: { checker: "STOP", security: ok.security } })).refusals.join(), /no PASS/);
});

test("must still refuse: a commit not ahead of the Worker (forward only), and a BUILD_SHA that cannot be read or is not a full sha", () => {
  assert.match(gateVerdict(facts({ descends: false })).refusals[0], /does not descend from the Worker's current BUILD_SHA bbbbbbbbbbbb: forward only/);
  for (const current of [null, undefined, "", "bbbb", "B".repeat(40), "unknown"]) {
    const v = gateVerdict(facts({ current, descends: false }));
    assert.equal(v.ok, false, String(current));
    assert.match(v.refusals.join(), /current BUILD_SHA could not be read/);
  }
});

test("must still refuse (Security F1): a build that installs dependencies before the gate; only SKIP_DEPENDENCY_INSTALL=1 or true passes", () => {
  for (const v of [undefined, "", "0", "false", "no", "yes", "2"]) assert.equal(skipsInstall(v), false, String(v));
  for (const v of ["1", "true", "TRUE", " 1 "]) assert.equal(skipsInstall(v), true, String(v));
  const r = gateVerdict(facts({ skipInstall: false }));
  assert.equal(r.ok, false);
  assert.match(r.refusals.join(), /SKIP_DEPENDENCY_INSTALL=1/);
  assert.equal(gateVerdict(facts({ skipInstall: undefined })).ok, false, "no reading is a refusal: the default fails closed");
});

test("must still refuse (Security F2): every commit since the Worker's BUILD_SHA needs SECURE and PASS, not only the tip, unless the tip's line sign covers it", () => {
  const s = (n) => String(n).repeat(40).slice(0, 40), signed = (sha, covered = false) => ({ sha, covered, notes: ok });
  assert.equal(gateVerdict(facts({ range: [signed(s(1)), signed(A)] })).ok, true, "all signed");
  for (const bad of [{ security: null, checker: ok.checker }, { security: ok.security, checker: null }, { security: "STOP", checker: ok.checker }, { security: ok.security, checker: "FINDINGS" }, {}]) {
    const v = gateVerdict(facts({ range: [{ sha: s(1), covered: false, notes: bad }, signed(A)] }));
    assert.equal(v.ok, false, JSON.stringify(bad));
    assert.match(v.refusals.join(), /a commit since the Worker's BUILD_SHA has no SECURE and PASS: 111111111111/);
  }
  assert.equal(gateVerdict(facts({ range: [{ sha: s(1), covered: true, notes: {} }, signed(A)] })).ok, true, "covered by the tip's line sign");
  const many = gateVerdict(facts({ range: [1, 2, 3, 4, 5].map((n) => ({ sha: s(n), covered: false, notes: {} })) }));
  assert.match(many.refusals.join(), /5 commits since the Worker's BUILD_SHA have no SECURE and PASS: 111111111111, 222222222222, 333333333333, \.\.\./);
  const base = "e".repeat(40);
  // Checker 2 F1 on 5c31dbc: a line sign is read as the release tool writes it ("PASS ... line from <sha>"), on the first line, from signed notes only.
  assert.equal(lineBase({ checker: `PASS Full, line from ${base}`, security: `SECURE line from ${base}` }), base, "as the release tool writes it");
  assert.equal(lineBase({ checker: `PASS line from ${base}\nmore`, security: `SECURE line from ${base}` }), base);
  assert.equal(lineBase({ checker: `PASS\nline from ${base}`, security: `SECURE line from ${base}` }), null, "the first line only, never later text");
  assert.equal(lineBase({ checker: `FINDINGS line from ${base}`, security: `SECURE line from ${base}` }), null, "a note that is not a PASS signs nothing");
  assert.equal(lineBase({ checker: `PASS line from ${base}`, security: `STOP line from ${base}` }), null);
  assert.equal(lineBase({ checker: `PASS line from ${base}`, security: `SECURE line from ${"f".repeat(40)}` }), null, "two different bases cover nothing");
  assert.equal(lineBase({ checker: `PASS line from ${base}`, security: "SECURE" }), null, "one note saying it is not both");
  assert.equal(lineBase({ checker: `PASS line from ${base}x`, security: `SECURE line from ${base}x` }), null, "a sha is 40 hex and ends there");
  assert.equal(lineBase({ checker: "PASS", security: "SECURE" }), null);
  assert.equal(lineBase({}), null);
});

test("the gate's own source holds the shallow clone fix, the install check and the range read (the CLI half is not run here)", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../scripts/self-deploy-gate.mjs", import.meta.url), "utf8");
  assert.match(src, /--is-shallow-repository/);
  assert.match(src, /"fetch", "-q", "--unshallow", "origin"/);
  assert.ok(src.indexOf("--unshallow") < src.indexOf('"merge-base", "--is-ancestor", current, commit'), "deepened before the ancestor check");
  assert.match(src, /skipInstall: skipsInstall\(process\.env\.SKIP_DEPENDENCY_INSTALL\)/);
  assert.match(src, /rev-list", `\$\{current\}\.\.\$\{commit\}`/);
  // Checker 2 F2: the facts gathered reach the verdict (a range dropped on the way let an unsigned commit under a signed tip deploy).
  assert.match(src, /const \{ notes, range \} = gatherFacts\(\{ commit, current, descends, quiet \}\)/);
  assert.match(src, /gateVerdict\(\{ commit, tip, notes, current, descends, skipInstall: skipsInstall\(process\.env\.SKIP_DEPENDENCY_INSTALL\), range \}\)/);
});

// Checker 2 F1 and F2 on 5c31dbc: the facts read from a real repository with notes, in the shape of #C976 (027616a: FINDINGS, no PASS; 111e326 on top
// signed "line from <base>"), through gatherFacts and gateVerdict as the CLI wires them.
async function history() {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const dir = mkdtempSync(join(tmpdir(), "gate-hist-"));
  const git = (...a) => execFileSync("git", a, { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
  git("init", "-q", "-b", "main");
  const shas = [];
  for (const n of [0, 1, 2, 3]) { git("commit", "-q", "--allow-empty", "-m", `c${n}`); shas.push(git("rev-parse", "HEAD")); }
  const note = (who, sha, text) => git("notes", `--ref=${who}`, "add", "-f", "-m", text, sha);
  const quiet = (a) => { try { return execFileSync("git", a, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); } catch { return null; } };
  const verdict = (commit, current) => {
    const descends = quiet(["merge-base", "--is-ancestor", current, commit]) !== null;
    const { notes, range } = gatherFacts({ commit, current, descends, quiet });
    return { v: gateVerdict({ commit, tip: commit, notes, current, descends, skipInstall: true, range }), range };
  };
  return { shas, note, verdict, git, done: () => rmSync(dir, { recursive: true, force: true }) };
}
const both = (h, sha, extra = "") => { h.note("checker", sha, `PASS Full${extra}`); h.note("security", sha, `SECURE${extra}`); };

test("history (F1): a fixing tip signed 'line from <base>' covers the unsigned commit landed under it; every commit of the range is read, not only the tip", async () => {
  const h = await history();
  try {
    const [c0, c1, c2, c3] = h.shas;
    h.note("checker", c1, "FINDINGS Full: F1 ..."); // 027616a: findings, fixed by the next commit
    both(h, c2, ` line from ${c0}`); // 111e326: signed on the line from the base
    both(h, c3, ` line from ${c0}`);
    const r = h.verdict(c3, c0);
    assert.deepEqual(r.range.map((x) => [x.sha, x.covered]), [[c3, true], [c2, true], [c1, true]]);
    assert.equal(r.v.ok, true, r.v.refusals.join());
    // The tip alone signed (no line sign): the FINDINGS commit under it still refuses, as before.
    const bare = await history();
    try {
      const [b0, b1, b2, b3] = bare.shas;
      bare.note("checker", b1, "FINDINGS Full: F1 ...");
      both(bare, b2); both(bare, b3);
      const v = bare.verdict(b3, b0).v;
      assert.equal(v.ok, false);
      assert.match(v.refusals.join(), new RegExp(`no SECURE and PASS: ${b1.slice(0, 12)}`));
    } finally { bare.done(); }
  } finally { h.done(); }
});

test("history (F2): an unsigned commit in the middle of the range under a signed tip refuses; the range reaches the verdict", async () => {
  const h = await history();
  try {
    const [c0, c1, c2, c3] = h.shas;
    both(h, c1); both(h, c3); // c2 has no notes at all
    const r = h.verdict(c3, c0);
    assert.deepEqual(r.range.map((x) => x.sha), [c3, c2, c1], "every commit between the Worker's BUILD_SHA and the tip");
    assert.equal(r.v.ok, false);
    assert.match(r.v.refusals.join(), new RegExp(`a commit since the Worker's BUILD_SHA has no SECURE and PASS: ${c2.slice(0, 12)}`));
    both(h, c2);
    assert.equal(h.verdict(c3, c0).v.ok, true, "signed on its own: it goes");
  } finally { h.done(); }
});

test("history: a line sign covers nothing it should not: a base before the Worker's BUILD_SHA, two different bases, a withdrawn note, or a base off the line", async () => {
  const h = await history();
  try {
    const [c0, c1, c2, c3] = h.shas;
    // Worker is at c1; the tip claims a line from c0, which is before what is deployed: it covers nothing of the range (c2 has no notes).
    both(h, c3, ` line from ${c0}`);
    assert.equal(h.verdict(c3, c1).v.ok, false, "a base older than the deployed BUILD_SHA");
    // The base is at the deployed commit: it covers c2.
    both(h, c3, ` line from ${c1}`);
    assert.equal(h.verdict(c3, c1).v.ok, true);
    // Two different bases.
    h.note("checker", c3, `PASS line from ${c1}`); h.note("security", c3, `SECURE line from ${c0}`);
    assert.equal(h.verdict(c3, c1).v.ok, false);
    // A STOP on the signing commit.
    h.note("checker", c3, `STOP line from ${c1}`); h.note("security", c3, `SECURE line from ${c1}`);
    assert.equal(h.verdict(c3, c1).v.ok, false);
    // A base that is not an ancestor of the signing commit.
    both(h, c3, ` line from ${"9".repeat(40)}`);
    assert.equal(h.verdict(c3, c1).v.ok, false);
  } finally { h.done(); }
});

// Checker 2 on 1100168: three guards of the F1 fix that survived their mutants.
test("history (a): the real shape of #C976: c1 FINDINGS, c2 signed 'line from c0', c3 plain PASS and SECURE with no line sign: ok, c1 covered by c2's sign, not the tip's", async () => {
  const h = await history();
  try {
    const [c0, c1, c2, c3] = h.shas;
    h.note("checker", c1, "FINDINGS Full: F1 ...");
    both(h, c2, ` line from ${c0}`);
    both(h, c3); // the tip carries no line sign of its own
    const r = h.verdict(c3, c0);
    assert.deepEqual(r.range.map((x) => [x.sha, x.covered]), [[c3, false], [c2, true], [c1, true]]);
    assert.equal(r.v.ok, true, r.v.refusals.join());
  } finally { h.done(); }
});

test("history (b): a line sign covers only the commits under its signer, never above it: c1 signed, c2 'line from c0', c3 with no notes refuses, naming c3", async () => {
  const h = await history();
  try {
    const [c0, c1, c2, c3] = h.shas;
    both(h, c1);
    both(h, c2, ` line from ${c0}`);
    const r = h.verdict(c3, c0);
    assert.equal(r.range.find((x) => x.sha === c3).covered, false, "c3 sits above c2's sign");
    assert.equal(r.v.ok, false);
    assert.match(r.v.refusals.join(), new RegExp(`no SECURE and PASS: ${c3.slice(0, 12)}`));
    assert.doesNotMatch(r.v.refusals.join(), new RegExp(`no SECURE and PASS: [^;]*${c2.slice(0, 12)}`), "c2 is signed");
  } finally { h.done(); }
});

test("history (c): a real side-branch base (forked at c1, Worker at c1): c3 'line from s' with c2 unsigned refuses; a base off the line covers nothing", async () => {
  const h = await history();
  try {
    const [, c1, c2, c3] = h.shas;
    h.git("checkout", "-q", "-b", "side", c1);
    h.git("commit", "-q", "--allow-empty", "-m", "side");
    const s = h.git("rev-parse", "HEAD");
    h.git("checkout", "-q", "main");
    both(h, c3, ` line from ${s}`); // s exists and is at or after the Worker, but is not an ancestor of c3
    const r = h.verdict(c3, c1);
    assert.equal(r.range.find((x) => x.sha === c2).covered, false);
    assert.equal(r.v.ok, false);
    assert.match(r.v.refusals.join(), new RegExp(`no SECURE and PASS: ${c2.slice(0, 12)}`));
  } finally { h.done(); }
});

test("must still refuse: a commit that is no full sha is refused whatever else holds", () => {
  for (const commit of ["", "abc", "A".repeat(40), null, undefined]) assert.equal(gateVerdict(facts({ commit, tip: commit })).ok, false, String(commit));
});

test("currentBuildSha reads the plain_text BUILD_SHA binding with the token; anything else is null and nothing throws", async () => {
  const account = "1".repeat(32), calls = [];
  const fetchOf = (body, status = 200) => async (url, init) => { calls.push({ url, init }); return { ok: status === 200, status, json: async () => body }; };
  const body = { result: { bindings: [{ type: "d1", name: "DB" }, { type: "plain_text", name: "BUILD_SHA", text: A }] } };
  assert.equal(await currentBuildSha({ accountId: account, token: "tok-12345678", script: "flight-board-store", fetchFn: fetchOf(body) }), A);
  assert.equal(calls[0].url, `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/flight-board-store/settings`);
  assert.equal(calls[0].init.headers.authorization, "Bearer tok-12345678");
  const nope = async (over) => currentBuildSha({ accountId: account, token: "tok-12345678", script: "flight-board-store", fetchFn: fetchOf({ result: { bindings: [] } }), ...over });
  assert.equal(await nope({}), null, "no such binding");
  assert.equal(await nope({ fetchFn: fetchOf({}, 403) }), null, "a failed call");
  assert.equal(await nope({ fetchFn: fetchOf({ result: { bindings: [{ type: "plain_text", name: "BUILD_SHA", text: "short" }] } }) }), null, "not a full sha");
  assert.equal(await nope({ fetchFn: async () => { throw new Error("offline"); } }), null, "a thrown error");
  assert.equal(await nope({ token: "" }), null, "no token");
  assert.equal(await nope({ accountId: "../x" }), null, "no account");
  assert.equal(await nope({ script: "a/b" }), null, "a script name with a slash");
});

test("scriptName takes the Worker's name from the wrangler config", () => {
  assert.equal(scriptName('# c\nname = "flight-board-store"\nmain = "x.mjs"\n'), "flight-board-store");
  assert.equal(scriptName("main = 'x'"), null);
  assert.equal(scriptName('name = "a b"'), null);
});

// ---- the run script, over a fake spawn and file system
const TOKEN = "cf-token-SECRET123456", ACCT = "9".repeat(32), CONFIG = '{"artifactUrl":"https://example.invalid/b","gate":{}}';
function rig({ marker = A, head = A, env = {}, fail = {} } = {}) {
  const calls = [], said = [], written = [];
  const files = new Map(marker === null ? [] : [[".self-deploy-ok", `${marker}\n`]]);
  const fs = { existsSync: (p) => files.has(p), readFileSync: (p) => files.get(p), writeFileSync: (p, t) => { files.set(p, t); written.push(p); }, mkdtempSync: (p) => `${p}x`, rmSync: () => {} };
  const spawn = (cmd, args, opts) => {
    calls.push({ cmd, args, env: opts?.env });
    if (cmd === "git") return { status: 0, stdout: `${head}\n` };
    const key = cmd === "node" ? "build" : args.includes("migrations") ? "migrate" : "deploy";
    if (fail[key]) return { status: 1, stdout: "", stderr: `boom ${TOKEN} ${ACCT} ${CONFIG}` };
    return key === "deploy" ? { status: 0, stdout: "Current Version ID: 12345678-1234-1234-1234-123456789abc\n", stderr: "" } : { status: 0, stdout: "", stderr: "" };
  };
  const run = () => selfDeployRun({ env: { WORKERS_CI_COMMIT_SHA: A, CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCT, BOARD_CONFIG_JSON: CONFIG, ...env }, spawn, fs, say: (l) => said.push(l), tmp: "/t" });
  return { run, calls, said, written };
}

test("the run builds the page from the build variable, applies the migrations, then deploys with BUILD_SHA set to the commit; the token is never an argument or a line", () => {
  const r = rig(), res = r.run();
  assert.equal(res.ok, true);
  assert.deepEqual(r.calls.map((c) => c.cmd + " " + (c.args.find((a) => /build-store-page|migrations|deploy/.test(a)) ?? c.args[0])), ["git rev-parse", "node scripts/build-store-page.mjs", "npx migrations", "npx deploy"]);
  const dep = r.calls.at(-1);
  assert.deepEqual(dep.args, ["--yes", WRANGLER, "deploy", "--config", "worker/wrangler.board.toml", "--var", `BUILD_SHA:${A}`]);
  assert.match(WRANGLER, /^wrangler@4\.\d+\.\d+$/, "pinned");
  assert.ok(r.calls.slice(1).every((c) => !c.args.join(" ").includes(TOKEN) && !c.args.join(" ").includes(ACCT)), "no secret in any argument");
  assert.equal(r.calls[1].args[1], "/t/self-deploy-x/board.config.json", "the config is written in a temporary folder, outside the repository");
  assert.deepEqual(r.written, ["/t/self-deploy-x/board.config.json"], "and it is the only file written");
  assert.match(res.line, /^SELF-DEPLOY OK: the Worker carries aaaaaaaaaaaa \(version 12345678-/);
  assert.doesNotMatch(r.said.join("\n"), new RegExp(`${TOKEN}|${ACCT}`));
});

test("must still refuse: no marker means nothing runs and it exits clean; a marker for another commit, a build commit that differs, missing secrets or config stop before any wrangler call", () => {
  const none = rig({ marker: null }), res = none.run();
  assert.deepEqual([res.ok, res.skipped], [true, true]);
  assert.deepEqual(none.calls, [], "no marker: not even git");
  for (const [name, r] of Object.entries({
    "a marker for another commit": rig({ marker: B }), "a build commit that differs": rig({ env: { WORKERS_CI_COMMIT_SHA: B } }),
    "no token": rig({ env: { CLOUDFLARE_API_TOKEN: "" } }), "no account": rig({ env: { CLOUDFLARE_ACCOUNT_ID: "" } }),
    "no board config": rig({ env: { BOARD_CONFIG_JSON: "" } }), "a board config that is not JSON": rig({ env: { BOARD_CONFIG_JSON: "{not json" } }),
    "a marker that is not a sha": rig({ marker: "main" }),
  })) {
    const out = r.run();
    assert.equal(out.ok, false, name);
    assert.match(out.line, /^SELF-DEPLOY FAILED: /, name);
    assert.ok(r.calls.every((c) => c.cmd === "git"), `${name}: only git was run`);
  }
});

test("a failing step stops the rest, and its line has the token, the account and the config taken out", () => {
  for (const [step, later] of [["build", ["migrate", "deploy"]], ["migrate", ["deploy"]], ["deploy", []]]) {
    const r = rig({ fail: { [step]: true } }), res = r.run();
    assert.equal(res.ok, false, step);
    assert.match(res.line, new RegExp(`^SELF-DEPLOY FAILED: (the page build|migration|deploy) exited 1`), step);
    assert.doesNotMatch(res.line + r.said.join(""), new RegExp(`${TOKEN}|${ACCT}|artifactUrl`), step);
    assert.match(res.line, /\[hidden\]/);
    for (const l of later) assert.ok(!r.calls.some((c) => (l === "migrate" ? c.args.includes("migrations") : l === "deploy" ? c.args.includes("deploy") : false)), `${step} failed: ${l} not run`);
  }
  assert.equal(redact("x TOKENTOKEN y", { CLOUDFLARE_API_TOKEN: "TOKENTOKEN" }), "x [hidden] y");
  assert.equal(redact("abc", { CLOUDFLARE_API_TOKEN: "ab" }), "abc", "a value under 8 characters is not a secret to hide (it would mangle text)");
});

test("a deploy that printed no version id is a failure, not a success", () => {
  const res = selfDeployRun({ env: { WORKERS_CI_COMMIT_SHA: A, CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCT, BOARD_CONFIG_JSON: CONFIG },
    spawn: (cmd, args) => (cmd === "git" ? { status: 0, stdout: A } : { status: 0, stdout: "deployed", stderr: "" }),
    fs: { existsSync: () => true, readFileSync: () => A, writeFileSync() {}, mkdtempSync: () => "/t/x", rmSync() {} }, say: () => {}, tmp: "/t" });
  assert.equal(res.ok, false); assert.match(res.line, /no version id/);
});
