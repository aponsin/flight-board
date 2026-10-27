import test from "node:test";
import assert from "node:assert/strict";
import { loadBoard, loadNames, step, renderWaitingHtml } from "./harness.mjs";

const T = 1_800_000_000_000;
function item(b, init, steps, fields = {}) {
  b.state.steps = steps;
  b.state.waiting = [];
  return b.gates(b.enrich({ id: init, level: "Quick", customerText: false, skip: ["plan"], status: "active", name: "X", ...fields }));
}

test("a phase nobody has started yet shows as 'up next', not as work in progress", () => {
  const b = loadBoard();
  const i = item(b, "x", [step("x", "build", "Admin", "start", T), step("x", "build", "Admin", "end", T + 1), step("x", "checker", "Checker", "start", T + 2), step("x", "checker", "Checker", "end", T + 3)]);
  assert.equal(i.phase, "ship");
  assert.equal(i.upNext, true);
  const html = b.initRow(i);
  assert.match(html, /class="step upnext"[^>]*>Ship<small>up next<\/small>/);
  assert.doesNotMatch(html, /class="step now"/);
});

test("a phase someone is working on shows as now, with who", () => {
  const b = loadBoard();
  const i = item(b, "x", [step("x", "build", "Admin", "start", T), step("x", "build", "Admin", "end", T + 1), step("x", "checker", "Checker", "start", T + 2)]);
  assert.equal(i.phase, "checker");
  assert.ok(!i.upNext);
  assert.match(b.initRow(i), /class="step now"[^>]*>Checker<small>Checker/);
});

// ---- Phases and who is on what ----

test("two agents working at once light both phases; the most advanced one is current", () => {
  const b = loadBoard();
  const i = item(b, "x", [step("x", "build", "Builder", "start", T), step("x", "build", "Builder", "end", T + 1), step("x", "checker", "Checker", "start", T + 2), step("x", "build", "Admin", "start", T + 3)]);
  assert.equal(i.phase, "checker");
  assert.deepEqual(Object.keys(i.nowPhases).sort(), ["build", "checker"]);
  assert.deepEqual([...i.nowPhases.build], ["Admin"]);
  const html = b.initRow(i);
  assert.match(html, /class="step now"[^>]*>Build<small>Admin/);
});

test("a second start by the same agent closes its first one", () => {
  const b = loadBoard();
  const i = item(b, "x", [step("x", "build", "Builder", "start", T), step("x", "build", "Builder", "start", T + 60000), step("x", "build", "Builder", "end", T + 120000)]);
  assert.ok(!i.nowPhases.build, "no open build step left");
});

test("the Test phase is hidden when no test step was logged, shown when one was", () => {
  const b = loadBoard();
  const without = item(b, "x", [step("x", "build", "Demos", "start", T), step("x", "build", "Demos", "end", T + 1)]);
  assert.ok(without.skip.includes("test"));
  assert.doesNotMatch(b.initRow(without), />Test</);
  const withTest = item(b, "x", [step("x", "build", "Demos", "start", T), step("x", "build", "Demos", "end", T + 1), step("x", "test", "Demos", "start", T + 2)]);
  assert.equal(withTest.phase, "test");
  assert.match(b.initRow(withTest), /class="step now"[^>]*>Test<small>Demos/);
});

test("skips: Security only at level Full, Linguist only when customer text changes", () => {
  const b = loadBoard();
  const quick = item(b, "x", [], { level: "Quick", customerText: false });
  assert.ok(quick.skip.includes("security") && quick.skip.includes("language"));
  const full = item(b, "x", [], { level: "Full", customerText: true });
  assert.ok(!full.skip.includes("security") && !full.skip.includes("language"));
});

// ---- Ship and live ----

test("a live step closes the item with its version and ship minutes", () => {
  const b = loadBoard();
  const i = item(b, "x", [step("x", "ship", "Release", "start", T), step("x", "live", "Release", "end", T + 600000, { version: "v9.9.9", testsMin: 6.2, deployMin: 2.4 })]);
  assert.equal(i.status, "done");
  assert.equal(i.version, "v9.9.9");
  assert.equal(i.shipDetail, "tests 6 min · deploy 2 min");
});

