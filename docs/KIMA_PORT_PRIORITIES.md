# Kima Port Priorities

This is the current shortlist of Kima areas worth integrating into Lidify, ordered by practical value.

## 1. Download Recovery / Reconciliation

This is the strongest remaining Kima port target. The main value is operational reliability after a download has already started, not just the initial request path.

What Kima has:
- Transaction retry wrapper for serialization/deadlock conflicts in `kima/backend/src/services/simpleDownloadManager.ts`
- Periodic reconciliation against Lidarr state in `kima/backend/src/jobs/queueCleaner.ts`
- Explicit Lidarr queue sync to detect cancelled/completed jobs in `kima/backend/src/jobs/queueCleaner.ts`
- Local-library reconciliation when webhooks are missed in `kima/backend/src/jobs/queueCleaner.ts`
- Persisted webhook event reconciliation in `kima/backend/src/jobs/webhookReconciliation.ts`

What Lidify already has:
- Good matching logic and useful fallback behavior in `repo/backend/src/services/simpleDownloadManager.ts`
- Less infrastructure around races and missed events
- Longer coarse timeouts

What to port:
- `withTransaction()` pattern
- Queue sync / reconcile jobs
- Webhook event persistence + replay
- Local-library “did it already arrive?” reconciliation

Why it matters:
- Fewer stuck downloads
- Fewer false `processing forever` states
- Fewer cases where one missed webhook leaves the UI wrong

Risk:
- Low to medium if done incrementally
- Backend-only, no UX regression if careful

## 2. Playlist / Import Job Infrastructure

Kima is stronger on making long imports feel resilient rather than fast.

What Kima has:
- Preview jobs started asynchronously in `kima/backend/src/services/spotifyImport.ts`
- SSE progress events emitted during fetch/match phases
- Result persistence in Redis so reconnects do not lose the preview

What Lidify already has:
- Background processing after preview in `repo/backend/src/services/spotifyImport.ts`
- Real playlist-first flow and pending-track reconciliation
- A more brittle preview/import lifecycle overall when the client disconnects or large playlists take time

What to port:
- Job-id based preview API
- SSE progress updates for fetch/match/import phases
- Persisted job state/results for resume after refresh
- Timeout/recovery logic for stuck import jobs

Why it matters:
- Large playlists stop feeling flaky
- Browser refresh or network hiccup is less destructive
- Easier to reason about imports operationally

Risk:
- Medium, because it touches frontend + backend flow
- Still a clean subsystem if isolated

## 3. Mood-Analysis Recovery Logic

Do not replace the Lidify model stack. Port Kima’s reliability logic around the existing Discogs EffNet analyzer.

Status:
- Implemented in Lidify

What Kima has:
- Entropy-based OOD detection and normalization in `kima/services/audio-analyzer/analyzer.py`
- Contradictory-pair competition for `happy/sad` and `relaxed/aggressive`
- Variance-based shrinkage for uncertain predictions
- Stale-processing recovery that distinguishes `has embeddings already` from `actually stuck`
- Process-pool recreation after worker failure

What Lidify already has:
- Stronger Discogs EffNet mood path
- Column-order fix for inconsistent Essentia model outputs
- Simpler stale-track reset logic

What to port:
- OOD normalization
- Contradictory mood balancing
- Uncertainty shrinkage
- Smarter stale-track recovery
- Pool recreation after worker breakage

What was actually merged into Lidify:
- Kept Lidify’s Discogs EffNet analyzer backbone and column-order fix
- Kept Lidify’s artist-diverse mood-mix selection
- Ported entropy-based OOD normalization
- Ported contradictory mood balancing for `happy/sad` and `relaxed/aggressive`
- Ported variance-based uncertainty shrinkage
- Ported safer stale `processing` recovery within Lidify’s current schema limits
- Ported worker-pool recreation and interrupted-batch reset logic
- Ported `moodTags` fallback in `backend/src/services/moodBucketService.ts`

Why it matters:
- Mood output gets less nonsensical on weird tracks
- Analyzer survives crashes better
- Fewer tracks stuck in `processing`

Risk:
- Low to medium
- Best done behind current model outputs, not as a model swap

Practical note:
- New and reanalyzed tracks benefit immediately.
- Existing tracks already marked `completed` keep their old mood outputs until they are reanalyzed.
- A full audio reanalysis is likely worth doing if mood quality matters, because the new sanity checks only apply when tracks are analyzed again.

## 4. Subsonic Modular Refactor

This is mostly maintainability, not a direct behavior upgrade.

What Kima has:
- Subsonic split into route modules such as:
  - `kima/backend/src/routes/subsonic/index.ts`
  - `kima/backend/src/routes/subsonic/library.ts`
  - `kima/backend/src/routes/subsonic/playback.ts`
  - `kima/backend/src/routes/subsonic/playlists.ts`
  - `kima/backend/src/routes/subsonic/search.ts`
- Smaller helpers and mappers instead of one huge file

What Lidify already has:
- Better client behavior for real-world clients like Symfonium
- One very large router in `repo/backend/src/routes/subsonic.ts`

What to port:
- Only the file/module structure
- Some helper extraction patterns
- Not Kima behavior where it conflicts with Lidify’s existing client fixes

Why it matters:
- Easier to keep adding client quirks without breaking unrelated endpoints
- Easier to test pieces in isolation
- Less risk when touching Subsonic again

Risk:
- Medium to high if mixed with behavior changes
- Low if done as a pure refactor with tests first

## 5. Test Patterns / Coverage

Kima is not just “more tested”; it is tested in some of the brittle areas Lidify cares about.

What Kima has:
- Backend route/service tests around webhooks, scanner behavior, event stores, and search strategies
- Frontend e2e coverage around playlists, queue, playback, and vibe flows

What Lidify already has:
- A few targeted tests:
  - `repo/backend/src/tests/downloadDedup.test.ts`
  - `repo/backend/src/tests/albumCoverCache.test.ts`
  - `repo/backend/src/tests/imageProxy.test.ts`

What to port:
- Not raw test files blindly
- The test categories and harness patterns:
  - Webhook reconciliation
  - Music scanner path edge cases
  - Import/playlist lifecycle
  - Subsonic route compatibility
  - A couple of real e2e smoke flows

Why it matters:
- Makes future refactors much safer
- Especially important before touching Subsonic or downloads again

Risk:
- Low
- High payoff, but less visible to users immediately

## Recommended Order

1. Download reconciliation
2. Mood recovery logic
3. Import job/SSE flow
4. Tests around those first three
5. Subsonic modular refactor
