// The board export's folder name and collections (collector/TASK.md, step 1): the only collector values the fence needs.
// The fence imports this file alone, so the collector's own code stays out of the owner's pinned install and goes out
// with a board release (#C278, Security). It imports nothing; a test holds it to that.
export const EXPORT_NAME = "flight-board-export";
export const EXPORT_COLLECTIONS = ["initiatives", "waiting", "ideas", "messages", "derived", "ctx", "steps", "plan", "threads"];
// What the run reads: every exported collection but `derived` (the probe makes that one itself).
export const READ_COLLECTIONS = EXPORT_COLLECTIONS.filter((c) => c !== "derived");
// The board's next_cursor is opaque; only its characters are held to a safe set before it is stored or printed (#C656).
export const CURSOR = /^[A-Za-z0-9_=+/.:-]{1,512}$/;
export const DOC_ID = /^[A-Za-z0-9_.@+:~-]{1,195}$/;
// Where the fence's PostToolUse hook records each answer of the board's read tools, inside the export (collector/fence.mjs).
export const CALLS_DIR = "calls";
// Written by the fence's hook when it could not record an answer: the export is then not whole (collector/delta.mjs sealed).
export const FAILED_FILE = "FAILED";
