# Lidify — App Sections Map

Troubleshooting index. Each section = one functional area. When something
breaks, find the symptom, jump to the files. Priority order on tradeoffs:
**playback reliability > data integrity > discovery quality > simplicity.**

System shape: Next.js+Node frontend (`3030`) ⇄ Express+Socket.io backend
(`3006`) ⇄ PostgreSQL (truth) + Redis (sessions/cache/Bull queues) +
Python Essentia analyzer sidecar. `frontend/server.js` proxies socket.io,
streaming, and long API paths to backend.

---

## 1. Auth & Users

Login, sessions, accounts, multi-user, API keys.

- **Backend:** `routes/auth.ts`, `routes/users.ts`, `middleware/auth.ts`,
  `middleware/optionalAuth.ts`, `middleware/adminAuth.ts`
- **Frontend:** `app/login`, `app/setup`, `lib/auth-context.tsx`,
  `lib/account-context.tsx`, `lib/api-keys.ts`
- **Symptoms:** can't log in, 401 on API, session drops, setup wizard loops.
- **Look first:** middleware order in `index.ts`, token expiry logic, Redis
  session store.

## 2. Library & Scan

Filesystem ingest, scan, organize, dedup, track/album/artist records.

- **Backend:** `routes/library.ts`, `routes/scan.ts`, `routes/albums.ts`,
  `routes/artists.ts`, `routes/genres.ts`, `routes/tags.ts`,
  `services/library.ts`
- **Queues:** `library-scan` (Bull, job name `scan`) + `file-validation`.
  Scans, imports, and post-download grabs all enqueue a `scan` job.
- **Frontend:** `app/library`, `app/albums`, `app/artists`, `app/genres`,
  `components/album`, `components/artist`
- **Invariant:** scan is **manual** (`/api/library/scan`). No startup
  auto-scan. Queue-driven flow.
- **Symptoms:** tracks missing after scan, wrong artist grouping, dupes,
  library not refreshing post-download.
- **Look first:** `workers/processors/scanProcessor.ts` (scan job logic),
  `services/library.ts` (library cache refresh).
- _Done 2026-05-29:_ replaced 6 biased `sort(()=>Math.random())` sites in
  `library.ts` with the shared `utils/shuffle.ts` (incl. the asymmetric `-0.3`
  vibe-pool site); fixed the dead `queueProcessors.ts` pointer + queue list.

## 3. Playback — Local

This-device audio engine, controls, queue, media session.

- **Backend:** `routes/playback.ts`, `routes/playbackState.ts`,
  `routes/queue.ts`
- **Frontend:** `components/player/HowlerAudioElement.tsx`,
  `lib/audio-controls-context.tsx`, `lib/play-context.tsx`,
  `lib/queue-context.tsx`, `lib/use-media-session.ts`, `app/queue`
- **Invariant:** `HowlerAudioElement` must NOT play if device not active.
- **Symptoms:** no sound, double playback, queue desync, scrubbing broken.

## 4. Playback — Remote Control

Cross-device control. One active player per user.

- **Backend:** `routes/remotePlayback.ts`, `websocket/remotePlayback.ts`
  (Socket.io server + auth + in-memory device registry)
- **Frontend:** `lib/remote-playback-context.tsx` (Socket.io client lives
  inline here — there is no separate socket module),
  `lib/remote-aware-audio-controls-context.tsx`, `lib/device-identity.ts`
  (device/browser/tab ID generation)
- **Invariants:** exactly one active player/user; routing follows
  `controlMode`+`controlTargetId` (no stale closures); controller UI mirrors
  remote state.
- **Symptoms:** command hits wrong device, controller UI stale, ghost
  players, socket disconnect.
- _Done 2026-05-29:_ (A) device rename no longer tears down the socket — name
  read via ref, dropped from connect-effect deps (was churning active-player
  election); (B) `device:register` now rejects a deviceId already owned by
  another user (registry-hijack guard); (C) gated hot-path logs + `Error().stack`
  captures behind `REMOTE_DEBUG`.

## 5. Discovery & Recommendations

Discover Weekly, mixes, mood, genre/artist recs.

- **Backend:** `routes/discover.ts` (recs + inline Redis cache),
  `routes/recommendations.ts`, `services/discoverWeekly.ts`,
  `services/programmaticPlaylists.ts`, `services/recommendations.ts`,
  `routes/playlists.ts`
