// #C989: every temp folder a test file makes with mkdtemp is removed when that file's process ends, pass or fail.
// 11-11 the Studio's disk filled with millions of leftover test folders and stopped every agent. Loaded into each
// test file's process by `node --import ./tests/helpers/clean-tmp.mjs --test` (npm test, through scripts/test-tmp.mjs).
// A folder whose name starts "keep-" is kept on purpose, to look at after a failure; scripts/test-tmp.mjs moves it
// out of the run's own folder and names it. Folders a spawned script makes are that script's own to remove.
import fs from "node:fs";
import { basename } from "node:path";
import { syncBuiltinESMExports } from "node:module";

const made = new Set();
const note = (p) => { if (typeof p === "string" && !basename(p).startsWith("keep-")) made.add(p); return p; };
const sync = fs.mkdtempSync, cb = fs.mkdtemp, prom = fs.promises.mkdtemp;
fs.mkdtempSync = function (...a) { return note(sync.apply(this, a)); };
fs.mkdtemp = function (...a) { const done = a.pop(); return cb.call(this, ...a, (err, p) => { if (!err) note(p); done(err, p); }); };
fs.promises.mkdtemp = async function (...a) { return note(await prom.apply(this, a)); };
syncBuiltinESMExports();
process.on("exit", () => { for (const p of made) { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* the guard names it */ } } });
