import { Router } from "express";
import { lastFmService } from "../services/lastfm";
import { musicBrainzService } from "../services/musicbrainz";
import { fanartService } from "../services/fanart";
import { deezerService } from "../services/deezer";
import { redisClient } from "../utils/redis";
import { openRouterService, SimilarArtistRecommendation, ChatMessage } from "../services/openrouter";
import { normalizeQuotes, normalizeFullwidth } from "../utils/stringNormalization";
import crypto from "crypto";
import { prisma } from "../utils/db";

const router = Router();

// Cache TTL for discovery content (shorter since it's not owned)
const DISCOVERY_CACHE_TTL = 24 * 60 * 60; // 24 hours

/**
 * Safely decode a URI component, returning the original string if decoding fails.
 */
function safeDecodeURIComponent(str: string): string {
    try {
        return decodeURIComponent(str);
    } catch {
        return str;
    }
}

const AI_SIMILAR_CACHE_TTL = 7 * 24 * 60 * 60; // 7 days

// Interface for enriched similar artist
interface EnrichedSimilarArtist extends SimilarArtistRecommendation {
    inLibrary: boolean;
    libraryId: string | null;
    image: string | null;
}

// GET /artists/image/:artistName - Get just the artist image (lightweight)
router.get("/image/:artistName", async (req, res) => {
    try {
        const artistName = safeDecodeURIComponent(req.params.artistName);
        const cacheKey = `artist-image:${artistName.toLowerCase()}`;

        // Check cache first
        const cached = await redisClient.get(cacheKey);
        if (cached) {
            return res.json({ image: cached === "null" ? null : cached });
        }

        // Fetch from Deezer (fast)
        const image = await deezerService.getArtistImage(artistName);

        // Cache for 7 days
        await redisClient.setEx(cacheKey, 7 * 24 * 60 * 60, image || "null");

        res.json({ image });
    } catch (error: any) {
        console.error("[Artist Image] Error:", error.message);
        res.json({ image: null });
    }
});

