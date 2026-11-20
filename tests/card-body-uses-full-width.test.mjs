// #C1344 (the owner, t-1795186002164, an open card inside a group): its body sat in a narrow column beside the card's buttons (move up and down, Move to..., Pull out) and
// the space under the buttons stayed empty. On a laptop the open card keeps its title row and buttons at the top right and its body runs the card's full width; a phone,
// a narrow window and a closed card keep the row as it was.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadNames } from "./harness.mjs";

const html = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
const rule = (sel) => { const m = html.match(new RegExp(`${sel.replace(/[.[\]>()*:^$+?|\\]/g, "\\$&")}\\{([^}]*)\\}`)); return m && m[1]; };
const wide = html.match(/@media \(min-width:1000px\)\{([\s\S]*?)\n\}/)[1];

test("a card's three controls sit in one .g-ctl wrapper after its details, and the wrapper is display:contents by default so the row is as it was", () => {
  const el = () => ({ innerHTML: "", textContent: "", hidden: false, classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, querySelectorAll: () => [], querySelector: () => null, dataset: {}, setAttribute() {} });
  const document = { documentElement: { getAttribute: () => "store" }, getElementById: el, querySelectorAll: () => [], querySelector: () => null, addEventListener() {}, activeElement: null, createRange: () => ({}) };
  const b = loadNames(["groupRow", "gates", "enrich", "probeEvent", "state"], { document });
  const raw = ["a", "b"].map((id, k) => ({ id, num: k + 1, name: `Card ${k}`, size: "S", level: "Quick", status: "active", phase: "build", who: "Boardsmith", repo: "flight-board", batch: "g5-thing", branch: `build/${id}`, createdAt: 1_800_000_000_000 + k }));
  Object.assign(b.state, { initRaw: raw, initiatives: raw.map((i) => b.gates(b.enrich(i))), steps: [], waiting: [], derived: [], messages: [], threads: [] });
  b.probeEvent({ type: "data", result: { payload: { v: 1, board: { at: Date.now() - 20e3 }, cards: {}, agents: {} } } }, {});
  const out = b.groupRow("g5-thing", b.state.initiatives);
  const cards = out.split('<div class="g-card">').slice(1);
  assert.equal(cards.length, 2);
  for (const c of cards) {
    const after = c.split("</details>")[c.split("</details>").length - 1];
    assert.match(after, /^<div class="g-ctl">.*data-moveto=.*data-pull=.*<\/div><\/div>/s, "the controls follow the details inside one wrapper");
    assert.equal((c.match(/class="g-ctl"/g) || []).length, 1);
  }
  assert.equal(rule(".g-ctl"), "display:contents");
});

test("on a laptop an open card's details take the full row and its buttons sit at the top right, with the summary kept clear of them", () => {
  assert.match(wide, /\.g-card>details\[open\]\{flex:1 1 100%\}/);
  assert.match(wide, /\.g-card:has\(>details\[open\]\)>\.g-ctl\{[^}]*position:absolute;top:8px;right:0/);
  assert.match(wide, /\.g-card>details\[open\]>summary\{padding-right:min\(45%,22rem\)/);
  assert.match(wide, /\.g-card:has\(>details\[open\]\)\{position:relative\}/);
});

test("must still allow: nothing changes under 1000 px or on a closed card, and the buttons wrap inside 45% of the card so they never run into its text", () => {
  assert.doesNotMatch(html.replace(wide, ""), /\.g-card:has\(>details\[open\]\)/, "the open-card rules live only in the laptop block");
  assert.match(wide, />\.g-ctl\{[^}]*flex-wrap:wrap[^}]*max-width:45%/);
  assert.match(rule(".g-card>details"), /flex:1 1 16rem/);
});
