// #C1389 (the owner: after Approve is clicked nothing shows the click took). The Approve button takes the sending state of a thread reply's button (the grey, the
// pulsing dots: .sbtn / .sdots) and its row looks disabled until the answer is stored (the pull request leaves the list to approve) or the write fails.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadNames } from "./harness.mjs";

const html = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
const css = html.match(/<style>([\s\S]*?)<\/style>/)[1];
const HEAD = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";

function world() {
  const b = loadNames(["renderAgentPrs", "onAgentPr", "applySending", "sending", "SENDING_MAX", "setDb:(d)=>{dbRef=d}", "setApply:(f)=>{applyWrites=f}"]);
  const w = { writes: [], btns: [], rowCls: new Set(), hold: null };
  b.state.agentPrs = [{ id: "pr7", head: HEAD, signedHead: HEAD, title: "A change", checks: "green" }];
  b.state.approvals = [];
  b.setDb({});
  b.setApply((ws) => { w.writes.push(ws); return new Promise((res, rej) => { w.hold = { res, rej }; }); });
  // The one Approve button the page draws, as the page's own markup says it, with the dots as its child.
  const cls = new Set();
  const btn = w.btn = { dataset: { gpa: "1", n: "7", head: HEAD }, disabled: false, textContent: "Approve", dots: null, cls,
    classList: { contains: (c) => cls.has(c), toggle: (c, on) => (on ? cls.add(c) : cls.delete(c)) },
    closest: (s) => (s === ".gp-row" ? { classList: { contains: (c) => w.rowCls.has(c), toggle: (c, on) => (on ? w.rowCls.add(c) : w.rowCls.delete(c)) } } : null),
    querySelector: (s) => (s === ":scope>.sdots" ? btn.dots : null),
    appendChild(h) { btn.dots = h; h.remove = () => { btn.dots = null; }; } };
  b.document.createElement = () => ({ attrs: {}, children: [], className: "", textContent: "", setAttribute(k, v) { this.attrs[k] = v; }, appendChild(c) { this.children.push(c); } });
  b.document.querySelectorAll = (sel) => (String(sel).includes("data-gpa") ? [btn] : []);
  const click = () => b.onAgentPr({ currentTarget: btn });
  return { b, w, btn, click, size: () => b.sending.size };
}

test("before the click the Approve button is the normal one", () => {
  const t = world(); t.b.renderAgentPrs();
  const out = t.b.els.agentprs.innerHTML;
  assert.match(out, /<button type="button" data-gpa="1" data-n="7"[^>]*>Approve<\/button>/);
  assert.match(out, /<div class="gp-row" data-pr="pr7">/, "the row is not marked");
  t.b.applySending();
  assert.ok(!t.btn.cls.has("sbtn") && !t.btn.dots && !t.w.rowCls.has("pending") && t.size() === 0);
});

test("after the click the button wears the sending state (grey, the dots, the word for a reader) and the row is disabled", async () => {
  const t = world(); const p = t.click();
  assert.equal(t.btn.disabled, true);
  assert.ok(t.btn.cls.has("sbtn"), "the same class as a thread reply's send button");
  assert.ok(t.btn.dots && t.btn.dots.className === "sdots", "the same dots element");
  assert.equal(t.btn.dots.children.filter((c) => c.attrs["aria-hidden"] === "true").length, 3, "three dots built by the page's sendDots, as elements");
  assert.ok(t.btn.dots.children.some((c) => c.className === "sr" && c.textContent === "Sending"), "and the word for a reader");
  assert.ok(t.w.rowCls.has("pending"), "the row looks disabled");
  assert.equal(t.w.writes.length, 1);
  assert.match(css, /\.gp-row\.pending\{pointer-events:none\}/, "the row takes no click");
  assert.match(css, /\.gp-row\.pending>:not\(\.gp-act\)\{opacity:\.6\}/);
  assert.match(css, /\.gp-act button\.sbtn\{background:color-mix\(in srgb,var\(--line\) 35%,var\(--panel\)\)/, "the grey of a sending thread, in board tokens");
  t.w.hold.res(); await p;
});

test("a second click posts nothing", async () => {
  const t = world(); const p = t.click();
  t.btn.disabled = false; // even if the button were enabled again by a redraw, the pending mark stops it
  await t.click();
  assert.equal(t.w.writes.length, 1);
  t.w.hold.res(); await p;
});

test("once the answer is stored (the pull request leaves the list to approve) the row is normal again", async () => {
  const t = world(); const p = t.click(); t.w.hold.res(); await p;
  t.b.renderAgentPrs(); // the approval is not in the view yet: still pending
  assert.equal(t.size(), 1);
  t.b.state.approvals = [{ id: "pr7", head: HEAD, at: 1, by: "x" }];
  t.b.renderAgentPrs(); t.b.applySending();
  assert.equal(t.size(), 0, "the mark ends with the row");
  assert.ok(!t.btn.cls.has("sbtn") && !t.btn.dots && !t.w.rowCls.has("pending"));
});

test("a write that fails ends it at once, so the button works again; and it never stays pending for good", async () => {
  const t = world(); const p = t.click(); t.w.hold.rej(new Error("no")); await p;
  assert.equal(t.btn.disabled, false);
  assert.equal(t.size(), 0);
  assert.ok(!t.btn.cls.has("sbtn") && !t.btn.dots && !t.w.rowCls.has("pending"));
  assert.equal(t.btn.textContent, "Not saved: try again", "the existing error line stays");
  const u = world(); const q = u.click(); const at = [...u.b.sending.values()][0];
  u.b.applySending(at + u.b.SENDING_MAX - 1); assert.equal(u.size(), 1);
  u.b.applySending(at + u.b.SENDING_MAX + 1); assert.equal(u.size(), 0, "the time limit of a thread reply's sending state");
  u.w.hold.res(); await q;
});