- **Queues:** `discover-weekly` (Bull). Recommendation + playlist generation
  run in-services (`recommendations.ts`, `programmaticPlaylists.ts`), not as
  separate Bull queues.
- **Frontend:** `app/discover`, `app/recommendations`, `app/mixes`,
  `app/mood`, `app/favorites`, `app/liked-songs`, `lib/discovery-context.tsx`,
  `lib/like-context.tsx`, `components/discovery`
- **Invariants:** avoid insertion-order bias; careful with Prisma `take`
  w/o randomization; preserve `diversifyByArtist`.
- **Symptoms:** same tracks every time, stale discover cache, empty mixes,
  artist not diversified.
- _Done 2026-05-29:_ added `utils/shuffle.ts` (`shuffle`/`seededShuffle`,
  Fisher-Yates) and replaced the biased `sort(()=>Math.random())` /
  seeded-LCG-in-`sort` pattern across `programmaticPlaylists.ts` (12 sites,
  incl. 9 daily-mix seeded shuffles), `discoverWeekly.ts` (3), and
  `moodBucketService.ts` (1). Daily-mix per-day stability preserved.
- _Done 2026-05-29:_ discover recs (`app/discover`) now persist until the
  user clicks Generate instead of auto-expiring at 24h; localStorage TTL
  eviction dropped, `formatTimeSince` extended past "yesterday" to
  days/weeks/months, and `routes/discover.ts` `RECOMMENDATIONS_CACHE_TTL`
  raised 24h→30d so the Redis copy does not regenerate under the client.

## 6. Downloads & Lidarr

Acquisition pipeline, download manager, Lidarr integration.

- **Backend:** `routes/download.ts`, `routes/downloadManagement.ts`,
  `routes/downloadStatus.ts`, `services/simpleDownloadManager.ts`,
  `services/lidarr.ts`
- **Not a Bull queue:** downloads run in-memory via
  `services/downloadQueue.ts` + `services/simpleDownloadManager.ts`;
  completion enqueues a `scan` job on `library-scan` (§2/§14).
- **Symptoms:** stuck downloads, Lidarr not triggering, status not updating,
  library not refreshing after grab.

## 7. External Metadata & Artwork

MusicBrainz, Last.fm, Spotify, ListenBrainz enrichment + images.

- **Backend:** `services/musicbrainz.ts`, `services/mbid.ts`,
  `services/lastfm.ts`, `services/spotify.ts`, `services/listenbrainz.ts`,
  `services/albumArt.ts`, `services/artistImageService.ts`,
  `services/similarArtists.ts`, `routes/albumArtRefresh.ts`,
  `routes/artistImage.ts`, `routes/similarArtists.ts`, `routes/sync.ts`
- **Queues:** `image-optimization` (Bull). Artist images + ListenBrainz/usage
  sync run in services/workers, not as separate Bull queues.
- **Invariant:** `temp-` MBIDs are placeholders — skip external lookups for
  them. Use `artist.id` for app links/joins.
- **Symptoms:** missing/wrong art, rate-limit errors, temp-MBID hitting
  external APIs, similar-artists empty, "Last.fm plays" album sort grayed
  on unowned artists.
- _Done 2026-05-29:_ `routes/artists.ts` discover route now attaches
  per-album Last.fm playcount/listeners (`getArtistTopAlbums`, matched by
  normalized title, temp-MBID guarded) before the 24h Redis cache write,
  mirroring the owned-artist path in `routes/library.ts`. Fixes the
  "Last.fm plays" album sort being grayed for unowned artists until a
  download flipped them to the library endpoint.

## 8. Audio Analysis

Essentia sidecar, audio features, tonal/mood scoring.

- **Backend:** `routes/analysis.ts`, `routes/audioFeatures.ts`,
  `routes/audio.ts` (`/api/audio`), `services/audioAnalysis.ts`,
  `services/audioFeatures.ts`
- **Sidecar:** `services/audio-analyzer/analyzer.py`
- **Queues:** `audio-analysis` (Bull).
- **Symptoms:** analysis stuck `pending`, mood/tonal missing, sidecar
  unreachable, ML scores absent (tag fallback).
- **Re-analyze reset:** `UPDATE "Track" SET "analysisStatus"='pending'
  WHERE "analysisMode"='standard';`

## 9. Subsonic Compatibility API

