-- ship-row-install-wait (#C976, Manager's A, 2026-11-11: the install time is to be measured later, so it is stored). A board card on main and
-- not yet deployed waits on the owner's install; the store writes that wait as its own row of the phase history (phase ship, wait 'install')
-- beside the probe's ship row, and closes it when the card leaves that state. SQLite cannot widen a CHECK, so the table is rebuilt as 0018
-- did; every row is copied as it is, wait included. No backfill: the rows written before this keep their empty wait.
CREATE TABLE phase_history_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id TEXT NOT NULL,
  phase TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('start', 'end')),
  at INTEGER NOT NULL,
  who TEXT,
  source TEXT NOT NULL CHECK (source IN ('evidence', 'import', 'tool')),
  wait TEXT CHECK (wait IS NULL OR wait IN ('busy', 'gate', 'decision', 'install'))
);
INSERT INTO phase_history_new (id, card_id, phase, kind, at, who, source, wait) SELECT id, card_id, phase, kind, at, who, source, wait FROM phase_history;
DROP TABLE phase_history;
ALTER TABLE phase_history_new RENAME TO phase_history;
CREATE UNIQUE INDEX phase_history_key ON phase_history (card_id, phase, kind, at, IFNULL(wait, ''));
CREATE INDEX phase_history_card ON phase_history (card_id, at);
