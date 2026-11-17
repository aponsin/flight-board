// #C1163 (Manager's audit 11-17): what "signed" and "Security wanted" mean, in ONE place. Pure, no imports (the Worker and the scripts both load it).
//
// A review's note on a commit signs it only when the FIRST line starts with the role's word: PASS for Checker, SECURE for Security. The probe used to count any note that did not
// start FINDINGS as a sign-off, while the landing job, the release tool, the re-cut tool and the self-deploy gate want PASS and SECURE, so a note saying HOLD or STOP read as signed
// on the board and landed nothing. A role with no word here (another repository's reviewer) keeps the older rule: any note that is not FINDINGS.
export const SIGNOFF_WORD = { checker: /^PASS\b/, security: /^SECURE\b/ };
const WORD_NAME = { checker: "PASS", security: "SECURE" };
export const noteLine = (note) => String(note ?? "").split("\n")[0].trim();
export const isFindings = (note) => /^FINDINGS\b/.test(noteLine(note));
// Whether the note signs the commit for the role.
export const isSignoff = (note, role) => (Object.hasOwn(SIGNOFF_WORD, role) ? SIGNOFF_WORD[role].test(noteLine(note)) : noteLine(note) !== "" && !isFindings(note));
export const signoffWord = (role) => WORD_NAME[role] ?? null;
// The first lines sign-note.mjs may write for a role: its sign-off word, FINDINGS (sent back) or STOP (held); anything else is refused.
export const noteLineOk = (role, line) => (Object.hasOwn(SIGNOFF_WORD, role) && SIGNOFF_WORD[role].test(noteLine(line))) || /^(FINDINGS|STOP)\b/.test(noteLine(line));

// The board's own repository words (collector/pairs.mjs BOARD_REPO_WORDS; this file imports nothing, a test holds the two equal).
export const BOARD_WORDS = new Set(["flight-board", "board"]);
// A card of the board's own repository is landed by the landing job, which wants Security's SECURE on every commit, so Security reviews it whatever its typed level or the paths it touched.
export const securityAlways = (repoWord) => BOARD_WORDS.has(String(repoWord ?? ""));
// Whether Security's review is wanted: the card is Full, the probe raised it from the paths (waitingFor), or it is a board card. The dispatch and the page's level both read this.
export const wantsSecurity = ({ review_level, repo, waitingFor, signed } = {}) =>
  review_level === "Full" || securityAlways(repo) || (Array.isArray(waitingFor) && waitingFor.includes("security")) || (Array.isArray(signed) && signed.includes("security"));
