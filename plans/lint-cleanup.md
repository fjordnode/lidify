# Lint Cleanup Plan

Pre-publish cleanup of all ESLint errors and warnings in the frontend.

**Current state:** 93 errors, 185 warnings across 129 files.

---

## Phase 1: Unused Variables (121 warnings, 60 files)

**Rule:** `@typescript-eslint/no-unused-vars`
**Effort:** Low — mechanical removals, no logic changes.
**Risk:** None.

Remove unused imports and variable declarations. These are leftover from refactors and dead code. Most are unused error variables in catch blocks, unused imports from lucide-react/next, and dead state variables.

Top affected areas:
- `features/` components and hooks (~30 files)
- `app/` page components (~15 files)
- `lib/` contexts and utilities (~8 files)
- `hooks/` (~5 files)
- `components/` (~5 files)

**Approach:**
1. Run `eslint --fix` for the 13 auto-fixable warnings first
2. Manually remove remaining unused imports/variables
3. For unused `error` in catch blocks, use `_error` or `_` prefix convention
4. Verify build still passes after each batch of ~10 files

---

## Phase 2: `<img>` to `<Image>` Migration (23 warnings, 5 files)

**Rule:** `@next/next/no-img-element`
**Effort:** Low-Medium — straightforward swap but needs sizing attributes.
**Risk:** Low — may need `unoptimized` prop for external/proxied images.

Files to update:
- `features/search/components/LibraryAlbumsGrid.tsx`
- `features/home/components/FeaturedPlaylistsGrid.tsx`
- `components/ui/CachedImage.tsx`
- `app/mix/[id]/page.tsx`
- `app/browse/playlists/page.tsx`
- Plus ~10 instances in `app/playlist/[id]/page.tsx`, `app/browse/playlists/[id]/page.tsx`

**Approach:**
1. Replace `<img>` with Next.js `<Image>` component
2. Add `fill` or explicit `width`/`height` props
3. Add `unoptimized` for proxied/external URLs (our cover-art proxy)
4. Test image rendering visually after changes

---

## Phase 3: Refs During Render (12 errors, 1 file)

**Rule:** `react-hooks/refs` (Cannot access refs during render)
**Effort:** Low — single file fix.
**Risk:** Low — needs careful review of render-time ref access.

**File:** `features/settings/components/sections/AIServicesSection.tsx`

All 12 errors are on line 42-46. The component accesses ref values directly during render instead of inside effects or callbacks.

**Fix:** Move ref reads into `useEffect` or memoize with proper dependencies.

---

## Phase 4: Explicit `any` Types (81 errors, 34 files)

**Rule:** `@typescript-eslint/no-explicit-any`
**Effort:** Medium-High — requires understanding data shapes and creating/reusing types.
**Risk:** Low if done carefully — improves type safety.

This is the largest category. The `any` types cluster in a few patterns:

### 4a. API response types (~25 errors)
Hooks and components that consume API data without typing the response. Common in:
- `features/artist/components/` (ArtistHero, ArtistActionBar, Discography, AvailableAlbums)
- `features/album/components/` (AlbumHero, AlbumActionBar, TrackList, SimilarAlbums)
- `features/podcast/components/` (PodcastHero, PodcastActionBar, PreviewEpisodes)
- `features/audiobook/components/` (AudiobookHero, ChapterList, PlayControls)

**Fix:** Define shared types in each feature's `types.ts` file. Many of these features already have partial type definitions — extend them to cover all API response shapes.

### 4b. Event handler / callback types (~15 errors)
Error catch blocks, event handlers, and callback parameters typed as `any`.
- `features/settings/hooks/` (useAPIKeys, useSystemSettings, useTwoFactor)
- `features/search/hooks/useSoulseekSearch.ts`
- `features/library/hooks/useLibraryActions.ts`
- `hooks/useDownloadStatus.ts`, `hooks/useRemotePlaybackIntegration.ts`

**Fix:** Use `unknown` for catch block errors (TypeScript best practice), proper event types for handlers.

