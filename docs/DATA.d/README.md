# DATA.d: one "Changes" line per card

A card that changes `docs/DATA.md` writes the dated line that says so ("what changed, why, what it ships as, the tests") as ONE file here, named for its card id
(the Board-Id trailer): `docs/DATA.d/<card id>.md`, one line, `- YYYY-MM-DD: what changed, why, what it ships as, the tests (#C<number>)`. The row, the principle or
the wording that changed is still edited in `docs/DATA.md` itself, as before; only the dated line goes here.

Never append the dated line to the end of `docs/DATA.md`: every branch did, every landing conflicted every waiting branch there, and each conflict cost a rebase
and a re-sign (11-16: #C1075 twice, then three more rebases the same day). Two branches that each add a file here never conflict.

`node scripts/data-fragments.mjs --check` tests the files; `node scripts/data-fragments.mjs --write` folds them into the end of `docs/DATA.md`, oldest date
first (then by card number), and deletes them. Only the fold card does that: a card whose Board-Id starts `fold-data-fragments`, signed like any other. The
landing job refuses every other tip that ADDS a dated line (`- YYYY-MM-DD: ...`) to `docs/DATA.md` (a tip that edits a row or a principle there still lands), and
logs `FOLD DUE` when 5 or more fragments wait on main; the dispatch then wakes Boardsmith, who cuts the fold card. This README is not a fragment and is never folded.
