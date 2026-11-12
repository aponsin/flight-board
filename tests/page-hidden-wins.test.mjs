// #C1029: the "A newer board is live: reload" banner showed on every page although the page sets hidden on it: `.newboard{display:block}` is an author rule, the
// browser's own `[hidden]{display:none}` loses to it, so the attribute did nothing (seen live: hidden=true, computed display block). The same clash can hit
// any element the page ships with the hidden attribute: if a class, id or tag rule sets a display other than none on it, a rule with [hidden] and display:none
// for the same element must beat that. This reads the page's own CSS and markup, so a new rule that brings the clash back fails here.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../page/board.template.html"), "utf8");
const css = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n").replace(/\/\*[\s\S]*?\*\//g, "");
const body = html.slice(html.indexOf("</style>"));

// Flat rules [{ selector (one of the comma list), decls }], at-rule bodies included (the inner rule is matched by itself).
export function rulesOf(text) {
  const out = [];
  for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (/^\s*@/.test(m[1])) continue;
    for (const sel of m[1].split(",")) out.push({ selector: sel.trim(), decls: m[2] });
  }
  return out;
}
// The last compound of a selector as { tag, id, classes, hiddenAttr, notHidden, other }.
export function lastCompound(selector) {
  const c = selector.trim().split(/\s*[>+~]\s*|\s+/).filter(Boolean).at(-1) ?? "";
  const notHidden = /:not\(\s*\[hidden\]\s*\)/.test(c);
  let rest = c.replace(/:not\(\s*\[hidden\]\s*\)/g, "");
  const hiddenAttr = /\[hidden\]/.test(rest); rest = rest.replace(/\[hidden\]/g, "");
  const other = /[\[:]/.test(rest); // any other attribute or pseudo: the rule only applies in a state we cannot read from the markup
  const tag = /^[a-zA-Z][\w-]*/.exec(rest)?.[0] ?? null, id = /#([\w-]+)/.exec(rest)?.[1] ?? null, classes = [...rest.matchAll(/\.([\w-]+)/g)].map((x) => x[1]);
  return { tag, id, classes, hiddenAttr, notHidden, other };
}
const matches = (cp, el) => (!cp.tag || cp.tag === el.tag) && (!cp.id || cp.id === el.id) && cp.classes.every((k) => el.classes.includes(k));
const displayOf = (decls) => [...decls.matchAll(/(?:^|;)\s*display\s*:\s*([^;!]+?)\s*(!important)?\s*(?:;|$)/g)].map((m) => ({ value: m[1].trim(), important: Boolean(m[2]) })).at(-1) ?? null;

// Elements the markup ships with the hidden attribute.
export function hiddenElements(markup) {
  return [...markup.matchAll(/<([a-zA-Z][\w-]*)((?:\s+[^\s>=]+(?:="[^"]*")?)*)\s*>/g)].map((m) => {
    const attrs = m[2], hid = /(?:^|\s)hidden(?=\s|$|=)/.test(attrs.replace(/="[^"]*"/g, (x) => x.replace(/\s/g, "_")));
    return hid ? { tag: m[1], id: /\sid="([^"]*)"/.exec(attrs)?.[1] ?? null, classes: (/\sclass="([^"]*)"/.exec(attrs)?.[1] ?? "").split(/\s+/).filter(Boolean) } : null;
  }).filter(Boolean);
}

// The clashes in a stylesheet for the given elements: [{ el, rule }] where an author rule shows a hidden element and no [hidden] rule hides it again.
// Only single-compound selectors (.cls, #id, tag, .a.b) are read: a rule with an ancestor (".panel button") applies only inside that ancestor, which the
// markup scan cannot place, so it is left out rather than guessed at (it would flag every button on the page).
export function clashes(stylesheet, elements) {
  const rules = rulesOf(stylesheet).map((r, idx) => ({ ...r, idx })).filter((r) => !/[\s>+~]/.test(r.selector)), out = [];
  // Specificity as [ids, classes and attributes, tags]; the later rule wins a tie; !important beats anything that is not.
  const spec = (cp) => [cp.id ? 1 : 0, cp.classes.length + (cp.hiddenAttr ? 1 : 0), cp.tag ? 1 : 0];
  const cmp = (a, b) => { for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };
  const beats = (h, s) => (h.imp !== s.imp ? h.imp : cmp(h.spec, s.spec) !== 0 ? cmp(h.spec, s.spec) > 0 : h.idx > s.idx);
  for (const el of elements) {
    const showing = rules.map((r) => ({ r, cp: lastCompound(r.selector), d: displayOf(r.decls) })).filter(({ cp, d }) => d && d.value !== "none" && !cp.hiddenAttr && !cp.notHidden && !cp.other && matches(cp, el) && (cp.tag || cp.id || cp.classes.length))
      .map(({ r, cp, d }) => ({ ...r, spec: spec(cp), imp: d.important }));
    const hiding = rules.map((r) => ({ r, cp: lastCompound(r.selector), d: displayOf(r.decls) })).filter(({ cp, d }) => d && d.value === "none" && cp.hiddenAttr && !cp.other && matches(cp, el))
      .map(({ r, cp, d }) => ({ ...r, spec: spec(cp), imp: d.important }));
    const loser = showing.find((s) => !hiding.some((h) => beats(h, s)));
    if (loser) out.push({ el: `${el.tag}${el.id ? `#${el.id}` : ""}${el.classes.map((k) => `.${k}`).join("")}`, rule: loser.selector });
  }
  return out;
}

test("the page ships elements with the hidden attribute (the check below is not vacuous)", () => {
  const els = hiddenElements(body);
  assert.ok(els.length > 20, `${els.length} elements`);
  assert.ok(els.some((e) => e.id === "newboard"), "the newer-board banner is one of them");
  assert.ok(rulesOf(css).length > 200);
});

test("no hidden element is shown by an author display rule: every one that has such a rule also has a [hidden] rule that hides it", () => {
  const bad = clashes(css, hiddenElements(body));
  assert.deepEqual(bad, [], `these hidden elements still show: ${bad.map((b) => `${b.el} by ${b.rule}`).join("; ")}`);
});

test("the checker itself: it finds the .newboard clash, accepts the [hidden] override, and ignores :not([hidden]) rules", () => {
  const el = [{ tag: "button", id: "newboard", classes: ["newboard"] }];
  assert.deepEqual(clashes(".newboard{display:block;color:red}", el).map((x) => x.rule), [".newboard"]);
  assert.deepEqual(clashes(".newboard{display:block}.newboard[hidden]{display:none}", el), []);
  assert.deepEqual(clashes(".hdr>.newboard:not([hidden]){display:block}", el), []);
  assert.deepEqual(clashes("#newboard{display:flex}", el).map((x) => x.rule), ["#newboard"]);
  assert.deepEqual(clashes("button{display:inline-flex}", el).map((x) => x.rule), ["button"]);
  assert.deepEqual(clashes(".newboard[hidden]{display:none}#newboard{display:flex}", el).map((x) => x.rule), ["#newboard"], "an id rule outranks .class[hidden]");
  assert.deepEqual(clashes("#newboard{display:flex}#newboard[hidden]{display:none}", el), [], "an id plus [hidden] rule beats it");
  assert.deepEqual(clashes(".newboard[hidden]{display:none}.newboard{display:block}", el), [], "[hidden] already outranks the bare class, whatever the order");
  assert.deepEqual(clashes(".newboard{display:block!important}.newboard[hidden]{display:none}", el).map((x) => x.rule), [".newboard"], "an important show beats a plain hide");
  assert.deepEqual(clashes(".newboard{display:block!important}.newboard[hidden]{display:none!important}", el), []);
  assert.deepEqual(clashes(".other{display:block}", el), []);
  assert.deepEqual(clashes(".newboard{margin:0}", el), []);
  assert.deepEqual(clashes("@media (max-width:600px){.newboard{display:block}}", el).map((x) => x.rule), [".newboard"]);
  assert.deepEqual(hiddenElements('<div class="a b" id="x" hidden></div><div class="c"></div><input type="file" multiple hidden accept="x y"><span data-t="not hidden">'), [
    { tag: "div", id: "x", classes: ["a", "b"] }, { tag: "input", id: null, classes: [] }]);
});
