# Lidify Known Issues

## Discovery Album Blocking Library Import

**Status:** Fixed
**Discovered:** 2026-01-02
**Fixed:** 2026-01-03 - Removed `DELETED` from discovery status check in `musicScanner.ts`

### Problem

When an artist has a `DiscoveryAlbum` entry (even with status `DELETED`), the scanner treats them as a "discovery-only artist" and skips importing their files from the library.

### Symptoms

- Artist folder exists with audio files
- Scanner finds the files (verified with manual test)
- Scanner logs show: `[Scanner] Artist "X" is a discovery-only artist`
- Albums are not added to library

### Root Cause

In `musicScanner.ts`, the scanner checks for `DiscoveryAlbum` entries and skips import if found. It doesn't distinguish between active discovery entries and deleted ones.

### Fix Applied

Changed the status check in `isDiscoveryDownload()` Pass 5 to only match `ACTIVE` and `LIKED` statuses, excluding `DELETED`:

```typescript
status: { in: ["ACTIVE", "LIKED"] },  // Don't include DELETED
```

**File changed:** `backend/src/services/musicScanner.ts:410`

---

## Artist Name Normalization Inconsistency

**Status:** Open
**Discovered:** 2026-01-02

### Problem

Artist names with special characters (e.g., "AC/DC") are sometimes normalized (to "ACDC") and sometimes not, creating duplicate artists.

### Symptoms

- Two artists exist for the same band: "AC/DC" and "ACDC"
- Albums split across both artists
- Depends on scan timing/order

### Workaround

Merge artists manually:
```sql
-- Move albums to the artist with valid MBID
UPDATE "Album" SET "artistId" = 'good_artist_id' WHERE "artistId" = 'duplicate_artist_id';

-- Delete the duplicate
DELETE FROM "Artist" WHERE id = 'duplicate_artist_id';
```

Then clear Redis: `redis-cli FLUSHALL`

### Proper Fix

Consistent normalization in scanner - always normalize or never normalize special characters.

---

## Artist Names Truncated at "&"

**Status:** Fixed
**Discovered:** 2026-01-02
**Fixed:** 2026-01-02 - Removed `&` and `,` from ambiguous split patterns in `musicScanner.ts`

### Problem

Artist names containing "&" are sometimes truncated, losing everything after the ampersand.

### Examples

| File Metadata | Stored As |
|--------------|-----------|
| Above & Beyond | Above |
| Nick Cave & the Bad Seeds | Nick Cave |
| Iron & Wine | Iron |
| Big Brother & the Holding Company | Big Brother |

### Workaround

Fix manually:
```sql
UPDATE "Artist" SET name = 'Above & Beyond' WHERE name = 'Above';
UPDATE "Artist" SET name = 'Nick Cave & the Bad Seeds' WHERE name = 'Nick Cave';
-- etc.
```

### Proper Fix

Investigate scanner's artist name parsing - likely splitting on "&" somewhere.

---

## Changing Album MBID Breaks Library Recognition

**Status:** Fixed
**Discovered:** 2026-01-02
**Fixed:** 2026-01-03 - Metadata editor now syncs `OwnedAlbum` when `rgMbid` changes

### Problem

When manually editing an album's MusicBrainz ID (rgMbid), the album stops being recognized as a library album. It shows "Download" button instead of playable tracks, even though the tracks exist and are linked.

### Root Cause

The `OwnedAlbum` table stores the original MBID to track library ownership. When the album's MBID is changed via the metadata editor, the `OwnedAlbum` entry still references the old MBID, so the album is no longer recognized as owned.

### Symptoms

- Album shows in library list
- Entering album page shows "Preview" and "Download" buttons
- Tracks exist in database but aren't displayed as playable
- `Album.location` is correctly set to `LIBRARY`

### Fix Applied

The `PUT /enrichment/albums/:id/metadata` endpoint now updates `OwnedAlbum` when `rgMbid` changes:
1. Fetches existing album to get the old MBID
2. If MBID is changing and album is in LIBRARY, updates `OwnedAlbum.rgMbid`
3. If no `OwnedAlbum` entry existed (edge case), creates one with source `metadata_edit`

**File changed:** `backend/src/routes/enrichment.ts:262-293`

---

## Last.fm Top Tracks Returns Wrong Artist

**Status:** Open
**Discovered:** 2026-01-04

### Problem

For some artists, Last.fm's API returns top tracks from a related but different artist entity. This causes "Top Songs" on artist pages to show Deezer previews for tracks the user doesn't own, even when they have hundreds of tracks by that artist.

