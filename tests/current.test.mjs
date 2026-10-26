// The collector's current link (#C223): scripts/current.mjs moves it only to a signed commit on main, in one rename; the
// fence accepts it only while it points at a pinned copy; a run's two steps run the same code.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readlinkSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { judge, linkedCommit, swapLink, importClosure, pinnedCommit, sameTree, OWNER_ENTRIES } from "../scripts/current.mjs";
import { currentLink, fenceSpec, decide } from "../collector/fence.mjs";
import { sameCode, EXPORT_NAME as NAME_C, EXPORT_COLLECTIONS as COLLECTIONS_C } from "../collector/collect.mjs";
import { EXPORT_NAME, EXPORT_COLLECTIONS } from "../collector/export.mjs";
import { fullConfig } from "../scripts/config.mjs";

const A = "a".repeat(40), B = "b".repeat(40);

test("judge: on main and SECURE, else refused with the reason; it names the owner's files and a task change", () => {
  assert.match(judge({ onMain: false, note: "SECURE", changed: [] }).reason, /origin\/main/);
  for (const note of [null, "", "RISKS", "secure", "PASS Full", "x\nSECURE", "NOT SECURE", "SECURED"]) assert.match(judge({ onMain: true, note, changed: [] }).reason, /SECURE/, String(note));
  const owned = ["gate/rules.mjs", "collector/text.mjs"];
  assert.deepEqual(judge({ onMain: true, note: "SECURE\n\nby Security", changed: ["collector/derive.mjs", "page/board.template.html"], owned }), { ok: true, ownerFiles: [], taskChanged: false });
  const v = judge({ onMain: true, note: "SECURE", changed: ["gate/rules.mjs", "collector/text.mjs", "collector/TASK.md", "collector/collect.mjs"], owned });
  assert.deepEqual(v.ownerFiles, ["gate/rules.mjs", "collector/text.mjs"]);
  assert.equal(v.taskChanged, true);
});

test("importClosure: the owner's install is everything its entry points load; at this commit, the 15 files Security listed and more", () => {
  const read = (f) => { try { return readFileSync(new URL(`../${f}`, import.meta.url), "utf8"); } catch { return null; } };
  const owned = importClosure(OWNER_ENTRIES, read);
  for (const f of ["collector/context.mjs", "collector/export.mjs", "collector/fence.mjs", "collector/refresh.mjs", "collector/text.mjs", "gate/after.mjs", "gate/gate.mjs", "gate/plan.mjs", "gate/rules.mjs", "gate/session.mjs", "gate/stop.mjs", "scripts/config.mjs"]) assert.ok(owned.includes(f), f);
  // The collector's own code is no longer pinned: the fence takes its two constants from collector/export.mjs (#C278).
  for (const f of ["collector/collect.mjs", "collector/derive.mjs", "collector/facts.mjs", "collector/nudges.mjs", "collector/plan-state.mjs", "collector/timings.mjs"]) assert.ok(!owned.includes(f), f);
  assert.ok(NAME_C === EXPORT_NAME && COLLECTIONS_C === EXPORT_COLLECTIONS, "collect.mjs re-exports the fence's own values: they can't drift apart");
  assert.ok(!owned.includes("collector/TASK.md") && !owned.includes("page/board.template.html"));
  const files = { "a.mjs": 'import { x } from "./b/c.mjs";\nexport { y } from "../z.mjs";\nimport fs from "node:fs";', "b/c.mjs": 'import "./d.mjs";\nimport { a } from "../a.mjs";', "z.mjs": "", "b/d.mjs": null };
  assert.deepEqual(importClosure(["a.mjs"], (f) => files[f] ?? null), ["a.mjs", "b/c.mjs"].sort(), "a bare import and a missing file add nothing; ../z.mjs is outside");
  assert.deepEqual(importClosure(["a.mjs"], (f) => ({ ...files, "../z.mjs": "" })[f] ?? null), ["../z.mjs", "a.mjs", "b/c.mjs"]);
  assert.deepEqual(importClosure(["a.mjs"], (f) => ({ ...files, "b/d.mjs": "" })[f] ?? null), ["a.mjs", "b/c.mjs", "b/d.mjs"], "a side-effect import is followed");
});

test("pinnedCommit: the commit the settings' gate hook runs from", () => {
  assert.equal(pinnedCommit(`{"command": "node '/u/.flight-board/install/${A}/gate/gate.mjs' --config x"}`), A);
  assert.equal(pinnedCommit(`node /u/flight-board/gate/gate.mjs`), null);
  assert.equal(pinnedCommit(null), null);
});

test("sameTree: the same files byte for byte and nothing else; a planted or edited file differs", () => {
  const base = mkdtempSync(join(tmpdir(), "fb-tree-"));
  try {
    const make = (name, files) => { for (const [f, t] of Object.entries(files)) { mkdirSync(join(base, name, f, ".."), { recursive: true }); writeFileSync(join(base, name, f), t); } return join(base, name); };
    const good = { "collector/collect.mjs": "run()", "gate/gate.mjs": "gate()" };
    assert.equal(sameTree(make("a", good), make("b", good)), true);
    assert.equal(sameTree(make("c", { ...good, "collector/collect.mjs": "evil()" }), make("d", good)), false, "an edited file");
    assert.equal(sameTree(make("e", { ...good, "extra.mjs": "x" }), make("f", good)), false, "a planted file");
    assert.equal(sameTree(make("g", { "gate/gate.mjs": "gate()" }), make("h", good)), false, "a missing file");
    const linked = make("i", { "gate/gate.mjs": "gate()" }); mkdirSync(join(linked, "collector")); symlinkSync(join(base, "a", "collector", "collect.mjs"), join(linked, "collector", "collect.mjs"));
    assert.equal(sameTree(linked, join(base, "a")), false, "a link to the same bytes in place of the file");
    const extra = make("j", good); symlinkSync(join(base, "a", "gate", "gate.mjs"), join(extra, "planted.mjs"));
    assert.equal(sameTree(extra, join(base, "a")), false, "a planted link");
  } finally { rmSync(base, { recursive: true, force: true }); }
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
