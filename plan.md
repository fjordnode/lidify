# Lidify Import Ownership Fix Plan

This file tracks the next fixes after the music import, file storage, and ownership work. Update checkboxes and notes as fixes land.

## Current Baseline

- Download/import ownership issues were investigated end to end across downloads, Lidarr webhooks, scans, DB writes, ownership, and frontend visibility.
- Main deployed fixes include storage-aware track paths via `Track.fileStorage`, safer uniqueness via `(fileStorage, filePath)`, direct Soulseek scan queuing, library refreshes after scan/download completion, and artist popular-track ownership cache invalidation.
- Production was deployed with migration `20260527000000_add_track_file_storage` and a successful full scan.
- Arctic Monkeys `505` was confirmed owned/playable after fixing artist popular-track matching beyond the first 10 album tracks and clearing stale processed top-track caches.

## Priority Order

1. Playback reliability
2. Library/data integrity
3. Discovery quality and variety
4. Self-hosted operational simplicity

## P0: Fix Partial-Scan Cleanup Safety

Status: Completed 2026-05-27

Risk: Data integrity. Current scanner code still appears capable of deleting unrelated tracks during partial scans.

Evidence:

- `backend/src/services/musicScanner.ts:111-115` computes `canRunOrphanCleanup` for full music-root scans only.
- `backend/src/services/musicScanner.ts:236` still gates cleanup on `!this.playlistOnlyMode`, not `canRunOrphanCleanup`.
- Partial scans can come from:
- `backend/src/routes/webhooks.ts:272-279` for localized Lidarr import scans.
- `backend/src/routes/soulseek.ts:319-324` for direct Soulseek album-folder scans.

Fix target:

- Change track/album/artist orphan cleanup to run only when `canRunOrphanCleanup` is true.
- Build `scannedPaths` relative to `basePathForDb`, not `musicPath`, so cleanup compares the same path namespace as persisted `Track.filePath`.
- Keep direct Soulseek ownership behavior separate from cleanup behavior. `playlistOnlyMode: false` can remain if direct Soulseek downloads should become owned, but partial scans must not clean unrelated rows.

Done when:

- Partial `/music/Artist/Album` scan cannot remove unrelated library tracks.
- Partial `/soulseek-downloads/Artist/Album` scan cannot remove unrelated download-storage tracks.
- Full `/music` scan can still remove genuinely missing music tracks.

Completion notes:

- `backend/src/services/musicScanner.ts` now runs orphan track/album/artist cleanup only when `canRunOrphanCleanup` is true.
- Partial, download-storage, and playlist-only scans now skip orphan cleanup.
- Cleanup path comparison now uses `path.relative(basePathForDb, f)` so it matches the stored `Track.filePath` namespace.
- Full-root scans that find fewer than 50% of existing indexed tracks now skip orphan cleanup and report a warning. This prevents mass deletion when a network mount path exists but the mount is unavailable or partially populated.
- Validation: `npx tsx src/tests/musicScannerFileStorage.test.ts` passed from `backend/`.
- Validation: `npm --prefix backend run build` passed.

## P1: Add Scanner And FileStorage Regression Coverage

Status: Completed 2026-05-27

Risk: Current tests do not cover scanner, `fileStorage`, partial scans, or import/ownership safety.

Coverage targets:

- Full `/music` scan can remove missing music tracks. Covered by `backend/src/tests/musicScannerFileStorage.test.ts`.
- Sparse full-root scans with existing indexed tracks skip orphan cleanup to avoid network-mount mass deletion. Covered by `backend/src/tests/musicScannerFileStorage.test.ts`.
- Partial `/music/Artist/Album` scan never removes unrelated tracks. Covered by `backend/src/tests/musicScannerFileStorage.test.ts`.
- Partial `/soulseek-downloads/Artist/Album` scan with `playlistOnlyMode: false` adds owned download-storage tracks without cleanup. Covered by `backend/src/tests/musicScannerFileStorage.test.ts`.
- Playlist/import scans with inferred playlist-only mode stay hidden from owned-library views. Covered by `backend/src/tests/musicScannerFileStorage.test.ts`.
- Duplicate relative paths in `music` and `download` coexist through `(fileStorage, filePath)`. Covered by `backend/src/tests/musicScannerFileStorage.test.ts` by preserving a download-storage track while deleting the missing music-storage row with the same relative path.

Completion notes:

- Added `backend/src/tests/musicScannerFileStorage.test.ts` as a direct `tsx` regression script using in-memory Prisma/service stubs.
- Validation: `npx tsx src/tests/musicScannerFileStorage.test.ts` passed from `backend/`.
- Validation: `npm --prefix backend run build` passed.

Relevant files:

- `backend/src/services/musicScanner.ts`
- `backend/src/workers/processors/scanProcessor.ts`
- `backend/prisma/schema.prisma`
- `backend/prisma/migrations/20260527000000_add_track_file_storage/migration.sql`

## P1: Centralize Frontend Library Refresh

Status: Completed 2026-05-27

Risk: Ownership/playability can remain stale because cache invalidation is duplicated and incomplete.

Current duplicated refresh paths:

