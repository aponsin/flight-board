-- An ask Manager called off (#C1409): a Terminal, Action or Later ask that is no longer wanted. It stays open until the owner closes it
-- himself, but he owes nothing on it: the page draws it Outdated in red, and every reader of "waiting on the owner" skips it. The reason is
-- kept, and replaced_by is the replacement ask's num. (withdrawn_at/withdrawn_by stay the owner's Withdraw of an approval.)
ALTER TABLE asks ADD COLUMN outdated_at INTEGER;
ALTER TABLE asks ADD COLUMN outdated_by TEXT;
ALTER TABLE asks ADD COLUMN outdated_reason TEXT;
ALTER TABLE asks ADD COLUMN replaced_by INTEGER;
