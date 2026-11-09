-- Threads and messages for the old page (#C725 B1, board parity stage B).
-- A message carries what the old page draws: a kind (ack, question, ...), whether it resolved its thread, and the options a
-- message from an agent offers. Files on a message are file_links rows (ref_kind 'message').
ALTER TABLE messages ADD COLUMN kind TEXT;
ALTER TABLE messages ADD COLUMN resolved INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN options TEXT;

-- A thread that is not an ask or a card (the owner's "new thread") has a row here with its #T number; a rename of any thread
-- (ask, card or free) keeps its title here with a null number. Nothing is deleted.
CREATE TABLE threads (
  id TEXT PRIMARY KEY,
  num INTEGER UNIQUE,
  title TEXT,
  created_at INTEGER NOT NULL
);
