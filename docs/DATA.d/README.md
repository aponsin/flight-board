# DATA.d: one "Changes" line per card

A card that changes `docs/DATA.md` (a row, or any line under "Changes") writes ONE file here, named for its card id (the Board-Id trailer):
`docs/DATA.d/<card id>.md`, one line, `- YYYY-MM-DD: what changed, why, what it ships as, the tests (#C<number>)`.

Never append to the end of `docs/DATA.md`: every branch did, every landing conflicted every waiting branch there, and each conflict cost a rebase and a
re-sign (11-16: #C1075 twice, then three more rebases the same day). Two branches that each add a file here never conflict.

`node scripts/data-fragments.mjs --check` tests the files; `node scripts/data-fragments.mjs --write` folds them into the end of `docs/DATA.md`, oldest date
first (then by card number), and deletes them. A release or a pack runs `--write` once, as `scripts/changelog.mjs` does for `CHANGELOG.d/`. This README is
not a fragment and is never folded.
