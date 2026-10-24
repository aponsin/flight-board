# Changelog

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