test("a partial ship (ship end, no live step) keeps the item open (2026-10-18)", () => {
  const b = loadBoard();
  const i = item(b, "x", [step("x", "build", "Demos", "start", T), step("x", "build", "Demos", "end", T + 1), step("x", "ship", "Release", "start", T + 2), step("x", "ship", "Release", "end", T + 3)]);
  assert.notEqual(i.status, "done");
});

test("while Release ships, the Ship box shows Release and the test/deploy estimate", () => {
  const b = loadBoard();
  const i = item(b, "x", [step("x", "ship", "Release", "start", Date.now() - 3 * 60000)]);
  const html = b.initRow(i);
  assert.match(html, /Ship<small>Release/);
  assert.match(html, /tests \(est\.\) 3\/~10 min/);
});

// ---- Waits and gates ----

test("a busy wait shows a Queued box before its phase; ending it removes the live pulse", () => {
  const b = loadBoard();
  const open = item(b, "x", [step("x", "ship", "Release", "start", T, { wait: "busy" })]);
  assert.match(b.initRow(open), /class="wait busy live"[^>]*>⧗ Queued<small>Release/);
  const closed = item(b, "x", [step("x", "ship", "Release", "start", T, { wait: "busy" }), step("x", "ship", "Release", "end", T + 1, { wait: "busy" }), step("x", "ship", "Release", "start", T + 2)]);
  assert.doesNotMatch(b.initRow(closed), /wait busy live/);
});

test("an open question to Owner tied to an item gates it on Owner", () => {
  const b = loadBoard();
  b.state.steps = [step("x", "build", "Admin", "start", T), step("x", "build", "Admin", "end", T + 1)];
  b.state.waiting = [{ id: "q", initiative: "x", phase: "ship", since: T + 2, text: "OK to ship?" }];
  const i = b.gates(b.enrich({ id: "x", level: "Quick", customerText: false, skip: ["plan"], status: "active", name: "X" }));
  assert.equal(i.who, "Owner");
  assert.match(i.waitingOn, /Owner: OK to ship\?/);
});

// ---- Next line ----

test("the Next line says how old it is, and dims when an agent logged a step since", () => {
  const b = loadBoard();
  const i = item(b, "x", [step("x", "build", "Admin", "start", T + 5000)], { nextNote: "Admin building.", nextNoteAt: T });
  const html = b.initRow(i);
  assert.match(html, /\(written .* ago; an agent has moved since\)/);
  assert.match(html, /opacity:\.6/);
});

// ---- Waiting on Owner: answers and links ----

test("an Answer shows only an Ack button and a follow-up box", () => {
  const b = loadBoard();
  const html = b.replyBox({ id: "a", kind: "answer", text: "x" });
  assert.match(html, /data-act="ack"/);
  assert.doesNotMatch(html, /data-act="done"|data-act="help"|data-act="ok"/);
  assert.match(html, /A follow-up question\? \(optional\)/);
});

test("an acknowledged Answer says so and doesn't claim it was sent to Manager", () => {
  const b = loadBoard();
  const html = b.replyBox({ id: "a", kind: "answer", response: { status: "ack", at: Date.now() } });
  assert.match(html, /You acknowledged this/);
  assert.doesNotMatch(html, /Sending to Manager/);
});

test("any https address becomes a link (g.page included); bare names for common endings; trailing punctuation stays outside", () => {
  const b = loadBoard();
  const out = b.linkify("Review: https://g.page/r/ABC/review. Open example.com/team/project/pull/144, then (https://x.example/a).");
  assert.match(out, /<a href="https:\/\/g\.page\/r\/ABC\/review"[^>]*>https:\/\/g\.page\/r\/ABC\/review<\/a>\./);
  assert.match(out, /<a href="https:\/\/example\.com\/team\/project\/pull\/144"/);
  assert.match(out, /<a href="https:\/\/x\.example\/a"[^>]*>https:\/\/x\.example\/a<\/a>\)/);
});

