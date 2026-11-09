// The file store (#C726 C1): the rules of worker/file-store.mjs, and its routes through the Worker on the in-memory D1 and a
// Map standing in for R2.
import test from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import worker from "../worker/board-worker.mjs";
import { refuse } from "../worker/board-store.mjs";
import { sniffRefusal, cleanName, decodeBase64, parseShot, putFile, filesRefusal, linkFiles, screenshotsRefusal, readFiles, applyFiles, MAX_FILE_BYTES, MAX_TOTAL_BYTES, MAX_DAY_BYTES_PER_CALLER, MAX_BODY_BYTES } from "../worker/file-store.mjs";

const NOW = 1_800_000_000_000;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const b64 = (bytes) => Buffer.from(bytes).toString("base64");
const fakeR2 = () => {
  const m = new Map();
  return { m, put: async (k, v, o) => { m.set(k, { bytes: new Uint8Array(v), type: o?.httpMetadata?.contentType }); }, get: async (k) => (m.has(k) ? { body: m.get(k).bytes } : null), delete: async (k) => { m.delete(k); } };
};
const WHO = { manager: { who: "Manager", role: "agent" }, owner: { who: "owner", role: "owner" }, probe: { who: "probe", role: "probe" } };
const make = (withBucket = true) => {
  const env = { DB: makeDb(), ...(withBucket ? { FILES: fakeR2() } : {}) };
  const call = (as, path, init = {}) => worker.fetch(new Request(`https://board.test${path}`, init.method === "POST" ? { ...init, headers: { "content-type": "application/json", "x-as": as, ...init.headers } } : { ...init, headers: { "x-as": as, ...init.headers } }), env, null, NOW, async (req) => WHO[req.headers.get("x-as")] ?? null);
  const tool = async (as, name, args) => (await (await call(as, "/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) })).json()).result.structuredContent;
  const upload = async (body, as = "owner") => { const r = await call(as, "/api/files", { method: "POST", body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => null) }; };
  return { env, call, tool, upload };
};

test("the first bytes must match the type; text kinds must be UTF-8 without NUL", () => {
  assert.equal(sniffRefusal("image/png", PNG), null);
  assert.equal(sniffRefusal("image/png", new TextEncoder().encode("<html><script>")).rule, "file-content");
  assert.equal(sniffRefusal("image/jpeg", new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), null);
  assert.equal(sniffRefusal("application/pdf", new TextEncoder().encode("%PDF-1.7")), null);
  assert.equal(sniffRefusal("image/webp", new TextEncoder().encode("RIFF1234WEBPVP8 ")), null);
  assert.equal(sniffRefusal("text/plain", new TextEncoder().encode("héllo <b>")), null);
  assert.equal(sniffRefusal("text/plain", new Uint8Array([0x61, 0, 0x62])).rule, "file-content");
  assert.equal(sniffRefusal("text/csv", new Uint8Array([0xc3, 0x28])).rule, "file-content");
});

test("a stored name has no path and no control characters; base64 is strict", () => {
  assert.equal(cleanName("../../etc/passwd"), "passwd"); assert.equal(cleanName("a\u0000b\nc.png"), "abc.png"); assert.equal(cleanName(""), "file");
  assert.equal(cleanName("x".repeat(300)).length, 200);
  // Cut by code point, lone surrogates dropped: the stored name is always well-formed, so the download header never throws.
  const emoji = cleanName("a".repeat(199) + "😀😀");
  assert.equal(Array.from(emoji).length, 200); assert.ok(emoji.isWellFormed());
  assert.equal(cleanName("x\ud800y\udc00z.png"), "xyz.png");
  // No bidi controls (Checker's LOW on #C726): a name can't display reversed.
  assert.equal(cleanName("evil‮gnp.exe"), "evilgnp.exe");
  assert.equal(cleanName("a⁦b⁩c‏d؜e.txt"), "abcde.txt");
  assert.doesNotThrow(() => encodeURIComponent(cleanName("\ud83d")));
  assert.deepEqual([...decodeBase64("AQID")], [1, 2, 3]); assert.equal(decodeBase64("AQI"), null); assert.equal(decodeBase64("A$=="), null); assert.equal(decodeBase64(5), null);
});

test("a screenshot is \"<id>\", \"<id> label\" or \"<id> A: label\"", () => {
  const id = "abcdefghijklmnop";
  assert.deepEqual(parseShot(id), { id, option: "", label: "" });
  assert.deepEqual(parseShot(`${id} The hero, laptop`), { id, option: "", label: "The hero, laptop" });
  assert.deepEqual(parseShot(`${id} B: green band`), { id, option: "B", label: "green band" });
  assert.equal(parseShot("short"), null); assert.equal(parseShot("https://example.com/x.png"), null);
});

test("putFile stores bytes and the list; every refusal is logged and stores nothing", async () => {
  const db = makeDb(), bucket = fakeR2(), ctx = { db, bucket, now: NOW, who: "owner", refuse };
  const ok = await putFile(ctx, { name: "shot.png", type: "image/png", data: b64(PNG) });
  assert.equal(ok.ok, true); assert.match(ok.id, /^[A-Za-z0-9_-]{32}$/); assert.equal(ok.sizeBytes, PNG.length); assert.equal(ok.contentType, "image/png");
  assert.deepEqual(bucket.m.get(ok.id).bytes, PNG);
  const row = await db.prepare("SELECT name, type, size, added_by FROM files WHERE id = ?").bind(ok.id).first();
  assert.deepEqual(row, { name: "shot.png", type: "image/png", size: PNG.length, added_by: "owner" });
  const cases = [
    [{ name: "a.svg", type: "image/svg+xml", data: b64(PNG) }, "file-type"],
    [{ name: "a.png", type: "image/png", data: "" }, "file-empty"],
    [{ name: "a.png", type: "image/png", data: "not base64!" }, "file-shape"],
    [{ name: "a.png", type: "image/png", data: b64(new TextEncoder().encode("<svg onload=alert(1)>")) }, "file-content"],
    [{ name: "a.png", type: "image/png", data: "A".repeat(Math.ceil(MAX_FILE_BYTES / 3) * 4 + 8) }, "file-too-large"],
  ];
  for (const [f, rule] of cases) assert.equal((await putFile(ctx, f)).refused.rule, rule, rule);
  assert.equal(bucket.m.size, 1);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM refusals WHERE rule LIKE 'file-%'").first()).n, cases.length);
  assert.equal((await putFile({ ...ctx, bucket: undefined }, { name: "a.png", type: "image/png", data: b64(PNG) })).refused.rule, "file-store-off");
});

test("the store's whole size and each caller's day are capped; a decoded file over 15 MB is refused; a failed list write takes the bytes back", async () => {
  const seed = async (db, n, who, at) => { for (let i = 0; i < n; i++) await db.prepare("INSERT INTO files (id, name, type, size, sha256, added_by, added_at) VALUES (?, 'x', 'image/png', ?, '', ?, ?)").bind(`seed${who}${String(i).padStart(14, "0")}`, MAX_FILE_BYTES, who, at).run(); };
  // The whole store: full up to the last file, refused for anyone.
  const full = makeDb(), bucket = fakeR2();
  await seed(full, Math.ceil(MAX_TOTAL_BYTES / MAX_FILE_BYTES), "old", NOW - 30 * 864e5);
  assert.equal((await putFile({ db: full, bucket, now: NOW, who: "owner", refuse }, { name: "a.png", type: "image/png", data: b64(PNG) })).refused.rule, "file-quota");
  // The agents' day is one cap for all of them (#C727, Security's LOW): Builder filled it, so Checker is refused too; the owner
  // has his own; yesterday's uploads do not count.
  const day = makeDb();
  await seed(day, Math.ceil(MAX_DAY_BYTES_PER_CALLER / MAX_FILE_BYTES), "Builder", NOW - 60_000);
  assert.equal((await putFile({ db: day, bucket, now: NOW, who: "Builder", refuse }, { name: "a.png", type: "image/png", data: b64(PNG) })).refused.rule, "file-quota-daily");
  assert.equal((await putFile({ db: day, bucket, now: NOW, who: "Checker", refuse }, { name: "a.png", type: "image/png", data: b64(PNG) })).refused.rule, "file-quota-daily", "another role shares the agents' cap");
  assert.equal((await putFile({ db: day, bucket, now: NOW, who: "owner", refuse }, { name: "a.png", type: "image/png", data: b64(PNG) })).ok, true);
  const owners = makeDb();
  await seed(owners, Math.ceil(MAX_DAY_BYTES_PER_CALLER / MAX_FILE_BYTES), "owner", NOW - 60_000);
  assert.equal((await putFile({ db: owners, bucket, now: NOW, who: "owner", refuse }, { name: "a.png", type: "image/png", data: b64(PNG) })).refused.rule, "file-quota-daily");
  assert.equal((await putFile({ db: owners, bucket, now: NOW, who: "Builder", refuse }, { name: "a.png", type: "image/png", data: b64(PNG) })).ok, true);
  assert.equal((await putFile({ db: day, bucket, now: NOW + 864e5 + 1, who: "Builder", refuse }, { name: "a.png", type: "image/png", data: b64(PNG) })).ok, true);
  // Three bytes over: the base64 is short enough to be decoded, the bytes are not.
  const big = new Uint8Array(MAX_FILE_BYTES + 1); big.set(PNG);
  assert.equal((await putFile({ db: makeDb(), bucket, now: NOW, who: "owner", refuse }, { name: "big.png", type: "image/png", data: b64(big) })).refused.rule, "file-too-large");
  // The list write fails after the bytes are in: they are taken back, nothing is half-stored.
  const db = makeDb(), r2 = fakeR2(), real = db.prepare;
  db.prepare = (sql) => (/^INSERT INTO files/.test(sql) ? { bind: () => ({ run: async () => { throw new Error("D1 down"); } }) } : real(sql));
  await assert.rejects(putFile({ db, bucket: r2, now: NOW, who: "owner", refuse }, { name: "a.png", type: "image/png", data: b64(PNG) }), /D1 down/);
  assert.equal(r2.m.size, 0);
});

test("a request body over one file's size is refused before it is read (413)", async () => {
  const { call } = make();
  const r = await call("owner", "/api/files", { method: "POST", headers: { "content-length": String(MAX_BODY_BYTES + 1) }, body: "{}" });
  assert.equal(r.status, 413);
  const c = await worker.fetch(new Request("https://board.test/mcp/anything", { method: "POST", headers: { "content-type": "application/json", "content-length": String(MAX_BODY_BYTES + 1) }, body: "{}" }), { DB: makeDb() }, null, NOW, async () => null);
  assert.equal(c.status, 413, "the connector too");
});

test("a send's files must be stored ids, at most ten, each once; links keep their order", async () => {
  const db = makeDb(), bucket = fakeR2(), ctx = { db, bucket, now: NOW, who: "owner", refuse };
  const a = await putFile(ctx, { name: "a.png", type: "image/png", data: b64(PNG) });
  const b = await putFile(ctx, { name: "b.txt", type: "text/plain", data: b64(new TextEncoder().encode("hi")) });
  assert.deepEqual(await filesRefusal(db, [{ id: b.id, name: "renamed by the page" }, { id: a.id }]), { ids: [b.id, a.id] });
  assert.deepEqual(await filesRefusal(db, undefined), { ids: [] });
  assert.equal((await filesRefusal(db, [{ id: "zzzzzzzzzzzzzzzzzzzz" }])).refused.rule, "file-unknown");
  assert.equal((await filesRefusal(db, [{ id: a.id }, { id: a.id }])).refused.rule, "files-shape");
  assert.equal((await filesRefusal(db, Array(11).fill({ id: a.id }))).refused.rule, "files-shape");
  assert.equal((await filesRefusal(db, [{ id: "../x" }])).refused.rule, "files-shape");
  await linkFiles(db, NOW, "answer", "t1", [b.id, a.id]);
  const { links } = await readFiles(db, []);
  assert.deepEqual(links.map((l) => [l.ref_kind, l.ref_id, l.name]), [["answer", "t1", "b.txt"], ["answer", "t1", "a.png"]]);
});

test("an ask's screenshots must be stored images; the view turns them into the old images list, and links into files and assets", async () => {
  const db = makeDb(), bucket = fakeR2(), ctx = { db, bucket, now: NOW, who: "Designer", refuse };
  const img = await putFile(ctx, { name: "hero.png", type: "image/png", data: b64(PNG) });
  const txt = await putFile(ctx, { name: "log.txt", type: "text/plain", data: b64(new TextEncoder().encode("x")) });
  assert.equal(await screenshotsRefusal(db, [`${img.id} A: blue`]), null);
  assert.equal((await screenshotsRefusal(db, [txt.id])).rule, "screenshots-shape");
  assert.equal((await screenshotsRefusal(db, ["https://evil.example/x.png"])).rule, "screenshots-shape");
  assert.equal((await screenshotsRefusal(db, ["zzzzzzzzzzzzzzzzzzzz"])).rule, "file-unknown");
  await linkFiles(db, NOW, "answer", "t1", [txt.id]);
  await linkFiles(db, NOW, "message", "m-1", [img.id]);
  const asks = [{ id: "t1", body: JSON.stringify({ screenshots: [`${img.id} A: blue`, `${img.id} the page`, "zzzzzzzzzzzzzzzzzzzz"] }) }];
  const view = { asks, files: await readFiles(db, asks) };
  const c = applyFiles({ waiting: [{ id: "t1", response: { status: "chose", choice: "A" } }], messages: [{ id: "m-1", text: "see" }, { id: "m-2" }] }, view);
  assert.deepEqual(c.waiting[0].images, [{ url: `/_blob/${img.id}`, label: "blue", option: "A" }, { url: `/_blob/${img.id}`, label: "the page" }]);
  assert.deepEqual(c.waiting[0].response.files, [{ id: txt.id, name: "log.txt", type: "text/plain", size: 1 }]);
  assert.deepEqual(c.messages[0].assets, [{ id: img.id, name: "hero.png", type: "image/png", size: PNG.length }]);
  assert.equal(c.messages[1].assets, undefined);
  assert.deepEqual(applyFiles({ waiting: [] }, { asks: [] }), { waiting: [] }, "a view without files changes nothing");
});

test("POST /api/files: owner only, JSON only, same site; GET /_blob serves the stored type, never sniffed, in a sandbox", async () => {
  const { call, upload } = make();
  assert.equal((await upload({ name: "a.png", type: "image/png", data: b64(PNG) }, "manager")).status, 403);
  assert.equal((await upload({ name: "a.png", type: "image/png", data: b64(PNG) }, "probe")).status, 403);
  const cross = await call("owner", "/api/files", { method: "POST", headers: { origin: "https://evil.test" }, body: "{}" });
  assert.equal(cross.status, 403);
  const plain = await call("owner", "/api/files", { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" });
  assert.equal(plain.status, 415);
  const bad = await upload({ name: "a.png", type: "image/png", data: b64(new TextEncoder().encode("<html>")) });
  assert.equal(bad.status, 422); assert.equal(bad.body.refused.rule, "file-content");
  const ok = await upload({ name: "a b.png", type: "image/png", data: b64(PNG) });
  assert.equal(ok.status, 200);
  const r = await call("owner", `/_blob/${ok.body.id}`);
  assert.equal(r.status, 200);
  assert.deepEqual(new Uint8Array(await r.arrayBuffer()), PNG);
  assert.equal(r.headers.get("content-type"), "image/png");
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.equal(r.headers.get("content-security-policy"), "default-src 'none'; sandbox");
  assert.match(r.headers.get("content-disposition"), /^inline; filename="a b.png"/);
  assert.equal((await call("manager", `/_blob/${ok.body.id}`)).status, 200, "an agent behind Access reads it too");
  assert.equal((await call("probe", `/_blob/${ok.body.id}`)).status, 403);
  assert.equal((await call("owner", "/_blob/zzzzzzzzzzzzzzzzzzzz")).status, 404);
  assert.equal((await call("owner", "/_blob/..%2Fx")).status, 404);
  assert.equal((await call("nobody", `/_blob/${ok.body.id}`)).status, 401);
});

test("a text file is a download as text/plain with a charset; a name with quotes cannot break the header", async () => {
  const { call, upload } = make();
  const ok = await upload({ name: 'x"; y=.txt', type: "text/plain", data: b64(new TextEncoder().encode("<script>alert(1)</script>")) });
  const r = await call("owner", `/_blob/${ok.body.id}`);
  assert.equal(r.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.match(r.headers.get("content-disposition"), /^attachment; filename="x_; y=.txt"; filename\*=UTF-8''x%22%3B%20y%3D.txt$/);
});

test("an agent stores a screenshot with the file_put tool; without a bucket the store says it is off", async () => {
  const { tool } = make();
  const r = await tool("manager", "file_put", { name: "hero.png", type: "image/png", data_base64: b64(PNG) });
  assert.equal(r.ok, true); assert.match(r.id, /^[A-Za-z0-9_-]{32}$/);
  const off = make(false);
  assert.equal((await off.tool("manager", "file_put", { name: "hero.png", type: "image/png", data_base64: b64(PNG) })).refused.rule, "file-store-off");
  assert.equal((await off.call("owner", "/_blob/zzzzzzzzzzzzzzzzzzzz")).status, 404);
});
