-- #C936: an agent's message (a decision posted in the owner's thread, #C920) can carry screenshots, as an ask does: a JSON list of
-- "<file id>", "<file id> label" or "<file id> A: label" (A to D: the option the picture sits beside). Null: no pictures, as before.
ALTER TABLE messages ADD COLUMN screenshots TEXT;
