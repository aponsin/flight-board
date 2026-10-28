// A long paste is never cut silently (#C404): on 2026-10-28 the owner pasted the v3.19 install output into its board
// item, the board kept the first 1000 characters with no word, and the auto-reply read the cut as a failure and asked for
// the rest. Now a text over a box's limit goes cut with a line that says so, the full text rides along as a text file,
// the result line tells the owner, and a cut thread ping says so first.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadNames } from "./harness.mjs";

const NOW = 1793210626000;
const output = Array.from({ length: 60 }, (_, k) => `line ${k}: Changed: replaced 5 older flight-board entries; hooks pinned`).join("\n");

test("a text within the limit goes as it is, with no file", () => {
  const b = loadNames(["longPaste", "NOTE_MAX"]);
  assert.equal(b.NOTE_MAX, 1000);
  assert.deepEqual({ ...b.longPaste("  all done  ", 1000, NOW) }, { text: "all done", cut: false, name: null, full: null });
  assert.equal(b.longPaste("x".repeat(1000), 1000, NOW).cut, false, "exactly the limit: not cut");
});

test("a text over the limit goes cut, ending with a line that names the attached full text", () => {
  const b = loadNames(["longPaste"]);
  const lp = b.longPaste(output, 1000, NOW);
  assert.ok(output.length > 3000);
  assert.equal(lp.cut, true);
  assert.equal(lp.name, `full-text-${NOW}.txt`);
  assert.equal(lp.full, output, "the whole text, for the file");
  assert.ok(lp.text.length <= 1000, "fits the box's limit, so nothing cuts the line off");
  assert.ok(lp.text.startsWith(output.slice(0, 200)));
  assert.match(lp.text, new RegExp(`\\n… cut at 1000 characters: the full text \\(${output.length}\\) is attached as full-text-${NOW}\\.txt$`));
});

test("with no asset store, the line asks for the rest in a second message instead", () => {
  const b = loadNames(["longPaste"]);
  const lp = b.longPaste(output, 1000, NOW, false);
  assert.equal(lp.cut, true);
  assert.equal(lp.name, null);
  assert.equal(lp.full, null);
  assert.match(lp.text, /\n… cut at 1000 characters \(\d+ in all\): send the rest in a second message$/);
  assert.ok(lp.text.length <= 1000);
});

test("the full text becomes a pending text file of the box, taken back out if the send stops", async () => {
  const b = loadNames(["longPaste", "attachLong", "pendingFiles"]);
  b.pendingFiles.set("ask-1", [{ name: "shot.png" }]);
  const undo = b.attachLong("ask-1", b.longPaste(output, 1000, NOW));
  const files = b.pendingFiles.get("ask-1");
  assert.deepEqual([...files.map((f) => f.name)], ["shot.png", `full-text-${NOW}.txt`], "beside the owner's own files");
  assert.equal(files[1].type, "text/plain");
  assert.equal(await files[1].text(), output);
  undo();
  assert.deepEqual([...b.pendingFiles.get("ask-1").map((f) => f.name)], ["shot.png"], "a stopped send leaves no stray file for the next try");
  b.attachLong("ask-2", b.longPaste("short", 1000, NOW))();
  assert.equal(b.pendingFiles.get("ask-2"), undefined, "a short text adds nothing");
});

test("the saved reply and message keep the line: the ask's note (1000) and a thread message (2000)", () => {
  const b = loadNames(["longPaste", "replyWrites", "threadWrites", "MAXT", "state"]);
  const lp = b.longPaste(output, 1000, NOW);
  const [ask, msg] = b.replyWrites({ id: "board-v319-install" }, "done", lp.text, [], NOW, null, "abc123");
  assert.equal(ask.data.response.note, lp.text);
  assert.match(msg.data.text, /is attached as full-text-/);
  const lt = b.longPaste(output + output, b.MAXT, NOW);
  assert.match(b.threadWrites("t-1", lt.text, [], NOW, null, "abc123")[0].data.text, /\n… cut at 2000 characters: the full text \(\d+\) is attached as full-text-\d+\.txt$/);
});

test("the result line tells the owner it went cut", () => {
  const b = loadNames(["longPaste", "longLine"]);
  assert.equal(b.longLine(b.longPaste("short", 1000, NOW), 1000), "");
  assert.equal(b.longLine(b.longPaste(output, 1000, NOW), 1000), ` Your text was over 1000 characters: it went cut, with the full text attached as full-text-${NOW}.txt.`);
  assert.equal(b.longLine(b.longPaste(output, 1000, NOW, false), 1000), " Your text was over 1000 characters: it went cut; send the rest in a second message.");
});

test("both send paths use it, and a cut thread ping says so first (the ping is cut at 1,900)", () => {
  const page = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
  assert.match(page, /const lp=longPaste\(note,NOTE_MAX,Date\.now\(\),!!assetsRef\),unattach=attachLong\(id,lp\);/, "the ask's reply");
  assert.match(page, /replyWrites\(w,act,lp\.text,/);
  assert.match(page, /const lp=longPaste\(text,MAXT,Date\.now\(\),!!assetsRef\),unattach=attachLong\(key,lp\);/, "a thread's reply and the new thread");
  assert.match(page, /threadWrites\(id,lp\.text,/);
  assert.match(page, /threadPing\(id,lp\.cut\?`\(long text, cut\$\{lp\.name\?`; the full text is attached as \$\{lp\.name\}`:""\}\) \$\{lp\.text\}`/);
  assert.equal((page.match(/unattach\(\)/g) ?? []).length, 4, "both catch paths of both sends take the file back");
});
