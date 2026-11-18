// A card counts "release" issues (#C1212, release-issue-kind; the owner's #T2043, A): each time a ship of the card stops for a reason that is not the
// card's own code (a ship-tool refusal, a DECISIONS/CHANGELOG merge glitch, a stopped ship, a missing re-sign after a main merge). The sixth issue kind,
// beside bugs, security, language, design and owner: the gate takes the key, both tool schemas list it, the page draws "2 release".
import test from "node:test";
import assert from "node:assert/strict";
import { ISSUE_KINDS, cardWriteRefusal } from "../worker/board-rules.mjs";
import { TOOLS } from "../worker/board-worker.mjs";
import { loadNames } from "./harness.mjs";

test("the gate accepts issues.release, 0 to 99, and still refuses every other key and shape", () => {
  assert.ok(ISSUE_KINDS.includes("release"));
  assert.equal(cardWriteRefusal({ issues: { release: 2 } }, null), null);
  assert.equal(cardWriteRefusal({ issues: { release: 0, bugs: 1, owner: 1 } }, null), null);
  for (const bad of [{ release: -1 }, { release: 100 }, { release: 1.5 }, { release: "2" }, { releases: 1 }, { luck: 1 }]) {
    assert.equal(cardWriteRefusal({ issues: bad }, null)?.rule, "card-issues", JSON.stringify(bad));
  }
});

test("card_create and card_update list release among the issue kinds", () => {
  for (const name of ["card_create", "card_update"]) {
    const props = TOOLS.find((t) => t.name === name).inputSchema.properties.issues.properties;
    assert.deepEqual(Object.keys(props).sort(), [...ISSUE_KINDS].sort(), name);
    assert.deepEqual(props.release, { type: "integer" }, name);
  }
});

test("the page shows \"2 release\" for issues.release = 2, and \"1 release\" for one", () => {
  const { issueChips, railChips } = loadNames(["issueChips", "railChips"]);
  assert.ok(issueChips({ issues: { release: 2 } }).includes('<span class="chip ">2 release</span>'));
  assert.ok(issueChips({ issues: { release: 1 } }).includes('<span class="chip ">1 release</span>'));
  assert.ok(issueChips({}).includes('<span class="chip zero">0 release</span>'));
  assert.ok(railChips({ issues: { release: 2 } }).includes('<span class="chip">2 release</span>'));
  assert.ok(!railChips({ issues: { bugs: 1 } }).includes("release"), "a kind at 0 is not drawn in the rail");
});
