// What the board pushes to the owner's phone, and when (#C904; #C874's push, #C879's unanswered asks). Pure: rows and the
// time in, lines out. The store (push-store.mjs) reads the rows, sends and records; the page never decides any of it.
//   An open ask waits on the owner from its creation, or from its date: a Later ask's eta_at, a Decision's "not before"
//   (eta_at, #C823). Answered, closed or withdrawn, it waits on nobody here.
//   At MANAGER_NUDGE_MIN Manager is woken once (a stall line, the wake's own path), so Manager can make it clearer first.
//   At OWNER_PUSH_MIN the owner's phone gets it, once per ask.
//   A ship the probe recorded and the owner hasn't acknowledged, from the last SHIP_DAYS (the page's "Went live, not yet
//   acknowledged" list), is pushed once per version.
// A push says only counts, ask numbers and versions: never an ask's, card's or message's text (it leaves through the push
// service).

const MIN = 60e3, DAY = 864e5;
export const MANAGER_NUDGE_MIN = 10, OWNER_PUSH_MIN = 30, SHIP_DAYS = 7;
export const ASK_WAKE_PREFIX = "ask:";

export function askWaitsFrom(a) {
  if (!a || a.closed_at != null || a.answered_at != null || a.withdrawn_at != null) return null;
  if (a.type === "Later") return typeof a.eta_at === "number" ? a.eta_at : null;
  if (a.type === "Decision" && typeof a.eta_at === "number" && a.eta_at > a.created_at) return a.eta_at;
  return typeof a.created_at === "number" ? a.created_at : null;
}
const waited = (a, now, min) => { const from = askWaitsFrom(a); return from !== null && now - from >= min * MIN; };

// Manager's wake lines: one row per ask (the stall_wakes key is "ask:<id>"), a reason that never changes for that ask, so
// it is told once. #C922 (Checker's LOW2 on #C904): it promises no push, since the owner may have no key or device set; it
// says the push comes only if one is, so the words never change with the setup (a new reason would wake Manager again).
export function askWakes({ asks, now }) {
  return asks.filter((a) => waited(a, now, MANAGER_NUDGE_MIN)).map((a) => ({
    card_id: `${ASK_WAKE_PREFIX}${a.id}`,
    reason: `ask #T${Number(a.num)} has waited ${MANAGER_NUDGE_MIN} min for the owner: make it clearer or answer what you can; at ${OWNER_PUSH_MIN} min it goes to the owner's phone, if phone pushes are on`,
  }));
}

// What is due on the phone now and not pushed yet: { asks, ships } (each an array of rows), and the push's words.
export function pushesDue({ asks, ships, sent, now }) {
  const was = (kind, ref) => sent.has(`${kind}:${ref}`);
  const dueAsks = asks.filter((a) => waited(a, now, OWNER_PUSH_MIN) && !was("ask", a.id)).sort((x, y) => x.num - y.num);
  const dueShips = ships.filter((s) => s.acked_at == null && typeof s.shipped_at === "number" && now - s.shipped_at <= SHIP_DAYS * DAY && !was("ship", s.version))
    .sort((x, y) => x.shipped_at - y.shipped_at);
  return { asks: dueAsks, ships: dueShips, payload: dueAsks.length || dueShips.length ? pushWords(dueAsks, dueShips) : null };
}

const VERSION = /^v?\d+(?:\.\d+){1,3}$/;
const list = (items) => (items.length <= 3 ? items.join(", ") : `${items.slice(0, 3).join(", ")} and ${items.length - 3} more`);
export function pushWords(asks, ships) {
  const parts = [];
  if (ships.length) {
    const vs = ships.map((s) => (VERSION.test(String(s.version)) ? String(s.version) : "a version"));
    parts.push(`${list(vs)} went live: acknowledge ${ships.length === 1 ? "it" : "them"}`);
  }
  if (asks.length) parts.push(`${asks.length === 1 ? "an ask has" : `${asks.length} asks have`} waited ${OWNER_PUSH_MIN}+ min (${list(asks.map((a) => `#T${Number(a.num)}`))})`);
  return JSON.stringify({ title: "Flight board", body: parts.join(". ") + ".", url: "/", tag: "board" });
}
