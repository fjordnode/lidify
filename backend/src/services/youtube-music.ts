import { Innertube, UniversalCache } from "youtubei.js";
import { exec } from "child_process";
import { promisify } from "util";
import * as fuzz from "fuzzball";
import * as path from "path";
import * as fs from "fs";
import { redisClient } from "../utils/redis";

const execPromise = promisify(exec);

/**
 * YouTube Music Service
 *
 * Provides YouTube Music search, streaming, and download capabilities via:
 * - youtubei.js (InnerTube API) for search and streaming - fast, no auth required
 * - yt-dlp CLI for downloads only - handles format conversion
 *
 * Features:
 * - No authentication required (uses anonymous visitor tokens)
 * - No DRM on audio streams (unlike Spotify)
 * - No ads in extracted streams
 * - Up to 256kbps AAC/OPUS quality
 * - Built-in signature decryption via youtubei.js (no external JS runtime needed)
 */

// ============================================
// Types
// ============================================

export interface YouTubeMusicTrack {
    videoId: string;
    title: string;
    artist: string;
    album?: string;
    duration: number; // seconds
    thumbnail?: string;
}

export interface YouTubeMusicSearchResult {
    tracks: YouTubeMusicTrack[];
    query: string;
}

export interface StreamUrlResult {
    url: string;
    format: string;
    expiresAt: number;
    mimeType?: string;
    contentLength?: number;
}

export interface DownloadResult {
    filePath: string;
    format: string;
    duration: number;
}

export interface YouTubeMusicPlaylistPreview {
    id: string;
    title: string;
    description: string | null;
    creator: string;
    imageUrl: string | null;
    trackCount: number;
}

export interface YouTubeMusicPlaylist {
    id: string;
    title: string;
    description: string | null;
    creator: string;
    imageUrl: string | null;
    trackCount: number;
    tracks: YouTubeMusicTrack[];
    isPublic: boolean;
    url: string;
}

interface MatchScore {
    track: YouTubeMusicTrack;
    score: number;
    breakdown: {
        titleScore: number;
        artistScore: number;
        durationScore: number;
    };
}

// ============================================
// Configuration
// ============================================

const YOUTUBE_MUSIC_ENABLED = process.env.YOUTUBE_MUSIC_ENABLED !== "false";
// Use opus (YouTube's native format ~130kbps) to avoid lossy transcoding
// MP3 transcoding from opus source just wastes space without quality gain
const DOWNLOAD_FORMAT = process.env.YOUTUBE_MUSIC_DOWNLOAD_FORMAT || "opus";
const DOWNLOAD_USER_AGENT =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";

// Cache TTLs
const STREAM_URL_TTL = 4 * 60 * 60; // 4 hours (conservative vs 5-6h expiry)
const MATCH_CACHE_TTL = 24 * 60 * 60; // 24 hours
const SEARCH_CACHE_TTL = 60 * 60; // 1 hour

// Redis key prefixes
const CACHE_PREFIX = "ytm:";
const STREAM_KEY = (videoId: string) => `${CACHE_PREFIX}stream:${videoId}`;
const MATCH_KEY = (hash: string) => `${CACHE_PREFIX}match:${hash}`;
const SEARCH_KEY = (query: string) => `${CACHE_PREFIX}search:${query.toLowerCase().replace(/\s+/g, "_")}`;
const PLAYLIST_KEY = (id: string) => `${CACHE_PREFIX}playlist:${id}`;
const PLAYLIST_META_KEY = (id: string) => `${CACHE_PREFIX}playlist_meta:${id}`;
const PLAYLIST_SEARCH_KEY = (query: string) => `${CACHE_PREFIX}plsearch:${query.toLowerCase().replace(/\s+/g, "_")}`;
const EXPLORE_KEY = `${CACHE_PREFIX}explore:playlists`;
const EXPLORE_FEATURED_KEY = `${CACHE_PREFIX}explore:featured`;
const EXPLORE_COMMUNITY_KEY = `${CACHE_PREFIX}explore:community`;

// Match thresholds
const MINIMUM_MATCH_SCORE = 0.65;
const DURATION_TOLERANCE_SECONDS = 5;

// ============================================
// Service Class
// ============================================

class YouTubeMusicService {
    private innertube: Innertube | null = null;
    private initPromise: Promise<void> | null = null;
    private initError: Error | null = null;

    /**
     * Initialize the InnerTube client (lazy, singleton)
     */
    private async ensureInitialized(): Promise<Innertube> {
        if (this.initError) {
            throw this.initError;
        }

        if (this.innertube) {
            return this.innertube;
        }

        if (!this.initPromise) {
            this.initPromise = this.initialize();
        }

        await this.initPromise;
        return this.innertube!;
    }

    private async initialize(): Promise<void> {
        try {
            console.log("[YouTube Music] Initializing InnerTube client...");
            this.innertube = await Innertube.create({
                cache: new UniversalCache(false), // Don't persist cache to disk
                generate_session_locally: true,
                retrieve_player: true, // Required for signature decryption
                location: "US",
                lang: "en",
            });
            console.log("[YouTube Music] InnerTube client ready");
        } catch (error: any) {
            this.initError = error;
            console.error("[YouTube Music] Failed to initialize InnerTube:", error.message);
            throw error;
        }
    }

    /**
     * Check if YouTube Music is enabled
     */
    isEnabled(): boolean {
        return YOUTUBE_MUSIC_ENABLED;
    }

    // ============================================
    // Redis Cache Helpers
    // ============================================

    private async getCached<T>(key: string): Promise<T | null> {
        try {
            const cached = await redisClient.get(key);
            if (cached) {
                return JSON.parse(cached);
            }
        } catch (err) {
            // Redis errors are non-critical
        }
        return null;
    }

    private async setCache(key: string, value: unknown, ttl: number): Promise<void> {
        try {
            await redisClient.setEx(key, ttl, JSON.stringify(value));
        } catch (err) {
            // Redis errors are non-critical
        }
    }

