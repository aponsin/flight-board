-- holds-need-an-end (#C838): a hold (waiting_on or blocked_reason) carries an end the store can check. hold_end is the id of an ask or a card whose
-- closing ends the hold (the other end is the card's check_at, a time); held_at is when the hold began (the write that set waiting_on or
-- blocked_reason), which the "no end after 2 hours" wake counts from. Additive: nothing dropped or rewritten; existing holds have both null
-- (held_at falls back to updated_at).
ALTER TABLE cards ADD COLUMN hold_end TEXT;
-- hold_until is the end the store gives a waiting_on written with no end (now + 2 h); an explicit check_at or hold_end always wins over it.
ALTER TABLE cards ADD COLUMN held_at INTEGER;
ALTER TABLE cards ADD COLUMN hold_until INTEGER;
