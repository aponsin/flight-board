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

// Drives the page's own onReply: the note box's Send on a Terminal ask, and what is stored.
async function send(note, act = "help") {
  const saved = [];
  const b = loadNames(["onReply", "state", "pendingFiles", `set:(w)=>{dbRef={doc:()=>({update:async()=>{}})};prepAnchor=async()=>null;storeFiles=async()=>[];pingManager=async()=>true;applyWrites=async(x)=>{w.push(...x)};settleRedraw=()=>{}}`]);
  b.set(saved);
  b.state.waiting = [{ id: "t1763", kind: "terminal" }];
  b.els["note-t1763"] = { value: note };
  b.els["msg-t1763"] = { textContent: "" };
  await b.onReply({ currentTarget: { dataset: { id: "t1763", act }, hasAttribute: (a) => a === "data-csend", disabled: false } });
  return saved[0]?.data?.response;
}

test("onReply: the note 'done' on a Terminal ask is stored as Done; 'done but it failed' stays Help", async () => {
  const done = await send("done");
  assert.equal(done?.status, "done");
  assert.equal((await send("Done.")).status, "done");
  assert.equal((await send("done but it failed")).status, "help");
  assert.equal((await send("error: ENOENT")).status, "help");
});

test("only the Help button's send is changed: Done, Ack, change and other keep their act", () => {
  for (const a of ["done", "ack", "change", "other", "ok", "chose"]) assert.equal(replyAct(a, "done", false), a);
});
