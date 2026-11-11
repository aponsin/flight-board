-- #C902 (prevention, 2026-11-10: #C884's result was a file with no branch; the store kept reading it "at build" and waking its
-- agent, and the only way to close it was dropped, which says "not done"). A card closed as done by an agent, with what shows it:
-- a file path, an https link or a thread message id. Additive: nothing dropped or rewritten; existing cards stay open (both null).
ALTER TABLE cards ADD COLUMN done_at INTEGER;
ALTER TABLE cards ADD COLUMN done_evidence TEXT;