- `frontend/hooks/useDownloadStatus.ts:88-93`
- `frontend/features/settings/components/sections/LibrarySection.tsx:151-156`
- `frontend/features/search/hooks/useSoulseekSearch.ts:123-133`

Missing refresh path:

- `frontend/app/import/spotify/page.tsx:159-176` dispatches notification and playlist events on import completion, but does not refresh library ownership caches.

Fix target:

- Create one shared helper for library refresh invalidation plus `library-data-changed` dispatch.
- Use it from download completion, manual scan completion, direct Soulseek scan completion, and Spotify import completion.
- Include library, albums, recently-added, artist/album detail, and homepage-related query keys as appropriate.

Done when:

- Open library/artist/album/home views refresh after downloads, scans, and imports without waiting for stale timers or remounts.

Completion notes:

- Added `frontend/lib/library-refresh.ts` with `refreshLibraryCaches(queryClient)`.
- Replaced duplicate invalidation in `frontend/hooks/useDownloadStatus.ts`, `frontend/features/settings/components/sections/LibrarySection.tsx`, and `frontend/features/search/hooks/useSoulseekSearch.ts`.
- Added library cache refresh to Spotify import terminal states in `frontend/app/import/spotify/page.tsx`.
- Refresh now invalidates library, albums, album detail, artist detail, and recommendations query prefixes, then dispatches `library-data-changed`.
- Validation: `npm --prefix frontend run build` passed.
- Validation: targeted ESLint on touched frontend files passed.
- Note: full `npm --prefix frontend run lint` is currently blocked by an existing `@typescript-eslint/no-explicit-any` error in `frontend/app/page.tsx:37`, outside this refresh change.

## P1: Fix Artist Source Detection

Status: Completed 2026-05-27

Risk: Library artists can be treated as discovery artists in the frontend.

Evidence:

- `frontend/features/artist/hooks/useArtistData.ts:83-87` infers source with `artist.id && !artist.id.includes("-")`.
- UUIDs contain hyphens, so real library artists can be misclassified as discovery.

Fix target:

- Prefer an explicit API field such as `source: "library" | "discovery"`.
- Alternatively derive source from which fetch path succeeded in `useArtistData`.
- Stop using ID shape as a source discriminator.

Done when:

- CUID and UUID-backed library artists both render with library/owned behavior.
- Discovery artists still render discovery/download behavior.

Completion notes:

- `frontend/features/artist/hooks/useArtistData.ts` now tags artist data with `source` based on the successful API path.
- Library responses are tagged `source: "library"`; discovery fallback/name responses are tagged `source: "discovery"`.
- Removed source inference from ID shape, so UUID-backed library artists are no longer misclassified as discovery.
- `frontend/features/artist/types.ts` now includes optional `Artist.source`.
- Validation: targeted ESLint on touched artist files passed.
- Validation: `npm --prefix frontend run build` passed.

## P2: Normalize Soulseek Source Strings

Status: Completed 2026-05-28

Risk: Download lifecycle/stale-job logic can drift because source strings are inconsistent.

Evidence:

- `backend/src/routes/soulseek.ts:323` uses `source: "soulseek-direct"`.
- `backend/src/services/simpleDownloadManager.ts:1220-1221` checks `"slskd"` and `"soulseek_direct"`.
- Other paths use `"soulseek_direct"`, for example `backend/src/services/spotifyImport.ts:1397`.

Fix target:

- Normalize on one source constant, likely `soulseek_direct` to match existing manager logic.
- Optionally support legacy aliases while existing jobs age out.

Done when:

- Direct Soulseek jobs are treated consistently by stale-job and completion logic.

Completion notes:

- `backend/src/routes/soulseek.ts` now uses `source: "soulseek_direct"` for direct Soulseek scan jobs.
- `backend/src/services/simpleDownloadManager.ts` now treats `slskd`, `soulseek_direct`, and legacy `soulseek-direct` as Soulseek sources when skipping stale-job handling.
- Validation: `npm --prefix backend run build` passed.
- Validation: `npx tsx src/tests/musicScannerFileStorage.test.ts` passed from `backend/`.

## P2: Add Lidarr Webhook Authenticity

Status: Not started

Risk: If the webhook endpoint is reachable beyond the trusted LAN/container network, unauthenticated requests can trigger scans and mutate download state.

Evidence:

- `backend/src/routes/webhooks.ts:103-168` validates that Lidarr is enabled, but does not validate a shared secret/signature.

Fix target:

- Add a configurable shared secret/token for Lidarr webhooks.
- Reject requests missing or mismatching the expected secret.
- Keep local deployment simple by documenting the setting and migration/default behavior if needed.

Done when:

- Unauthorized webhook requests cannot trigger scan/download state changes.
- Valid Lidarr webhooks continue to work.

## Validation Checklist

- `npm --prefix backend run build`
- `npm --prefix frontend run lint`
- `npm --prefix frontend run build`
- Targeted scanner regression test command, once tests exist.
- Manual validation: direct Soulseek download, Lidarr import webhook path, Spotify playlist import, artist page ownership state, album playback.

## Notes

- Avoid reverting existing uncommitted deployed changes unless explicitly requested.
- Keep fixes small and surgical.
- Prefer library/data integrity over frontend polish until P0 is complete.
