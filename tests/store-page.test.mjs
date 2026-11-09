// The old board page served by the store Worker (#C723, board parity A1): built with self-hosted fonts and a document
// skeleton, served behind the identity check with a per-response script nonce and a policy that refuses every other site.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import worker, { OLD_PAGE_PATH, oldPageCsp, withNonce } from "../worker/board-worker.mjs";
import { buildChecked } from "../scripts/build-page.mjs";
import { storePage, fontFaceCss, FONT_FACES, FONTS_DIR } from "../scripts/build-store-page.mjs";

const template = readFileSync(new URL("../page/board.template.html", import.meta.url), "utf8");
const config = JSON.parse(readFileSync(new URL("../board.config.example.json", import.meta.url), "utf8"));
const built = buildChecked(template, config, undefined, { commit: "abc1234" });
const page = storePage(built);
const outsideScript = (html) => html.replace(/<script[^>]*>[\s\S]*?<\/script>/g, "");

test("the store page: Google's font links become @font-face rules on /fonts/, inside a whole document", () => {
  assert.doesNotMatch(page, /fonts\.(googleapis|gstatic)\.com/);
  assert.ok(page.includes(fontFaceCss()));
  for (const f of FONT_FACES) assert.ok(page.includes(`src:url(/fonts/${f.file}) format("woff2")`), f.file);
  assert.match(page, /^<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">/);
  assert.match(page, /<\/body>\n<\/html>\n$/);
  // The artifact build keeps Google's links: the old board runs as it is until the owner switches.
  assert.match(built, /fonts\.googleapis\.com/);
  assert.throws(() => storePage(built.replace("<!--FONTS-->", "")), /no <!--FONTS--> block/);
});

test("the store page loads nothing from another site and runs no inline handler: one script tag, by nonce", () => {
  assert.equal((page.match(/<script\b/g) ?? []).length, 1, "exactly one script element");
  assert.equal((page.match(/<script>/g) ?? []).length, 1, "and it is a bare <script>, which the Worker stamps");
  const markup = outsideScript(page);
  assert.doesNotMatch(markup, /<[a-z][^>]*\son[a-z]+\s*=/i, "no inline event handler in the markup");
  assert.doesNotMatch(markup, /\b(?:src|href)\s*=\s*["']?(?:https?:)?\/\//i, "no address on another site");
  assert.doesNotMatch(markup, /javascript:/i);
});

test("the Worker serves the old page at /board behind the identity check, its script by a fresh nonce", async () => {
  const assets = { "/board.html": page };
  const env = { DB: makeDb(), ASSETS: { fetch: async (req) => { const p = new URL(req.url).pathname; return p in assets ? new Response(assets[p]) : new Response("", { status: 404 }); } } };
  const get = (path, as = "owner", init = {}) => worker.fetch(new Request(`https://board.test${path}`, init), env, null, 1_800_000_000_000, async () => (as ? { who: as, role: as === "owner" ? "owner" : "agent" } : null));
  assert.equal(OLD_PAGE_PATH, "/board");
  assert.equal((await get("/board", null)).status, 401, "no identity, no page");

  const r1 = await get("/board"), r2 = await get("/board");
  assert.equal(r1.status, 200);
  assert.equal(r1.headers.get("content-type"), "text/html; charset=utf-8");
  for (const [h, v] of [["cache-control", "no-store"], ["x-content-type-options", "nosniff"], ["referrer-policy", "no-referrer"], ["x-frame-options", "DENY"]]) assert.equal(r1.headers.get(h), v, h);
  const csp = r1.headers.get("content-security-policy"), nonce = /'nonce-([A-Za-z0-9_-]{24})'/.exec(csp)?.[1];
  assert.ok(nonce, csp);
  assert.equal(csp, oldPageCsp(nonce));
  for (const part of ["default-src 'none'", `script-src 'nonce-${nonce}'`, "font-src 'self'", "img-src 'self' blob:", "connect-src 'self'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'", "object-src 'none'"]) assert.ok(csp.split("; ").includes(part), part);
  assert.doesNotMatch(csp, /unsafe-eval|https?:|\*/, "no other site, no eval");
  assert.doesNotMatch(csp.split("; ").find((p) => p.startsWith("script-src")), /unsafe-inline/);
  const html = await r1.text();
  assert.equal(html, withNonce(page, nonce));
  assert.equal((html.match(new RegExp(`<script nonce="${nonce}">`, "g")) ?? []).length, 1);
  assert.notEqual(/'nonce-([^']+)'/.exec(r2.headers.get("content-security-policy"))[1], nonce, "a new nonce per response");

  assert.equal((await get("/board", "owner", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 404, "GET only");
  assert.equal((await get("/board.html")).status, 404, "the asset itself is not a route");
});

test("the Worker serves only the six named font files, behind the identity check", async () => {
  const fonts = Object.fromEntries(FONT_FACES.map((f) => [`/fonts/${f.file}`, `woff2:${f.file}`]));
  const env = { DB: makeDb(), ASSETS: { fetch: async (req) => { const p = new URL(req.url).pathname; return p in fonts ? new Response(fonts[p]) : new Response("", { status: 404 }); } } };
  const get = (path, as = "owner") => worker.fetch(new Request(`https://board.test${path}`), env, null, 1_800_000_000_000, async () => (as ? { who: as, role: "owner" } : null));
  const f = FONT_FACES[0].file;
  const r = await get(`/fonts/${f}`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "font/woff2");
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.equal(await r.text(), `woff2:${f}`);
  assert.equal((await get(`/fonts/${f}`, null)).status, 401);
  for (const bad of ["/fonts/missing.woff2", "/fonts/../board.html", "/fonts/x.woff", "/fonts/A.woff2", "/fonts/"]) assert.equal((await get(bad)).status, 404, bad);
});

test("without its built assets the Worker says the page is not built (503), never an empty page", async () => {
  const env = { DB: makeDb() };
  const r = await worker.fetch(new Request("https://board.test/board"), env, null, 1_800_000_000_000, async () => ({ who: "owner", role: "owner" }));
  assert.equal(r.status, 503);
  assert.match(await r.text(), /not built/);
});

test("the six fonts are in the repository, each with its licence (@fontsource, the owner's yes on #T1668)", () => {
  for (const f of FONT_FACES) {
    const bytes = readFileSync(new URL(f.file, FONTS_DIR));
    assert.equal(bytes.subarray(0, 4).toString("latin1"), "wOF2", f.file);
  }
  for (const lic of ["barlow-condensed-OFL.txt", "source-sans-3-OFL.txt", "jetbrains-mono-OFL.txt"]) assert.match(readFileSync(new URL(lic, FONTS_DIR), "utf8"), /SIL OPEN FONT LICENSE/i, lic);
});

test("the Worker config ships the built page as assets, Worker first", () => {
  const t = readFileSync(new URL("../worker/wrangler.board.toml", import.meta.url), "utf8");
  assert.match(t, /^\[assets\]\ndirectory = "\.\.\/dist\/store-page"\nbinding = "ASSETS"\nrun_worker_first = true$/m);
});
