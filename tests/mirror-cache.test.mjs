// #C996 part 2: the derive read all of the mirror (8,100 files on 11-11: messages 3,473, threads 1,699, waiting 1,379, initiatives 804, steps 713)
// and parsed each, every run: 13.7 s of a 94 s derive at the machine's load, and growing with the board's history. readMirror can keep each
// document as parsed with its file's size and time (a file outside the mirror folder), so a run parses only what changed.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, utimesSync, statSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readMirror, liveMirror, MIRROR_CACHE_V } from "../gate/gate.mjs";

function mirror(files) {
  const root = mkdtempSync(join(tmpdir(), "fb-mc-"));
  const dir = join(root, "mirror"), cache = join(root, "mirror-parsed.json");
  for (const [path, doc] of Object.entries(files)) {
    mkdirSync(join(dir, path.split("/")[0]), { recursive: true });
    writeFileSync(join(dir, path), typeof doc === "string" ? doc : JSON.stringify(doc));
  }
  return { root, dir, cache };
}
const FILES = { "initiatives/a.json": { title: "A" }, "initiatives/b.json": { title: "B", deleted: true }, "messages/m1.json": { body: "hi" }, "steps/s1.json": { text: "step" } };

test("with a cache the mirror reads the same as without, and the cache is a file beside the mirror, not in it", () => {
  const m = mirror(FILES);
  try {
    const plain = readMirror(m.dir), first = readMirror(m.dir, { cache: m.cache }), second = readMirror(m.dir, { cache: m.cache });
    assert.deepEqual(first, plain);
    assert.deepEqual(second, plain);
    assert.ok(existsSync(m.cache));
    assert.equal(statSync(m.cache).mode & 0o777, 0o600);
    assert.ok(!readdirSync(m.dir).includes("mirror-parsed.json"), "not a collection of the mirror");
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(m.cache, "utf8"))), ["v", "files"]);
    assert.deepEqual(plain.docs.initiatives.map((d) => d.id), ["a"], "a deleted card is still no card");
  } finally { rmSync(m.root, { recursive: true, force: true }); }
});

test("a file whose size and time are unchanged is not read again; one that changed, is new or is gone is", () => {
  const m = mirror(FILES);
  try {
    readMirror(m.dir, { cache: m.cache });
    // Proof that the cache is what answers: put a different document in the cache for an unchanged file.
    const c = JSON.parse(readFileSync(m.cache, "utf8"));
    c.files["messages/m1.json"][2] = { body: "FROM THE CACHE" };
    writeFileSync(m.cache, JSON.stringify(c));
    assert.equal(readMirror(m.dir, { cache: m.cache }).docs.messages[0].body, "FROM THE CACHE");
    assert.equal(readMirror(m.dir).docs.messages[0].body, "hi", "without a cache, the file");
    // Changed: the same size, a later time (a rewrite), then a different size.
    const p = join(m.dir, "messages/m1.json"), before = statSync(p);
    writeFileSync(p, JSON.stringify({ body: "ho" }));
    utimesSync(p, new Date(before.mtimeMs + 5000), new Date(before.mtimeMs + 5000));
    assert.equal(readMirror(m.dir, { cache: m.cache }).docs.messages[0].body, "ho", "a later time is a change");
    writeFileSync(p, JSON.stringify({ body: "a longer one" }));
    utimesSync(p, new Date(before.mtimeMs + 5000), new Date(before.mtimeMs + 5000));
    assert.equal(readMirror(m.dir, { cache: m.cache }).docs.messages[0].body, "a longer one", "another size is a change, even at the same time");
    // New and gone.
    writeFileSync(join(m.dir, "messages/m2.json"), JSON.stringify({ body: "new" }));
    assert.deepEqual(readMirror(m.dir, { cache: m.cache }).docs.messages.map((d) => d.id).sort(), ["m1", "m2"]);
    rmSync(join(m.dir, "messages/m1.json"));
    assert.deepEqual(readMirror(m.dir, { cache: m.cache }).docs.messages.map((d) => d.id), ["m2"]);
    assert.ok(!("messages/m1.json" in JSON.parse(readFileSync(m.cache, "utf8")).files), "a gone file leaves the cache");
  } finally { rmSync(m.root, { recursive: true, force: true }); }
});

test("a half-written file is no document and is never cached; the next read takes it whole", () => {
  const m = mirror({ ...FILES, "threads/t1.json": '{"title": "cut off' });
  try {
    assert.deepEqual(readMirror(m.dir, { cache: m.cache }).docs.threads, []);
    assert.ok(!("threads/t1.json" in JSON.parse(readFileSync(m.cache, "utf8")).files));
    writeFileSync(join(m.dir, "threads/t1.json"), JSON.stringify({ title: "whole" }));
    assert.equal(readMirror(m.dir, { cache: m.cache }).docs.threads[0].title, "whole");
  } finally { rmSync(m.root, { recursive: true, force: true }); }
});

test("a cache that is missing, not JSON, of another version, or odd in an entry is ignored; the mirror reads as without one", () => {
  const m = mirror(FILES);
  try {
    const plain = readMirror(m.dir);
    for (const bad of ["", "not json", "[]", JSON.stringify({ v: MIRROR_CACHE_V + 1, files: {} }), JSON.stringify({ v: MIRROR_CACHE_V, files: [] }), JSON.stringify({ v: MIRROR_CACHE_V, files: { "messages/m1.json": "x", "steps/s1.json": [1, 2], "initiatives/a.json": [0, 0, null] } })]) {
      writeFileSync(m.cache, bad);
      assert.deepEqual(readMirror(m.dir, { cache: m.cache }), plain, bad.slice(0, 40));
    }
    assert.equal(JSON.parse(readFileSync(m.cache, "utf8")).v, MIRROR_CACHE_V, "and it is made good again");
  } finally { rmSync(m.root, { recursive: true, force: true }); }
});

test("a cache that cannot be written never fails the read, and the default read makes no cache", () => {
  const m = mirror(FILES);
  try {
    assert.deepEqual(readMirror(m.dir, { cache: join(m.root, "no-such-folder", "c.json") }), readMirror(m.dir));
    readMirror(m.dir);
    assert.ok(!existsSync(m.cache), "the gate's hooks read as before: no cache unless one is asked for");
  } finally { rmSync(m.root, { recursive: true, force: true }); }
});

test("liveMirror passes the cache through and still lays the journal over the cards", () => {
  const m = mirror(FILES);
  try {
    const journal = join(m.root, "gate.json");
    writeFileSync(journal, JSON.stringify({ journal: [{ op: "update", collection: "initiatives", doc_id: "a", data: { title: "A2" }, at: Date.now() + 1000 }] }));
    for (let k = 0; k < 2; k++) assert.equal(liveMirror(m.dir, journal, m.cache).docs.initiatives.find((d) => d.id === "a").title, "A2");
    assert.ok(existsSync(m.cache));
    assert.equal(JSON.parse(readFileSync(join(m.dir, "initiatives/a.json"), "utf8")).title, "A", "the journal is laid over a copy: the cache and the file keep the card as it was");
    assert.equal(JSON.parse(readFileSync(m.cache, "utf8")).files["initiatives/a.json"][2].title, "A");
  } finally { rmSync(m.root, { recursive: true, force: true }); }
});
