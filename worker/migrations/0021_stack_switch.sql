-- stack-switch (#C859, slice 1): one stack switch per repository, in the store. stack = 1: the repository's open cards are built, reviewed, landed and
-- deployed as one stack; 0: each card on its own (today). Only the owner writes it (the Worker refuses every other writer); the store records
-- who and when. A repository with no row reads as off. The key is the repository's name in the board config (flight-board is the board's own); the team's
-- own repository, which has no name there, is `product`. The board repository is on and the product repository off, as the owner agreed.
-- Additive: nothing dropped or rewritten.
CREATE TABLE stack_switch (
  repo TEXT PRIMARY KEY,
  stack INTEGER NOT NULL CHECK (stack IN (0, 1)),
  set_by TEXT NOT NULL,
  set_at INTEGER NOT NULL
);
INSERT INTO stack_switch (repo, stack, set_by, set_at) VALUES ('flight-board', 1, 'default', 0);
INSERT INTO stack_switch (repo, stack, set_by, set_at) VALUES ('product', 0, 'default', 0);