### Example

- Artist in Lidify: "Nick Cave & the Bad Seeds" (MBID `172e1f1a-504d-4488-b053-6344ba63e6d0`)
- Last.fm returns tracks for: "Nick Cave" solo (MBID `4aae17a7-9f0c-487b-b60e-f8eafb410b1d`)
- Tracks like "I'm Your Man", "Cosmic Dancer" (Nick Cave solo covers) don't exist in Bad Seeds albums
- These appear as Deezer preview tracks instead of library tracks

### Symptoms

- Artist page shows Deezer preview icons on "Top Songs"
- Clicking plays 30-second preview instead of full library track
- User owns the artist's albums but previews still shown

### Root Cause

Last.fm merges/redirects artist queries in ways that don't match MusicBrainz artist separation. When queried with "Nick Cave & the Bad Seeds" MBID, Last.fm returns "Nick Cave" solo tracks.

**Code location:** `backend/src/routes/library.ts:1383-1447` (top tracks matching logic)

### Potential Fixes

1. **Skip unmatched tracks** - Don't show Last.fm tracks as previews if they don't match library; use more library tracks instead
2. **Fuzzy title matching** - Handle slight title variations between Last.fm and library
3. **Query by name** - Use artist name instead of MBID for Last.fm queries (may give better results for some artists)
4. **Library-first approach** - When artist has 50+ library tracks, skip Last.fm entirely

### Workaround

Clear the Redis cache for the affected artist to force re-fetch:
```bash
docker exec lidify redis-cli DEL "top-tracks:<artist_id>"
```

This may or may not help depending on Last.fm's response

---

## Scanner Merges Similar Artist Names Incorrectly

**Status:** Open
**Discovered:** 2026-01-04

### Problem

The scanner's fuzzy artist matching is too aggressive, merging distinct artists with similar names into one artist entry. This causes albums to be assigned to the wrong artist.

### Example

Files in `/music/Nick Cave/` folder with different artist tags:
- `CARNAGE` tagged as "Nick Cave & Warren Ellis" → stored under "Nick Cave & the Bad Seeds"
- `Live at Royal Albert Hall` tagged as "Nick Cave" (solo) → stored under "Nick Cave & the Bad Seeds"
- `The Good Son` tagged as "Nick Cave" (solo) → stored under "Nick Cave & the Bad Seeds"
- `Seven Psalms` tagged as "Nick Cave & Warren Ellis" → stored correctly under "Nick Cave & Warren Ellis"

### Symptoms

- Solo artist albums don't appear under the solo artist in library
- When viewing solo artist via discovery/Last.fm, shows 0 albums owned
- Albums grouped under wrong artist (usually the more popular/first-scanned variant)

### Root Cause

Scanner's artist matching logic (fuzzy matching, normalization, or MBID lookup) incorrectly identifies "Nick Cave" solo as "Nick Cave & the Bad Seeds". The matching is likely triggered by:
1. Similar normalized names (both start with "nick cave")
2. Fuzzy string matching being too lenient
3. MBID lookup returning the band instead of solo artist

**Code location:** `backend/src/services/musicScanner.ts` - artist matching logic around lines 550-665

### Potential Fixes

1. **Stricter exact matching** - Only merge artists if names match exactly (after normalization)
2. **Respect file tags** - Trust the artist tag in the file, don't fuzzy match to existing artists
3. **MBID-based separation** - If file has MBID, use it to distinguish artists
4. **"& the" pattern detection** - "Artist" and "Artist & the Band" should be treated as different artists

### Workaround

Manually create the correct artist and move albums:
```sql
-- Create solo artist
INSERT INTO "Artist" (id, mbid, name, "normalizedName")
VALUES ('manual-nick-cave-solo', '4aae17a7-9f0c-487b-b60e-f8eafb410b1d', 'Nick Cave', 'nick cave');

-- Move albums to correct artist
UPDATE "Album" SET "artistId" = 'manual-nick-cave-solo'
WHERE title IN ('The Good Son', 'Live at Royal Albert Hall')
  AND "artistId" = 'cmjou6dr10xtg11cvpod5jld9';

-- Create OwnedAlbum records
INSERT INTO "OwnedAlbum" ("rgMbid", "artistId", "source")
SELECT "rgMbid", "artistId", 'native_scan' FROM "Album" WHERE "artistId" = 'manual-nick-cave-solo';
```
