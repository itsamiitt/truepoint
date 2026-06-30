ALTER TABLE "announcements" ADD COLUMN IF NOT EXISTS "type" text DEFAULT 'general' NOT NULL;
