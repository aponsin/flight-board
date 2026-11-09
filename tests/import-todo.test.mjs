// The import's to-do reading (#C728): the open rows of the old board's todo documents are counted one by one, and a --todo folder with
// no documents in it (the wrong level) is an error, never a silent "0 open".
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { plan, readMirror } from "../collector/import-mirror.mjs";

const mirror = () => {
  const dir = mkdtempSync(join(tmpdir(), "mirror-"));
  for (const c of ["initiatives", "threads", "messages", "waiting", "ideas"]) mkdirSync(join(dir, c));
  return dir;
};
const todoDir = (rows) => {
  const parent = mkdtempSync(join(tmpdir(), "todo-"));
  const dir = join(parent, "todo");
  mkdirSync(dir);
  for (const [id, d] of Object.entries(rows)) writeFileSync(join(dir, `${id}.json`), JSON.stringify(d));
  return { parent, dir };
};
const rows = {
  crawlers: { text: "Crawlers", done: false, addedAt: 1 },
  "search-console": { text: "Search Console", done: false, addedAt: 2 },
  "gbp-api-apply": { text: "GBP API", addedAt: 3 },
  finished: { text: "Done one", done: true, addedAt: 4 },
};

test("the old board's open to-do rows are counted one by one: a row is open unless it is marked done", () => {
  const { dir } = todoDir(rows);
  const p = plan(readMirror(mirror(), { todoDir: dir }), { owner: "Owner", roster: ["Manager"], lead: "Manager" });
  assert.equal(p.counts.todo, 3, "three open rows");
  assert.equal(p.skipped.doneLists, 1, "one done row");
  assert.equal(p.lists.filter((l) => l.kind === "todo").length, 3);
});

test("a --todo folder that holds no documents is refused by name, not read as 0 open rows", () => {
  const { parent } = todoDir(rows); // the parent of the folder that holds the documents
  assert.throws(() => readMirror(mirror(), { todoDir: parent }), /holds no \.json documents/);
});
