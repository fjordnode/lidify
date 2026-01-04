-- Add discNo column to Track table for multi-disc album support
ALTER TABLE "Track" ADD COLUMN "discNo" INTEGER NOT NULL DEFAULT 1;
