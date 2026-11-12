// #C1037: a failed fetch of origin's notes refuses the release, naming the ref, the remote and git's error, and never reads stale notes. (#C1032 made the fetch
// loud with git() instead of quiet(); this is its test, and the message.) A good fetch behaves as before.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { scratch } from "./helpers/release-scratch.mjs";

test("a good fetch of the notes: the signed commit passes the dry run as before", () => {
  const s = scratch({ withNotes: true });
  try {
    const r = s.run(s.X);
    assert.ok(r.ok, r.out);
    assert.match(r.out, /PASS/);
  } finally { rmSync(s.D, { recursive: true, force: true }); }
});

test("a failed fetch (origin has no notes refs) refuses, naming the ref, origin and git's error", () => {
  const s = scratch({ withNotes: false });
  try {
    const r = s.run(s.X);
    assert.equal(r.ok, false, r.out);
    assert.match(r.out, /Not released: the fetch of refs\/notes\/(security|checker) from origin failed, so the notes may be stale: .*couldn't find remote ref/);
  } finally { rmSync(s.D, { recursive: true, force: true }); }
});
