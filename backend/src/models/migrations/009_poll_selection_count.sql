-- Older polling cycles could queue at most one attachment. Preserve their reported count.
ALTER TABLE live_poll_cycles ADD COLUMN selected_documents INTEGER NOT NULL DEFAULT 0
  CHECK (selected_documents >= 0);
UPDATE live_poll_cycles SET selected_documents = 1 WHERE selected_target_id IS NOT NULL;
