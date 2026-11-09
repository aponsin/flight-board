-- Who closed an ask (#C719, Checker on v10): the owner, the agent that asked it, or the one-time import for an ask the old board had
-- already resolved. NULL on an ask that is still open.
ALTER TABLE asks ADD COLUMN closed_by TEXT;
