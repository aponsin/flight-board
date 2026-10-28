// A long ETA line never narrows a card's summary (#C424, the owner on #C423's card: "In review · then after the queue:
// v1.159.1 at the earliest" took about 60% of the card at laptop width and the summary wrapped in a narrow strip).
// The ETA column is capped and its version line wraps inside it. Measured in a real browser: the card as the page draws
// it (its own CSS and initRow), at laptop (1180) and phone (390) width, in headless Chrome when it is there.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { loadNames } from "./harness.mjs";

const page = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
const css = page.match(/<style>([\s\S]*?)<\/style>/)[1];
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const T = Date.now();
const SUMMARY = "The board shows each card's stage and each agent's current activity within about ninety seconds, from a script, on any device, with the Collector stopped; the panel reads the Studio's own state through a connector and stays hidden without it.";

// The card row the board draws for a card in review whose next version is predicted past the queue.
function row() {
  const b = loadNames(["initRow", "versionNote"]);
  const card = { id: "card-eta-wrap", num: 423, name: "Board state without a model", size: "M", status: "active", phase: "checker", who: "Boardsmith", createdAt: T - 36e5, etaLive: T + 36e5, level: "Full", summary: SUMMARY };
  Object.assign(b.state, { derived: [{ id: "all", cards: { [card.id]: { phase: "checker", head: "a".repeat(40), expected: { version: "1.159.1", earliest: true } } } }], steps: [], waiting: [], messages: [], threads: [], initRaw: [card], initiatives: [card] });
  assert.match(b.versionNote(card), /In review · then after the queue: <b>v1\.159\.1<\/b> at the earliest/);
  return b.initRow(card);
}

test("the ETA column is capped and its version line wraps; on a phone the column is the card's width", () => {
  assert.match(css, /\.eta\{[^}]*max-width:16rem/);
  assert.match(css, /@media \(max-width:760px\)\{[^\n]*\.eta\{text-align:left;max-width:none\}/);
  assert.doesNotMatch(css.match(/\.pv\{[^}]*\}/)[0], /nowrap/, "the version line wraps");
  assert.match(css, /\.pv b\{[^}]*white-space:nowrap/, "the version itself stays whole");
});

test("measured: a long ETA line leaves the summary most of the card at 1180, and all of it at 390", { skip: !existsSync(CHROME) && "no Chrome on this machine" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "card-eta-wrap-"));
  const measure = `<script>addEventListener("load",()=>{const r=document.querySelector(".i-row"),s=r.querySelector(".w-sub"),e=r.querySelector(".eta"),pv=r.querySelector(".pv");const cs=getComputedStyle(r),inner=r.clientWidth-parseFloat(cs.paddingLeft)-parseFloat(cs.paddingRight);document.body.setAttribute("data-m",JSON.stringify({inner,sum:s.getBoundingClientRect().width,eta:e.getBoundingClientRect().width,pvLines:Math.round(pv.getBoundingClientRect().height/parseFloat(getComputedStyle(pv).lineHeight||"16"))}))})</script>`;
  // Headless Chrome's window is never narrower than about 500 px: the body is set to the width measured.
  const html = (w) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}body{width:${w}px;margin:0}</style></head><body><div class="wrap"><section class="panel board">${row()}</section></div>${measure}</body></html>`;
  const at = (w) => {
    const f = join(dir, `card-${w}.html`);
    writeFileSync(f, html(w));
    const dom = execFileSync(CHROME, ["--headless=new", "--disable-gpu", "--hide-scrollbars", `--window-size=${w},900`, "--virtual-time-budget=2000", "--dump-dom", "file://" + f], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 60_000 });
    const m = /data-m="([^"]+)"/.exec(dom);
    assert.ok(m, `measured at ${w}`);
    return JSON.parse(m[1].replace(/&quot;/g, '"'));
  };
  const laptop = at(1180);
  assert.ok(laptop.eta <= 16 * 16 + 1, `the ETA column is at most 16rem (${laptop.eta} px)`);
  assert.ok(laptop.sum >= 0.7 * laptop.inner, `the summary has most of the card at 1180 (${Math.round(laptop.sum)} of ${Math.round(laptop.inner)} px)`);
  const phone = at(390);
  assert.ok(phone.sum >= 0.95 * phone.inner, `the summary has the card's width at 390 (${Math.round(phone.sum)} of ${Math.round(phone.inner)} px)`);
});
