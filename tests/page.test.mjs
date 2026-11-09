import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import worker from "../worker/board-worker.mjs";
import { pageHtml } from "../worker/page.mjs";
import { createCard, createAsk, writeEvidence } from "../worker/board-store.mjs";

const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const chromeOk = existsSync(CHROME);

test("board text reaches the page only as text: the one innerHTML is the header built from our own functions", () => {
  const html = pageHtml({ version: "v1" });
  assert.equal((html.match(/innerHTML/g) ?? []).length, 1);
  assert.match(html, /\$\("hd"\)\.innerHTML = headerHtml\(/);
  assert.doesNotMatch(html, /document\.write|eval\(/);
});

test("the version stamp is sanitized", () => assert.doesNotMatch(pageHtml({ version: '"><script>x</script>' }), /<script>x/));

test("the page is served with a locked-down content policy and needs a signed-in identity", async () => {
  const env = { DB: makeDb() };
  const denied = await worker.fetch(new Request("https://b.test/"), env, null, 1, async () => null);
  assert.equal(denied.status, 401);
  const ok = await worker.fetch(new Request("https://b.test/"), env, null, 1, async () => ({ who: "owner", role: "owner" }));
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get("content-security-policy"), /default-src 'none'.*connect-src 'self'/);
  assert.equal(ok.headers.get("x-content-type-options"), "nosniff");
});

test("only the owner answers from the page; a bad option is refused with 422", async () => {
  const env = { DB: makeDb() };
  const as = (role, who) => async () => ({ who, role });
  const a = await createAsk(env.DB, 1000, { type: "Decision", title: "Pick", asked_by: "Manager", question: "A or B?", options: ["A", "B"], recommended: "A" });
  const post = (auth, body) => worker.fetch(new Request("https://b.test/api/answer", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), env, null, 2000, auth);
  assert.equal((await post(as("agent", "Manager"), { id: a.id, answer: "A" })).status, 403);
  assert.equal((await post(as("owner", "owner"), { id: a.id, answer: "C" })).status, 422);
  assert.equal((await post(as("owner", "owner"), { id: a.id, answer: "B" })).status, 200);
});

// Real browser against the real Worker code: a hostile card title is shown as text, the ask has its buttons, every tile shows
// its source and age, and the header is one row at phone width with real data.
test("the page in headless Chrome: text not markup, buttons, sources, one-row header at 375", { skip: chromeOk ? false : "no Chrome" }, async () => {
  const env = { DB: makeDb() };
  const now = Date.now();
  await createCard(env.DB, now, "Manager", { id: "c-one", title: '<img src=x onerror="document.title=\'pwned\'">', next_note: "n" });
  await writeEvidence(env.DB, now - 5000, "probe", "cards.c-one", { lit: ["build"] });
  await writeEvidence(env.DB, now - 4000, "probe", "live", { version: "v1.2.3" });
  await createAsk(env.DB, now, { type: "Decision", title: "Pick", asked_by: "Manager", question: "A or B?", options: ["A", "B"], recommended: "A" });
  const auth = async () => ({ who: "owner", role: "owner" });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/__outer") { // test harness only: same-origin frame of an exact width, measured after the page has drawn
      const w = Number(url.searchParams.get("w"));
      res.setHeader("content-type", "text/html");
      return res.end(`<body style="margin:0"><iframe id="f" src="/" style="border:0;width:${w}px;height:800px"></iframe><script>setTimeout(()=>{const d=document.getElementById("f").contentDocument,h=d.querySelector(".hd"),b=d.body;
document.documentElement.dataset.result=JSON.stringify({title:d.title,hdH:h&&h.getBoundingClientRect().height,scrollW:d.documentElement.scrollWidth,clientW:d.documentElement.clientWidth,text:b.innerText,buttons:[...d.querySelectorAll("button")].map(x=>x.textContent),imgs:d.querySelectorAll("img").length});},1500);</script>`);
    }
    const r = await worker.fetch(new Request(`http://x${req.url}`, { method: req.method }), env, null, Date.now(), auth);
    res.writeHead(r.status, Object.fromEntries(r.headers));
    res.end(Buffer.from(await r.arrayBuffer()));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    for (const w of [375, 1440]) {
      const out = await new Promise((resolve) => {
        const c = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-sandbox", "--window-size=1600,1000", "--virtual-time-budget=6000", "--dump-dom", `http://127.0.0.1:${server.address().port}/__outer?w=${w}`]);
        let s = ""; c.stdout.on("data", (d) => (s += d)); c.on("close", () => resolve(s));
      });
      const m = /data-result="([^"]*)"/.exec(out) ?? /data-result='([^']*)'/.exec(out);
      assert.ok(m, `no result at ${w}: ${out.slice(0, 300)}`);
      const res = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"));
      assert.equal(res.title, "Flight board", "the hostile title ran script");
      assert.equal(res.imgs, 0, "board text became markup");
      assert.match(res.text, /<img src=x/, "the hostile title is shown as text");
      assert.deepEqual(res.buttons, ["A (recommended)", "B"]);
      assert.match(res.text, /source: the probe, read \d+ s ago/);
      assert.match(res.text, /source: the asking session/);
      assert.ok(res.hdH <= 44, `header ${res.hdH}px at ${w}`);
      assert.ok(res.scrollW <= res.clientW, `sideways scroll at ${w}`);
    }
  } finally { server.close(); }
});
