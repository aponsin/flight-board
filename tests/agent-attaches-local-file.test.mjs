// #C1056: an agent puts a file that is already on the Mac into the board's file store in one step, with no base64 through a model. scripts/put-file.mjs reads
// the probe's own token from its env file and posts to POST /api/probe/file, which only stores a file and returns its id. Two halves tested here: the Worker's route
// (probe only, the same putFile rules and quotas) and the script's limits (what it will read, what it will say).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, symlinkSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeDb } from "./helpers/d1-sqlite.mjs";
import { checkConfig, fullConfig } from "../scripts/config.mjs";
import worker from "../worker/board-worker.mjs";
import { MAX_BODY_BYTES, MAX_DAY_BYTES_PER_CALLER, MAX_FILE_BYTES } from "../worker/file-store.mjs";
import { TYPES, checkPath, credentials, rootsFor, putLocalFile, main } from "../scripts/put-file.mjs";

const NOW = 1_800_000_000_000;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const SECRET = "s3cr3t-token-value-abcdefghij";
const scratch = [];
const dir = () => { const d = realpathSync(mkdtempSync(join(tmpdir(), "put-"))); scratch.push(d); return d; };
test.after(() => { for (const d of scratch) rmSync(d, { recursive: true, force: true }); });

// The Worker, on the in-memory D1 and a Map standing in for R2 (as tests/file-store.test.mjs).
const fakeR2 = () => { const m = new Map(); return { m, put: async (k, v, o) => { m.set(k, { bytes: new Uint8Array(v), type: o?.httpMetadata?.contentType }); }, get: async (k) => (m.has(k) ? { body: m.get(k).bytes } : null), delete: async (k) => { m.delete(k); } }; };
const WHO = { manager: { who: "Manager", role: "agent" }, owner: { who: "owner", role: "owner" }, probe: { who: "probe", role: "probe" } };
const make = () => {
  const env = { DB: makeDb(), FILES: fakeR2() };
  const call = (as, path, init = {}) => worker.fetch(new Request(`https://board.test${path}`, init.method === "POST" ? { ...init, headers: { "content-type": "application/json", "x-as": as, ...init.headers } } : { ...init, headers: { "x-as": as, ...init.headers } }), env, null, NOW, async (req) => WHO[req.headers.get("x-as")] ?? null);
  const put = async (as, body) => { const r = await call(as, "/api/probe/file", { method: "POST", body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => null) }; };
  return { env, call, put };
};
const png = { name: "icon.png", type: "image/png", data: PNG.toString("base64") };

test("the probe's token stores a file and gets its id; an agent can then read it at /_blob and the probe cannot", async () => {
  const { env, call, put } = make();
  const r = await put("probe", png);
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.deepEqual([r.body.name, r.body.contentType, r.body.sizeBytes], ["icon.png", "image/png", PNG.length]);
  assert.equal(env.FILES.m.get(r.body.id).bytes.length, PNG.length);
  assert.equal((await call("manager", `/_blob/${r.body.id}`)).status, 200);
  assert.equal((await call("probe", `/_blob/${r.body.id}`)).status, 403, "the probe still reads no file back");
  const row = await env.DB.prepare("SELECT added_by FROM files WHERE id = ?").bind(r.body.id).first();
  assert.equal(row.added_by, "probe");
});

test("only the probe's role may use it: the owner and an agent get 403, and nothing is stored", async () => {
  const { env, call, put } = make();
  for (const as of ["owner", "manager"]) assert.equal((await put(as, png)).status, 403, as);
  assert.equal((await call("nobody", "/api/probe/file", { method: "POST", body: "{}" })).status, 401);
  assert.equal(env.FILES.m.size, 0);
});

