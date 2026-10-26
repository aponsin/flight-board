// The plan layer (board v3): the `plan` collection's nodes and the link from every initiative to one of them.
// A node: { parent, order, text, kind, outcome?, measure?, due?, waitsOn?, state?, evidence?, replacedBy?, changedAt?,
// why?, decisionThread?, note? }. Only the lead writes the plan. A changed plan is never deleted: a node is replaced
// (the old one gets replacedBy, changedAt and why, and stays, struck through; the new one sits below it), and a node
// that has initiatives can't have its text or outcome edited in place. Pure: writes and the board's mirror come in.

export const PLAN = "plan";
export const KINDS = ["objective", "milestone", "step"];
export const STATES = ["open", "done"];
const FIELDS = ["parent", "order", "text", "kind", "outcome", "measure", "due", "waitsOn", "state", "evidence", "replacedBy", "changedAt", "why", "decisionThread", "note"];
const ID = /^[a-z0-9][a-z0-9-]{0,79}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const text = (v, max) => typeof v === "string" && v.trim().length > 0 && v.length <= max;
const del = (v) => v && typeof v === "object" && v.__delete__ === true;

// One plan write's own problems (no mirror needed).
export function planWriteErrors(w, { who, config, now = Date.now() }) {
  const { op, doc_id: id, data } = w;
  if (!who.manager) return [`only ${config.gate.managerRole} writes the plan`];
  if (op === "delete") return ["a plan node is never deleted: replace it (replacedBy, changedAt, why) and add the new node"];
  if (op === "batch" || !data || typeof data !== "object") return [];
  const e = [];
  if (!ID.test(String(id))) e.push("a node id: lower case letters, digits and -, at most 80");
  for (const k of Object.keys(data)) if (!FIELDS.includes(k)) e.push(`unknown field "${k}" (known: ${FIELDS.join(", ")})`);
  const has = (k) => k in data && !del(data[k]);
  if (op === "set") {
    for (const k of ["text", "kind", "order"]) if (!has(k)) e.push(`a node needs ${k}`);
    if (!("parent" in data)) e.push("a node needs parent (null for a top-level objective)");
  }
  for (const k of ["text", "kind", "order", "parent"]) if (k in data && del(data[k])) e.push(`${k} can't be removed`);
  if (has("text") && !text(data.text, 200)) e.push("text: 1 to 200 characters");
  if (has("kind") && !KINDS.includes(data.kind)) e.push(`kind: one of ${KINDS.join(", ")}`);
  if (has("order") && !(typeof data.order === "number" && Number.isFinite(data.order))) e.push("order: a number");
  if ("parent" in data && data.parent !== null && !del(data.parent) && !ID.test(String(data.parent))) e.push("parent: a node id, or null");
  if ("parent" in data && data.parent === id) e.push("a node can't be its own parent");
  for (const k of ["outcome", "measure", "why", "note", "evidence"]) if (has(k) && !text(data[k], 300)) e.push(`${k}: 1 to 300 characters`);
  if (has("decisionThread") && !text(data.decisionThread, 80)) e.push("decisionThread: a thread id");
  if (has("due") && !DAY.test(String(data.due))) e.push("due: YYYY-MM-DD");
  if (has("waitsOn") && !(Array.isArray(data.waitsOn) && data.waitsOn.length <= 20 && data.waitsOn.every((x) => text(x, 120)))) e.push("waitsOn: up to 20 node or initiative ids, or short descriptions");
  if (has("state") && !STATES.includes(data.state)) e.push(`state: one of ${STATES.join(", ")} (the collector works out the rest)`);
  // On a set the evidence comes with it; an update may rely on the node's evidence already on the board (planMirrorErrors).
  if (op === "set" && has("state") && data.state === "done" && !has("evidence")) e.push('state "done" is declared with evidence (what shows the done-condition is met)');
  if (has("replacedBy")) {
    if (!ID.test(String(data.replacedBy)) || data.replacedBy === id) e.push("replacedBy: the id of the node that replaces it");
    if (!has("why")) e.push("a replaced node says why");
    if (!(typeof data.changedAt === "number" && data.changedAt > 0)) e.push("a replaced node has changedAt (the clock, ms)");
    else if (data.changedAt > now + 60e3) e.push('changedAt is in the future: read the clock (python3 -c "import time;print(int(time.time()*1000))")');
  }
  return e;
}

