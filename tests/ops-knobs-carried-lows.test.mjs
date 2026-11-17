// #C1113 slice 1: the LOWs carried from #C1106 and #C1114.
// Checker 2's LOW on #C1106: silentPushSec had no rule keeping it above one evidence cycle, so 300 s with a 600 s interval would send false "Mac may be down" pushes.
// Designer's note on #C1114: the red "Unexplained rework" chip explained itself only in title=, which a phone never shows; the reason is visible text now.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveKnobs, KNOBS } from "../worker/knobs.mjs";
import { drawPage } from "./helpers/draw-page.mjs";

test("silentPushSec stays over one whole evidence cycle (interval plus limit), as the staleness settings do", () => {
  assert.deepEqual(KNOBS.silentPushSec.over, ["evidenceIntervalSec", "evidenceLimitSec"]);
  // the finding: a 300 s silence against a 600 s interval is refused, naming why, and the default stands
  const bad = resolveKnobs({ evidenceIntervalSec: 600, silentPushSec: 300 });
  assert.equal(bad.values.silentPushSec, 900);
  assert.deepEqual(bad.ignored, [{ key: "silentPushSec", why: "not over interval plus limit" }]);
  // exactly the cycle (600 + 170) is not over it; one second more is
  assert.equal(resolveKnobs({ evidenceIntervalSec: 600, silentPushSec: 770 }).values.silentPushSec, 900);
  assert.deepEqual(resolveKnobs({ evidenceIntervalSec: 600, silentPushSec: 770 }).ignored.map((i) => i.key), ["silentPushSec"]);
  const ok = resolveKnobs({ evidenceIntervalSec: 600, silentPushSec: 771 });
  assert.equal(ok.values.silentPushSec, 771);
  assert.deepEqual(ok.ignored, []);
  // the default interval leaves the whole range open: 300 s is fine against a 60 s interval (cycle 230 s)
  assert.equal(resolveKnobs({ silentPushSec: 300 }).values.silentPushSec, 300);
  assert.deepEqual(resolveKnobs({ silentPushSec: 300 }).ignored, []);
  // a default that has to move because the owner raised the interval moves quietly, and stays valid
  const quiet = resolveKnobs({ evidenceIntervalSec: 600, evidenceLimitSec: 170 });
  assert.equal(quiet.values.silentPushSec, 900);
  assert.deepEqual(quiet.ignored, []);
});

const NOW = Date.now();
const drawn = (extra) => drawPage({ initiatives: [{ id: "c", name: "A card", num: 962, status: "active", phase: "checker", who: "Builder", size: "S", createdAt: NOW - 3600e3, ...extra }] }).html;

test("the red Unexplained rework chip says why in visible text, not only in its title, and still shows how long", () => {
  const html = drawn({ unexplainedRework: true, unexplainedAt: NOW - 5 * 60e3 });
  const chip = /<span class="unexplained-chip"[^>]*>(.*?)<\/span><\/span>/s.exec(html)?.[1] ?? "";
  assert.match(chip, /^Unexplained rework · /);
  assert.match(chip, /<span class="unexplained-why"> — no findings noted and no reason given; the reviewer is asked to file the finding$/);
  const css = readFileSync(fileURLToPath(new URL("../page/board.template.html", import.meta.url)), "utf8");
  assert.match(css, /\.unexplained-chip\{[^}]*max-width:100%;white-space:normal/, "a long chip wraps on a phone instead of running off the row");
  assert.doesNotMatch(drawn({}), /unexplained-why/);
  assert.doesNotMatch(drawn({ unexplainedRework: true, status: "done", doneAt: NOW }), /unexplained-why/);
});
