import { Router } from "express";
import { requireAuthOrToken } from "../middleware/auth";
import { spotifyService } from "../services/spotify";
import { deezerService, DeezerPlaylistPreview, DeezerRadioStation } from "../services/deezer";
import { youtubeMusicService, YouTubeMusicPlaylistPreview } from "../services/youtube-music";

const router = Router();

// All routes require authentication
router.use(requireAuthOrToken);

/**
 * Unified playlist preview type
 */
interface PlaylistPreview {
    id: string;
    source: "deezer" | "spotify" | "youtube";
    type: "playlist" | "radio";
    title: string;
    description: string | null;
    creator: string;
    imageUrl: string | null;
    trackCount: number;
    url: string;
}

/**
 * Convert Deezer playlist to unified format
 */
function deezerPlaylistToUnified(playlist: DeezerPlaylistPreview): PlaylistPreview {
    return {
        id: playlist.id,
        source: "deezer",
        type: "playlist",
        title: playlist.title,
        description: playlist.description,
        creator: playlist.creator,
        imageUrl: playlist.imageUrl,
        trackCount: playlist.trackCount,
        url: `https://www.deezer.com/playlist/${playlist.id}`,
    };
}

/**
 * Convert Deezer radio to unified format
 */
function deezerRadioToUnified(radio: DeezerRadioStation): PlaylistPreview {
    return {
        id: radio.id,
        source: "deezer",
        type: "radio",
        title: radio.title,
        description: radio.description,
        creator: "Deezer",
        imageUrl: radio.imageUrl,
        trackCount: 0, // Radio tracks are dynamic
        url: `https://www.deezer.com/radio-${radio.id}`,
    };
}

// ============================================
// Playlist Endpoints
// ============================================

/**
 * GET /api/browse/playlists/featured
 * Get featured/chart playlists from Deezer
 */
router.get("/playlists/featured", async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
        console.log(`[Browse] Fetching featured playlists (limit: ${limit})...`);

        const playlists = await deezerService.getFeaturedPlaylists(limit);
        console.log(`[Browse] Got ${playlists.length} Deezer playlists`);

        res.json({
            playlists: playlists.map(deezerPlaylistToUnified),
            total: playlists.length,
            source: "deezer",
        });
    } catch (error: any) {
        console.error("Browse featured playlists error:", error);
        res.status(500).json({ error: error.message || "Failed to fetch playlists" });
    }
});

/**
 * GET /api/browse/playlists/search
 * Search for playlists on Deezer
 */
router.get("/playlists/search", async (req, res) => {
    try {
        const query = req.query.q as string;
        if (!query || query.length < 2) {
            return res.status(400).json({ error: "Search query must be at least 2 characters" });
        }

        const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
        console.log(`[Browse] Searching playlists for "${query}"...`);

        const playlists = await deezerService.searchPlaylists(query, limit);
        console.log(`[Browse] Search "${query}": ${playlists.length} results`);

        res.json({
            playlists: playlists.map(deezerPlaylistToUnified),
            total: playlists.length,
            query,
            source: "deezer",
        });
    } catch (error: any) {
        console.error("Browse search playlists error:", error);
        res.status(500).json({ error: error.message || "Failed to search playlists" });
    }
});

/**
 * GET /api/browse/playlists/:id
 * Get full details of a Deezer playlist
 */
