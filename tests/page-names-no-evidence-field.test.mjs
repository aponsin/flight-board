// #C1388 (the contract's test, board-reading-contract.md section B.1): a test fails when page/board.template.html names an evidence field.
// The card's row, its group's row and "Who is on what" draw the READING (state, wait, with, working, phase, why, pack, waitsFor, building, branches ...); the page never looks at the
// probe's evidence for a card to say where it is. The names the collector and the Worker write into a card's evidence (collector/state-schema.mjs's CARD, the Worker's `lit`) are
// scanned for in the page's CODE (comments, strings and the text of a template literal are not code; a `${...}` inside one is), as a property (`.name`, `?.name`) or an object key (`name:`).
// Known limits: bracket access (`L["onMain"]`, strings are blanked) and a name destructured in a function's parameter list (`({onMain})=>`) are not seen; shorthand `const {onMain}=x` is.
// A name that remains is on ALLOWED below, per function, with its reason; the six this card moved (closeableNow, groupWaitFor, versionNote's group wait, packTile, liveBuilding,
// builtWaiting) are on no list and a test says so.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (p) => readFileSync(root + p, "utf8");
const html = read("page/board.template.html");

// The evidence fields. Each is a key the collector's card state (state-schema.mjs CARD) or the Worker's evidence (board-rules.mjs `lit`) carries; a test below proves it. Not scanned: the
// words a page object of its own shares with the evidence (phase, at, num, ci, stack, pack, stale, staleSince, findings, reviews, issueCounts): a card row has a `phase` too.
export const EVIDENCE = ["onMain", "signed", "lit", "packed", "installed", "headSha", "headSha12", "seen", "builtWaiting", "noInstall", "shipping", "workSeen", "partsMissing", "behindMain", "stackHold", "wipHead", "trailerMisplaced", "waitingFor", "readyAt", "shippedAt", "liveVersion", "ciMin", "firm"];

// What remains, { name: { function: reason } }. These are NOT card readings: the header's live and probe state, the ship line and the version notes (the collector's derived/all and the probe's
// ship-run flag, #C617/#C400), the phase log the page builds from derived/all's times. The six of #C1388 are not here.
const SHIP = "the ship line / version notes: derived/all's ship queue and the probe's ship-run flag (#C617, #C400), not a card's place on the board";
const DERIVED = "the page's phase log built from the collector's derived/all times (#C731 B4b), the sub-step of a card, not a reading of where it is";
const PROBE = "the probe document's own normaliser and its header state (live/probe, #C449): the one place the probe's fields are named, no card row reads it for a phase, state or wait";
const LOG = "a phase-log entry's own `signed` mark (a step a reviewer signed), the page's log of steps, not the probe's field of that name";
export const ALLOWED = {
  readyAt: { derivedOf: DERIVED, shipQueue: SHIP, byEvidence: DERIVED, fromSteps: DERIVED },
  waitingFor: { derivedOf: DERIVED },
  firm: { derivedOf: DERIVED, shipQueue: SHIP, versionNoteBase: SHIP, byEvidence: DERIVED },
  liveVersion: { derivedOf: DERIVED, liveCard: PROBE },
  shipping: { shipQueue: SHIP, versionNote: SHIP, versionNoteBase: SHIP, replan: SHIP, expectedNow: SHIP, liveCard: PROBE, shipNow: "the restart pill and the Don't-restart line: whether a ship run is on right now (the ship banner), not a card's place" },
  onMain: { versionNote: SHIP, liveRun: SHIP, liveCard: PROBE, shipNow: "the ship banner: a run is on while its card is not on main yet, not a card's place" },
  signed: { phaseStart: LOG, fromSteps: LOG },
  shippedAt: { fromSteps: DERIVED },
  workSeen: { fromSteps: DERIVED },
  headSha12: { liveCard: PROBE },
  installed: { liveCard: PROBE },
  packed: { liveCard: PROBE },
  seen: { liveCard: PROBE },
};

