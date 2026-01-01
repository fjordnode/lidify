# Lidify - Remote Playback Feature

## Overview

Implementing a Spotify Connect-like remote playback feature that allows controlling music playback across multiple devices on the same LAN.

## Architecture

```
┌─────────────────┐     WebSocket      ┌─────────────────┐
│   Device A      │◄──────────────────►│  Lidify Server  │
│   (Controller)  │    Socket.io       │  (Express:3006) │
└─────────────────┘                    └────────┬────────┘
                                                │
┌─────────────────┐     WebSocket              │
│   Device B      │◄───────────────────────────┘
│   (Active Player)│
└─────────────────┘
```

**Expected Behavior:**
1. Only ONE device plays audio at any time (the "active player")
2. When a remote device is selected, local playback STOPS
3. All playback commands (play/pause/next/prev/seek/volume) forward to the active player
4. The controller shows what's playing on the remote device

## Reverse Proxy Compatibility

The frontend includes a custom server (`frontend/server.js`) that proxies WebSocket connections internally, eliminating the need for special reverse proxy configuration.

```
┌─────────────────────────────────────────────────────────┐
│                    Docker Container                      │
│                                                          │
│  ┌──────────────────┐      ┌──────────────────────────┐ │
│  │  Next.js + Proxy │      │  Express Backend         │ │
│  │  (port 3030)     │─────►│  (port 3006)             │ │
│  │                  │ WS   │  - REST API              │ │
│  │  /api/socket.io  │proxy │  - Socket.io server      │ │
│  └──────────────────┘      └──────────────────────────┘ │
│           ▲                                              │
└───────────│──────────────────────────────────────────────┘
            │
     Reverse Proxy (Traefik/nginx/Caddy)
     - Only needs standard HTTP proxy to port 3030
     - No special WebSocket configuration required

```

**How it works:**
- `frontend/server.js` uses `http-proxy-middleware` to intercept `/api/socket.io` requests
- WebSocket upgrade requests are proxied to the backend on port 3006
- Users only need to expose port 3030 - no separate WebSocket routing needed

**Standard reverse proxy config (example for Traefik):**
```yaml
labels:
  - traefik.enable=true
  - traefik.http.routers.lidify.rule=Host(`lidify.example.com`)
  - traefik.http.services.lidify.loadbalancer.server.port=3030
```

## Files Involved

### Frontend - Core Context Files

| File | Purpose |
|------|---------|
| `frontend/server.js` | Custom Next.js server with WebSocket proxy to backend |
| `frontend/lib/remote-playback-context.tsx` | WebSocket connection, device list, `activePlayerId` state, `isActivePlayer` flag |
| `frontend/lib/remote-aware-audio-controls-context.tsx` | Wraps audio controls to forward commands to remote device when not active |
| `frontend/hooks/useRemotePlaybackIntegration.ts` | Bridges remote commands with audio controls, handles state broadcasting |
| `frontend/lib/audio-hooks.tsx` | Unified `useAudio` hook - updated to use remote-aware controls |

### Frontend - UI Components

| File | Purpose |
|------|---------|
| `frontend/components/player/DeviceSelector.tsx` | Dropdown UI for selecting devices |
| `frontend/components/player/FullPlayer.tsx` | Desktop player - shows remote control indicator, uses `displayTrack` |
| `frontend/components/player/MiniPlayer.tsx` | Compact player (mobile toast + desktop bottom bar) - uses `displayTrack` |
| `frontend/components/player/OverlayPlayer.tsx` | Fullscreen mobile player - has volume slider, uses `displayTrack` |
| `frontend/components/player/HowlerAudioElement.tsx` | Actual audio playback - has `isActivePlayer` guards |
| `frontend/components/player/RemoteVolumeCapture.tsx` | Silent audio for hardware volume button capture (experimental) |
| `frontend/components/providers/ConditionalAudioProvider.tsx` | Provider hierarchy |

### Backend

| File | Purpose |
|------|---------|
| `backend/src/websocket/remotePlayback.ts` | Socket.io server handling device registration, commands, state sync |
| `backend/src/routes/remotePlayback.ts` | REST API for device listing |

## What Has Been Accomplished

### 1. Provider Hierarchy Fixed
- `HowlerAudioElement` moved INSIDE `RemotePlaybackProvider` so it can access `isActivePlayer`

### 2. Play Guards Added
All 7 `howlerEngine.play()` calls in HowlerAudioElement now check `isActivePlayerRef.current`:
- Line 147: Repeat mode
- Line 328: Same track resume
- Line 428: Post-load autoplay
- Line 550: isPlaying effect
- Line 662: Cache polling reload
- Line 837: Seek reload fallback
- Line 848: Post-seek resume

