// Ships, "Done in the last 24 h" and the shipped feed (#C726 C2, board parity; docs/DATA.md rows 40 and 41).
// Nothing here is typed: a card is done when the probe reads its last phase lit (live, or install on the board's own track),
// and a ship is a version the probe read on a card's commit (cards.<id>.liveVersion). The store keeps one ships row per
// version (migration 0001: version, cards, shipped_at, acked_at), so the owner's ack (the ack tool) has a row to land on.
//
// Hooks (Boardsmith adds them, one line each):
//   board-store writeEvidence   await noteShip(db, now, cardId, value)   for a cards.<id> key, after the evidence is stored
//   board-store readView        ships: await readShips(db)               (and in the tag's content)
//   compat-view compatView      applyShips(collections, view)            after initiatives are built
// applyShips is pure; noteShip and readShips touch only the ships table.

export const END_PHASES = ["live", "install"];
const VERSION = /^v?(\d{1,6}\.\d{1,6}\.\d{1,6})$/;
export const plainVersion = (v) => (typeof v === "string" && VERSION.test(v) ? VERSION.exec(v)[1] : null);

// A card's reading carries the version it went live in: the ship of that version lists the card. The first reading of a
// version is when it shipped; a later card in the same version joins the list and leaves the time as it was.
// The probe's own shippedAt (when the card's work reached main, #C731 B4b) is when the version shipped, not when the probe first noticed it:
// used when it is a time in the last 30 days and not in the future, else the reading's time. A later card in the same version with an
// earlier shippedAt moves the ship back to it (the version shipped when its first card did).
const FRESH_MS = 30 * 864e5;
const shipTime = (now, v) => (Number.isFinite(v) && v > now - FRESH_MS && v <= now ? Math.floor(v) : now);
export async function noteShip(db, now, cardId, value) {
  const version = plainVersion(value?.liveVersion);
  if (!version || typeof cardId !== "string") return;
  const at = shipTime(now, value?.shippedAt);
  const row = await db.prepare("SELECT cards, shipped_at FROM ships WHERE version = ?").bind(version).first();
  if (!row) {
    await db.prepare("INSERT INTO ships (version, cards, shipped_at) VALUES (?, ?, ?) ON CONFLICT (version) DO NOTHING").bind(version, JSON.stringify([cardId]), at).run();
    return;
  }
  let cards;
  try { cards = JSON.parse(row.cards); } catch { cards = []; }
  if (!Array.isArray(cards)) cards = [];
  const earlier = Number.isFinite(row.shipped_at) && at < row.shipped_at && Number.isFinite(value?.shippedAt);
  if (cards.includes(cardId) && !earlier) return;
  if (earlier) await db.prepare("UPDATE ships SET cards = ?, shipped_at = ? WHERE version = ?").bind(JSON.stringify(cards.includes(cardId) ? cards : [...cards, cardId]), at, version).run();
  else await db.prepare("UPDATE ships SET cards = ? WHERE version = ?").bind(JSON.stringify([...cards, cardId]), version).run();
}

export async function readShips(db) {
  return (await db.prepare("SELECT version, cards, shipped_at, acked_at FROM ships ORDER BY shipped_at, version").all()).results;
}

// When a card reached its last phase: the phase history's first start of it, else the reading's own time. A wait step (the step
// tool, #C739) is not the lit phase: only the probe's own rows (no wait) say when the card got there.
function doneAtOf(cardId, phase, history, readAt) {
  const h = (history ?? []).find((r) => r.card_id === cardId && r.phase === phase && r.kind === "start" && r.wait == null);
  return h ? h.at : readAt;
}

// Pure. initiatives: a card read at its last phase is done, with doneAt and its version (a dropped card stays dropped).
// events: one line per ship, newest first, "#C12 Title · #C13 Title", with the owner's ack once given.
export function applyShips(collections, view) {
  const cards = Object.fromEntries((view.cards ?? []).map((c) => [c.id, c]));
  for (const i of collections.initiatives ?? []) {
    const c = cards[i.id];
    const ev = view.evidence?.[`cards.${i.id}`];
    const lit = ev?.value?.lit?.[0];
    // A card with a check date is held open past its live reading until the lead lifts the date (#C731 B4b, as on the old board;
    // store-check-date-holds-card): it stays as the compat view made it, with no doneAt and no version. The ship of its version is unaffected.
    if (!c || !END_PHASES.includes(lit) || c.dropped || (Number.isInteger(c.check_at) && c.check_at > 0)) continue;
    i.status = "done";
    i.doneAt = doneAtOf(i.id, lit, view.history, ev.readAt);
    const v = plainVersion(ev.value.liveVersion);
    if (v) i.version = v;
  }
  if (view.ships === undefined) return collections;
  const label = (id) => {
    const c = cards[id] ?? (view.historyCards ?? []).find((h) => h.id === id);
    return c ? `#C${c.num} ${String(c.title ?? "").trim()}`.trim() : id;
  };
  collections.events = (view.ships ?? []).map((s) => {
    let ids;
    try { ids = JSON.parse(s.cards); } catch { ids = []; }
    if (!Array.isArray(ids)) ids = [];
    ids = ids.filter((x) => typeof x === "string");
    const doc = { id: `v${s.version}`, version: s.version, at: s.shipped_at, cards: ids, text: ids.map(label).join(" · ") };
    if (s.acked_at) doc.ackedAt = s.acked_at;
    return doc;
  }).sort((a, b) => b.at - a.at);
  return collections;
}