router.get("/playlists/:id", async (req, res) => {
    try {
        const { id } = req.params;
        const playlist = await deezerService.getPlaylist(id);

        if (!playlist) {
            return res.status(404).json({ error: "Playlist not found" });
        }

        // Normalize to match Spotify format for frontend compatibility
        res.json({
            id: playlist.id,
            title: playlist.title,
            description: playlist.description,
            creator: playlist.creator,
            imageUrl: playlist.imageUrl,
            trackCount: playlist.trackCount,
            tracks: playlist.tracks.map(t => ({
                id: t.deezerId,           // Normalize field name (was deezerId)
                title: t.title,
                artist: t.artist,
                artistId: t.artistId,
                album: t.album,
                albumId: t.albumId,
                durationMs: t.durationMs,
                previewUrl: t.previewUrl,
                coverUrl: t.coverUrl,
            })),
            isPublic: playlist.isPublic,
            source: "deezer",
            url: `https://www.deezer.com/playlist/${id}`,
        });
    } catch (error: any) {
        console.error("Playlist fetch error:", error);
        res.status(500).json({ error: error.message || "Failed to fetch playlist" });
    }
});

/**
 * GET /api/browse/spotify/playlists/:id
 * Get full details of a Spotify playlist
 * Normalizes format to match Deezer for frontend compatibility
 */
router.get("/spotify/playlists/:id", async (req, res) => {
    try {
        const { id } = req.params;
        const playlist = await spotifyService.getPlaylist(id);

        if (!playlist) {
            return res.status(404).json({ error: "Playlist not found" });
        }

        // Normalize to match Deezer format for frontend compatibility
        res.json({
            id: playlist.id,
            title: playlist.name,           // Spotify uses "name", normalize to "title"
            description: playlist.description,
            creator: playlist.owner,        // Spotify uses "owner", normalize to "creator"
            imageUrl: playlist.imageUrl,
            trackCount: playlist.trackCount,
            tracks: playlist.tracks.map(t => ({
                id: t.spotifyId,            // Normalize ID field name
                title: t.title,
                artist: t.artist,
                artistId: t.artistId,
                album: t.album,
                albumId: t.albumId,
                durationMs: t.durationMs,
                previewUrl: t.previewUrl,
                coverUrl: t.coverUrl,
                isrc: t.isrc,               // Keep ISRC for better matching
            })),
            isPublic: playlist.isPublic,
            source: "spotify",
            url: `https://open.spotify.com/playlist/${id}`,
        });
    } catch (error: any) {
        console.error("Spotify playlist fetch error:", error);
        res.status(500).json({ error: error.message || "Failed to fetch Spotify playlist" });
    }
});

// ============================================
// Radio Endpoints
// ============================================

/**
 * GET /api/browse/radios
 * Get all radio stations (mood/theme based mixes)
 */
router.get("/radios", async (req, res) => {
    try {
        console.log("[Browse] Fetching radio stations...");
        const radios = await deezerService.getRadioStations();

        res.json({
            radios: radios.map(deezerRadioToUnified),
            total: radios.length,
            source: "deezer",
        });
    } catch (error: any) {
        console.error("Browse radios error:", error);
        res.status(500).json({ error: error.message || "Failed to fetch radios" });
    }
});

/**
 * GET /api/browse/radios/by-genre
 * Get radio stations organized by genre
 */
router.get("/radios/by-genre", async (req, res) => {
    try {
        console.log("[Browse] Fetching radios by genre...");
        const genresWithRadios = await deezerService.getRadiosByGenre();

        // Transform to include unified format
        const result = genresWithRadios.map(genre => ({
            id: genre.id,
            name: genre.name,
            radios: genre.radios.map(deezerRadioToUnified),
        }));

        res.json({
            genres: result,
            total: result.length,
            source: "deezer",
        });
    } catch (error: any) {
        console.error("Browse radios by genre error:", error);
        res.status(500).json({ error: error.message || "Failed to fetch radios" });
    }
});

/**
 * GET /api/browse/radios/:id
 * Get tracks from a radio station (as playlist format for import)
 */
