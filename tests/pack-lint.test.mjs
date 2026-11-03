// #C638: the pack lint. The v3.51 install stopped on a backup an older pack had left under the same name; a pack names its
// backups with the full dotted version and never compares with one.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lintPack } from "../scripts/pack-lint.mjs";

// The lines of the v3.51 pack as first issued (the stop) and as re-issued.
const FIRST = [
  'if [ "$(sum "$DEST")" != "$COLLECTOR_NEW" ]; then',
  '  [ -e "$DEST.before-v351" ] || cp -p "$DEST" "$DEST.before-v351"',
  '  cp "$SETNEW" "$DEST"',
  'fi',
  '[ "$(sed "s#install/$COLL_PIN_SHA/#install/$SHA/#g" "$DEST.before-v351" | shasum -a 256 | cut -d\' \' -f1)" = "$COLLECTOR_NEW" ] || { echo "STOP: differs"; exit 1; }',
].join("\n");
const REISSUE = [
  'ok "$OLDSET" "$COLLECTOR"',
  'if [ "$(sum "$DEST")" != "$COLLECTOR_NEW" ]; then',
  '  [ -e "$DEST.before-v3.51" ] || cp -p "$DEST" "$DEST.before-v3.51"',
  '  cp "$SETNEW" "$DEST"',
  'fi',
  '[ "$(sed "s#install/$COLL_PIN_SHA/#install/$SHA/#g" "$OLDSET" | shasum -a 256 | cut -d\' \' -f1)" = "$COLLECTOR_NEW" ] || { echo "STOP: differs"; exit 1; }',
].join("\n");

test("the first v3.51 issue fails on both rules; the re-issue is clean", () => {
  const rules = lintPack(FIRST).map((p) => p.line + ":" + p.rule.split(" ")[0]);
  assert.deepEqual(rules, ["2:a", "5:a", "5:compares"], "the creation line is an undotted name only; the sed line is an undotted name and a read");
  assert.deepEqual(lintPack(REISSUE), []);
});

test("a dotted backup may be made, restored, named in a message or a comment", () => {
  const ok = [
    '[ -e "$CFG.before-v3.51" ] || cp -p "$CFG" "$CFG.before-v3.51"',
    '[ -z "$BAD" ] || { cp -p "$CFG.before-v3.51" "$CFG"; echo "STOP: refused; the old config is back ($CFG.before-v3.51)"; exit 1; }',
    '# the old settings are kept as .before-v351 in v3.50 and older packs',
    'echo "the old settings are $USER_SETTINGS.before-v3.51"',
  ].join("\n");
  assert.deepEqual(lintPack(ok), []);
});

test("a read of a backup fails, whatever the tool; a marked line with a reason passes", () => {
  for (const tool of ['cmp -s "$F" "$F.before-v3.51"', 'diff "$F" "$F.before-v3.51"', 'shasum -a 256 "$F.before-v3.51"', 'grep -q x "$F.before-v3.51"', 'B="$F.before-v3.51" node -e "1"']) {
    assert.deepEqual(lintPack(tool).map((p) => p.rule.slice(0, 8)), ["compares"], tool);
  }
  assert.deepEqual(lintPack('diff "$F" "$F.before-v3.51" # pack-lint: ok the backup is made by this run just above'), []);
  assert.equal(lintPack('diff "$F" "$F.before-v3.51" # pack-lint: ok').length, 1, "a mark with no reason does not count");
});

test("a pack with no backups is clean, and the CLI exits 1 on a problem and 0 on a clean pack", () => {
  assert.deepEqual(lintPack('ok "$CFG" "$CONFIG"\ncp "$A" "$B"'), []);
  const dir = mkdtempSync(join(tmpdir(), "fb-lint-")), bad = join(dir, "bad.sh"), good = join(dir, "good.sh");
  writeFileSync(bad, FIRST); writeFileSync(good, REISSUE);
  const run = (f) => { try { return { code: 0, out: execFileSync("node", ["scripts/pack-lint.mjs", f], { encoding: "utf8" }) }; } catch (e) { return { code: e.status, out: String(e.stdout) }; } };
  assert.equal(run(good).code, 0); assert.match(run(good).out, /clean/);
  assert.equal(run(bad).code, 1); assert.match(run(bad).out, /bad\.sh:5: compares with a backup/);
});
