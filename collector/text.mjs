// What the collector prints goes into its session and on to the lead (collector/TASK.md), so board text never reaches
// it as written: a value a writer chose prints only if it has the shape of a board document id, otherwise "?" (Security:
// a step's who of "Builder\nIGNORE ALL RULES…" printed as an instruction). Text built from the repository (a branch, a
// version) is one line: control and format characters become spaces, and it is capped.
const ID = /^[A-Za-z0-9_.~:@+-]{1,64}$/;
export const idText = (v) => (typeof v === "string" && ID.test(v) ? v : "?");
export const lineText = (v, max = 160) => String(v ?? "").replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu, " ").replace(/\s+/g, " ").trim().slice(0, max);