    private async deleteCache(key: string): Promise<void> {
        try {
            await redisClient.del(key);
        } catch (err) {
            // Redis errors are non-critical
        }
    }

    // ============================================
    // Search Methods
    // ============================================

    /**
     * Search YouTube Music for tracks
     */
    async search(query: string, limit: number = 10): Promise<YouTubeMusicTrack[]> {
        if (!this.isEnabled()) {
            return [];
        }

        // Check cache first
        const cacheKey = SEARCH_KEY(query);
        const cached = await this.getCached<YouTubeMusicTrack[]>(cacheKey);
        if (cached) {
            console.log(`[YouTube Music] Search cache hit for "${query}"`);
            return cached.slice(0, limit);
        }

        try {
            const yt = await this.ensureInitialized();
            const searchResults = await yt.music.search(query, { type: "song" });

            const tracks: YouTubeMusicTrack[] = [];

            // Extract songs from search results
            const contents = searchResults.contents;
            if (contents) {
                for (const section of contents) {
                    if (section.type === "MusicShelfRenderer" || section.type === "MusicShelf") {
                        const shelf = section as any;
                        const items = shelf.contents || [];

                        for (const item of items) {
                            const track = this.parseTrackFromSearchResult(item);
                            if (track) {
                                tracks.push(track);
                                if (tracks.length >= limit) break;
                            }
                        }
                    }
                }
            }

            // Cache results
            if (tracks.length > 0) {
                await this.setCache(cacheKey, tracks, SEARCH_CACHE_TTL);
            }

            console.log(`[YouTube Music] Search for "${query}" found ${tracks.length} tracks`);
            return tracks;
        } catch (error: any) {
            console.error(`[YouTube Music] Search error for "${query}":`, error.message);
            return [];
        }
    }

    /**
     * Parse a track from YouTube Music search result item
     */
    private parseTrackFromSearchResult(item: any): YouTubeMusicTrack | null {
        return this.parseTrackFromMusicItem(item);
    }

    private parseTrackFromMusicItem(item: any): YouTubeMusicTrack | null {
        try {
            if (!item || item.type === "ContinuationItem") {
                return null;
            }

            const videoId =
                item.id ||
                item.video_id ||
                item.videoId ||
                item.endpoint?.payload?.videoId ||
                item.navigation_endpoint?.payload?.videoId ||
                "";
            if (!videoId) {
                return null;
            }

            const title =
                this.extractText(item.title) ||
                this.extractText(item.name) ||
                this.extractText(item.flex_columns?.[0]?.title) ||
                this.extractText(item.flex_columns?.[0]?.text);

            let artist = "";
            if (Array.isArray(item.artists) && item.artists.length > 0) {
                artist = item.artists
                    .map((a: any) => this.extractText(a?.name || a?.text || a))
                    .filter(Boolean)
                    .join(", ");
            }
            if (!artist && Array.isArray(item.authors) && item.authors.length > 0) {
                artist = item.authors
                    .map((a: any) => this.extractText(a?.name || a?.text || a))
                    .filter(Boolean)
                    .join(", ");
            }
            if (!artist) {
                const subtitle =
                    this.extractText(item.subtitle) ||
                    this.extractText(item.flex_columns?.[1]?.title) ||
                    this.extractText(item.flex_columns?.[1]?.text);
                if (subtitle) {
                    const parts = subtitle
                        .split(" • ")
                        .map((p) => p.trim())
                        .filter(Boolean);
                    artist =
                        parts.find((p) => !/^\d+:\d{2}(?::\d{2})?$/.test(p)) ||
                        parts[0] ||
                        "";
                }
            }

            let album =
                this.extractText(item.album?.name) ||
                this.extractText(item.album?.title) ||
                undefined;

            let duration = 0;
            if (typeof item.duration?.seconds === "number") {
                duration = item.duration.seconds;
            } else if (typeof item.duration === "number") {
                duration = item.duration;
            } else {
                const durationText =
                    this.extractText(item.duration?.text) ||
                    this.extractText(item.duration) ||
                    this.extractText(item.fixed_columns?.[0]?.title);
                if (durationText) {
                    duration = this.parseDurationString(durationText);
                }
            }

            const thumbnail = this.extractThumbnailUrl(
                item.thumbnails || item.thumbnail?.contents || item.thumbnail
            );

            if (title && artist) {
                return {
                    videoId: String(videoId),
                    title: title.trim(),
                    artist: artist.trim(),
                    album: album?.trim(),
                    duration,
                    thumbnail: thumbnail || undefined,
                };
            }
        } catch (err) {
            // Skip malformed items
        }
        return null;
    }

    private extractText(value: any): string {
        if (value == null) return "";
        if (typeof value === "string") return value;
        if (typeof value === "number") return String(value);

        if (typeof value.text === "string") {
            return value.text;
        }

        if (Array.isArray(value.runs)) {
            return value.runs
                .map((r: any) => this.extractText(r?.text || r))
                .filter(Boolean)
                .join("");
        }

        if (typeof value.toString === "function") {
            const stringValue = String(value.toString());
            if (stringValue && stringValue !== "[object Object]") {
                return stringValue;
            }
        }

        return "";
    }

    private extractTrackCount(value: any): number {
        if (typeof value === "number" && Number.isFinite(value)) {
            return value;
        }

        const text = this.extractText(value);
        if (!text) {
            return 0;
        }

        const match = text.match(/(\d[\d,]*)\s+(song|songs|track|tracks|video|videos)/i);
        if (!match) {
            return 0;
        }

        const parsed = parseInt(match[1].replace(/,/g, ""), 10);
        return Number.isFinite(parsed) ? parsed : 0;
    }

    private extractThumbnailUrl(value: any): string | null {
        const thumbnails = Array.isArray(value)
            ? value
            : Array.isArray(value?.contents)
            ? value.contents
            : value
            ? [value]
            : [];

        if (thumbnails.length === 0) {
            return null;
        }

        const sorted = [...thumbnails].sort(
            (a: any, b: any) => (b?.width || 0) - (a?.width || 0)
        );
        const best = sorted[0];
        return best?.url || null;
    }