router.get("/radios/:id", async (req, res) => {
    try {
        const { id } = req.params;
        console.log(`[Browse] Fetching radio ${id} tracks...`);
        
        const radioPlaylist = await deezerService.getRadioTracks(id);

        if (!radioPlaylist) {
            return res.status(404).json({ error: "Radio station not found" });
        }

        // Normalize track IDs for frontend compatibility
        res.json({
            id: radioPlaylist.id,
            title: radioPlaylist.title,
            description: radioPlaylist.description,
            creator: radioPlaylist.creator,
            imageUrl: radioPlaylist.imageUrl,
            trackCount: radioPlaylist.trackCount,
            tracks: radioPlaylist.tracks.map(t => ({
                id: t.deezerId,           // Normalize field name (was deezerId)
                title: t.title,
                artist: t.artist,
                artistId: t.artistId,
                album: t.album,
                albumId: t.albumId,
                durationMs: t.durationMs,
                previewUrl: t.previewUrl,
                coverUrl: t.coverUrl,
            })),
            isPublic: radioPlaylist.isPublic,
            source: "deezer",
            type: "radio",
        });
    } catch (error: any) {
        console.error("Radio tracks error:", error);
        res.status(500).json({ error: error.message || "Failed to fetch radio tracks" });
    }
});

// ============================================
// Genre Endpoints
// ============================================

/**
 * GET /api/browse/genres
 * Get all available genres
 */
router.get("/genres", async (req, res) => {
    try {
        console.log("[Browse] Fetching genres...");
        const genres = await deezerService.getGenres();

        res.json({
            genres,
            total: genres.length,
            source: "deezer",
        });
    } catch (error: any) {
        console.error("Browse genres error:", error);
        res.status(500).json({ error: error.message || "Failed to fetch genres" });
    }
});

/**
 * GET /api/browse/genres/:id
 * Get content for a specific genre (playlists + radios)
 */
router.get("/genres/:id", async (req, res) => {
    try {
        const genreId = parseInt(req.params.id);
        if (isNaN(genreId)) {
            return res.status(400).json({ error: "Invalid genre ID" });
        }

        console.log(`[Browse] Fetching content for genre ${genreId}...`);
        const content = await deezerService.getEditorialContent(genreId);

        res.json({
            genreId,
            playlists: content.playlists.map(deezerPlaylistToUnified),
            radios: content.radios.map(deezerRadioToUnified),
            source: "deezer",
        });
    } catch (error: any) {
        console.error("Genre content error:", error);
        res.status(500).json({ error: error.message || "Failed to fetch genre content" });
    }
});

/**
 * GET /api/browse/genres/:id/playlists
 * Get playlists for a specific genre (by name search)
 */
router.get("/genres/:id/playlists", async (req, res) => {
    try {
        const genreId = parseInt(req.params.id);
        const limit = Math.min(parseInt(req.query.limit as string) || 20, 50);

        // Get genre name first
        const genres = await deezerService.getGenres();
        const genre = genres.find(g => g.id === genreId);

        if (!genre) {
            return res.status(404).json({ error: "Genre not found" });
        }

        const playlists = await deezerService.getGenrePlaylists(genre.name, limit);

        res.json({
            playlists: playlists.map(deezerPlaylistToUnified),
            total: playlists.length,
            genre: genre.name,
            source: "deezer",
        });
    } catch (error: any) {
        console.error("Genre playlists error:", error);
        res.status(500).json({ error: error.message || "Failed to fetch genre playlists" });
    }
});

// ============================================
// URL Parsing (supports both Spotify & Deezer)
// ============================================

/**
 * POST /api/browse/playlists/parse
 * Parse a Spotify or Deezer URL and return playlist info
 * This is the main entry point for URL-based imports
 */
