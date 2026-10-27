// Mechanical traffic (#C335, the context-tax brief's card B): a message that only reports a status the lead needs no
// judgment on ("picked up Ops", "SHIPPED v1.155.1", "finished #C330") is written to the board's log instead of waking the
// lead, and the lead gets one digest line. The classes are the config's (traffic.mechanical: [{ name, pattern }], each a
// pattern the whole message must match, trimmed); a message holding any of NEVER is always the lead's, whatever matches,
// and a message no class matches is allowed: the gate never guesses.
export const NEVER = /\?|\bBUG\b|\bBLOCKED\b|\bDECIDE\b|\bSALES\b|🔴/u;
export const MAX_LEN = 300;

// The class a message falls in, or null.
export function mechanicalClass(text, classes) {
  const t = String(text ?? "").trim();
  if (!t || t.length > MAX_LEN || NEVER.test(t)) return null;
  for (const c of classes ?? []) {
    let re;
    try { re = new RegExp(`^(?:${c.pattern})$`, "i"); } catch { continue; }
    if (re.test(t)) return c.name;
  }
  return null;
}

export const refusal = (name) => `Mechanical (${name}): write it to the board instead (ArtifactData set, collection log, {from: <your role>, kind: "${name}", text, at}); the lead sees a digest. Not sent.`;

// One digest line from log entries newer than `since`, oldest first: "Since your last turn: Ops: picked up Ops; …", or
// null with none. entries: [{ from, kind, text, at }]. Each part one line, no tags, 80 characters at most; 20 at most.
const brief = (t) => {
  const s = String(t ?? "").replace(/[\u0000-\u001f\u007f<>"]+/g, " ").replace(/\s+/g, " ").trim();
  return s.length > 80 ? `${s.slice(0, 79)}…` : s;
};
const WHO = /^[A-Za-z0-9_-]{1,60}$/;
export function logDigest(entries, since) {
  const fresh = (entries ?? []).filter((e) => e && typeof e.at === "number" && e.at > since && typeof e.text === "string").sort((a, b) => a.at - b.at);
  if (!fresh.length) return null;
  const parts = fresh.slice(-20).map((e) => `${WHO.test(String(e.from)) ? e.from : "?"}: ${brief(e.text)}`);
  return `Since your last turn: ${fresh.length > 20 ? `(${fresh.length - 20} older) ` : ""}${parts.join("; ")}.`;
}
