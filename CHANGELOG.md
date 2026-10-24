# Changelog

## 0.1.0 - Unreleased

### Added
- The board page as a template, with everything particular to one team in its own `board.config.json`: title, owner, phases, roles, skips, usage labels.
- Threads: every item is a thread (`messages`); a "Start a thread" box (question or idea); a reply reopens a resolved ask or idea; each message from the owner pings the lead agent as `Board thread [<thread>]: <owner>: <text>`, or waits for its check with `meta/board.wake` "batch".
- A bare Ack on an answer closes it; a note on any button also goes in the item's thread, so a question in it waits for an answer.
- The content scan before every push, against the team's private word list and for artifact links, real emails and phone numbers, and tokens.
- `scripts/install.mjs`, `scripts/build-page.mjs`, and tests for every rule.