test("it is putFile's own rules: a type outside the list, bytes that are not the type, an empty file and a body over the cap are each refused", async () => {
  const { env, call, put } = make();
  assert.equal((await put("probe", { ...png, type: "text/html" })).body.refused.rule, "file-type");
  assert.equal((await put("probe", { ...png, data: Buffer.from("<html><script>x</script>").toString("base64") })).body.refused.rule, "file-content");
  assert.equal((await put("probe", { ...png, data: "" })).body.refused.rule, "file-empty");
  assert.equal((await put("probe", { ...png, data: "not base64!" })).body.refused.rule, "file-shape");
  assert.equal((await call("probe", "/api/probe/file", { method: "POST", headers: { "content-length": String(MAX_BODY_BYTES + 1) }, body: "{}" })).status, 413);
  assert.equal((await call("probe", "/api/probe/file", { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" })).status, 415);
  assert.equal((await call("probe", "/api/probe/file", { method: "POST", headers: { origin: "https://evil.test" }, body: "{}" })).status, 403);
  assert.equal(env.FILES.m.size, 0);
});

test("the probe counts with the agents in the daily cap, so this route cannot add to it", async () => {
  const { env, put } = make();
  // An agent filled the day (full-size files, as tests/file-store.test.mjs seeds it); the probe is refused as another agent would be.
  for (let i = 0; i < Math.ceil(MAX_DAY_BYTES_PER_CALLER / MAX_FILE_BYTES); i++) await env.DB.prepare("INSERT INTO files (id, name, type, size, sha256, added_by, added_at) VALUES (?, 'x', 'image/png', ?, '', 'Manager', ?)").bind(`seedManager${String(i).padStart(14, "0")}`, MAX_FILE_BYTES, NOW - 60_000).run();
  const r = await put("probe", png);
  assert.equal(r.status, 422);
  assert.equal(r.body.refused.rule, "file-quota-daily");
  assert.equal((await put("probe", png)).body.refused.rule, "file-quota-daily");
});

// The script's limits.
const tree = () => {
  const root = dir(), outside = dir();
  mkdirSync(join(root, "mockups"), { recursive: true });
  const f = (p, bytes = PNG, mode = 0o644) => { const full = join(root, p); mkdirSync(join(full, ".."), { recursive: true }); writeFileSync(full, bytes); chmodSync(full, mode); return full; };
  return { root, outside, f };
};
const why = (r) => (r.ok ? "ok" : r.reason);

test("checkPath: a plain picture or text file inside the folder passes, with its type and size", () => {
  const { root, f } = tree();
  const ok = checkPath(f("mockups/options-A.png"), { roots: [root] });
  assert.deepEqual([ok.ok, ok.type, ok.size, ok.name], [true, "image/png", PNG.length, "options-A.png"]);
  assert.equal(checkPath(f("notes.md", Buffer.from("# hi")), { roots: [root] }).type, "text/markdown");
  assert.equal(checkPath(f("keyboard.png"), { roots: [root] }).ok, true, "key is refused as a word, not inside another word");
});

test("checkPath: outside the folders is refused: a path elsewhere, a .. out, a sibling that shares the folder's name as a prefix, a link out", () => {
  const { root, outside, f } = tree();
  const elsewhere = join(outside, "x.png"); writeFileSync(elsewhere, PNG);
  assert.match(why(checkPath(elsewhere, { roots: [root] })), /outside the folders/);
  assert.match(why(checkPath(join(root, "..", outside.split("/").pop(), "x.png"), { roots: [root] })), /outside the folders/);
  const sibling = root + "-extra"; mkdirSync(sibling); scratch.push(sibling); writeFileSync(join(sibling, "x.png"), PNG);
  assert.match(why(checkPath(join(sibling, "x.png"), { roots: [root] })), /outside the folders/);
  symlinkSync(elsewhere, join(root, "link.png"));
  assert.match(why(checkPath(join(root, "link.png"), { roots: [root] })), /outside the folders/, "a link inside the folder that points out is judged by where it lands");
  assert.match(why(checkPath(f("a.png").replace(root, "relative"), { roots: [root] })), /absolute|no such/);
  assert.match(why(checkPath("relative/x.png", { roots: [root] })), /absolute/);
  assert.equal(checkPath(root, { roots: [root] }).ok, false, "the folder itself");
});

test("checkPath: what looks like a secret is refused even inside the folder: dot names, secret words, owner-only files, JSON and other types", () => {
  const { root, f } = tree();
  const bad = (p, re, bytes, mode) => assert.match(why(checkPath(f(p, bytes, mode), { roots: [root] })), re, p);
  bad(".hidden.png", /dot/);
  bad(".git/x.png", /dot/);
  bad("board.private.json", /secret|JSON|json/);
  bad("private-notes.txt", /looks like a secret/);
  bad("my-key.png", /looks like a secret/);
  bad("probe.env.txt", /looks like a secret/);
  bad("Token_list.md", /looks like a secret/);
  bad("owner-only.png", /owner only/, PNG, 0o600);
  bad("data.json", /only \.png/);
  bad("run.sh", /only \.png/);
  bad("noext", /no-extension/);
  bad("empty.png", /empty/, Buffer.alloc(0));
  assert.deepEqual(Object.keys(TYPES).includes(".json"), false);
  assert.match(why(checkPath(join(root, "mockups"), { roots: [root] })), /not a plain file/);
  assert.match(why(checkPath(join(root, "nope.png"), { roots: [root] })), /no such file/);
  assert.match(why(checkPath("", { roots: [root] })), /path of one file/);
});

test("checkPath: a file over the store's cap is refused without being read", () => {
  const { root, f } = tree();
  const p = f("big.png");
  const stat = (x) => ({ isFile: () => true, mode: 0o644, size: 15 * 1024 * 1024 + 1, ...(x ? {} : {}) });
  assert.match(why(checkPath(p, { roots: [root], stat })), /byte cap/);
});

test("the folders a file may come from are the one that holds the board config, plus the config's own fileRoots; nothing is named in the code", () => {
  const home = dir(), board = dir(), extra = dir();
  const cfg = (v) => { const p = join(board, "board.config.json"); writeFileSync(p, JSON.stringify(v)); return p; };
  assert.deepEqual(rootsFor(cfg({})).roots, [board]);
  assert.deepEqual(rootsFor(cfg({ fileRoots: [extra, "~/mockups"] }), { home }).roots, [board, extra, join(home, "mockups")]);
  const bad = (v, re) => assert.match(why(rootsFor(cfg({ fileRoots: v }))), re, JSON.stringify(v));
  bad("x", /fileRoots/);
  bad(["relative/dir"], /fileRoots/);
  bad(["/a/../etc"], /fileRoots/);
  bad(["~/a/../../b"], /fileRoots/);
  bad([5], /fileRoots/);
  bad(Array.from({ length: 6 }, (_, i) => `/r${i}`), /fileRoots/);
  assert.match(why(rootsFor(undefined)), /--config/);
  assert.match(why(rootsFor(join(board, "missing.json"))), /cannot be read/);
  writeFileSync(join(board, "bad.json"), "not json");
  assert.match(why(rootsFor(join(board, "bad.json"))), /JSON/);
  assert.match(why(checkPath(join(board, "a.png"), {})), /no folder to take a file from/);
  assert.match(why(checkPath(join(board, "a.png"), { roots: [] })), /no folder to take a file from/);
});

test("config: fileRoots defaults to none; up to 5 absolute (or ~/) folders with no .. are accepted, anything else is refused", () => {
  assert.deepEqual(fullConfig({}).fileRoots, []);
  assert.deepEqual(checkConfig({ fileRoots: ["/Users/x/mockups", "~/designs"] }), []);
  for (const v of ["x", ["rel/dir"], ["/a/../b"], [5], [""], ["/"], Array.from({ length: 6 }, (_, i) => `/r${i}`)]) assert.ok(checkConfig({ fileRoots: v }).some((e) => /fileRoots/.test(e)), JSON.stringify(v));
});

test("a file in the config's folder goes; the same file anywhere else does not, whatever the command line says", async () => {
  const { root, outside, f } = tree();
  const config = join(root, "board.config.json"); writeFileSync(config, "{}");
  const inside = f("mockups/a.png"), elsewhere = join(outside, "a.png"); writeFileSync(elsewhere, PNG);
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, id: "abc123def456ghi789jkl", name: "a.png", contentType: "image/png", sizeBytes: PNG.length }) });
  const env = envFile(GOOD_ENV);
  assert.equal((await putLocalFile({ path: inside, envFile: env, configPath: config, fetchImpl })).ok, true);
  assert.match(why(await putLocalFile({ path: elsewhere, envFile: env, configPath: config, fetchImpl: () => assert.fail("nothing is sent") })), /outside the folders/);
  assert.match(why(await putLocalFile({ path: inside, envFile: env, fetchImpl: () => assert.fail("nothing is sent") })), /--config/);
});

