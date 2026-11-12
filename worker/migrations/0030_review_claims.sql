-- review-claims (#C1018, #C1035): one checker per tip. A Checker session claims a tip (its 40-hex commit) before it reviews it; the first claim wins, and
-- another Checker session is told "<checker> has this" and does no review. A claim is released by its holder or by Manager (when that checker is gone).
-- card_id is the card the tip belongs to when the caller says so: a re-cut of the card (a new sha) keeps the claim of the checker who held the old tip.
-- Additive: nothing dropped or rewritten.
CREATE TABLE review_claims (
  sha TEXT PRIMARY KEY,
  card_id TEXT,
  checker TEXT NOT NULL,
  claimed_by TEXT NOT NULL,
  claimed_at INTEGER NOT NULL,
  released_at INTEGER,
  released_by TEXT
);
CREATE INDEX review_claims_card ON review_claims (card_id);
