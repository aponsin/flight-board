// The config check, the page build and the content scan. Fictional values only.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { checkConfig, fullConfig, DEFAULTS } from "../scripts/config.mjs";
import { buildPage, scriptJson } from "../scripts/build-page.mjs";
import { scanText, pushedCommits, scanCommit, tagText } from "../scripts/scan.mjs";

const template = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
const scriptOf = (html) => html.match(/<script>([\s\S]*?)<\/script>/)[1];

test("the config: known fields only, each in its shape; the defaults pass", () => {
  assert.deepEqual(checkConfig({}), []);
  assert.deepEqual(checkConfig(DEFAULTS), []);
  assert.deepEqual(checkConfig(JSON.parse(readFileSync(new URL("../board.config.example.json", import.meta.url), "utf8"))), []);
  const bad = checkConfig({ colour: "red", owner: "<b>", phases: [["Plan", "Plan"], ["x"]], skips: [{ phase: "nope", unlessLevel: "Full", whenFalse: "x" }], artifactUrl: "https://evil.example/x", boardStart: "Oct 14", usageNote: "<script>" });
  for (const part of ['unknown field "colour"', "owner:", "phases[0]", "phases[1]", "skips[0].phase", "skips[0]: exactly one", "artifactUrl", "boardStart", "usageNote"]) {
    assert.ok(bad.some((p) => p.startsWith(part)), part);
  }
  assert.deepEqual(checkConfig([]), ["the config must be a JSON object"]);
  assert.deepEqual(checkConfig({ phases: [["a", "A"], ["a", "B"]] }), ["phases: each key once"]);
});

