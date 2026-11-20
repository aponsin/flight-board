# What the product repository's ship tool must accept for a group head (#C1303)

With the product's stack switch on (#C1295), a product group is built on ONE stacked branch, each card on the previous card's tip, reviewed once at the tip, and shipped as one head. The board side is done (dispatch, the stack-ready signal, review notes that cover every member). This note says what the product repository's own ship tool (`npm run ship`, `scripts/ship.mjs` and `scripts/lib/ship.mjs` there) has to do with such a head. Manager cards it for Builder.

Read from a probe clone of the product repository (read only, 11-19). That clone may be behind the product's main: Builder confirms each point below against main before changing anything. Where a point says "confirm", it is a guess from what the tool's header and its imports say, not a reading of the code.

## What the tool already does with one `branch@tip` target

- `parseTarget` takes `branch@commit` (never main or dev). A group head is ONE target: the stacked branch and its tip.
- It checks that the branch's tip is the reviewed commit, then reads the sign-off as git notes on that exact commit: `git notes --ref=checker|security|linguist show <tip>`, the first line only (`PASS None|Quick|Full`, `SECURE`, `LANGUAGE-OK`). A note on a member below the tip is never read.
- The files the verdict looks at are `git diff --name-only origin/dev...<tip>`: every member's change, because the members are stacked under the tip. So Full-or-sensitive-file and customer-text rules already see the whole group.

So a group head with notes ON THE TIP already passes the sign-off check, as long as Release hands it the tip alone.

## What it must accept or do (the rules for Builder's card)

1. **One target, the tip.** Release passes the group's tip only. A member that is also passed as its own target (`member@sha` and the tip together) is refused with a plain reason ("already inside <tip>"), not merged twice.
2. **Notes on the tip cover the members.** The tip's Checker and Security notes are the group's sign-off (the board's review writes them "from main", covering every member). The tool must not ask for a note on a member commit. Its level is the highest level any member needs: a Full member makes the tip's Checker note Full, and then it needs SECURE.
3. **The version commit and the changelog name every member card.** Today the commit message is `v<version>: <branch>@<sha>` for each target, and the release changelog is built from the targets' tips (`releaseChangelog(..., { tips })`). For a group head they should list the cards inside it: the `Board-Id` trailers of the commits in `origin/dev..<tip>`, one line per card. (Confirm how `tips` becomes lines in `lib/ship.mjs`.)
4. **`--dry-run` prints the members.** The cards found in `origin/dev..<tip>`, and each one's `Board-Id`, so Release sees what one ship carries before it runs.
5. **A member with no Board-Id trailer stops the ship** with a plain reason, as a card with no trailer does today (confirm), so a group head never ships a commit no card owns.
6. **No change to the candidate-branch, CI and live-check steps.** They run on the one merged result as they do for any ship.

## What the board side gives the tool

- The probe reads the product's stack from the clone at `collector.repoPath` ("" in the probe's names) when the product's row is on. The live config lists the board's own repository as its one `collector.repos` entry, so the product's clone is the team's own one: no new config entry is needed (#C1303 made the product's row switch it).

- The head and its notes: the branch name, the full 40-character tip, and the notes on it, as every ship gets today.
- The board's switch for the product row is read from `~/.flight-board/stack-switch.json` (`{ at, product: true|false }`), the file the product's release tool already reads (#C900). The tool should treat a missing, stale or off file as "no group heads": ship cards one by one as before.

## Not in this note

- The product repository's own `scripts/stack-ready.mjs`: it has none. The board's `stack-ready` works from a product checkout (`--config <board config>`), as #C1295 made it.
- Turning the switch on: the owner does it, after the Worker deploy and after Builder's change below is in.
