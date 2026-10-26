// The plan's states (board v3, step 2; board-brief section 9): worked out from the cards and the asks, never written by
// hand. Pure: the plan's nodes, the cards, the collector's derived phases, the asks and the config come in.
//
// A node is, in this order:
//   replaced - it has replacedBy (it stays, struck through, with why);
//   done     - the lead declared it done (state "done", with evidence), or it has cards or live children and every one is
//              done (a card live by the evidence, or closed as done; a dropped card doesn't count either way);
//   active   - a card linked to it, or to a node below it, is open and not parked ("in progress");
//   gated    - something it waits on is unmet: a waitsOn entry that names a node not done or a card not done, any other
//              waitsOn text (only the lead clears it), or an open ask to the owner tied to one of its cards;
//   next     - anything else.
// An objective also gets its bar (done over all the nodes below it, replaced ones left out) and its chip: done, blocked
// (every node left is gated), at-risk (the ETA medians of what is left run past its due day) or on-track; null with no
// due day, or nothing below it yet, unless done or blocked. The due day ends at 23:59:59 UTC (the clock comes in; no time zone is read).
import { closed } from "./derive.mjs";

const HOUR = 36e5;

export function derivePlan({ nodes, cards, derived = {}, waiting = [], config, now }) {
  const list = (Array.isArray(nodes) ? nodes : []).filter((n) => n && typeof n.id === "string");
  const byId = new Map(list.map((n) => [n.id, n]));
  const cardsById = new Map((Array.isArray(cards) ? cards : []).filter((k) => k && typeof k.id === "string").map((k) => [k.id, k]));
  const kids = new Map();
  for (const n of list) if (typeof n.parent === "string" && byId.has(n.parent) && n.parent !== n.id) (kids.get(n.parent) ?? kids.set(n.parent, []).get(n.parent)).push(n);
  const linked = new Map();
  for (const k of cardsById.values()) if (typeof k.plan === "string") (linked.get(k.plan) ?? linked.set(k.plan, []).get(k.plan)).push(k);
  const live = config.collector.livePhase;
  const parked = new Set(config.nudges?.parked ?? []);
  const cardDone = (k) => k.status === "done" || derived[k.id]?.phase === live;
  const cardOpen = (k) => !closed(k) && !cardDone(k);
  const eta = config.nudges?.etaHours ?? {};
  const fallback = eta.M ?? Object.values(eta).sort((a, b) => a - b)[Math.floor(Object.keys(eta).length / 2)] ?? 0;
  const asks = (Array.isArray(waiting) ? waiting : []).filter((a) => a && !a.done && !a.response && typeof a.initiative === "string");

  const out = {};
  const visiting = new Set();
  function state(id) {
    if (out[id]) return out[id];
    const n = byId.get(id);
    if (!n || visiting.has(id)) return { state: "next" }; // a loop the gate refuses: never walked twice
    visiting.add(id);
    const below = (kids.get(id) ?? []).filter((c) => !c.replacedBy).map((c) => state(c.id));
    const mine = (linked.get(id) ?? []).filter((k) => k.status !== "dropped");
    let s;
    if (n.replacedBy) s = { state: "replaced", replacedBy: n.replacedBy };
    else if (n.state === "done") s = { state: "done", declared: true };
    else if ((mine.length || below.length) && mine.every(cardDone) && below.every((b) => b.state === "done")) s = { state: "done" };
    else if (mine.some((k) => cardOpen(k) && !parked.has(k.status)) || below.some((b) => b.state === "active")) s = { state: "active", cards: mine.filter(cardOpen).map((k) => k.id) };
    else {
      const gates = [];
      for (const w of Array.isArray(n.waitsOn) ? n.waitsOn : []) {
        if (byId.has(w)) { if (w !== id && state(w).state !== "done") gates.push({ on: w, kind: "node" }); }
        else if (cardsById.has(w)) { const k = cardsById.get(w); if (!cardDone(k)) gates.push({ on: w, kind: "card", who: k.who ?? null }); }
        else if (typeof w === "string") gates.push({ on: w, kind: "text" });
      }
      const ids = new Set(mine.map((k) => k.id));
      for (const a of asks) if (ids.has(a.initiative)) gates.push({ on: a.id, kind: "ask", who: config.owner ?? "Owner", since: Number.isFinite(a.since) ? a.since : null });
      if (below.length && below.every((b) => b.state === "gated" || b.state === "done") && below.some((b) => b.state === "gated")) gates.push({ on: id, kind: "below" });
      s = gates.length ? { state: "gated", gates } : { state: "next" };
    }
    visiting.delete(id);
    return (out[id] = s);
  }
  for (const n of list) state(n.id);

  // Each objective: the nodes below it (any depth, replaced ones out), its bar and its chip.
  const objectives = {};
  for (const n of list.filter((x) => x.kind === "objective" && !x.replacedBy)) {
    const all = [];
    const walk = (id, depth) => { if (depth > 50) return; for (const c of kids.get(id) ?? []) if (!c.replacedBy) { all.push(c); walk(c.id, depth + 1); } };
    walk(n.id, 0);
    const done = all.filter((c) => out[c.id].state === "done").length;
    // What is left: the leaves not done, each its open cards' medians (a leaf with no card counts one at the fallback).
    const left = all.filter((c) => out[c.id].state !== "done" && !(kids.get(c.id) ?? []).some((x) => !x.replacedBy));
    const hours = left.reduce((sum, c) => {
      const open = (linked.get(c.id) ?? []).filter(cardOpen);
      return sum + (open.length ? open.reduce((h, k) => h + (eta[k.size] ?? fallback), 0) : fallback);
    }, 0);
    const dueAt = /^\d{4}-\d{2}-\d{2}$/.test(String(n.due ?? "")) ? Date.parse(`${n.due}T23:59:59Z`) : null;
    let chip = null;
    if (out[n.id].state === "done") chip = "done";
    else if (left.length && left.every((c) => out[c.id].state === "gated")) chip = "blocked";
    else if (dueAt !== null && all.length) chip = now + hours * HOUR > dueAt ? "at-risk" : "on-track";
    objectives[n.id] = { done, total: all.length, hoursLeft: Math.round(hours * 10) / 10, chip };
  }
  return { at: now, nodes: out, objectives };
}
