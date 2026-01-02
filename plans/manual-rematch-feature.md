# Manual Re-Match Feature Plan

## Overview

Add the ability for users to manually search and select the correct artist/album match from external sources (MusicBrainz, Deezer) when automatic matching fails or is incorrect.

## Current Infrastructure (Already Exists)

| Component | Location | Status |
|-----------|----------|--------|
| MusicBrainz search API | `backend/src/services/musicbrainz.ts` | ✅ |
| Last.fm lookup | `backend/src/services/lastfm.ts` | ✅ |
| Deezer search | `backend/src/services/deezer.ts` | ✅ |
| Temp MBID detection | `mbid.startsWith("temp-")` | ✅ |
| Manual metadata edit | `PUT /enrichment/artists/:id/metadata` | ✅ |
| Confidence scoring | `enrichmentService.ts` | ✅ |
| Rate limiting & caching | Redis-based | ✅ |

## Implementation Plan

### Phase 1: Backend Endpoints

#### 1.1 Search Candidates Endpoints

**GET `/api/enrichment/artist/:id/search-candidates`**

```typescript
// Query params: ?query=override+search (optional)
// Returns top 5 candidates from MusicBrainz

interface ArtistCandidate {
  mbid: string;
  name: string;
  type: string;           // "Person" | "Group" | "Orchestra" etc.
  disambiguation: string; // "American rock band" etc.
  country?: string;
  beginYear?: number;
  score: number;          // MusicBrainz relevance score
}

// Response
{
  currentArtist: { id, name, mbid, isTemp },
  candidates: ArtistCandidate[]
}
```

**GET `/api/enrichment/album/:id/search-candidates`**

```typescript
interface AlbumCandidate {
  rgMbid: string;         // Release Group MBID
  title: string;
  artistName: string;
  artistMbid: string;
  year?: number;
  type: string;           // "Album" | "EP" | "Single" etc.
  coverUrl?: string;      // From Cover Art Archive or Deezer
  score: number;
}

// Response
{
  currentAlbum: { id, title, rgMbid, isTemp, artistName },
  candidates: AlbumCandidate[]
}
```

#### 1.2 Confirm Match Endpoints

**POST `/api/enrichment/artist/:id/confirm-match`**

```typescript
// Body
{ mbid: string }

// Actions:
// 1. Validate MBID exists in MusicBrainz
// 2. Update artist.mbid in database
// 3. Clear old cached data
// 4. Trigger full enrichment (bio, image, genres, similar artists)
// 5. Optionally re-match albums using new artist MBID

// Response
{
  success: boolean,
  artist: { id, name, mbid, heroUrl, genres },
  albumsUpdated: number  // Albums that got better matches
}
```

**POST `/api/enrichment/album/:id/confirm-match`**

```typescript
// Body
{ rgMbid: string }

// Actions:
// 1. Validate Release Group MBID exists
// 2. Update album.rgMbid in database
// 3. Fetch cover from Cover Art Archive (or Deezer fallback)
// 4. Update year, label, type from MusicBrainz
// 5. Fetch genres from Last.fm

// Response
{
  success: boolean,
  album: { id, title, rgMbid, coverUrl, year, genres }
}
```

#### 1.3 File Locations

```
backend/src/routes/enrichment.ts     # Add new endpoints
backend/src/services/enrichment.ts   # Add search/confirm logic
```

### Phase 2: Frontend UI

#### 2.1 Re-Match Button

Add to artist page (`frontend/app/artist/[id]/page.tsx`):
- Small "Re-match" button near artist name (icon: RefreshCw or Search)
- Only show if user is admin OR artist has temp MBID
- Opens modal on click

Add to album page (`frontend/app/album/[id]/page.tsx`):
- Same pattern

#### 2.2 Search Modal Component

```
frontend/components/RematchModal.tsx
```

**Layout:**
```
┌─────────────────────────────────────────────────┐
│  Re-match Artist                            [X] │
├─────────────────────────────────────────────────┤
│  Current: "The Weekend" (no MBID)               │
│                                                 │
│  Search: [The Weeknd____________] [Search]      │
│                                                 │
│  ┌─────────────────────────────────────────┐   │
│  │ ○ The Weeknd                            │   │
│  │   Canadian R&B singer (b. 1990)         │   │
│  │   MBID: c8b03190-306c-4120-...          │   │
│  ├─────────────────────────────────────────┤   │
│  │ ○ The Weekend (Australian band)         │   │
│  │   Rock band from Sydney                 │   │
│  │   MBID: a1b2c3d4-...                    │   │
│  ├─────────────────────────────────────────┤   │
│  │ ○ Weekend                               │   │
│  │   American punk band                    │   │
│  │   MBID: e5f6g7h8-...                    │   │
│  └─────────────────────────────────────────┘   │
│                                                 │
│  [Cancel]                      [Confirm Match]  │
└─────────────────────────────────────────────────┘
```

