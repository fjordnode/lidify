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
