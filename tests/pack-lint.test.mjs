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
  assert.deepEqual(rules, ["2:a", "5:a", "5:uses"], "the creation line is an undotted name only; the sed line is an undotted name and a read");
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
  for (const tool of ['cmp -s "$F" "$F.before-v3.51"', 'diff "$F" "$F.before-v3.51"', 'shasum -a 256 "$F.before-v3.51"', 'grep -q x "$F.before-v3.51"', 'B="$F.before-v3.51" node -e "1"',
    // Checker's: every one of these read a backup and passed the first version of the lint.
    'awk 1 "$F.before-v3.51"', 'cat "$F.before-v3.51" | wc -c', 'python3 -c 1 "$F.before-v3.51"', 'X=$(head -1 "$F.before-v3.51")', 'echo "$(diff "$F" "$F.before-v3.51")"',
    'diff "$F" \\\n  "$F.before-v3.51"', 'echo `cat "$F.before-v3.51"`']) {
    assert.deepEqual(lintPack(tool).map((p) => p.rule.slice(0, 4)), ["uses"], tool);
  }
  assert.equal(lintPack('diff "$F" \\\n  "$F.before-v3.51"')[0].line, 1, "a continued command is reported at its first line");
  assert.deepEqual(lintPack('diff "$F" "$F.before-v3.51" # pack-lint: ok the backup is made by this run just above'), []);
  assert.equal(lintPack('diff "$F" "$F.before-v3.51" # pack-lint: ok').length, 1, "a mark with no reason does not count");
});

test("a pack with no backups is clean, and the CLI exits 1 on a problem and 0 on a clean pack", () => {
  assert.deepEqual(lintPack('ok "$CFG" "$CONFIG"\ncp "$A" "$B"'), []);
  const dir = mkdtempSync(join(tmpdir(), "fb-lint-")), bad = join(dir, "bad.sh"), good = join(dir, "good.sh");
  writeFileSync(bad, FIRST); writeFileSync(good, REISSUE);
  const run = (f) => { try { return { code: 0, out: execFileSync("node", ["scripts/pack-lint.mjs", f], { encoding: "utf8" }) }; } catch (e) { return { code: e.status, out: String(e.stdout) }; } };
  assert.equal(run(good).code, 0); assert.match(run(good).out, /clean/);
  assert.equal(run(bad).code, 1); assert.match(run(bad).out, /bad\.sh:5: uses a backup/);
});

test("#C664: a pack that removes or disables a scheduled task or source must name its replacement's install log", () => {
  for (const line of ['launchctl bootout "gui/$(id -u)/com.example.old-probe"', 'launchctl unload "$HOME/Library/LaunchAgents/com.example.old.plist"', 'rm -f "$HOME/Library/LaunchAgents/com.example.old.plist"',
    'launchctl disable "gui/501/com.example.old"', 'echo y | claude scheduled-task delete board-collector', 'disable the scheduled task "board-collector"', 'rm "$HOME/x/old.plist" # pack-lint: ok removing it']) {
    const r = lintPack(line);
    assert.equal(r.length, 1, line);
    assert.match(r[0].rule, /without naming its replacement's install log/);
  }
  assert.equal(lintPack('launchctl bootout "gui/501/com.example.old" # pack-lint: replaced-by board-v3.60-install.log').length, 0, "named: clean");
  assert.equal(lintPack('launchctl bootout "gui/501/com.example.old" # pack-lint: replaced-by').length, 1, "a mark with no log does not count");
  assert.equal(lintPack('launchctl bootout "gui/501/com.example.old" # pack-lint: replaced-by it').length, 1, "a name that is no .log does not count");
  assert.equal(lintPack('launchctl bootout "gui/501/com.example.old" \\\n  # pack-lint: replaced-by board-v3.60-install.log').length, 0, "a continued command is read whole, mark included");
  // Security's and Checker's indirect forms: every one passed the first version of rule 3.
  for (const pack of ['launchctl "bootout" "gui/501/com.example.old"', 'L=launchctl\n$L bootout "gui/501/com.example.old"', 'launchctl kill TERM "gui/501/com.example.old"',
    'P="$HOME/Library/LaunchAgents/com.example.old.plist"\nrm -f "$P"', 'mv ~/Library/LaunchAgents/x.plist /tmp/', 'mv ~/Library/LaunchAgents/x.plist ~/old.plist.off', 'find ~/Library/LaunchAgents -name "x*" -delete',
    'rm -rf ~/.claude/scheduled-tasks/board-collector', 'echo "launchctl bootout x" | sh', 'D=~/.claude/scheduled-tasks/old\nrm -rf "${D}"', 'P="$HOME/Library/LaunchAgents/x.plist"\nmv "$P" "$P.off"', 'L=launchctl; $L bootout "gui/501/com.example.old"', 'P=~/Library/LaunchAgents/x.plist && rm -f "$P"']) {
    assert.equal(lintPack(pack).length, 1, pack);
  }
  assert.equal(lintPack('launchctl bootout "gui/501/x" # pack-lint: replaced-by board-v3.60.log').length, 1, "the named log must be an install log");
  assert.deepEqual(lintPack('mv "$HOME/Library/LaunchAgents/x.plist.tmp" "$HOME/Library/LaunchAgents/x.plist"\nmv x.plist.tmp x.plist'), [], "installing a plist from its temp file retires nothing (Checker)");
  assert.deepEqual(lintPack('P="$HOME/Library/LaunchAgents/x.plist"\ncat > "$P" <<EOF\nEOF\nmv "$TMP" "$P"\nlaunchctl bootstrap "gui/501" "$P"\nlaunchctl kickstart "gui/501/x"\nL=launchctl\n$L print "gui/501/x"'), [], "writing a plist, bootstrap, kickstart and print retire nothing");
  assert.deepEqual(lintPack('# launchctl bootout x\necho "run: launchctl bootout x yourself"\nlaunchctl print "gui/501/com.example.new" >/dev/null\nlaunchctl bootstrap "gui/501" "$P"'), [], "comments, plain messages, print and bootstrap retire nothing");
});