### 3. Transfer Race Condition Fixed
`transferPlayback()` now:
1. Sets `activePlayerId` FIRST (so guards see it immediately)
2. Stops local playback
3. Waits 50ms before emitting WebSocket events

### 4. Command Forwarding
`RemoteAwareAudioControlsContext` wraps all controls:
- If `isActivePlayer` is true → execute locally
- If `isActivePlayer` is false → forward via WebSocket

### 5. State Broadcasting
- Remote device broadcasts state changes via WebSocket
- Track changes broadcast IMMEDIATELY (bypass 500ms debounce)
- Controller receives updates via `playback:stateUpdate` event
- Interval broadcasts every 1 second while playing (for timer sync)

### 6. Persistence
- `activePlayerId` persisted to localStorage (`lidify_active_player_id`)
- Restored on page load

### 7. Remote Control Indicator
- Shows floating bar when controlling remote device
- Displays: device name, album art, track title, artist, play/pause status

### 8. Controller Display Uses Remote State (NEW)
All player UI components now use `activePlayerState` when controlling a remote device:
- **Timer/progress**: Uses `activePlayerState.currentTime`
- **Track info**: Uses `activePlayerState.currentTrack` (title, artist, album art)
- **Duration**: Uses `activePlayerState.currentTrack.duration`
- **isPlaying**: Uses `activePlayerState.isPlaying`

This ensures the controller displays the remote device's actual state immediately when tracks change.

## Current Status

Remote playback is now **fully functional**:
- ✅ Commands (play, pause, next, prev, seek, volume) correctly forward to active player
- ✅ Timer syncs with the active player's current time
- ✅ Track info (title, artist, artwork) updates immediately on the controller
- ✅ State persists across page refreshes via localStorage
- ✅ Volume control syncs with remote player
- ✅ Mobile volume slider in OverlayPlayer (fullscreen player view)

### Recent Updates (Dec 2025)

#### Controller Display Uses Remote State
The controller UI now uses `activePlayerState` for track info display:
- `FullPlayer.tsx` - uses `displayTrack` derived from `activePlayerState.currentTrack`
- `MiniPlayer.tsx` - same pattern
- `OverlayPlayer.tsx` - same pattern + volume slider

#### Mobile Volume Control
Added volume slider to `OverlayPlayer.tsx` (the fullscreen player on mobile):
- Location: Bottom of the player, after shuffle/repeat/vibe controls
- Uses **local state** (`localVolume`) for smooth dragging without jitter
- Only syncs from remote if value differs by >2% from what user set (prevents snap-back)
- Displays volume icon (tap to mute/unmute) + slider + percentage

```typescript
// Smooth volume slider pattern (OverlayPlayer.tsx)
const [localVolume, setLocalVolume] = useState(displayVolume * 100);
const lastSetVolumeRef = useRef<number | null>(null);

// Only sync from remote if it's different from what we set
useEffect(() => {
    const remoteVol = Math.round(displayVolume * 100);
    if (lastSet === null || Math.abs(remoteVol - lastSet) > 2) {
        setLocalVolume(remoteVol);
    }
}, [displayVolume]);

const handleVolumeChange = (value: number) => {
    setLocalVolume(value);  // Immediate UI update
    lastSetVolumeRef.current = value;
    setVolume(value / 100);  // Send to player
};
```

#### Hardware Volume Button Capture (Experimental)
`RemoteVolumeCapture.tsx` component attempts to capture Android hardware volume buttons when controlling a remote device by playing a silent audio element. This is hacky and may not work reliably on all devices/browsers.

#### Display Volume Logic
When controlling a remote device, volume display uses remote state:
```typescript
const displayVolume = (!isActivePlayer && activePlayerState?.volume !== undefined)
    ? activePlayerState.volume
    : volume;
```

## Debugging Tips

### Console logs to verify remote playback is working:
```
[RemotePlayback] Setting activePlayerId: device_xxx
[RemotePlayback] Restored activePlayerId from storage: device_xxx
[RemoteAware] next: isActivePlayer=false, activePlayerId=device_xxx
[RemoteAware] Forwarding next to device_xxx
[RemoteIntegration] Interval broadcast: time=XX.X, playing=true
[RemotePlayback] State update received from device: device_xxx
```

### Check localStorage in browser DevTools:
```javascript
localStorage.getItem("lidify_active_player_id")
```

## Commands

```bash
# Build (from repo directory)
cd /mnt/cache/appdata/compose/lidify/repo
docker build -t lidify-remote:latest .

# Deploy (from compose directory)
cd /mnt/cache/appdata/compose/lidify
docker compose up -d --force-recreate

# View logs
docker logs lidify --tail 100 -f

# Check BUILD_ID to verify frontend was rebuilt
docker exec lidify cat /app/frontend/.next/BUILD_ID
```

