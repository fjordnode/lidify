# Fix Split Multi-Disc Albums

## Problem Summary

Multi-disc albums are being split into separate album entries in Lidify because:
1. **Incorrect file metadata** - Album tags include disc identifiers (e.g., "Album (Disc 1)", "CD2 - Album")
2. **Missing/wrong disc numbers** - DISCNUMBER tag is missing or set to 1 for all discs
3. **Inconsistent tagging** - Different discs have different album name formats

## Scanner Fix (Already Applied)

The scanner now strips both disc **prefixes** and **suffixes** from album names:
- Suffixes: `(Disc 1)`, `[CD 2]`, `- Disc 1`, etc.
- Prefixes: `CD1 - `, `Disc 2: `, etc.

See: `backend/src/services/musicScanner.ts` - `stripDiscSuffix()` method

## Finding Problematic Albums

```sql
-- Run inside lidify container:
docker exec lidify psql -U lidify -d lidify -c "
SELECT a.title, ar.name as artist, a.id,
       (SELECT COUNT(*) FROM \"Track\" t WHERE t.\"albumId\" = a.id) as tracks
FROM \"Album\" a
JOIN \"Artist\" ar ON a.\"artistId\" = ar.id
WHERE a.title ~* '(disc|cd)\s*\d+'
   OR a.title ~* '^(disc|cd)\s*\d+\s*[-:]'
ORDER BY ar.name, a.title;"
```

## Current Problematic Albums (as of 2026-01-04)

| Artist | Album Title | Issue |
|--------|-------------|-------|
| Aretha Franklin | Aretha - Live At Fillmore West [MFSL MFCD 820] | Contains "MFCD" (false positive?) |
| Black Francis | The Golem (disc 2) | Missing disc 1? |
| Black Sabbath | Born Again (2011 Deluxe Edition) (Disc2) | Split disc |
| Bob Dylan | The Basement Tapes Complete (DIsc 01-06) | 6 discs split |
| Bruce Springsteen | The River (Disc 1/2) | Split into 2 albums |
| Chet Baker | The SESJUN Radio Shows (CD 1/2) | Split into 2 albums |
| Derek | Layla and Other Assorted Love Songs (Disc 1/2) | Split into 2 albums |
| Ennio Morricone | A Fistful of Film Music (Disc 1/2) | Split into 2 albums |
| Frank Sinatra | The Very Best Of (Disc 1/2) | Split into 2 albums |
| Grateful Dead | Reckoning (CD1/CD2) | Split into 2 albums |
| Infected Mushroom | Converting Vegetarians [CD 1/2] | Split into 2 albums |
| Jeff Buckley | Sketches for My Sweetheart The Drunk (Disc 1) | Missing disc 2? |
| Jethro Tull | Aqualung 40th Anniversary (Disc 1/2) | Split into 2 albums |
| Killer Mike | I Pledge Allegiance to the Grind [CD 1] | Missing disc 2? |
| Led Zeppelin | Physical Graffiti (DISC 1/2) | Split into 2 albums |
| Metallica | Garage Inc. [CD 1] / Metallica - Garage Inc (cd2) | Different album tags! |
| Pink Floyd | The Wall (Disc 1/2) | Split into 2 albums |
| Radiohead | In Rainbows (Disc 1/2) | Split into 2 albums |
| Rammstein | Liebe ist fur alle da (CD2) | Missing disc 1? |
| Sepultura | Live In Japan 2018 (CD1/CD2), Roorback (Disc 1/2) | Multiple split albums |
| Sivert Hoyem | Moon Landing (Limited Edition) (CD2) | Missing disc 1? |
| Sólstafir | Svartir Sandar (CD 1/2) | Split into 2 albums |
| The Heavy Pets | Whale (Disc 1) | Missing disc 2? |
| The Rolling Stones | Some Girls Deluxe Edition (Disc 1) | Missing disc 2? |

## Fix Options

### Option 1: Fix with Beets (Recommended)

```bash
# For each problematic album, re-import with Beets
# Example for Metallica Garage Inc:

# Remove from beets library first
beet remove "Garage Inc"

# Import both disc folders together
beet import "/mnt/user/media/music/main_music_from_gecko/Metallica/Garage Inc. [CD 1]" \
             "/mnt/user/media/music/main_music_from_gecko/Metallica/Metallica - Garage Inc (cd2)"
```

### Option 2: Manual Tag Fix

```bash
# Fix album tag and disc number directly
cd "/path/to/album/disc2"
mid3v2 --album="Album Name" --TPOS="2/2" *.flac
```

### Option 3: Database Merge (Quick Fix)

```sql
-- Example: Merge disc 2 into disc 1
BEGIN;

-- Move tracks and set correct disc number
UPDATE "Track"
SET "albumId" = '<disc1_album_id>', "discNo" = 2
WHERE "albumId" = '<disc2_album_id>';

-- Rename album to remove disc suffix
UPDATE "Album"
SET title = 'Clean Album Name'
WHERE id = '<disc1_album_id>';

-- Delete empty disc 2 album
DELETE FROM "OwnedAlbum" WHERE "rgMbid" = '<disc2_rgMbid>';
DELETE FROM "Album" WHERE id = '<disc2_album_id>';

COMMIT;
```

## Already Fixed

- [x] Zucchero - Black Cat (Disc 1/2) - Merged in database
- [x] Crippled Black Phoenix - (Mankind) The Crafty Ape (CD1/CD2) - Merged in database

## Music Library Path

```
/mnt/user/media/music/main_music_from_gecko/
```

Mounted in Lidify container as `/music/`

## After Fixing Tags

After fixing file tags with Beets, trigger a rescan in Lidify:
1. Go to Settings > Library
2. Click "Scan Library"

Or via API:
```bash
curl -X POST https://lidify.denshi.dev/api/library/scan
```
