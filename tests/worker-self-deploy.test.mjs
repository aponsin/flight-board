// #C968 (the owner chose B on #T1837 and accepted change 4 on #T1779): the board Worker deploys itself from a signed main, in Cloudflare's own Git build.
// scripts/self-deploy-gate.mjs decides (main's tip, Security's SECURE and Checker's PASS on the exact commit, forward of the Worker's BUILD_SHA);
// scripts/self-deploy-run.mjs deploys only behind the gate's marker; the Worker's push tells the owner's phone (tests/owner-phone-push.test.mjs).
// Must still refuse: an unsigned or non-tip commit, a commit behind the Worker, a BUILD_SHA it cannot read, a deploy with no marker, a token in any line.
// Must still allow: a signed main tip ahead of the Worker (deploys), and the same commit twice (nothing to do, exit 0).
import test from "node:test";
import assert from "node:assert/strict";
import { gateVerdict, currentBuildSha, scriptName } from "../scripts/self-deploy-gate.mjs";
import { selfDeployRun, redact, WRANGLER } from "../scripts/self-deploy-run.mjs";

const A = "a".repeat(40), B = "b".repeat(40), C = "c".repeat(40);
const ok = { security: "SECURE #C968: reviewed\nmore", checker: "PASS Full at aaaa" };
const facts = (over = {}) => ({ commit: A, tip: A, notes: ok, current: B, descends: true, ...over });

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
