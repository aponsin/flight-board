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
import { initiativeDoc, shownLevel } from "../worker/compat-view.mjs";

export const BOARD_SECURITY_PATHS = [
  "worker/**", "gate/**", "hooks/**", "keeper/**", ".githooks/**", ".github/**", ".claude/**", "scripts/hooks.mjs", "scripts/hooks-check.mjs", "scripts/install.mjs",
  "scripts/state-install.mjs", "scripts/make-pair.mjs", "scripts/pack-lint.mjs", "scripts/pair/**", "scripts/current.mjs", "scripts/self-deploy-*.mjs",
  "scripts/board-land.mjs", "scripts/board-release.mjs", "scripts/board-recut.mjs", "scripts/push-keys.mjs", "scripts/put-file.mjs", "scripts/scan.mjs",
  "scripts/trailer-check.mjs", "scripts/stack-ready.mjs", "scripts/sign-note.mjs", "scripts/approvals-check.mjs", "scripts/config.mjs", "collector/review-paths.mjs",
  "scripts/wake-watch.mjs", "scripts/prompt-watch.mjs", "scripts/pickup-watch.mjs", "scripts/restart-check.mjs", "scripts/restart-ready.mjs", "page/**",
  "scripts/build-page.mjs", "scripts/build-store-page.mjs", "wrangler.jsonc", "wrangler.toml", "*.plist", "**/*.plist", "**/settings*.json", "package.json",
  "package-lock.json",
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
    "wrangler.jsonc", ".github/workflows/ci.yml", ".claude/settings.json", "launchd/com.example.board.plist", "com.example.board.plist", "docs/settings.local.json", "package.json",
    // The reviewers' findings (Checker 2's M1, Security's M2 and M3 and lows): who reviews, the deploy pair, the pins, the hooks, the page, the scripts a model acts on.
    ".githooks/pre-push", "scripts/pair/deploy/hooks.mjs", "scripts/current.mjs", "scripts/sign-note.mjs", "scripts/approvals-check.mjs", "scripts/stack-ready.mjs", "scripts/config.mjs",
    "collector/review-paths.mjs", "scripts/board-recut.mjs", "page/board.template.html", "scripts/build-page.mjs", "scripts/build-store-page.mjs",
    "scripts/wake-watch.mjs", "scripts/prompt-watch.mjs", "scripts/pickup-watch.mjs", "scripts/restart-check.mjs", "scripts/restart-ready.mjs"]) {
    assert.deepEqual(needs({ level: "Quick" }, [f]), ["checker", "security"], f);
  }
});

// Manager's ruling on the card: collector/** (apart from the engine that decides who reviews) stays Quick for now; the owner decides it on the board.
test("a Quick card that touches only docs, tests or the collector keeps the typed rule: no Security", () => {
  for (const f of ["docs/DATA.md", "tests/anything.test.mjs", "CHANGELOG.d/x.md", "collector/probe-evidence.mjs", "collector/store-dispatch.mjs", "scripts/changelog.mjs", "README.md", "DECISIONS.md"]) {
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

// Manager's ruling on the card: the card's shown level reads Full whenever the probe raised Security's review on it (waiting, signed, or signed with a time), whatever was typed.
test("the card's shown level reads Full when Security's review is in play on it; typed Full stays; nothing else is raised", () => {
  const card = (review_level) => ({ id: "c-x", title: "X", num: 5, review_level, owner_role: "Builder", created_at: 1, updated_at: 2 });
  const shown = (typed, value) => initiativeDoc(card(typed), value === undefined ? undefined : { value }).level;
  assert.equal(shown("Quick", { waitingFor: ["checker", "security"] }), "Full", "security waits");
  assert.equal(shown("Quick", { waitingFor: ["security"] }), "Full");
  assert.equal(shown("Quick", { signed: ["checker", "security"] }), "Full", "security signed");
  assert.equal(shown("Quick", { reviews: { security: 1_800_000_000_000 } }), "Full", "signed with a time");
  assert.equal(shown("None", { waitingFor: ["security"] }), "Full");
  assert.equal(shown(null, { waitingFor: ["security"] }), "Full", "no level typed");
  assert.equal(shown("Full", { waitingFor: ["checker"] }), "Full", "typed Full stays");
  assert.equal(shown("Quick", { waitingFor: ["checker"] }), "Quick", "no Security: as typed");
  assert.equal(shown("Quick", { signed: ["checker"], reviews: { checker: 1 } }), "Quick");
  assert.equal(shown("Quick", undefined), "Quick", "no evidence: as typed");
  assert.equal(shown("Quick", { waitingFor: "security" }), "Quick", "a word that is no list raises nothing");
  assert.equal(shown("Quick", { reviews: ["security"] }), "Quick", "reviews as a list is no map of times");
  assert.equal(shownLevel("Quick", null), "Quick");
});

test("a pattern is anchored: a file that only contains a listed name, or a sibling directory, does not match", () => {
  for (const f of ["myworker/x.mjs", "docs/worker/x.md", "workers/x.mjs", "gates/x.mjs", "scripts/hooks.mjs.bak", "scripts/hooks-extra.mjs", "package.json.md", "notes/wrangler.jsonc.txt", "scripts/self-deploy-a/b.mjs"]) { // the last: a single * stops at a slash
    assert.deepEqual(needs({ level: "Quick" }, [f]), ["checker"], f);
  }
});
