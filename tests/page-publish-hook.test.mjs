// Page-only board releases publish without the owner's word (#C409, the owner's B in #T1051 and their OK to add the
// hook): gate/publish.mjs allows exactly one call, the lead's publish of the very page the signed board code builds, to
// this board, and is silent on everything else (the app asks as before). Silence is null here; an allow is its reason.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, realpathSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { publishAllowed, PAGE_NAME, MAX_PAGE } from "../gate/publish.mjs";
import { buildPage } from "../scripts/build-page.mjs";

const BOARD = "https://claude.ai/" + "artifact/TestBoard01";
const rawConfig = { title: "Test Board", owner: "Sam", artifactUrl: BOARD };
const template = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
const lead = [{ customTitle: "Manager" }];

// A config folder with today's page in it, and a signed copy (the current link's target) holding the template.
function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "publish-")));
  const configDir = join(root, "Team"), current = join(root, "install", "a".repeat(40));
  mkdirSync(configDir, { recursive: true });
  mkdirSync(join(current, "page"), { recursive: true });
  writeFileSync(join(current, "page", "board.template.html"), template);
  writeFileSync(join(configDir, "board.config.json"), JSON.stringify(rawConfig));
  const page = join(configDir, "board-5c782c5.html");
  writeFileSync(page, buildPage(template, rawConfig));
  return { root, configDir, current, page };
}
const call = (tool_input, tool_name = "Artifact") => ({ tool_name, tool_input });
const ask = (s, input, extra = {}) => publishAllowed(input, { rawConfig, managerRole: "Manager", configDir: s.configDir, current: s.current, lines: lead, ...extra });

