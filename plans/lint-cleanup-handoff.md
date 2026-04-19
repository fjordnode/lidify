# Lint Cleanup — COMPLETED

## Final Result

- **Before**: 93 errors, 185 warnings (278 total at start of first session)
- **At handoff**: 128 errors, 80 warnings (208 total — errors rose due to new React 19 rules)
- **After**: **0 errors, 0 warnings**
- **Build**: Passes cleanly (`npm --prefix frontend run build`)

## What Was Done

### Phase 1: Unused Variables (121 warnings → 0)

Completed across two sessions (~60 files total):

- Removed dead imports, variables, and functions
- Prefixed intentionally-unused vars with `_` (catch block errors, destructured-but-unused props)
- **Key fix**: Added `varsIgnorePattern: "^_"`, `argsIgnorePattern: "^_"`, `caughtErrorsIgnorePattern: "^_"` to ESLint config (`eslint.config.mjs`). Without this, `_`-prefixed vars were still flagged.
- Removed dead code: `playingDevice`, `handleRemotePlayPause`, `sendCommand` from `DeviceSelector.tsx`

### Phase 2: `<img>` → `<Image>` Migration (23 warnings → 0)

16 files modified:

- Used `fill` + `unoptimized` for images in sized containers (added `relative` to parents where missing)
- Used explicit `width`/`height` for images with Tailwind size classes
- All images use `unoptimized` since they serve external/proxied cover art
- Special case: `CachedImage.tsx` rewritten to use `<Image>` internally

### Phase 3: Refs During Render (47 errors → 0)

Two sub-patterns fixed:

**a) `useRef` for previous-value tracking (8 files)**
Converted from `useRef` + render-time mutation to `useState` — the React 19 approved pattern for "storing information from previous renders":
- `AIServicesSection.tsx`, `DownloadNotifications.tsx`, `VibeOverlayContainer.tsx`, `InlineStatus.tsx`
- `useCachedImage.ts`, `useImageColor.ts`, `useJobStatus.ts`, `useMediaQuery.ts`

**b) `Math.random()` in render — purity rule (GalaxyBackground.tsx)**
Moved particle generation to module-level `generateParticleLayer()` function and `PARTICLES` constant. Extracted `hexToRgb()` out of the component. Removed `useMemo` import.

**c) Synchronous `setState` in effects (2 files)**
- `useImageColor.ts`: Moved `setIsLoading(true)` to render-time URL change handler
- `useJobStatus.ts`: Deferred initial `checkStatus()` call with `setTimeout(fn, 0)`

### Phase 4: `no-explicit-any` (81 errors → 0)

51 files fixed across several patterns:

- **Catch blocks** (`catch (err: any)` → `catch (err: unknown)`): ~30 instances. Added `err instanceof Error ? err.message : "fallback"` pattern.
- **API response types**: Defined inline interfaces for data shapes used in `.map()` callbacks and state
- **Component props**: Added proper interface definitions (e.g., `AudiobookActionBar`, `PlayControls`, `PlaylistSelector`)
- **React Query cache updates**: Used `Record<string, unknown>` with property assertions instead of `any`
- **`useSystemSettings.ts`**: Changed `as SystemSettings` to `as unknown as SystemSettings` for the sanitize function's return

### Phase 5: React Hooks Warnings (25 exhaustive-deps + refs in cleanup → 0)

**a) `exhaustive-deps` (25 warnings)**
- Added stable `useState` setters to dep arrays where safe (`setActivePlayerId`, `setControlMode`, `setCurrentTrack`)
- Added `controls` (memoized context object) to dep arrays in `remote-aware-audio-controls-context.tsx` (6 callbacks)
- Used `eslint-disable-next-line` with explanations for intentional omissions:
  - Mount-once effects (data loading on mount)
  - Output-not-input deps (e.g., `colors` is output of the color extraction effect)
  - Property-specific deps (e.g., `currentTrack?.id` instead of full object)
- Wrapped conditional `audiobooks` derivation in `useMemo` (`audiobooks/page.tsx`)

**b) Ref in cleanup (toast-context.tsx)**
- Captured `timeoutsRef.current` to local variable before cleanup function

### Phase 6: Unused Expressions (3 warnings → 0)

Converted `isPlaying ? pause() : resume()` ternaries to `if/else` statements in:
- `app/audiobooks/series/[name]/page.tsx`
- `app/browse/playlists/[id]/page.tsx`
- `components/layout/TVLayout.tsx`

## Build Fixes (regressions from type changes)

Some `any` → specific type conversions required iteration to get right:
- `artists/page.tsx`: Added `albumCount` to artist type
- `playlists/page.tsx`: Expanded playlist item type to include `album.artist` and `album.id`
- `DownloadNotifications.tsx`: Added `onDelete` prop to `DownloadJobItemCompact`
- `InlineStatus.tsx`: Restored `status` and `props` destructuring removed by agent
- `AudiobookActionBar.tsx` / `PlayControls.tsx`: Added `duration`, `progress.currentTime`, `progress.isFinished` to audiobook type
- `useAudiobookActions.ts`: Used proper `Audiobook` import instead of `Record<string, unknown>`
- `useSystemSettings.ts`: Double-cast through `unknown` for sanitized settings

## Post-Cleanup Risk Reduction Patch

A follow-up review identified that replacing `controls.seek` → `controls` in dependency arrays (Phase 5a, `remote-aware-audio-controls-context.tsx`) introduced a cascade risk: if *any* method on `controls` changed, all 6 wrapped callbacks would recreate unnecessarily.

**Fix applied** (`remote-aware-audio-controls-context.tsx`):
- Destructured specific method refs from `controls` once at render time (`localSeek`, `localSkipForward`, etc.) at line ~119
- Updated all 6 `useCallback` dep arrays to depend on these specific refs instead of the whole `controls` object
- Removed duplicated passthrough assignments (now sourced from the initial destructure)

This narrows callback invalidation so each wrapper only recreates when its specific method changes, not when any unrelated method on `controls` changes. Zero behavior change, strictly a dependency-tracking optimization.

**Residual note**: Upstream `AudioControlsProvider` has broad deps like `[state]` in its `useMemo` that could still cause the whole `controls` object to recreate. This patch limits the blast radius at the remote-aware layer but doesn't fix the upstream issue.

Lint and build both pass after this patch.

## Validation

```bash
npm --prefix frontend run lint   # 0 errors, 0 warnings
npm --prefix frontend run build  # ✓ All 27 pages generated
```

## Files Modified

~70+ frontend files. Run `git diff --stat` for the full list.

## Key Config Change

`frontend/eslint.config.mjs` now includes:
```js
"@typescript-eslint/no-unused-vars": ["warn", {
    argsIgnorePattern: "^_",
    varsIgnorePattern: "^_",
    caughtErrorsIgnorePattern: "^_",
}]
```
This is the standard convention and prevents future `_`-prefixed variables from being flagged.