    /**
     * Parse duration string like "3:45" to seconds
     */
    private parseDurationString(durationStr: string): number {
        if (!durationStr) return 0;
        const parts = durationStr.split(":").map(Number);
        if (parts.length === 2) {
            return parts[0] * 60 + parts[1];
        } else if (parts.length === 3) {
            return parts[0] * 3600 + parts[1] * 60 + parts[2];
        }
        return 0;
    }

    // ============================================
    // Playlist Methods
    // ============================================

    /**
     * Parse a YouTube Music or YouTube playlist URL
     */
    parseUrl(url: string): { type: string; id: string } | null {
        try {
            const urlObj = new URL(url);
            const hostname = urlObj.hostname.replace("www.", "");

            if (hostname === "music.youtube.com" || hostname === "youtube.com") {
                // Playlist: music.youtube.com/playlist?list=PLxxxx
                if (urlObj.pathname === "/playlist" || urlObj.pathname === "/playlist/") {
                    const listId = urlObj.searchParams.get("list");
                    if (listId) {
                        return { type: "playlist", id: listId };
                    }
                }
                // Video with list param: music.youtube.com/watch?v=xxx&list=PLxxxx
                if (urlObj.pathname === "/watch") {
                    const listId = urlObj.searchParams.get("list");
                    if (listId) {
                        return { type: "playlist", id: listId };
                    }
                }
            }
        } catch {
            // Invalid URL
        }
        return null;
    }

    /**
     * Fetch a full YouTube Music playlist with tracks
     */
    async getPlaylist(playlistId: string): Promise<YouTubeMusicPlaylist | null> {
        if (!this.isEnabled()) {
            return null;
        }

        const cacheKey = PLAYLIST_KEY(playlistId);
        const cached = await this.getCached<YouTubeMusicPlaylist>(cacheKey);
        if (cached) {
            const cachedLooksBroken =
                cached.title === "Unknown Playlist" &&
                cached.creator === "Unknown" &&
                cached.trackCount === 0 &&
                cached.tracks.length === 0;

            if (cachedLooksBroken) {
                await this.deleteCache(cacheKey);
                console.log(
                    `[YouTube Music] Discarding stale playlist cache for ${playlistId}`
                );
            } else {
                console.log(`[YouTube Music] Playlist cache hit for ${playlistId}`);
                return cached;
            }
        }

        try {
            const yt = await this.ensureInitialized();
            const playlist = await yt.music.getPlaylist(playlistId);
            let {
                title,
                creator,
                description,
                imageUrl,
                trackCount,
            } = this.parsePlaylistMetadata(playlist);

            // Parse all tracks, handling pagination
            const tracks: YouTubeMusicTrack[] = [];
            let currentPage = playlist;

            while (true) {
                const items = currentPage.items || currentPage.contents;
                if (items) {
                    for (const item of items) {
                        const track = this.parseTrackFromMusicItem(item);
                        if (track) {
                            tracks.push(track);
                        }
                    }
                }

                if (currentPage.has_continuation) {
                    try {
                        currentPage = await currentPage.getContinuation();
                    } catch {
                        break;
                    }
                } else {
                    break;
                }

                // Safety limit
                if (tracks.length > 5000) break;
            }

            if (trackCount === 0) {
                trackCount = tracks.length;
            }

            const result: YouTubeMusicPlaylist = {
                id: playlistId,
                title,
                description,
                creator,
                imageUrl,
                trackCount,
                tracks,
                isPublic: true,
                url: `https://music.youtube.com/playlist?list=${playlistId}`,
            };

            await this.setCache(cacheKey, result, SEARCH_CACHE_TTL);
            console.log(`[YouTube Music] Fetched playlist "${title}" with ${tracks.length} tracks`);
            return result;
        } catch (error: any) {
            console.error(`[YouTube Music] Failed to fetch playlist ${playlistId}:`, error.message);
            return null;
        }
    }

    private parsePlaylistMetadata(playlist: any): {
        title: string;
        creator: string;
        description: string | null;
        imageUrl: string | null;
        trackCount: number;
    } {
        const header = playlist?.header as any;
        const fallbackTitle = this.extractText(playlist?.title);

        let title = fallbackTitle || "Unknown Playlist";
        let creator = "Unknown";
        let description: string | null = null;
        let imageUrl: string | null = null;
        let trackCount = 0;

        if (header) {
            title =
                this.extractText(header.title) ||
                this.extractText(header.edit_header?.title) ||
                this.extractText(header.header?.title) ||
                title;

            creator =
                this.extractText(header.author?.name) ||
                this.extractText(header.strapline_text_one) ||
                this.extractText(
                    header.subtitle?.runs?.find(
                        (r: any) =>
                            r?.endpoint?.payload?.browseId &&
                            String(r.endpoint.payload.browseId).startsWith("UC")
                    )?.text
                ) ||
                this.extractText(header.subtitle).split(" • ")[0] ||
                "YouTube Music";

            description =
                this.extractText(header.description) ||
                this.extractText(header.description?.description) ||
                this.extractText(header.edit_header?.edit_description) ||
                null;

            trackCount =
                this.extractTrackCount(header.song_count) ||
                this.extractTrackCount(header.second_subtitle) ||
                this.extractTrackCount(header.subtitle) ||
                this.extractTrackCount(playlist?.track_count);

            imageUrl =
                this.extractThumbnailUrl(header.thumbnails) ||
                this.extractThumbnailUrl(header.thumbnail?.contents) ||
                this.extractThumbnailUrl(playlist?.background?.contents) ||
                null;
        }

        return { title, creator, description, imageUrl, trackCount };
    }

