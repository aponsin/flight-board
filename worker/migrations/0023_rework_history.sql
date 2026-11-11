-- The reason history of a card's rework (#C875). A card's rework_reason column holds the latest reason only; each time a reason is attached
-- the store also keeps a row here, so the card shows every rework it went through and why. Additive: nothing reads it but the view.
CREATE TABLE rework_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('bug found in test', 'review findings', 'design change', 'security finding', 'owner change')),
  at INTEGER NOT NULL,
  who TEXT
);
CREATE INDEX rework_history_card ON rework_history (card_id, at);