// GET /artists/ai-similar/:artistId - Get AI-powered similar artist recommendations
router.get("/ai-similar/:artistId", async (req, res) => {
    try {
        const { artistId } = req.params;
        const cacheKey = `ai-similar:${artistId}`;

        console.log(`[AI Similar] Request for artist: ${artistId}`);

        // Check if OpenRouter is available
        const isAvailable = await openRouterService.isAvailable();
        console.log(`[AI Similar] OpenRouter available: ${isAvailable}`);
        if (!isAvailable) {
            return res.status(503).json({
                error: "AI recommendations not available",
                message: "OpenRouter is not configured. Enable it in Settings > AI & Enhancement Services.",
            });
        }

        // Check Redis cache first
        try {
            const cached = await redisClient.get(cacheKey);
            if (cached) {
                console.log(`[AI Similar] Cache hit for artist: ${artistId}`);
                return res.json(JSON.parse(cached));
            }
        } catch (err) {
            // Redis errors are non-critical
        }

        // Get artist info - first try library, then discovery
        let artist: any = null;
        let source: "library" | "discovery" = "library";

        // Check if it's a database ID (UUID or CUID) or name/mbid
        // UUID format: 550e8400-e29b-41d4-a716-446655440000
        // CUID format: cmjotvfy7019011cvh80ihq9o (starts with 'c', 25 chars)
        const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(artistId);
        const isCUID = /^c[a-z0-9]{24}$/i.test(artistId);
        const isDatabaseId = isUUID || isCUID;
        console.log(`[AI Similar] Artist ID type: UUID=${isUUID}, CUID=${isCUID}, isDatabaseId=${isDatabaseId}`);

        if (isDatabaseId) {
            // Try to find in library first
            const libraryArtist = await prisma.artist.findUnique({
                where: { id: artistId },
                select: {
                    name: true,
                    genres: true, // JSON field with array of genre strings
                    albums: { select: { title: true, year: true } },
                },
            });

            if (libraryArtist) {
                // genres is stored as JSON array of strings
                const genreArray = Array.isArray(libraryArtist.genres)
                    ? libraryArtist.genres
                    : [];
                artist = {
                    name: libraryArtist.name,
                    genres: genreArray as string[],
                    albums: libraryArtist.albums.map((a) => ({
                        name: a.title,
                        year: a.year,
                    })),
                };
            }
        }

        // If not in library, try discovery (using Last.fm)
        if (!artist) {
            source = "discovery";
            const nameOrMbid = safeDecodeURIComponent(artistId);

            try {
                const lastFmInfo = await lastFmService.getArtistInfo(nameOrMbid);
                if (lastFmInfo) {
                    artist = {
                        name: lastFmInfo.name || nameOrMbid,
                        genres: lastFmInfo.tags?.tag?.map((t: any) => t.name) || [],
                        albums: [], // We don't have album info from Last.fm in this context
                    };
                }
            } catch (err) {
                // Last.fm lookup failed, use just the name
                artist = {
                    name: nameOrMbid,
                    genres: [],
                    albums: [],
                };
            }
        }

        if (!artist) {
            console.log(`[AI Similar] Artist not found for ID: ${artistId}`);
            return res.status(404).json({ error: "Artist not found" });
        }
        console.log(`[AI Similar] Found artist: ${artist.name} (source: ${source})`);

        // Get user's library artists for "in library" detection
        const libraryArtists = await prisma.artist.findMany({
            select: { id: true, name: true },
        });
        const libraryArtistNames = libraryArtists.map((a) => a.name);

        console.log(`[AI Similar] Fetching recommendations for: ${artist.name}`);

        // Get AI recommendations
        const recommendations = await openRouterService.getSimilarArtists({
            artistName: artist.name,
            genres: artist.genres,
            albums: artist.albums,
            userLibraryArtists: libraryArtistNames,
        });

        // Enrich with library status and images
        const enriched: EnrichedSimilarArtist[] = await Promise.all(
            recommendations.map(async (rec) => {
                const libraryMatch = libraryArtists.find(
                    (a) => a.name.toLowerCase() === rec.artistName.toLowerCase()
                );

                // Try to get an image from Deezer
                let image: string | null = null;
                try {
                    image = await deezerService.getArtistImage(rec.artistName);
                } catch (err) {
                    // Silently fail - image is optional
                }

                return {
                    ...rec,
                    inLibrary: !!libraryMatch,
                    libraryId: libraryMatch?.id || null,
                    image,
                };
            })
        );

        const response = {
            artistName: artist.name,
            source,
            recommendations: enriched,
            generatedAt: new Date().toISOString(),
        };

        // Cache the response
        try {
            await redisClient.setEx(
                cacheKey,
                AI_SIMILAR_CACHE_TTL,
                JSON.stringify(response)
            );
            console.log(`[AI Similar] Cached recommendations for: ${artist.name}`);
        } catch (err) {
            // Redis errors are non-critical
        }

        res.json(response);
    } catch (error: any) {
        console.error("[AI Similar] Error:", error);
        res.status(500).json({
            error: "Failed to get AI recommendations",
            message: error.message,
        });
    }
});

// Conversation TTL (1 hour of inactivity)
const CONVERSATION_TTL = 60 * 60;

