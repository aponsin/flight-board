import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { headerHtml, HEADER_CSS, liveChip, LONGEST } from "../worker/page-header.mjs";
import { liveNow } from "../worker/board-rules.mjs";

const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const NOW = 1_800_000_000_000;

test("Live now shows the probe's reading with its age; past 3 minutes it is stale and red, never live", () => {
  const fresh = liveChip(liveNow({ version: "v1.2.3", readAt: NOW - 20_000 }, NOW), null);
  assert.equal(fresh.cls, "ok");
  assert.match(fresh.long, /^Live now v1\.2\.3 · read 20 s ago$/);
  const old = liveChip(liveNow({ version: "v1.2.3", readAt: NOW - 36 * 60_000 }, NOW), null);
  assert.equal(old.cls, "bad");
  assert.match(old.short, /^STALE /);
  assert.match(old.long, /stale/);
  assert.match(old.long, /36 min ago/);
  assert.doesNotMatch(old.long, /^Live now v/, "an old reading never reads as live");
  assert.equal(liveChip(liveNow(null, NOW), null).cls, "warn");
});

test("the header markup carries the stale mark for an old reading", () => {
  const html = headerHtml({ live: liveNow({ version: "v9", readAt: NOW - 600_000 }, NOW) });
  assert.match(html, /chip live bad/);
  assert.match(html, /STALE v9/);
});

// Real browser: the longest state at phone and laptop width. Fails if the header is taller than one row or the page scrolls
// sideways. The page measures itself and writes the numbers into the DOM; Chrome dumps the DOM.
const chromeOk = existsSync(CHROME);
for (const [name, w, h] of [["phone 375", 375, 800], ["laptop 1440", 1440, 900]]) {
  test(`the header stays on one row at ${name} in the longest state`, { skip: chromeOk ? false : "no Chrome at " + CHROME }, () => {
    const dir = mkdtempSync(join(tmpdir(), "hdr-"));
    const page = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0}${HEADER_CSS}</style>
<body>${headerHtml(LONGEST.view, LONGEST.opts)}<main style="padding:12px">content</main>
<script>addEventListener("load",()=>{const hd=document.querySelector(".hd"),chips=[...hd.children].map(c=>{const b=c.getBoundingClientRect();return b.top+b.height/2;});
document.documentElement.dataset.result=JSON.stringify({vw:innerWidth,hdH:hd.getBoundingClientRect().height,tops:chips,scrollW:document.documentElement.scrollWidth,clientW:document.documentElement.clientWidth,hdScrollW:hd.scrollWidth,hdClientW:hd.clientWidth});});</script>`;
    const file = join(dir, "p.html");
    // Headless Chrome will not open a window narrower than 500 px, so the page sits in an iframe of the exact width: its own
    // viewport (and its media queries) are w wide. srcdoc keeps it same-origin so the page can report to its parent.
    const inner = page.replace('document.documentElement.dataset.result=', 'parent.document.documentElement.dataset.result=');
    writeFileSync(file, `<!doctype html><body style="margin:0"><iframe style="border:0;width:${w}px;height:${h}px" srcdoc="${inner.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"></iframe>`);
    const r = spawnSync(CHROME, ["--headless=new", "--disable-gpu", "--no-sandbox", "--window-size=1600,1000", "--force-device-scale-factor=1", "--virtual-time-budget=3000", "--dump-dom", `file://${file}`], { encoding: "utf8", timeout: 60_000 });
    const m = /data-result='([^']*)'|data-result="([^"]*)"/.exec(r.stdout);
    assert.ok(m, `no result from Chrome: ${r.stderr.slice(-300)}`);
    const res = JSON.parse((m[1] ?? m[2]).replace(/&quot;/g, '"'));
    assert.ok(Math.abs(res.vw - w) <= 20, `viewport ${res.vw} is not ~${w}`);
    assert.ok(res.hdH <= 44, `header is ${res.hdH}px tall: more than one row`);
    // Chips are centred on the row, so one row means their vertical centres agree (a wrapped chip sits a row lower).
    assert.ok(Math.max(...res.tops) - Math.min(...res.tops) <= 2, `chips on different rows (centres ${res.tops})`);
    assert.ok(res.scrollW <= res.clientW, `page scrolls sideways: ${res.scrollW} > ${res.clientW}`);
    assert.ok(res.hdScrollW <= res.hdClientW + 1, `header content overflows its row: ${res.hdScrollW} > ${res.hdClientW}`);
  });
}
