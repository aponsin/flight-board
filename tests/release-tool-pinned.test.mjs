// #C1058 (Security's LOW on pc59; the owner chose A on #T1992, 2026-11-17, replacing B of #T1903 / #C1043): the release tool is pinned to the owner's pack. The landing job
// starts scripts/board-release.mjs from ~/.flight-board/current, the copy he installed, so a changed release tool runs only after his install: a landed change to it is
// refused like a change to the hooks, and the landing job cannot be pointed at a checkout's copy of it.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, symlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { verdict, RELEASE_ENTRIES } from "../scripts/board-release.mjs";
import { OWNER_ENTRIES, importClosure } from "../scripts/current.mjs";
import { pinnedReleaseTool } from "../scripts/board-land.mjs";
import { REPO, scratch } from "./helpers/release-scratch.mjs";

const read = (f) => { try { return readFileSync(join(REPO, f), "utf8"); } catch { return null; } };
const SIGNED = { checker: "PASS Full", security: "SECURE" };
const base = (owned) => ({ forward: true, notes: SIGNED, pinned: "1".repeat(40), owned, settingsChanged: false, capabilities: ["db"], pending: null });

test("the closure: the release tool and what it imports are in it, with the landing job, the link move and the hooks", () => {
  assert.ok(RELEASE_ENTRIES.includes("scripts/board-release.mjs"));
  const owned = importClosure([...OWNER_ENTRIES, ...RELEASE_ENTRIES], read);
  for (const f of ["scripts/board-release.mjs", "scripts/self-deploy-gate.mjs", "scripts/pack-label.mjs", "scripts/board-land.mjs", "scripts/current.mjs", "scripts/scan.mjs", "gate/stop.mjs", "collector/fence.mjs"]) assert.ok(owned.includes(f), f);
  assert.ok(!owned.includes("page/board.template.html") && !owned.includes("collector/PROMPT.txt"), "the page and the prompt stay the release role's");
});