// Code only: comments, string literals, regex literals and the text of template literals blanked (newlines kept); a `${ ... }` expression inside a template is code again.
export function codeOf(src) {
  let out = "", i = 0, prev = "";
  const stack = []; // "tpl" frames: the brace depth to come back to when a `${` closes
  let depth = 0;
  const blank = (s) => s.replace(/[^\n]/g, " ");
  const regexOk = () => prev === "" || "(,=:[!&|?{};+-*%<>~^".includes(prev) || /\b(return|typeof|case|in|of)$/.test(out.trimEnd());
  const template = () => { // at the opening backtick or after a closing `}`: copy template text blanked until `${` or the closing backtick
    let j = i, buf = "";
    while (j < src.length) {
      const c = src[j];
      if (c === "\\") { buf += blank(src.slice(j, j + 2)); j += 2; continue; }
      if (c === "`") { out += buf + " "; i = j + 1; prev = "`"; return; }
      if (c === "$" && src[j + 1] === "{") { out += buf + "  "; i = j + 2; stack.push(depth); depth = 0; prev = "{"; return; }
      buf += c === "\n" ? "\n" : " "; j++;
    }
    out += buf; i = j;
  };
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (c === "/" && n === "/") { const e = src.indexOf("\n", i); const end = e < 0 ? src.length : e; out += blank(src.slice(i, end)); i = end; continue; }
    if (c === "/" && n === "*") { const e = src.indexOf("*/", i + 2); const end = e < 0 ? src.length : e + 2; out += blank(src.slice(i, end)); i = end; continue; }
    if (c === "'" || c === '"') { let j = i + 1; while (j < src.length && src[j] !== c && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1; out += blank(src.slice(i, j + 1)); i = j + 1; prev = c; continue; }
    if (c === "`") { i++; template(); continue; }
    if (c === "/" && regexOk()) { let j = i + 1, cls = false; while (j < src.length && src[j] !== "\n" && (cls || src[j] !== "/")) { if (src[j] === "\\") j++; else if (src[j] === "[") cls = true; else if (src[j] === "]") cls = false; j++; } j++; while (/[a-z]/.test(src[j] ?? "")) j++; out += blank(src.slice(i, j)); i = j; prev = ")"; continue; }
    if (c === "{") depth++;
    if (c === "}") { if (depth === 0 && stack.length) { depth = stack.pop(); out += " "; i++; template(); continue; } depth--; }
    out += c; i++; if (!/\s/.test(c)) prev = c;
  }
  return out;
}

// [{ name, owner, line }]: every place the page's code names an evidence field, and the top-level function or constant (column 0) it sits in.
export function evidenceNames(page, names = EVIDENCE) {
  const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => ({ code: codeOf(m[1]), at: page.slice(0, m.index).split("\n").length }));
  const hits = [], re = new RegExp(`(?<!\\.)(?:\\?\\.|\\.)(${names.join("|")})\\b|\\b(${names.join("|")})\\s*:(?!:)`, "g"); // `.name` or `?.name` (not a `...spread`), or a key `name:`
  for (const { code, at } of scripts) {
    const lines = code.split("\n"), owners = [], starts = [];
    let owner = null, off = 0;
    lines.forEach((line, k) => {
      const d = line.match(/^(?:async\s+)?function\s+(\w+)|^(?:const|let|var)\s+(\w+)/);
      if (d) owner = d[1] ?? d[2];
      else if (/^\S/.test(line)) owner = null; // #C1387 F3: a column-0 line that is no declaration (a loose statement) is nobody's: it takes no function's allowance
      owners.push(owner); starts.push(off); off += line.length + 1;
      for (const m of line.matchAll(re)) hits.push({ name: m[1] ?? m[2], owner, line: at + k });
    });
    // #C1387 F3: a name read by shorthand destructuring, `const {onMain}=x` or `{onMain=1}=x` (a `{packed:p}` has its key caught above).
    const lineOf = (pos) => { let k = 0; while (k + 1 < starts.length && starts[k + 1] <= pos) k++; return k; };
    for (const m of code.matchAll(/\{([^{}]*)\}\s*=(?![=>])/g)) {
      let p = m.index + 1;
      for (const part of m[1].split(",")) {
        const key = part.trim().replace(/^\.\.\./, "");
        if (!part.includes(":") && names.includes(key.split("=")[0].trim())) { const k = lineOf(p + part.indexOf(key.charAt(0))); hits.push({ name: key.split("=")[0].trim(), owner: owners[k], line: at + k }); }
        p += part.length + 1;
      }
    }
  }
  return hits;
}

