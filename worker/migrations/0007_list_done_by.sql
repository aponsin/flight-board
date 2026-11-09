-- Who marked a To-do or Ideas row done (#C719, Checker's note on v11, Manager's word: record it, do not restrict who may mark).
-- Stamped with done_at when a row goes from not done to done, cleared when it goes back. Rows already done at import have none.
ALTER TABLE lists ADD COLUMN done_by TEXT;
