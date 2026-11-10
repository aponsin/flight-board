-- #C732 (Stalled widens to every phase, the owner's pick A on #T1681): a card that waits 15 minutes at a phase while that phase's agent is idle
-- wakes Manager once with the reason, and again only when the reason changes. One row per (card, reason): created when the store's
-- "anything for Manager?" answer first finds the stall, taken (taken_at) when Manager reads it or when the stall is over. Additive: nothing
-- dropped or rewritten.
CREATE TABLE stall_wakes (
  card_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  taken_at INTEGER,
  PRIMARY KEY (card_id, reason)
);
CREATE INDEX stall_wakes_untaken ON stall_wakes (taken_at) WHERE taken_at IS NULL;