test("the page for a config: its values in the script and the HTML, escaped; a bad config builds nothing", () => {
  const html = buildPage(template, { title: "Team & Co", owner: "Sam", roster: ["Lead", "Maker"], phases: [["make", "Make"], ["done", "Done"]], skips: [] });
  assert.match(html, /<title>Team &amp; Co<\/title>/);
  assert.match(html, /<h2 id="h-wait">Waiting on Sam<\/h2>/);
  assert.doesNotMatch(html, /\{\{[A-Z_]+\}\}/, "every placeholder filled");
  const injected = JSON.parse(html.match(/const CONFIG=\/\*BOARD_CONFIG\*\/([\s\S]*?)\/\*END_CONFIG\*\//)[1]);
  assert.equal(injected.owner, "Sam");
  assert.deepEqual(injected.phases, [["make", "Make"], ["done", "Done"]]);
  assert.deepEqual(injected.roster, ["Lead", "Maker"]);
  assert.throws(() => buildPage(template, { owner: "x\ny" }), /owner/);
});

test("a config value can't close the page's script or open a tag: the check refuses \"<\", and the JSON carries none", () => {
  assert.ok(checkConfig({ roster: ["</script>"] }).length);
  const json = scriptJson({ a: "</script><script>alert(1)", b: "x\u2028y" });
  assert.equal(json.includes("<"), false);
  assert.equal(/[\u2028\u2029]/.test(json), false);
  assert.deepEqual(JSON.parse(json), { a: "</script><script>alert(1)", b: "x\u2028y" });
  assert.match(buildPage(template, { usageNote: "a & b" }), /a &amp; b Agent minutes/);
});

test("fullConfig: the team's values on top of the defaults", () => {
  assert.equal(fullConfig({ owner: "Sam" }).owner, "Sam");
  assert.deepEqual(fullConfig({}).phases, DEFAULTS.phases);
});

test("the scan: the private words, artifact links, real emails and phones, tokens; example ones pass", () => {
  const words = ["acme widgets"];
  const hits = (t) => scanText(t, words).map((h) => h.what);
  assert.deepEqual(hits("We love ACME Widgets here"), ['a listed word ("acme widgets")']);
  assert.deepEqual(hits("see https://claude.ai/" + "artifact/AbC123xyz"), ["an artifact link"]);
  assert.deepEqual(hits("mail sam@" + "realshop.io"), ["an email address"]);
  assert.deepEqual(hits("mail sam@example.com or team@example.org"), []);
  assert.deepEqual(hits("Co-Authored-By: Bot <noreply@" + "bots.dev> and 123+sam@" + "users.noreply.github.com"), [], "no-reply addresses pass");
  assert.deepEqual(hits("mail realnoreply@" + "shop.io"), ["an email address"]);
  assert.deepEqual(hits("call (303) 444" + "-1234"), ["a phone number"]);
  assert.deepEqual(hits("call (303) 555-0100"), []);
  assert.deepEqual(hits("key ghp" + "_abcdefghijklmnopqrstuvwxyz0123"), ["a token"]);
  assert.deepEqual(hits("version 1.92.0, at 1800000000000"), []);
  assert.deepEqual(scanText("one\ntwo acme widgets", words)[0].line, 2);
});

test("this repository holds no artifact link, real email or phone, or token", async () => {
  const { execFileSync } = await import("node:child_process");
  const files = execFileSync("git", ["ls-files"], { encoding: "utf8", cwd: new URL("..", import.meta.url) }).split("\n").filter(Boolean);
  const found = [];
  for (const f of files) {
    let text; try { text = readFileSync(new URL("../" + f, import.meta.url), "utf8"); } catch { continue; }
    for (const h of scanText(text, [])) found.push(`${f}:${h.line} ${h.what}`);
  }
  assert.deepEqual(found, []);
});

test("the scan's shapes: phones as digits (E.164 too), Stripe, webhook, Resend and fine-grained GitHub keys; 555 and long times pass", () => {
  const hits = (t) => scanText(t, []).map((h) => h.what);
  assert.deepEqual(hits("phone +1303" + "4431079"), ["a phone number"]);
  assert.deepEqual(hits("phone 303" + "4431079"), ["a phone number"]);
  assert.deepEqual(hits("phone +13035550100 and 3035550199"), []);
  assert.deepEqual(hits("at 1800000000000 and 1792876174813, sha b0c42f77"), []);
  for (const t of ["sk" + "_live_abcdefghijklmnop1234", "rk" + "_live_abcdefghijklmnop1234", "whsec" + "_abcdefghijklmnop1234", "re" + "_abcdefghijklmnopqrstu_123", "github" + "_pat_" + "a".repeat(40)]) {
    assert.deepEqual(hits(`key ${t}`), ["a token"], t);
  }
});

test("the pre-push scan reads what is pushed: a word committed then removed, or edited out on disk, is still refused", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFileSync, spawnSync } = await import("node:child_process");
  const dir = mkdtempSync(join(tmpdir(), "fb-scan-"));
  try {
    const repo = join(dir, "repo"), bare = join(dir, "bare.git"), words = join(dir, "words.txt");
    writeFileSync(words, "# private\nquillwhistle\n");
    const git = (args, cwd = repo) => execFileSync("git", args, { cwd, encoding: "utf8" });
    execFileSync("git", ["init", "-q", "--bare", bare]);
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    git(["config", "user.email", "t@example.com"]); git(["config", "user.name", "T"]);
    git(["remote", "add", "origin", bare]);
    writeFileSync(join(repo, "a.md"), "clean\n"); git(["add", "-A"]); git(["commit", "-qm", "one"]);
    git(["push", "-q", "origin", "main"]);
    const base = git(["rev-parse", "HEAD"]).trim();
    writeFileSync(join(repo, "notes.md"), "secret quillwhistle plan\n"); git(["add", "-A"]); git(["commit", "-qm", "two"]);
    git(["rm", "-q", "notes.md"]); git(["commit", "-qm", "three"]);
    writeFileSync(join(repo, "b.md"), "word quillwhistle\n"); git(["add", "-A"]); git(["commit", "-qm", "four"]);
    writeFileSync(join(repo, "b.md"), "edited out on disk\n");
    const head = git(["rev-parse", "HEAD"]).trim();
    const scan = new URL("../scripts/scan.mjs", import.meta.url).pathname;
    const run = (stdin) => spawnSync(process.execPath, [scan, "--pre-push"], { cwd: repo, input: stdin, encoding: "utf8", env: { ...process.env, FLIGHT_BOARD_SCAN_WORDS: words } });
    const r = run(`refs/heads/main ${head} refs/heads/main ${base}\n`);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /:notes\.md:1: a listed word/);
    assert.match(r.stderr, /:b\.md:1: a listed word/);
    const shell = (args) => git(args);
    assert.equal(pushedCommits(`refs/heads/main ${head} refs/heads/main ${base}`, shell).length, 3);
    assert.equal(pushedCommits(`refs/heads/x ${"0".repeat(40)} refs/heads/x ${base}`, shell).length, 0, "a deleted ref sends nothing");
    assert.equal(scanCommit(base, ["quillwhistle"], shell).length, 0);
    assert.equal(run(`refs/heads/main ${base} refs/heads/main ${base}\n`).status, 0, "nothing new: clean");
    writeFileSync(words, "# only comments\n");
    assert.match(run("").stderr, /has no words/, "an empty list refuses");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the pre-push scan also reads merges, a first push to a second remote, annotated tags, and authors", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFileSync, spawnSync } = await import("node:child_process");
  const dir = mkdtempSync(join(tmpdir(), "fb-scan2-"));
  try {
    const repo = join(dir, "repo"), words = join(dir, "words.txt");
    writeFileSync(words, "quillwhistle\n");
    const git = (args, env = {}) => execFileSync("git", args, { cwd: repo, encoding: "utf8", env: { ...process.env, ...env } });
    for (const b of ["private.git", "public.git"]) execFileSync("git", ["init", "-q", "--bare", join(dir, b)]);
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    git(["config", "user.email", "t@example.com"]); git(["config", "user.name", "T"]);
    git(["remote", "add", "origin", join(dir, "private.git")]); git(["remote", "add", "public", join(dir, "public.git")]);
    const scan = new URL("../scripts/scan.mjs", import.meta.url).pathname;
    const hook = (remote, stdin) => spawnSync(process.execPath, [scan, "--pre-push", remote], { cwd: repo, input: stdin, encoding: "utf8", env: { ...process.env, FLIGHT_BOARD_SCAN_WORDS: words } });
    const sha = (ref) => git(["rev-parse", ref]).trim();
    const Z = "0".repeat(40);
    writeFileSync(join(repo, "a.md"), "clean\n"); git(["add", "-A"]); git(["commit", "-qm", "one"]);
    // A merge whose own resolution adds the word.
    git(["checkout", "-qb", "side"]); writeFileSync(join(repo, "s.md"), "side\n"); git(["add", "-A"]); git(["commit", "-qm", "side"]);
    git(["checkout", "-q", "main"]); writeFileSync(join(repo, "m.md"), "main\n"); git(["add", "-A"]); git(["commit", "-qm", "main"]);
    git(["merge", "-q", "--no-ff", "--no-commit", "side"]); writeFileSync(join(repo, "evil.md"), "quillwhistle\n"); git(["add", "-A"]); git(["commit", "-qm", "merge"]);
    const merged = hook("origin", `refs/heads/main ${sha("HEAD")} refs/heads/main ${Z}\n`);
    assert.equal(merged.status, 1); assert.match(merged.stderr, /evil\.md:1: a listed word/);
    git(["rm", "-q", "evil.md"]); git(["commit", "-qm", "clean again"]);
    // The private remote has it all; a first push to the public one still sends (and scans) every commit.
    git(["push", "-q", "--no-verify", "origin", "main"]);
    const pub = hook("public", `refs/heads/main ${sha("HEAD")} refs/heads/main ${Z}\n`);
    assert.equal(pub.status, 1, "the old merge goes to the public remote too"); assert.match(pub.stdout + pub.stderr, /evil\.md/);
    assert.equal(hook("origin", `refs/heads/main ${sha("HEAD")} refs/heads/main ${sha("HEAD")}\n`).status, 0);
    // An annotated tag's message.
    git(["tag", "-a", "v9", "-m", "the quillwhistle release"]);
    const tag = hook("origin", `refs/tags/v9 ${sha("v9")} refs/tags/v9 ${Z}\n`);
    assert.equal(tag.status, 1); assert.match(tag.stderr, /tag [0-9a-f]{8}:\d+: a listed word/);
    git(["tag", "-a", "v10", "-m", "a clean release"]);
    const clean = hook("origin", `refs/tags/v10 ${sha("v10")} refs/tags/v10 ${Z}\n`);
    assert.equal(clean.status, 0, "a clean tag passes: " + clean.stderr);
    // A personal address in a commit's author.
    writeFileSync(join(repo, "b.md"), "b\n"); git(["add", "-A"]);
    git(["commit", "-qm", "b"], { GIT_AUTHOR_EMAIL: "sam@" + "realshop.io", GIT_AUTHOR_NAME: "Sam" });
    const author = hook("origin", `refs/heads/main ${sha("HEAD")} refs/heads/main ${sha("HEAD~1")}\n`);
    assert.equal(author.status, 1); assert.match(author.stderr, /\(message, author\):\d+: an email address/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a tag is scanned by its tagger's name and email and its message, never its time", () => {
  const raw = "object 0123abcd\ntype commit\ntag v1\ntagger Sam Lee <sam@example.com> " + "17928" + "77170 -0700\n\nRelease notes\n\nmore";
  assert.equal(tagText(raw), "Sam Lee <sam@example.com>\nRelease notes\n\nmore");
  assert.deepEqual(scanText(tagText(raw), []), []);
});
