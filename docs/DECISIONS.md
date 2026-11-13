# Decisions log (the board's builder)

Dated lines, newest first: choices made in the build that the code alone does not explain.

- 2026-11-10 (Security and Checker LOWs, accepted, no code change): four findings are recorded here instead of fixed.
  (1) `ownHead` (collector/state.mjs) trusts a Board-Id on a foreign commit: it only changes what a card's head shows, and a ship still checks the signatures on the exact sha, so a foreign id cannot ship anything.
  (2) `mainEvidence` (collector/state.mjs): a merged outside commit that cites #C<n> and matches versionPattern can set workSeen and shippedAt on that card; both are display only (the shipped feed and the card's time) and no rule reads them to ship or wake. A card number outside 1 to 1e6 gets no reading at all.
  (3) `stalledWaits` (worker/board-rules.mjs) exempts any card with a non-empty repo word from the stall wake at ship, so a team card given a repo name by mistake would lose that wake. The repo word is set by the probe from git (#C742), by the delta import (#C741) and by Manager's card tools, never by another agent's own card.
  (4) #C732's live exemption has no test for a live card with Release idle; the case is the next test to add with the board's next rules change.
  Kept here so the next change to these three places knows they were seen and accepted, not missed.
- 2026-11-10 (C5 import, #C744): the real delta import ran at 18:21Z. The store's `C` counter was already above the import's (821, from the cut-over import), and the import only ever raises a counter, so it stayed. A later run (at the switch) must not expect a fixed `next #C`: it prints the counter and the expectation is "at least the newest card number plus one".

- 2026-11-09 (#C728, import3): ten old step rows were refused by the import as step shape (history only, refused as step shape, not
  imported): board-doc-cap/build, board-header-sticky/build, card-from-commits/build, collector-fence-app-fields/build,
  hook-nag-live-check/build, call-voicemail-note/build, the merge-guard card's live step (its id starts with the name of the
  prospecting agent), step-start-evidence/build, step-tile-evidence/build, usage-other-named/build. The cards they belong to are unaffected: the phase history is built from the probe's readings.
- 2026-11-09 (#C725 B1): the owner's messages are stored under the author "owner" (the store's own word: the wake and Manager's inbox
  count them); the page shim turns it into the owner's name from the page config and back, so the repository never holds a name.
  A thread the owner starts is a row of `threads` with a #T number from the same counter as asks; a rename of any thread keeps only
  its title there. The view carries every message in full (a few dozen after the import); the "resolved threads load on open" rule
  of the plan is not built, because the volume does not need it yet.
- 2026-11-13 (#C1022, Security's pick B on its residual LOW on #C968): the self-deploy gate does NOT check that main's tip was landed by the release tool. Every agent runs node as the same Mac user, so any record the tool writes (a git note, a ref, a Keychain key, a store endpoint) an agent can write too; option A (a landing key and a store endpoint) added a secret and protected nothing more. The release tool writes refs/notes/landed after each real landing as an audit trail only, and nothing trusts it. What limits the risk: the gate needs a Security SECURE and a Checker PASS on main's tip (and on every commit since the Worker's BUILD_SHA, #C1045), the tip must descend from that BUILD_SHA, and every deploy pushes "board deployed <sha>" to the owner's phone, so a forged landing is seen within minutes and can be rolled back. The only real fix is a second identity agents cannot use (a separate macOS user for the release tool, or landing from a cloud runner): the owner's call if he wants it. Revisit if agents ever run under another identity than the release tool.