    private async getPlaylistMetadata(playlistId: string): Promise<{
        title: string;
        creator: string;
        description: string | null;
        imageUrl: string | null;
        trackCount: number;
    } | null> {
        const cacheKey = PLAYLIST_META_KEY(playlistId);
        const cached = await this.getCached<{
            title: string;
            creator: string;
            description: string | null;
            imageUrl: string | null;
            trackCount: number;
        }>(cacheKey);
        if (cached) {
            return cached;
        }

        try {
            const yt = await this.ensureInitialized();
            const playlist = await yt.music.getPlaylist(playlistId);
            const metadata = this.parsePlaylistMetadata(playlist);
            await this.setCache(cacheKey, metadata, SEARCH_CACHE_TTL);
            return metadata;
        } catch {
            return null;
        }
    }

    private async enrichPlaylistPreviewCounts(
        playlists: YouTubeMusicPlaylistPreview[]
    ): Promise<YouTubeMusicPlaylistPreview[]> {
        const missingCounts = playlists.filter((playlist) => playlist.trackCount <= 0);
        if (missingCounts.length === 0) {
            return playlists;
        }

        const hydratedCounts = new Map<string, number>();
        const concurrency = 4;

        for (let i = 0; i < missingCounts.length; i += concurrency) {
            const batch = missingCounts.slice(i, i + concurrency);
            const metadataBatch = await Promise.all(
                batch.map((playlist) => this.getPlaylistMetadata(playlist.id))
            );

            for (let j = 0; j < batch.length; j++) {
                const metadata = metadataBatch[j];
                if (metadata && metadata.trackCount > 0) {
                    hydratedCounts.set(batch[j].id, metadata.trackCount);
                }
            }
        }

        if (hydratedCounts.size === 0) {
            return playlists;
        }

        return playlists.map((playlist) => {
            const hydratedCount = hydratedCounts.get(playlist.id);
            if (hydratedCount && hydratedCount > 0) {
                return { ...playlist, trackCount: hydratedCount };
            }
            return playlist;
        });
    }

    /**
     * Search YouTube Music for playlists
     */
    async searchPlaylists(query: string, limit: number = 20): Promise<YouTubeMusicPlaylistPreview[]> {
        if (!this.isEnabled()) {
            return [];
        }

        const cacheKey = PLAYLIST_SEARCH_KEY(query);
        const cached = await this.getCached<YouTubeMusicPlaylistPreview[]>(cacheKey);
        if (cached) {
            console.log(`[YouTube Music] Playlist search cache hit for "${query}"`);
            return cached.slice(0, limit);
        }

        try {
            const yt = await this.ensureInitialized();
            const searchResults = await yt.music.search(query, { type: "playlist" });

            const playlists: YouTubeMusicPlaylistPreview[] = [];
            const contents = searchResults.contents;

            if (contents) {
                for (const section of contents) {
                    if (section.type === "MusicShelfRenderer" || section.type === "MusicShelf") {
                        const shelf = section as any;
                        const items = shelf.contents || [];

                        for (const item of items) {
                            const parsed = this.parsePlaylistFromSearchResult(item);
                            if (parsed) {
                                playlists.push(parsed);
                                if (playlists.length >= limit) break;
                            }
                        }
                    }
                }
            }

            if (playlists.length > 0) {
                await this.setCache(cacheKey, playlists, SEARCH_CACHE_TTL);
            }

            console.log(`[YouTube Music] Playlist search for "${query}" found ${playlists.length} results`);
            return playlists;
        } catch (error: any) {
            console.error(`[YouTube Music] Playlist search error for "${query}":`, error.message);
            return [];
        }
    }

    /**
     * Get popular playlists from YouTube Music charts/explore surfaces.
     * Keeps featured and community lists separate for UI tabs.
     */
    async getExplorePlaylists(limit: number = 30): Promise<YouTubeMusicPlaylistPreview[]> {
        const sections = await this.getExplorePlaylistSections(limit, limit);
        const merged = [...sections.featured, ...sections.community];

        if (merged.length > 0) {
            await this.setCache(EXPLORE_KEY, merged, MATCH_CACHE_TTL);
        }

        if (sections.featured.length > 0) {
            return sections.featured.slice(0, limit);
        }
        return sections.community.slice(0, limit);
    }

    async getExplorePlaylistSections(
        featuredLimit: number = 30,
        communityLimit: number = 30
    ): Promise<{ featured: YouTubeMusicPlaylistPreview[]; community: YouTubeMusicPlaylistPreview[] }> {
        if (!this.isEnabled()) {
            return { featured: [], community: [] };
        }

        const [cachedFeatured, cachedCommunity] = await Promise.all([
            this.getCached<YouTubeMusicPlaylistPreview[]>(EXPLORE_FEATURED_KEY),
            this.getCached<YouTubeMusicPlaylistPreview[]>(EXPLORE_COMMUNITY_KEY),
        ]);

        let featured = cachedFeatured || [];
        let community = cachedCommunity || [];

        const staleFeatured =
            featured.length > 0 && featured.every((playlist) => playlist.trackCount === 0);
        if (staleFeatured) {
            await this.deleteCache(EXPLORE_FEATURED_KEY);
            featured = [];
        }

        const staleCommunity =
            community.length > 0 && community.every((playlist) => playlist.trackCount === 0);
        if (staleCommunity) {
            await this.deleteCache(EXPLORE_COMMUNITY_KEY);
            community = [];
        }

        try {
            if (featured.length === 0) {
                const popular = await this.getPopularPlaylistsFromCharts(
                    Math.max(featuredLimit, 40)
                );
                featured = await this.enrichPlaylistPreviewCounts(popular);

                if (featured.length === 0) {
                    featured = await this.getFeaturedPlaylistsFromSearch(
                        Math.max(featuredLimit, 30)
                    );
                    featured = await this.enrichPlaylistPreviewCounts(featured);
                    if (featured.length > 0) {
                        console.log(
                            `[YouTube Music] Featured fallback search returned ${featured.length} playlists`
                        );
                    }
                }

                if (featured.length > 0) {
                    await this.setCache(EXPLORE_FEATURED_KEY, featured, MATCH_CACHE_TTL);
                    console.log(
                        `[YouTube Music] Featured source returned ${featured.length} playlists`
                    );
                }
            } else {
                featured = await this.enrichPlaylistPreviewCounts(featured);
            }

            if (community.length === 0) {
                const featuredIds = new Set(featured.map((playlist) => playlist.id));
                community = await this.getCommunityPlaylistsFromSearch(
                    Math.max(communityLimit, 40),
                    featuredIds
                );
                community = await this.enrichPlaylistPreviewCounts(community);
                if (community.length > 0) {
                    await this.setCache(EXPLORE_COMMUNITY_KEY, community, MATCH_CACHE_TTL);
                    console.log(
                        `[YouTube Music] Community discovery returned ${community.length} playlists`
                    );
                }
            } else {
                community = await this.enrichPlaylistPreviewCounts(community);
            }

            const featuredIds = new Set(featured.map((playlist) => playlist.id));
            community = community.filter((playlist) => !featuredIds.has(playlist.id));

            return {
                featured: featured.slice(0, featuredLimit),
                community: community.slice(0, communityLimit),
            };
        } catch (error: any) {
            console.error("[YouTube Music] Failed to fetch explore playlist sections:", error.message);
            return {
                featured: featured.slice(0, featuredLimit),
                community: community.slice(0, communityLimit),
            };
        }
    }

