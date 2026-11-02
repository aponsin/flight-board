// Every install pack dry-runs each pinned hook's config check against the config it wrote (#C587). The v3.40 pack left the
// Collector's fence on a copy whose config check refused gate.keeperRole as an unknown field. Only a pinned copy
// (<install root>/<40 hex>) is ever imported (Security): a line in a file an agent can edit must not get a folder of its
// choosing run as the owner.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { pinnedRoots, dryRun, report, isPinnedCopy } from "../scripts/hooks-check.mjs";

const here = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const CLI = join(here, "scripts", "hooks-check.mjs");
const config = { artifactUrl: "https://claude.ai/" + "artifact/TestBoard01", gate: { keeperRole: "Context keeper" } };
const SHA_OLD = "a".repeat(40), SHA_NEW = "b".repeat(40);

// An install root with an older pinned copy (its config check knows no gate.keeperRole) and a current one (this checkout's).
function installRoot() {
  const root = mkdtempSync(join(tmpdir(), "install-"));
  const old = join(root, SHA_OLD), cur = join(root, SHA_NEW);
  mkdirSync(join(old, "scripts"), { recursive: true });
  writeFileSync(join(old, "scripts", "config.mjs"), `export const checkConfig = (c) => Object.keys(c.gate ?? {}).filter((k) => k !== "managerRole").map((k) => 'gate: unknown field "' + k + '"');\n`);
  mkdirSync(join(cur, "scripts"), { recursive: true });
  copyFileSync(join(here, "scripts", "config.mjs"), join(cur, "scripts", "config.mjs"));
  return { root, old, cur };
}

test("the roots are the folders the texts run scripts from, quotes and repeats aside", () => {
  const text = `node '/x/install/${"a".repeat(40)}/gate/gate.mjs' --config '/c.json'\n"Bash(node /y/pin/collector/fence.mjs *)"\nnode /x/install/${"a".repeat(40)}/gate/stop.mjs`;
  assert.deepEqual(pinnedRoots([text, "nothing here"]), [`/x/install/${"a".repeat(40)}`, "/y/pin"]);
  assert.deepEqual(pinnedRoots([]), []);
});

test("a copy whose config check refuses a field the pack wrote fails; a current copy passes", async () => {
  const { root, old, cur } = installRoot();
  const r = report(await dryRun([old, cur], config, root));
  assert.equal(r.ok, false);
  assert.match(r.lines.join("\n"), new RegExp(`CHECK FAILED ${old}: gate: unknown field "keeperRole"`));
  assert.match(r.lines.join("\n"), new RegExp(`ok ${cur}`));
  assert.equal(report(await dryRun([cur], config, root)).ok, true);
});

test("only a pinned copy is imported: a planted folder outside the install root is a failure, never run", async () => {
  const { root, cur } = installRoot();
  const planted = mkdtempSync(join(tmpdir(), "planted-")), mark = join(planted, "ran");
  mkdirSync(join(planted, "scripts"));
  writeFileSync(join(planted, "scripts", "config.mjs"), `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(mark)}, "x"); export const checkConfig = () => [];\n`);
  // A folder inside the install root that isn't a 40-hex name, and a link in it that points out.
  const named = join(root, "latest");
  mkdirSync(join(named, "scripts"), { recursive: true });
  copyFileSync(join(planted, "scripts", "config.mjs"), join(named, "scripts", "config.mjs"));
  const link = join(root, "c".repeat(40));
  symlinkSync(planted, link);
  const results = await dryRun([planted, named, link, cur], config, root);
  assert.equal(existsSync(mark), false, "the planted config.mjs was never imported");
  const r = report(results);
  assert.equal(r.ok, false);
  for (const p of [planted, named, link]) assert.match(r.lines.join("\n"), new RegExp(`CHECK FAILED ${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: not a pinned copy`));
  assert.equal(isPinnedCopy(cur, root), true);
  assert.equal(isPinnedCopy(planted, root), false);
  assert.equal(isPinnedCopy(join(root, "nope"), root), false);
});

test("the command: exit 1 naming the stale copy, 0 when all accept, 2 with nothing to check", () => {
  const { root, old, cur } = installRoot();
  const work = mkdtempSync(join(tmpdir(), "pack-"));
  const cfg = join(work, "board.config.json");
  writeFileSync(cfg, JSON.stringify(config));
  const settings = join(work, "settings.json"), task = join(work, "TASK.md"), empty = join(work, "empty.txt");
  writeFileSync(settings, `node '${cur}/gate/gate.mjs' --config '${cfg}'`);
  writeFileSync(task, `Bash(node ${old}/collector/fence.mjs *)`);
  writeFileSync(empty, "no scripts here");
  const run = (...files) => spawnSync(process.execPath, [CLI, cfg, ...files], { encoding: "utf8", env: { ...process.env, FLIGHT_BOARD_INSTALL_ROOT: root } });
  const bad = run(settings, task);
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /CHECK FAILED .*unknown field "keeperRole"/);
  assert.match(bad.stdout, /hooks check: FAILED/);
  const good = run(settings);
  assert.equal(good.status, 0, good.stdout + good.stderr);
  assert.match(good.stdout, /1 pinned copy accepts the config/);
  assert.equal(run(join(work, "missing.txt")).status, 1, "an unreadable file fails");
  assert.equal(run(empty).status, 2);
  assert.equal(spawnSync(process.execPath, [CLI], { encoding: "utf8" }).status, 2, "usage");
  // Without the override, the real install root is used: a folder named in a file is not it.
  const outside = spawnSync(process.execPath, [CLI, cfg, settings], { encoding: "utf8", env: { ...process.env, FLIGHT_BOARD_INSTALL_ROOT: "" } });
  assert.equal(outside.status, 1);
  assert.match(outside.stdout, /not a pinned copy/);
});
