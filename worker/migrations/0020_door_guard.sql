-- store-manager-door-guard (#C827): only Manager's session may take Manager's wake batch through Manager's door. door_session holds the one
-- expected session id (a single row, written by Manager or the owner); inbox_takes logs every read_inbox: the time, the session the call
-- claimed, whether it was taken, and why not. Additive: nothing dropped or rewritten. With no row, read_inbox still works (and is logged as unguarded).
CREATE TABLE door_session (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  session TEXT NOT NULL,
  set_by TEXT NOT NULL,
  set_at INTEGER NOT NULL
);
CREATE TABLE inbox_takes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  claimed TEXT,
  ok INTEGER NOT NULL,
  reason TEXT NOT NULL,
  noticed_at INTEGER -- a "door session replaced" row: when Manager's next read told him (null: not yet)
);
