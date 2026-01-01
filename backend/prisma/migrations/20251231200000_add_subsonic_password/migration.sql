-- Add subsonicPassword field to User table for Subsonic token authentication
ALTER TABLE "User" ADD COLUMN "subsonicPassword" TEXT;
