-- The reason list of a rework gains "wording" (#C1114 part 2: a step back needs a reason from bug, security, wording, design or owner change, and each accepted
-- reason adds 1 to its counter). The list lives in two CHECK constraints, which SQLite cannot change in place:
--   cards.rework_reason: copied to a new column, the old one (and its CHECK) dropped, the new one renamed back, so the cards table itself is never rebuilt;
--   rework_history: a small table, rebuilt with the same rows and its index.
-- The list itself is held by worker/board-rules.mjs (REWORK_REASONS, refused before a write reaches the database), so the columns no longer repeat it.
-- Nothing is lost: every stored reason is copied; a board with no reasons reads as before.
ALTER TABLE cards ADD COLUMN rework_reason_new TEXT;
UPDATE cards SET rework_reason_new = rework_reason;
ALTER TABLE cards DROP COLUMN rework_reason;
ALTER TABLE cards RENAME COLUMN rework_reason_new TO rework_reason;

CREATE TABLE rework_history_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  at INTEGER NOT NULL,
  who TEXT
);
INSERT INTO rework_history_new (id, card_id, reason, at, who) SELECT id, card_id, reason, at, who FROM rework_history;
DROP TABLE rework_history;
ALTER TABLE rework_history_new RENAME TO rework_history;
CREATE INDEX rework_history_card ON rework_history (card_id, at);
