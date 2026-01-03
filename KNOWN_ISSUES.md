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
