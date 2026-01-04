-- Create function to update Artist search vector
CREATE OR REPLACE FUNCTION update_artist_search_vector()
RETURNS TRIGGER AS $$
BEGIN
  NEW."searchVector" := to_tsvector('simple', COALESCE(NEW.name, ''));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create function to update Album search vector
CREATE OR REPLACE FUNCTION update_album_search_vector()
RETURNS TRIGGER AS $$
BEGIN
  NEW."searchVector" := to_tsvector('simple', COALESCE(NEW.title, ''));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create function to update Track search vector
CREATE OR REPLACE FUNCTION update_track_search_vector()
RETURNS TRIGGER AS $$
BEGIN
  NEW."searchVector" := to_tsvector('simple', COALESCE(NEW.title, ''));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create triggers (drop if exists first to be idempotent)
DROP TRIGGER IF EXISTS artist_search_vector_trigger ON "Artist";
CREATE TRIGGER artist_search_vector_trigger
  BEFORE INSERT OR UPDATE OF name ON "Artist"
  FOR EACH ROW
  EXECUTE FUNCTION update_artist_search_vector();

DROP TRIGGER IF EXISTS album_search_vector_trigger ON "Album";
CREATE TRIGGER album_search_vector_trigger
  BEFORE INSERT OR UPDATE OF title ON "Album"
  FOR EACH ROW
  EXECUTE FUNCTION update_album_search_vector();

DROP TRIGGER IF EXISTS track_search_vector_trigger ON "Track";
CREATE TRIGGER track_search_vector_trigger
  BEFORE INSERT OR UPDATE OF title ON "Track"
  FOR EACH ROW
  EXECUTE FUNCTION update_track_search_vector();

-- Backfill existing data
UPDATE "Artist" SET "searchVector" = to_tsvector('simple', COALESCE(name, '')) WHERE "searchVector" IS NULL;
UPDATE "Album" SET "searchVector" = to_tsvector('simple', COALESCE(title, '')) WHERE "searchVector" IS NULL;
UPDATE "Track" SET "searchVector" = to_tsvector('simple', COALESCE(title, '')) WHERE "searchVector" IS NULL;
