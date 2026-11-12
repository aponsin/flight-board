-- #C1036: a card's holds clear when its commit lands on main. The words cleared are kept here, one row per clearing, so nothing is lost.
CREATE TABLE hold_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  waiting_on TEXT,
  blocked_reason TEXT,
  hold_end TEXT,
  check_at INTEGER
);
CREATE INDEX hold_history_card ON hold_history (card_id, at);