**For albums, include:**
- Cover art preview (if available from CAA/Deezer)
- Release year
- Album type (Album/EP/Single)

#### 2.3 State Management

```typescript
// frontend/lib/api.ts additions
async getArtistSearchCandidates(id: string, query?: string): Promise<SearchCandidatesResponse>
async getAlbumSearchCandidates(id: string, query?: string): Promise<SearchCandidatesResponse>
async confirmArtistMatch(id: string, mbid: string): Promise<ConfirmMatchResponse>
async confirmAlbumMatch(id: string, rgMbid: string): Promise<ConfirmMatchResponse>
```

### Phase 3: Edge Cases & Polish

#### 3.1 Error Handling

- MusicBrainz rate limit hit → Show "Try again in X seconds"
- No candidates found → Allow manual MBID entry
- Network error → Retry button
- Invalid MBID submitted → Validation error

#### 3.2 Cascade Updates

When artist MBID is confirmed:
1. Re-check all albums for this artist
2. Query MusicBrainz for artist's release groups
3. Match existing albums by normalized title
4. Update album MBIDs where matches found
5. Show user: "Updated 5 albums with better metadata"

#### 3.3 Audit Trail (Optional)

```typescript
// Track manual overrides for debugging
model MetadataOverride {
  id        String   @id @default(cuid())
  entityType String  // "artist" | "album"
  entityId  String
  oldMbid   String?
  newMbid   String
  userId    String
  createdAt DateTime @default(now())
}
```

### Phase 4: Bulk Operations (Future)

#### 4.1 Unmatched Items View

New settings page section or standalone page:
- List all artists/albums with temp MBIDs
- Bulk search & match interface
- "Auto-fix high confidence" button (>0.9 score)

#### 4.2 Import from External

- Paste MusicBrainz URL → Extract MBID → Apply
- Paste Deezer artist URL → Search MB by Deezer ID

## Estimated Timeline

| Task | Estimate |
|------|----------|
| Backend: Search endpoints | 1 hour |
| Backend: Confirm endpoints | 1 hour |
| Frontend: RematchModal component | 2 hours |
| Frontend: Integration with artist/album pages | 1 hour |
| Testing & edge cases | 1-2 hours |
| **Total Phase 1-2** | **6-8 hours** |
| Phase 3 (polish) | 2-3 hours |
| Phase 4 (bulk) | 4-6 hours |

## Technical Notes

### MusicBrainz Search

```typescript
// Existing method in musicbrainz.ts
async searchArtist(query: string, limit = 5): Promise<MBArtist[]>

// Returns disambiguation which is key for user selection
// e.g., "The Weeknd" returns:
// - "The Weeknd" (Canadian singer, songwriter, and record producer)
// - "The Weekend" (Australian alternative rock band)
```

### Deezer as Fallback

```typescript
// Existing method in deezer.ts
async searchArtist(query: string): Promise<DeezerArtist | null>
async searchAlbum(title: string, artistName: string): Promise<DeezerAlbum | null>

// Deezer has better cover art but no MBIDs
// Use for image preview, then map to MusicBrainz
```

### Rate Limiting

MusicBrainz: 1 request/second (already handled by service)
- Search candidates: 1 request
- Confirm match: 1-2 requests (validate + fetch details)
- Album cascade: N requests (batch with delays)

## Open Questions

1. **Who can re-match?**
   - Any user? Only admins? Only for items with temp MBIDs?

2. **Should we show Deezer candidates alongside MusicBrainz?**
   - Pro: Better cover previews
   - Con: No MBIDs, would need to cross-reference

3. **Auto-cascade album fixes when artist is corrected?**
   - Pro: Fixes many issues at once
   - Con: Could take time, might want user confirmation

4. **Store override history?**
   - Pro: Can audit/revert mistakes
   - Con: Extra complexity

## Files to Create/Modify

### New Files
- `frontend/components/RematchModal.tsx`
- `frontend/components/RematchModal.types.ts` (optional)

### Modified Files
- `backend/src/routes/enrichment.ts` - Add 4 new endpoints
- `backend/src/services/enrichment.ts` - Add search/confirm logic
- `frontend/lib/api.ts` - Add API methods
- `frontend/app/artist/[id]/page.tsx` - Add re-match button
- `frontend/app/album/[id]/page.tsx` - Add re-match button
