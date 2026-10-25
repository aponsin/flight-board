# Changelog

## 0.3.1 - Unreleased

### Changed
- Text boxes work like the chat app: Enter presses the box's main button (Done, OK, Ack, Send, Send to Manager); Shift+Enter or ⌘+Enter (Ctrl+Enter off a Mac) adds a line. Nothing while an input method composes, in an empty box, on a disabled button or in a decision with options. Each box says so under it.
- The collector runs hourly (the app's scheduler): the gate counts its mirror fresh for 75 minutes, not 30 (`gate.mirrorMaxAgeMin`), so the board-state rules keep running between runs. A scheduled run's session takes the task's own title, so the task is titled `Collector` and the role rule is unchanged.
- The collector's first run (TASK.md): the folder is set in the app's view of the task and checked after saving; the export's folder (`mirror.next`) and step 3's `out` are the task's `additionalDirectories`, never their parent; the lead is messaged by session id, since a scheduled run reaches no session by name; a correct run asks for nothing, so any prompt is answered Deny and the run stopped (an "always allow" stays on the task).

### Added
- A Close button on every open thread: the owner's message marks it resolved (and closes an ask or idea), with no ping; it folds into Resolved.
- A message may name the one it answers (`after: <message id>`); it then always comes after it, whatever the clocks said.

### Fixed
- Send takes the text out of the box at once: no kept draft after sending, no second send of the same text; a failed save puts it back.
- The gate lays every write it let through since the mirror's export over the mirror, so a card closed since shows closed and the board-state rules keep running (a card closed earlier showed as still on build).

## 0.3.0 - Unreleased

### Added
- The collector (`collector/`): each open card's phase from the repository (Board-Id trailers, branches, release commits that name shipped branches, sign-off notes, the main branch, the deploy run), with its version; conflicts with the card's own phase and the cards live but still open; `derived/all` for the page and the gate; `TASK.md` for the scheduled run.
- The gate's rules that need the board's state, against the collector's mirror: phases only move forward, one card per role per build or review phase, done only with the owner answered, no open ask and live by the evidence.
- The page shows "Repository: <phase> <version>" on each card, marked when the card disagrees.
- Hardening (Security): a sha from a commit subject reaches git only as plain hex; `collect.mjs --prepare` makes a fresh export folder, which the run swaps in whole as the mirror, only under `<stateDir>/<board id>`.
- Review fixes (Checker, Manager's rules): a sign-off note on a card's head means READY until heads carry Board-Id, and missing evidence is no conflict; one card per owner only in `collector.lanePhases` (build, test), while reviews and shipping queue; a card given up closes as "dropped" with a `dropReason`, shown as Dropped, with no live evidence needed.

## 0.2.0 - Unreleased

### Added
- The write gate (`gate/`): the board's rules on every write; decisions with two options or more, context and per-option screenshots for a look; commands as `{text, cmd}`; each role's own memory tile (the lead keeps the keeper's writes); passing agent states never become items; the stuck line after three refusals in a row, shown on the page and cleared by the item's next good write; hand-offs name an existing card; the Stop hook for verdicts and thread answers.
- `scripts/hooks.mjs`: the gate's settings entries, printed or written, every path single-quoted for sh (nothing in it expands); `--retire <text>` removes an older gate's hook in the same write; a one-line summary of the change and a timestamped backup. `--pin <signed commit>` (required) exports that commit with git archive to `~/.flight-board/install/<sha>` and points the hooks there, so they never run a checkout someone is editing; upgrading is installing a newer signed sha.
- The gate refuses an edit in place (str_replace) on the board, and lets only the lead set or delete the whole of meta/context or meta/stuck (Checker).
- `DECISIONS.md`: the role check is an integrity check, never access control; the gate fails open on its own errors.
- Not in the gate: a reused id (the board's server refuses a set without if_version); phase order, one item per role and phase, and done-only-when-closed come with the collector, which keeps the board's mirror.

## 0.1.0 - Unreleased

### Added
- The board page as a template, with everything particular to one team in its own `board.config.json`: title, owner, phases, roles, skips, usage labels.
- Threads: every item is a thread (`messages`); a "Start a thread" box (question or idea); a reply reopens a resolved ask or idea; each message from the owner pings the lead agent as `Board thread [<thread>]: <owner>: <text>`, or waits for its check with `meta/board.wake` "batch".
- A bare Ack on an answer closes it; a note on any button also goes in the item's thread, so a question in it waits for an answer.
- The content scan before every push, against the team's private word list and for artifact links, real emails and phone numbers, and tokens.
- `scripts/install.mjs`, `scripts/build-page.mjs`, and tests for every rule.

### Fixed (review, before 0.1.0)
- The pre-push scan reads what the push sends: every file each pushed commit adds or changes, and each commit's message, not the working tree. `--all` scans every commit ever made, for the check before going public.
- The scan also catches phone numbers written as digits (+13035550100 style), Stripe, webhook, Resend and fine-grained GitHub keys; it refuses a word list with no words; no-reply addresses pass.
- `install.mjs` keeps the config and word list outside the repository from any folder in it.
- The scan reads a merge's own changes, ranges a push against that remote only (a first push to a new remote scans everything), and scans pushed annotated tags (tagger and message, not the time) and every commit's author and committer.
