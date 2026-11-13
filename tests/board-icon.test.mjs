// #C1055: the board has its own icon (option F, the attitude indicator, the owner's pick). The page head carries the tab icon and the apple-touch-icon as
// data: links, the Worker's manifest names the icon at 192 and 512 px, and every one is the file under page/icon/ (a changed file without a rebuild fails here).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildPage } from "../scripts/build-page.mjs";
import { storePage } from "../scripts/build-store-page.mjs";
import { iconLinks, iconsModule, withIcons } from "../scripts/build-icons.mjs";
import { MANIFEST } from "../worker/push-page.mjs";
import { ICON_192, ICON_512 } from "../worker/board-icons.mjs";

const file = (n) => readFileSync(new URL(`../page/icon/${n}`, import.meta.url));
const template = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
const generated = readFileSync(new URL("../worker/board-icons.mjs", import.meta.url), "utf8");
const head = (html) => html.slice(0, html.indexOf("<style>"));
const link = (html, re) => { const m = head(html).match(re); assert.ok(m, `no ${re}`); return m[1]; };
const png = (uri) => { assert.match(uri, /^data:image\/png;base64,/); return Buffer.from(uri.split(",")[1], "base64"); };
const size = (b) => [b.readUInt32BE(16), b.readUInt32BE(20)];

test("the page head has the tab icon and the apple-touch-icon as data: links, right after the title, and no manifest of its own", () => {
  const h = head(template);
  assert.ok(h.startsWith("<title>{{TITLE}}</title>\n<!--ICONS-->\n"), "after the title, before any stylesheet");
  assert.match(h, /<link rel="icon" type="image\/svg\+xml" href="data:image\/svg\+xml,/);
  assert.match(h, /<link rel="icon" type="image\/png" sizes="192x192" href="data:image\/png;base64,/);
  assert.match(h, /<link rel="apple-touch-icon" sizes="180x180" href="data:image\/png;base64,/);
  assert.doesNotMatch(h, /rel="manifest"/, "the store page's manifest is the Worker's (#C904)");
  assert.doesNotMatch(h, /rel="(?:icon|apple-touch-icon)"[^>]*href="(?!data:)/, "no icon link goes to another host");
});

test("each link is its file under page/icon/, at its size, and the page and the Worker's module are what the build writes", () => {
  const svg = decodeURIComponent(link(template, /rel="icon" type="image\/svg\+xml" href="data:image\/svg\+xml,([^"]+)"/));
  assert.equal(svg, file("board-icon.svg").toString("utf8").replace(/\s*\n\s*/g, ""));
  const tab = png(link(template, /rel="icon" type="image\/png" sizes="192x192" href="([^"]+)"/));
  assert.ok(tab.equals(file("icon-192.png")), "the 192 px tab icon is page/icon/icon-192.png"); assert.deepEqual(size(tab), [192, 192]);
  const touch = png(link(template, /rel="apple-touch-icon" sizes="180x180" href="([^"]+)"/));
  assert.ok(touch.equals(file("apple-touch-icon.png")), "the apple-touch-icon is page/icon/apple-touch-icon.png"); assert.deepEqual(size(touch), [180, 180]);
  // iOS rounds the corners itself and draws a transparent one black: the apple-touch-icon is opaque (PNG colour type 2, RGB, no alpha) and its source fills the square.
  assert.equal(touch[25], 2, "the apple-touch-icon has no alpha channel");
  assert.doesNotMatch(file("apple-touch-icon.svg").toString("utf8"), /<rect[^>]*\brx=/, "its ground has square corners");
  assert.equal(withIcons(template), template, "the template's block is what the build writes now");
  assert.equal(generated, iconsModule(), "worker/board-icons.mjs is what the build writes now");
  assert.ok(template.includes(iconLinks()));
});

test("the Worker's manifest names the icon at 192 and 512 px, each the file, beside what #C904 gave it", () => {
  const m = JSON.parse(MANIFEST);
  assert.equal(m.display, "standalone"); assert.equal(m.start_url, "/");
  assert.deepEqual(m.icons.map((i) => i.sizes), ["192x192", "512x512"]);
  for (const i of m.icons) {
    assert.equal(i.type, "image/png");
    const b = png(i.src), n = i.sizes.split("x").map(Number);
    assert.deepEqual(size(b), n); assert.ok(b.equals(file(`icon-${n[0]}.png`)), `the manifest icon ${i.sizes} is page/icon/icon-${n[0]}.png`);
  }
  assert.equal(m.icons[0].src, ICON_192); assert.equal(m.icons[1].src, ICON_512);
});

test("a built page and the store page keep the title and the icon links", () => {
  const html = buildPage(template, { title: "Test", owner: "Sam" });
  assert.match(head(html), /^<title>[^<]+<\/title>\n<!--ICONS-->/);
  assert.match(head(html), /rel="apple-touch-icon"/);
  const store = storePage(html.replace(/<!--FONTS-->[\s\S]*?<!--END_FONTS-->/, "<!--FONTS--><!--END_FONTS-->"));
  assert.match(store, /rel="apple-touch-icon"/);
  assert.match(store, /<link rel="manifest" href="\/manifest\.webmanifest">/);
});
