-- Disambiguate identical relative paths across the main music library and download storage.
ALTER TABLE "Track" ADD COLUMN "fileStorage" TEXT NOT NULL DEFAULT 'music';

-- Existing playlist imports live under the download mount even though their paths are relative.
UPDATE "Track"
SET "fileStorage" = 'download'
WHERE "filePath" LIKE 'Playlists/%'
   OR "filePath" LIKE 'soulseek-downloads/Playlists/%';

ALTER TABLE "Track" DROP CONSTRAINT IF EXISTS "Track_filePath_key";
CREATE UNIQUE INDEX "Track_fileStorage_filePath_key" ON "Track"("fileStorage", "filePath");
CREATE INDEX "Track_fileStorage_idx" ON "Track"("fileStorage");
