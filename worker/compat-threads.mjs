// Threads and messages for the old page (#C725 B1, board parity stage B; docs/DATA.md rows on threads and messages).
// The page draws a thread from three collections: messages { id, thread, from, text, at, kind?, resolved?, options?, assets? },
// threads { id, num, title? } (the #T number and the owner's rename), and the item the thread is on (an ask, a card, a list row).
// In the store a thread is an ask (its #T number is the ask's), a card, or a free thread of the owner's own (the threads table,
// numbered from the same #T counter). Messages are rows of messages.
//
// Hooks (Boardsmith adds them, one line each):
//   board-store readView      threads: await readThreads(db)               (and in the tag's content)
//   compat-view compatView    applyThreads(collections, view)              BEFORE applyFiles (it adds assets to messages)
//   compat-write              threads and messages paths -> routeThreadWrite(...)
// Everything here that reads only its arguments is pure. The owner's messages are stored under author "owner" (the store's own
// word: the wake and the inbox count them); the page's shim turns it into the owner's name and back.

export const MAX_TEXT = 8000;
const ID = /^[A-Za-z0-9-]{1,64}$/;
const KIND = /^[a-z][a-z-]{0,19}$/;
const MSG_ID = /^m[A-Za-z0-9-]{1,63}$/;
const json = (s) => { try { return JSON.parse(s); } catch { return undefined; } };

export async function readThreads(db) {
  const messages = (await db.prepare("SELECT id, thread_id, author, body, created_at, kind, resolved, options FROM messages ORDER BY created_at, id").all()).results;
  const threads = (await db.prepare("SELECT id, num, title, created_at FROM threads ORDER BY created_at, id").all()).results;
  return { messages, threads };
}

// Pure: the old collections from the view's rows.
export function applyThreads(collections, view) {
  const t = view?.threads;
  if (!t) return collections;
  collections.messages = (t.messages ?? []).map((m) => {
    const o = { id: m.id, thread: m.thread_id, from: m.author, text: m.body, at: m.created_at };
    if (m.kind) o.kind = m.kind;
    if (m.resolved) o.resolved = true;
    const options = json(m.options);
    if (Array.isArray(options)) o.options = options;
    return o;
  });
  const byId = new Map();
  for (const a of view.asks ?? []) byId.set(a.id, { id: a.id, num: a.num });
  for (const r of t.threads ?? []) {
    const cur = byId.get(r.id) ?? { id: r.id };
    if (r.num) cur.num = r.num;
    if (r.title) cur.title = r.title;
    byId.set(r.id, cur);
  }
  collections.threads = [...byId.values()];
  // #C729 B4a: a card names the thread it came from by the thread's id (the page links "from #T<n>"); the store keeps the number.
  const idOfNum = new Map();
  for (const th of collections.threads) if (Number.isInteger(th.num) && !idOfNum.has(th.num)) idOfNum.set(th.num, th.id);
  for (const c of collections.initiatives ?? []) if (Number.isInteger(c.fromThread) && idOfNum.has(c.fromThread)) c.thread = idOfNum.get(c.fromThread);
  return collections;
}

// The owner's writes on the old paths. ctx = { db, now, who, mint, refuse, filesRefusal, linkFiles } (injected, so this module
// imports nothing from the store). Returns { ok:true } or a refusal, like the other routes.
export async function routeThreadWrite(ctx, { op, coll, id, d }) {
  const { db, now, who, refuse } = ctx;
  const no = (rule, detail, card) => refuse(db, now, { rule, detail }, card ?? null, who);
  if (coll === "messages") {
    if (op !== "set") return no("no-route-yet", `messages/${id}: a message is only added (the store deletes nothing)`);
    if (!MSG_ID.test(id)) return no("message-shape", "the message id starts with m");
    const text = typeof d.text === "string" ? d.text : "";
    if (!text.trim() || text.length > MAX_TEXT) return no("message-shape", `text is 1 to ${MAX_TEXT} characters`);
    if (typeof d.thread !== "string" || !ID.test(d.thread)) return no("message-shape", "thread is the thread's id");
    if (d.from !== "owner") return no("message-author", "the board writes the owner's messages only");
    if (d.kind !== undefined && !(typeof d.kind === "string" && KIND.test(d.kind))) return no("message-shape", "kind is a short lower-case word");
    const unknown = Object.keys(d).filter((k) => !["thread", "from", "text", "at", "assets", "kind", "resolved"].includes(k));
    if (unknown.length) return no("message-shape", `fields ${unknown.join(", ").slice(0, 60)}`);
    const fl = await ctx.filesRefusal(db, d.assets);
    if (fl.refused) return refuse(db, now, fl.refused, null, who);
    if (await db.prepare("SELECT 1 AS x FROM messages WHERE id = ?").bind(id).first()) return no("message-exists", id);
    // The thread must be an ask, a card or a free thread; an unknown id is a NEW thread of the owner's, numbered here.
    const known = (await db.prepare("SELECT 1 AS x FROM asks WHERE id = ?").bind(d.thread).first()) || (await db.prepare("SELECT 1 AS x FROM cards WHERE id = ?").bind(d.thread).first()) || (await db.prepare("SELECT 1 AS x FROM threads WHERE id = ?").bind(d.thread).first());
    const writes = [];
    if (!known) {
      const num = await ctx.mint(db, "T");
      writes.push(db.prepare("INSERT INTO threads (id, num, title, created_at) VALUES (?, ?, NULL, ?)").bind(d.thread, num, now));
    }
    writes.push(db.prepare("INSERT INTO messages (id, thread_id, author, body, created_at, kind, resolved) VALUES (?, ?, 'owner', ?, ?, ?, ?)").bind(id, d.thread, text, now, d.kind ?? null, d.resolved === true ? 1 : 0));
    await db.batch(writes);
    await ctx.linkFiles(db, now, "message", id, fl.ids);
    return { ok: true, id };
  }
  if (coll === "threads") {
    if (op === "delete") return no("no-route-yet", `threads/${id}: the store deletes nothing`);
    const keys = Object.keys(d);
    if (!keys.length || keys.some((k) => k !== "title")) return no("no-route-yet", `threads/${id}: only the title is renamed`);
    const title = typeof d.title === "string" ? d.title.replace(/\s+/g, " ").trim().slice(0, 120) : "";
    if (!title) return no("thread-title", "a title is 1 to 120 characters");
    const exists = (await db.prepare("SELECT 1 AS x FROM asks WHERE id = ?").bind(id).first()) || (await db.prepare("SELECT 1 AS x FROM cards WHERE id = ?").bind(id).first()) || (await db.prepare("SELECT 1 AS x FROM threads WHERE id = ?").bind(id).first());
    if (!exists) return no("thread-unknown", id);
    await db.prepare("INSERT INTO threads (id, num, title, created_at) VALUES (?, NULL, ?, ?) ON CONFLICT (id) DO UPDATE SET title = excluded.title").bind(id, title, now).run();
    return { ok: true };
  }
  return no("no-route-yet", `${op} on ${coll} has no route`);
}
