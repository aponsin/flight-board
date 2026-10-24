# Changelog

## 0.2.0 - Unreleased

### Added
- The write gate (`gate/`): the board's rules on every write; decisions with two options or more, context and per-option screenshots for a look; commands as `{text, cmd}`; each role's own memory tile (the lead keeps the keeper's writes); passing agent states never become items; the stuck line after three refusals in a row, shown on the page and cleared by the item's next good write; hand-offs name an existing card; the Stop hook for verdicts and thread answers.
- `scripts/hooks.mjs`: the gate's settings entries, printed or written, every path single-quoted for sh (nothing in it expands); `--retire <text>` removes an older gate's hook in the same write; a one-line summary of the change and a timestamped backup.
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