const envFile = (text, mode = 0o600) => { const p = join(dir(), "probe.env"); writeFileSync(p, text); chmodSync(p, mode); return p; };
const GOOD_ENV = `BOARD_SERVICE_TOKEN_ID=idvalue\nBOARD_SERVICE_TOKEN_SECRET=${SECRET}\nBOARD_BASE_URL=https://board.test/\n`;

test("credentials: the probe's env file, only when it is readable by its owner alone, has both token parts and an https address", () => {
  const ok = credentials(envFile(GOOD_ENV));
  assert.deepEqual([ok.ok, ok.base, ok.headers["cf-access-client-id"], ok.headers["cf-access-client-secret"]], [true, "https://board.test", "idvalue", SECRET]);
  assert.match(why(credentials(envFile(GOOD_ENV, 0o644))), /owner only/);
  assert.match(why(credentials(envFile(GOOD_ENV, 0o640))), /owner only/);
  assert.match(why(credentials(envFile("BOARD_BASE_URL=https://board.test\n"))), /no BOARD_SERVICE_TOKEN_ID/);
  assert.match(why(credentials(envFile(GOOD_ENV.replace("https", "http")))), /https/);
  assert.match(why(credentials(envFile(GOOD_ENV.replace("board.test/", "board.test/path")))), /https/);
  assert.match(why(credentials(envFile(GOOD_ENV.replace("board.test/", "evil.test@x/")))), /https/);
  assert.match(why(credentials(join(dir(), "missing.env"))), /cannot be read/);
  assert.match(why(credentials(undefined)), /--env/);
  assert.equal(credentials(envFile(GOOD_ENV.replace(/BOARD_BASE_URL=.*\n/, "")), { baseOverride: "https://other.test" }).base, "https://other.test");
});

