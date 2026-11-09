-- Files and screenshots (#C726 C1, board parity): the old page's attachments, now behind the Worker. The bytes live in R2
-- (binding FILES, key = the file's id); this table is the list of what is stored. A file is never changed: a new upload is a
-- new id. Nothing here is typed by an agent beyond the upload itself.
CREATE TABLE files (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 16 AND 64),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  type TEXT NOT NULL CHECK (type IN ('image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf', 'text/plain', 'text/markdown', 'text/csv', 'application/json')),
  size INTEGER NOT NULL CHECK (size > 0 AND size <= 15728640),
  sha256 TEXT NOT NULL,
  added_by TEXT NOT NULL,
  added_at INTEGER NOT NULL
);

-- Which answer or message a file was sent with (the old page's response.files and message.assets), in the order it was sent.
-- An ask's screenshots stay in the ask's own body (a list of file ids); they are not links.
CREATE TABLE file_links (
  file_id TEXT NOT NULL REFERENCES files (id),
  ref_kind TEXT NOT NULL CHECK (ref_kind IN ('answer', 'message')),
  ref_id TEXT NOT NULL,
  pos INTEGER NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (ref_kind, ref_id, file_id)
);
