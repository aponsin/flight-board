-- card-groups-on-board (#C1008): the owner can pull a card out of its group (its batch). The card leaves the batch (batch = NULL) and keeps a
-- record of where it came from, who pulled it and when, so the page can tag it "pulled out of G3 · 10:05 AM by <owner>". A later write that puts the
-- card in a group again clears the record. Additive and nullable: a card written before has none, which reads as "never pulled out".
ALTER TABLE cards ADD COLUMN pulled_from TEXT;
ALTER TABLE cards ADD COLUMN pulled_by TEXT;
ALTER TABLE cards ADD COLUMN pulled_at INTEGER;