test("links never let page text inject markup", () => {
  const b = loadBoard();
  const out = b.linkify('<img src=x onerror=alert(1)> https://a.example/"><script>');
  assert.doesNotMatch(out, /<img|<script/);
});

test("decision and action text is linkified too, not only answers", () => {
  const b = loadBoard();
  const s = (b.linkify("Open example.com/team/project/pull/1"));
  assert.match(s, /<a href=/);
});

test("numbered points written inline (\"1) … 2) …\") show one per line in an ask (2026-10-18)", () => {
  const b = loadBoard();
  const out = b.askText("Board tests: 1) a test file; 2) a publish check; 3) tests first. Go?");
  assert.match(out, /Board tests:<br>1\) a test file;<br>2\) a publish check;<br>3\) tests first\. Go\?/);
  assert.equal(b.askText("A) keep it; B) change it"), "A) keep it;<br>B) change it");
  assert.equal(b.askText("Plain sentence (with parentheses)."), "Plain sentence (with parentheses).");
});

test("line breaks in an ask show, and numbered or dashed lines become a real list", () => {
  const b = loadBoard();
  const out = b.askText("How it works:\n1. One thing.\n2. Two <things>.\nSize: large.");
  assert.match(out, /^How it works:<ol class="w-list"><li>One thing\.<\/li><li>Two &lt;things&gt;\.<\/li><\/ol>Size: large\.$/);
  assert.match(b.askText("Defaults:\n- Spanish later\n- no map"), /<ul class="w-list"><li>Spanish later<\/li><li>no map<\/li><\/ul>/);
  assert.equal(b.askText("Line one\nLine two"), "Line one<br>Line two");
});

// ---- Gaps: the board itself flags what Manager forgot ----

test("an open item with no ETA, no next step or no review level is flagged", () => {
  const b = loadBoard();
  const i = item(b, "x", [step("x", "build", "Admin", "start", Date.now())], { level: undefined, etaLive: undefined, nextNote: undefined });
  const g = [...b.gaps(i)];
  assert.ok(g.includes("no ETA") && g.includes("no next step") && g.includes("no review level"), g.join(", "));
});

test("a complete open item has no gaps; a done item is never flagged", () => {
  const b = loadBoard();
  const now = Date.now();
  const ok = item(b, "x", [step("x", "build", "Admin", "start", now)], { etaLive: now + 3600e3, nextNote: "Admin building.", nextNoteAt: now });
  assert.deepEqual([...b.gaps(ok)], []);
  const done = item(b, "x", [step("x", "live", "Release", "end", now, { version: "v1" })]);
  assert.deepEqual([...b.gaps(done)], []);
});

test("a next step older than an hour, or an ETA in the past, is flagged", () => {
  const b = loadBoard();
  const now = Date.now();
  const i = item(b, "x", [step("x", "build", "Admin", "start", now)], { etaLive: now - 60e3, nextNote: "x", nextNoteAt: now - 2 * 3600e3 });
  const g = [...b.gaps(i)];
  assert.ok(g.includes("ETA passed") && g.includes("next step over 1 h old"), g.join(", "));
});

test("an item that went live without Release's ship times is flagged", () => {
  const b = loadBoard();
  const i = item(b, "x", [step("x", "ship", "Release", "start", T), step("x", "live", "Release", "end", T + 1, { version: "v1" })], { skip: ["plan"] });
  assert.ok([...b.gaps(i, { done: true })].includes("no ship times"));
});

test("asks: an action with no steps, or a look question with no screenshots, is flagged", () => {
  const b = loadBoard();
  assert.ok([...b.waitGaps({ kind: "action", text: "Do X" })].includes("no steps"));
  assert.ok([...b.waitGaps({ kind: "decision", text: "OK to ship as it looks?" })].includes("no screenshots"));
  assert.deepEqual([...b.waitGaps({ kind: "decision", text: "OK to ship as it looks?", images: [{ url: "/_blob/abc" }] })], []);
  assert.deepEqual([...b.waitGaps({ kind: "answer", text: "x", question: "y" })], []);
});

