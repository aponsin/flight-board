// The board export's folder name and collections (collector/TASK.md, step 1): the only collector values the fence needs.
// The fence imports this file alone, so the collector's own code stays out of the owner's pinned install and goes out
// with a board release (#C278, Security). It imports nothing; a test holds it to that.
export const EXPORT_NAME = "flight-board-export";
export const EXPORT_COLLECTIONS = ["initiatives", "waiting", "ideas", "messages", "derived", "ctx", "steps", "plan", "threads"];
// What the run reads and saves: every exported collection but `derived` (the probe makes that one itself).
export const READ_COLLECTIONS = EXPORT_COLLECTIONS.filter((c) => c !== "derived");
// The board's next_cursor is opaque; only its characters are held to a safe set before it is printed into the run's steps
// or written back (#C655).
export const CURSOR = /^[A-Za-z0-9_=+/.:-]{1,512}$/;
export const DOC_ID = /^[A-Za-z0-9_.@+:~-]{1,195}$/;

const plain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// The files the run writes with its Write tool (#C655), checked by shape before they are written (the fence) and again when
// the probe reads them: "page" = {docs: [{id, data}]} (at most 1000), "report" = {collection, next} for a sweep page,
// "seal" = {version} (the version of derived/all the run read last, null if none). Returns the reasons it is refused.
export function fileErrors(kind, content) {
  let v;
  try { v = JSON.parse(content); } catch { return ["not JSON"]; }
  if (!plain(v)) return ["not an object"];
  const keys = Object.keys(v);
  if (kind === "page") {
    if (keys.length !== 1 || keys[0] !== "docs" || !Array.isArray(v.docs)) return ["a page is {docs: [...]} only"];
    if (v.docs.length > 1000) return ["at most 1000 documents a page"];
    for (const e of v.docs) {
      if (!plain(e) || Object.keys(e).some((k) => k !== "id" && k !== "data")) return ["each document is {id, data} only"];
      if (typeof e.id !== "string" || !DOC_ID.test(e.id)) return ["a document id of letters, digits and _ . @ + : ~ -"];
      if (!plain(e.data)) return ["each document's data is an object"];
    }
    return [];
  }
  if (kind === "report") {
    if (keys.length !== 2 || !keys.includes("collection") || !keys.includes("next")) return ["a report is {collection, next} only"];
    if (!READ_COLLECTIONS.includes(v.collection)) return ["collection: an exported one"];
    if (v.next !== null && !(typeof v.next === "string" && CURSOR.test(v.next))) return ["next: null or the board's cursor"];
    return [];
  }
  if (kind === "seal") {
    if (keys.length !== 1 || keys[0] !== "version") return ["the seal is {version} only"];
    return v.version === null || (Number.isInteger(v.version) && v.version >= 0) ? [] : ["version: a whole number or null"];
  }
  return ["unknown file"];
}
