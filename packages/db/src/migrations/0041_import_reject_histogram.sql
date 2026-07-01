ALTER TABLE "import_jobs" ADD COLUMN IF NOT EXISTS "reject_histogram" jsonb DEFAULT '{}'::jsonb NOT NULL;