    private async getCommunityPlaylistsFromSearch(
        limit: number,
        excludeIds: Set<string> = new Set()
    ): Promise<YouTubeMusicPlaylistPreview[]> {
        const queries = [
            "indie playlist",
            "bedroom pop playlist",
            "workout mix playlist",
            "house music playlist",
            "community playlist",
            "user playlist mix",
        ];

        const playlists: YouTubeMusicPlaylistPreview[] = [];
        const seenIds = new Set<string>(excludeIds);

        for (const query of queries) {
            const results = await this.searchPlaylists(query, 10).catch(() => []);
            for (const playlist of results) {
                if (seenIds.has(playlist.id)) {
                    continue;
                }
                seenIds.add(playlist.id);
                playlists.push(playlist);

                if (playlists.length >= limit) {
                    return playlists.slice(0, limit);
                }
            }
        }

        return playlists.slice(0, limit);
    }

    private async getFeaturedPlaylistsFromSearch(
        limit: number
    ): Promise<YouTubeMusicPlaylistPreview[]> {
        const queries = [
            "today's top hits playlist",
            "official playlist youtube music",
            "top songs playlist",
            "global hits playlist",
            "chart toppers playlist",
            "music charts playlist",
        ];

        const playlists: YouTubeMusicPlaylistPreview[] = [];
        const seenIds = new Set<string>();

        for (const query of queries) {
            const results = await this.searchPlaylists(query, 10).catch(() => []);
            for (const playlist of results) {
                if (seenIds.has(playlist.id)) {
                    continue;
                }
                seenIds.add(playlist.id);
                playlists.push(playlist);

                if (playlists.length >= limit) {
                    return playlists.slice(0, limit);
                }
            }
        }

        return playlists.slice(0, limit);
    }

    private async getPopularPlaylistsFromCharts(
        limit: number
    ): Promise<YouTubeMusicPlaylistPreview[]> {
        const yt = await this.ensureInitialized();
        const sources: any[] = [];

        try {
            const charts = await (yt as any).actions.execute("/browse", {
                client: "YTMUSIC",
                browseId: "FEmusic_charts",
                parse: true,
            });
            if (charts) {
                sources.push(charts);
            }
        } catch (error: any) {
            console.warn(
                `[YouTube Music] Direct charts browse failed: ${error.message}`
            );
        }

        try {
            const explore = await (yt as any).music.getExplore();
            const topButtons = (explore as any)?.top_buttons || [];
            const chartsButton = topButtons.find((button: any) =>
                /charts?/i.test(this.extractText(button?.button_text))
            );

            if (chartsButton?.endpoint?.call) {
                const exploreCharts = await chartsButton.endpoint.call(
                    (yt as any).actions,
                    {
                        client: "YTMUSIC",
                        parse: true,
                    }
                );
                if (exploreCharts) {
                    sources.push(exploreCharts);
                }
            }
        } catch (error: any) {
            console.warn(
                `[YouTube Music] Explore charts fallback failed: ${error.message}`
            );
        }

        const playlists = this.extractPlaylistPreviewsFromNodes(sources, limit);
        return playlists;
    }

    private extractPlaylistPreviewsFromNodes(
        roots: any[],
        limit: number
    ): YouTubeMusicPlaylistPreview[] {
        const previews: YouTubeMusicPlaylistPreview[] = [];
        const seenIds = new Set<string>();
        const visited = new Set<any>();
        const stack = [...roots];

        while (stack.length > 0 && previews.length < limit) {
            const node = stack.pop();
            if (!node || typeof node !== "object" || visited.has(node)) {
                continue;
            }
            visited.add(node);

            const parsed = this.parsePlaylistFromSearchResult(node);
            if (parsed && !seenIds.has(parsed.id)) {
                seenIds.add(parsed.id);
                previews.push(parsed);
                if (previews.length >= limit) break;
            }

            for (const value of Object.values(node)) {
                if (!value) continue;
                if (Array.isArray(value)) {
                    for (const entry of value) {
                        if (entry && typeof entry === "object") {
                            stack.push(entry);
                        }
                    }
                } else if (typeof value === "object") {
                    stack.push(value);
                }
            }
        }

        return previews;
    }

