# Decisions log (the board's builder)

Dated lines, newest first: choices made in the build that the code alone does not explain.

- 2026-11-09 (#C728, import3): ten old step rows were refused by the import as step shape (history only, refused as step shape, not
  imported): board-doc-cap/build, board-header-sticky/build, card-from-commits/build, collector-fence-app-fields/build,
  hook-nag-live-check/build, call-voicemail-note/build, the merge-guard card's live step (its id starts with the name of the
  prospecting agent), step-start-evidence/build, step-tile-evidence/build, usage-other-named/build. The cards they belong to are unaffected: the phase history is built from the probe's readings.
- 2026-11-09 (#C725 B1): the owner's messages are stored under the author "owner" (the store's own word: the wake and Manager's inbox
  count them); the page shim turns it into the owner's name from the page config and back, so the repository never holds a name.
  A thread the owner starts is a row of `threads` with a #T number from the same counter as asks; a rename of any thread keeps only
  its title there. The view carries every message in full (a few dozen after the import); the "resolved threads load on open" rule
  of the plan is not built, because the volume does not need it yet.