test("the item row shows its gaps as a warning line", () => {
  const b = loadBoard();
  const i = item(b, "x", [step("x", "build", "Admin", "start", Date.now())], { etaLive: undefined, nextNote: "x", nextNoteAt: Date.now() });
  assert.match(b.initRow(i), /class="gaps"[^>]*>Manager missed: no ETA/);
});

test("an Answer starts folded, showing its first lines; opening it shows all of it with Ack and the box (2026-10-18)", () => {
  const html = renderWaitingHtml([{ id: "a1", kind: "answer", question: "Q?", text: "A.", since: Date.now(), done: false }]);
  assert.match(html, /<details class="w-item" data-id="a1">/);
  assert.match(html, /<div class="w-answer">A\.<\/div>/);
  assert.match(html, /data-act="ack"/);
});

test("a folded Answer is clipped to three lines by the page's styles", async () => {
  const { readFileSync } = await import("node:fs");
  const css = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
  assert.match(css, /\.w-item:not\(\[open\]\) \.w-answer\{[^}]*-webkit-line-clamp:3/);
});

// ---- More gaps ----

test("#C278: a wait the repository explains (queued for a board release, waiting for the install) is no stall and raises no step alarms", () => {
  const b = loadBoard();
  const old = Date.now() - 5 * 3600e3;
  const base = { etaLive: Date.now() + 1, nextNote: "x", nextNoteAt: old, createdAt: old };
  const derived = (wait) => { b.state.derived = [{ id: "all", cards: { "board-x": { phase: "ship", wait, evidence: "e" } } }]; };
  for (const [wait, says] of [["release", "Queued for board release"], ["install", "Waiting for install"]]) {
    derived(wait);
    const i = item(b, "board-x", [step("board-x", "build", "Boardsmith", "start", old - 1), step("board-x", "build", "Boardsmith", "end", old)], base);
    assert.equal(b.stalled(i), 0, wait);
    assert.ok(![...b.gaps(i)].some((g) => /over 1 h old|never started/.test(g)), wait);
    assert.match(b.initRow(i), new RegExp(says));
    assert.doesNotMatch(b.initRow(i), /Stalled/);
    const fresh = item(b, "board-x", [], { ...base, lastStepAt: undefined });
    assert.ok(![...b.gaps(fresh)].includes("never started"), `${wait}: no step logged is fine while waiting`);
  }
  // Without a known wait (or an unknown one) the alarms are as before.
  for (const wait of [undefined, "lunch", "constructor"]) {
    derived(wait);
    const i = item(b, "board-x", [step("board-x", "build", "Boardsmith", "start", old - 1), step("board-x", "build", "Boardsmith", "end", old)], base);
    assert.ok(b.stalled(i) > 0, String(wait));
    assert.ok([...b.gaps(i)].includes("next step over 1 h old"), String(wait));
  }
});

