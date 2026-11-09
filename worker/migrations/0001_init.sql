-- Board store (#C719, docs/DATA.md "Where things live"): one D1 database holds everything the board shows.
-- Words (cards, asks, threads, queue order, acks) are written by people and agents through the typed tools;
-- evidence and status are written only by the probe. Numbers (#C, #T) are minted by the store (counters).

CREATE TABLE counters (
  name TEXT PRIMARY KEY CHECK (name IN ('C', 'T')),
  next INTEGER NOT NULL CHECK (next >= 1)
);
INSERT INTO counters (name, next) VALUES ('C', 1), ('T', 1);

-- A card's words. status/phase live in evidence, never here (principle 1).
CREATE TABLE cards (
  id TEXT PRIMARY KEY CHECK (id GLOB '[a-z0-9]*' AND length(id) <= 64),
  num INTEGER NOT NULL UNIQUE,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  size TEXT CHECK (size IN ('XS', 'S', 'M', 'L', 'XL')),
  review_level TEXT CHECK (review_level IN ('None', 'Quick', 'Full')),
  from_thread INTEGER,
  track TEXT NOT NULL DEFAULT 'product',
  owner_role TEXT,
  next_note TEXT,
  next_note_at INTEGER,
  waiting_on TEXT,
  blocked_reason TEXT,
  paused INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1)),
  dropped INTEGER NOT NULL DEFAULT 0 CHECK (dropped IN (0, 1)),
  rework_reason TEXT CHECK (rework_reason IN ('bug found in test', 'review findings', 'design change', 'security finding', 'owner change')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- One queue column per agent; the owner's order outranks the manager's (set_by).
CREATE TABLE queue (
  role TEXT NOT NULL,
  card_id TEXT NOT NULL REFERENCES cards (id),
  position INTEGER NOT NULL CHECK (position >= 1),
  set_by TEXT NOT NULL CHECK (set_by IN ('owner', 'manager')),
  set_at INTEGER NOT NULL,
  PRIMARY KEY (role, card_id)
);

-- The eight ask types (Worker-enforced): body holds the type's required parts as JSON, checked on write.
CREATE TABLE asks (
  id TEXT PRIMARY KEY,
  num INTEGER NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK (type IN ('Decision', 'Action', 'Terminal', 'SessionStart', 'Later', 'Approval', 'Answer', 'Thread')),
  title TEXT NOT NULL,
  asked_by TEXT NOT NULL,
  card_id TEXT REFERENCES cards (id),
  body TEXT NOT NULL,
  eta_at INTEGER,
  eta_precondition TEXT,
  created_at INTEGER NOT NULL,
  answered_at INTEGER,
  answer TEXT,
  closed_at INTEGER,
  CHECK (type <> 'Later' OR eta_at IS NOT NULL)
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  delivered_at INTEGER,
  taken_batch TEXT
);
CREATE INDEX messages_thread ON messages (thread_id, created_at);
CREATE INDEX messages_undelivered ON messages (delivered_at) WHERE delivered_at IS NULL;

-- The probe's readings, one row per key (cards.<id>, agents, ctx, usage, live, board). Only the probe writes here.
CREATE TABLE evidence (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  read_at INTEGER NOT NULL
);

-- Row 4 liveness: each "anything for Manager?" ask is the heartbeat; a batch is taken when the typed read marks it.
CREATE TABLE wake (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  alive_at INTEGER NOT NULL DEFAULT 0,
  seen_at INTEGER NOT NULL DEFAULT 0,
  batch_id TEXT,
  batch_count INTEGER NOT NULL DEFAULT 0,
  printed_at INTEGER NOT NULL DEFAULT 0
);
INSERT INTO wake (id) VALUES (1);

CREATE TABLE ships (
  version TEXT PRIMARY KEY,
  cards TEXT NOT NULL,
  shipped_at INTEGER NOT NULL,
  acked_at INTEGER
);

CREATE TABLE refusals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  rule TEXT NOT NULL,
  card_id TEXT,
  who TEXT,
  detail TEXT
);

CREATE TABLE usage_days (
  day TEXT PRIMARY KEY CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  agent_minutes REAL NOT NULL DEFAULT 0,
  runner_minutes REAL NOT NULL DEFAULT 0,
  automation_minutes REAL NOT NULL DEFAULT 0,
  actions_usd REAL NOT NULL DEFAULT 0
);
