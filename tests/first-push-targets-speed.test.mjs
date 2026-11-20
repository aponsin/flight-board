// #C1291 (Security INFO on #C1289): gate/first-push.mjs's bashTargets (and the commit check's heredoc masking) looked for a heredoc's closing line from every "<<" to the end of the
// command, so a command of many unterminated "<<" took about 2.7 s at 200 KB. replaceHeredocs reads the same way in linear time. These tests pin the speed and prove the same reading
// against the old regex on thousands of random commands.
import test from "node:test";
import assert from "node:assert/strict";
import { bashTargets, boardIdRefusal, refusal, replaceHeredocs } from "../gate/first-push.mjs";

const OLD = /(<<-?[ \t]*(["']?)(\w+)\2[^\n]*)\n[\s\S]*?\n[ \t]*\3[ \t]*(?=\n|$)/g;
const oldDrop = (t) => t.replace(OLD, "$1");
const oldMask = (t) => t.replace(OLD, (m, head) => head + "Q".repeat(m.length - head.length));
const newDrop = (t) => replaceHeredocs(t, (head) => head);
const newMask = (t) => replaceHeredocs(t, (head, rest) => head + "Q".repeat(rest));
const noGit = () => { throw new Error("no git may run for this check"); };

// A small deterministic random source, so a failure can be replayed.
const rng = (seed) => () => (seed = (seed * 1_664_525 + 1_013_904_223) >>> 0) / 2 ** 32;

test("same reading as the old regex on 20000 random commands (heredocs closed, unclosed, quoted, indented, on one line, here-strings, CRLF)", () => {
  const pieces = ["cat <<EOF\n", "EOF\n", "EOF", " EOF  \n", "\tEOF\t\n", "x\n", "\n", "<<'A'\n", '<<"A"\n', "<<-A\n", "A\n", "echo hi > f.txt\n", "<<<w\n", "<<A <<B\n", "B\n", "<<A", " ; ", "a <<EOF b\n", "EOF\r\n", "<<\n", "<< EOF\n", "<<'EOF\n", "cat > out.txt <<X\nbody\nX\n", "<<A\n\nA\n", "<<A\nA\n", "<<AB\n", "AB\n", "<<ABC\n", "ABC\n", "<<'AB'\n", "<<AA\n", "AA\n"];
  const r = rng(11);
  for (let n = 0; n < 20_000; n++) {
    let t = ""; const k = 1 + Math.floor(r() * 12);
    for (let i = 0; i < k; i++) t += pieces[Math.floor(r() * pieces.length)];
    assert.equal(newDrop(t), oldDrop(t), JSON.stringify(t));
    assert.equal(newMask(t), oldMask(t), JSON.stringify(t));
  }
});

test("a long command of many unterminated heredoc starts is read in well under a second, in each shape", () => {
  const shapes = {
    "same tag, one per line": "cat <<X\n".repeat(25_000),
    "distinct tags, one per line": Array.from({ length: 20_000 }, (_, i) => `cat <<T${i}\n`).join(""),
    "all on one line": "cat " + "<<X ".repeat(40_000),
    "closed far away": "cat <<X\n".repeat(25_000) + "X\n",
    "git commit and unterminated starts": "git commit -m x\n" + "cat <<X\n".repeat(25_000),
    "heredocs closed, one after another": "cat <<X\nb\nX\n".repeat(15_000),
  };
  for (const [name, cmd] of Object.entries(shapes)) {
    const t0 = performance.now();
    bashTargets(cmd); boardIdRefusal(cmd);
    refusal({ tool_name: "Bash", tool_input: { command: cmd }, cwd: "/nowhere" }, noGit, []);
    const ms = performance.now() - t0;
    assert.ok(ms < 1000, `${name}: took ${Math.round(ms)} ms`);
  }
});

test("what the guard reads is unchanged: redirections, tee, cp and a heredoc body that is only text", () => {
  assert.deepEqual(bashTargets("echo hi > out.txt"), ["out.txt"]);
  assert.deepEqual(bashTargets("cat > msg.txt <<'EOF'\nthis > not.txt\nEOF"), ["msg.txt"]);
  assert.deepEqual(bashTargets("cat <<EOF\nrm -rf x\nEOF\ntouch a.txt"), ["a.txt"]);
  assert.deepEqual(bashTargets("cat <<EOF > b.txt\nx\nEOF"), ["b.txt"]);
  assert.ok(boardIdRefusal(`git commit -F - <<'EOF'\nx\n\nBoard-Id: C1274\nEOF`), "a bad trailer inside a heredoc is still refused");
  assert.equal(boardIdRefusal(`cat > f <<'EOF'\nBoard-Id: C1274\nEOF`), null);
});
