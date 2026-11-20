// #C1379 (repair-false-install-waits): the ONE rule for the one-time repair, written once as SQL. Migration 0040 holds DELETE_FALSE_WAITS verbatim, and
// scripts/repair-false-install-waits.mjs (the dry run) runs LIST_FALSE_WAITS on the same cards, so the list a pack note shows and the rows the deploy
// removes cannot differ (tests/repair-false-install-waits.test.mjs holds the migration to this text).
//
// A false install wait is a phase_history row with wait 'install', written by the store's own evidence write (source 'evidence'), for a card whose repository
// word is a PRODUCT repository (worker/board-rules.mjs repoKind: not empty, not a board word). Before #C1378 any card with a word at ship and on main got one.
// The rows are removed whole, a start and its end alike: the product has no install, and a closed false wait would still bend the install-time medians.
// A board card's rows, the probe's own rows, the step tool's waits and every card (done_at, evidence, phase) are never touched: no card is reopened.
//
// repoKey in SQL: lower-case, trimmed, a trailing ".git" and everything up to the last "/" removed; a board word is flight-board or board (LANDED_REPO_WORDS).
const KEY = "(CASE WHEN LOWER(TRIM(repo)) LIKE '%.git' THEN SUBSTR(LOWER(TRIM(repo)), 1, LENGTH(LOWER(TRIM(repo))) - 4) ELSE LOWER(TRIM(repo)) END)";
export const PRODUCT_CARDS = `SELECT id FROM cards WHERE repo IS NOT NULL AND TRIM(repo) <> '' AND NOT (${KEY} IN ('flight-board', 'board') OR ${KEY} LIKE '%/flight-board' OR ${KEY} LIKE '%/board')`;
const WHERE = `wait = 'install' AND source = 'evidence' AND card_id IN (${PRODUCT_CARDS})`;
export const DELETE_FALSE_WAITS = `DELETE FROM phase_history WHERE ${WHERE};`;
export const LIST_FALSE_WAITS = `SELECT card_id, kind, at FROM phase_history WHERE ${WHERE} ORDER BY card_id, at, id;`;
