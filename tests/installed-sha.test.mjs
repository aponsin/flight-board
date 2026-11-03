// What counts as installed (#C639): the release moves the installed link to the newest main, but the hooks and the probe stay
// on the pinned copy until the owner installs a pack, so a card only on main must not read as live. Fictional paths.
import test from "node:test";
import assert from "node:assert/strict";
import { installedSha } from "../collector/state.mjs";

const OLD = "a".repeat(40), MAIN = "b".repeat(40), ROOT = "/h/.flight-board/install";
const link = (target) => () => target;
const none = () => { throw new Error("ENOENT"); };

test("a probe running from a pinned copy beside the link's target reports that copy, not the link's newer main", () => {
  assert.equal(installedSha("/h/.flight-board/current", `${ROOT}/${OLD}`, link(`${ROOT}/${MAIN}`)), OLD);
});

test("the link when the run is not a pinned copy beside it (a checkout, another install root, a link to a short name)", () => {
  assert.equal(installedSha("/h/.flight-board/current", "/work/flight-board", link(`${ROOT}/${MAIN}`)), MAIN);
  assert.equal(installedSha("/h/.flight-board/current", `/elsewhere/install/${OLD}`, link(`${ROOT}/${MAIN}`)), MAIN);
  assert.equal(installedSha("/h/.flight-board/current", `${ROOT}/${OLD}`, link(`${ROOT}/short`)), null);
});

test("nothing installed when there is no link, even for a pinned run", () => {
  assert.equal(installedSha("/h/.flight-board/current", `${ROOT}/${OLD}`, none), null);
});
