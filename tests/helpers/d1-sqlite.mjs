// A D1-shaped database over node:sqlite for tests: prepare(sql).bind(...).run() / all() / first(), batch([...]).
// It runs the real migrations, so a test sees the same CHECKs and constraints the Worker will.
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const MIGRATIONS = fileURLToPath(new URL("../../worker/migrations/", import.meta.url));

export function makeDb() {
  const sql = new DatabaseSync(":memory:");
  sql.exec("PRAGMA foreign_keys = ON");
  for (const f of readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql")).sort()) sql.exec(readFileSync(MIGRATIONS + f, "utf8"));
  const stmt = (text, args = []) => ({
    bind: (...a) => stmt(text, a),
    run: async () => { const r = sql.prepare(text).run(...args); return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
    all: async () => ({ results: sql.prepare(text).all(...args).map((o) => ({ ...o })) }),
    first: async () => { const r = sql.prepare(text).get(...args); return r ? { ...r } : null; },
    _exec: () => sql.prepare(text).run(...args),
  });
  return {
    prepare: (t) => stmt(t),
    // D1's batch is one transaction: all or nothing.
    batch: async (stmts) => {
      sql.exec("BEGIN");
      try { const out = []; for (const s of stmts) { const r = s._exec(); out.push({ success: true, meta: { changes: Number(r.changes) } }); } sql.exec("COMMIT"); return out; }
      catch (e) { sql.exec("ROLLBACK"); throw e; }
    },
  };
}