test("the lead's publish of exactly the signed page, to this board: allowed, with its reason", () => {
  const s = setup();
  assert.match(ask(s, call({ url: BOARD, file_path: s.page })), /^Flight board: board-5c782c5\.html is the page the signed board code builds \(aaaaaaaaaaaa\) for this board: published by Manager without asking \(#C409\)\.$/);
  assert.ok(ask(s, call({ action: "publish", url: BOARD, file_path: s.page })), "action publish, said or not");
  const v = join(s.configDir, "board-v321.html");
  cpSync(s.page, v);
  assert.ok(ask(s, call({ url: BOARD, file_path: v })), "board-v<NNN>.html too");
});

test("anyone else, any other call, any other board: silence", () => {
  const s = setup();
  const ok = { url: BOARD, file_path: s.page };
  assert.equal(ask(s, call(ok), { lines: [{ customTitle: "Boardsmith" }] }), null, "not the lead");
  assert.equal(ask(s, call(ok), { lines: [] }), null, "no title");
  assert.equal(ask(s, call(ok), { envRole: "Release" }), null, "title and FLIGHT_BOARD_ROLE disagree");
  assert.equal(ask(s, call(ok, "ArtifactData")), null, "another tool");
  for (const action of ["delete", "read", "list", "open", "pin", "quickstart"]) assert.equal(ask(s, call({ ...ok, action })), null, action);
  assert.equal(ask(s, call({ ...ok, url: BOARD + "x" })), null, "another artifact");
  assert.equal(ask(s, call({ ...ok, url: undefined })), null, "a new artifact");
  for (const extra of [{ files: {} }, { capabilities: {} }, { force: true }, { edits: [] }, { asset: true }, { contract: "latest" }, { type_url: "x" }, { pin: true }, { description: "d" }])
    assert.equal(ask(s, call({ ...ok, ...extra })), null, Object.keys(extra)[0]);
  assert.equal(publishAllowed(call(ok), { rawConfig: { ...rawConfig, artifactUrl: "" }, managerRole: "Manager", configDir: s.configDir, current: s.current, lines: lead }), null, "no board link in the config");
});

test("only the very page the signed code builds, from the config's folder, under a board page's name", () => {
  const s = setup();
  const edited = join(s.configDir, "board-1234567.html");
  writeFileSync(edited, buildPage(template, rawConfig) + "<script>steal()</script>");
  assert.equal(ask(s, call({ url: BOARD, file_path: edited })), null, "one byte off the build");
  const other = join(s.configDir, "board-5c782c5.htm");
  cpSync(s.page, other);
  assert.equal(ask(s, call({ url: BOARD, file_path: other })), null, "not a board page's name");
  const away = join(s.root, "board-5c782c5.html");
  cpSync(s.page, away);
  assert.equal(ask(s, call({ url: BOARD, file_path: away })), null, "outside the config's folder");
  const link = join(s.configDir, "board-7654321.html");
  symlinkSync(away, link);
  assert.equal(ask(s, call({ url: BOARD, file_path: link })), null, "a link out of the folder (realpath)");
  const fifo = join(s.configDir, "board-abcdef0.html");
  execFileSync("mkfifo", [fifo]);
  assert.equal(ask(s, call({ url: BOARD, file_path: fifo })), null, "a FIFO never blocks the hook");
  const big = join(s.configDir, "board-fedcba0.html");
  writeFileSync(big, "x".repeat(MAX_PAGE + 1));
  assert.equal(ask(s, call({ url: BOARD, file_path: big })), null, "too big");
  assert.equal(ask(s, call({ url: BOARD, file_path: s.page }), { current: null }), null, "no signed copy to build from");
  writeFileSync(join(s.current, "page", "board.template.html"), template + "\n<!-- a newer release -->\n");
  assert.equal(ask(s, call({ url: BOARD, file_path: s.page })), null, "the signed template moved on: the old page isn't it");
  for (const n of ["board-5c782c5.html", "board-v320.html", "board-" + "a".repeat(40) + ".html"]) assert.match(n, PAGE_NAME);
  for (const n of ["board-v3.21.html", "board-x.html", "board-5c782c5.html.bak", "../board-5c782c5.html", "board-ABCDEF0.html", "board-123456.html"]) assert.doesNotMatch(n, PAGE_NAME);
});

test("the hook as the app runs it: an allow on stdout as JSON, silence otherwise, and never a refusal", () => {
  const s = setup();
  const install = join(s.root, "flight-board", "install");
  const pin = join(install, "b".repeat(40));
  // The hook's own pinned copy: this checkout's files at <install>/<sha>, and <install>/../current → a signed copy.
  cpSync(new URL("..", import.meta.url).pathname, pin, { recursive: true, filter: (p) => !p.includes("/.git") && !p.includes("/node_modules") });
  symlinkSync(pin, join(install, "..", "current"));
  const transcript = join(s.root, "t.jsonl");
  writeFileSync(transcript, JSON.stringify({ customTitle: "Manager" }) + "\n");
  const run = (input) => spawnSync(process.execPath, [join(pin, "gate", "publish.mjs"), "--config", join(s.configDir, "board.config.json")], { input: JSON.stringify(input), encoding: "utf8", env: { ...process.env, FLIGHT_BOARD_ROLE: "" } });
  const page = join(s.configDir, "board-0000000.html");
  writeFileSync(page, buildPage(readFileSync(join(pin, "page", "board.template.html"), "utf8"), rawConfig));
  const yes = run({ tool_name: "Artifact", tool_input: { url: BOARD, file_path: page }, transcript_path: transcript });
  assert.equal(yes.status, 0);
  const out = JSON.parse(yes.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(out.hookSpecificOutput.permissionDecision, "allow");
  const no = run({ tool_name: "Artifact", tool_input: { url: BOARD, file_path: page, action: "delete" }, transcript_path: transcript });
  assert.deepEqual([no.status, no.stdout, no.stderr], [0, "", ""], "silent, exit 0");
  const junk = spawnSync(process.execPath, [join(pin, "gate", "publish.mjs"), "--config", join(s.configDir, "board.config.json")], { input: "not json", encoding: "utf8" });
  assert.deepEqual([junk.status, junk.stdout], [0, ""], "a call it can't read: silence");
});