Third-party client compatibility under `/rest/*`.

- **Backend:** `routes/subsonic.ts`, `middleware/subsonicAuth.ts`
- **Invariant:** Subsonic stays under `/rest/*`; app API stays `/api/*`.
- **Symptoms:** external client (DSub/Symfonium) login fails, missing
  endpoints, salt/token auth mismatch.
- _Done 2026-05-29:_ replaced 3 biased `sort(()=>Math.random())` sites
  (random albums/songs endpoints) with `utils/shuffle.ts`.

## 10. Search

- **Backend:** `routes/search.ts`
- **Frontend:** `app/search`
- **Symptoms:** no results, slow query, wrong ranking.

## 11. Settings / Admin / System

Config, admin panel, health/system info.

- **Backend:** `routes/settings.ts`, `routes/admin.ts`, `routes/system.ts`,
  `admin/` dir
- **Frontend:** `app/settings`, `app/admin`, `lib/admin-context.tsx`,
  `lib/theme-context.tsx`, `lib/toast-context.tsx`
- **Symptoms:** setting not persisting, admin actions fail, health endpoint
  down.

## 12. Lyrics

- **Backend:** `routes/lyrics.ts`, `services/lyrics.ts`
- **Symptoms:** lyrics missing/misaligned, provider error.

## 13. Visualization

- **Backend:** `routes/visualization.ts`
- **Frontend:** `app/...`, `components/visualization`,
  `lib/visualization-context.tsx`
- **Symptoms:** visualizer blank, perf lag.

## 14. Queue / Worker / Scheduler Infrastructure

Bull queues, worker boot, recurring jobs. Cross-cuts sections 2/5/6/7/8.

- **Backend:** `workers/queues.ts` (the 5 Bull queue defs + `queues` array),
  `workers/index.ts` (worker boot + `.process()` registration),
  `workers/processors/` (`scanProcessor`, `discoverProcessor`,
  `imageProcessor`, `validationProcessor`), `workers/discoverCron.ts`
  (recurring discover job), `jobs/queueCleaner.ts` (stale-job cleanup)
- **Queues (5 Bull queues only):** `library-scan` (job name `scan` → §2),
  `discover-weekly` (→ §5), `image-optimization` (→ §7),
  `file-validation` (→ §2 dedup/validate), `audio-analysis` (→ §8).
  There is no `QUEUE_NAMES` constant. Downloads are NOT a Bull queue (see §6).
- **Symptoms:** jobs stuck, queue backlog, worker crash loop, recurring job
  not firing. Check Redis (`redis-cli`), Bull job states.
- _Done 2026-05-29:_ rewrote this section from a fabricated ~24-queue model
  (nonexistent `queue/index.ts`/`QUEUE_NAMES`/`queueProcessors.ts`/`scheduler.ts`)
  to the real architecture: 5 Bull queues in `workers/queues.ts`, processors in
  `workers/processors/`. Corrected the per-section Queues lines in §2/5/6/7/8 too.

## 15. Platform / Boot / Routing / Schema

Foundation. Touch carefully.

- **Files:** `backend/src/index.ts` (route mounts, middleware order),
  `frontend/server.js` (proxy: socket.io + streaming + long API),
  `backend/prisma/schema.prisma` (data truth), `Dockerfile`,
  `docker-compose.yml` (prod, monolith), `docker-compose.dev.yml` (dev stack)
- **Invariants:** app API `/api/*`, Subsonic `/rest/*`, keep proxy
  assumptions for long-running requests. External proxy only exposes `3030`.
- **Symptoms:** boot failure, 502 via proxy, migration drift, route 404,
  build mismatch (`docker exec lidify cat /app/frontend/.next/BUILD_ID`).

---

## Quick symptom → section

| Symptom | Section |
|---|---|
| Can't log in / 401 | 1 |
| Tracks missing / dupes after scan | 2, 14 |
| No sound / double play on this device | 3 |
| Command controls wrong device | 4 |
| Same recs every time / stale discover | 5 |
| Download stuck / Lidarr silent | 6, 14 |
| Missing artwork / API rate-limit | 7, 14 |
| Analysis stuck pending | 8, 14 |
| External Subsonic client fails | 9 |
| Setting won't save | 11 |
| Jobs piling up in Redis | 14 |
| 502 / route 404 / boot fail | 15 |
