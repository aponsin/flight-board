# Board parity: the old page on the store

The old board page (`page/board.template.html`) served by the store Worker at `/board` (#C723), against the same page on the artifact. The owner switches when every row below is **same** or **gone** (parity plan rule 6), with screenshot pairs at phone and laptop width and Designer's LOOK-OK.

Status words:
- **same**: the store's page shows it as the artifact's does.
- **gone**: left out on the store by the owner's agreement of 2026-11-04 (`docs/DATA.md`, its words quoted) or his later word. The store's page hides it (`STORE` in the page; `tests/store-gone.test.mjs`); the artifact's page still shows it.
- **not yet**: the store has no data or no write for it yet; the stage that brings it is named. The page draws what it has: an area with no data is empty, as the old page already does.

How it is checked: `tests/store-page.test.mjs` (the page as served), `tests/hostile-text.test.mjs` (no board text becomes markup, both pages), `tests/compat-view.test.mjs` and `tests/compat-routes.test.mjs` (the store's answers in the old shapes, Boardsmith), `tests/store-gone.test.mjs` (the gone rows).

## Header

| Item | Status | Where it comes from on the store |
|---|---|---|
| Live now vX | same | evidence `live` (compat `meta/live`, `derived/all.live`) |
| Live now "deploying vY" | not yet: B3a | the probe's `ship` evidence |
| "⚠ Manager missed" after Live now | hidden on the store: a typed-field gap (row 37, "Mostly deleted with the typed fields") | |
| Clock, "Studio checked N s" | same | probe reading via the shim |
| "Board data behind, reloading" | gone: "Delete: row 2's 'fetched N s ago' covers it once there is one store" (row 3) | |
| Manager chip | not yet: B1 ("seen your message" needs messages) | `wakeState` |
| Safe to restart, "Don't restart: shipping" | not yet: B3a | probe `agents`, `ship` |
| Board vX · page abc | same | the build's stamp |
| "Manager stuck on …" | not yet: B4 (refusals in the old shape, with the "You:" action) | `refusals` |
| "X waiting on you since" | not yet: B3a | probe `stuck` |
| "You wrote, Manager silent N min" | not yet: B1 | messages |
| Comment threads full | gone: "Delete with the artifact comments" (row 11) | |
| Keeper line | gone: "Delete" (row 12) | |
| Layout link, Now / Plan / Crew views | gone: "Delete: v3 layout and plan outline removed" (row 45) | |

## Memory and crew

| Item | Status | Where it comes from on the store |
|---|---|---|
| Memory tiles: %, bar, colour, tokens, age | not yet: B3a | probe `ctx` |
| "/clear me" | gone: "Delete the flag" (row 14) | |
| Refresh (↻) on a faded tile | gone: "the Refresh request" (Deleted list). Row 15's "check now" comes back with its own endpoint, later | |
| Model · effort | not yet: B4 | |
| Who is on what | not yet: B3a (agents), B4 (notes) | probe `agents` |

## Needs you, threads, lists

| Item | Status | Where it comes from on the store |
|---|---|---|
| Tabs with counts, arrow keys | same for asks and lists; not yet: B1 for threads | |
| Needs you: asks, "Your queue" | same | compat `waiting` |
| Ask row: kind, #T, title, badge, age, "For: card" | same; the chip after an answer: B1 | compat `waiting` |
| Ask steps with Copy per command, "You should see" | not yet: B2 (steps are plain strings) | |
| Ask screenshots, picture viewer | not yet: C1 (no file store). Until then a screenshot shows as a broken picture, with a policy error in the browser's console | |
| Reply box per kind (A/B, OK/Change, Ack, Done/Help) | same for an option, Ack and Done; not yet: B2 for a note, "Something else", files | `POST /api/compat/write` |
| Sent line "You chose …" | same for the choice; not yet: B2 for the note and files | |
| "Manager missed" on an ask | hidden on the store until B4 (Manager, 2026-11-09): its fields are not in the store yet | |
| Thread messages, "seen HH:MM" | not yet: B1 | |
| Thread buttons: Close, options, Rename | not yet: B1 (asks close today) | |
| Later tab | same | compat `waiting` (Later) |
| With the team, sub-step line | not yet: B1, B3a | |
| Resolved tab, search | same for closed asks; not yet: B1 for threads | |
| Pull request panel | gone: "Folded into row 19 as the Approval type" (row 22); Approval asks come in C4 | |
| To-do: rank, up/down, Done, Add | same | `lists` |
| Ideas: kind, Close, Add | same | `lists` |
| "Let's start" on an idea | gone: "not part of this change" (DATA.md Changes, 2026-11-09, the lists) | |
| #T and #C links, hover, jump | same for asks and cards; not yet: B1 for threads | |
| Files: attach, paste, drop, thumbnails, save | not yet: C1 | |

## Cards

| Item | Status | Where it comes from on the store |
|---|---|---|
| Name row: #C, repo badge, "from #T", size | same | compat `initiatives` |
| Status pill | same where the probe has evidence; not yet: B3a for the rest | `derived/all.cards` |
| Check button, "checked by the Collector" | gone: "Delete with the Collector" (row 38) | |
| Source-disagreement flag | gone: "Delete: one source, nothing to flag" (row 28) | |
| ETA box | not yet: B3b, B4 | |
| Version note, "Next: vX" | not yet: B3a, B4 | |
| Track: lit phase, skips | same | `derived/all.cards` |
| Track: who · time on each tile | not yet: B3b (tiles say "no record") | `derived/all.times` |
| One track per branch | not yet: B3a | probe `cards.branches` |
| Queue line, "waits on", Next (written N ago), Started, issue chips | same for next note, waiting on, started; not yet: B4 for the rest | |
| "Manager missed" on a card | hidden on the store until B4 (Manager, 2026-11-09; the ETA inputs come in B4) | |
| Thread fold, closed asks | not yet: B1 | |
| Done in the last 24 h | not yet: C2 | |

## Shipped, time, usage

| Item | Status | Where it comes from on the store |
|---|---|---|
| Shipped feed, search | not yet: C2 | |
| Time spent: tiles, chart | not yet: C3 | |
| Plan-week tile | not yet: B3a | probe `usage` |
| Per-agent table | not yet: C3 | |

## The page itself

| Item | Status |
|---|---|
| Keys, touch, copy buttons, drafts and folds kept across redraws, light and dark, phone widths | same (the page's own code) |
| Fonts | same: self-hosted (`page/fonts/`, DECISIONS) |
| Lightbox buttons | same: wired by listener, not inline |