test("9. stalled: in flight with no step for 30+ min shows a Stalled flag, not a Manager-missed line", () => {
  const b = loadBoard();
  const old = Date.now() - 31 * 60e3;
  const base = { etaLive: Date.now() + 1, nextNote: "x", nextNoteAt: Date.now() };
  const i = item(b, "x", [step("x", "build", "Admin", "start", old - 1), step("x", "build", "Admin", "end", old)], base);
  assert.equal(b.stalled(i), 31);
  assert.ok(![...b.gaps(i)].some((g) => /stalled/.test(g)));
  // An open step that has run 30+ min with nothing logged is stalled too: the board can't tell work from a hang.
  const open = item(b, "x", [step("x", "build", "Admin", "start", old)], base);
  assert.equal(b.stalled(open), 31);
  const fresh = item(b, "x", [step("x", "build", "Admin", "start", Date.now() - 1), step("x", "build", "Admin", "end", Date.now())], base);
  assert.equal(b.stalled(fresh), 0);
  // Queued behind a busy agent, or held by Owner, or done: not stalled.
  const queued = item(b, "x", [step("x", "build", "Admin", "start", old, { wait: "busy" })], base);
  assert.equal(b.stalled(queued), 0);
  b.state.waiting = [{ id: "w", initiative: "x", since: old, text: "pick" }];
  const gated = b.gates(b.enrich({ id: "x", level: "Quick", customerText: false, skip: ["plan"], status: "active", name: "X", ...base }));
  assert.equal(b.stalled(gated), 0);
  const done = item(b, "x", [step("x", "build", "Admin", "start", old - 2), step("x", "live", "Release", "end", old, { version: "v1" })], base);
  assert.equal(b.stalled(done), 0);
  // The row says so, with the last step's time.
  const row = b.initRow(i);
  assert.match(row, /class="state stalled">Stalled</);
  assert.match(row, /class="stall">No step logged for 31 min \(last at /);
  assert.doesNotMatch(b.initRow(fresh), /Stalled/);
});

test("10. never started: created 15+ min ago with no step logged", () => {
  const b = loadBoard();
  const i = item(b, "x", [], { createdAt: Date.now() - 16 * 60e3, etaLive: Date.now() + 1, nextNote: "x", nextNoteAt: Date.now() });
  assert.ok([...b.gaps(i)].includes("never started"));
});

test("11. (retired, #C211) a card without a planned version is no gap: the board shows the repository's version", () => {
  const b = loadBoard();
  const base = { etaLive: Date.now() + 1, nextNote: "x", nextNoteAt: Date.now() };
  assert.ok(![...b.gaps(item(b, "x", [step("x", "build", "A", "start", Date.now())], { ...base, level: "Quick" }))].some((g) => /planned version/.test(g)));
});

test("12. a choice written as A) ... B) ... without the A/B buttons", () => {
  const b = loadBoard();
  assert.ok([...b.waitGaps({ kind: "decision", text: "Pick: A) this; B) that." })].includes("no A/B buttons"));
  assert.ok(![...b.waitGaps({ kind: "decision", text: "Pick: A) this; B) that.", options: [{ key: "A" }, { key: "B" }] })].includes("no A/B buttons"));
});

test("13. an answer with no 'You asked' question", () => {
  const b = loadBoard();
  assert.ok([...b.waitGaps({ kind: "answer", text: "x" })].includes("no question"));
});

test("14. the header's Live now version older than the newest shipped version", () => {
  const b = loadBoard();
  assert.equal(b.liveGap({ version: "v1.52.1" }, [{ version: "v1.53.0", at: 2 }, { version: "v1.52.1", at: 1 }]), "Live now shows v1.52.1 but v1.53.0 shipped");
  assert.equal(b.liveGap({ version: "v1.53.0" }, [{ version: "v1.53.0", at: 2 }]), "");
  assert.equal(b.liveGap({ version: "v1.9.0" }, [{ version: "v1.10.0", at: 2 }]), "Live now shows v1.9.0 but v1.10.0 shipped");
});

// ---- File attachments on replies ----

test("attachments: images, PDFs and text files up to 15 MB are accepted; others refused with a plain reason", () => {
  const b = loadBoard();
  const f = (name, type, size = 1000) => ({ name, type, size });
  const fc = (x) => ({ ...b.fileCheck(x) });
  assert.deepEqual(fc(f("shot.png", "image/png")), { type: "image/png" });
  assert.deepEqual(fc(f("a.JPG", "image/jpeg")), { type: "image/jpeg" });
  assert.deepEqual(fc(f("doc.pdf", "application/pdf")), { type: "application/pdf" });
  assert.deepEqual(fc(f("notes.md", "")), { type: "text/markdown" });
  assert.deepEqual(fc(f("list.csv", "application/vnd.ms-excel")), { type: "text/csv" });
  assert.deepEqual(fc(f("log.txt", "text/plain;charset=utf-8")), { type: "text/plain" });
  assert.deepEqual(fc(f("d.json", "application/json")), { type: "application/json" });
  assert.match(fc(f("big.png", "image/png", 15 * 1024 * 1024 + 1)).error, /over 15 MB/);
  assert.match(fc(f("IMG_1.HEIC", "image/heic")).error, /HEIC.*JPEG/);
  assert.match(fc(f("a.zip", "application/zip")).error, /can't take/);
});

test("attachments: every note box gets Attach, a hidden file picker and a paste/drop hint when the board can store files", () => {
  const html = renderWaitingHtml([{ id: "w1", kind: "action", text: "Do it", steps: ["x"], since: Date.now(), done: false }], { assets: true });
  assert.match(html, /<button type="button" class="attach" data-attach="w1">Attach<\/button>/);
  assert.match(html, /<input type="file" id="file-w1" data-files="w1" multiple hidden accept="[^"]*image\/png[^"]*application\/pdf[^"]*">/);
  assert.match(html, /paste or drop/i);
  const none = renderWaitingHtml([{ id: "w1", kind: "action", text: "Do it", steps: ["x"], since: Date.now(), done: false }]);
  assert.doesNotMatch(none, /data-attach=/);
});

test("attachments: chosen files show as removable chips, names escaped; they survive a re-draw", () => {
  const html = renderWaitingHtml([{ id: "w1", kind: "answer", question: "q", text: "a", since: Date.now(), done: false }], { assets: true, pending: { w1: [{ name: "<b>x</b>.png", type: "image/png", size: 2.5 * 1024 * 1024 }] } });
  assert.match(html, /<span class="fchip">(?:<button type="button" class="thumb fthumb"[^>]*><img [^>]*><\/button>)?&lt;b&gt;x&lt;\/b&gt;\.png <small>2\.5 MB<\/small><button type="button" class="fx" data-unattach="w1" data-n="0" aria-label="Remove &lt;b&gt;x&lt;\/b&gt;\.png">×<\/button><\/span>/);
});

test("attachments: a sent reply shows its files from the board's stored copies, never in a new tab; bad ids are dropped", () => {
  const html = renderWaitingHtml([{ id: "w1", kind: "action", text: "Do it", steps: ["x"], since: Date.now(), done: false, ping: "sent",
    response: { status: "help", note: "see", at: Date.now(), files: [{ id: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6", name: "err.png", type: "image/png" }, { id: "../evil", name: "bad" }] } }]);
  assert.match(html, /<button type="button" class="thumb fthumb" data-full="\/_blob\/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6" data-cap="err\.png"><img src="\/_blob\/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6"/);
  assert.doesNotMatch(html, /evil/);
  assert.doesNotMatch(html, /target="_blank"/);
});

test("attachments: the ping to Manager names each file with its id, so Manager can download it", () => {
  const b = loadBoard();
  const t = b.pingText({ text: "Do it" }, "w1", { status: "help", note: "broken", files: [{ id: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6", name: "err.png" }] });
  assert.match(t, /^Board reply \[w1\]: asked for help on "Do it"\. Note: broken Files \(1\): err\.png = a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6$/);
  assert.equal(b.pingText({ text: "Q" }, "w2", { status: "ack" }), 'Board reply [w2]: acknowledged on "Q".');
});

// ---- Look questions: derived from the config's look words and visual lanes (#C344, tests/look-derived.test.mjs) ----

test("a look question needs screenshots: a look word in it, or look: true; look: false no longer opts out", () => {
  const b = loadBoard();
  const has = (w) => [...b.waitGaps({ kind: "decision", ...w })].includes("no screenshots");
  assert.ok(has({ text: "OK to ship as it looks?" }));
  assert.ok(has({ text: "Anything", look: true }));
  assert.ok(has({ text: "Should agents attach a screenshot to every READY?" }), "the Director's card: screenshot is a look word");
  assert.ok(has({ text: "OK to ship as it looks?", look: false }));
  assert.ok(!has({ text: "The run failed: retry it?" }));
});

test("attachments: a picture shows as a small preview in its chip, which opens full size; other files show their name only", () => {
  const html = renderWaitingHtml([{ id: "w1", kind: "action", text: "x", steps: ["x"], since: Date.now(), done: false }], { assets: true, pending: { w1: [{ name: "shot.png", type: "image/png", size: 2048 }, { name: "log.txt", type: "text/plain", size: 10 }] } });
  assert.match(html, /<span class="fchip"><button type="button" class="thumb fthumb" data-full="blob:test\/shot\.png" data-cap="shot\.png"><img src="blob:test\/shot\.png" alt="Preview of shot\.png"><\/button>shot\.png/);
  assert.doesNotMatch(html, /blob:test\/log\.txt/);
});

test("a preview in a chip opens in the same full-size view as screenshots", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
  assert.match(src, /thumb\.closest\("\.shots,\.files,\.sentfiles,\.btns"\)/);
});

test("'Who is on what' is a collapsible panel, closed by default", async () => {
  const { readFileSync } = await import("node:fs");
  const page = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
  const box = page.match(/<details[^>]*id="crewbox"[^>]*>([\s\S]*?)<\/details>/);
  assert.ok(box, "crew sits inside <details id=\"crewbox\">");
  assert.doesNotMatch(box[0].split(">")[0], /\bopen\b/);
  assert.match(box[1], /<summary>[\s\S]*Who is on what[\s\S]*<\/summary>/);
  assert.match(box[1], /id="crew"/);
});

test("picture viewer: pinch, double-tap, trackpad and +/- zoom are wired, and zoom resets per picture", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
  assert.match(src, /id="lb-scroll"/);
  assert.match(src, /id="lb-in" onclick="zoomBy\(1\.5\)"/);
  assert.match(src, /addEventListener\("touchmove",[^\n]*passive:false/);
  assert.match(src, /addEventListener\("dblclick"/);
  assert.match(src, /e\.ctrlKey/);
  assert.match(src, /function showShot\(\)\{[^\n]*resetZoom\(\)/);
  assert.match(src, /touch-action:pan-x pan-y/);
});

test("the usage note names the board's first day only from the config (boardStart), never a team's own history", async () => {
  const { loadNames } = await import("./harness.mjs");
  const { usageNoteText } = loadNames(["usageNoteText"]);
  assert.doesNotMatch(usageNoteText("", 0), /started/);
  assert.match(usageNoteText("2026-01-05", 0), /The board started on 2026-01-05, so that day is partial\./);
  assert.match(usageNoteText("", 2.5e6), /About 2\.5M tokens/);
  const page = (await import("node:fs")).readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
  assert.doesNotMatch(page, /Oct 14/);
});

test("open cards: by status, then the furthest phase first, then the sooner ETA (board-sort-progress)", () => {
  const b = loadNames(["openOrder"]);
  const t = Date.now() + 36e5;
  const cards = [
    { id: "build-late", status: "active", phase: "build", etaLive: t + 2e6 },
    { id: "paused-ship", status: "paused", phase: "ship", etaLive: t },
    { id: "checker", status: "active", phase: "checker", etaLive: t + 9e6 },
    { id: "build-soon", status: "active", phase: "build", etaLive: t },
    { id: "queued-security", status: "queued", phase: "security", etaLive: t },
    { id: "ship", status: "active", phase: "ship", etaLive: t + 9e6 },
    { id: "stuck-plan", status: "stuck", phase: "plan", etaLive: t },
    { id: "plan", status: "active", phase: "plan", etaLive: t },
    { id: "security", status: "active", phase: "security", etaLive: t + 9e6 },
  ];
  assert.deepEqual(cards.slice().sort(b.openOrder).map((c) => c.id),
    ["stuck-plan", "ship", "security", "checker", "build-soon", "build-late", "plan", "queued-security", "paused-ship"]);
});