### 4c. Component prop types (~10 errors)
Components receiving data props typed as `any`:
- `components/MetadataEditor.tsx`
- `components/ui/PlaylistSelector.tsx`
- `components/player/RemoteVolumeCapture.tsx`
- `components/activity/NotificationsTab.tsx`

**Fix:** Define proper interfaces for each component's props.

### 4d. Page-level types (~10 errors)
- `app/playlist/[id]/page.tsx` (4 — query cache update callbacks)
- `app/releases/page.tsx`
- `app/recommendations/page.tsx`
- `app/artists/page.tsx`
- `app/browse/playlists/[id]/page.tsx`

**Fix:** Type the query data shapes or use generics from React Query.

**Approach for Phase 4:**
1. Start with features that already have `types.ts` — extend existing types
2. Create shared API response types where multiple components use the same shape
3. Replace `any` in catch blocks with `unknown` globally (batch operation)
4. Address component props last (these need the most context)
5. Build after every 5-8 files to catch regressions

---

## Phase 5: React Hooks Warnings (45 warnings, 13 files)

### 5a. Exhaustive deps (26 warnings, 8 files)

**Rule:** `react-hooks/exhaustive-deps`
**Effort:** Medium — each needs case-by-case judgment.
**Risk:** Medium — incorrect fixes can cause infinite re-renders or stale closures.

Files:
- `components/ui/GalaxyBackground.tsx`
- `components/ui/ReleaseSelectionModal.tsx`
- `features/discover/hooks/useDiscoverData.ts`
- `features/home/components/LibraryRadioStations.tsx`
- `features/settings/components/sections/LidarrSection.tsx`
- `lib/toast-context.tsx`
- `app/audiobooks/series/[name]/page.tsx`
- `app/podcasts/genre/[genreId]/page.tsx`

**Approach:** Review each individually:
- If dep is intentionally omitted (e.g., "run once" effect), add `// eslint-disable-next-line` with explanation
- If dep should be included, add it and verify no infinite loops
- If function dep, wrap in `useCallback` first

### 5b. Refs in cleanup (19 warnings, 5 files)

**Rule:** `react-hooks/refs`
**Effort:** Low — mechanical pattern.
**Risk:** None.

Files:
- `components/player/VibeOverlayContainer.tsx`
- `hooks/useCachedImage.ts`
- `hooks/useImageColor.ts`
- `hooks/useJobStatus.ts`
- `hooks/useMediaQuery.ts`

**Fix:** Copy ref value to a local variable at the top of the effect:
```ts
useEffect(() => {
    const current = ref.current; // capture
    return () => {
        // use `current` instead of `ref.current`
    };
}, []);
```

---

## Phase 6: Unused Expressions (3 warnings, 1 file)

**Rule:** `@typescript-eslint/no-unused-expressions`
**Effort:** Low.
**Risk:** None.

**File:** `app/browse/playlists/[id]/page.tsx`

Likely short-circuit expressions used for side effects (e.g., `condition && doSomething()`). Convert to `if` statements.

---

## Execution Order

| Phase | Items | Effort | Suggested approach |
|-------|-------|--------|--------------------|
| 1 | 121 unused vars | ~1 hour | Batch with auto-fix + manual pass |
| 5b | 19 ref warnings | ~15 min | Mechanical pattern |
| 3 | 12 render refs | ~15 min | Single file |
| 6 | 3 expressions | ~5 min | Single file |
| 2 | 23 img elements | ~30 min | File by file |
| 5a | 26 exhaustive-deps | ~45 min | Case by case |
| 4 | 81 any types | ~3-4 hours | Feature by feature |

**Total estimate:** ~6-7 hours of focused work.

**Target:** Zero errors, warnings under 10 (some `exhaustive-deps` may be intentional suppresses).

## Validation

After each phase:
```bash
npm --prefix frontend run lint
npm --prefix frontend run build
```

After all phases:
```bash
docker build -t lidify-remote:latest .
```
