// #C1166 (1): the one reading of a commit's "Board-Id: <card id>" trailer. Git reads a trailer only in the LAST paragraph of the message
// (the landing job, the release job and stack-ready ask git for it with %(trailers:key=Board-Id)); the probe's parsers used to read a
// line anywhere in the message, some case-insensitively and some with any value, so a commit the land job refused could still light a card.
// Now every reader takes the same lines git does: the last paragraph, the key matched without case, a value that is a card id.
// A line that starts with a space or tab continues the line above (git's folding), so "Board-Id: a" plus " b" is not the id "a".
export const BOARD_ID_SHAPE = /^[a-z0-9][a-z0-9-]{0,63}$/;

// Every Board-Id value in the last paragraph of a commit message, in order, as the card ids they are (a value that is no card id is left out).
export function boardIdsOf(message) {
  const text = String(message ?? "").replace(/\r\n?/g, "\n").replace(/\s+$/, "");
  if (!text) return [];
  const paragraphs = text.split(/\n[ \t]*\n/);
  const last = paragraphs.length > 1 ? paragraphs[paragraphs.length - 1] : "";
  const out = [];
  let open = null;
  for (const line of last.split("\n")) {
    if (/^[ \t]/.test(line) && open) { open.value += ` ${line.trim()}`; continue; }
    const m = /^([A-Za-z0-9-]+)[ \t]*:[ \t]*(.*)$/.exec(line);
    open = m ? { key: m[1].toLowerCase(), value: m[2].trim() } : null;
    if (open) out.push(open);
  }
  return out.filter((t) => t.key === "board-id" && BOARD_ID_SHAPE.test(t.value)).map((t) => t.value);
}

// The card a commit message names: git's last Board-Id trailer, or null.
export const boardIdOf = (message) => boardIdsOf(message).at(-1) ?? null;