// POST /artists/ai-chat/:artistId - Conversational AI recommendations
router.post("/ai-chat/:artistId", async (req, res) => {
    try {
        const { artistId } = req.params;
        const { message, conversationId } = req.body;

        console.log(`[AI Chat] Request for artist: ${artistId}, convId: ${conversationId || 'new'}`);

        // Check if OpenRouter is available
        const isAvailable = await openRouterService.isAvailable();
        if (!isAvailable) {
            return res.status(503).json({
                error: "AI chat not available",
                message: "OpenRouter is not configured. Enable it in Settings > AI & Enhancement Services.",
            });
        }

        // Get or create conversation ID
        const convId = conversationId || crypto.randomUUID();
        const convKey = `ai-chat:${convId}`;

        // Get existing conversation from Redis
        let conversationData: {
            artistId: string;
            artistName: string;
            genres: string[];
            albums: Array<{ name: string; year: number | null }>;
            messages: ChatMessage[];
        } | null = null;

        try {
            const cached = await redisClient.get(convKey);
            if (cached) {
                conversationData = JSON.parse(cached);
                // Verify the conversation is for the same artist
                if (conversationData?.artistId !== artistId) {
                    conversationData = null; // Reset if artist changed
                }
            }
        } catch (err) {
            // Redis errors are non-critical
        }

        // If no conversation, look up artist info
        if (!conversationData) {
            // Check if it's a database ID
            const isCUID = /^c[a-z0-9]{20,}$/i.test(artistId);
            const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(artistId);
            const isDatabaseId = isCUID || isUUID;

            let artistInfo: { name: string; genres: string[]; albums: Array<{ name: string; year: number | null }> } | null = null;

            if (isDatabaseId) {
                const libraryArtist = await prisma.artist.findUnique({
                    where: { id: artistId },
                    select: {
                        name: true,
                        genres: true,
                        albums: { select: { title: true, year: true } },
                    },
                });

                if (libraryArtist) {
                    const genreArray = Array.isArray(libraryArtist.genres) ? libraryArtist.genres : [];
                    artistInfo = {
                        name: libraryArtist.name,
                        genres: genreArray as string[],
                        albums: libraryArtist.albums.map((a) => ({ name: a.title, year: a.year })),
                    };
                }
            }

            if (!artistInfo) {
                // Try discovery via Last.fm
                const nameOrMbid = safeDecodeURIComponent(artistId);
                try {
                    const lastFmInfo = await lastFmService.getArtistInfo(nameOrMbid);
                    if (lastFmInfo) {
                        artistInfo = {
                            name: lastFmInfo.name || nameOrMbid,
                            genres: lastFmInfo.tags?.tag?.map((t: any) => t.name) || [],
                            albums: [],
                        };
                    }
                } catch (err) {
                    artistInfo = { name: nameOrMbid, genres: [], albums: [] };
                }
            }

            if (!artistInfo) {
                return res.status(404).json({ error: "Artist not found" });
            }

            conversationData = {
                artistId,
                artistName: artistInfo.name,
                genres: artistInfo.genres,
                albums: artistInfo.albums,
                messages: [],
            };
        }

        // Get user's library artists
        const libraryArtists = await prisma.artist.findMany({
            select: { id: true, name: true },
        });
        const libraryArtistNames = libraryArtists.map((a) => a.name);

        // Call OpenRouter with conversation context
        const aiResponse = await openRouterService.chatAboutArtist({
            artistName: conversationData.artistName,
            genres: conversationData.genres,
            albums: conversationData.albums,
            userLibraryArtists: libraryArtistNames,
            messages: conversationData.messages,
            userMessage: message,
        });

        // Update conversation history
        if (message) {
            conversationData.messages.push({ role: "user", content: message });
        } else if (conversationData.messages.length === 0) {
            conversationData.messages.push({ role: "user", content: "Recommend similar artists to explore." });
        }
        conversationData.messages.push({
            role: "assistant",
            content: JSON.stringify({ text: aiResponse.text, recommendations: aiResponse.recommendations }),
        });

        // Save conversation to Redis
        try {
            await redisClient.setEx(convKey, CONVERSATION_TTL, JSON.stringify(conversationData));
        } catch (err) {
            // Redis errors are non-critical
        }

        // Enrich recommendations with library status and images
        const enriched: EnrichedSimilarArtist[] = await Promise.all(
            aiResponse.recommendations.map(async (rec) => {
                const libraryMatch = libraryArtists.find(
                    (a) => a.name.toLowerCase() === rec.artistName.toLowerCase()
                );

                let image: string | null = null;
                try {
                    image = await deezerService.getArtistImage(rec.artistName);
                } catch (err) {
                    // Silently fail
                }

                return {
                    ...rec,
                    inLibrary: !!libraryMatch,
                    libraryId: libraryMatch?.id || null,
                    image,
                };
            })
        );

        res.json({
            conversationId: convId,
            artistName: conversationData.artistName,
            text: aiResponse.text,
            recommendations: enriched,
            model: aiResponse.model,
        });
    } catch (error: any) {
        console.error("[AI Chat] Error:", error);
        res.status(500).json({
            error: "Failed to get AI response",
            message: error.message,
        });
    }
});

