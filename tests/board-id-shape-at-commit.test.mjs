// #C1285 (11-19: "Board-Id: C1274" on a product commit; once its branches were deleted nothing could find the card, and the board kept showing a ship in progress): the first-push
// hook (gate/first-push.mjs) also refuses a git commit whose Board-Id trailer, as typed in the command, is not a valid card id (the shape the landing job reads). Text only: no git runs.
import test from "node:test";
import assert from "node:assert/strict";
import { refusal, boardIdRefusal, BOARD_ID_SHAPE, badBoardIdReason } from "../gate/first-push.mjs";
import { BOARD_ID_SHAPE as COLLECTOR_SHAPE } from "../collector/board-id.mjs";

const bash = (command) => ({ tool_name: "Bash", tool_input: { command }, cwd: "/nowhere" });
const noGit = () => { throw new Error("no git may run for this check"); };

test("a git commit with Board-Id: C1274 (uppercase, a number) is refused, naming the right form", () => {
  const why = refusal(bash(`git commit -m "The test sets up its rows at once\n\nBoard-Id: C1274\nCo-Authored-By: X <x@example.com>"`), noGit, []);
  assert.match(why, /Board-Id must be the card's id: lowercase letters, digits and hyphens/);
  assert.match(why, /not "C1274"/);
});

test("other bad values are refused too: a space, an underscore, a slash, a trailing dot, an overlong id", () => {
  for (const v of ["Outreach-Logs", "outreach_logs", "outreach/logs", "outreach.", "-lead", "a".repeat(65)]) assert.ok(boardIdRefusal(`git commit -m "x\n\nBoard-Id: ${v}"`), v);
});

test("a valid card id passes, in -m, in a heredoc, and with the Co-Authored-By line after it", () => {
  assert.equal(boardIdRefusal(`git commit -m "x\n\nBoard-Id: outreach-logs-phone-flake\nCo-Authored-By: X <x@example.com>"`), null);
  assert.equal(boardIdRefusal(`git commit -F - <<'EOF'\nx\n\nBoard-Id: unread-count-owner-only\nEOF`), null);
  assert.equal(boardIdRefusal(`git -C /some/wt commit -m "y\n\nBoard-Id: a1"`), null);
});

test("only a commit is checked: a command that merely mentions a Board-Id (a grep, a log, an echo) is let through", () => {
  assert.equal(boardIdRefusal(`git log --grep="Board-Id: C1274" --format=%H`), null);
  assert.equal(boardIdRefusal(`grep -rn "Board-Id: C1274" docs`), null);
  assert.equal(boardIdRefusal(`echo "Board-Id: C1274"`), null);
  assert.equal(refusal({ tool_name: "Edit", tool_input: { file_path: "/x/y.md", new_string: "Board-Id: C1274" }, cwd: "/nowhere" }, noGit, []), null, "an edit is not a commit");
});

test("what cannot be read is let through, never blocked: a message from a file, a placeholder, a shell expansion, an empty value, odd input", () => {
  assert.equal(boardIdRefusal(`git commit -F msg.txt`), null);
  assert.equal(boardIdRefusal(`git commit -m "x\n\nBoard-Id: <card id>"`), null);
  assert.equal(boardIdRefusal('git commit -m "x\n\nBoard-Id: $ID"'), null);
  assert.equal(boardIdRefusal('git commit -m "x\n\nBoard-Id: "'), null);
  assert.equal(boardIdRefusal(undefined), null);
  assert.equal(boardIdRefusal({}), null);
  assert.equal(refusal(null, noGit, []), null);
});

test("the shape is the one the landing job reads (the collector's), and the refusal text names a real example", () => {
  assert.equal(BOARD_ID_SHAPE.source, COLLECTOR_SHAPE.source);
  assert.ok(BOARD_ID_SHAPE.test("picture-option-looks-clickable"), "the example the message gives is itself valid");
  assert.ok(badBoardIdReason("C1274").includes("#C1285"));
});
