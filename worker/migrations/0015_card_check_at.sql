-- The done-test hold (#C731 B4b, board parity stage B, Designer's gap 1): cards.check_at, the time (ms) a card that is live on the
-- evidence is to be checked for its done test. A card with a check_at is held: the page does not close it for the owner ("Live,
-- still open" instead of Done) until the lead closes it. Nullable and additive: a card written before has none.
ALTER TABLE cards ADD COLUMN check_at INTEGER;