    /**
     * Parse a playlist from YouTube Music search result item (MusicResponsiveListItem)
     */
    private parsePlaylistFromSearchResult(item: any): YouTubeMusicPlaylistPreview | null {
        try {
            const rawPlaylistId =
                this.extractText(item.endpoint?.payload?.playlistId) ||
                this.extractText(item.endpoint?.payload?.browseId) ||
                this.extractText(item.navigation_endpoint?.payload?.playlistId) ||
                this.extractText(item.navigation_endpoint?.payload?.browseId) ||
                this.extractText(item.id);
            const playlistId = this.normalizePlaylistId(rawPlaylistId, item);
            if (!playlistId) return null;

            const title =
                this.extractText(item.title) ||
                this.extractText(item.name) ||
                this.extractText(item.flex_columns?.[0]?.title) ||
                this.extractText(item.flex_columns?.[0]?.text);
            if (!title) return null;

            let creator = "YouTube Music";
            const byAuthor = this.extractText(item.author?.name);
            const byAuthors = Array.isArray(item.authors)
                ? item.authors
                      .map((a: any) => this.extractText(a?.name || a?.text || a))
                      .filter(Boolean)
                      .join(", ")
                : "";
            const byArtists = Array.isArray(item.artists)
                ? item.artists
                      .map((a: any) => this.extractText(a?.name || a?.text || a))
                      .filter(Boolean)
                      .join(", ")
                : "";
            const byMeta =
                this.extractCreatorFromMeta(
                    this.extractText(item.flex_columns?.[1]?.title) ||
                        this.extractText(item.flex_columns?.[1]?.text) ||
                        this.extractText(item.subtitle)
                ) || "";

            creator = byAuthor || byAuthors || byArtists || byMeta || creator;

            let imageUrl =
                this.extractThumbnailUrl(item.thumbnails || item.thumbnail?.contents) ||
                this.extractThumbnailUrl(item.thumbnail) ||
                null;

            let trackCount =
                this.extractTrackCount(item.item_count) ||
                this.extractTrackCount(item.song_count) ||
                this.extractTrackCount(item.subtitle) ||
                this.extractTrackCount(item.flex_columns?.[1]?.title) ||
                this.extractTrackCount(item.flex_columns?.[1]?.text) ||
                this.extractTrackCount(item.second_subtitle);

            if (trackCount === 0 && item.item_type === "playlist") {
                const inlineCount = this.extractTrackCount(this.extractText(item));
                if (inlineCount > 0) {
                    trackCount = inlineCount;
                }
            }

            return {
                id: playlistId,
                title: title.trim(),
                description: null,
                creator: creator.trim(),
                imageUrl,
                trackCount,
            };
        } catch {
            return null;
        }
    }

    /**
     * Parse a MusicTwoRowItem (from Explore carousels) as a playlist preview
     */
    private parseTwoRowItemAsPlaylist(item: any): YouTubeMusicPlaylistPreview | null {
        return this.parsePlaylistFromSearchResult(item);
    }

    private normalizePlaylistId(rawId: string, item?: any): string {
        const id = (rawId || "").trim();
        if (!id) return "";

        const stripped = id.startsWith("VL") ? id.substring(2) : id;

        if (/^(PL|OLAK5uy_|RDCLAK5uy_|RDEM|RDMM|UU|LL|FL|LM|MPLYt_)/.test(stripped)) {
            return stripped;
        }

        // Avoid returning plain 11-char video IDs as playlists
        if (/^[a-zA-Z0-9_-]{11}$/.test(stripped)) {
            const itemType = this.extractText(item?.item_type).toLowerCase();
            const subtitle = this.extractText(item?.subtitle).toLowerCase();
            if (
                itemType.includes("playlist") ||
                subtitle.includes("playlist") ||
                !!item?.endpoint?.payload?.playlistId ||
                !!item?.navigation_endpoint?.payload?.playlistId
            ) {
                return stripped;
            }
            return "";
        }

        return stripped;
    }

    private extractCreatorFromMeta(meta: string): string {
        if (!meta) return "";

        const parts = meta
            .split(" • ")
            .map((p) => p.trim())
            .filter(Boolean);

        for (const part of parts) {
            if (/^\d{4}$/.test(part)) continue;
            if (/^\d[\d,]*\s*(song|songs|track|tracks|video|videos|view|views)$/i.test(part)) {
                continue;
            }
            if (/^(playlist|album|single|ep)$/i.test(part)) continue;
            if (/^\d+:\d{2}(?::\d{2})?$/.test(part)) continue;
            return part;
        }

        return "";
    }

    // ============================================
    // Track Matching
    // ============================================

    /**
     * Find the best YouTube Music match for a track
     */
    async findTrack(
        artist: string,
        title: string,
        duration?: number,
        album?: string
    ): Promise<YouTubeMusicTrack | null> {
        if (!this.isEnabled()) {
            return null;
        }

        // Generate cache key from normalized inputs
        const cacheHash = this.generateMatchHash(artist, title, duration);
        const cacheKey = MATCH_KEY(cacheHash);

        // Check cache first
        const cached = await this.getCached<YouTubeMusicTrack | { noMatch: true }>(cacheKey);
        if (cached !== null) {
            // Check if this is a cached negative result (no match found previously)
            if ('noMatch' in cached && cached.noMatch === true) {
                console.log(`[YouTube Music] Match cache hit (no match): "${artist} - ${title}"`);
                return null;
            }
            console.log(`[YouTube Music] Match cache hit for "${artist} - ${title}"`);
            return cached as YouTubeMusicTrack;
        }

        // Search YouTube Music
        const query = `${artist} ${title}`;
        const results = await this.search(query, 15);

        if (results.length === 0) {
            // Cache negative result with sentinel object
            await this.setCache(cacheKey, { noMatch: true }, MATCH_CACHE_TTL);
            return null;
        }

        // Score each result
        const scored: MatchScore[] = results.map((track) => {
            const scores = this.calculateMatchScore(track, { artist, title, duration, album });
            return {
                track,
                score: scores.total,
                breakdown: {
                    titleScore: scores.titleScore,
                    artistScore: scores.artistScore,
                    durationScore: scores.durationScore,
                },
            };
        });

        // Sort by score descending
        scored.sort((a, b) => b.score - a.score);

        const best = scored[0];
        if (best && best.score >= MINIMUM_MATCH_SCORE) {
            console.log(
                `[YouTube Music] Best match for "${artist} - ${title}": ` +
                `"${best.track.artist} - ${best.track.title}" (score: ${best.score.toFixed(2)}, ` +
                `title: ${best.breakdown.titleScore.toFixed(2)}, artist: ${best.breakdown.artistScore.toFixed(2)}, ` +
                `duration: ${best.breakdown.durationScore.toFixed(2)})`
            );
            await this.setCache(cacheKey, best.track, MATCH_CACHE_TTL);
            return best.track;
        }

        console.log(
            `[YouTube Music] No good match for "${artist} - ${title}" ` +
            `(best score: ${best?.score.toFixed(2) || "N/A"})`
        );
        // Cache negative result with sentinel object
        await this.setCache(cacheKey, { noMatch: true }, MATCH_CACHE_TTL);
        return null;
    }

