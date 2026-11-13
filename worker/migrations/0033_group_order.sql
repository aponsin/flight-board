-- group-order (#C1053): the owner's order of the card groups (a group is a batch id). pos 1 is the group that goes live first; the dispatch gives
-- each agent its next card from the highest group that has one for its role. Written only by the owner from the page, or by Manager's tool as the
-- fallback (groupMoveRefusal). A group with no row here is new and sorts after every placed group (by its id); a card in no group sorts after all groups.
-- Additive: a board with no rows reads as "no one ordered the groups".
CREATE TABLE IF NOT EXISTS group_order (
  batch TEXT PRIMARY KEY,
  pos INTEGER NOT NULL,
  set_by TEXT NOT NULL,
  set_at INTEGER NOT NULL
);
