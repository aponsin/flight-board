-- Phase history (#C723 B3b): when each card entered and left each phase, kept by the Worker the moment the probe's evidence changes
-- a card's lit phase (and, once, by the import of the old board's steps). Nobody types a row. The old page reads it as its `steps`.
CREATE TABLE phase_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id TEXT NOT NULL,
  phase TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('start', 'end')),
  at INTEGER NOT NULL,
  who TEXT,
  source TEXT NOT NULL CHECK (source IN ('evidence', 'import')),
  UNIQUE (card_id, phase, kind, at)
);
CREATE INDEX phase_history_card ON phase_history (card_id, at);
