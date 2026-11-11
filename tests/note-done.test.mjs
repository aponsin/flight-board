// #C844: the owner types "done" in the note box of a Terminal ask and presses Send; the page sent it as Help. A note that only says
// done/ok/closed is Done; Help stays for real trouble.
import test from "node:test";
import assert from "node:assert/strict";
import { loadNames } from "./harness.mjs";

const { replyAct } = loadNames(["replyAct"]);

test("a note that only says done, ok or closed sends Done instead of Help", () => {
  for (const n of ["done", "Done.", " done! ", "OK", "okay", "closed", "all done", "Completed"]) assert.equal(replyAct("help", n, false), "done", n);
});

test("real trouble stays Help: a question, a longer note, pasted output, or any file", () => {
  for (const n of ["done but it failed", "why did it stop?", "error: ENOENT\nnot done", "", "ok then what"]) assert.equal(replyAct("help", n, false), "help", JSON.stringify(n));
  assert.equal(replyAct("help", "done", true), "help", "with a file attached it is a report");
});

test("only the Help button's send is changed: Done, Ack, change and other keep their act", () => {
  for (const a of ["done", "ack", "change", "other", "ok", "chose"]) assert.equal(replyAct(a, "done", false), a);
});