// GET /artists/preview/:artistName/:trackTitle - Get Deezer preview URL for a track
// Preferred: use /artists/preview?artist=...&track=... to avoid path encoding issues
router.get("/preview", async (req, res) => {
    try {
        const artistParam = req.query.artist;
        const trackParam = req.query.track;

        if (typeof artistParam !== "string" || typeof trackParam !== "string") {
            return res.status(400).json({
                error: "Missing artist or track query parameter",
            });
        }

        const decodedArtist = safeDecodeURIComponent(artistParam);
        const decodedTrack = safeDecodeURIComponent(trackParam);

        console.log(
            `Getting preview for "${decodedTrack}" by ${decodedArtist}`
        );

        const previewInfo = await deezerService.getTrackPreviewWithInfo(
            decodedArtist,
            decodedTrack
        );

        if (previewInfo) {
            return res.json({
                previewUrl: previewInfo.previewUrl,
                albumTitle: previewInfo.albumTitle,
                albumCover: previewInfo.albumCover,
            });
        }

        return res.status(404).json({ error: "Preview not found" });
    } catch (error: any) {
        console.error("Preview fetch error:", error);
        return res.status(500).json({
            error: "Failed to fetch preview",
            message: error.message,
        });
    }
});

// Legacy path-based preview endpoint
router.get("/preview/:artistName/:trackTitle", async (req, res) => {
    try {
        const { artistName, trackTitle } = req.params;
        const decodedArtist = safeDecodeURIComponent(artistName);
        const decodedTrack = safeDecodeURIComponent(trackTitle);

        console.log(
            `Getting preview for "${decodedTrack}" by ${decodedArtist}`
        );

        const previewInfo = await deezerService.getTrackPreviewWithInfo(
            decodedArtist,
            decodedTrack
        );

        if (previewInfo) {
            res.json({
                previewUrl: previewInfo.previewUrl,
                albumTitle: previewInfo.albumTitle,
                albumCover: previewInfo.albumCover,
            });
        } else {
            res.status(404).json({ error: "Preview not found" });
        }
    } catch (error: any) {
        console.error("Preview fetch error:", error);
        res.status(500).json({
            error: "Failed to fetch preview",
            message: error.message,
        });
    }
});