### Build Notes
- The Dockerfile is in `/mnt/cache/appdata/compose/lidify/repo/`
- The docker-compose.yml is in `/mnt/cache/appdata/compose/lidify/`
- Image tag must be `lidify-remote:latest` (what compose expects)
- If changes aren't appearing, check the BUILD_ID changed
- Docker layer caching can be aggressive - delete old image if needed:
  ```bash
  docker rmi lidify-remote:latest
  docker build --no-cache -t lidify-remote:latest .
  ```

## Key Code Locations

### isActivePlayer calculation
```typescript
// frontend/lib/remote-playback-context.tsx:177
const isActivePlayer = activePlayerId === null || activePlayerId === currentDeviceId;
```

### Command forwarding logic
```typescript
// frontend/lib/remote-aware-audio-controls-context.tsx:121-146
const executeOrForward = useCallback((command, localAction, payload) => {
    if (isActivePlayer) {
        localAction();  // Execute locally
    } else if (activePlayerId) {
        sendCommand(activePlayerId, command, payload);  // Forward to remote
    } else {
        localAction();  // Fallback to local
    }
}, [isActivePlayer, activePlayerId, sendCommand]);
```

### HowlerAudioElement guard
```typescript
// frontend/components/player/HowlerAudioElement.tsx:527-537
if (isPlaying) {
    if (!isActivePlayer) {
        console.log("[HowlerAudioElement] Blocking local play - not active player");
        return;
    }
    howlerEngine.play();
}
```

### displayTrack pattern (for showing remote track info)
```typescript
// Used in FullPlayer.tsx, MiniPlayer.tsx, OverlayPlayer.tsx
const displayTrack = (!isActivePlayer && activePlayerState?.currentTrack)
    ? activePlayerState.currentTrack
    : currentTrack;

// Remote track has different shape than local Track type:
// - artist: string (not object)
// - coverArt: string (not album.coverArt)
const album = (displayTrack as any).album;
const coverArt = (album && typeof album === 'object' && album.coverArt)
    ? album.coverArt
    : (displayTrack as any).coverArt;
```

### displayVolume pattern (for syncing volume with remote)
```typescript
// Used in MiniPlayer.tsx, OverlayPlayer.tsx
const displayVolume = (!isActivePlayer && activePlayerState?.volume !== undefined)
    ? activePlayerState.volume
    : volume;
```

---

## Lidarr Integration Improvements (Dec 2025)

### Overview

Several improvements were made to the Lidarr integration to fix download reliability and automatic library sync issues.

### Changes from Original Repo

#### 1. Quality Profile Selection
**Files Modified:**
- `backend/prisma/schema.prisma` - Added `lidarrQualityProfileId` field to SystemSettings
- `backend/src/routes/systemSettings.ts` - Added `/lidarr-quality-profiles` endpoint (before auth middleware)
- `backend/src/services/lidarr.ts` - Updated to use configured quality profile instead of hardcoded `1`
- `frontend/features/settings/types.ts` - Added `lidarrQualityProfileId` to SystemSettings type
- `frontend/features/settings/hooks/useSystemSettings.ts` - Added default value
- `frontend/features/settings/components/sections/LidarrSection.tsx` - Added quality profile dropdown

**What it does:**
- Allows selecting which Lidarr quality profile to use for downloads (e.g., "Lossless" instead of "Any")
- Dropdown fetches available profiles from Lidarr API
- Profile selection persists in database

#### 2. Artist Deletion Protection
**File Modified:** `backend/src/services/lidarr.ts`

**Added:**
```typescript
async hasActiveDownloads(lidarrArtistId: number): Promise<boolean>
```

