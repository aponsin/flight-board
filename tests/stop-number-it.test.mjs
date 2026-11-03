// #C627: when the owner's word waits in a thread the export has no number for, the Stop gate's ask says to number it in the same
// batch as the reply (the gate takes the lead's reply there only that way), instead of letting the lead try a bare reply first.
import test from "node:test";
import assert from "node:assert/strict";
import { fullConfig } from "../scripts/config.mjs";
import { stopRun } from "../gate/stop.mjs";

const URL_ = "https://claude.ai/" + "artifact/TestBoard01";
const config = fullConfig({ artifactUrl: URL_ });
const NOW = 1_800_000_000_000, MIN = 60e3, DAY = 864e5, LISTED = NOW - 30 * MIN;
const owner = (thread, at = NOW - 40 * MIN) => ({ id: `m${at}-${thread}`, thread, from: "Owner", text: "all done", at });
const view = (messages, threads) => ({ docs: { messages, waiting: [], ...(threads ? { threads } : {}) }, at: LISTED, atBy: { messages: LISTED, waiting: LISTED } });
const T = (at) => new Date(at).toISOString();
const lines = [{ type: "custom-title", customTitle: "Manager" }, { type: "user", timestamp: T(NOW - MIN), message: { content: [{ type: "text", text: "status?" }] } }, { type: "assistant", message: { content: [{ type: "text", text: "Done." }] } }];
const errs = (v) => stopRun(lines, { config, now: NOW, since: NOW - DAY, view: v }).errs;

test("an owner word in a thread with no numbered threads doc: the ask says to number it in the same batch", () => {
  const e = errs(view([owner("c598-hook-install-1793663396840")], [{ id: "other", num: 3, title: "Other" }]));
  assert.equal(e.length, 1);
  assert.match(e[0], /thread c598-hook-install-1793663396840 "all done"/);
  assert.match(e[0], /c598-hook-install-1793663396840 has no number yet, so number it in the same batch \(threads\/<id> \{num, title\} and meta\/threadSeq\) or the gate refuses the reply/);
});

test("no hint for a numbered thread, a page-started t- thread, or an export without threads", () => {
  assert.doesNotMatch(errs(view([owner("c598")], [{ id: "c598", num: 7, title: "Hook install" }]))[0], /no number yet/);
  assert.doesNotMatch(errs(view([owner("t-1793675124027")], [{ id: "other", num: 3, title: "Other" }]))[0], /no number yet/);
  assert.doesNotMatch(errs(view([owner("c598")], null))[0], /no number yet/, "an export with no threads collection: no claim");
});

test("a doc with a number but no title is not numbered; several unnumbered threads are named, at most three", () => {
  assert.match(errs(view([owner("c598")], [{ id: "c598", num: 7 }]))[0], /c598 has no number yet/);
  const e = errs(view(["a-1", "b-2", "c-3", "d-4"].map((t, i) => owner(t, NOW - (40 + i) * MIN)), [{ id: "z", num: 1, title: "Z" }]));
  assert.match(e[0], /have no number yet, so number them/);
  assert.equal((e[0].match(/ has no number yet| have no number yet/g) ?? []).length, 1);
});
