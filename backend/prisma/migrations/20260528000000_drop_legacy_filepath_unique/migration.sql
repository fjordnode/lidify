-- The previous migration (20260527000000_add_track_file_storage) tried to remove the
-- global unique on Track.filePath with `DROP CONSTRAINT IF EXISTS "Track_filePath_key"`.
-- Prisma `@unique` materializes as a unique INDEX, not a table CONSTRAINT, so that
-- statement was a silent no-op and the index survived. It still enforces global
-- uniqueness on filePath alone, which defeats the (fileStorage, filePath) design:
-- a download-storage track sharing a relative path with a music-storage track would
-- violate it on insert. Drop it as an index. Idempotent.
DROP INDEX IF EXISTS "Track_filePath_key";
