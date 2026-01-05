# Refactor Plan: Code Review Findings

Issues identified during code review on 2026-01-04. Prioritized by impact.

## High Priority

### 1. N+1 Query Pattern in Artist Discovery
**File:** `backend/src/routes/artists.ts` (lines 707-755)

**Issue:** The similar artists loop makes 30+ HTTP requests (Fanart.tv → Deezer → Last.fm for each of 10 artists).

**Impact:** Slow page loads for artist discovery pages.

**Solution:**
- Batch image lookups where possible
- Add parallel request limiting (e.g., p-limit)
- Consider caching similar artist images more aggressively
- Pre-fetch common artist images in background job

---

### 2. Stale Cache Keys for Library Search
**File:** `backend/src/routes/search.ts` (line 105)

**Issue:** Cache key includes query/type/genre but doesn't invalidate when library changes. User searches "radiohead", gets 10 albums cached, adds 5 more albums, still sees 10.

**Impact:** Confusing UX - search results don't reflect recent library changes.

**Solution Options:**
- Shorten TTL from 2 minutes to 30 seconds
- Add cache invalidation on library writes (album add/delete)
- Include a library version/hash in cache key
- Use Redis pub/sub to invalidate on changes

---

### 3. Missing Error Boundaries
**Files:** Frontend components

**Issue:** No React Error Boundaries. If any component throws (e.g., bad data from API), the entire page crashes with white screen.

**Impact:** Poor error recovery UX.

**Solution:**
```tsx
// Add error boundaries around major sections
<ErrorBoundary fallback={<ErrorMessage />}>
  <ArtistPage />
</ErrorBoundary>
```

Priority sections:
- Artist page
- Album page
- Search page
- Player components

---

## Medium Priority

### 4. Console.logs in Production
**Files:** Multiple backend files

**Issue:** Extensive `console.log()` statements spam production logs.

**Solution:**
- Create a logger utility with levels (debug/info/warn/error)
- Wrap in `if (process.env.NODE_ENV === 'development')`
- Or use a library like `pino` or `winston`

Example locations:
- `artists.ts`: lines 71, 87, 104, 158, 169, 217
- `lastfm.ts`: various debug logs
- `search.ts`: cache hit/miss logs

---

### 5. Magic Numbers for Cache TTLs
**Files:** Multiple files

**Issue:** Cache TTLs are hardcoded numbers with no explanation.

**Current:**
```typescript
const DISCOVERY_CACHE_TTL = 24 * 60 * 60; // This one has a comment
await redisClient.setEx(key, 604800, value); // What is 604800?
```

**Solution:**
```typescript
const CACHE_TTL = {
  SEARCH_RESULTS: 2 * 60,        // 2 minutes
  DISCOVERY_ARTIST: 24 * 60 * 60, // 24 hours
  SIMILAR_ARTISTS: 7 * 24 * 60 * 60, // 7 days
  DEEZER_IMAGE: 24 * 60 * 60,    // 24 hours
} as const;
```

---

### 6. Inconsistent Error Handling in lastfm.ts
**File:** `backend/src/services/lastfm.ts`

**Issue:** Some methods silently return null/empty, others throw. Inconsistent behavior makes debugging harder.

**Solution:**
- Document expected behavior in JSDoc
- Either always throw (let caller handle) or always return Result type
- Add proper error logging before returning null

---

## Low Priority

### 7. Artist ID Handling Utility
**Files:** `TopResult.tsx`, `SimilarArtistsGrid.tsx`, `useArtistData.ts`

**Issue:** Three different patterns for determining artist link IDs.

**Solution:**
```typescript
// utils/artistHelpers.ts
export function getArtistLinkId(artist: {
  id?: string;
  mbid?: string;
  name: string;
}): string {
  // Library artists have CUID ids (no hyphens)
  // Discovery artists use MBID or name
  return artist.id || artist.mbid || artist.name;
}

export function isLibraryArtist(artist: { id?: string }): boolean {
  return !!artist.id && !artist.id.includes("-");
}
```

---

### 8. TypeScript Strictness
**Files:** Multiple

**Issue:** Many `any` types throughout codebase.

**Examples:**
- `lastfm.ts`: API responses typed as `any`
- `artists.ts`: Album/track objects as `any`
- Component props with `any`

**Solution:**
- Create proper interfaces for API responses
- Enable stricter TypeScript settings incrementally
- Start with new code, gradually fix existing

---

### 9. Image Proxy Performance
**File:** `frontend/features/search/components/SimilarArtistsGrid.tsx`

**Issue:** All images go through backend proxy, even external URLs that support CORS.

**Solution:**
- Only proxy images that need auth or caching
- Load Last.fm/Deezer images directly if CORS allows
- Add `loading="lazy"` to images below fold

---

## Completed

- [x] Safe URI decoding (try-catch around decodeURIComponent)
- [x] Memory leak fix in AvailableAlbums (isMounted flag)

---

## Notes

- Most issues are optimizations, not bugs
- Current code works correctly, just has room for improvement
- Prioritize based on user-facing impact
