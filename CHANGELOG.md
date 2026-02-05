# Changelog

All notable changes in this Lidify fork are documented here.

This changelog is based on repository history and current project context.

## [Unreleased]

### Changed
- Ongoing settings and AI service refinements in progress.

## [2026-02-01] - Radio + Genre Tagging

### Added
- Last.fm-powered genre tagging pipeline and admin/script support for batch tagging.
- Major `/radio` page redesign and UX polish.

### Changed
- Centralized frontend color system with Tailwind v4 `@theme` semantic tokens.

## [2026-01] - Major Platform Expansion

### Added
- YouTube Music fallback streaming path for tracks unavailable locally.
- YouTube pre-cache flow for near-instant playback start.
- Source-aware player UI badges (local/YouTube/Spotify/Deezer where applicable).
- Podcast expansion:
  - AI-powered ad removal pipeline.
  - Auto-download and scheduled refresh.
  - Per-podcast access tokens and external RSS feeds.
  - M3U export and compact subscription views.
- Subsonic improvements:
  - Added endpoints like `getAlbumInfo2` and `getArtistInfo2`.
  - Better client compatibility across Symfonium-style clients.
- Ntfy push notifications for external client auto-sync workflows.

### Changed
- Discovery/recommendations experience redesigned with mode controls and preview-first behavior.
- Home/discover recommendation surfaces unified and recommendation internals simplified.
- AI weekly recommendation quality improved with stronger sonic-similarity logic.
- Search quality improved with ranking updates and better Last.fm integration.
- Settings UX reorganized and improved across multiple sections.

### Fixed
- Remote playback synchronization stabilized:
  - Bidirectional control/state sync improvements.
  - Reconnect no longer unexpectedly stops playback.
- Local playback prioritization fixed by consistently passing `filePath` through playback actions.
- Scanner/data integrity hardening:
  - Dual-root path safety improvements.
  - Protection against destructive scan edge cases.
  - Better metadata sanitization and duplicate prevention.
  - Release year handling improvements (original vs remaster, same-year ordering).
- TypeScript/ESLint debt significantly reduced via large cleanup passes.
- Dependency vulnerabilities addressed via npm audit updates.

## [2026-01-01] - Subsonic + Security Baseline

### Added
- Subsonic/OpenSubsonic compatibility layer for external clients.
- Separate Subsonic password setup/management flow.

### Fixed
- Compatibility issues discovered with specific Subsonic clients.

### Security
- Hardened authentication and input validation paths.

## [2025-12] - Foundation of Fork Enhancements

### Added
- Remote playback architecture (Spotify Connect-like control model).
- Internal frontend WebSocket proxy path (`/api/socket.io`) for reverse-proxy simplicity.
- OpenRouter integration replacing direct OpenAI dependency for AI features.
- AI recommendation and artist-discovery surfaces.

### Fixed
- ML audio analysis correctness:
  - Correct model loading paths.
  - Correct positive-class column handling per model.
  - Better resilience for oversized/timeout analysis cases.
- Playlist diversity bias:
  - Reduced insertion-order bias.
  - Expanded artist diversification logic across more generators.
- Cover art reliability:
  - Better fallback behavior (including Deezer-backed paths).
  - Extended and improved caching behavior.

### Infrastructure
- GHCR publishing workflow and tag-based build/release flow.
- Examples folder for all-in-one deployment setup.

## Notes

- This is an actively developed fork; sections are grouped by major development windows when formal tags are not available.
- For implementation detail and deep technical history, see `DEVELOPMENT_HISTORY.md`.

## Attribution

Original project: [Chevron7Locked/lidify](https://github.com/Chevron7Locked/lidify) (GPL-3.0).
