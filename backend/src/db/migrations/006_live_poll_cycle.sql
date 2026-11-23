-- Persist the active scan and its single selection so an interrupted scan can resume safely.
CREATE TABLE live_poll_cycles (
  mode TEXT PRIMARY KEY CHECK (mode IN ('authorized-direct', 'licensed-feed')),
  monitoring_from TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  result TEXT CHECK (result IN ('success', 'partial')),
  new_candidates INTEGER NOT NULL DEFAULT 0 CHECK (new_candidates >= 0),
  selected_target_id TEXT REFERENCES download_targets(id)
) STRICT;

CREATE INDEX download_targets_url ON download_targets (url);
