// What the board pushes to the owner's phone, and when (#C904; #C874's push, #C879's unanswered asks). Pure: rows and the
// time in, lines out. The store (push-store.mjs) reads the rows, sends and records; the page never decides any of it.
//   An open ask waits on the owner from its creation, or from its date: a Later ask's eta_at, a Decision's "not before"
//   (eta_at, #C823). Answered, closed or withdrawn, it waits on nobody here.
//   At MANAGER_NUDGE_MIN Manager is woken once (a stall line, the wake's own path), so Manager can make it clearer first.
//   At OWNER_PUSH_MIN the owner's phone gets it, once per ask.
//   A ship the probe recorded and the owner hasn't acknowledged, from the last SHIP_DAYS (the page's "Went live, not yet
//   acknowledged" list), is pushed once per version.
//   #C1016: when the newest evidence write (the probe's heartbeat, as the page's "probe silent" chip reads it) is SILENT_PUSH_MIN
//   old, the phone is told once for that silence, with the time the board last heard from the Mac. A write after it ends the
//   silence, and the next silence is told again.
// A push says only counts, ask numbers, versions and times: never an ask's, card's or message's text (it leaves through the push
// service).

import { mtDayTime } from "./team-time.mjs";

const MIN = 60e3, DAY = 864e5;
export const MANAGER_NUDGE_MIN = 10, OWNER_PUSH_MIN = 30, SHIP_DAYS = 7, SILENT_PUSH_MIN = 15;
export const ASK_WAKE_PREFIX = "ask:";

export function askWaitsFrom(a) {
  if (!a || a.closed_at != null || a.answered_at != null || a.withdrawn_at != null) return null;
  // #C925: a promise (owed_by) waits on its promiser, never on the owner: no 10-minute nudge, no phone push (promiseWakes below).
  if (typeof a.owed_by === "string" && a.owed_by) return null;
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

// #C925: at a promise's date the store wakes its promiser (the lead) once, through the same stall rows: one row per ask
// ("promise:<id>"), a reason that never changes for that ask, so it is told once. Open only: a closed or answered promise is kept.
export const PROMISE_WAKE_PREFIX = "promise:";
export function promiseWakes({ asks, now }) {
  return asks.filter((a) => a && typeof a.owed_by === "string" && a.owed_by && a.type === "Later" && a.closed_at == null && a.answered_at == null && a.withdrawn_at == null
    && typeof a.eta_at === "number" && a.eta_at <= now && Number.isInteger(Number(a.num))).map((a) => ({
    card_id: `${PROMISE_WAKE_PREFIX}${a.id}`,
    reason: `#T${Number(a.num)} is due now: you promised it to the owner for this time; do it, or post on its thread when it will be`,
  }));
}

// What is due on the phone now and not pushed yet: { asks, ships, deploy } (asks and ships arrays of rows, deploy a 40-hex commit or null), and the push's words.
// #C968: deploy is the commit the Worker was deployed from (BUILD_SHA), told once per commit ("board deployed <short sha>"), so a deploy the owner did
// not start by hand is seen within minutes. Anything that is not a full lower-case sha is no deploy.
export const DEPLOY_SHA = /^[0-9a-f]{40}$/;
// #C1016: silent is the time (ms) of the newest evidence write when it is SILENT_PUSH_MIN old or more and this silence has not been told, else null.
// Recorded in push_sent as kind 'ship', ref "silent:<that time>" (no migration): a new write changes the time, so the next silence is told again.
// No evidence at all (lastEvidenceAt null or 0) is a board that has not started, not a silence.
export function pushesDue({ asks, ships, sent, now, deploy = null, lastEvidenceAt = null }) {
  const was = (kind, ref) => sent.has(`${kind}:${ref}`);
  const dueSilent = Number.isInteger(lastEvidenceAt) && lastEvidenceAt > 0 && now - lastEvidenceAt >= SILENT_PUSH_MIN * MIN && !was("ship", `silent:${lastEvidenceAt}`) ? lastEvidenceAt : null;
  // Recorded in push_sent as kind 'ship', ref "deploy:<sha>" (its kind is checked to ask or ship, and a ship's ref is a version, never "deploy:..."): no migration.
  const dueDeploy = typeof deploy === "string" && DEPLOY_SHA.test(deploy) && !was("ship", `deploy:${deploy}`) ? deploy : null;
  const dueAsks = asks.filter((a) => waited(a, now, OWNER_PUSH_MIN) && !was("ask", a.id)).sort((x, y) => x.num - y.num);
  const dueShips = ships.filter((s) => s.acked_at == null && typeof s.shipped_at === "number" && now - s.shipped_at <= SHIP_DAYS * DAY && !was("ship", s.version))
    .sort((x, y) => x.shipped_at - y.shipped_at);
  return { asks: dueAsks, ships: dueShips, deploy: dueDeploy, silent: dueSilent, payload: dueAsks.length || dueShips.length || dueDeploy || dueSilent ? pushWords(dueAsks, dueShips, dueDeploy, dueSilent) : null };
}

const VERSION = /^v?\d+(?:\.\d+){1,3}$/;
const list = (items) => (items.length <= 3 ? items.join(", ") : `${items.slice(0, 3).join(", ")} and ${items.length - 3} more`);
export function pushWords(asks, ships, deploy = null, silent = null) {
  const parts = [];
  if (Number.isInteger(silent) && silent > 0) parts.push(`board jobs silent since ${mtDayTime(silent)}: the Mac may have crashed, log back in`);
  if (typeof deploy === "string" && DEPLOY_SHA.test(deploy)) parts.push(`board deployed ${deploy.slice(0, 7)}`);
  if (ships.length) {
    const vs = ships.map((s) => (VERSION.test(String(s.version)) ? String(s.version) : "a version"));
    parts.push(`${list(vs)} went live: acknowledge ${ships.length === 1 ? "it" : "them"}`);
  }
  if (asks.length) parts.push(`${asks.length === 1 ? "an ask has" : `${asks.length} asks have`} waited ${OWNER_PUSH_MIN}+ min (${list(asks.map((a) => `#T${Number(a.num)}`))})`);
  return JSON.stringify({ title: "Flight board", body: parts.join(". ") + ".", url: "/", tag: "board" });
}
