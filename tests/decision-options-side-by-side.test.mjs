// #C1268 (the owner: a decision's options and their pictures stack down the page and take too much room): on a laptop the
// options sit side by side, two to four in a row at equal widths, each picture scaled to its column with its button under
// it; on a phone they stack as before. These tests list what each option must still show, then pin the layout.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderWaitingHtml } from "./harness.mjs";

const page = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
const css = page.slice(page.indexOf("<style>"), page.indexOf("</style>"));
const ask = (n, extra = {}) => ({
  id: "d1", kind: "decision", text: "Which hero?", since: Date.now(), done: false,
  options: ["A", "B", "C", "D"].slice(0, n).map((key, i) => ({ key, label: `option ${i + 1}`, ...(i === 0 ? { recommended: true } : {}) })),
  images: ["A", "B", "C", "D"].slice(0, n).map((o, i) => ({ url: `/_blob/abcdefg${i}`, option: o, label: `picture ${o}` })),
  ...extra,
});
const grid = (html) => html.match(/<div class="opt-grid[^"]*" style="--n:(\d)">([\s\S]*?)<\/div><button type="button" class="other"/);

test("each option still shows its key, label, Manager's pick tag, its pictures with their captions, and the Something else button", () => {
  const html = renderWaitingHtml([ask(3)]);
  for (const k of ["A", "B", "C"]) assert.match(html, new RegExp(`data-choice="${k}" data-id="d1"><b>${k}</b> option`));
  assert.match(html, /<span class="recl">Manager's pick<\/span>/);
  for (const k of ["A", "B", "C"]) assert.match(html, new RegExp(`<span>picture ${k}</span>`));
  assert.match(html, /data-focus="note-d1">Something else \(say what\)<\/button>/);
  assert.equal((html.match(/<div class="opt-line">/g) ?? []).length, 3, "one line (picture over button) per option");
});

test("the options sit in one grid whose column count is the number of options (two to four), with Something else after it, not inside", () => {
  for (const n of [2, 3, 4]) {
    const g = grid(renderWaitingHtml([ask(n)]));
    assert.ok(g, `${n} options: a grid`);
    assert.equal(g[1], String(n), `${n} options: ${n} columns`);
    assert.equal((g[2].match(/class="opt"|class="opt rec"/g) ?? []).length, n, `${n} options inside it`);
    assert.ok(!g[2].includes('class="other"'), "Something else is not a cell of the grid");
  }
});

test("a decision with no pictures keeps its buttons, now in the same grid; one with a single option is one column", () => {
  const plain = renderWaitingHtml([ask(2, { images: [] })]);
  const g = grid(plain);
  assert.equal(g[1], "2");
  assert.ok(!g[2].includes("opt-line"), "no picture lines when there are no pictures");
  assert.equal(grid(renderWaitingHtml([ask(1)]))[1], "1");
});

test("more than four options still read in rows of four: the count is capped", () => {
  const five = ask(4);
  five.options.push({ key: "E", label: "fifth" });
  assert.equal(grid(renderWaitingHtml([five]))[1], "4");
});

test("laptop: equal columns, the picture fills its column and scales to fit, each option's button under its picture", () => {
  assert.match(css, /\.opt-grid\{display:grid;grid-template-columns:repeat\(var\(--n,1\),minmax\(0,1fr\)\);gap:12px;flex:1 0 100%;align-items:start\}/, "equal widths");
  assert.match(css, /\.opt-grid>\.opt-line\{grid-template-columns:minmax\(0,1fr\);row-gap:6px\}/, "inside a column the picture is over its button");
  assert.match(css, /\.opt-shots \.thumb\{width:100%;max-width:none;/, "the picture fills its column");
  assert.match(css, /\.opt-shots \.thumb img\{height:auto;max-height:200px\}/, "scaled to fit, never stretched");
  assert.match(css, /\.opt-shots \.thumb span\{[^}]*-webkit-line-clamp:2/, "its caption on one or two lines");
  assert.match(css, /\.opt-grid>button\.opt\{width:100%\}|\.opt-grid>button\.opt\{[^}]*width:100%/, "a button with no picture fills its cell too");
});

test("a narrower laptop or tablet: three or four options go two to a row; a phone stacks them all", () => {
  assert.match(css, /@media \(max-width:1000px\)\{\.opt-grid\.many\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)\}\}/);
  assert.match(css, /@media \(max-width:760px\)\{[^}]*\.opt-grid,\.opt-grid\.many\{grid-template-columns:minmax\(0,1fr\)\}/);
  assert.match(renderWaitingHtml([ask(3)]), /class="opt-grid many"/, "three or four options carry the class that lets them drop to two columns");
  assert.doesNotMatch(renderWaitingHtml([ask(2)]), /class="opt-grid many"/, "two options stay two columns at every width above a phone");
});

test("the phone layout the owner had is kept: the phone's own rules for the choices and the picture rows are unchanged", () => {
  assert.match(css, /@media \(max-width:600px\)\{\.cchoice\{flex-direction:column;align-items:stretch\}\.cchoice button\{text-align:left\}/);
  assert.match(css, /\.opt-line\+\.opt-line\{margin-top:12px\}/, "the gap between stacked options on a phone");
});