test("the scanner reads code, not comments, strings or template text; a ${} inside a template is code", () => {
  const src = `<script>
// comment: x.onMain
const a = "x.onMain" + 'y.seen' + /\\.onMain/.test(s);
function f(L){ return \`<b class="seen">\${L.onMain}</b> and onMain: text\`; }
const g = {signed: 1};
const h = i => i?.lit;
</script>`;
  const got = evidenceNames(src).map((h) => `${h.name}@${h.owner}`);
  assert.deepEqual(got, ["onMain@f", "signed@g", "lit@h"]);
});

test("the scanner catches a shorthand destructuring and a loose column-0 statement after an allowed function (a known limit: bracket access L[\"onMain\"], strings being blanked)", () => {
  const src = `<script>
function liveCard(id){ return 1; }
state.x=L=>L.packed;
function zz(id){const {onMain}=liveCard(id);return onMain}
function yy(L){const {a, seen=2, packed:p}=L;return a}
const ww = ({lit}) => lit;
</script>`;
  const got = evidenceNames(src).map((h) => `${h.name}@${h.owner}`);
  assert.deepEqual(got.sort(), ["onMain@zz", "packed@null", "packed@yy", "seen@yy"].sort());
});

test("every name scanned for is a field the collector or the Worker writes", () => {
  const schema = read("collector/state-schema.mjs"), rules = read("worker/board-rules.mjs"), worker = read("worker/reading.mjs");
  for (const n of EVIDENCE) assert.ok(new RegExp(`\\b${n}\\b`).test(schema + rules + worker), `${n} is not an evidence field of the schema, the rules or the reading`);
  const card = schema.slice(schema.indexOf("const CARD = {"), schema.indexOf("const { num: _n"));
  for (const n of ["onMain", "signed", "headSha", "headSha12", "seen", "builtWaiting", "noInstall", "packed", "installed", "shipping", "workSeen", "liveVersion"]) assert.ok(new RegExp(`^\\s+${n}:`, "m").test(card), `${n} is a key of the card state`);
});

test("page names no evidence field: every name the page's code carries is on the allow-list, with its function and a reason", () => {
  const hits = evidenceNames(html), loose = hits.filter((h) => !ALLOWED[h.name]?.[h.owner]);
  assert.deepEqual(loose.map((h) => `${h.name} in ${h.owner} (line ${h.line})`), [], "the page names an evidence field outside the allow-list: draw the card's reading instead (worker/reading.mjs), or allow it with a reason that is not a card's place");
  for (const [name, owners] of Object.entries(ALLOWED)) for (const [fn, why] of Object.entries(owners)) {
    assert.ok(why.length > 20, `${name} in ${fn} needs a reason`);
    assert.ok(hits.some((h) => h.name === name && h.owner === fn), `${name} in ${fn} is allowed but the page no longer names it there: delete the entry`);
  }
});

test("the six reads of #C1388 are gone and on no list: closeableNow, groupWaitFor, versionNote's group wait, packTile, liveBuilding, builtWaiting", () => {
  const hits = evidenceNames(html);
  for (const fn of ["closeableNow", "groupWaitFor", "packTile", "liveBuilding", "builtWaiting", "cardBranches", "branchTracks", "asShown", "notStarted"]) {
    assert.deepEqual(hits.filter((h) => h.owner === fn), [], `${fn} names an evidence field`);
    for (const owners of Object.values(ALLOWED)) assert.equal(Object.hasOwn(owners, fn), false, `${fn} is on the allow-list`);
  }
  // versionNote's group wait is the first line of it that names the group: it reads groupWaitFor, which reads the reading.
  const note = html.slice(html.indexOf("function versionNote(i)"), html.indexOf("function versionNoteBase"));
  assert.match(note, /groupWaitFor\(i\)/);
  assert.match(html, /function groupWaitFor\(i\)\{[^]*?readingOf\(i\.id\)/);
  assert.match(html, /const closeableNow=[^\n]*readingOf\(i\.id\)\.state==="done"/);
  assert.match(html, /function liveBuilding\(id\)\{return readingOf\(id\)\.building===true\}/);
  assert.equal(/\bbuiltWaiting\b/.test(codeOf(html)), false, "builtWaiting is dead: nothing in the page reads it");
});
