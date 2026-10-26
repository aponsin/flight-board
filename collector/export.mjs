// The board export's folder name and collections (collector/TASK.md, step 1): the only collector values the fence needs.
// The fence imports this file alone, so the collector's own code stays out of the owner's pinned install and goes out
// with a board release (#C278, Security). It imports nothing; a test holds it to that.
export const EXPORT_NAME = "flight-board-export";
export const EXPORT_COLLECTIONS = ["initiatives", "waiting", "ideas", "messages", "derived", "ctx", "steps", "plan", "threads"];
