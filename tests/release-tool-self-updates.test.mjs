// #C1043: the owner chose B on #T1903 (2026-11-12): the release tool (scripts/board-release.mjs) self-updates on land, so a change to it needs no owner pack, while the
// hooks and the other pinned files still do.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { verdict, RELEASE_ENTRIES } from "../scripts/board-release.mjs";
import { OWNER_ENTRIES, importClosure } from "../scripts/current.mjs";
import { REPO, scratch } from "./helpers/release-scratch.mjs";

const read = (f) => { try { return readFileSync(join(REPO, f), "utf8"); } catch { return null; } };
const SIGNED = { checker: "PASS Full", security: "SECURE" };

test("the closure: the release tool is not in it; the hooks, the gate, the landing job and the link move still are", () => {
  const owned = importClosure([...OWNER_ENTRIES, ...RELEASE_ENTRIES], read);
  assert.ok(!owned.includes("scripts/board-release.mjs"));
  for (const f of ["hooks/red-ask-board.py", "gate/gate.mjs", "gate/publish.mjs", "collector/fence.mjs", "scripts/board-land.mjs", "scripts/current.mjs", "scripts/hooks.mjs"]) assert.ok(owned.includes(f), f);
});

test("verdict: a change to board-release.mjs alone needs no waiting pack; a change to a hook or another pinned file is refused without one", () => {
  const owned = importClosure([...OWNER_ENTRIES, ...RELEASE_ENTRIES], read);
  const base = { forward: true, notes: SIGNED, pinned: "1".repeat(40), owned, settingsChanged: false, capabilities: ["db"], pending: null };
  assert.deepEqual(verdict({ ...base, changed: ["scripts/board-release.mjs", "tests/x.test.mjs"] }).refusals, []);
  for (const f of ["hooks/red-ask-board.py", "gate/gate.mjs", "collector/fence.mjs", "scripts/board-land.mjs", "scripts/current.mjs"]) {
    const v = verdict({ ...base, changed: [f] });
    assert.equal(v.ok, false, f);
    assert.match(v.refusals.join("\n"), new RegExp(`owner's install.*${f.replace(/[./]/g, "\\$&")}`), f);
  }
  const mixed = verdict({ ...base, changed: ["scripts/board-release.mjs", "hooks/red-ask-board.py"] });
  assert.match(mixed.refusals.join("\n"), /hooks\/red-ask-board\.py/);
  assert.doesNotMatch(mixed.refusals.join("\n"), /board-release\.mjs/);
});

test("end to end on a scratch origin: a signed change to board-release.mjs passes the dry run with no pack waiting", () => {
  const s = scratch({ withNotes: true });
  try {
    const r = s.run(s.X);
    assert.ok(r.ok, r.out);
    assert.match(r.out, /nothing pinned changed since/);
  } finally { rmSync(s.D, { recursive: true, force: true }); }
});
