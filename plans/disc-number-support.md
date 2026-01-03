# Disc Number Support

## Problem

Multi-disc albums (e.g., deluxe editions, box sets) display duplicate track names because Lidify doesn't track or display disc numbers. Example: Royal Edition of "Crack the Skye" has Disc 1 (original) and Disc 2 (instrumental) with identical track names.

## Current State

- `Track` model has `trackNo` but no `discNo`
- Scanner doesn't read disc metadata from audio files
- UI shows flat track list with no disc grouping

## Implementation Plan

### 1. Schema Migration

**File:** `backend/prisma/schema.prisma`

```prisma
model Track {
  // ... existing fields
  trackNo      Int
  discNo       Int      @default(1)  // NEW
  // ...
}
```

**Migration:**
```bash
npx prisma migrate dev --name add_disc_number
```

### 2. Scanner Update

**File:** `backend/src/services/musicScanner.ts`

Read disc number from audio metadata during scan:

```typescript
// In parseAudioMetadata or similar function
const discNo = metadata.common.disk?.no || 1;

// When creating/updating Track
await prisma.track.upsert({
  // ...
  discNo,
  trackNo,
  // ...
});
```

FLAC/MP3 metadata fields:
- FLAC: `DISCNUMBER` tag
- MP3: ID3v2 `TPOS` frame
- music-metadata library: `metadata.common.disk.no`

### 3. Backend API Update

**File:** `backend/src/routes/library.ts`

Include `discNo` in track queries and order by `discNo, trackNo`:

```typescript
const tracks = await prisma.track.findMany({
  where: { albumId },
  orderBy: [
    { discNo: 'asc' },
    { trackNo: 'asc' }
  ],
  select: {
    // ... include discNo
  }
});
```

### 4. Frontend UI Update

**File:** `frontend/app/album/[id]/page.tsx` (or similar)

Option A: **Disc Headers**
```tsx
{discs.map(discNo => (
  <div key={discNo}>
    {totalDiscs > 1 && <h3>Disc {discNo}</h3>}
    {tracks.filter(t => t.discNo === discNo).map(track => (
      <TrackRow track={track} />
    ))}
  </div>
))}
```

Option B: **Track Number Prefix**
Display as "1-01", "1-02", "2-01", "2-02" when multiple discs exist.

### 5. Subsonic API Update

**File:** `backend/src/routes/subsonic.ts`

Include `discNumber` in track responses for Subsonic clients:

```xml
<song discNumber="1" track="1" ... />
<song discNumber="2" track="1" ... />
```

## Testing

1. Import multi-disc album (Royal Edition, box set, etc.)
2. Verify disc numbers read correctly from metadata
3. Verify UI displays disc grouping
4. Verify track ordering: Disc 1 tracks, then Disc 2 tracks
5. Verify Subsonic clients show correct disc info

## Files to Modify

| File | Change |
|------|--------|
| `backend/prisma/schema.prisma` | Add `discNo` field |
| `backend/src/services/musicScanner.ts` | Read disc from metadata |
| `backend/src/routes/library.ts` | Include discNo, order by disc+track |
| `backend/src/routes/subsonic.ts` | Add discNumber to responses |
| `frontend/app/album/[id]/page.tsx` | Display disc grouping |
| `frontend/features/album/components/TrackList.tsx` | Render disc headers |

## Priority

Medium - Affects multi-disc album display but has workarounds (manual renaming).

## Estimated Effort

- Schema + migration: 10 min
- Scanner update: 20 min
- Backend API: 15 min
- Frontend UI: 30 min
- Testing: 20 min

**Total: ~1.5 hours**
