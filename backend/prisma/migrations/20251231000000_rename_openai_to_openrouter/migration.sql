-- Rename OpenAI columns to OpenRouter
-- This migration:
-- 1. Adds new openrouter* columns
-- 2. Copies data from old openai* columns
-- 3. Drops the old columns

-- Add new columns with defaults
ALTER TABLE "SystemSettings" ADD COLUMN IF NOT EXISTS "openrouterEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "SystemSettings" ADD COLUMN IF NOT EXISTS "openrouterModel" TEXT DEFAULT 'openai/gpt-4o-mini';

-- Copy data from old columns (if they exist)
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='SystemSettings' AND column_name='openaiEnabled') THEN
        UPDATE "SystemSettings" SET "openrouterEnabled" = "openaiEnabled";
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='SystemSettings' AND column_name='openaiModel') THEN
        UPDATE "SystemSettings" SET "openrouterModel" = "openaiModel" WHERE "openaiModel" IS NOT NULL;
    END IF;
END $$;

-- Drop old columns (if they exist)
ALTER TABLE "SystemSettings" DROP COLUMN IF EXISTS "openaiEnabled";
ALTER TABLE "SystemSettings" DROP COLUMN IF EXISTS "openaiApiKey";
ALTER TABLE "SystemSettings" DROP COLUMN IF EXISTS "openaiModel";
ALTER TABLE "SystemSettings" DROP COLUMN IF EXISTS "openaiBaseUrl";
