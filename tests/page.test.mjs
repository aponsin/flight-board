import test from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import worker from "../worker/board-worker.mjs";
import { createAsk } from "../worker/board-store.mjs";

test("the root is the board page (#C829): the old-look page at /, /board only redirects there, both behind the identity check and not for the probe", async () => {
  const env = { DB: makeDb(), ASSETS: { fetch: async (req) => (new URL(req.url).pathname === "/board.html" ? new Response("<html><style>a{}</style><script>x</script></html>") : new Response("", { status: 404 })) } };
  const get = (path, auth) => worker.fetch(new Request("https://b.test" + path), env, null, 1, async () => auth);
  assert.equal((await get("/", null)).status, 401);
  assert.equal((await get("/board", null)).status, 401, "the redirect is behind the check too");
  assert.equal((await get("/", { who: "probe", role: "probe" })).status, 403);
  assert.equal((await get("/board", { who: "probe", role: "probe" })).status, 403);
  const ok = await get("/", { who: "owner", role: "owner" });
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get("content-security-policy"), /script-src 'nonce-[A-Za-z0-9_-]{24}'/, "the old page's policy, not the bare page's");
  assert.doesNotMatch(ok.headers.get("content-security-policy"), /unsafe-inline'; style-src 'unsafe-inline'; connect/);
  assert.match(await ok.text(), /<script nonce=/);
  const red = await get("/board", { who: "owner", role: "owner" });
  assert.equal(red.status, 302);
  assert.equal(red.headers.get("location"), "/");
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
