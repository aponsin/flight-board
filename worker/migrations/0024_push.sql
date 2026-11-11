-- #C904 (the owner's pick B on #T1793): the board pushes to the owner's phone itself (Web Push). Additive: nothing dropped or rewritten.
-- A subscription is the browser's push address and its two public keys (never a secret of ours); the owner adds and removes them from
-- the page. push_sent holds each ask and each ship once pushed, so nothing is pushed twice. push_state is the last cron run, for the page.
CREATE TABLE push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  ok_at INTEGER,
  fail_at INTEGER,
  fails INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE push_sent (
  kind TEXT NOT NULL CHECK (kind IN ('ask', 'ship')),
  ref TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (kind, ref)
);
CREATE TABLE push_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  run_at INTEGER NOT NULL DEFAULT 0,
  sent_at INTEGER,
  result TEXT
);
INSERT INTO push_state (id) VALUES (1);