**What it does:**
- Before deleting an artist, checks if they have active downloads in Lidarr's queue
- Prevents orphaned downloads (downloads that can't be imported because the artist was deleted)
- Both `deleteArtist()` and `deleteArtistById()` now check before deleting

#### 3. Metadata Refresh Wait
**File Modified:** `backend/src/services/lidarr.ts` (in `addArtist()`)

**What it does:**
- When adding a new artist to Lidarr, waits up to 30 seconds for metadata refresh to complete
- Polls Lidarr command status every 2 seconds
- Prevents "album not found" errors when downloading from newly added artists
- Previously, the metadata refresh was fire-and-forget, causing race conditions

#### 4. Artist Name Fallback Lookup
**File Modified:** `backend/src/services/lidarr.ts` (in `addAlbum()`)

**What it does:**
- When looking up an artist in Lidarr, first tries MBID match
- If MBID doesn't match, falls back to case-insensitive name match
- Prevents duplicate artist creation when MBIDs differ between Lidify and Lidarr

```typescript
// Fallback: try to find by name if MBID didn't match
if (!artist && artistName) {
    const normalizedName = artistName.toLowerCase().trim();
    artist = existingArtists.data.find(
        (a: LidarrArtist) =>
            a.artistName.toLowerCase().trim() === normalizedName
    );
}
```

### Lidarr Webhook Setup

For automatic library sync after Lidarr imports, a webhook must be configured:

**In Lidarr → Settings → Connect → Add → Webhook:**

| Field | Value |
|-------|-------|
| Name | `Lidify` |
| URL | `http://host.docker.internal:3030/api/webhooks/lidarr` |
| Method | `POST` |
| On Grab | ✅ |
| On Release Import | ✅ |
| On Download Failure | ✅ |
| On Import Failure | ✅ |

**Important:** Lidarr's docker-compose needs `extra_hosts` for the webhook to work on Linux:

```yaml
services:
  lidarr:
    # ... other config ...
    extra_hosts:
      - "host.docker.internal:host-gateway"
```

### Database Migration

After updating, run this SQL to add the quality profile column:

```sql
ALTER TABLE "SystemSettings" ADD COLUMN IF NOT EXISTS "lidarrQualityProfileId" INTEGER;
```

Or let Prisma handle it on container startup.

### Debugging Lidarr Integration

```bash
# Check webhook events
docker logs lidify 2>&1 | grep "WEBHOOK"

# Check download flow
docker logs lidify 2>&1 | grep -i "download\|lidarr\|artist"

# Check Lidarr queue
docker logs lidarr 2>&1 | grep -i "download\|grab\|import"

# Verify webhook config in Lidarr
docker exec lidarr curl -s "http://localhost:8686/api/v1/notification" \
  -H "X-Api-Key: YOUR_API_KEY" | jq '.[].name'
```

#### 5. Artist Name Validation (Bug Fix)
**File Modified:** `backend/src/services/simpleDownloadManager.ts` (in `startDownload()`)

**What it does:**
- Before trusting an artist MBID from MusicBrainz, validates the artist name matches
- Prevents downloading wrong artist when MusicBrainz album data has incorrect artist credits
- If names don't match, falls back to name-based matching in Lidarr

```typescript
// Validate artist name matches before trusting MBID
const requestedNorm = artistName.toLowerCase().trim();
const mbNorm = mbArtistName.toLowerCase().trim();

if (mbNorm === requestedNorm || mbNorm.includes(requestedNorm) || requestedNorm.includes(mbNorm)) {
    artistMbid = mbArtistId;
} else {
    console.warn(`   Artist name mismatch - ignoring MBID`);
    // Will use name-based matching instead
}
```

**Bug this fixes:** Discovery downloads could add the wrong artist (e.g., "Robert Schumann" instead of "Robert Taylor") when MusicBrainz album data had incorrect artist credits.

### Known Issues

1. **Discovery cache can hold stale temp MBIDs** - If an artist shows a temp ID, try hard refresh or wait for cache to expire
2. **First download attempt may fail** - If MBID lookup or indexer search times out, retry usually works

---

## Audio Analyzer Improvements (Dec 2025)

### Problem

The audio analyzer would get stuck processing large hi-res FLAC files (24-bit/96kHz+, 100-600MB), causing:
- Batch timeouts (5-minute limit exceeded)
- All tracks in the batch stuck in "processing" status
- Infinite retry loops as failed tracks reset on container restart

### Solution

**Files Modified:** `services/audio-analyzer/analyzer.py`

#### 1. File Size Limit
```python
MAX_FILE_SIZE_MB = int(os.getenv('MAX_FILE_SIZE_MB', '100'))
```
- Files exceeding limit are skipped before processing
- Marked as permanently failed (won't retry)

#### 2. Permanent Failure Handling
Tracks are marked as permanent failures (retry count = MAX_RETRIES) for:
- Oversized files
- Timeout errors
- Memory errors

```python
def _save_failed(self, track_id: str, error: str, permanent: bool = False):
    if permanent:
        # Set retry count to MAX_RETRIES immediately
```

#### 3. Scaled Timeouts
```python
BASE_TRACK_TIMEOUT = int(os.getenv('BASE_TRACK_TIMEOUT', '120'))
MAX_TRACK_TIMEOUT = int(os.getenv('MAX_TRACK_TIMEOUT', '600'))
```

### Configuration

```yaml
environment:
  - MAX_FILE_SIZE_MB=100    # Skip files larger than this (0 = disabled)
  - BASE_TRACK_TIMEOUT=120  # Base timeout per track in seconds
  - MAX_TRACK_TIMEOUT=600   # Maximum timeout even for large files
```

### Log Messages

```
⊘ Skipped: file.flac - File too large (123.7MB > 100MB limit)
⊘ Timeout (permanent): file.flac
✓ Completed (67.7MB): file.flac
```

---

## ML Mood Analysis Fix (Dec 2025)

### Problem

The "Enhanced mode" ML mood analysis was **never actually working**. All 32K+ tracks were analyzed with "Standard mode" heuristics instead of real ML predictions. This caused:
- Playlist generators falling back to unreliable heuristics
- No `moodHappy`, `moodSad`, `moodRelaxed`, `moodAggressive` values in database
- "Chill Mix" containing death metal, "Happy Vibes" containing black metal

### Root Causes

#### Bug 1: Model Filename Mismatch
**Dockerfile** downloaded Discogs EfficientNet models:
```
discogs-effnet-bs64-1.pb
mood_happy-discogs-effnet-1.pb
```

**Analyzer code** looked for MusiCNN models:
```python
'musicnn': os.path.join(MODEL_DIR, 'msd-musicnn-1.pb'),  # DOESN'T EXIST
'mood_happy': os.path.join(MODEL_DIR, 'mood_happy-msd-musicnn-1.pb'),  # DOESN'T EXIST
```

Result: Model loading silently failed, fell back to Standard mode for ALL tracks.

#### Bug 2: Classification Column Order Inversion
The Discogs EfficientNet models have **inconsistent column ordering** per model:

| Model | Column 0 | Column 1 | Positive Class |
|-------|----------|----------|----------------|
| mood_aggressive | aggressive | not_aggressive | **Column 0** |
| mood_happy | happy | non_happy | **Column 0** |
| mood_sad | non_sad | sad | **Column 1** |
| mood_relaxed | non_relaxed | relaxed | **Column 1** |
| danceability | danceable | not_danceable | **Column 0** |
| voice_instrumental | instrumental | voice | **Column 1** |

Original code assumed column 1 was always positive:
```python
positive_probs = preds[:, 1]  # WRONG for half the models
```

### Solution

**File Modified:** `services/audio-analyzer/analyzer.py`

#### Fix 1: Correct Model Paths
```python
MODELS = {
    'effnet': os.path.join(MODEL_DIR, 'discogs-effnet-bs64-1.pb'),
    'mood_happy': os.path.join(MODEL_DIR, 'mood_happy-discogs-effnet-1.pb'),
    # ... etc
}
```

#### Fix 2: Use TensorflowPredictEffnetDiscogs
```python
from essentia.standard import TensorflowPredictEffnetDiscogs
self.effnet_model = TensorflowPredictEffnetDiscogs(
    graphFilename=MODELS['effnet'],
    output="PartitionedCall:1"
)
```

#### Fix 3: Per-Model Column Selection
```python
# Column order verified from model metadata JSON files at essentia.upf.edu
positive_col = 0 if model_name in ['mood_aggressive', 'mood_happy', 'danceability'] else 1
positive_probs = preds[:, positive_col]
```

### Verification

After fix, metal tracks correctly classified:
```
Manowar - Thor (The Powerhead):
  mood_aggressive: 0.964 (was 0.036 before fix)
  mood_happy: 0.279
  mood_relaxed: 0.034
```

### Re-Analysis Required

All existing tracks need re-analysis to populate ML mood fields:
```sql
UPDATE "Track" SET "analysisStatus" = 'pending', "analysisMode" = NULL
WHERE "analysisMode" = 'standard';
```

### Why This Wasn't Caught

1. **Silent fallback**: Standard mode ran without obvious errors
2. **Plausible outputs**: Heuristic valence/arousal values looked reasonable
3. **Buried error logs**: "Base MusiCNN model not found" error lost in startup noise
4. **Working playlists**: Generators fell back to Standard mode queries

---

## Playlist Diversity Fix (Dec 2025)

### Problem

"Made for You" playlists were dominated by artists imported early (e.g., 90% AC/DC). Root causes:
1. Prisma queries without `orderBy` return by insertion order (primary key)
2. `take: 200` limits pool to first 200 matching tracks
3. No artist diversity enforcement

### Solution

**Files Modified:**
- `backend/src/services/programmaticPlaylists.ts`
- `backend/src/routes/library.ts`

#### 1. Diversity Helper Function
```typescript
function diversifyByArtist<T extends { album?: { artist?: { id?: string } } }>(
    tracks: T[],
    maxPerArtist: number = 2
): T[] {
    const shuffled = [...tracks].sort(() => Math.random() - 0.5);
    const artistCounts = new Map<string, number>();
    const diverse: T[] = [];

    for (const track of shuffled) {
        const artistId = track.album?.artist?.id || `unknown-${Math.random()}`;
        const count = artistCounts.get(artistId) || 0;
        if (count < maxPerArtist) {
            diverse.push(track);
            artistCounts.set(artistId, count + 1);
        }
    }
    return diverse.sort(() => Math.random() - 0.5);
}
```

#### 2. Query Changes
All fixed generators now:
- Include artist ID: `include: { album: { select: { coverUrl: true, artist: { select: { id: true } } } } }`
- **Remove `take` and `orderBy`** - fetch ALL matching tracks from entire library
- Apply diversity: `diversifyByArtist(tracks, 2)` - shuffles randomly + limits per artist

**Why no `take` limit?**
Using `take: 300` with `orderBy: { id: 'desc' }` just swaps "always oldest" for "always newest" - still biased. Fetching all matching tracks (e.g., 32K unplayed) and randomly sampling gives true variety.

```typescript
// Before (biased to newest 300):
const tracks = await prisma.track.findMany({
    where: { ... },
    take: 300,
    orderBy: { id: 'desc' },
});

// After (entire library pool):
const tracks = await prisma.track.findMany({
    where: { ... },
    // No take, no orderBy
});
const diverse = diversifyByArtist(tracks, 2);  // Shuffles + limits per artist
```

### Fixed Generators

| Generator | Status |
|-----------|--------|
| `generateDeepCuts` | ✅ Fixed |
| `generateChillMix` | ✅ Fixed |
| `generateWorkoutMix` | ✅ Fixed |
| `generateHighEnergyMix` | ✅ Fixed |
| `generateLateNightMix` | ✅ Fixed |
| `generatePartyMix` | ⏳ Pending (complex - uses Genre table) |
| `generateFocusMix` | ⏳ Pending |
| `generateHappyMix` | ⏳ Pending |
| `generateMelancholyMix` | ⏳ Pending |
| Others... | ⏳ Pending |

### Radio Mode (library.ts)

Also fixed `diversifyTracksByArtist` helper added for workout radio and other radio modes.

### Cache Clearing

After deploying changes, clear Redis cache to regenerate playlists:
```bash
docker exec lidify /usr/bin/redis-cli FLUSHALL
```

### Last.fm Enrichment

**Disabled** - The Last.fm mood tag enrichment was found to have only ~1% hit rate (most tracks return "no tags"). The Essentia-generated mood tags from audio analysis provide much better coverage (14K+ tracks tagged as groovy, dance, moody, etc.).

---

## AI Similar Artists Feature (Dec 2025)

### Overview

AI-powered artist recommendations using OpenRouter (multi-provider LLM gateway), with conversational refinement.

### OpenRouter Migration (Dec 31, 2025)

**Migrated from OpenAI direct to OpenRouter** for access to 200+ models from multiple providers (OpenAI, Anthropic, Google, Meta, DeepSeek, etc.).

**Files Changed:**
- `backend/src/services/openai.ts` → `backend/src/services/openrouter.ts` - Renamed and updated
- `backend/src/config.ts` - `OPENAI_API_KEY` → `OPENROUTER_API_KEY`
- `backend/prisma/schema.prisma` - `openaiEnabled/openaiModel` → `openrouterEnabled/openrouterModel`
- `docker-compose.yml` - Environment variable renamed
- All frontend references updated

**Database Migration:**
```sql
-- Migration: 20251231000000_rename_openai_to_openrouter
ALTER TABLE "SystemSettings" ADD COLUMN "openrouterEnabled" BOOLEAN DEFAULT false;
ALTER TABLE "SystemSettings" ADD COLUMN "openrouterModel" TEXT DEFAULT 'openai/gpt-4o-mini';
-- Copies data from old columns, then drops them
```

### Features

**Core:**
- Button on artist page opens slide-over panel
- 6-8 AI-generated similar artist recommendations
- Shows artist photo (from Deezer), reason, recommended album
- "In Library" badge for artists already in collection
- Click recommendation → searches for artist (uses search to get proper MBID)

**Conversational Refinement:**
- Chat input for follow-up requests ("more electronic", "female vocalists")
- Conversation history with message bubbles
- Redis stores conversation (1hr TTL)
- SessionStorage caches conversation per artist (survives page refresh)

**UI Enhancements:**
- **Regenerate button** - Refresh icon in header clears cache and fetches fresh recommendations
- **Model label** - Small monospace text below header shows which model served the results (e.g., `deepseek/deepseek-chat-v3-0324`)
- **Searchable model dropdown** - Settings page has searchable dropdown with all 200+ OpenRouter models

### Settings

OpenRouter must be enabled in Settings → AI & Enhancement Services:
- Enable OpenRouter toggle (grayed out if API key not configured)
- Select model from searchable dropdown (GPT-4o Mini, DeepSeek, Claude, Gemini, etc.)

**Environment Variable:**
```bash
# In docker-compose.yml or .env
OPENROUTER_API_KEY=sk-or-v1-...
```

Get your API key at: https://openrouter.ai/keys

### Recommended Models

| Model | Cost/rec | Notes |
|-------|----------|-------|
| `deepseek/deepseek-chat-v3-0324` | ~$0.0004 | Best value, excellent quality |
| `google/gemini-2.0-flash-001` | ~$0.002 | Fast, good knowledge |
| `openai/gpt-4o-mini` | ~$0.001 | Reliable, good JSON formatting |
| `anthropic/claude-3-haiku` | ~$0.001 | Fast reasoning |

### Key Implementation Details

**Artist ID handling for recommendations:**
```typescript
// ArtistActionBar passes fallback chain
artistId={artist.id || artist.mbid || artist.name}
```

**Discovery artists navigate to search:**
```typescript
// Non-library recommendations go through search for proper MBID
router.push(`/search?q=${encodeURIComponent(artist.artistName)}`);
```

**Mobile keyboard fix:**
```typescript
// Only auto-focus input on desktop to avoid keyboard popup on mobile
if (isOpen && messages.length > 0 && window.innerWidth >= 768) {
    inputRef.current?.focus();
}
```

### API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/system-settings/openrouter-status` | GET | Check if API key is configured |
| `/api/system-settings/openrouter-models` | GET | Fetch available models from OpenRouter |
| `/api/system-settings/test-openrouter` | POST | Test connection with selected model |
| `/api/artists/ai-chat/:artistId` | POST | Get AI recommendations (returns `model` in response) |

---

## Bug Fixes (Dec 2025)

### Lidarr Queue Cleanup Bug

**Problem:** Completed downloads were being deleted before import.

**Cause:** `clearLidarrQueue()` in `simpleDownloadManager.ts` treated `importPending` as a failure state. Downloads at 100% waiting for import were removed.

**Fix:** Removed `importPending` from failure conditions:
```typescript
// Before (WRONG - deleted completed downloads)
item.trackedDownloadState === "importPending" ||

// After (correct)
// Only: failed, error, importFailed, or warnings with messages
```

### Artist URL Using Temp MBID

**Problem:** Recently added artists got URLs like `/artist/temp-1767141916598-...` which led nowhere.

**Cause:** Frontend used `artist.mbid || artist.id` - temp MBIDs are truthy so they were used instead of database ID.

**Fix:** Changed all artist links to use `artist.id` (CUID) instead:
```typescript
// Before
href={`/artist/${artist.mbid || artist.id}`}

// After
href={`/artist/${artist.id}`}
```

**Files fixed:**
- `frontend/features/library/components/ArtistsGrid.tsx`
- `frontend/features/home/components/ArtistsGrid.tsx`
- `frontend/app/artists/page.tsx`
- `frontend/features/search/components/LibraryTracksList.tsx`
- `frontend/features/home/components/ContinueListening.tsx`
- `frontend/components/player/OverlayPlayer.tsx`
- `frontend/components/player/FullPlayer.tsx`
- `frontend/features/album/components/AlbumHero.tsx`

### Popular Tracks Album Display

**Enhancement:** Show album name instead of artist name (redundant on artist page).

**Additional:** When playing Deezer preview, album info from Deezer is displayed:
- `backend/src/services/deezer.ts` - Added `getTrackPreviewWithInfo()` returning album title/cover
- `backend/src/routes/artists.ts` - Preview endpoint returns album info
- `frontend/features/artist/hooks/usePreviewPlayer.ts` - Stores album info per track
- `frontend/features/artist/components/PopularTracks.tsx` - Shows Deezer album after preview

---

## Subsonic API - Symfonium Compatibility (Jan 2026)

### Overview

Fixed two major issues preventing Symfonium (Android music app) from working correctly with Lidify's Subsonic API, while Ultrasonic worked fine with the same server.

### Issue 1: "Last Played" Sorting Broken

**Symptom:** Sorting albums by "Last Played" in Symfonium produced alphabetical order instead of actual play history. "Recently Added" worked correctly.

**Root Cause Investigation:**

Analyzing Symfonium's debug logs revealed:
```sql
UPDATE albums SET last_played = (SELECT MAX(songs.last_played) FROM songs WHERE songs.album_id = albums._id)
```

Symfonium **derives** `albums.last_played` from `MAX(songs.last_played)` - it doesn't read the album's `played` field directly. The server was sending `played` on albums but NOT on songs.

**The Fix:**

Added `played` and `playCount` fields to all song responses.

**Files Modified:**
- `backend/src/utils/subsonicResponse.ts` - `formatTrackForSubsonic()` now accepts optional `playData` parameter
- `backend/src/routes/subsonic.ts` - All song endpoints now query Play table and pass data:
  - `search3.view` - Batch queries play data for all songs
  - `getAlbum.view` - Queries play data for album tracks
  - `getSong.view` - Queries play data for single track
  - `getRandomSongs.view` - Queries play data for random tracks
  - `getPlaylist.view` - Queries play data for playlist tracks
  - `getTopSongs.view` - Queries play data for top songs

**Code Pattern:**
```typescript
// Query play data for songs
const songIds = songs.map(s => s.id);
const songPlayData = songIds.length > 0 ? await prisma.$queryRaw<Array<{ trackId: string; lastPlayed: Date; playCount: bigint }>>`
    SELECT p."trackId", MAX(p."playedAt") as "lastPlayed", COUNT(p.id) as "playCount"
    FROM "Play" p
    WHERE p."trackId" = ANY(${songIds})
    GROUP BY p."trackId"
` : [];
const songLastPlayed = new Map(songPlayData.map(d => [d.trackId, d.lastPlayed]));
const songPlayCount = new Map(songPlayData.map(d => [d.trackId, Number(d.playCount)]));

// Pass to formatter
formatTrackForSubsonic(track, {
    played: songLastPlayed.get(track.id),
    playCount: songPlayCount.get(track.id) || 0,
})
```

### Issue 2: Album/Artist Artwork Missing

**Symptom:** Artwork visible in Lidify web but missing in Symfonium.

**Root Cause:** `getCoverArt.view` was doing `res.redirect(imageUrl)` to external URLs. Many Subsonic clients don't handle redirects well. Additionally, local covers stored as `native:xxx.jpg` weren't being resolved.

**The Fix:**

1. **Handle `native:` covers** - Serve local files directly from `/covers/` directory
2. **Proxy external URLs** - Fetch and pipe through instead of redirecting
3. **Cache external artwork** - Save to disk on first request, serve from cache thereafter

**File Modified:** `backend/src/routes/subsonic.ts` - `getCoverArt.view` endpoint

**Implementation:**
```typescript
// Handle native (local) cover files
if (imageUrl.startsWith("native:")) {
    const nativePath = imageUrl.replace("native:", "");
    const coverCachePath = path.join(coverCacheDir, nativePath);
    if (fs.existsSync(coverCachePath)) {
        res.set('Content-Type', 'image/jpeg');
        return fs.createReadStream(coverCachePath).pipe(res);
    }
}

// For external URLs, check cache first
const cacheFileName = `ext-${entityId}.jpg`;
const cachedFilePath = path.join(coverCacheDir, cacheFileName);

if (fs.existsSync(cachedFilePath)) {
    const stats = fs.statSync(cachedFilePath);
    const ageMs = Date.now() - stats.mtimeMs;
    if (ageMs < 7 * 24 * 60 * 60 * 1000) {  // 7 days
        return fs.createReadStream(cachedFilePath).pipe(res);
    }
}

// Download, cache, and serve
const imageResponse = await axios.get(imageUrl, { responseType: 'arraybuffer' });
fs.writeFileSync(cachedFilePath, imageResponse.data);
res.send(imageResponse.data);
```

**Cache Behavior:**
- Native covers: Already local, served directly (fast)
- External URLs: Cached to `/covers/ext-{entityId}.jpg` for 7 days
- First sync is slow (downloads all artwork), subsequent access is instant

### Debugging Tips

**Check what endpoints Symfonium calls:**
```bash
grep -o 'rest/[a-zA-Z0-9]*\.view' debug.log | sort | uniq -c | sort -rn
```

**Verify song responses include `played`:**
```bash
docker logs lidify 2>&1 | grep -A2 "search3"
# Look for: "played":"2026-01-01T..." in song objects
```

**Check cover art caching:**
```bash
docker exec lidify ls -la /app/cache/covers/ | head -20
```

### Key Insight

When Client A works and Client B doesn't with the same API, check **how each client stores and uses the data**, not just whether you're sending it. Symfonium's internal SQLite schema revealed it derives album metadata from songs, which wasn't obvious from the API spec alone.

---

## Known Issues / TODO

### Playback Position Persistence

**Current:** Playback position resets to start on page reload.

**TODO:** Add localStorage persistence:
- Save `currentTime` on time updates (throttled)
- Restore position when track loads
- Clear on track change/completion
