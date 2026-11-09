-- Done cards of the old board, kept only so the old page's medians and its Done list are not blank on day one (#C723 B3b, Manager's
-- word). Written once by the import, never by a tool; they are not cards of the store (no number is minted, no rule applies to them).
-- Their steps are phase_history rows with source 'import'.
CREATE TABLE history_cards (
  id TEXT PRIMARY KEY,
  num INTEGER,
  title TEXT NOT NULL,
  size TEXT CHECK (size IN ('XS', 'S', 'M', 'L', 'XL')),
  review_level TEXT CHECK (review_level IN ('None', 'Quick', 'Full')),
  created_at INTEGER,
  done_at INTEGER NOT NULL
);