test("verdict: a change to board-release.mjs, alone or with a test, is refused naming it, until his pack carries it; a change to a file outside the closure still goes out", () => {
  const owned = importClosure([...OWNER_ENTRIES, ...RELEASE_ENTRIES], read);
  for (const changed of [["scripts/board-release.mjs"], ["scripts/board-release.mjs", "tests/x.test.mjs"], ["tests/x.test.mjs", "scripts/board-release.mjs", "page/board.template.html"]]) {
    const v = verdict({ ...base(owned), changed });
    assert.equal(v.ok, false, changed.join());
    assert.match(v.refusals.join("\n"), /owner's install.*scripts\/board-release\.mjs/, changed.join());
  }
  assert.deepEqual(verdict({ ...base(owned), changed: ["tests/x.test.mjs", "docs/DATA.md"] }).refusals, []);
});

test("a change to what the release tool imports is the owner's too (a release cannot loosen the next one through its helpers)", () => {
  const owned = importClosure([...OWNER_ENTRIES, ...RELEASE_ENTRIES], read);
  for (const f of ["scripts/self-deploy-gate.mjs", "scripts/pack-label.mjs", "scripts/config.mjs"]) {
    const v = verdict({ ...base(owned), changed: [f] });
    assert.equal(v.ok, false, f);
    assert.match(v.refusals.join("\n"), new RegExp(`owner's install.*${f.replace(/[./]/g, "\\$&")}`), f);
  }
});

test("end to end on a scratch origin: a signed change to board-release.mjs is a pinned change now: the dry run counts it as the waiting pack's, never as 'nothing pinned changed'", () => {
  const s = scratch({ withNotes: true });
  try {
    const r = s.run(s.X);
    assert.match(r.out, /pinned changes since \w+ are the waiting pack's only/, r.out);
    assert.doesNotMatch(r.out, /nothing pinned changed/);
  } finally { rmSync(s.D, { recursive: true, force: true }); }
});

test("pinnedReleaseTool: the release tool of the installed copy the hooks pin; no pin, two pins or a copy without the tool give a reason, never the linked copy or a checkout", () => {
  const PIN = "a".repeat(40), OTHER = "b".repeat(40);
  const settings = (...pins) => JSON.stringify({ hooks: { Stop: [{ hooks: pins.map((p) => ({ type: "command", command: `'/bin/node' '/h/.flight-board/install/${p}/gate/stop.mjs' --config '/c/board.config.json' --store` })) }] } });
  const ok = pinnedReleaseTool(settings(PIN), "/h/.flight-board/install", () => true);
  assert.deepEqual(ok, { file: `/h/.flight-board/install/${PIN}/scripts/board-release.mjs`, pin: PIN });
  assert.match(pinnedReleaseTool("", "/h/.flight-board/install", () => true).why, /no single pinned commit/);
  assert.match(pinnedReleaseTool("{}", "/h/.flight-board/install", () => true).why, /no single pinned commit/);
  assert.match(pinnedReleaseTool(settings(PIN, OTHER), "/h/.flight-board/install", () => true).why, /no single pinned commit/, "hooks that disagree on the pin name none");
  assert.match(pinnedReleaseTool(settings(PIN), "/h/.flight-board/install", () => false).why, /aaaaaaaaaaaa has no scripts\/board-release\.mjs/);
  assert.doesNotMatch(JSON.stringify(ok), /current/, "never the linked copy");
});

test("the landing job takes the release tool from pinnedReleaseTool and from no other place: not beside itself (the linked copy), not a checkout; and it runs only from ~/.flight-board/current", () => {
  const src = read("scripts/board-land.mjs");
  assert.match(src, /spawnSync\(process\.execPath, \[tool\.file, sha/);
  assert.doesNotMatch(src, /join\(self, "board-release\.mjs"\)/, "no longer the file beside this one");
  assert.doesNotMatch(src, /join\(repo, "scripts"/, "no path into the checkout's scripts folder");
  assert.match(src, /NOT RUN: \$\{tool\.why\}/, "no pinned tool: it stops, it does not fall back");
  const home = mkdtempSync(join(tmpdir(), "fb-land-pin-"));
  try {
    const cfg = join(home, "board.config.json");
    writeFileSync(cfg, "{}");
    const run = () => spawnSync(process.execPath, [join(REPO, "scripts/board-land.mjs"), "--config", cfg, "--dry-run"], { encoding: "utf8", env: { ...process.env, HOME: home } });
    const away = run();
    assert.equal(away.status, 1);
    assert.match(away.stdout, /NOT RUN: this is not the signed linked copy/, "from a checkout (no link at all)");
    mkdirSync(join(home, ".flight-board", "current"), { recursive: true });
    symlinkSync(join(REPO, "scripts"), join(home, ".flight-board", "current", "scripts"));
    const linked = run();
    assert.doesNotMatch(linked.stdout, /signed linked copy/, "from the linked copy the guard lets it on: the next refusal is the config's");
    assert.match(linked.stdout, /NOT RUN: the config names no board/);
    // A valid config naming a board: now the only thing missing is the owner's pin, and the job stops there (no pin in ~/.claude/settings.json), it does not use the linked copy.
    writeFileSync(cfg, JSON.stringify({ ...JSON.parse(readFileSync(join(REPO, "board.config.example.json"), "utf8")), boardId: "pin-test-board" }));
    const noPin = run();
    assert.equal(noPin.status, 1, noPin.stdout + noPin.stderr);
    assert.match(noPin.stdout, /NOT RUN: the owner's settings name no single pinned commit for the hooks: the landing job starts only the release tool of the owner's installed copy/);
    mkdirSync(join(home, ".claude"), { recursive: true });
    const PIN = "c".repeat(40);
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: `'/bin/node' '${join(home, ".flight-board", "install", PIN)}/gate/stop.mjs' --config '${cfg}' --store` }] }] } }));
    const noCopy = run();
    assert.equal(noCopy.status, 1);
    assert.match(noCopy.stdout, /NOT RUN: the owner's installed copy cccccccccccc has no scripts\/board-release\.mjs/, "a pin with no installed copy stops too");
    rmSync(join(home, ".flight-board", "current", "scripts"));
    mkdirSync(join(home, "other-scripts"));
    symlinkSync(join(home, "other-scripts"), join(home, ".flight-board", "current", "scripts"));
    assert.match(run().stdout, /NOT RUN: this is not the signed linked copy/, "a link to some other folder is not this copy");
  } finally { rmSync(home, { recursive: true, force: true }); }
});