router.post("/playlists/parse", async (req, res) => {
    try {
        const { url } = req.body;
        if (!url) {
            return res.status(400).json({ error: "URL is required" });
        }

        // Try Deezer first (our primary source)
        const deezerParsed = deezerService.parseUrl(url);
        if (deezerParsed && deezerParsed.type === "playlist") {
            return res.json({
                source: "deezer",
                type: "playlist",
                id: deezerParsed.id,
                url: `https://www.deezer.com/playlist/${deezerParsed.id}`,
            });
        }

        // Try Spotify (still supported for URL imports)
        const spotifyParsed = spotifyService.parseUrl(url);
        if (spotifyParsed && spotifyParsed.type === "playlist") {
            return res.json({
                source: "spotify",
                type: "playlist",
                id: spotifyParsed.id,
                url: `https://open.spotify.com/playlist/${spotifyParsed.id}`,
            });
        }

        // Try YouTube Music
        const youtubeParsed = youtubeMusicService.parseUrl(url);
        if (youtubeParsed && youtubeParsed.type === "playlist") {
            return res.json({
                source: "youtube",
                type: "playlist",
                id: youtubeParsed.id,
                url: `https://music.youtube.com/playlist?list=${youtubeParsed.id}`,
            });
        }

        return res.status(400).json({
            error: "Invalid or unsupported URL. Please provide a Spotify, Deezer, or YouTube Music playlist URL."
        });
    } catch (error: any) {
        console.error("Parse URL error:", error);
        res.status(500).json({ error: error.message || "Failed to parse URL" });
    }
});

// ============================================
// Combined Browse Endpoint (for frontend convenience)
// ============================================

/**
 * GET /api/browse/all
 * Get a combined view of featured content (playlists, genres) from Deezer
 * Note: Radio stations are now internal (library-based), not from Deezer
 */
router.get("/all", async (req, res) => {
    try {
        console.log("[Browse] Fetching Deezer browse content (playlists + genres)...");

        // Only fetch playlists and genres - radios are now internal library-based
        const [playlists, genres] = await Promise.all([
            deezerService.getFeaturedPlaylists(200),
            deezerService.getGenres(),
        ]);

        res.json({
            playlists: playlists.map(deezerPlaylistToUnified),
            radios: [], // Radio stations are now internal (use /api/library/radio)
            genres,
            radiosByGenre: [], // Deprecated - use internal radios
            source: "deezer",
        });
    } catch (error: any) {
        console.error("Browse all error:", error);
        res.status(500).json({ error: error.message || "Failed to fetch browse content" });
    }
});

// ============================================
// Spotify Browse Endpoints
// ============================================

/**
 * Convert Spotify playlist to unified format
 */
function spotifyPlaylistToUnified(playlist: { id: string; name: string; description: string | null; owner: string; imageUrl: string | null; trackCount: number }): PlaylistPreview {
    return {
        id: playlist.id,
        source: "spotify",
        type: "playlist",
        title: playlist.name,
        description: playlist.description,
        creator: playlist.owner,
        imageUrl: playlist.imageUrl,
        trackCount: playlist.trackCount,
        url: `https://open.spotify.com/playlist/${playlist.id}`,
    };
}

/**
 * GET /api/browse/spotify/all
 * Get Spotify featured playlists and categories
 */
router.get("/spotify/all", async (req, res) => {
    try {
        console.log("[Browse] Fetching Spotify browse content (playlists + categories)...");

        const [playlists, categories] = await Promise.all([
            spotifyService.getFeaturedPlaylists(50),
            spotifyService.getCategories(50),
        ]);

        console.log(`[Browse] Spotify: ${playlists.length} playlists, ${categories.length} categories`);

        res.json({
            playlists: playlists.map(spotifyPlaylistToUnified),
            categories,
            source: "spotify",
        });
    } catch (error: any) {
        console.error("Spotify browse all error:", error);
        res.status(500).json({ error: error.message || "Failed to fetch Spotify content" });
    }
});

/**
 * GET /api/browse/spotify/categories/:id/playlists
 * Get playlists for a specific Spotify category
 * Accepts optional `name` query param for fallback search
 */
