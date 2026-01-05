# Fix Album Art Loading for Artists with Many Albums

## Problem Summary

Album art fails to load consistently for artists with 50+ albums. Users see placeholder disc icons instead of cover art, especially for "discovery" artists not yet in the library.

## Root Cause Analysis

### Two Separate Artist Page Endpoints

| Endpoint | File | Cover Strategy | Rate Limited | Cached |
|----------|------|----------------|--------------|--------|
| `/library/artist/:id` | library.ts:1123 | Returns `/api/library/album-cover/:mbid` URLs for lazy loading | Yes (via endpoint) | Yes (Redis) |
| `/artists/discover/:nameOrMbid` | artists.ts:457 | **Direct CAA URLs + inline HEAD requests** | **No** | **No** |

The **discover endpoint** (artists.ts:653-699) is the problem:

```typescript
// BAD: Direct fetch without rate limiting
const response = await fetch(coverUrl, {
    method: "HEAD",
    signal: AbortSignal.timeout(2000),  // Too short
});
```

Problems:
1. **No rate limiting** — 50 albums = 50 simultaneous HEAD requests to CAA
2. **Only first 10 get Deezer fallback** — Albums 11+ stuck with potentially dead CAA URLs
3. **2 second timeout** — Too aggressive for CAA's global CDN
4. **No caching** — Every page visit re-fetches all covers
5. **Returns direct CAA URLs** — Frontend can't recover from 404s

### Why Library Endpoint Works

The library endpoint (library.ts:1127-1167) does it right:
- Returns `/api/library/album-cover/:mbid` URLs (not direct CAA URLs)
- Frontend lazy-loads covers via the endpoint
- Endpoint uses imageProviderService (Deezer → CAA → Fanart.tv chain)
- Results cached in Redis for 30 days

## Solution: Unify Both Endpoints

Make discover endpoint use the same lazy-loading pattern as library endpoint.

### Fix 1: Return Lazy-Load URLs Instead of Direct CAA URLs

**File:** `backend/src/routes/artists.ts` (lines 652-699)

**Before:**
```typescript
albums = await Promise.all(
    filteredReleaseGroups.map(async (rg: any) => {
        let coverUrl = `https://coverartarchive.org/release-group/${rg.id}/front-500`;

        const index = filteredReleaseGroups.indexOf(rg);
        if (index < 10) {
            // Try HEAD request...
        }

        return { ...rg, coverUrl };
    })
);
```

**After:**
```typescript
albums = await Promise.all(
    filteredReleaseGroups.map(async (rg: any) => {
        // Check Redis cache first
        const cacheKey = `caa:${rg.id}`;
        let coverUrl: string | null = null;

        try {
            const cached = await redisClient.get(cacheKey);
            if (cached === "NOT_FOUND") {
                coverUrl = null;
            } else if (cached) {
                coverUrl = cached;
            } else {
                // Cache miss - return lazy-load URL
                const params = new URLSearchParams({
                    artist: artistName,
                    album: rg.title,
                });
                coverUrl = `/api/library/album-cover/${rg.id}?${params}`;
            }
        } catch {
            // Redis error - return lazy-load URL
            const params = new URLSearchParams({
                artist: artistName,
                album: rg.title,
            });
            coverUrl = `/api/library/album-cover/${rg.id}?${params}`;
        }

        return {
            id: rg.id,
            rgMbid: rg.id,
            mbid: rg.id,
            title: rg.title,
            type: rg["primary-type"],
            year: rg["first-release-date"]?.substring(0, 4),
            coverUrl,
            owned: false,
        };
    })
);
```

This removes:
- All direct `fetch()` calls
- The `index < 10` limit
- The 2-second timeout

Benefits:
- Rate limiting handled by `/api/library/album-cover` endpoint
- Full Deezer → CAA → Fanart.tv fallback chain for ALL albums
- 30-day Redis caching
- Frontend already handles these URLs correctly

### Fix 2: Ensure Cover Lookup Actually Happens

The `/api/library/album-cover/:mbid` endpoint (library.ts:2322-2379) already:
- Uses `imageProviderService.getAlbumCover()` which tries Deezer → CAA → Fanart.tv
- Caches results in Redis for 30 days
- Caches "NOT_FOUND" for 24 hours

However, need to verify it's using rate limiting throughout:

**File:** `backend/src/services/imageProvider.ts`

Check that `getAlbumCoverFromMusicBrainz()` uses rate limiter:

```typescript
private async getAlbumCoverFromMusicBrainz(
    rgMbid: string,
    timeout: number
): Promise<ImageResult | null> {
    try {
        // Should use rate limiter:
        const response = await rateLimiter.execute("coverart", () =>
            axios.get(`https://coverartarchive.org/release-group/${rgMbid}`, {
                timeout,
                validateStatus: (status) => status === 200,
            })
        );
        // ...
    }
}
```

Currently it does NOT use rate limiter (line 347-353). Fix this.

### Fix 3: Increase Timeouts

**File:** `backend/src/services/imageProvider.ts`

```typescript
async getAlbumCover(..., options: ImageSearchOptions = {}): Promise<...> {
    const { timeout = 8000 } = options;  // Was 5000
    // ...
}
```

**File:** `backend/src/services/coverArt.ts`

```typescript
const response = await rateLimiter.execute("coverart", () =>
    axios.get(`${this.baseUrl}/release-group/${rgMbid}`, {
        timeout: 8000,  // Was 5000
    })
);
```

### Fix 4: Add Database Persistence for Verified Covers

Currently covers are only cached in Redis (30 days). For library albums, persist verified cover URLs to the database.

**Why:** Redis cache can be flushed. Database persistence ensures we don't re-fetch covers we've already verified.

**File:** `backend/src/routes/library.ts` (album-cover endpoint)

After successful cover fetch:
```typescript
if (coverUrl) {
    // Cache in Redis
    await redisClient.setEx(cacheKey, 30 * 24 * 60 * 60, coverUrl);

    // If this album exists in database, update coverUrl
    await prisma.album.updateMany({
        where: { rgMbid: mbid, coverUrl: null },
        data: { coverUrl },
    });

    return res.redirect(302, coverUrl);
}
```

## Implementation Order

1. **Fix imageProvider.ts rate limiting** — Ensure CAA requests go through rate limiter
2. **Fix artists.ts discover endpoint** — Replace direct fetches with lazy-load URLs
3. **Increase timeouts** — 5s → 8s
4. **Add database persistence** — Optional but recommended

## Testing

1. Find an artist with 50+ albums (e.g., The Beatles, Bob Dylan)
2. Clear Redis cache: `docker exec lidify /usr/bin/redis-cli FLUSHALL`
3. Visit artist discover page
4. Verify:
   - No console errors about rate limiting
   - Covers load progressively (not all at once)
   - Reloading page uses cached covers instantly
   - Albums 11+ also get covers (not just first 10)

## Files to Modify

| File | Change |
|------|--------|
| `backend/src/routes/artists.ts` | Replace direct CAA fetches with lazy-load URLs |
| `backend/src/services/imageProvider.ts` | Add rate limiter to CAA requests, increase timeout |
| `backend/src/services/coverArt.ts` | Increase timeout |
| `backend/src/routes/library.ts` | Add database persistence for verified covers |

## What NOT to Change

- **Frontend retry logic** — Not needed if backend returns proper lazy-load URLs
- **p-limit batching** — Rate limiter already handles concurrency
- **Frontend stagger timing** — Already has `index * 100ms` delay which is fine
