// Every install pack dry-runs each pinned hook's config check against the config it wrote (#C587). The v3.40 pack left the
// Collector's fence on a copy whose config check refused gate.keeperRole as an unknown field.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { pinnedRoots, dryRun, report } from "../scripts/hooks-check.mjs";

const here = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const CLI = join(here, "scripts", "hooks-check.mjs");
const config = { artifactUrl: "https://claude.ai/" + "artifact/TestBoard01", gate: { keeperRole: "Context keeper" } };

// An older pinned copy: its config check knows no gate.keeperRole.
function oldCopy(dir) {
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(join(dir, "scripts", "config.mjs"), `export const checkConfig = (c) => Object.keys(c.gate ?? {}).filter((k) => k !== "managerRole").map((k) => 'gate: unknown field "' + k + '"');\n`);
  return dir;
}

test("the roots are the folders the texts run scripts from, quotes and repeats aside", () => {
  const text = `node '/x/install/${"a".repeat(40)}/gate/gate.mjs' --config '/c.json'\n"Bash(node /y/pin/collector/fence.mjs *)"\nnode /x/install/${"a".repeat(40)}/gate/stop.mjs`;
  assert.deepEqual(pinnedRoots([text, "nothing here"]), [`/x/install/${"a".repeat(40)}`, "/y/pin"]);
  assert.deepEqual(pinnedRoots([]), []);
});

test("a copy whose config check refuses a field the pack wrote fails; a current copy passes", async () => {
  const dir = oldCopy(mkdtempSync(join(tmpdir(), "pin-")));
  const results = await dryRun([dir, here], config);
  const r = report(results);
  assert.equal(r.ok, false);
  assert.match(r.lines.join("\n"), new RegExp(`CHECK FAILED ${dir}: gate: unknown field "keeperRole"`));
  assert.match(r.lines.join("\n"), new RegExp(`ok ${here}`), "this checkout accepts it");
  assert.equal(report(await dryRun([here], config)).ok, true);
  assert.equal(report(await dryRun([join(tmpdir(), "no-such-pin")], config)).ok, true, "a folder with no config check is skipped, not failed");
  assert.equal(report(await dryRun([join(tmpdir(), "no-such-pin")], config)).checked, 0);
});

test("the command: exit 1 naming the stale copy, 0 when all accept, 2 with nothing to check", () => {
  const dir = oldCopy(mkdtempSync(join(tmpdir(), "pin-")));
  const work = mkdtempSync(join(tmpdir(), "pack-"));
  const cfg = join(work, "board.config.json");
  writeFileSync(cfg, JSON.stringify(config));
  const settings = join(work, "settings.json"), task = join(work, "TASK.md");
  writeFileSync(settings, `node '${here}/gate/gate.mjs' --config '${cfg}'`);
  writeFileSync(task, `Bash(node ${dir}/collector/fence.mjs *)`);
  const run = (...files) => spawnSync(process.execPath, [CLI, cfg, ...files], { encoding: "utf8" });
  const bad = run(settings, task);
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /CHECK FAILED .*unknown field "keeperRole"/);
  assert.match(bad.stdout, /hooks check: FAILED/);
  const good = run(settings);
  assert.equal(good.status, 0, good.stdout + good.stderr);
  assert.match(good.stdout, /1 pinned copy accepts the config/);
  const none = run(join(work, "TASK.md").replace("TASK.md", "empty.txt"));
  assert.equal(none.status, 1, "an unreadable file fails");
  writeFileSync(join(work, "empty.txt"), "no scripts here");
  assert.equal(run(join(work, "empty.txt")).status, 2);
  assert.equal(spawnSync(process.execPath, [CLI], { encoding: "utf8" }).status, 2, "usage");
});
