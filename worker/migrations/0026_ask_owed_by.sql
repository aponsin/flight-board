-- #C925: a Later ask can be Manager's own dated promise to the owner ("At 8 am MT I'll put one decision to you"). owed_by names
-- who owes it (only the lead, the asker itself); at eta_at the store wakes that role once, and the page reads it as owed to the
-- owner, not as waiting on him. Null: today's Later, which waits on the owner from its ETA.
ALTER TABLE asks ADD COLUMN owed_by TEXT;
