// #C917 (split from #C898): landing a commit no longer produces the old artifact board's republish. After #C873 the landing
// wrote board-5da811e.html beside the config and printed "Page: ... Republish it as the board". The old board is frozen and
// the store page ships with the owner's deploy pair. Source-level, as tests/pack-label.test.mjs reads this tool.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../scripts/board-release.mjs", import.meta.url), "utf8");

test("the landing prints no republish line and names no page to publish", () => {
  assert.doesNotMatch(src, /Republish it/i);
  assert.doesNotMatch(src, /console\.log\(`Page:/);
});

test("the page is built only in the tool's temporary folder, never beside the config", () => {
  assert.match(src, /const page = join\(tmp, `board-\$\{sha\.slice\(0, 7\)\}\.html`\)/);
  assert.doesNotMatch(src, /join\(out, `board-/);
  assert.match(src, /finally \{ if \(tmp\) rmSync\(tmp, \{ recursive: true, force: true \}\); \}/, "and the folder goes when the run ends");
});

test("Still allowed: the page still builds and its scenarios are still a check, and a changed prompt is still printed", () => {
  assert.match(src, /scripts\/build-page\.mjs"\), configPath, page\]/);
  assert.match(src, /page builds and its scenarios pass/);
  assert.match(src, /the page didn't build/);
  assert.match(src, /console\.log\(`Prompt: \$\{promptPath\}/);
});
