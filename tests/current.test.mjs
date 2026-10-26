// The collector's current link (#C223): scripts/current.mjs moves it only to a signed commit on main, in one rename; the
// fence accepts it only while it points at a pinned copy; a run's two steps run the same code.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readlinkSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { judge, linkedCommit, swapLink, OWNER_INSTALLS } from "../scripts/current.mjs";
import { currentLink, fenceSpec, decide } from "../collector/fence.mjs";
import { sameCode } from "../collector/collect.mjs";
import { fullConfig } from "../scripts/config.mjs";

const A = "a".repeat(40), B = "b".repeat(40);

test("judge: on main and SECURE, else refused with the reason; it names the owner's files and a task change", () => {
  assert.match(judge({ onMain: false, note: "SECURE", changed: [] }).reason, /origin\/main/);
  for (const note of [null, "", "RISKS", "secure", "PASS Full", "x\nSECURE", "NOT SECURE", "SECURED"]) assert.match(judge({ onMain: true, note, changed: [] }).reason, /SECURE/, String(note));
  assert.deepEqual(judge({ onMain: true, note: "SECURE\n\nby Security", changed: ["collector/derive.mjs", "page/board.template.html"] }), { ok: true, ownerFiles: [], taskChanged: false });
  const v = judge({ onMain: true, note: "SECURE", changed: ["gate/rules.mjs", "collector/fence.mjs", "collector/refresh.mjs", "scripts/hooks.mjs", "collector/TASK.md", "collector/collect.mjs"] });
  assert.deepEqual(v.ownerFiles, ["gate/rules.mjs", "collector/fence.mjs", "collector/refresh.mjs", "scripts/hooks.mjs"]);
  assert.equal(v.taskChanged, true);
  assert.ok(OWNER_INSTALLS.some((re) => re.test("scripts/config.mjs")));
});

function layout() {
  const base = mkdtempSync(join(tmpdir(), "fb-current-"));
  const root = join(base, "install");
  for (const sha of [A, B]) { mkdirSync(join(root, sha, "collector"), { recursive: true }); writeFileSync(join(root, sha, "collector", "collect.mjs"), ""); }
  return { base, root, link: join(base, "current") };
}

test("swapLink: makes or moves the link in one rename; a real folder in its place is refused, never removed", () => {
  const { base, root, link } = layout();
  try {
    assert.equal(linkedCommit(link), null);
    swapLink(link, join(root, A));
    assert.equal(linkedCommit(link), A);
    swapLink(link, join(root, B));
    assert.equal(readlinkSync(link), join(root, B));
    assert.equal(existsSync(`${link}.next`), false);
    rmSync(link); mkdirSync(link);
    assert.throws(() => swapLink(link, join(root, A)), /not a link/);
    assert.equal(existsSync(link), true);
    assert.equal(linkedCommit(link), null, "a folder is no link");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("currentLink: only a link to <install root>/<full commit> holding the collector", () => {
  const { base, root, link } = layout();
  try {
    const install = join(root, A);
    assert.equal(currentLink(install), null, "no link");
    symlinkSync(join(root, B), link);
    assert.equal(currentLink(install), link);
    mkdirSync(join(base, A, "collector"), { recursive: true }); writeFileSync(join(base, A, "collector", "collect.mjs"), "");
    rmSync(link); symlinkSync(join(base, A), link);
    assert.equal(currentLink(install), null, "a link elsewhere, collector and all");
    rmSync(link); mkdirSync(join(root, "short", "collector"), { recursive: true }); writeFileSync(join(root, "short", "collector", "collect.mjs"), ""); symlinkSync(join(root, "short"), link);
    assert.equal(currentLink(install), null, "not a full commit");
    rmSync(link); mkdirSync(join(root, "c".repeat(40))); symlinkSync(join(root, "c".repeat(40)), link);
    assert.equal(currentLink(install), null, "no collector in it");
    rmSync(link); mkdirSync(link);
    assert.equal(currentLink(install), null, "a folder, not a link");
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("the fence lets the two steps run from the pinned copy or the current link, and nothing else", () => {
  const config = fullConfig({ artifactUrl: "https://claude.ai/" + "artifact/TestBoard01", collector: { outDir: "/srv/out" } });
  const install = `/srv/fb/install/${A}`, current = "/srv/fb/current";
  const run = (command, spec) => decide({ session_id: "s1", cwd: spec.cwd, tool_name: "Bash", tool_input: { command } }, spec);
  const withLink = fenceSpec({ config, configPath: "/c.json", install, current, sendTo: "lead", uid: 501 });
  const without = fenceSpec({ config, configPath: "/c.json", install, sendTo: "lead", uid: 501 });
  for (const dir of [install, current]) {
    assert.equal(run(`node ${dir}/collector/collect.mjs --config /c.json --prepare`, withLink), null, dir);
    assert.equal(run(`node ${dir}/collector/collect.mjs --config /c.json`, withLink), null, dir);
  }
  assert.match(run(`node ${current}/collector/collect.mjs --config /c.json`, without), /only the two collect\.mjs commands/, "no valid link: pinned only");
  assert.match(run(`node /srv/fb/install/${B}/collector/collect.mjs --config /c.json`, withLink), /only the two/, "another pinned copy");
});

test("sameCode: step 2 runs only the code step 1 ran; an older mark without code passes", () => {
  assert.equal(sameCode({ code: "/i/a" }, "/i/a"), true);
  assert.equal(sameCode({ code: "/i/a" }, "/i/b"), false);
  assert.equal(sameCode({ at: 1 }, "/i/b"), true);
  assert.equal(sameCode({}, "/i/b"), true);
});