    /**
     * Calculate match score between YouTube track and target
     */
    private calculateMatchScore(
        track: YouTubeMusicTrack,
        target: { artist: string; title: string; duration?: number; album?: string }
    ): { total: number; titleScore: number; artistScore: number; durationScore: number } {
        // Normalize strings for comparison
        const normalizeStr = (s: string) =>
            s.toLowerCase()
                .replace(/[^\w\s]/g, "") // Remove punctuation
                .replace(/\s+/g, " ") // Normalize whitespace
                .trim();

        const trackTitle = normalizeStr(track.title);
        const targetTitle = normalizeStr(target.title);
        const trackArtist = normalizeStr(track.artist);
        const targetArtist = normalizeStr(target.artist);

        // Title similarity (40% weight)
        const titleScore = fuzz.ratio(trackTitle, targetTitle) / 100;

        // Artist similarity (35% weight)
        // Handle multi-artist scenarios (feat., &, etc.)
        let artistScore = fuzz.ratio(trackArtist, targetArtist) / 100;

        // Check if primary artist matches (first artist in comma/& separated list)
        const trackPrimaryArtist = trackArtist.split(/[,&]/)[0].trim();
        const targetPrimaryArtist = targetArtist.split(/[,&]/)[0].trim();
        const primaryArtistScore = fuzz.ratio(trackPrimaryArtist, targetPrimaryArtist) / 100;
        artistScore = Math.max(artistScore, primaryArtistScore);

        // Duration match (25% weight)
        let durationScore = 0.5; // Default to neutral if no duration info
        if (target.duration && track.duration) {
            const durationDiff = Math.abs(track.duration - target.duration);
            if (durationDiff <= DURATION_TOLERANCE_SECONDS) {
                durationScore = 1.0;
            } else if (durationDiff <= 10) {
                durationScore = 0.8;
            } else if (durationDiff <= 20) {
                durationScore = 0.5;
            } else if (durationDiff <= 30) {
                durationScore = 0.3;
            } else {
                durationScore = 0.1;
            }
        }

        // Calculate weighted total
        const total = titleScore * 0.4 + artistScore * 0.35 + durationScore * 0.25;

        return { total, titleScore, artistScore, durationScore };
    }

    /**
     * Generate a hash for cache key from track info
     */
    private generateMatchHash(artist: string, title: string, duration?: number): string {
        const normalized = `${artist.toLowerCase().trim()}|${title.toLowerCase().trim()}|${duration || ""}`;
        // Simple hash - good enough for cache keys
        let hash = 0;
        for (let i = 0; i < normalized.length; i++) {
            const char = normalized.charCodeAt(i);
            hash = (hash << 5) - hash + char;
            hash = hash & hash; // Convert to 32-bit integer
        }
        return Math.abs(hash).toString(36);
    }

    // ============================================
    // Stream URL Extraction (via yt-dlp)
    // ============================================

    /**
     * Get a stream URL for a video (cached)
     * 
     * Uses yt-dlp to extract stream URLs. URLs are cached but can be
     * invalidated when they return 403 (expired).
     * 
     * @param videoId - YouTube video ID
     * @param maxAgeMs - Optional max age in ms. If cached URL is older than this, refresh it.
     */
    async getStreamUrl(videoId: string, maxAgeMs?: number): Promise<StreamUrlResult> {
        if (!this.isEnabled()) {
            throw new Error("YouTube Music is disabled");
        }

        // Check cache first
        const cacheKey = STREAM_KEY(videoId);
        const cached = await this.getCached<StreamUrlResult>(cacheKey);
        if (cached && cached.expiresAt > Date.now()) {
            // If maxAgeMs specified, check if URL is fresh enough
            if (maxAgeMs !== undefined) {
                const urlAge = (STREAM_URL_TTL * 1000) - (cached.expiresAt - Date.now());
                if (urlAge > maxAgeMs) {
                    console.log(`[YouTube Music] Stream URL too old for ${videoId} (${Math.round(urlAge / 60000)}min), refreshing...`);
                    // Fall through to extract fresh URL
                } else {
                    console.log(`[YouTube Music] Stream URL cache hit for ${videoId}`);
                    return cached;
                }
            } else {
                console.log(`[YouTube Music] Stream URL cache hit for ${videoId}`);
                return cached;
            }
        }

        // Extract fresh URL via yt-dlp
        console.log(`[YouTube Music] Extracting stream URL for ${videoId} via yt-dlp...`);
        const url = `https://music.youtube.com/watch?v=${videoId}`;

        try {
            // Get best audio stream URL
            const { stdout } = await execPromise(
                `yt-dlp -f "bestaudio[ext=webm]/bestaudio[ext=m4a]/bestaudio" -g --extractor-args "youtube:player_client=android_vr" --no-warnings "${url}"`,
                { timeout: 30000 }
            );

            const streamUrl = stdout.trim().split("\n")[0];
            if (!streamUrl) {
                throw new Error("No stream URL extracted");
            }

            // Get format info
            const { stdout: formatInfo } = await execPromise(
                `yt-dlp -f "bestaudio[ext=webm]/bestaudio[ext=m4a]/bestaudio" --print "%(ext)s" --extractor-args "youtube:player_client=android_vr" --no-warnings "${url}"`,
                { timeout: 10000 }
            ).catch(() => ({ stdout: "webm" }));

            const format = formatInfo.trim() || "webm";
            const expiresAt = Date.now() + STREAM_URL_TTL * 1000;

            // Try to extract content length from URL
            let contentLength: number | undefined;
            try {
                const urlObj = new URL(streamUrl);
                const clenParam = urlObj.searchParams.get("clen");
                if (clenParam) {
                    const parsed = parseInt(clenParam, 10);
                    if (Number.isFinite(parsed)) {
                        contentLength = parsed;
                    }
                }
            } catch {
                // Ignore URL parse failures
            }

            const result: StreamUrlResult = {
                url: streamUrl,
                format,
                expiresAt,
                mimeType: format === "m4a" ? "audio/mp4" : "audio/webm",
                contentLength,
            };

            // Cache the result
            await this.setCache(cacheKey, result, STREAM_URL_TTL);

            console.log(`[YouTube Music] Stream URL extracted for ${videoId} (format: ${format})`);
            return result;
        } catch (error: any) {
            console.error(`[YouTube Music] Failed to extract stream URL for ${videoId}:`, error.message);
            throw new Error(`Failed to get stream URL: ${error.message}`);
        }
    }