// GET /artists/discover/:nameOrMbid - Get artist details for discovery (not in library yet)
router.get("/discover/:nameOrMbid", async (req, res) => {
    try {
        const { nameOrMbid } = req.params;

        // Check if it's an MBID (UUID format) or name - needed for cache key normalization
        const isMbid =
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
                nameOrMbid
            );

        // Check Redis cache first for discovery content
        // Normalize the cache key so "ＧＨＯＳＴ" and "GHOST" share the same cache entry
        const normalizedCacheKey = isMbid
            ? nameOrMbid
            : normalizeFullwidth(safeDecodeURIComponent(nameOrMbid)).toLowerCase();
        const cacheKey = `discovery:artist:${normalizedCacheKey}`;
        try {
            const cached = await redisClient.get(cacheKey);
            if (cached) {
                console.log(`[Discovery] Cache hit for artist: ${nameOrMbid}`);
                return res.json(JSON.parse(cached));
            }
        } catch (err) {
            // Redis errors are non-critical
        }

        let mbid: string | null = isMbid ? nameOrMbid : null;
        // Keep original name for display, use normalized for lookups
        const originalName: string = isMbid ? "" : safeDecodeURIComponent(nameOrMbid);
        let artistName: string = originalName;
        const normalizedName = artistName ? normalizeFullwidth(artistName) : "";

        // If we have a name but no MBID, search for it
        if (!mbid && artistName) {
            // Step 1: Try searching with the ORIGINAL name first
            let mbResults = await musicBrainzService.searchArtist(artistName, 10);

            // Look for exact match with original name (case-insensitive)
            // Normalize quotes because MusicBrainz uses typographic quotes (') but URLs use straight (')
            const normalizedArtistName = normalizeQuotes(artistName.toLowerCase());
            let exactMatch = mbResults.find((r: any) =>
                normalizeQuotes(r.name.toLowerCase()) === normalizedArtistName
            );

            if (exactMatch) {
                mbid = exactMatch.id;
                // Use normalized name (straight quotes) for external API compatibility
                // MusicBrainz uses typographic quotes which Last.fm doesn't recognize
                artistName = normalizeQuotes(exactMatch.name);
            } else if (normalizedName.toLowerCase() !== artistName.toLowerCase()) {
                // Step 2: Only if normalization actually changed the name,
                // try searching with normalized name (handles ＧＨＯＳＴ -> GHOST)
                mbResults = await musicBrainzService.searchArtist(normalizedName, 10);

                // Look for match where normalized names are equal
                const normalizedSearchName = normalizeQuotes(normalizedName.toLowerCase());
                exactMatch = mbResults.find((r: any) =>
                    normalizeQuotes(normalizeFullwidth(r.name).toLowerCase()) === normalizedSearchName
                );

                if (exactMatch) {
                    mbid = exactMatch.id;
                    artistName = normalizeQuotes(exactMatch.name);
                } else if (mbResults.length > 0) {
                    // Fallback to first result only for normalized searches
                    // (e.g., ＧＨＯＳＴ where there's no exact "ＧＨＯＳＴ" artist)
                    mbid = mbResults[0].id;
                    artistName = normalizeQuotes(mbResults[0].name);
                }
            }
            // If original search had results but no exact match,
            // we intentionally DON'T fall back to first result
            // This prevents "Ghøst" from matching "GHØST GIRL"
        }

        // If no MusicBrainz match was found, at least normalize fullwidth characters
        // for external API compatibility (Last.fm, Deezer won't recognize "ＧＨＯＳＴ")
        if (!mbid && artistName === originalName && normalizedName !== originalName) {
            artistName = normalizedName;
        }

        // If we have MBID but no name, get it from MusicBrainz
        if (mbid && !artistName) {
            const mbArtist = await musicBrainzService.getArtist(mbid);
            artistName = normalizeQuotes(mbArtist.name);
        }

        if (!artistName) {
            return res.status(404).json({ error: "Artist not found" });
        }

        // Get artist info from Last.fm
        const lastFmInfo = await lastFmService.getArtistInfo(
            artistName,
            mbid || undefined
        );

        // Filter out generic "multiple artists" biographies from Last.fm
        // These occur when Last.fm groups artists with the same name
        let bio = lastFmInfo?.bio?.summary || null;
        if (bio) {
            const lowerBio = bio.toLowerCase();
            if (
                (lowerBio.includes("there are") &&
                    (lowerBio.includes("artist") ||
                        lowerBio.includes("band")) &&
                    lowerBio.includes("with the name")) ||
                lowerBio.includes("there is more than one artist") ||
                lowerBio.includes("multiple artists")
            ) {
                // This is a disambiguation page - don't show it
                console.log(
                    `  Filtered out disambiguation biography for ${artistName}`
                );
                bio = null;
            }
        }

        // Get top tracks from Last.fm
        let topTracks: any[] = [];
        if (mbid || artistName) {
            try {
                topTracks = await lastFmService.getArtistTopTracks(
                    mbid || "",
                    artistName,
                    10
                );
            } catch (error) {
                console.log(`Failed to get top tracks for ${artistName}`);
            }
        }

        // Get artist image
        let image = null;

        // Try Fanart.tv first (if we have MBID)
        if (mbid) {
            try {
                image = await fanartService.getArtistImage(mbid);
                console.log(`Fanart.tv image for ${artistName}`);
            } catch (error) {
                console.log(
                    `✗ Failed to get Fanart.tv image for ${artistName}`
                );
            }
        }

        // Fallback to Deezer
        if (!image) {
            try {
                image = await deezerService.getArtistImage(artistName);
                if (image) {
                    console.log(`Deezer image for ${artistName}`);
                }
            } catch (error) {
                console.log(`✗ Failed to get Deezer image for ${artistName}`);
            }
        }

        // Fallback to Last.fm (but filter placeholders)
        if (!image && lastFmInfo?.image) {
            const lastFmImage = lastFmService.getBestImage(lastFmInfo.image);
            // Filter out Last.fm placeholder
            if (
                lastFmImage &&
                !lastFmImage.includes("2a96cbd8b46e442fc41c2b86b821562f")
            ) {
                image = lastFmImage;
                console.log(`Last.fm image for ${artistName}`);
            } else {
                console.log(`✗ Last.fm returned placeholder for ${artistName}`);
            }
        }

        // Get discography from MusicBrainz
        let albums: any[] = [];
        if (mbid) {
            try {
                const releaseGroups = await musicBrainzService.getReleaseGroups(
                    mbid
                );

                // Filter albums - only show studio albums and EPs
                // Exclude live albums, compilations, soundtracks, remixes, etc.
                const filteredReleaseGroups = releaseGroups.filter(
                    (rg: any) => {
                        // Must be Album or EP
                        const isPrimaryType =
                            rg["primary-type"] === "Album" ||
                            rg["primary-type"] === "EP";
                        if (!isPrimaryType) return false;

                        // Exclude secondary types (live, compilation, soundtrack, remix, etc.)
                        const secondaryTypes = rg["secondary-types"] || [];
                        const hasExcludedType = secondaryTypes.some(
                            (type: string) =>
                                [
                                    "Live",
                                    "Compilation",
                                    "Soundtrack",
                                    "Remix",
                                    "DJ-mix",
                                    "Mixtape/Street",
                                ].includes(type)
                        );

                        return !hasExcludedType;
                    }
                );

                // Process albums with lazy-load cover URLs
                // Instead of fetching covers inline (which causes rate limiting issues),
                // return URLs that the frontend will lazy-load via /api/library/album-cover
                albums = await Promise.all(
                    filteredReleaseGroups.map(async (rg: any) => {
                        const params = new URLSearchParams({
                            artist: artistName,
                            album: rg.title,
                        });
                        const coverUrl = `/api/library/album-cover/${rg.id}?${params}`;

                        return {
                            id: rg.id, // MBID - used for linking
                            rgMbid: rg.id, // Release group MBID - used for downloads
                            mbid: rg.id, // Fallback MBID
                            title: rg.title,
                            type: rg["primary-type"],
                            year: rg["first-release-date"]
                                ? parseInt(
                                      rg["first-release-date"].substring(0, 4)
                                  )
                                : null,
                            releaseDate: rg["first-release-date"] || null,
                            coverArt: coverUrl, // Use coverArt to match library endpoint
                            owned: false, // Discovery albums are never owned
                        };
                    })
                );

                // Sort albums
                albums.sort((a: any, b: any) => {
                    // Sort by year descending (newest first)
                    if (a.year && b.year) return b.year - a.year;
                    if (a.year) return -1;
                    if (b.year) return 1;
                    return 0;
                });
            } catch (error) {
                console.error(
                    `Failed to get discography for ${artistName}:`,
                    error
                );
            }
        }

        // Get similar artists from Last.fm and fetch images
        const similarArtistsRaw = lastFmInfo?.similar?.artist || [];
        const similarArtists = await Promise.all(
            similarArtistsRaw.slice(0, 10).map(async (artist: any) => {
                const similarImage = artist.image?.find(
                    (img: any) => img.size === "large"
                )?.[" #text"];

                let image = null;

                // Try Fanart.tv first (if we have MBID)
                if (artist.mbid) {
                    try {
                        image = await fanartService.getArtistImage(artist.mbid);
                    } catch (error) {
                        // Silently fail
                    }
                }

                // Fallback to Deezer
                if (!image) {
                    try {
                        const deezerImage = await deezerService.getArtistImage(
                            artist.name
                        );
                        if (deezerImage) {
                            image = deezerImage;
                        }
                    } catch (error) {
                        // Silently fail
                    }
                }

                // Last fallback to Last.fm (but filter placeholders)
                if (
                    !image &&
                    similarImage &&
                    !similarImage.includes("2a96cbd8b46e442fc41c2b86b821562f")
                ) {
                    image = similarImage;
                }

                return {
                    id: artist.mbid || artist.name,
                    name: artist.name,
                    mbid: artist.mbid || null,
                    url: artist.url,
                    image,
                };
            })
        );

        const response = {
            id: mbid || artistName, // For consistency with library artists
            mbid,
            name: artistName,
            image,
            bio, // Use filtered bio instead of raw Last.fm bio
            summary: bio, // Alias for consistency
            tags: lastFmInfo?.tags?.tag?.map((t: any) => t.name) || [],
            genres: lastFmInfo?.tags?.tag?.map((t: any) => t.name) || [], // Alias for consistency
            listeners: parseInt(lastFmInfo?.stats?.listeners || "0"),
            playcount: parseInt(lastFmInfo?.stats?.playcount || "0"),
            url: lastFmInfo?.url || null,
            albums: albums.map((album) => ({ ...album, owned: false })), // Mark all as not owned
            topTracks: topTracks.map((track) => ({
                id: `lastfm-${mbid || artistName}-${track.name}`,
                title: track.name,
                playCount: parseInt(track.playcount || "0"),
                listeners: parseInt(track.listeners || "0"),
                duration: parseInt(track.duration || "0"),
                url: track.url,
                album: { title: track.album?.["#text"] || "Unknown Album" },
            })),
            similarArtists,
        };

        // Cache discovery response for 24 hours
        try {
            await redisClient.setEx(
                cacheKey,
                DISCOVERY_CACHE_TTL,
                JSON.stringify(response)
            );
            console.log(`[Discovery] Cached artist: ${artistName}`);
        } catch (err) {
            // Redis errors are non-critical
        }

        res.json(response);
    } catch (error: any) {
        console.error("Artist discovery error:", error);
        res.status(500).json({
            error: "Failed to fetch artist details",
            message: error.message,
        });
    }
});

