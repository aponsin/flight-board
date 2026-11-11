// #C917 (split from #C898): landing a commit no longer produces the old artifact board's republish. After #C873 the landing
// wrote board-5da811e.html beside the config and printed "Page: ... Republish it as the board". The old board is frozen and
// the store page ships with the owner's deploy pair. Source-level, as tests/pack-label.test.mjs reads this tool.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../scripts/board-release.mjs", import.meta.url), "utf8");
const has = (re) => re.test(src);

test("the landing prints no republish line and names no page to publish", () => {
  assert.equal(has(/Republish it/i), false, "a 'Republish it' line is back");
  assert.equal(has(/console\.log\(`Page:/), false, "a 'Page:' line is back");
});

test("the page is built only in the tool's temporary folder, never beside the config", () => {
  assert.equal(has(/const page = join\(tmp, `board-\$\{sha\.slice\(0, 7\)\}\.html`\)/), true, "the page is not built in tmp");
  assert.equal(has(/join\(out, `board-/), false, "a page is written beside the config");
  assert.equal(has(/finally \{ if \(tmp\) rmSync\(tmp, \{ recursive: true, force: true \}\); \}/), true, "the temporary folder is not removed");
});

test("Still allowed: the page still builds and its scenarios are still a check, and a changed prompt is still printed", () => {
  assert.equal(has(/scripts\/build-page\.mjs"\), configPath, page\]/), true, "the page is no longer built");
  assert.equal(has(/page builds and its scenarios pass/), true);
  assert.equal(has(/the page didn't build/), true, "a page that does not build no longer refuses");
  assert.equal(has(/console\.log\(`Prompt: \$\{promptPath\}/), true, "a changed prompt is no longer printed");
});
