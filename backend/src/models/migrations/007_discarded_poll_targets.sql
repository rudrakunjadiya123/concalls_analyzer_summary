-- Preserve a private deduplication record for automatic candidates that were not selected.
ALTER TABLE download_targets ADD COLUMN discarded INTEGER NOT NULL DEFAULT 0 CHECK (discarded IN (0, 1));
UPDATE download_targets SET discarded = 1
WHERE NOT EXISTS (SELECT 1 FROM processing_jobs j WHERE j.entity_id = download_targets.id AND j.step = 'download');