// GET /artists/album/:mbid - Get album details for discovery (not in library yet)
router.get("/album/:mbid", async (req, res) => {
    try {
        const { mbid } = req.params;

        // Check Redis cache first for discovery content
        const cacheKey = `discovery:album:${mbid}`;
        try {
            const cached = await redisClient.get(cacheKey);
            if (cached) {
                console.log(`[Discovery] Cache hit for album: ${mbid}`);
                return res.json(JSON.parse(cached));
            }
        } catch (err) {
            // Redis errors are non-critical
        }

        let releaseGroup: any = null;
        let release: any = null;
        let releaseGroupId: string = mbid;

        // Try as release-group first, then as release
        try {
            releaseGroup = await musicBrainzService.getReleaseGroup(mbid);
        } catch (error: any) {
            // If 404, try as a release instead
            if (error.response?.status === 404) {
                console.log(
                    `${mbid} is not a release-group, trying as release...`
                );
                release = await musicBrainzService.getRelease(mbid);
                releaseGroupId = release["release-group"]?.id || mbid;

                // Now get the release group to get the type and first-release-date
                if (releaseGroupId) {
                    try {
                        releaseGroup = await musicBrainzService.getReleaseGroup(
                            releaseGroupId
                        );
                    } catch (err) {
                        console.error(
                            `Failed to get release-group ${releaseGroupId}`
                        );
                    }
                }
            } else {
                throw error;
            }
        }

        if (!releaseGroup && !release) {
            return res.status(404).json({ error: "Album not found" });
        }

        // Get the artist name and MBID from either release-group or release
        const artistCredit =
            releaseGroup?.["artist-credit"] || release?.["artist-credit"];
        const artistName = artistCredit?.[0]?.name || "Unknown Artist";
        const artistMbid = artistCredit?.[0]?.artist?.id;
        const albumTitle = releaseGroup?.title || release?.title;

        // Get album info from Last.fm
        let lastFmInfo = null;
        try {
            lastFmInfo = await lastFmService.getAlbumInfo(
                artistName,
                albumTitle
            );
        } catch (error) {
            console.log(`Failed to get Last.fm info for ${albumTitle}`);
        }

        // Get tracks - if we have release, use it directly; otherwise get first release from group
        let tracks: any[] = [];
        if (release) {
            tracks = release.media?.[0]?.tracks || [];
        } else if (releaseGroup?.releases && releaseGroup.releases.length > 0) {
            const firstRelease = releaseGroup.releases[0];
            try {
                const releaseDetails = await musicBrainzService.getRelease(
                    firstRelease.id
                );
                tracks = releaseDetails.media?.[0]?.tracks || [];
            } catch (error) {
                console.error(
                    `Failed to get tracks for release ${firstRelease.id}`
                );
            }
        }

        // Get album cover art - try Cover Art Archive first
        let coverUrl = null;
        let coverArtUrl = `https://coverartarchive.org/release/${mbid}/front-500`;
        if (!release) {
            coverArtUrl = `https://coverartarchive.org/release-group/${releaseGroupId}/front-500`;
        }

        // Check if Cover Art Archive actually has the image
        try {
            const response = await fetch(coverArtUrl, { method: "HEAD" });
            if (response.ok) {
                coverUrl = coverArtUrl;
                console.log(`Cover Art Archive has cover for ${albumTitle}`);
            } else {
                console.log(
                    `✗ Cover Art Archive 404 for ${albumTitle}, trying Deezer...`
                );
            }
        } catch (error) {
            console.log(
                `✗ Cover Art Archive check failed for ${albumTitle}, trying Deezer...`
            );
        }

        // Fallback to Deezer if Cover Art Archive doesn't have it
        if (!coverUrl) {
            try {
                const deezerCover = await deezerService.getAlbumCover(
                    artistName,
                    albumTitle
                );
                if (deezerCover) {
                    coverUrl = deezerCover;
                    console.log(`Deezer has cover for ${albumTitle}`);
                } else {
                    // Final fallback to Cover Art Archive URL (might 404, but better than nothing)
                    coverUrl = coverArtUrl;
                }
            } catch (error) {
                console.log(`✗ Deezer lookup failed for ${albumTitle}`);
                // Final fallback to Cover Art Archive URL
                coverUrl = coverArtUrl;
            }
        }

        // Format response
        const releaseMbid = release?.id || null;

        const response = {
            id: releaseGroupId,
            rgMbid: releaseGroupId,
            mbid: releaseMbid || releaseGroupId,
            releaseMbid,
            title: albumTitle,
            artist: {
                name: artistName,
                id: artistMbid || artistName,
                mbid: artistMbid,
            },
            year: releaseGroup?.["first-release-date"]
                ? parseInt(releaseGroup["first-release-date"].substring(0, 4))
                : release?.date
                ? parseInt(release.date.substring(0, 4))
                : null,
            type: releaseGroup?.["primary-type"] || "Album",
            coverArt: coverUrl, // Use coverArt to match library endpoint
            bio: lastFmInfo?.wiki?.summary || null,
            tags: lastFmInfo?.tags?.tag?.map((t: any) => t.name) || [],
            tracks: tracks.map((track: any, index: number) => ({
                id: `mb-${releaseGroupId}-${track.id || index}`,
                title: track.title,
                trackNo: track.position || index + 1,
                duration: track.length ? Math.floor(track.length / 1000) : 0,
                artist: { name: artistName },
            })),
            similarAlbums: [], // Similar album recommendations not yet implemented
            owned: false,
            source: "discovery",
        };

        // Cache discovery response for 24 hours
        try {
            await redisClient.setEx(
                cacheKey,
                DISCOVERY_CACHE_TTL,
                JSON.stringify(response)
            );
            console.log(`[Discovery] Cached album: ${albumTitle}`);
        } catch (err) {
            // Redis errors are non-critical
        }

        res.json(response);
    } catch (error: any) {
        console.error("Album discovery error:", error);
        res.status(500).json({
            error: "Failed to fetch album details",
            message: error.message,
        });
    }
});

export default router;