test("putLocalFile: one POST to /api/probe/file with the token headers and the file's own bytes, no redirect followed; the id comes back", async () => {
  const { root, f } = tree();
  const path = f("a.png"), env = envFile(GOOD_ENV);
  let seen;
  const fetchImpl = async (url, o) => { seen = { url, method: o.method, headers: o.headers, redirect: o.redirect, body: JSON.parse(o.body) }; return { ok: true, status: 200, json: async () => ({ ok: true, id: "abc123def456ghi789jkl", name: "a.png", contentType: "image/png", sizeBytes: PNG.length }) }; };
  const r = await putLocalFile({ path, envFile: env, fetchImpl, roots: [root] });
  assert.deepEqual(r, { ok: true, id: "abc123def456ghi789jkl", name: "a.png", type: "image/png", size: PNG.length });
  assert.deepEqual([seen.url, seen.method, seen.redirect], ["https://board.test/api/probe/file", "POST", "error"]);
  assert.equal(seen.headers["cf-access-client-secret"], SECRET);
  assert.deepEqual(seen.body, { name: "a.png", type: "image/png", data: PNG.toString("base64") });
  assert.equal((await putLocalFile({ path, envFile: env, name: "Option A.png", fetchImpl, roots: [root] })).ok, true);
  assert.equal(seen.body.name, "Option A.png");
});

test("putLocalFile: every failure says why in a few words and never carries the token: a refused path, a bad env file, a Worker refusal, an unreachable board", async () => {
  const { root, outside, f } = tree();
  const good = f("a.png"), env = envFile(GOOD_ENV), x = join(outside, "x.png"); writeFileSync(x, PNG);
  const results = [
    await putLocalFile({ path: x, envFile: env, roots: [root], fetchImpl: async () => assert.fail("a refused path sends nothing") }),
    await putLocalFile({ path: good, envFile: envFile(GOOD_ENV, 0o644), roots: [root], fetchImpl: async () => assert.fail("a bad env file sends nothing") }),
    await putLocalFile({ path: good, envFile: env, roots: [root], fetchImpl: async () => ({ ok: false, status: 422, json: async () => ({ ok: false, refused: { rule: "file-quota-daily", detail: SECRET } }) }) }),
    await putLocalFile({ path: good, envFile: env, roots: [root], fetchImpl: async () => ({ ok: false, status: 403, json: async () => { throw new Error(SECRET); } }) }),
    await putLocalFile({ path: good, envFile: env, roots: [root], fetchImpl: async () => { throw Object.assign(new Error(`connect ${SECRET}`), { name: "TypeError" }); } }),
  ];
  assert.deepEqual(results.map((r) => r.ok), [false, false, false, false, false]);
  assert.match(results[2].reason, /422 \(file-quota-daily\)/);
  assert.match(results[3].reason, /403/);
  assert.match(results[4].reason, /could not be reached/);
  for (const r of results) assert.equal(JSON.stringify(r).includes(SECRET), false, JSON.stringify(r));
});

test("the command line prints FILE <id> and how to attach it, or PUT FAILED and exit 1, and never the token", async () => {
  const { root, f } = tree();
  const path = f("a.png"), env = envFile(GOOD_ENV);
  const out = [], err = []; let code;
  const fetchOk = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, id: "abc123def456ghi789jkl", name: "a.png", contentType: "image/png", sizeBytes: PNG.length }) });
  const io = { fetchImpl: fetchOk, out: (l) => out.push(l), err: (l) => err.push(l), exit: (c) => { code = c; } };
  await main(["--env", env, "--name", "Option A.png", path], { ...io, roots: [root] });
  assert.equal(code, 0);
  assert.equal(out[0], `FILE abc123def456ghi789jkl a.png image/png ${PNG.length}`);
  assert.match(out[1], /screenshots: \["abc123def456ghi789jkl"\]/);
  // Without test roots main takes the folders from the board config, and with no config it sends nothing: the command line has no way to name a folder.
  await main(["--env", env, path], io);
  assert.equal(code, 1);
  assert.match(err.at(-1), /^PUT FAILED: --config/);
  const config = join(root, "board.config.json"); writeFileSync(config, "{}");
  await main(["--env", env, "--config", config, path], io);
  assert.equal(code, 0, "the file is in the config's folder");
  const stranger = join(dir(), "a.png"); writeFileSync(stranger, PNG);
  await main(["--env", env, "--config", config, stranger], io);
  assert.equal(code, 1);
  assert.match(err.at(-1), /^PUT FAILED: outside the folders a file may come from/);
  await main(["--env", env], { ...io, roots: [root] });
  assert.equal(code, 1);
  assert.match(err.at(-1), /path of one file/);
  assert.equal([...out, ...err].join("\n").includes(SECRET), false);
});
