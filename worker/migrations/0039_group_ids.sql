-- group-ids (#C1299): the store mints a number for each group, like #C and #T numbers ("#G12 board-polish"), and holds a name the owner can change.
-- `batch` stays the group's identity (the slug on every card); this table only adds the number and the name. A single card's place in the owner's one
-- order list is a row of group_order keyed "c:<card id>", so no change to that table. Additive: nothing reads this table to decide a card's group.
-- The number is minted by the store in the one statement that inserts the row (the highest number plus one; the UNIQUE on num refuses a second writer's
-- duplicate), not from `counters`, whose CHECK allows only C and T.
-- Backfill: every batch that any card has gets a number, oldest first. Undo (the Worker rollback is enough; the old Worker ignores the table):
--   DROP TABLE groups;
CREATE TABLE IF NOT EXISTS groups (
  batch TEXT PRIMARY KEY,
  num INTEGER NOT NULL UNIQUE,
  name TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
INSERT OR IGNORE INTO groups (batch, num, name, created_by, created_at)
  SELECT batch, ROW_NUMBER() OVER (ORDER BY MIN(created_at), batch), NULL, 'store', MIN(created_at)
  FROM cards WHERE batch IS NOT NULL AND TRIM(batch) <> '' GROUP BY batch;
