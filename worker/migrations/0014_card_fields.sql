-- Card fields the old page draws and agents write (#C729 B4a, board parity stage B): what a card waits on (depends_on, a JSON list of
-- card ids), the five issue counts and when they were last set (issues, a JSON object; issues_at), and the card's place in its
-- owner's queue (queue_pos, 1 = next). All nullable and additive: a card written before has none, and the page draws it as before.
ALTER TABLE cards ADD COLUMN depends_on TEXT;
ALTER TABLE cards ADD COLUMN issues TEXT;
ALTER TABLE cards ADD COLUMN issues_at INTEGER;
ALTER TABLE cards ADD COLUMN queue_pos INTEGER;
