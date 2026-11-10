-- The step tool (board parity, after B4b): an agent writes a step of its own, with the old step log's wait column. phase_history gets
-- `wait` (busy: waiting behind other work; gate: held by an open ask; decision: waiting on a decision) and its rows may come from the
-- tool (source 'tool'). SQLite cannot widen a CHECK, so the table is rebuilt; every row is copied as it is. The unique key now holds the
-- wait, so a wait step and a work step at the same second are two rows. Additive for the readers: old code ignores the new column.
CREATE TABLE phase_history_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id TEXT NOT NULL,
  phase TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('start', 'end')),
  at INTEGER NOT NULL,
  who TEXT,
  source TEXT NOT NULL CHECK (source IN ('evidence', 'import', 'tool')),
  wait TEXT CHECK (wait IS NULL OR wait IN ('busy', 'gate', 'decision'))
);
INSERT INTO phase_history_new (id, card_id, phase, kind, at, who, source) SELECT id, card_id, phase, kind, at, who, source FROM phase_history;
DROP TABLE phase_history;
ALTER TABLE phase_history_new RENAME TO phase_history;
CREATE UNIQUE INDEX phase_history_key ON phase_history (card_id, phase, kind, at, IFNULL(wait, ''));
CREATE INDEX phase_history_card ON phase_history (card_id, at);