// A plan write against the board as the mirror holds it: a node with initiatives is replaced, never edited in place;
// a replacement stays; parents and replacements exist. batch: the other writes of the same call. Skipped (fail open,
// like the other mirror rules) when the export has no plan collection.
// The plan as it will be once this call lands: the mirror's nodes with the batch's plan writes laid over (a set
// replaces a node, an update merges into it, a field set to {"__delete__": true} goes).
export function planAfter(nodes, batch = []) {
  const out = new Map((Array.isArray(nodes) ? nodes : []).filter((n) => n && typeof n.id === "string").map((n) => [n.id, { ...n }]));
  for (const b of batch) {
    if (b.collection !== PLAN || b.op === "delete" || !b.data || typeof b.data !== "object") continue;
    const next = b.op === "set" ? { id: b.doc_id } : { ...(out.get(b.doc_id) ?? { id: b.doc_id }) };
    for (const [k, v] of Object.entries(b.data)) { if (del(v)) delete next[k]; else next[k] = v; }
    out.set(b.doc_id, next);
  }
  return out;
}
// Whether following `field` (parent, or replacedBy) from id comes back to it: a loop a tree walk would never leave.
function loops(plan, id, field) {
  const seen = new Set([id]);
  let at = plan.get(id)?.[field];
  for (let n = 0; typeof at === "string" && n < 200; n++) {
    if (seen.has(at)) return at === id || true;
    seen.add(at);
    at = plan.get(at)?.[field];
  }
  return false;
}

export function planMirrorErrors(w, { mirror, batch = [] }) {
  const { op, doc_id: id, data } = w;
  const nodes = mirror?.docs?.[PLAN];
  if (!Array.isArray(nodes) || op === "delete" || !data || typeof data !== "object") return [];
  const e = [];
  const was = nodes.find((n) => n.id === id);
  const after = planAfter(nodes, batch.includes(w) ? batch : [...batch, w]);
  const exists = (nid) => after.has(nid);
  const linked = (mirror.docs.initiatives ?? []).filter((k) => k.plan === id).map((k) => k.id);
  if (was && linked.length) {
    for (const k of ["text", "outcome"]) {
      const after = op === "set" ? data[k] : (k in data ? data[k] : was[k]);
      if (JSON.stringify(after ?? null) !== JSON.stringify(was[k] ?? null)) e.push(`${k}: ${linked.length} initiative(s) link here (${linked.slice(0, 3).join(", ")}): replace the node (replacedBy, changedAt, why, and a new node), don't edit it`);
    }
  }
  if (was?.replacedBy) {
    const after = op === "set" ? data.replacedBy : ("replacedBy" in data ? data.replacedBy : was.replacedBy);
    if (after !== was.replacedBy) e.push(`it was replaced by ${was.replacedBy}: a replacement stays`);
  }
  if (typeof data.replacedBy === "string" && !exists(data.replacedBy)) e.push(`replacedBy: no node ${data.replacedBy} on the board or in this call`);
  if (typeof data.parent === "string" && !exists(data.parent)) e.push(`parent: no node ${data.parent} on the board or in this call`);
  if ("parent" in data && loops(after, id, "parent")) e.push("parent: that makes a loop (a node inside its own branch)");
  if ("replacedBy" in data && loops(after, id, "replacedBy")) e.push("replacedBy: that makes a loop of replacements");
  const now = after.get(id);
  if (op === "update" && now?.state === "done" && !(typeof now.evidence === "string" && now.evidence.trim())) e.push('state "done" is declared with evidence (what shows the done-condition is met)');
  return e;
}

// An initiative's link to the plan: a new card names a node; any card naming one names a live node (not replaced).
export function initiativePlanErrors(w, { mirror, batch = [] }) {
  const { op, data } = w;
  if (op === "delete" || !data || typeof data !== "object") return [];
  const e = [];
  if (op === "set" && data.status !== "done" && data.status !== "dropped" && !text(data.plan, 80)) e.push("no plan: link the card to the plan node it serves (plan: <node id>), or to the keep-the-lights-on node");
  if (!("plan" in data) || del(data.plan)) {
    if (del(data.plan)) e.push("plan can't be removed: link it to another node");
    return e;
  }
  if (!text(data.plan, 80)) return [...e, "plan: a node id"];
  const nodes = mirror?.docs?.[PLAN];
  if (!Array.isArray(nodes)) return e;
  // The node as it will be once the call lands: an update in the same batch can't hide that it was replaced.
  const node = planAfter(nodes, batch).get(data.plan);
  if (!node) e.push(`plan: no node ${data.plan} on the board or in this call`);
  else if (node.replacedBy) e.push(`plan: ${data.plan} was replaced by ${node.replacedBy}: link to that`);
  return e;
}
