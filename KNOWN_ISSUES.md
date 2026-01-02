# Lidify Known Issues

## Discovery Album Blocking Library Import

**Status:** Open
**Discovered:** 2026-01-02

### Problem

When an artist has a `DiscoveryAlbum` entry (even with status `DELETED`), the scanner treats them as a "discovery-only artist" and skips importing their files from the library.

### Symptoms

- Artist folder exists with audio files
- Scanner finds the files (verified with manual test)
- Scanner logs show: `[Scanner] Artist "X" is a discovery-only artist`
- Albums are not added to library

### Root Cause

In `musicScanner.ts`, the scanner checks for `DiscoveryAlbum` entries and skips import if found. It doesn't distinguish between active discovery entries and deleted ones.

### Workaround

Delete the blocking discovery entry:
```sql
DELETE FROM "DiscoveryAlbum" WHERE "artistName" ILIKE '%Artist Name%';
```

Then rescan the library.

### Proper Fix

The scanner should either:
1. Only check for discovery entries with `status = 'ACTIVE'` or similar
2. Not skip import when the artist has actual files on disk
3. Delete stale discovery entries during cleanup

**Files to investigate:**
- `backend/src/services/musicScanner.ts` - Look for discovery check logic

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
