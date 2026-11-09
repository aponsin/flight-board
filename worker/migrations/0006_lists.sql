-- The owner's two lists (#C719, his pick on 2026-11-09): To-do (his long-term list) and Ideas (the product backlog). Rows are
-- carried over from the old board as they are: text, area, an optional category (the old `kind`), a note, a rank, done. Nothing
-- here has a trigger or an ETA; a to-do is not a Later ask.
CREATE TABLE lists (
  id TEXT PRIMARY KEY CHECK (id GLOB '[a-z0-9]*' AND length(id) <= 64),
  kind TEXT NOT NULL CHECK (kind IN ('todo', 'idea')),
  text TEXT NOT NULL,
  area TEXT,
  category TEXT,
  note TEXT,
  rank INTEGER,
  done INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0, 1)),
  done_at INTEGER,
  added_at INTEGER NOT NULL
);
CREATE INDEX lists_kind ON lists (kind, done, rank);
