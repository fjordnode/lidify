# Lidify Agent Context

You read this file at the start of every fresh chat. Treat it as your working memory for this repo.

## Your Priority Order

When tradeoffs appear, choose in this exact order:

1. Playback reliability
2. Library/data integrity
3. Discovery quality and variety
4. Self-hosted operational simplicity

## Fast System Model (keep in your head)

- Frontend: Next.js + custom Node server on `3030`
- Backend: Express + Socket.io on `3006`
- Data: PostgreSQL (truth) + Redis (sessions/cache/queues)
- Workers: Bull queues + recurring jobs
- Analysis: Python Essentia sidecar at `services/audio-analyzer/analyzer.py`
- Compatibility API: Subsonic under `/rest/*`

Routing fact you must not break:

- `frontend/server.js` proxies `/api/socket.io`, streaming endpoints, and long-running API paths to backend
- External reverse proxies should only need to expose port `3030`

## High-Impact Files (start here before wider search)

### Playback / Remote Control
- `frontend/lib/remote-playback-context.tsx`
- `frontend/lib/remote-aware-audio-controls-context.tsx`
- `frontend/components/player/HowlerAudioElement.tsx`
- `backend/src/websocket/remotePlayback.ts`
- `backend/src/routes/remotePlayback.ts`

### Library / Discovery
- `backend/src/routes/library.ts`
- `backend/src/services/programmaticPlaylists.ts`
- `backend/src/services/discoverWeekly.ts`

### Integrations / Compatibility
- `backend/src/services/lidarr.ts`
- `backend/src/services/simpleDownloadManager.ts`
- `backend/src/routes/subsonic.ts`
- `backend/src/middleware/subsonicAuth.ts`

### Platform / Boot / Schema
- `backend/src/index.ts`
- `frontend/server.js`
- `backend/prisma/schema.prisma`
- `Dockerfile`
- `docker-compose.dev.yml`

## Non-Negotiable Invariants

### Remote playback correctness
- Exactly one active player per user
- Command routing must follow `controlMode` + `controlTargetId` (avoid stale closure behavior)
- Controller UI must reflect remote state while controlling remote
- `HowlerAudioElement` must not play if this device is not active

### Discovery fairness
- Avoid insertion-order bias in track selection
- Be careful with Prisma `take` without randomization/ordering
- Preserve `diversifyByArtist` behavior for generated mixes

### Identity safety
- `temp-` MBIDs are placeholders
- Skip external metadata/artwork lookups for temporary MBIDs
- Use stable internal IDs (`artist.id`) for app links and joins

### API boundaries
- App API stays under `/api/*`
- Subsonic compatibility stays under `/rest/*`
- Keep frontend proxy assumptions intact for long-running requests

### Scan behavior
- Scan is manual via `/api/library/scan`
- Do not reintroduce automatic startup scan behavior
- Preserve queue-driven scan/organization flow

### UI token discipline
- Use semantic tokens from `frontend/app/globals.css` (for example `brand`, `ai`)
- Avoid hardcoded hex Tailwind classes when a semantic token exists

## How You Should Change Code

- Make small, surgical diffs
- Preserve behavior unless user asked for behavior change
- Keep API shapes and user-facing text stable unless intentional
- Follow local style; avoid unrelated reformatting
- Never commit secrets or private local config

Before editing:

1. Read end-to-end code path
2. Identify cross-cutting impact (frontend state, route contracts, worker effects, schema)
3. Implement minimal safe fix
4. Validate touched surfaces
5. Report clearly: changed files, risks, validation

## Validation Commands

Run from repo root:

```bash
# Frontend
npm --prefix frontend run lint
npm --prefix frontend run build

# Backend
npm --prefix backend run build

# Optional e2e
npm --prefix frontend run test:e2e

# Container confidence check
docker build -t lidify-remote:latest .
```

Dev dependencies only (db/redis/analyzer):

```bash
docker compose -f docker-compose.dev.yml up -d
```

## Database / Migration Rules

- Schema source of truth: `backend/prisma/schema.prisma`
- Schema changes require Prisma migration
- New columns/relations must be backward-safe
- If analysis logic changes, consider re-analysis strategy

Useful reset:

```bash
docker exec lidify psql -U lidify -d lidify -c \
  "UPDATE \"Track\" SET \"analysisStatus\" = 'pending' WHERE \"analysisMode\" = 'standard';"
```

## Operations Quick Commands

```bash
# Build and deploy
docker build -t lidify-remote:latest .
docker compose up -d --force-recreate

# Logs
docker logs lidify --tail 100 -f

# Verify frontend rebuild
docker exec lidify cat /app/frontend/.next/BUILD_ID

# Clear Redis
docker exec lidify /usr/bin/redis-cli FLUSHALL
```

If changes do not appear, rebuild image with `--no-cache`.

## Done Criteria (for your final response)

A task is done when:

- Intended behavior works
- Relevant checks pass for touched areas
- No obvious regressions to playback/auth/routing/data integrity
- You report: what changed, risk areas, files touched, and validation run

## Source Docs

- Product context: `README.md`
- Detailed implementation history: `DEVELOPMENT_HISTORY.md`

If this file conflicts with code behavior, trust the code, then update this file.
