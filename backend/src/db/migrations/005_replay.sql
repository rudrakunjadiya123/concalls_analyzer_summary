-- A local CLI can request a replay without competing for the background watcher's lease.
CREATE TABLE fixture_replays (
  variant TEXT PRIMARY KEY CHECK (variant IN ('replay','correction')),
  requested_at TEXT NOT NULL,
  discovered_at TEXT
) STRICT;
