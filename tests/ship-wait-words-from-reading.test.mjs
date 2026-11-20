// #C1382 (replaces tests/ship-tile-says-who-acts.test.mjs, #C1288, which locked the words of the old knownWait functions): a card's wait is drawn from its reading, and the words say who acts.
// A deploy wait is Release's (it acts; nothing waits on the owner), and the owner's install is the owner's. The tile's small line holds about 14 characters on a phone.
import test from "node:test";
import assert from "node:assert/strict";
import { loadNames } from "./harness.mjs";

const b = () => loadNames(["waitTileWord", "waitPillWord", "RELEASE_ROLE", "OWNER"]);
const plain = (h) => h.replace(/<[^>]*>/g, "");

test("a deploy wait names the release role on the tile (short) and in the status line, never the owner", () => {
  const p = b(), R = { wait: "deploy", with: p.RELEASE_ROLE }, i = { id: "x" };
  assert.equal(p.waitTileWord(i, R), `${p.RELEASE_ROLE}<span class="sl"> ships</span>`);
  assert.ok(plain(p.waitTileWord(i, R)).length <= 14 + " ships".length, "the .sl part is hidden on a phone, so the phone sees the role alone");
  assert.ok(p.RELEASE_ROLE.length <= 14);
  assert.equal(p.waitPillWord(i, R), `Queued for ${p.RELEASE_ROLE}'s ship`);
  assert.doesNotMatch(p.waitPillWord(i, R), new RegExp(p.OWNER));
});

test("the owner's install names the owner, with the pack's number when the reading carries one; a bad pack word is never drawn", () => {
  const p = b(), i = { id: "x" };
  assert.equal(p.waitTileWord(i, { wait: "install", pack: "pc111" }), `pc111<span class="sl"> · ${p.OWNER}</span>`);
  assert.equal(p.waitTileWord(i, { wait: "install", pack: null }), `${p.OWNER}<span class="sl">'s install</span>`);
  assert.equal(p.waitTileWord(i, { wait: "install", pack: "<b>x</b>" }), `${p.OWNER}<span class="sl">'s install</span>`);
  assert.equal(p.waitPillWord(i, { wait: "install" }), "Waiting for install");
});
