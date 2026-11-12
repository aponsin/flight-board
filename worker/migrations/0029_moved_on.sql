-- #C987: when a card last moved on (its next_note or waiting_on changed value), so an answered Decision whose card moved on after
-- the answer can be closed by the store; and when the store closed an ask that way, so one reopened after it is not closed again.
-- Additive: nothing dropped or rewritten; existing rows stay as they are (both null).
ALTER TABLE cards ADD COLUMN moved_at INTEGER;
ALTER TABLE asks ADD COLUMN auto_closed_at INTEGER;
