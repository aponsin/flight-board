// #C1108 (the rule "board and tooling cards are Quick unless they touch hooks, the Worker, permissions or the Mac" lived in the lead's memory; a launchd change was set Full by
// hand): the board's own repository gets a reviewPaths table (collector.repos[].reviewPaths, the mechanism of #C897) whose `security` list is those paths, so a card that touches
// one has Security's review whatever level it was typed at, and a card that touches none keeps the typed rule. This pins the table the config carries (BOARD_SECURITY_PATHS, the
// same list as docs/review-paths-board.md) against the engine, path kind by path kind, with the live config's skips.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { reviewsFromPaths, pathPhases } from "../collector/review-paths.mjs";
import { reviewPathsErrors } from "../scripts/config.mjs";

export const BOARD_SECURITY_PATHS = [
  "worker/**", "gate/**", "hooks/**", "keeper/**",
  "scripts/hooks.mjs", "scripts/hooks-check.mjs", "scripts/install.mjs", "scripts/state-install.mjs", "scripts/make-pair.mjs", "scripts/pack-lint.mjs",
  "scripts/self-deploy-*.mjs", "scripts/board-land.mjs", "scripts/board-release.mjs", "scripts/push-keys.mjs", "scripts/put-file.mjs", "scripts/scan.mjs", "scripts/trailer-check.mjs",
  "wrangler.jsonc", "wrangler.toml", ".github/**", ".claude/**", "*.plist", "**/*.plist", "**/settings*.json", "package.json", "package-lock.json",
];
const TABLE = { security: BOARD_SECURITY_PATHS };
// The live config's skips: Security is skipped unless the card is Full; the Checker has none.
const config = { collector: { notes: { checker: "refs/notes/checker", security: "refs/notes/security" } }, skips: [{ phase: "security", unlessLevel: "Full" }] };
const typedFor = (card) => (card.level && card.level !== "Full" ? ["checker"] : ["checker", "security"]);
const needs = (card, paths) => reviewsFromPaths(card, config, typedFor(card), TABLE, paths);

test("the table is a valid reviewPaths table", () => {
  assert.deepEqual(reviewPathsErrors({ security: BOARD_SECURITY_PATHS }, ["checker", "security"], "collector.repos[0].reviewPaths"), []);
  assert.equal(reviewPathsErrors({ security: ["../x"] }, ["checker", "security"]).length, 1, "the validator refuses a path that climbs out");
});

test("docs/review-paths-board.md carries the same list as this test: the config is copied from it", () => {
  const doc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "review-paths-board.md"), "utf8");
  const m = /```json\n([\s\S]*?)\n```/.exec(doc);
  assert.ok(m, "a json block");
  assert.deepEqual(JSON.parse(m[1]), { security: BOARD_SECURITY_PATHS });
});

test("a Quick card that touches one of each path kind has Security's review added; the Checker stays", () => {
  for (const f of ["worker/board-store.mjs", "worker/knobs.mjs", "gate/reset.mjs", "gate/hooks/stop.mjs", "hooks/red-ask-board.py", "keeper/keeper.mjs",
    "scripts/hooks.mjs", "scripts/install.mjs", "scripts/state-install.mjs", "scripts/make-pair.mjs", "scripts/self-deploy-run.mjs", "scripts/board-land.mjs",
    "wrangler.jsonc", ".github/workflows/ci.yml", ".claude/settings.json", "launchd/com.example.board.plist", "com.example.board.plist", "docs/settings.local.json", "package.json"]) {
    assert.deepEqual(needs({ level: "Quick" }, [f]), ["checker", "security"], f);
  }
});

test("a Quick card that touches only docs, tests, the page or the collector keeps the typed rule: no Security", () => {
  for (const f of ["docs/DATA.md", "tests/anything.test.mjs", "page/board.template.html", "CHANGELOG.d/x.md", "collector/probe-evidence.mjs", "scripts/changelog.mjs", "README.md"]) {
    assert.deepEqual(needs({ level: "Quick" }, [f]), ["checker"], f);
  }
  assert.deepEqual(needs({ level: "Quick" }, ["docs/DATA.md", "tests/a.test.mjs", "collector/state.mjs"]), ["checker"]);
});

test("one touching path among many is enough", () => {
  assert.deepEqual(needs({ level: "Quick" }, ["docs/DATA.md", "tests/a.test.mjs", "worker/board-rules.mjs", "page/board.template.html"]), ["checker", "security"]);
});

test("a Full card stays Full whatever it touches: the paths only raise", () => {
  assert.deepEqual(needs({ level: "Full" }, ["docs/DATA.md"]), ["checker", "security"]);
  assert.deepEqual(needs({ level: "Full" }, ["worker/x.mjs"]), ["checker", "security"]);
});

test("no diff read, or no table, leaves the typed rule as before", () => {
  assert.deepEqual(reviewsFromPaths({ level: "Quick" }, config, typedFor({ level: "Quick" }), TABLE, null), ["checker"]);
  assert.deepEqual(reviewsFromPaths({ level: "Quick" }, config, typedFor({ level: "Quick" }), null, ["worker/x.mjs"]), ["checker"]);
  assert.deepEqual(pathPhases(TABLE, []), new Set());
});

test("a pattern is anchored: a file that only contains a listed name, or a sibling directory, does not match", () => {
  for (const f of ["myworker/x.mjs", "docs/worker/x.md", "workers/x.mjs", "gates/x.mjs", "scripts/hooks.mjs.bak", "scripts/hooks-extra.mjs", "package.json.md", "notes/wrangler.jsonc.txt", "scripts/self-deploy-a/b.mjs"]) { // the last: a single * stops at a slash
    assert.deepEqual(needs({ level: "Quick" }, [f]), ["checker"], f);
  }
});
