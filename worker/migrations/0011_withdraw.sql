-- The owner's Withdraw of an approval (#C727, parity C4): the answer is cleared (so the pull request needs his Approve again) and
-- the last withdraw is kept here, so the record says it once stood.
ALTER TABLE asks ADD COLUMN withdrawn_at INTEGER;
ALTER TABLE asks ADD COLUMN withdrawn_by TEXT;