    /**
     * Invalidate cached stream URL (e.g., when it returns 403)
     */
    async invalidateStreamUrl(videoId: string): Promise<void> {
        const cacheKey = STREAM_KEY(videoId);
        await this.deleteCache(cacheKey);
        console.log(`[YouTube Music] Invalidated stream URL cache for ${videoId}`);
    }

    // ============================================
    // Download (via yt-dlp)
    // ============================================

    /**
     * Download a track to the specified path
     */
    async downloadTrack(videoId: string, outputDir: string, filename?: string): Promise<DownloadResult> {
        if (!this.isEnabled()) {
            throw new Error("YouTube Music is disabled");
        }

        const url = `https://music.youtube.com/watch?v=${videoId}`;
        const format = DOWNLOAD_FORMAT;

        // Ensure output directory exists
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }

        // Build output template
        const outputTemplate = filename
            ? path.join(outputDir, `${filename}.%(ext)s`)
            : path.join(outputDir, "%(title)s.%(ext)s");

        // Check if file already exists (with expected extension)
        if (filename) {
            const expectedPath = path.join(outputDir, `${filename}.${format}`);
            if (fs.existsSync(expectedPath)) {
                console.log(`[YouTube Music] File already exists: ${expectedPath}`);
                // Get duration from existing file
                let duration = 0;
                try {
                    const { stdout: durationOutput } = await execPromise(
                        `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${expectedPath}"`,
                        { timeout: 10000 }
                    );
                    duration = Math.round(parseFloat(durationOutput.trim()));
                } catch {
                    // Duration extraction failed, not critical
                }
                return { filePath: expectedPath, format, duration };
            }
        }

        console.log(`[YouTube Music] Downloading ${videoId} to ${outputDir}...`);

        try {
            // Build yt-dlp command
            // Use best audio quality available, no transcoding if using native format (opus)
            // Note: We skip --embed-thumbnail because YouTube thumbnails often have encoding issues
            // that cause music-metadata parsing to fail. We fetch covers from Deezer instead.
            const command = [
                "yt-dlp",
                "-x", // Extract audio
                "--audio-format", format,
                "--audio-quality", "0", // 0 = best available (no upsampling)
                "--add-metadata",
                "--no-warnings",
                "--extractor-args", "youtube:player_client=android_vr", // Use android_vr to bypass SABR/PO token
                "--user-agent", `"${DOWNLOAD_USER_AGENT}"`,
                "--referer", "https://music.youtube.com/",
                "-o", `"${outputTemplate}"`,
                "--print", "after_move:filepath", // Print final path
                `"${url}"`,
            ].join(" ");

            const { stdout, stderr } = await execPromise(command, { timeout: 120000 });

            // Get the output file path from yt-dlp's print output
            const lines = stdout.trim().split("\n");
            const filePath = lines[lines.length - 1];

            if (!filePath || !fs.existsSync(filePath)) {
                throw new Error("Download completed but file not found");
            }

            // Get file duration via ffprobe
            let duration = 0;
            try {
                const { stdout: durationOutput } = await execPromise(
                    `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`,
                    { timeout: 10000 }
                );
                duration = Math.round(parseFloat(durationOutput.trim()));
            } catch {
                // Duration extraction failed, not critical
            }

            console.log(`[YouTube Music] Downloaded ${videoId} to ${filePath}`);

            return {
                filePath,
                format,
                duration,
            };
        } catch (error: any) {
            console.error(`[YouTube Music] Download failed for ${videoId}:`, error.message);
            throw new Error(`Download failed: ${error.message}`);
        }
    }

    // ============================================
    // Utility Methods
    // ============================================

    /**
     * Clear all YouTube Music caches
     */
    async clearCache(): Promise<void> {
        try {
            const keys = await redisClient.keys(`${CACHE_PREFIX}*`);
            if (keys.length > 0) {
                await redisClient.del(keys);
                console.log(`[YouTube Music] Cleared ${keys.length} cache entries`);
            }
        } catch (err) {
            console.error("[YouTube Music] Failed to clear cache:", err);
        }
    }

    /**
     * Check if yt-dlp is available
     */
    async checkYtDlpAvailable(): Promise<boolean> {
        try {
            await execPromise("yt-dlp --version", { timeout: 5000 });
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Get yt-dlp version
     */
    async getYtDlpVersion(): Promise<string | null> {
        try {
            const { stdout } = await execPromise("yt-dlp --version", { timeout: 5000 });
            return stdout.trim();
        } catch {
            return null;
        }
    }
}

// Export singleton instance
export const youtubeMusicService = new YouTubeMusicService();