router.get("/spotify/categories/:id/playlists", async (req, res) => {
    try {
        const categoryId = req.params.id;
        const categoryName = req.query.name as string;
        const limit = Math.min(parseInt(req.query.limit as string) || 50, 50);

        console.log(`[Browse] Fetching Spotify playlists for category ${categoryId}...`);
        
        // Try the category API first
        let playlists = await spotifyService.getCategoryPlaylists(categoryId, limit);
        
        // If no results and we have a category name, search by name as fallback
        if (playlists.length === 0 && categoryName) {
            console.log(`[Browse] Category API returned empty, searching by name "${categoryName}"...`);
            playlists = await spotifyService.getCategoryPlaylistsByName(categoryName, limit);
        }

        res.json({
            playlists: playlists.map(spotifyPlaylistToUnified),
            total: playlists.length,
            categoryId,
            source: "spotify",
        });
    } catch (error: any) {
        console.error("Spotify category playlists error:", error);
        res.status(500).json({ error: error.message || "Failed to fetch category playlists" });
    }
});

/**
 * GET /api/browse/spotify/playlists/search
 * Search for playlists on Spotify
 */
router.get("/spotify/playlists/search", async (req, res) => {
    try {
        const query = req.query.q as string;
        if (!query || query.length < 2) {
            return res.status(400).json({ error: "Search query must be at least 2 characters" });
        }

        const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
        console.log(`[Browse] Searching Spotify playlists for "${query}"...`);

        const playlists = await spotifyService.searchPlaylists(query, limit);
        console.log(`[Browse] Spotify search "${query}": ${playlists.length} results`);

        res.json({
            playlists: playlists.map(spotifyPlaylistToUnified),
            total: playlists.length,
            query,
            source: "spotify",
        });
    } catch (error: any) {
        console.error("Spotify search playlists error:", error);
        res.status(500).json({ error: error.message || "Failed to search Spotify playlists" });
    }
});

// ============================================
// YouTube Music Browse Endpoints
// ============================================

/**
 * Convert YouTube Music playlist to unified format
 */
function youtubePlaylistToUnified(playlist: YouTubeMusicPlaylistPreview): PlaylistPreview {
    return {
        id: playlist.id,
        source: "youtube",
        type: "playlist",
        title: playlist.title,
        description: playlist.description,
        creator: playlist.creator,
        imageUrl: playlist.imageUrl,
        trackCount: playlist.trackCount,
        url: `https://music.youtube.com/playlist?list=${playlist.id}`,
    };
}

/**
 * GET /api/browse/youtube/all
 * Get YouTube Music explore/trending playlists
 */
router.get("/youtube/all", async (req, res) => {
    try {
        console.log("[Browse] Fetching YouTube Music explore playlists...");

        const sections = await youtubeMusicService.getExplorePlaylistSections(40, 40);
        const playlists = [...sections.featured, ...sections.community];

        console.log(
            `[Browse] YouTube Music: ${sections.featured.length} featured, ${sections.community.length} community playlists`
        );

        res.json({
            playlists: playlists.map(youtubePlaylistToUnified),
            featuredPlaylists: sections.featured.map(youtubePlaylistToUnified),
            communityPlaylists: sections.community.map(youtubePlaylistToUnified),
            source: "youtube",
        });
    } catch (error: any) {
        console.error("YouTube Music browse all error:", error);
        res.status(500).json({ error: error.message || "Failed to fetch YouTube Music content" });
    }
});

/**
 * GET /api/browse/youtube/playlists/:id
 * Get full details of a YouTube Music playlist
 */
router.get("/youtube/playlists/:id", async (req, res) => {
    try {
        const { id } = req.params;
        const playlist = await youtubeMusicService.getPlaylist(id);

        if (!playlist) {
            return res.status(404).json({ error: "Playlist not found" });
        }

        res.json({
            id: playlist.id,
            title: playlist.title,
            description: playlist.description,
            creator: playlist.creator,
            imageUrl: playlist.imageUrl,
            trackCount: playlist.trackCount,
            tracks: playlist.tracks.map(t => ({
                id: t.videoId,
                title: t.title,
                artist: t.artist,
                artistId: "",
                album: t.album || "",
                albumId: "",
                durationMs: t.duration * 1000,
                previewUrl: null,
                coverUrl: t.thumbnail || null,
            })),
            isPublic: playlist.isPublic,
            source: "youtube",
            url: playlist.url,
        });
    } catch (error: any) {
        console.error("YouTube Music playlist fetch error:", error);
        res.status(500).json({ error: error.message || "Failed to fetch YouTube Music playlist" });
    }
});

