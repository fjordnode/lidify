-- Add createdAt field to Artist table
ALTER TABLE "Artist" ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Set existing artists' createdAt to their lastSynced value (best approximation of when they were added)
UPDATE "Artist" SET "createdAt" = "lastSynced";

-- Add createdAt field to Album table
ALTER TABLE "Album" ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Set existing albums' createdAt to their lastSynced value (best approximation of when they were added)
UPDATE "Album" SET "createdAt" = "lastSynced";
