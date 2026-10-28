// #C409's race (#C415, Security's two parts): the file the hook checked could change before the app publishes it.
// (1) The hook allows the publish of a copy of the very bytes it checked, in a fresh 0700 folder (updatedInput).
// (2) Its reason names the page's sha256, and the lead checks the read-back against it (scripts/publish-check.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, cpSync, statSync, readdirSync, utimesSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { publishVerdict, verifiedCopy, COPY_DIR } from "../gate/publish.mjs";
import { publishCheck, unwrap } from "../scripts/publish-check.mjs";
import { buildPage } from "../scripts/build-page.mjs";

const BOARD = "https://claude.ai/" + "artifact/TestBoard01";
const rawConfig = { title: "Test Board", owner: "Sam", artifactUrl: BOARD };
const template = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
const sha = (b) => createHash("sha256").update(b).digest("hex");
function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "race-")));
  const configDir = join(root, "Team"), current = join(root, "install", "a".repeat(40));
  mkdirSync(configDir, { recursive: true }); mkdirSync(join(current, "page"), { recursive: true });
  writeFileSync(join(current, "page", "board.template.html"), template);
  writeFileSync(join(configDir, "board.config.json"), JSON.stringify(rawConfig));
  const page = join(configDir, "board-5c782c5.html");
  writeFileSync(page, buildPage(template, rawConfig));
  return { root, configDir, current, page };
}
const verdict = (s, input) => publishVerdict({ tool_name: "Artifact", tool_input: input }, { rawConfig, managerRole: "Manager", configDir: s.configDir, current: s.current, lines: [{ customTitle: "Manager" }] });

test("(1) the publish goes from a fresh copy of the checked bytes: a 0700 folder in the config's, same name; the original changed after the check changes nothing", () => {
  const s = setup();
  const v = verdict(s, { action: "publish", url: BOARD, file_path: s.page });
  const checked = readFileSync(s.page);
  writeFileSync(s.page, "<script>steal()</script>"); // the race: changed after the check
  const input = verifiedCopy(v, s.configDir);
  assert.deepEqual(Object.keys(input).sort(), ["action", "file_path", "url"], "the whole input, as updatedInput replaces it");
  assert.equal(input.url, BOARD); assert.equal(input.action, "publish");
  assert.ok(readFileSync(input.file_path).equals(checked), "the copy is the bytes the hook checked");
  assert.equal(basename(input.file_path), "board-5c782c5.html");
  assert.equal(dirname(dirname(input.file_path)), s.configDir);
  assert.match(basename(dirname(input.file_path)), COPY_DIR);
  assert.equal(statSync(dirname(input.file_path)).mode & 0o777, 0o700);
  assert.equal(statSync(input.file_path).mode & 0o777, 0o600);
  assert.match(v.reason, new RegExp(`sha256 ${sha(checked)}:`), "(2) the reason names the checked page's hash");
});

test("each publish gets its own folder; copies older than a day are cleared, nothing else is", () => {
  const s = setup();
  const v = verdict(s, { url: BOARD, file_path: s.page });
  const a = verifiedCopy(v, s.configDir), b = verifiedCopy(v, s.configDir);
  assert.notEqual(dirname(a.file_path), dirname(b.file_path));
  const old = dirname(a.file_path), day = (Date.now() - 2 * 864e5) / 1000;
  utimesSync(old, day, day);
  const keep = join(s.configDir, ".publish-notours"); mkdirSync(keep); utimesSync(keep, day, day);
  verifiedCopy(v, s.configDir);
  assert.ok(!existsSync(old), "the day-old copy is gone");
  assert.ok(existsSync(keep) && existsSync(b.file_path) && existsSync(s.page), "anything else stays");
  assert.equal(readdirSync(s.configDir).filter((d) => COPY_DIR.test(d)).length, 2);
});

test("no copy, no allow: a folder it can't write in gives null", () => {
  const s = setup();
  const v = verdict(s, { url: BOARD, file_path: s.page });
  assert.equal(verifiedCopy(v, join(s.root, "missing")), null);
});

test("the hook as the app runs it: the allow carries updatedInput with the copy", () => {
  const s = setup();
  const install = join(s.root, "fb", "install"), pin = join(install, "b".repeat(40));
  cpSync(new URL("..", import.meta.url).pathname, pin, { recursive: true, filter: (p) => !p.includes("/.git") && !p.includes("/node_modules") });
  symlinkSync(pin, join(install, "..", "current"));
  const transcript = join(s.root, "t.jsonl");
  writeFileSync(transcript, JSON.stringify({ customTitle: "Manager" }) + "\n");
  const page = join(s.configDir, "board-0000000.html");
  writeFileSync(page, buildPage(readFileSync(join(pin, "page", "board.template.html"), "utf8"), rawConfig));
  const r = spawnSync(process.execPath, [join(pin, "gate", "publish.mjs"), "--config", join(s.configDir, "board.config.json")], { input: JSON.stringify({ tool_name: "Artifact", tool_input: { url: BOARD, file_path: page }, transcript_path: transcript }), encoding: "utf8", env: { ...process.env, FLIGHT_BOARD_ROLE: "" } });
  const out = JSON.parse(r.stdout).hookSpecificOutput;
  assert.equal(out.permissionDecision, "allow");
  assert.equal(out.updatedInput.url, BOARD);
  assert.notEqual(out.updatedInput.file_path, page);
  assert.ok(readFileSync(out.updatedInput.file_path).equals(readFileSync(page)));
  assert.match(out.permissionDecisionReason, new RegExp(`sha256 ${sha(readFileSync(page))}`));
});

// What Artifact's read action saves: the page inside the app's document skeleton (checked on the live board: the inside
// of its read-back is board-a55334c.html byte for byte).
const wrap = (page) => `<!doctype html><html><head><meta charset=utf8><meta name=viewport content="width=device-width"><style>body{margin:0}</style></head><body>\n${page}\n</body></html>`;

test("(2) the read-back check: ok on the page, MISMATCH on any other, can't check without the wrapping or a hash", () => {
  const page = buildPage(template, rawConfig), h = sha(page);
  assert.equal(unwrap(wrap(page)), page);
  assert.deepEqual(publishCheck(wrap(page), h), { ok: true, line: "publish check: ok" });
  const bad = publishCheck(wrap(page + "<script>x()</script>"), h);
  assert.equal(bad.ok, false); assert.match(bad.line, /^publish check: MISMATCH: the board holds [0-9a-f]{12}, the hook verified [0-9a-f]{12}: tell Security and the owner$/);
  assert.match(publishCheck(page, h).line, /can't check: the read-back isn't wrapped/);
  assert.match(publishCheck(wrap(page), "abc").line, /can't check: no sha256/);
});

test("(2) the check as the lead runs it: one line, exit 0 on ok, 1 otherwise", () => {
  const dir = mkdtempSync(join(tmpdir(), "check-")), page = buildPage(template, rawConfig), f = join(dir, "back.html");
  writeFileSync(f, wrap(page));
  const run = (h) => spawnSync(process.execPath, [new URL("../scripts/publish-check.mjs", import.meta.url).pathname, f, h], { encoding: "utf8" });
  const ok = run(sha(page));
  assert.deepEqual([ok.status, ok.stdout], [0, "publish check: ok\n"]);
  assert.equal(run("0".repeat(64)).status, 1);
});
