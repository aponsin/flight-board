// #C1114: a card's counters read from the review notes, not typed. A review note whose first word is FINDINGS (the review sent the tip back) or RISKS
// (Security's list) counts its items by kind: the checker's are bugs, Security's are security, the language review's are language, the design review's are design.
// An item is a line that starts with a label such as F1, M2 or L3; a note with none counts as one. The probe sums the notes on every commit the branch has
// beyond main, so a second round of findings adds to the first; the Worker only ever raises the stored counter to the probe's number, so a later PASS or the same
// note read again changes nothing (writeEvidence, worker/board-store.mjs).
export const KIND_OF_PHASE = { checker: "bugs", security: "security", language: "language", design: "design" };
const FINDING_NOTE = /^\s*(FINDINGS|RISKS)\b/;
const ITEM_LINE = /^\s*(?:[A-Z]{1,2}\d{1,3})\b/;
const MAX_ITEMS = 99;

// How many findings one note holds: 0 when it is no FINDINGS or RISKS note.
export function itemsIn(text) {
  const t = String(text ?? "");
  if (!FINDING_NOTE.test(t)) return 0;
  const items = t.split("\n").filter((l) => ITEM_LINE.test(l)).length;
  return Math.min(MAX_ITEMS, Math.max(1, items));
}

// entries: [[phase, note text], ...] for every note on the branch's commits. { bugs, security, language, design } with only the kinds above zero.
export function countFindings(entries) {
  const out = {}, seen = new Set();
  for (const [phase, text] of Array.isArray(entries) ? entries : []) {
    // A reviewer signs every commit of a stack with the same words: one finding read on ten commits is one finding.
    const key = `${phase}\n${String(text ?? "").trim()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const kind = KIND_OF_PHASE[phase], n = kind ? itemsIn(text) : 0;
    if (n > 0) out[kind] = Math.min(MAX_ITEMS, (out[kind] ?? 0) + n);
  }
  return out;
}