/**
 * GET /api/browse/youtube/playlists/search
 * Search for playlists on YouTube Music
 */
router.get("/youtube/playlists/search", async (req, res) => {
    try {
        const query = req.query.q as string;
        if (!query || query.length < 2) {
            return res.status(400).json({ error: "Search query must be at least 2 characters" });
        }

        const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
        console.log(`[Browse] Searching YouTube Music playlists for "${query}"...`);

        const playlists = await youtubeMusicService.searchPlaylists(query, limit);
        console.log(`[Browse] YouTube Music search "${query}": ${playlists.length} results`);

        res.json({
            playlists: playlists.map(youtubePlaylistToUnified),
            total: playlists.length,
            query,
            source: "youtube",
        });
    } catch (error: any) {
        console.error("YouTube Music search playlists error:", error);
        res.status(500).json({ error: error.message || "Failed to search YouTube Music playlists" });
    }
});

// ============================================
// Combined Search Endpoint (all sources)
// ============================================

/**
 * GET /api/browse/search
 * Search for playlists on both Deezer and Spotify
 * Returns interleaved results from both sources
 */
router.get("/search", async (req, res) => {
    try {
        const query = req.query.q as string;
        if (!query || query.length < 2) {
            return res.status(400).json({ error: "Search query must be at least 2 characters" });
        }

        const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
        console.log(`[Browse] Combined search for "${query}" (limit: ${limit})...`);

        // Search all sources in parallel
        const [deezerResults, spotifyResults, youtubeResults] = await Promise.all([
            deezerService.searchPlaylists(query, limit).catch(err => {
                console.error("Deezer search failed:", err.message);
                return [];
            }),
            spotifyService.searchPlaylists(query, limit).catch(err => {
                console.error("Spotify search failed:", err.message);
                return [];
            }),
            youtubeMusicService.searchPlaylists(query, limit).catch(err => {
                console.error("YouTube Music search failed:", err.message);
                return [];
            }),
        ]);

        console.log(`[Browse] Combined search "${query}": Deezer=${deezerResults.length}, Spotify=${spotifyResults.length}, YouTube=${youtubeResults.length}`);

        // Convert to unified format
        const deezerPlaylists = deezerResults.map(deezerPlaylistToUnified);
        const spotifyPlaylists = spotifyResults.map(spotifyPlaylistToUnified);
        const youtubePlaylists = youtubeResults.map(youtubePlaylistToUnified);

        // Interleave results (Deezer, Spotify, YouTube, Deezer, Spotify, YouTube, ...)
        const interleaved: PlaylistPreview[] = [];
        const maxLen = Math.max(deezerPlaylists.length, spotifyPlaylists.length, youtubePlaylists.length);

        for (let i = 0; i < maxLen; i++) {
            if (i < deezerPlaylists.length) {
                interleaved.push(deezerPlaylists[i]);
            }
            if (i < spotifyPlaylists.length) {
                interleaved.push(spotifyPlaylists[i]);
            }
            if (i < youtubePlaylists.length) {
                interleaved.push(youtubePlaylists[i]);
            }
        }

        res.json({
            playlists: interleaved,
            total: interleaved.length,
            query,
            sources: {
                deezer: deezerResults.length,
                spotify: spotifyResults.length,
                youtube: youtubeResults.length,
            },
        });
    } catch (error: any) {
        console.error("Combined search error:", error);
        res.status(500).json({ error: error.message || "Failed to search playlists" });
    }
});

export default router;
