// What counts as READY in the new probe (#C719). The current probe (collector/derive.mjs phaseFromFacts) reads a head commit
// that carries the card's Board-Id trailer as READY, so every working commit on a long card showed "READY, waiting for
// checker, security" (seen on refactor-step1-store, 2026-11-09). Here only an explicit READY counts: a "Ready: <card id>"
// trailer line naming this very card, or a sign-off note on the head. A Board-Id trailer alone is work in progress.

const trailerLines = (message) => String(message ?? "").split(/\r?\n/).map((l) => l.trim());

// The card ids named by "Ready:" trailer lines in a commit message.
export const readyOf = (message) => trailerLines(message).map((l) => /^Ready:\s*([a-z0-9][a-z0-9-]{0,63})$/i.exec(l)?.[1]?.toLowerCase()).filter(Boolean);

// facts.head.message, the card id, and how many sign-off notes the head carries.
export function isReady(message, cardId, signedCount = 0) {
  return readyOf(message).includes(String(cardId).toLowerCase()) || signedCount > 0;
}
