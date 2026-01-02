# Lidify Fork

A fork of Lidify (self-hosted music streaming) with significant enhancements: remote playback, improved Lidarr integration, ML audio analysis fixes, AI recommendations, and Subsonic API compatibility.

## Quick Reference

### Build & Deploy

```bash
# Build (from repo directory)
cd /mnt/cache/appdata/compose/lidify/repo
docker build -t lidify-remote:latest .

# Deploy (from compose directory)
cd /mnt/cache/appdata/compose/lidify
docker compose up -d --force-recreate

# View logs
docker logs lidify --tail 100 -f

# Verify frontend rebuilt
docker exec lidify cat /app/frontend/.next/BUILD_ID

# Force clean rebuild (if changes not appearing)
docker rmi lidify-remote:latest
docker build --no-cache -t lidify-remote:latest .
```

### Clear Caches

```bash
# Redis (playlists, API responses)
docker exec lidify /usr/bin/redis-cli FLUSHALL

# Re-analyze all tracks (after ML model changes)
docker exec lidify psql -U lidify -d lidify -c \
  "UPDATE \"Track\" SET \"analysisStatus\" = 'pending' WHERE \"analysisMode\" = 'standard';"
```

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Docker Container                      │
│  ┌──────────────────┐      ┌──────────────────────────┐ │
│  │  Next.js + Proxy │      │  Express Backend         │ │
│  │  (port 3030)     │─────►│  (port 3006)             │ │
│  │  /api/socket.io  │ WS   │  - REST API              │ │
│  │  proxy           │      │  - Socket.io server      │ │
│  └──────────────────┘      └──────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
         ▲
   Reverse Proxy (only needs port 3030)
```

- **Frontend**: Next.js on port 3030 (custom server with WebSocket proxy)
- **Backend**: Express on port 3006 (internal only)
- **Audio Analyzer**: Python/Essentia sidecar service

## Key File Locations

### Remote Playback
| File | Purpose |
|------|---------|
| `frontend/lib/remote-playback-context.tsx` | Device list, `activePlayerId`, `isActivePlayer` |
| `frontend/lib/remote-aware-audio-controls-context.tsx` | Command forwarding to remote devices |
| `frontend/components/player/HowlerAudioElement.tsx` | Audio playback with `isActivePlayer` guards |
| `backend/src/websocket/remotePlayback.ts` | Socket.io server for device sync |

### Playlists
| File | Purpose |
|------|---------|
| `backend/src/services/programmaticPlaylists.ts` | All "Made for You" generators |
| `backend/src/routes/library.ts` | Radio mode endpoints |

### Audio Analysis
| File | Purpose |
|------|---------|
| `services/audio-analyzer/analyzer.py` | ML mood analysis (Essentia + TensorFlow) |
| `backend/src/workers/artistEnrichment.ts` | Album cover enrichment |

### Lidarr Integration
| File | Purpose |
|------|---------|
| `backend/src/services/lidarr.ts` | Lidarr API client |
| `backend/src/services/simpleDownloadManager.ts` | Download orchestration |

### Subsonic API
| File | Purpose |
|------|---------|
| `backend/src/routes/subsonic.ts` | All Subsonic endpoints |
| `backend/src/middleware/subsonicAuth.ts` | Token/password auth |

## Important Patterns

### Artist Diversity in Playlists
```typescript
// Fetch ALL matching tracks, then diversify
const tracks = await prisma.track.findMany({
    where: { ... },
    include: { album: { select: { coverUrl: true, artist: { select: { id: true } } } } },
    // No take/orderBy - fetch entire pool
});
const diverse = diversifyByArtist(tracks, 2);  // Max 2 per artist
```

### Remote Playback Display
```typescript
// Use remote state when controlling another device
const displayTrack = (!isActivePlayer && activePlayerState?.currentTrack)
    ? activePlayerState.currentTrack
    : currentTrack;
```

### Temp MBID Handling
```typescript
// Always check for temp MBIDs before querying external services
const hasValidMbid = album.rgMbid && !album.rgMbid.startsWith("temp-");
if (hasValidMbid) {
    // Query Cover Art Archive, etc.
}
```

## Gotchas

1. **Prisma queries without `orderBy`** return by insertion order (primary key) - causes bias
2. **`take: N` limits** always return same N tracks without randomization
3. **Artist links** should use `artist.id` (CUID), not `artist.mbid` (can be temp)
4. **Lidarr metadata refresh** is async - wait for completion before album search
5. **Essentia mood models** have inconsistent column ordering - check per-model

## Environment Variables

```yaml
# AI Recommendations (OpenRouter)
OPENROUTER_API_KEY=sk-or-v1-...

# Audio Analyzer limits
MAX_FILE_SIZE_MB=100      # Skip oversized files
BASE_TRACK_TIMEOUT=120    # Per-track timeout (seconds)
```

## Detailed History

See [DEVELOPMENT_HISTORY.md](./DEVELOPMENT_HISTORY.md) for comprehensive changelog including:
- Remote playback implementation details
- Lidarr integration improvements
- ML mood analysis bug fixes
- Symfonium/Subsonic compatibility fixes
- All code patterns and debugging tips
