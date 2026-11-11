#!/usr/bin/env node
// #C877: replay the last 30 ships and report the error of the "Live in" estimate. Usage:
//   node scripts/replay-estimates.mjs <view.json> [count]
// <view.json> is the store's whole view (the board's read_view). For each of the last <count> (30) cards that went live, the estimate is
// taken as the page would have drawn it the moment its build started: the medians (by size, falling back to the overall) of only the cards
// that were live by then, applied to the phases from build on (derivedEta). Error = estimate minus the time it really went live.
// Not replayed: the queue wait before build. The store keeps no history of queue places, so the estimate is of a card that is next in its queue.
import { readFileSync } from "node:fs";
import { drawPage } from "../tests/helpers/draw-page.mjs";
import { compatView } from "../worker/compat-view.mjs";

const [, , file, countArg] = process.argv;
if (!file) { console.error("usage: node scripts/replay-estimates.mjs <view.json> [count]"); process.exit(2); }
const COUNT = Number(countArg) > 0 ? Number(countArg) : 30;
const H = 3600e3;
const view = JSON.parse(readFileSync(file, "utf8"));
const { collections, probe } = compatView(view);
const { b } = drawPage(collections, { probe, host: "store", expose: ["phaseMedians", "derivedEta", "BUILD_PHASE"] });

const live = b.state.initiatives.filter((i) => i && i.status === "done" && !i.dropped && Number.isFinite(i.doneAt) && Array.isArray(i.phaseLog));
const buildStart = (i) => { const s = i.phaseLog.filter((e) => e && e.phase === b.BUILD_PHASE && !e.wait && Number.isFinite(e.start)).map((e) => e.start); return s.length ? Math.min(...s) : null; };
const last = live.filter((i) => buildStart(i) != null).sort((x, y) => y.doneAt - x.doneAt).slice(0, COUNT).reverse();

const rows = [];
for (const c of last) {
  const T = buildStart(c);
  const med = b.phaseMedians(b.state.initiatives.filter((i) => i.id !== c.id), T); // only cards that were live by T (and never this one)
  const eta = b.derivedEta({ ...c, status: "active", phase: b.BUILD_PHASE, phaseLog: [], shipAt: null }, med, T);
  // The alternative measured next to it: the median wall-clock time from build start to live of the cards done by T, of the card's size
  // (3 or more of them, else all sizes), waits included.
  const before = live.filter((i) => i.id !== c.id && i.doneAt <= T && buildStart(i) != null);
  const sameSize = before.filter((i) => i.size && i.size === c.size).map((i) => i.doneAt - buildStart(i));
  const wall = [...(sameSize.length >= 3 ? sameSize : before.map((i) => i.doneAt - buildStart(i)))];
  const wallMed = wall.length ? wall.sort((x, y) => x - y)[wall.length >> 1] : null;
  rows.push({ num: c.num, id: c.id, size: c.size ?? "?", took: (c.doneAt - T) / H, estimate: eta == null ? null : (eta - T) / H, error: eta == null ? null : (eta - c.doneAt) / H,
    wallError: wallMed == null ? null : (T + wallMed - c.doneAt) / H });
}
const withEst = rows.filter((r) => r.error != null);
const med = (a) => { if (!a.length) return null; a = a.slice().sort((x, y) => x - y); const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
const f = (n) => (n == null ? "—" : (n >= 0 ? "+" : "") + n.toFixed(1) + " h");
const g = (n) => (n == null ? "—" : n.toFixed(1) + " h");
console.log(`Replay of the last ${rows.length} ships (estimate taken when each build started; error = estimate - actual):`);
for (const r of rows) console.log(`  #C${r.num ?? "?"} ${r.id} [${r.size}] took ${r.took.toFixed(1)} h, estimated ${r.estimate == null ? "— (no median for a phase yet)" : r.estimate.toFixed(1) + " h"}, error ${f(r.error)}`);
console.log(`With an estimate: ${withEst.length} of ${rows.length}`);
console.log(`Median error ${f(med(withEst.map((r) => r.error)))}; median absolute error ${g(med(withEst.map((r) => Math.abs(r.error))))}`);
const within = (h) => withEst.filter((r) => Math.abs(r.error) <= h).length;
console.log(`Within 2 h: ${within(2)}; within 6 h: ${within(6)}; within 24 h: ${within(24)} of ${withEst.length}`);
const wallRows = rows.filter((r) => r.wallError != null);
console.log(`Alternative (median wall-clock build start to live, by size, waits included): ${wallRows.length} of ${rows.length}; median error ${f(med(wallRows.map((r) => r.wallError)))}, median absolute error ${g(med(wallRows.map((r) => Math.abs(r.wallError))))}; within 2 h: ${wallRows.filter((r) => Math.abs(r.wallError) <= 2).length}, within 6 h: ${wallRows.filter((r) => Math.abs(r.wallError) <= 6).length}, within 24 h: ${wallRows.filter((r) => Math.abs(r.wallError) <= 24).length}`);
const bySize = {}; for (const r of withEst) (bySize[r.size] ||= []).push(r);
for (const [s, a] of Object.entries(bySize)) console.log(`  size ${s}: ${a.length} cards, median error ${f(med(a.map((r) => r.error)))}, median absolute ${g(med(a.map((r) => Math.abs(r.error))))}`);
