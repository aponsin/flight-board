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

// #C1407 (11-20 about 10 pm MT: Release's dry run for #C1406 at 261814e7 said "my gate did not ask for Designer", yet the tip changed page/board.template.html and Designer had put FINDINGS on that exact tip;
// Manager stopped the land by hand): Designer's note (refs/notes/designer) is read by the landing too. A tip is refused when Designer's note on it is FINDINGS, and when the tip changes anything under
// page/ (the page and its styles) unless Designer's LOOK-OK is on that tip, or on an earlier commit of the line with no change to page/ since. The facts are git's alone (the card's look_change
// flag lives on the board, not in git; a card that changes the page always shows in the diff). `quiet` is the callers' git read: the output, "" for no output, null for a failed read.
export const DESIGNER_REF = "refs/notes/designer", DESIGNER_COPY = "refs/notes/board-release/designer", PAGE_DIR = "page/";
export const isLookOk = (note) => /^LOOK-OK\b/.test(noteLine(note));
export function designerFacts({ quiet, main, tip, noteRef = DESIGNER_COPY }) {
  const show = (c) => quiet(["notes", `--ref=${noteRef}`, "show", c]);
  const page = quiet(["diff", "--name-only", `${main}...${tip}`, "--", PAGE_DIR]);
  const touchesPage = page === null ? null : page.split("\n").some((l) => l.trim() !== "");
  const note = show(tip);
  let okBefore = false;
  if (touchesPage && !isLookOk(note)) {
    for (const c of (quiet(["rev-list", `${main}..${tip}`]) ?? "").split("\n").map((l) => l.trim()).filter((l) => /^[0-9a-f]{40}$/.test(l) && l !== tip)) {
      if (!isLookOk(show(c))) continue;
      if (quiet(["diff", "--name-only", c, tip, "--", PAGE_DIR]) === "") { okBefore = true; break; } // "" is no change to page/ since that LOOK-OK; a failed read (null) is no cover
    }
  }
  return { note, touchesPage, okBefore };
}
// The refusals for a tip's designer facts ({ note, touchesPage, okBefore } from designerFacts), as plain sentences; [] when the tip may land.
export function designerRefusals(d) {
  if (!d || typeof d !== "object") return [];
  if (isFindings(d.note)) return [`Designer's FINDINGS note stands on this tip (${DESIGNER_REF}): Designer has to note LOOK-OK on the fixed tip`];
  if (d.touchesPage === null) return [`whether the tip changes ${PAGE_DIR} could not be read, so Designer's LOOK-OK cannot be checked`];
  if (d.touchesPage && !isLookOk(d.note) && !d.okBefore) return [`it changes ${PAGE_DIR} and has no LOOK-OK from Designer on this tip in ${DESIGNER_REF} (a LOOK-OK on an earlier commit of the line counts only with no change to ${PAGE_DIR} since)`];
  return [];
}

// The board's own repository words (collector/pairs.mjs BOARD_REPO_WORDS; this file imports nothing, a test holds the two equal).
export const BOARD_WORDS = new Set(["flight-board", "board"]);
// A card of the board's own repository is landed by the landing job, which wants Security's SECURE on every commit, so Security reviews it whatever its typed level or the paths it touched.
export const securityAlways = (repoWord) => BOARD_WORDS.has(String(repoWord ?? ""));
// Whether Security's review is wanted: the card is Full, the probe raised it from the paths (waitingFor), or it is a board card. The dispatch and the page's level both read this.
export const wantsSecurity = ({ review_level, repo, waitingFor, signed } = {}) =>
  review_level === "Full" || securityAlways(repo) || (Array.isArray(waitingFor) && waitingFor.includes("security")) || (Array.isArray(signed) && signed.includes("security"));
