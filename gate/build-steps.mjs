// Build steps as the gate reads them (#C649): who has started a card and who has ended it, from the board's steps. Pure: no file,
// no network, no import. gate/commit.mjs (a tagged commit) and gate/gate.mjs (a READY message) both use it.
//
// A start counts only when it is a PLAIN build start: a start with a wait ("busy" or "gate") means the card is queued behind the
// agent's other work, not started (#C654, Manager). An end counts only when it is later than that start.

// The card number of a git commit whose message starts "#C<num>:", or null. The message is the one after -m / --message, or the
// first line of a heredoc given to it; "#C123" later in a subject ("… (#C123, Manager)") is not a tag.
const COMMIT = /\bgit\b(?:\s+-[Cc]\s+\S+|\s+-c\s+\S+|\s+--[a-z-]+(?:=\S+)?)*\s+commit\b/;
const SUBJECT_M = /\s(?:-[a-zA-Z]*m|--message)(?:=|\s*)["']?\s*#C(\d{1,6}):/;
const SUBJECT_HEREDOC = /<<-?\s*['"]?\w+['"]?\s*\n\s*#C(\d{1,6}):/;
export function commitCardNum(command) {
  if (typeof command !== "string" || !command.includes("#C") || !COMMIT.test(command)) return null;
  const m = SUBJECT_M.exec(command) ?? SUBJECT_HEREDOC.exec(command);
  return m ? Number(m[1]) : null;
}

// The card a message names: "board id <id>" or "#C<num>". Returns [{ id } | { num }].
export function namedCards(text) {
  const s = String(text ?? ""), out = [];
  for (const m of s.matchAll(/\bboard id[:\s]+`?([a-z0-9]+(?:-[a-z0-9]+)*)/gi)) out.push({ id: m[1].toLowerCase() });
  for (const m of s.matchAll(/#C(\d{1,6})\b/g)) out.push({ num: Number(m[1]) });
  return out;
}
export const isReady = (text) => /^\s*READY\b/.test(String(text ?? "")); // the word as the hand-off writes it, in capitals

// The card document for an id or a number, from the mirror's initiatives (null if unknown).
export function findCard(mirror, ref) {
  const list = Array.isArray(mirror?.docs?.initiatives) ? mirror.docs.initiatives : [];
  return list.find((d) => (ref.id !== undefined ? d.id === ref.id : Number.isInteger(ref.num) && d.num === ref.num)) ?? null;
}

// { steps: bool (the mirror holds any steps at all), started: the latest plain build start by role on the card (ms) or null,
// ended: bool (an end by role after it) }.
export function buildState(mirror, role, cardId) {
  const list = Array.isArray(mirror?.docs?.steps) ? mirror.docs.steps : [];
  const mine = list.filter((s) => s && s.init === cardId && s.who === role && s.phase === "build" && Number.isFinite(s.at));
  const starts = mine.filter((s) => s.kind === "start" && !s.wait);
  const started = starts.length ? Math.max(...starts.map((s) => s.at)) : null;
  const ended = started !== null && mine.some((s) => s.kind === "end" && s.at > started);
  return { steps: list.length > 0, started, ended };
}

export const startWrite = (cardId, role, now) => `db_write set steps/${cardId}-build-start-${now} {"at": ${now}, "init": "${cardId}", "kind": "start", "phase": "build", "who": "${role}"} (the real clock: node -e "console.log(Date.now())")`;
export const endWrite = (cardId, role, now) => `db_write set steps/${cardId}-build-end-${now} {"at": ${now}, "init": "${cardId}", "kind": "end", "phase": "build", "who": "${role}"} (the real clock: node -e "console.log(Date.now())")`;

// A commit tagged #C<num>: refused until the committer has a plain build start on that card. Returns an error text or null.
// Anything it cannot tell (no role, a stale or missing mirror, no such card, no steps loaded) is null: the gate fails open.
export function commitError({ num, role, mirror, now, maxAgeMs }) {
  if (!role || !mirror || !(now - mirror.at < maxAgeMs)) return null;
  const card = findCard(mirror, { num });
  if (!card || typeof card.id !== "string") return null;
  const b = buildState(mirror, role, card.id);
  if (!b.steps || b.started !== null) return null;
  return `Flight board refused this commit: it is tagged #C${num} (card ${card.id}) but ${role} has no plain build start step on that card, so the board would show it idle. A start with a wait (busy) means not started. Write the start first: ${startWrite(card.id, role, now)}. Then commit again.`;
}

// A READY message about a card the sender started: refused until the sender's end step exists after that start. A card the
// sender never started is not its to end: no requirement. Returns an error text or null.
export function readyError({ text, role, mirror, now, maxAgeMs }) {
  if (!isReady(text) || !role || !mirror || !(now - mirror.at < maxAgeMs)) return null;
  const seen = new Set();
  for (const ref of namedCards(text)) {
    const card = findCard(mirror, ref);
    if (!card || typeof card.id !== "string" || seen.has(card.id)) continue;
    seen.add(card.id);
    const b = buildState(mirror, role, card.id);
    if (b.steps && b.started !== null && !b.ended) return `Not sent. This is READY for card ${card.id} but ${role} has no build end step after its start. Write the end first: ${endWrite(card.id, role, now)}. Then send READY again.`;
  }
  return null;
}
