// Rendered scenarios for the board page (#C268): each fixture is a set of board documents and what the owner must see
// for each item (its section, how many rows, its badge, whether its thread sits under it, a card's phase row). The page's
// own script draws them, the whole board at once (renderAll), with no browser; what it drew is read back and compared.
//   node scripts/fixtures.mjs [page.html]   prints each fixture's result; exits 1 when one fails.
// scripts/build-page.mjs refuses to build a page whose fixtures fail, and so does the owner's install.
// Fixtures live in tests/fixtures/board/*.json: { name, about, docs: { <collection>: [ {id, ...} ] }, expect: { <id>: {…} } }.
// A time is written "now", "now-5m", "now+2h" (s, m, h, d), so a fixture never goes stale.
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const FIXTURES = join(ROOT, "tests", "fixtures", "board");
const UNIT = { s: 1e3, m: 60e3, h: 36e5, d: 864e5 };

// Every "now…" string in a value, as a time in ms.
export function times(v, now) {
  if (typeof v === "string") { const m = /^now(?:([+-]\d+(?:\.\d+)?)([smhd]))?$/.exec(v); return m ? now + (m[1] ? Number(m[1]) * UNIT[m[2]] : 0) : v; }
  if (Array.isArray(v)) return v.map((x) => times(x, now));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, times(x, now)]));
  return v;
}

// The page's script, run on a fixture's documents. Returns the HTML of each section it drew.
export function render(html, docs) {
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const els = {};
  const el = (id) => (els[id] ||= { id, innerHTML: "", textContent: "", value: "", hidden: false, scrollTop: 0, dataset: {}, style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, addEventListener() {}, setAttribute() {}, removeAttribute() {},
    querySelectorAll: () => [], querySelector: () => null, appendChild() {}, getBoundingClientRect: () => ({ left: 0, width: 0, top: 0, height: 0 }) });
  const document = { getElementById: el, querySelectorAll: () => [], querySelector: () => null, addEventListener() {}, activeElement: null, createRange: () => ({}), createElement: () => el("_new") };
  const ctx = { document, window: { scrollY: 0, scrollTo() {}, addEventListener() {} }, console, setInterval() {}, setTimeout() {}, clearTimeout() {}, queueMicrotask() {}, navigator: {}, getSelection: () => ({}),
    localStorage: { getItem: () => null, setItem() {} }, location: { hash: "", search: "" }, Date, Math, JSON, Number, String, Array, Object, Set, Map, WeakMap, isFinite, URLSearchParams };
  vm.createContext(ctx);
  vm.runInContext(script + "\n;globalThis.__b={state,renderAll,OWNER};", ctx);
  const b = ctx.__b;
  // "@owner" in a fixture is the page's own owner (the template's, or the team's in a built page).
  const own = (v) => (v === "@owner" ? b.OWNER : Array.isArray(v) ? v.map(own) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, own(x)])) : v);
  for (const [c, list] of Object.entries(docs)) {
    const key = c === "initiatives" ? "initRaw" : c;
    if (Array.isArray(b.state[key])) b.state[key] = own(list);
  }
  b.renderAll();
  const h = (id) => (els[id] ? els[id].innerHTML : "");
  return { "needs-you": h("waiting"), "waiting-on-manager": h("threads"), later: h("later"), resolved: h("resolved"), board: h("board"), done: h("doneboard") };
}

const strip = (s) => String(s).replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
const ROW = /<details class="w-item[^"]*" data-id="/g;

