# Lidify Quick Start

All-in-one Docker deployment with embedded PostgreSQL, Redis, and audio analyzer.

## Setup

```bash
# 1. Copy example files
cp docker-compose.yml /path/to/your/compose/lidify/
cp .env.example /path/to/your/compose/lidify/.env

# 2. Edit docker-compose.yml
#    - Set your music library path
#    - Set your data directory path

# 3. Edit .env (optional)
#    - Add OPENROUTER_API_KEY for AI recommendations
#    - Add LASTFM_API_KEY for artist bios and scrobbling

# 4. Start Lidify
cd /path/to/your/compose/lidify
docker compose up -d

# 5. Open http://localhost:3030
```

## Building from Source

```bash
# Clone the repository
git clone https://github.com/fjordnode/lidify.git
cd lidify

# Build the all-in-one image
docker build -t lidify:latest .

# Update docker-compose.yml to use local image:
# image: lidify:latest
```

## Volumes

| Container Path | Purpose |
|----------------|---------|
| `/music` | Your music library (read-only) |
| `/data` | Database, cache, logs (read-write) |

## Ports

| Port | Service |
|------|---------|
| 3030 | Web UI |
| 3006 | API (optional) |
