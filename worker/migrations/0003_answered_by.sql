-- Who answered an ask (Security, #C719): only the owner can, and the row says so, so Manager's inbox can never carry an
-- agent's answer as the owner's.
ALTER TABLE asks ADD COLUMN answered_by TEXT;