// What the owner sees for one item id: { section, rows, badge, replyRow, threadUnder } and, for a card, { phase, status,
// version, gated }. A section is where its rows are ("none" when it has none; several, joined by ", ").
export function observe(drawn, id) {
  const out = { rows: 0 }, where = [];
  let first = null;
  for (const [section, html] of Object.entries(drawn)) {
    if (section === "board" || section === "done") {
      for (const row of html.split('<div class="i-row">').slice(1)) {
        if (!row.includes(`data-id="ith-${id}"`)) continue;
        out.rows++; where.push(section); first ??= { section, row, card: true };
      }
      continue;
    }
    // A row is an item's own fold (data-id its id, or th-<id> for a thread row); a button's data-id is not a row.
    ROW.lastIndex = 0;
    const starts = [...html.matchAll(ROW)].map((m) => m.index);
    // Top-level rows only for the position: a row inside a folded group (Later, Resolved) is not counted at that level.
    let place = 0;
    starts.forEach((start, n) => {
      const key = html.slice(html.indexOf('data-id="', start) + 9).split('"', 1)[0];
      if (!key.startsWith("__")) place++;
      if (key !== id && key !== `th-${id}`) return;
      const row = html.slice(start, starts[n + 1] ?? html.length);
      out.rows++; where.push(section); first ??= { section, row, card: false, position: place };
    });
  }
  out.section = where.length ? [...new Set(where)].join(", ") : "none";
  if (!first) return { ...out, badge: null };
  const head = first.card ? (first.row.match(/<details class="i-thread"[\s\S]*?<\/summary>/) ?? [""])[0] : first.row.slice(0, first.row.indexOf("</summary>"));
  const badge = /<span class="t-badge[^"]*">([^<]*)<\/span>/.exec(head);
  out.badge = badge ? badge[1] : null;
  out.threadUnder = first.row.includes(`data-thread="${id}"`);
  if (!first.card) {
    out.replyRow = head.includes("Reply to:");
    out.position = first.position;
    out.age = strip((/<span class="age">([\s\S]*?)<span class="caret"/.exec(head) ?? ["", ""])[1]) || null;
    return out;
  }
  const steps = [...first.row.matchAll(/<div class="step([^"]*)" title="([^"]+)"/g)].filter((m) => /\b(now|upnext)\b/.test(m[1]));
  out.phase = steps.length ? steps[steps.length - 1][2].split(":")[0] : null;
  out.status = strip((/<span class="state [^"]*">([\s\S]*?)<\/span>/.exec(first.row) ?? ["", ""])[1]);
  out.version = strip((/<div class="pv">([\s\S]*?)<\/div>/.exec(first.row) ?? ["", ""])[1]) || null;
  out.gated = /<div class="wait gate/.test(first.row);
  return out;
}

// One fixture: the mismatches, as lines ("<id>: badge: want …, got …"); none when it passes.
export function check(html, fixture, now = Date.now()) {
  const drawn = render(html, times(fixture.docs ?? {}, now));
  const bad = [];
  for (const [id, want] of Object.entries(fixture.expect ?? {})) {
    const got = observe(drawn, id);
    for (const [k, v] of Object.entries(want)) if (JSON.stringify(got[k]) !== JSON.stringify(v)) bad.push(`${id}: ${k}: want ${JSON.stringify(v)}, got ${JSON.stringify(got[k])}`);
  }
  return bad;
}

export function fixtures(dir = FIXTURES) {
  return readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => ({ file: f, ...JSON.parse(readFileSync(join(dir, f), "utf8")) }));
}

// Every fixture against a page (the template, or a built page): [{ file, name, bad: [lines] }].
export function checkAll(html, dir = FIXTURES) {
  return fixtures(dir).map((f) => { let bad; try { bad = check(html, f); } catch (e) { bad = [`the page failed to draw it: ${e.message}`]; } return { file: f.file, name: f.name, bad }; });
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const page = process.argv[2] ?? join(ROOT, "page", "board.template.html");
  const results = checkAll(readFileSync(page, "utf8"));
  for (const r of results) console.log(`${r.bad.length ? "FAIL" : "ok  "} ${r.file}: ${r.name}${r.bad.map((l) => `\n     ${l}`).join("")}`);
  const failed = results.filter((r) => r.bad.length).length;
  console.log(failed ? `${failed} of ${results.length} fixtures fail.` : `All ${results.length} fixtures pass.`);
  process.exit(failed ? 1 : 0);
}
