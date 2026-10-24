// The config check, the page build and the content scan. Fictional values only.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { checkConfig, fullConfig, DEFAULTS } from "../scripts/config.mjs";
import { buildPage, scriptJson } from "../scripts/build-page.mjs";
import { scanText } from "../scripts/scan.mjs";

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
