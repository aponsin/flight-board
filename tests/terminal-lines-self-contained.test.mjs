// #C921 (prevention for #T1802): every Terminal line works when run on its own. The ask rule refuses a command that only changes
// folder, and make-pair writes each pair line with the folder's full path and no cd line.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { askRefusal } from "../worker/board-rules.mjs";
import { makeAll } from "../scripts/make-pair.mjs";

const terminal = (commands) => ({ type: "Terminal", title: "Copy the job check", asked_by: "Manager", commands });

test("a Terminal ask with a cd on its own line is refused, naming the line", () => {
  for (const line of ["cd ~/Documents/Code/app/scripts", "cd", "  cd /tmp/x  ", "pushd ~/x", "cd -"]) {
    const r = askRefusal(terminal([line, "cp runner-job-check.sh ~/actions-runner-app/job-check.sh"]));
    assert.equal(r?.rule, "terminal-bare-cd", line);
    assert.ok(r.detail.includes(line.trim()), "the refusal names the line");
  }
  assert.equal(askRefusal(terminal(["node ~/x/a.mjs", "cd ~/x"]))?.rule, "terminal-bare-cd", "any position");
});

test("Still allowed: full or ~ paths, a cd chained in the same line, one command spanning lines, words that start with cd", () => {
  for (const commands of [
    ["cp ~/Documents/Code/app/scripts/runner-job-check.sh ~/actions-runner-app/job-check.sh"],
    ["cd ~/Documents/Code/app/scripts && cp runner-job-check.sh ~/actions-runner-app/job-check.sh"],
    ["cd ~/x; node a.mjs", "cd ~/y || echo missing"],
    ["cd ~/x\nnode a.mjs"],
    ["cdk deploy", "echo cd ~/x"],
  ]) assert.equal(askRefusal(terminal(commands)), null, JSON.stringify(commands));
});

test("the rule is the Terminal type's: an Action step's text is not judged by it", () => {
  const action = { type: "Action", title: "t", asked_by: "Manager", steps: [{ text: "Open Terminal", cmd: "node ~/x/a.mjs" }], expect: "OK" };
  assert.equal(askRefusal(action), null);
});

test("make-pair writes every line with the folder's full path and no cd line", () => {
  const dir = mkdtempSync(join(tmpdir(), "fb-c921-"));
  const bare = join(dir, "origin.git"), work = join(dir, "work"), out = join(dir, "out");
  mkdirSync(out);
  const g = (...a) => execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=T", "-c", "commit.gpgsign=false", ...a], { cwd: work, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  g("remote", "add", "origin", bare);
  mkdirSync(join(work, "worker"));
  writeFileSync(join(work, "worker", "a.mjs"), "1\n");
  g("add", "-A");
  g("commit", "-qm", "base (#C100)");
  g("push", "-q", "origin", "main");
  const r = makeAll({ repo: work, sha: g("rev-parse", "HEAD"), n: 1, out });
  assert.equal(r.ok, true, r.why);
  const steps = readFileSync(join(out, "board-store-pc1-steps.md"), "utf8");
  const blocks = [...steps.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1].trim());
  assert.equal(blocks.length, 2, "two lines, nothing else to paste");
  for (const b of blocks) {
    assert.equal(askRefusal(terminal([b])), null, "each line passes the Terminal rule");
    assert.doesNotMatch(b, /(^|\s)node board-store-|256 board-store-/, "no relative file");
    assert.ok(b.includes(`node ${out}/board-store-`), "the file by its full path");
  }
  assert.match(steps, /from any folder: every path is full/);
  assert.ok(steps.includes(`rollback --config ${out}/board-store-pa/`), "the undo line too");
  assert.ok(steps.includes(`Undo: \`node ${out}/board-store-tree-pc1.mjs back\``));
});
