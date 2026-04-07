import { Router } from "express";
import { requireAuthOrToken } from "../middleware/auth";
import { prisma } from "../utils/db";
import { redisClient } from "../utils/redis";
import { lastFmService } from "../services/lastfm";
import { musicBrainzService } from "../services/musicbrainz";
import { openRouterService } from "../services/openrouter";
import { deezerService } from "../services/deezer";
import { startOfWeek, endOfWeek, subWeeks, subDays } from "date-fns";
import axios from "axios";
import fs from "fs";
import path from "path";
import { config } from "../config";

// Cache TTL for AI recommendations (24 hours)
const RECOMMENDATIONS_CACHE_TTL = 24 * 60 * 60;

// Static imports for performance
import { discoverQueue, scanQueue } from "../workers/queues";
import { getSystemSettings } from "../utils/systemSettings";
import { lidarrService } from "../services/lidarr";

// Types for recommendation-only mode (artist-focused, not album-focused)
interface RecommendedAlbum {
    artistName: string;
    artistMbid?: string;
    albumTitle: string;  // Kept for backwards compatibility, now empty string
    albumMbid: string;   // Kept for backwards compatibility, now empty string
    similarity: number;
    tier: "high" | "medium" | "explore" | "wildcard";
    coverUrl?: string;   // Artist image
    year?: number;
    reason?: string;     // AI-generated explanation
    // Artist metadata
    listeners?: number;
    tags?: string[];
    bio?: string;
}

// Discovery mode types
type DiscoveryMode = "safe" | "adjacent" | "adventurous" | "mix";
type DiscoveryTimeframe = "7d" | "28d" | "90d" | "all";

// Sectioned response for Mix mode
interface SectionedRecommendations {
    safe: RecommendedAlbum[];
    adjacent: RecommendedAlbum[];
    wildcard: RecommendedAlbum[];
}

// Helper to get timeframe in days
function getTimeframeDays(timeframe: DiscoveryTimeframe): number {
    switch (timeframe) {
        case "7d": return 7;
        case "28d": return 28;
        case "90d": return 90;
        case "all": return 365 * 10; // Effectively all time
        default: return 28;
    }
}

const router = Router();

router.use(requireAuthOrToken);

// =============================================================================
// RECOMMENDATION-ONLY ENDPOINT (No Auto-Download)
// =============================================================================

/**
 * GET /discover/recommendations - Get album recommendations for browsing
 *
 * Query params:
 * - limit: number of recommendations (default: 16)
 * - timeframe: "7d" | "28d" | "90d" | "all" (default: "28d")
 * - mode: "safe" | "adjacent" | "adventurous" | "mix" (default: "mix")
 *
 * This is a preview-only mode that returns recommendations without downloading.
 * Users can browse artists, check top tracks, then manually download if interested.
 */
router.get("/recommendations", async (req, res) => {
    try {
        const userId = req.user!.id;
        const targetCount = parseInt(req.query.limit as string) || 16;
        const timeframe = (req.query.timeframe as DiscoveryTimeframe) || "28d";
        const mode = (req.query.mode as DiscoveryMode) || "mix";
        const includeLibrary = req.query.includeLibrary === "true";
        const source = (req.query.source as string) || "auto"; // "auto", "ai", "lastfm"

        console.log(`\n[DISCOVER] Generating recommendations for user ${userId}`);
        console.log(`   Mode: ${mode}, Timeframe: ${timeframe}, Target: ${targetCount}, Include Library: ${includeLibrary}, Source: ${source}`);

        // Check Redis cache first (skip for force refresh)
        const forceRefresh = req.query.refresh === "true";
        const cacheKey = `discover:recommendations:${userId}:${mode}:${timeframe}:${includeLibrary}:${source}`;
        
        if (!forceRefresh) {
            try {
                const cached = await redisClient.get(cacheKey);
                if (cached) {
                    console.log(`   Cache HIT - returning cached recommendations`);
                    return res.json(JSON.parse(cached));
                }
            } catch (err) {
                console.warn("[DISCOVER] Redis read error:", err);
            }
        } else {
            console.log(`   Force refresh requested - skipping cache`);
        }

        // Check if AI is available for mode-specific recommendations
        // If source=lastfm, skip AI entirely
        const aiAvailable = source === "lastfm" ? false : await openRouterService.isAvailable();
        console.log(`   AI available: ${aiAvailable}${source === "lastfm" ? " (forced Last.fm)" : ""}`);

        // Step 1: Get seed artists from listening history with configurable timeframe
        const days = getTimeframeDays(timeframe);
        const startDate = subDays(new Date(), days);

        const recentPlays = await prisma.play.groupBy({
            by: ["trackId"],
            where: {
                userId,
                playedAt: { gte: startDate },
                source: { in: ["LIBRARY", "DISCOVERY_KEPT"] },
            },
            _count: { id: true },
            orderBy: { _count: { id: "desc" } },
            take: 200, // Get more for weighted sampling
        });

        // Build artist pool with play counts and recency weighting
        interface ArtistWithStats {
            name: string;
            mbid: string | null;
            playCount: number;
            weightedScore: number;
            genres: string[];
        }

        let artistPool: ArtistWithStats[] = [];

        if (recentPlays.length >= 3) {
            const tracks = await prisma.track.findMany({
                where: {
                    id: { in: recentPlays.map((p) => p.trackId) },
                    album: { location: "LIBRARY" },
                },
                include: {
                    album: {
                        include: {
                            artist: true
                        }
                    }
                },
            });

            // Get play dates for recency weighting
            const playDates = await prisma.play.findMany({
                where: {
                    userId,
                    trackId: { in: recentPlays.map(p => p.trackId) },
                    playedAt: { gte: startDate },
                },
                select: { trackId: true, playedAt: true },
            });

            // Build map of trackId -> most recent play date
            const trackLastPlayed = new Map<string, Date>();
            for (const play of playDates) {
                const existing = trackLastPlayed.get(play.trackId);
                if (!existing || play.playedAt > existing) {
                    trackLastPlayed.set(play.trackId, play.playedAt);
                }
            }

            // Count plays per artist with recency weighting
            const artistStats = new Map<string, ArtistWithStats>();
            const now = new Date();

            for (const track of tracks) {
                const play = recentPlays.find(p => p.trackId === track.id);
                const playCount = play?._count.id || 1;
                const lastPlayed = trackLastPlayed.get(track.id) || now;

                // Recency weight: more recent = higher weight
                // For 28d/90d timeframes, apply recency weighting
                let recencyMultiplier = 1;
                if (timeframe === "28d" || timeframe === "90d") {
                    const daysAgo = (now.getTime() - lastPlayed.getTime()) / (1000 * 60 * 60 * 24);
                    const totalDays = days;
                    // Week 1: 45%, Week 2: 25%, Week 3: 18%, Week 4+: 12%
                    if (daysAgo <= 7) recencyMultiplier = 1.45;
                    else if (daysAgo <= 14) recencyMultiplier = 1.25;
                    else if (daysAgo <= 21) recencyMultiplier = 1.18;
                    else recencyMultiplier = 1.12;
                }

                const existing = artistStats.get(track.album.artistId);
                if (existing) {
                    existing.playCount += playCount;
                    existing.weightedScore += playCount * recencyMultiplier;
                } else {
                    artistStats.set(track.album.artistId, {
                        name: track.album.artist.name,
                        mbid: track.album.artist.mbid,
                        playCount: playCount,
                        weightedScore: playCount * recencyMultiplier,
                        genres: [], // Will be populated if available
                    });
                }
            }

            // Sort by weighted score and take top 50 for the pool
            artistPool = Array.from(artistStats.values())
                .sort((a, b) => b.weightedScore - a.weightedScore)
                .slice(0, 50);
        } else {
            // Fallback: get artists with most albums in library
            const albums = await prisma.album.groupBy({
                by: ["artistId"],
                where: { location: "LIBRARY" },
                _count: { id: true },
                orderBy: { _count: { id: "desc" } },
                take: 50,
            });
            const artistIds = albums.map((a) => a.artistId);
            const artists = await prisma.artist.findMany({
                where: { id: { in: artistIds } },
            });

            artistPool = artistIds
                .map((id, idx) => {
                    const artist = artists.find((a) => a.id === id);
                    if (!artist) return null;
                    const albumCount = albums[idx]._count.id;
                    return {
                        name: artist.name,
                        mbid: artist.mbid,
                        playCount: albumCount,
                        weightedScore: albumCount,
                        genres: [] as string[],
                    };
                })
                .filter((a): a is NonNullable<typeof a> => a !== null);
        }

        if (artistPool.length === 0) {
            return res.status(400).json({
                error: "No seed artists found",
                message: "Listen to some music first to get personalized recommendations",
            });
        }

        // Step 2: Weighted random sampling from artist pool
        // Ranks 1-5: 50% chance, Ranks 6-15: 35% chance, Ranks 16-50: 15% chance
        const sampleSeeds = (pool: ArtistWithStats[], count: number): ArtistWithStats[] => {
            const selected: ArtistWithStats[] = [];
            const availablePool = [...pool];

            while (selected.length < count && availablePool.length > 0) {
                // Calculate weights based on rank
                const weights = availablePool.map((_, idx) => {
                    if (idx < 5) return 0.50;
                    if (idx < 15) return 0.35;
                    return 0.15;
                });

                // Weighted random selection
                const totalWeight = weights.reduce((a, b) => a + b, 0);
                let random = Math.random() * totalWeight;
                let selectedIdx = 0;

                for (let i = 0; i < weights.length; i++) {
                    random -= weights[i];
                    if (random <= 0) {
                        selectedIdx = i;
                        break;
                    }
                }

                selected.push(availablePool[selectedIdx]);
                availablePool.splice(selectedIdx, 1);
            }

            return selected;
        };

        // Sample 8-12 seeds for variety
        const seedCount = Math.min(Math.max(8, Math.floor(artistPool.length / 4)), 12);
        const seedArtists = sampleSeeds(artistPool, seedCount);

        console.log(`   Seed artists (${seedArtists.length}): ${seedArtists.map(a => a.name).join(", ")}`);

        // Get owned artists for filtering
        const ownedArtists = await prisma.artist.findMany({
            where: { albums: { some: { location: "LIBRARY" } } },
            select: { name: true },
        });
        const ownedArtistNames = ownedArtists.map(a => a.name);

        // Step 3: Generate recommendations based on mode
        let recommendations: RecommendedAlbum[] = [];
        let sections: SectionedRecommendations | null = null;

        if (aiAvailable) {
            // Use AI for mode-specific recommendations
            try {
                const aiRecommendations = await generateAIRecommendations(
                    seedArtists,
                    ownedArtistNames,
                    mode,
                    targetCount,
                    timeframe,
                    includeLibrary
                );

                if (mode === "mix" && aiRecommendations.sections) {
                    sections = aiRecommendations.sections;
                    // Flatten for backwards compatibility
                    recommendations = [
                        ...aiRecommendations.sections.safe,
                        ...aiRecommendations.sections.adjacent,
                        ...aiRecommendations.sections.wildcard,
                    ];
                } else {
                    recommendations = aiRecommendations.recommendations;
                }

                console.log(`   AI generated ${recommendations.length} recommendations`);
                
                // Post-filter: Remove any owned artists the AI missed (AI doesn't always respect exclusion list)
                if (!includeLibrary) {
                    const ownedSet = new Set(ownedArtistNames.map(n => n.toLowerCase()));
                    const beforeCount = recommendations.length;
                    recommendations = recommendations.filter(r => !ownedSet.has(r.artistName.toLowerCase()));
                    
                    if (sections) {
                        sections.safe = sections.safe.filter(r => !ownedSet.has(r.artistName.toLowerCase()));
                        sections.adjacent = sections.adjacent.filter(r => !ownedSet.has(r.artistName.toLowerCase()));
                        sections.wildcard = sections.wildcard.filter(r => !ownedSet.has(r.artistName.toLowerCase()));
                    }
                    
                    if (beforeCount !== recommendations.length) {
                        console.log(`   Filtered out ${beforeCount - recommendations.length} owned artists AI missed`);
                    }
                }
            } catch (aiError: any) {
                console.error(`   AI recommendations failed: ${aiError.message}, falling back to Last.fm`);
                recommendations = await generateLastFmRecommendations(
                    seedArtists,
                    ownedArtistNames,
                    targetCount
                );
            }
        } else {
            // Fallback to Last.fm-based recommendations
            recommendations = await generateLastFmRecommendations(
                seedArtists,
                ownedArtistNames,
                targetCount
            );
        }

        console.log(`   Final: ${recommendations.length} recommendations`);

        const response = {
            recommendations,
            sections: mode === "mix" ? sections : undefined,
            seedArtists: seedArtists.map(a => a.name),
            mode,
            timeframe,
            generatedAt: new Date().toISOString(),
        };

        // Cache the response for 24 hours
        try {
            await redisClient.setEx(cacheKey, RECOMMENDATIONS_CACHE_TTL, JSON.stringify(response));
            console.log(`   Cached recommendations for 24 hours`);
        } catch (err) {
            console.warn("[DISCOVER] Redis write error:", err);
        }

        res.json(response);
    } catch (error: any) {
        console.error("[DISCOVER] Recommendations error:", error?.message || error);
        res.status(500).json({
            error: "Failed to generate recommendations",
            details: error?.message,
        });
    }
});

/**
 * Generate AI-powered recommendations using OpenRouter
 */
async function generateAIRecommendations(
    seedArtists: { name: string; playCount: number; genres: string[] }[],
    libraryArtists: string[],
    mode: DiscoveryMode,
    targetCount: number,
    timeframe: DiscoveryTimeframe,
    includeLibrary: boolean = false
): Promise<{ recommendations: RecommendedAlbum[]; sections?: SectionedRecommendations }> {
    const settings = await getSystemSettings();
    const model = settings?.openrouterModel || "openai/gpt-4o-mini";

    // Build the prompt based on mode
    const prompt = buildDiscoveryPrompt(seedArtists, libraryArtists, mode, targetCount, timeframe, includeLibrary);

    const client = await createOpenRouterClient();
    const response = await client.post("/chat/completions", {
        model,
        messages: [
            {
                role: "system",
                content: "You are an expert music curator. Respond with valid JSON only, no markdown formatting.",
            },
            { role: "user", content: prompt },
        ],
        max_tokens: 3000,
        temperature: 0.7,
    });

    const content = response.data.choices[0].message.content.trim();
    let jsonContent = content;
    if (content.startsWith("```json")) {
        jsonContent = content.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    } else if (content.startsWith("```")) {
        jsonContent = content.replace(/```\n?/g, "").trim();
    }

    const result = JSON.parse(jsonContent);

    // Process recommendations and fetch album covers
    if (mode === "mix" && result.safe && result.adjacent && result.wildcard) {
        const sections: SectionedRecommendations = {
            safe: await processAIArtists(result.safe, "high"),
            adjacent: await processAIArtists(result.adjacent, "medium"),
            wildcard: await processAIArtists(result.wildcard, "wildcard"),
        };
        return { recommendations: [], sections };
    } else {
        const recs = result.recommendations || result;
        const tier = mode === "safe" ? "high" : mode === "adjacent" ? "medium" : "explore";
        return { recommendations: await processAIArtists(recs, tier) };
    }
}

/**
 * Build the AI prompt based on discovery mode
 */
function buildDiscoveryPrompt(
    seedArtists: { name: string; playCount: number; genres: string[] }[],
    libraryArtists: string[],
    mode: DiscoveryMode,
    targetCount: number,
    timeframe: DiscoveryTimeframe,
    includeLibrary: boolean = false
): string {
    const timeframeLabel = timeframe === "7d" ? "last week" :
                          timeframe === "28d" ? "last month" :
                          timeframe === "90d" ? "last 3 months" : "all time";

    const seedList = seedArtists
        .map(a => `${a.name} (${a.playCount} plays)`)
        .join("\n");

    // Only include exclusion list if not including library artists
    const exclusionSection = includeLibrary
        ? "\nNote: User wants recommendations that MAY include artists already in their library (to discover new albums from known artists).\n"
        : `\nARTISTS ALREADY IN LIBRARY (do NOT recommend these):\n${JSON.stringify(libraryArtists.slice(0, 500))}\n`;

    const baseContext = `User's top artists (${timeframeLabel}):
${seedList}
${exclusionSection}
`;

    const libraryRequirement = includeLibrary
        ? "- May include artists from user's library (to discover new albums)"
        : "- Must NOT be in the library list above";

    switch (mode) {
        case "safe":
            return `${baseContext}
TASK: Recommend ${targetCount} artists who sound VERY SIMILAR to these seeds.

REQUIREMENTS:
- Same genre, same era, same production style
- Direct sonic matches only
- High similarity in instrumentation, vocals, and energy
${libraryRequirement}

Output JSON array:
{
  "recommendations": [
    { "name": "Artist Name", "reason": "Brief explanation" }
  ]
}`;

        case "adjacent":
            return `${baseContext}
TASK: Recommend ${targetCount} artists who share the same ENERGY and MOOD.

REQUIREMENTS:
- Can cross genres if the vibe matches
- Same feeling, new sounds
- Artists who "fit the same playlist"
${libraryRequirement}

Output JSON array:
{
  "recommendations": [
    { "name": "Artist Name", "reason": "Brief explanation" }
  ]
}`;

        case "adventurous":
            return `${baseContext}
TASK: Recommend ${targetCount} artists that expand the listener's horizons while staying musically grounded.

REQUIREMENTS:
- Must share REAL musical DNA (production style, song structure, vocal approach, instrumentation)
- Can cross genres but the sonic connection must be obvious when you hear both artists
- NO superficial connections like "both use strings" or "both are experimental"
- Think: actual fans of the seed artists would genuinely enjoy these recommendations
${libraryRequirement}

Output JSON array:
{
  "recommendations": [
    { "name": "Artist Name", "reason": "Brief explanation" }
  ]
}`;

        case "mix":
        default:
            const safeCount = Math.ceil(targetCount * 0.35);
            const adjacentCount = Math.ceil(targetCount * 0.35);
            const wildcardCount = targetCount - safeCount - adjacentCount;

            const mixLibraryRequirement = includeLibrary
                ? "- May include artists from user's library (to discover new albums)"
                : "- Must NOT recommend any artist from the library list above";

            return `${baseContext}
TASK: Recommend ${targetCount} artists in 3 tiers:

SAFE (${safeCount} artists):
- Direct sonic matches, same genre/era/production
- Very similar in sound and style

ADJACENT (${adjacentCount} artists):
- Same energy/mood, can cross genres if vibe matches
- "Fits the same playlist" feeling

WILDCARD (${wildcardCount} artists):
- Different genre but REAL sonic/production similarities
- Must share actual musical DNA, not superficial traits
- Fans of the seeds would genuinely enjoy these

REQUIREMENTS:
${mixLibraryRequirement}
- Each recommendation needs a brief reason

Output JSON:
{
  "safe": [{ "name": "Artist Name", "reason": "Brief explanation" }],
  "adjacent": [{ "name": "Artist Name", "reason": "Brief explanation" }],
  "wildcard": [{ "name": "Artist Name", "reason": "Brief explanation" }]
}`;
    }
}

/**
 * Process AI artist recommendations: fetch artist images, metadata, and MusicBrainz IDs
 * Returns artist-focused data (no albums) - consistent with Last.fm recommendations
 */
async function processAIArtists(
    artists: { name: string; reason?: string }[],
    defaultTier: "high" | "medium" | "explore" | "wildcard"
): Promise<RecommendedAlbum[]> {
    // Process artists in parallel for better performance
    const results = await Promise.all(
        artists.map(async (artist) => {
            try {
                // Fetch artist info and MusicBrainz ID in parallel
                const [artistInfo, mbArtists] = await Promise.all([
                    lastFmService.getArtistInfo(artist.name),
                    musicBrainzService.searchArtist(artist.name, 1),
                ]);

                const mbArtist = mbArtists?.[0];

                // Get artist image - try Last.fm first, then Deezer as fallback
                let coverUrl: string | undefined;
                if (artistInfo?.image) {
                    coverUrl = lastFmService.getBestImage(artistInfo.image) || undefined;
                }
                
                // Fallback to Deezer if Last.fm has no image
                if (!coverUrl) {
                    try {
                        coverUrl = await deezerService.getArtistImage(artist.name) || undefined;
                    } catch {
                        // Deezer failed, continue without image
                    }
                }

                // Extract and clean bio summary
                let bio: string | undefined;
                if (artistInfo?.bio?.summary) {
                    bio = artistInfo.bio.summary
                        .replace(/<a href=".*">Read more on Last\.fm<\/a>\.?/gi, "")
                        .trim();
                }

                return {
                    artistName: artist.name,
                    artistMbid: mbArtist?.id || "",
                    albumTitle: "", // No longer returning albums
                    albumMbid: "",
                    similarity: defaultTier === "high" ? 0.85 : defaultTier === "medium" ? 0.6 : 0.35,
                    tier: defaultTier,
                    coverUrl,
                    reason: artist.reason,
                    // Additional artist metadata
                    listeners: artistInfo?.stats?.listeners ? parseInt(artistInfo.stats.listeners) : undefined,
                    tags: artistInfo?.tags?.tag?.slice(0, 3).map((t: any) => t.name) || [],
                    bio,
                };
            } catch (e) {
                console.log(`   Failed to process AI recommendation: ${artist.name}`);
                return null;
            }
        })
    );

    // Use NonNullable predicate so the narrow map-result type flows through
    // instead of trying to assert the wider RecommendedAlbum shape (which has
    // artistMbid as optional — incompatible with the required string here).
    return results.filter((r): r is NonNullable<typeof r> => r !== null);
}

/**
 * Generate Last.fm-based recommendations (fallback when AI unavailable)
 * Returns similar ARTISTS (not albums) - matching how Last.fm actually works
 */
async function generateLastFmRecommendations(
    seedArtists: { name: string; mbid: string | null }[],
    ownedArtistNames: string[],
    targetCount: number
): Promise<RecommendedAlbum[]> {
    const ownedSet = new Set(ownedArtistNames.map(n => n.toLowerCase()));
    const seenArtists = new Set<string>();
    const allSimilarArtists: any[] = [];

    // Get similar artists from Last.fm for each seed
    for (const seed of seedArtists.slice(0, 8)) {
        try {
            const similar = await lastFmService.getSimilarArtists(seed.mbid || "", seed.name, 15);
            for (const sim of similar) {
                allSimilarArtists.push({ ...sim, seedArtist: seed.name });
            }
        } catch (e) {
            console.log(`   Failed to get similar for ${seed.name}`);
        }
    }

    // Filter and deduplicate
    const filteredArtists = allSimilarArtists.filter((a) => {
        const key = a.name.toLowerCase();
        if (seenArtists.has(key)) return false;
        if (ownedSet.has(key)) return false;
        seenArtists.add(key);
        return true;
    });

    // Sort by similarity and process top candidates
    const sortedArtists = filteredArtists
        .sort((a, b) => (b.match || 0) - (a.match || 0))
        .slice(0, targetCount + 5);

    const recommendations: RecommendedAlbum[] = [];

    // Fetch artist info in parallel for better performance
    const artistInfoPromises = sortedArtists.slice(0, targetCount).map(async (artist) => {
        try {
            // Fetch artist info (for image) and MusicBrainz ID in parallel
            const [artistInfo, mbArtists] = await Promise.all([
                lastFmService.getArtistInfo(artist.name),
                musicBrainzService.searchArtist(artist.name, 1),
            ]);

            const mbArtist = mbArtists?.[0];
            
            // Get artist image - try Last.fm first, then Deezer as fallback
            let coverUrl: string | undefined;
            if (artistInfo?.image) {
                coverUrl = lastFmService.getBestImage(artistInfo.image) || undefined;
            }
            
            // Fallback to Deezer if Last.fm has no image (common since they deprecated artist images)
            if (!coverUrl) {
                try {
                    coverUrl = await deezerService.getArtistImage(artist.name) || undefined;
                } catch {
                    // Deezer failed, continue without image
                }
            }

            const similarity = artist.match || 0.5;
            let tier: "high" | "medium" | "explore" | "wildcard";
            if (similarity >= 0.7) tier = "high";
            else if (similarity >= 0.5) tier = "medium";
            else if (similarity >= 0.3) tier = "explore";
            else tier = "wildcard";

            // Extract and clean bio summary (remove Last.fm link suffix)
            let bio: string | undefined;
            if (artistInfo?.bio?.summary) {
                bio = artistInfo.bio.summary
                    .replace(/<a href=".*">Read more on Last\.fm<\/a>\.?/gi, "")
                    .trim();
            }

            return {
                artistName: artist.name,
                artistMbid: mbArtist?.id || "",
                albumTitle: "", // No longer returning albums
                albumMbid: "",
                similarity,
                tier,
                coverUrl: coverUrl || undefined,
                // Additional artist metadata
                listeners: artistInfo?.stats?.listeners ? parseInt(artistInfo.stats.listeners) : undefined,
                tags: artistInfo?.tags?.tag?.slice(0, 3).map((t: any) => t.name) || [],
                bio,
            };
        } catch (e) {
            return null;
        }
    });

    const results = await Promise.all(artistInfoPromises);
    
    for (const result of results) {
        if (result && recommendations.length < targetCount) {
            recommendations.push(result);
        }
    }

    return recommendations;
}

/**
 * Create OpenRouter client
 */
async function createOpenRouterClient() {
    return axios.create({
        baseURL: "https://openrouter.ai/api/v1",
        timeout: 90000,
        headers: {
            Authorization: `Bearer ${config.openrouter.apiKey}`,
            "Content-Type": "application/json",
            "HTTP-Referer": "https://lidify.app",
            "X-Title": "Lidify Music",
        },
    });
}

// =============================================================================
// LEGACY ENDPOINTS (Download-based - kept for backwards compatibility)
// =============================================================================

// GET /discover/batch-status - Check if there's an active batch being processed
router.get("/batch-status", async (req, res) => {
    try {
        const userId = req.user!.id;

        // Find any active batch for this user
        const activeBatch = await prisma.discoveryBatch.findFirst({
            where: {
                userId,
                status: { in: ["downloading", "scanning"] },
            },
            include: {
                jobs: {
                    select: {
                        status: true,
                    },
                },
            },
            orderBy: { createdAt: "desc" },
        });

        if (!activeBatch) {
            return res.json({
                active: false,
                status: null,
                progress: null,
            });
        }

        const completedJobs = activeBatch.jobs.filter(j => j.status === "completed").length;
        const failedJobs = activeBatch.jobs.filter(j => j.status === "failed" || j.status === "exhausted").length;
        const totalJobs = activeBatch.jobs.length;
        const progress = totalJobs > 0 ? Math.round(((completedJobs + failedJobs) / totalJobs) * 100) : 0;

        res.json({
            active: true,
            status: activeBatch.status,
            batchId: activeBatch.id,
            progress,
            completed: completedJobs,
            failed: failedJobs,
            total: totalJobs,
        });
    } catch (error) {
        console.error("Get batch status error:", error);
        res.status(500).json({ error: "Failed to get batch status" });
    }
});

// POST /discover/generate - Generate new Discover Weekly playlist (using Bull queue)
router.post("/generate", async (req, res) => {
    try {
        const userId = req.user!.id;

        // Check for existing active batch
        const existingBatch = await prisma.discoveryBatch.findFirst({
            where: {
                userId,
                status: { in: ["downloading", "scanning"] },
            },
        });

        if (existingBatch) {
            return res.status(409).json({
                error: "Generation already in progress",
                batchId: existingBatch.id,
                status: existingBatch.status,
            });
        }

        console.log(`\n Queuing Discover Weekly generation for user ${userId}`);

        // Add generation job to queue
        const job = await discoverQueue.add({ userId });

        res.json({
            message: "Discover Weekly generation started",
            jobId: job.id,
        });
    } catch (error) {
        console.error("Generate Discover Weekly error:", error);
        res.status(500).json({ error: "Failed to start generation" });
    }
});

// GET /discover/generate/status/:jobId - Check generation job status
router.get("/generate/status/:jobId", async (req, res) => {
    try {
        const job = await discoverQueue.getJob(req.params.jobId);

        if (!job) {
            return res.status(404).json({ error: "Job not found" });
        }

        const state = await job.getState();
        const progress = job.progress();
        const result = job.returnvalue;

        res.json({
            status: state,
            progress,
            result,
        });
    } catch (error) {
        console.error("Get generation status error:", error);
        res.status(500).json({ error: "Failed to get job status" });
    }
});

// GET /discover/current - Get current week's Discover Weekly playlist
router.get("/current", async (req, res) => {
    try {
        const userId = req.user!.id;

        const weekStart = startOfWeek(new Date(), { weekStartsOn: 1 }); // Monday
        const weekEnd = endOfWeek(new Date(), { weekStartsOn: 1 }); // Sunday

        // Get all discovery albums for this week with their tracks
        const discoveryAlbums = await prisma.discoveryAlbum.findMany({
            where: {
                userId,
                weekStartDate: weekStart,
                status: { in: ["ACTIVE", "LIKED"] },
            },
            include: {
                tracks: true, // DiscoveryTrack records (trackId is just a string, not a relation)
            },
            orderBy: { downloadedAt: "asc" },
        });

        // Get unavailable albums for this week (show full replacement chain)
        const unavailableAlbums = await prisma.unavailableAlbum.findMany({
            where: {
                userId,
                weekStartDate: weekStart,
            },
            orderBy: [
                { originalAlbumId: "asc" }, // Group by original album
                { attemptNumber: "asc" }, // Then sort by attempt number
            ],
        });

        // Build track list from DiscoveryTrack records (the actual selected tracks)
        const tracks = [];

        for (const discoveryAlbum of discoveryAlbums) {
            // If we have DiscoveryTrack records, use them (the actual selected tracks)
            if (discoveryAlbum.tracks && discoveryAlbum.tracks.length > 0) {
                // Fetch all tracks in one query using their IDs
                const trackIds = discoveryAlbum.tracks
                    .map(dt => dt.trackId)
                    .filter((id): id is string => id !== null);

                if (trackIds.length > 0) {
                    const libraryTracks = await prisma.track.findMany({
                        where: { id: { in: trackIds } },
                        include: { album: { include: { artist: true } } },
                    });

                    // Create a map for quick lookup
                    const trackMap = new Map(libraryTracks.map(t => [t.id, t]));

                    for (const dt of discoveryAlbum.tracks) {
                        const track = dt.trackId ? trackMap.get(dt.trackId) : null;
                        if (track) {
                            tracks.push({
                                id: track.id,
                                title: track.title,
                                artist: discoveryAlbum.artistName,
                                album: discoveryAlbum.albumTitle,
                                albumId: discoveryAlbum.rgMbid,
                                isLiked: discoveryAlbum.status === "LIKED",
                                likedAt: discoveryAlbum.likedAt,
                                similarity: discoveryAlbum.similarity,
                                tier: discoveryAlbum.tier,
                                coverUrl: track.album?.coverUrl,
                                available: true,
                            });
                        }
                    }
                }
            }
            
            // Fallback: No DiscoveryTrack records or no valid trackIds, find ONE track from library
            if (tracks.filter(t => t.album === discoveryAlbum.albumTitle).length === 0) {
                const album = await prisma.album.findFirst({
                    where: {
                        title: discoveryAlbum.albumTitle,
                        artist: { name: discoveryAlbum.artistName },
                    },
                    include: {
                        artist: true,
                        tracks: { take: 1, orderBy: [{ discNo: "asc" }, { trackNo: "asc" }] },
                    },
                });

                if (album && album.tracks.length > 0) {
                    const track = album.tracks[0];
                    tracks.push({
                        id: track.id,
                        title: track.title,
                        artist: discoveryAlbum.artistName,
                        album: discoveryAlbum.albumTitle,
                        albumId: discoveryAlbum.rgMbid,
                        isLiked: discoveryAlbum.status === "LIKED",
                        likedAt: discoveryAlbum.likedAt,
                        similarity: discoveryAlbum.similarity,
                        tier: discoveryAlbum.tier,
                        coverUrl: album.coverUrl,
                        available: true,
                    });
                } else {
                    // Album not in library yet (downloading/pending)
                    tracks.push({
                        id: `pending-${discoveryAlbum.id}`,
                        title: `${discoveryAlbum.albumTitle} (pending import)`,
                        artist: discoveryAlbum.artistName,
                        album: discoveryAlbum.albumTitle,
                        albumId: discoveryAlbum.rgMbid,
                        isLiked: discoveryAlbum.status === "LIKED",
                        likedAt: discoveryAlbum.likedAt,
                        similarity: discoveryAlbum.similarity,
                        tier: discoveryAlbum.tier,
                        coverUrl: null,
                        available: false,
                        isPending: true,
                    });
                }
            }
        }

        // Get the list of successfully downloaded album MBIDs from discoveryAlbums
        const successfulMbids = new Set(discoveryAlbums.map(da => da.rgMbid));

        // Filter unavailable albums:
        // 1. Remove albums that successfully downloaded (have DiscoveryAlbum record)
        // 2. Remove albums that the user now owns (in Album table)
        const filteredUnavailable: typeof unavailableAlbums = [];
        for (const album of unavailableAlbums) {
            // Skip if this album successfully downloaded this week
            if (successfulMbids.has(album.albumMbid)) {
                continue;
            }

            // Skip if album exists in user's library by artist+title (normalized match)
            const normalizedArtist = album.artistName.toLowerCase().trim();
            const normalizedAlbum = album.albumTitle.toLowerCase()
                .replace(/\(.*?\)/g, "") // Remove parenthetical content
                .replace(/\[.*?\]/g, "") // Remove bracketed content
                .trim();

            const existsInLibrary = await prisma.album.findFirst({
                where: {
                    OR: [
                        { rgMbid: album.albumMbid },
                        {
                            title: { contains: normalizedAlbum, mode: "insensitive" },
                            artist: { name: { contains: normalizedArtist, mode: "insensitive" } },
                        }
                    ]
                }
            });

            if (existsInLibrary) {
                continue; // User already owns this album, don't show as unavailable
            }

            filteredUnavailable.push(album);
        }

        // Format unavailable albums
        const unavailable = filteredUnavailable.map((album) => ({
            id: `unavailable-${album.id}`,
            title: album.albumTitle,
            artist: album.artistName,
            album: album.albumTitle,
            albumId: album.albumMbid,
            similarity: album.similarity,
            tier: album.tier,
            previewUrl: album.previewUrl,
            deezerTrackId: album.deezerTrackId,
            deezerAlbumId: album.deezerAlbumId,
            attemptNumber: album.attemptNumber,
            originalAlbumId: album.originalAlbumId,
            available: false,
        }));

        try {
            console.log(`\nDiscover Weekly API Response:`);
            console.log(`  Total tracks: ${tracks.length}`);
            console.log(`  Unavailable albums: ${unavailable.length}`);
            if (unavailable.length > 0 && unavailable.length <= 20) {
                console.log(`  Unavailable albums with previews:`);
                unavailable.slice(0, 5).forEach((album, i) => {
                    console.log(
                        `    ${i + 1}. ${album.artist} - ${album.album} [${
                            album.previewUrl ? "HAS PREVIEW" : "NO PREVIEW"
                        }]`
                    );
                });
                if (unavailable.length > 5) {
                    console.log(`    ... and ${unavailable.length - 5} more`);
                }
            }
        } catch (err) {
            console.error("Error logging discover response:", err);
        }

        res.json({
            weekStart,
            weekEnd,
            tracks,
            unavailable,
            totalCount: tracks.length,
            unavailableCount: unavailable.length,
        });
    } catch (error) {
        console.error("Get current Discover Weekly error:", error);
        res.status(500).json({
            error: "Failed to get Discover Weekly playlist",
        });
    }
});

// POST /discover/like - Like a track (marks entire album for keeping)
router.post("/like", async (req, res) => {
    try {
        const userId = req.user!.id;
        const { albumId } = req.body;

        if (!albumId) {
            return res.status(400).json({ error: "albumId required" });
        }

        // Find the discovery album
        const discoveryAlbum = await prisma.discoveryAlbum.findFirst({
            where: {
                userId,
                rgMbid: albumId,
                status: "ACTIVE",
            },
        });

        if (!discoveryAlbum) {
            return res
                .status(404)
                .json({ error: "Album not in active discovery" });
        }

        // Mark as liked (entire album will be kept)
        await prisma.discoveryAlbum.update({
            where: { id: discoveryAlbum.id },
            data: {
                status: "LIKED",
                likedAt: new Date(),
            },
        });

        // Remove discovery tag from the artist in Lidarr
        // This prevents the artist from being deleted during cleanup
        console.log(`   Removing discovery tag from artist: ${discoveryAlbum.artistName}`);
        
        // If artistMbid is a temp ID, we need to search Lidarr by artist name instead
        if (discoveryAlbum.artistMbid && !discoveryAlbum.artistMbid.startsWith("temp-")) {
            await lidarrService.removeDiscoveryTagByMbid(discoveryAlbum.artistMbid);
        } else {
            // Search Lidarr for the artist by name and remove tag
            try {
                const lidarrArtists = await lidarrService.getArtists();
                const lidarrArtist = lidarrArtists.find(
                    a => a.artistName.toLowerCase() === discoveryAlbum.artistName.toLowerCase()
                );
                
                if (lidarrArtist) {
                    const tagId = await lidarrService.getOrCreateDiscoveryTag();
                    if (tagId && lidarrArtist.tags?.includes(tagId)) {
                        await lidarrService.removeTagsFromArtist(lidarrArtist.id, [tagId]);
                        console.log(`   Removed discovery tag from ${lidarrArtist.artistName} (found by name)`);
                    }
                } else {
                    console.log(`   Artist ${discoveryAlbum.artistName} not found in Lidarr (may have been removed)`);
                }
            } catch (e: any) {
                console.log(`   Failed to remove discovery tag: ${e.message}`);
            }
        }

        // Find the actual Album record and create OwnedAlbum so it appears in library immediately
        // Match by artist name + album title since rgMbid may differ between DiscoveryAlbum and scanned Album
        const dbAlbum = await prisma.album.findFirst({
            where: {
                OR: [
                    { rgMbid: albumId },
                    {
                        title: { equals: discoveryAlbum.albumTitle, mode: "insensitive" },
                        artist: { name: { equals: discoveryAlbum.artistName, mode: "insensitive" } },
                    },
                ],
            },
            include: { artist: true },
        });

        if (dbAlbum) {
            // Update album location to LIBRARY so it appears in owned view
            await prisma.album.update({
                where: { id: dbAlbum.id },
                data: { location: "LIBRARY" },
            });

            // Create OwnedAlbum record if doesn't exist (makes it appear in "Owned" filter)
            await prisma.ownedAlbum.upsert({
                where: {
                    artistId_rgMbid: {
                        artistId: dbAlbum.artistId,
                        rgMbid: dbAlbum.rgMbid,
                    },
                },
                create: {
                    artistId: dbAlbum.artistId,
                    rgMbid: dbAlbum.rgMbid,
                    source: "discovery_liked",
                },
                update: {
                    source: "discovery_liked",
                },
            });
            console.log(`   ✓ Added liked album to library: ${dbAlbum.artist.name} - ${dbAlbum.title} (matched from discovery)`);
        } else {
            console.log(`   [WARN] Could not find scanned album for: ${discoveryAlbum.artistName} - ${discoveryAlbum.albumTitle}`);
        }

        // Retroactively mark all plays from this album as DISCOVERY_KEPT
        // Note: This requires getting tracks from the album first
        const tracks = await prisma.discoveryTrack.findMany({
            where: { discoveryAlbumId: discoveryAlbum.id },
            select: { trackId: true },
        });

        const trackIds = tracks
            .map((t) => t.trackId)
            .filter((id): id is string => id !== null);

        if (trackIds.length > 0) {
            await prisma.play.updateMany({
                where: {
                    userId,
                    trackId: { in: trackIds },
                    source: "DISCOVERY",
                },
                data: {
                    source: "DISCOVERY_KEPT",
                },
            });
        }

        res.json({ success: true });
    } catch (error) {
        console.error("Like discovery album error:", error);
        res.status(500).json({ error: "Failed to like album" });
    }
});

// DELETE /discover/unlike - Unlike a track
router.delete("/unlike", async (req, res) => {
    try {
        const userId = req.user!.id;
        const { albumId } = req.body;

        if (!albumId) {
            return res.status(400).json({ error: "albumId required" });
        }

        const discoveryAlbum = await prisma.discoveryAlbum.findFirst({
            where: {
                userId,
                rgMbid: albumId,
                status: "LIKED",
            },
        });

        if (!discoveryAlbum) {
            return res.status(404).json({ error: "Album not liked" });
        }

        // Revert status back to ACTIVE
        await prisma.discoveryAlbum.update({
            where: { id: discoveryAlbum.id },
            data: {
                status: "ACTIVE",
                likedAt: null,
            },
        });

        // Remove OwnedAlbum record if it was from discovery_liked
        await prisma.ownedAlbum.deleteMany({
            where: {
                rgMbid: albumId,
                source: "discovery_liked",
            },
        });

        // Revert plays back to DISCOVERY source
        const tracks = await prisma.discoveryTrack.findMany({
            where: { discoveryAlbumId: discoveryAlbum.id },
            select: { trackId: true },
        });

        const trackIds = tracks
            .map((t) => t.trackId)
            .filter((id): id is string => id !== null);

        if (trackIds.length > 0) {
            await prisma.play.updateMany({
                where: {
                    userId,
                    trackId: { in: trackIds },
                    source: "DISCOVERY_KEPT",
                },
                data: {
                    source: "DISCOVERY",
                },
            });
        }

        res.json({ success: true });
    } catch (error) {
        console.error("Unlike discovery album error:", error);
        res.status(500).json({ error: "Failed to unlike album" });
    }
});

// GET /discover/config - Get user's Discover Weekly configuration
router.get("/config", async (req, res) => {
    try {
        const userId = req.user!.id;

        let config = await prisma.userDiscoverConfig.findUnique({
            where: { userId },
        });

        // Create default config if doesn't exist
        if (!config) {
            config = await prisma.userDiscoverConfig.create({
                data: {
                    userId,
                    playlistSize: 10,
                    maxRetryAttempts: 3,
                    exclusionMonths: 6,
                    downloadRatio: 1.3,
                    enabled: true,
                    discoveryMode: "mix",
                    discoveryTimeframe: "28d",
                    includeLibraryArtists: false,
                },
            });
        }

        res.json(config);
    } catch (error) {
        console.error("Get Discover Weekly config error:", error);
        res.status(500).json({ error: "Failed to get configuration" });
    }
});

// PATCH /discover/config - Update user's Discover Weekly configuration
router.patch("/config", async (req, res) => {
    try {
        const userId = req.user!.id;
        const { playlistSize, maxRetryAttempts, exclusionMonths, downloadRatio, enabled, discoveryMode, discoveryTimeframe, includeLibraryArtists } = req.body;

        // Validate playlist size
        if (playlistSize !== undefined) {
            const size = parseInt(playlistSize, 10);
            if (isNaN(size) || size < 5 || size > 50 || size % 5 !== 0) {
                return res.status(400).json({
                    error: "Invalid playlist size. Must be between 5-50 in increments of 5.",
                });
            }
        }

        // Validate max retry attempts
        if (maxRetryAttempts !== undefined) {
            const retries = parseInt(maxRetryAttempts, 10);
            if (isNaN(retries) || retries < 1 || retries > 10) {
                return res.status(400).json({
                    error: "Invalid retry attempts. Must be between 1-10.",
                });
            }
        }

        // Validate exclusion months
        if (exclusionMonths !== undefined) {
            const months = parseInt(exclusionMonths, 10);
            if (isNaN(months) || months < 0 || months > 12) {
                return res.status(400).json({
                    error: "Invalid exclusion months. Must be between 0-12.",
                });
            }
        }

        // Validate download ratio
        if (downloadRatio !== undefined) {
            const ratio = parseFloat(downloadRatio);
            if (isNaN(ratio) || ratio < 1.0 || ratio > 2.0) {
                return res.status(400).json({
                    error: "Invalid download ratio. Must be between 1.0-2.0.",
                });
            }
        }

        // Validate discovery mode
        if (discoveryMode !== undefined) {
            const validModes = ["safe", "adjacent", "adventurous", "mix"];
            if (!validModes.includes(discoveryMode)) {
                return res.status(400).json({
                    error: "Invalid discovery mode. Must be one of: safe, adjacent, adventurous, mix.",
                });
            }
        }

        // Validate discovery timeframe
        if (discoveryTimeframe !== undefined) {
            const validTimeframes = ["7d", "28d", "90d", "all"];
            if (!validTimeframes.includes(discoveryTimeframe)) {
                return res.status(400).json({
                    error: "Invalid discovery timeframe. Must be one of: 7d, 28d, 90d, all.",
                });
            }
        }

        const config = await prisma.userDiscoverConfig.upsert({
            where: { userId },
            create: {
                userId,
                playlistSize: playlistSize ?? 10,
                maxRetryAttempts: maxRetryAttempts ?? 3,
                exclusionMonths: exclusionMonths ?? 6,
                downloadRatio: downloadRatio ?? 1.3,
                enabled: enabled ?? true,
                discoveryMode: discoveryMode ?? "mix",
                discoveryTimeframe: discoveryTimeframe ?? "28d",
                includeLibraryArtists: includeLibraryArtists ?? false,
            },
            update: {
                ...(playlistSize !== undefined && {
                    playlistSize: parseInt(playlistSize, 10),
                }),
                ...(maxRetryAttempts !== undefined && {
                    maxRetryAttempts: parseInt(maxRetryAttempts, 10),
                }),
                ...(exclusionMonths !== undefined && {
                    exclusionMonths: parseInt(exclusionMonths, 10),
                }),
                ...(downloadRatio !== undefined && {
                    downloadRatio: parseFloat(downloadRatio),
                }),
                ...(enabled !== undefined && { enabled }),
                ...(discoveryMode !== undefined && { discoveryMode }),
                ...(discoveryTimeframe !== undefined && { discoveryTimeframe }),
                ...(includeLibraryArtists !== undefined && { includeLibraryArtists }),
            },
        });

        res.json(config);
    } catch (error) {
        console.error("Update Discover Weekly config error:", error);
        res.status(500).json({ error: "Failed to update configuration" });
    }
});

// GET /discover/popular-artists - Get popular artists from Last.fm charts
router.get("/popular-artists", async (req, res) => {
    try {
        const limit = parseInt(req.query.limit as string) || 20;

        const artists = await lastFmService.getTopChartArtists(limit);

        res.json({ artists });
    } catch (error: any) {
        console.error(
            "[Discover] Get popular artists error:",
            error?.message || error
        );
        // Return empty array instead of 500 - allows homepage to still render
        res.json({ artists: [] });
    }
});

// DELETE /discover/clear - Clear the discovery playlist (move liked to library, delete the rest)
router.delete("/clear", async (req, res) => {
    try {
        const userId = req.user!.id;

        console.log(`\n Clearing Discover Weekly playlist for user ${userId}`);

        // Get all discovery albums for this user
        const discoveryAlbums = await prisma.discoveryAlbum.findMany({
            where: {
                userId,
                status: { in: ["ACTIVE", "LIKED"] },
            },
        });

        if (discoveryAlbums.length === 0) {
            return res.json({
                success: true,
                message: "No discovery albums to clear",
                likedMoved: 0,
                activeDeleted: 0,
            });
        }

        const likedAlbums = discoveryAlbums.filter((a) => a.status === "LIKED");
        const activeAlbums = discoveryAlbums.filter(
            (a) => a.status === "ACTIVE"
        );

        console.log(
            `  Found ${likedAlbums.length} liked albums to move to library`
        );
        console.log(`  Found ${activeAlbums.length} active albums to delete`);

        // Get system settings for Lidarr
        const settings = await getSystemSettings();

        let likedMoved = 0;
        let activeDeleted = 0;

        // Process liked albums - move to library
        if (likedAlbums.length > 0) {
            console.log(`\n[LIBRARY] Moving liked albums to library...`);

            for (const album of likedAlbums) {
                try {
                    // Find the album in the database by matching artist + title
                    const dbAlbum = await prisma.album.findFirst({
                        where: {
                            title: album.albumTitle,
                            artist: { name: album.artistName },
                        },
                        include: { artist: true },
                    });

                    if (dbAlbum) {
                        // Update album location to LIBRARY
                        await prisma.album.update({
                            where: { id: dbAlbum.id },
                            data: { location: "LIBRARY" },
                        });

                        // Create OwnedAlbum record if doesn't exist
                        await prisma.ownedAlbum.upsert({
                            where: {
                                artistId_rgMbid: {
                                    artistId: dbAlbum.artistId,
                                    rgMbid: dbAlbum.rgMbid,
                                },
                            },
                            create: {
                                artistId: dbAlbum.artistId,
                                rgMbid: dbAlbum.rgMbid,
                                source: "discover_liked",
                            },
                            update: {}, // No update needed if exists
                        });

                        // If Lidarr is enabled, move the album files to main library
                        if (
                            settings.lidarrEnabled &&
                            settings.lidarrUrl &&
                            settings.lidarrApiKey &&
                            album.lidarrAlbumId
                        ) {

                            try {
                                // Get album details from Lidarr
                                const albumResponse = await axios.get(
                                    `${settings.lidarrUrl}/api/v1/album/${album.lidarrAlbumId}`,
                                    {
                                        headers: {
                                            "X-Api-Key": settings.lidarrApiKey,
                                        },
                                        timeout: 10000,
                                    }
                                );

                                const artistId = albumResponse.data.artistId;

                                // Get artist details
                                const artistResponse = await axios.get(
                                    `${settings.lidarrUrl}/api/v1/artist/${artistId}`,
                                    {
                                        headers: {
                                            "X-Api-Key": settings.lidarrApiKey,
                                        },
                                        timeout: 10000,
                                    }
                                );

                                // Update artist's root folder path to main library if in discovery
                                if (
                                    artistResponse.data.path?.includes(
                                        "/music/discovery"
                                    )
                                ) {
                                    // Move artist to main library path
                                    await axios.put(
                                        `${settings.lidarrUrl}/api/v1/artist/${artistId}`,
                                        {
                                            ...artistResponse.data,
                                            path: artistResponse.data.path.replace(
                                                "/music/discovery",
                                                "/music"
                                            ),
                                            moveFiles: true,
                                        },
                                        {
                                            headers: {
                                                "X-Api-Key":
                                                    settings.lidarrApiKey,
                                            },
                                            timeout: 30000,
                                        }
                                    );
                                    console.log(
                                        `    Moved to library: ${album.artistName} - ${album.albumTitle}`
                                    );
                                }
                            } catch (lidarrError: any) {
                                console.log(
                                    `  Lidarr move failed for ${album.albumTitle}: ${lidarrError.message}`
                                );
                            }
                        }

                        likedMoved++;
                    }

                    // Mark as MOVED in discovery database
                    await prisma.discoveryAlbum.update({
                        where: { id: album.id },
                        data: { status: "MOVED" },
                    });
                } catch (error: any) {
                    console.error(
                        `  ✗ Failed to move ${album.albumTitle}: ${error.message}`
                    );
                }
            }
        }

        // Process active (non-liked) albums - delete them
        if (activeAlbums.length > 0) {
            console.log(`\n[CLEANUP] Deleting non-liked albums...`);

            const checkedArtistIds = new Set<number>();

            for (const album of activeAlbums) {
                try {
                    // Remove from Lidarr if enabled
                    if (
                        settings.lidarrEnabled &&
                        settings.lidarrUrl &&
                        settings.lidarrApiKey &&
                        album.lidarrAlbumId
                    ) {

                        try {
                            // Get album details to find artist ID
                            let artistId: number | undefined;
                            try {
                                const albumResponse = await axios.get(
                                    `${settings.lidarrUrl}/api/v1/album/${album.lidarrAlbumId}`,
                                    {
                                        headers: {
                                            "X-Api-Key": settings.lidarrApiKey,
                                        },
                                        timeout: 10000,
                                    }
                                );
                                artistId = albumResponse.data.artistId;
                            } catch (e: any) {
                                if (e.response?.status !== 404) throw e;
                            }

                            // Delete album from Lidarr
                            await axios.delete(
                                `${settings.lidarrUrl}/api/v1/album/${album.lidarrAlbumId}`,
                                {
                                    params: { deleteFiles: true },
                                    headers: {
                                        "X-Api-Key": settings.lidarrApiKey,
                                    },
                                    timeout: 10000,
                                }
                            );
                            console.log(
                                `    Deleted from Lidarr: ${album.albumTitle}`
                            );

                            // Check if artist should be removed too
                            if (artistId && !checkedArtistIds.has(artistId)) {
                                checkedArtistIds.add(artistId);

                                try {
                                    const artistResponse = await axios.get(
                                        `${settings.lidarrUrl}/api/v1/artist/${artistId}`,
                                        {
                                            headers: {
                                                "X-Api-Key":
                                                    settings.lidarrApiKey,
                                            },
                                            timeout: 10000,
                                        }
                                    );

                                    const artist = artistResponse.data;
                                    const artistMbid = artist.foreignArtistId;

                                    // Check if artist has any NATIVE library content (real user library)
                                    // This is more reliable than checking Album.location which can be wrong
                                    const hasNativeOwnedAlbums =
                                        await prisma.ownedAlbum.findFirst({
                                            where: {
                                                artist: { mbid: artistMbid },
                                                source: "native_scan",
                                            },
                                        });

                                    // Check if artist has any LIKED/MOVED discovery albums
                                    const hasKeptDiscoveryAlbums =
                                        await prisma.discoveryAlbum.findFirst({
                                            where: {
                                                artistMbid: artistMbid,
                                                status: {
                                                    in: ["LIKED", "MOVED"],
                                                },
                                            },
                                        });

                                    // Only remove artist if they have no native library content and no kept discovery albums
                                    if (
                                        !hasNativeOwnedAlbums &&
                                        !hasKeptDiscoveryAlbums
                                    ) {
                                        await axios.delete(
                                            `${settings.lidarrUrl}/api/v1/artist/${artistId}`,
                                            {
                                                params: { deleteFiles: true },
                                                headers: {
                                                    "X-Api-Key":
                                                        settings.lidarrApiKey,
                                                },
                                                timeout: 10000,
                                            }
                                        );
                                        console.log(
                                            `    Removed artist from Lidarr: ${artist.artistName}`
                                        );
                                    } else {
                                        console.log(
                                            `    Keeping artist in Lidarr: ${artist.artistName} (has library or kept albums)`
                                        );
                                    }
                                } catch (e: any) {
                                    // Artist might have other albums
                                }
                            }
                        } catch (lidarrError: any) {
                            if (lidarrError.response?.status !== 404) {
                                console.log(
                                    `  Lidarr delete failed for ${album.albumTitle}: ${lidarrError.message}`
                                );
                            }
                        }
                    }

                    // FALLBACK: Direct filesystem deletion (in case Lidarr's deleteFiles didn't work)
                    // Try to delete files directly from the discovery folder
                    try {
                        const discoveryPath = path.join(config.music.musicPath, "discovery");
                        // Try common folder structures: /discovery/Artist/Album or /discovery/Artist - Album
                        const possiblePaths = [
                            path.join(discoveryPath, album.artistName, album.albumTitle),
                            path.join(discoveryPath, album.artistName),
                            path.join(discoveryPath, `${album.artistName} - ${album.albumTitle}`),
                        ];

                        for (const albumPath of possiblePaths) {
                            if (fs.existsSync(albumPath)) {
                                fs.rmSync(albumPath, { recursive: true, force: true });
                                console.log(`    Direct deleted: ${albumPath}`);
                                break; // Stop after first successful delete
                            }
                        }
                    } catch (fsError: any) {
                        console.log(`    Filesystem delete failed for ${album.albumTitle}: ${fsError.message}`);
                    }

                    // Delete DiscoveryTrack records first (foreign key to Track)
                    await prisma.discoveryTrack.deleteMany({
                        where: { discoveryAlbumId: album.id },
                    });

                    // Remove from local database
                    const dbAlbum = await prisma.album.findFirst({
                        where: {
                            title: album.albumTitle,
                            artist: { name: album.artistName },
                            location: "DISCOVER",
                        },
                        include: { tracks: true },
                    });

                    if (dbAlbum) {
                        // Delete tracks first
                        await prisma.track.deleteMany({
                            where: { albumId: dbAlbum.id },
                        });

                        // Delete album
                        await prisma.album.delete({
                            where: { id: dbAlbum.id },
                        });
                    }

                    // Mark as DELETED in discovery database
                    await prisma.discoveryAlbum.update({
                        where: { id: album.id },
                        data: { status: "DELETED" },
                    });

                    activeDeleted++;
                } catch (error: any) {
                    console.error(
                        `  ✗ Failed to delete ${album.albumTitle}: ${error.message}`
                    );
                }
            }
        }

        // ALSO clean up "extra" downloaded albums that didn't make the final playlist
        // These are in DownloadJob but not in DiscoveryAlbum
        // IMPORTANT: Skip any albums where the artist has LIKED content (even if MBID doesn't match)
        if (settings.lidarrEnabled && settings.lidarrUrl && settings.lidarrApiKey) {
            const completedJobs = await prisma.downloadJob.findMany({
                where: {
                    userId,
                    discoveryBatchId: { not: null },
                    status: "completed",
                },
            });

            // Get all DiscoveryAlbum for this user (including ones we just processed)
            const allDiscoveryAlbums = await prisma.discoveryAlbum.findMany({
                where: { userId },
                select: { rgMbid: true, artistName: true, albumTitle: true, status: true },
            });
            const discoveryMbids = new Set(allDiscoveryAlbums.map(da => da.rgMbid));
            
            // Build a set of liked artist names (case-insensitive) for extra protection
            const likedArtistNames = new Set(
                allDiscoveryAlbums
                    .filter(da => da.status === "LIKED" || da.status === "MOVED")
                    .map(da => da.artistName.toLowerCase())
            );

            // Find completed jobs that didn't make the playlist AND aren't from liked artists
            const extraJobs = completedJobs.filter(job => {
                // If MBID matches a discovery album, not an "extra"
                if (job.targetMbid && discoveryMbids.has(job.targetMbid)) return false;
                
                // If this job's artist has any LIKED albums, don't clean it up
                const metadata = job.metadata as any;
                const artistName = metadata?.artistName?.toLowerCase();
                if (artistName && likedArtistNames.has(artistName)) {
                    console.log(`    Skipping ${metadata?.albumTitle} - artist ${metadata?.artistName} has liked albums`);
                    return false;
                }
                
                return true;
            });

            if (extraJobs.length > 0) {
                console.log(`\n[CLEANUP] Found ${extraJobs.length} extra albums to clean from Lidarr...`);
                
                for (const job of extraJobs) {
                    const metadata = job.metadata as any;
                    const albumTitle = metadata?.albumTitle || job.subject;
                    const artistName = metadata?.artistName;
                    
                    // Double-check: also check by artist name + album title for LIKED status
                    const isLikedByName = await prisma.discoveryAlbum.findFirst({
                        where: {
                            userId,
                            artistName: { equals: artistName, mode: "insensitive" },
                            albumTitle: { equals: albumTitle, mode: "insensitive" },
                            status: { in: ["LIKED", "MOVED"] },
                        },
                    });
                    
                    if (isLikedByName) {
                        console.log(`    Skipping ${albumTitle} - marked as LIKED`);
                        continue;
                    }
                    
                    if (job.lidarrAlbumId) {
                        try {
                            // Get artist ID before deleting album
                            let artistId: number | undefined;
                            try {
                                const albumResponse = await axios.get(
                                    `${settings.lidarrUrl}/api/v1/album/${job.lidarrAlbumId}`,
                                    {
                                        headers: { "X-Api-Key": settings.lidarrApiKey },
                                        timeout: 10000,
                                    }
                                );
                                artistId = albumResponse.data.artistId;
                            } catch (e) {
                                // Album might not exist
                            }

                            // Delete album from Lidarr
                            await axios.delete(
                                `${settings.lidarrUrl}/api/v1/album/${job.lidarrAlbumId}`,
                                {
                                    params: { deleteFiles: true },
                                    headers: { "X-Api-Key": settings.lidarrApiKey },
                                    timeout: 10000,
                                }
                            );
                            console.log(`    Cleaned up extra album: ${albumTitle}`);

                            // Check if artist should be removed too
                            if (artistId) {
                                // Check if artist has any liked albums by NAME (more reliable than MBID)
                                const hasLikedByArtistName = await prisma.discoveryAlbum.findFirst({
                                    where: {
                                        artistName: { equals: artistName, mode: "insensitive" },
                                        status: { in: ["LIKED", "MOVED"] },
                                    },
                                });

                                if (hasLikedByArtistName) {
                                    console.log(`    Keeping artist: ${artistName} (has liked albums)`);
                                    continue;
                                }

                                const artistMbid = metadata?.artistMbid;
                                if (artistMbid && !artistMbid.startsWith("temp-")) {
                                    // Check if artist has native library content
                                    const hasNativeLibrary = await prisma.ownedAlbum.findFirst({
                                        where: {
                                            artist: { mbid: artistMbid },
                                            source: "native_scan",
                                        },
                                    });

                                    if (!hasNativeLibrary) {
                                        try {
                                            await axios.delete(
                                                `${settings.lidarrUrl}/api/v1/artist/${artistId}`,
                                                {
                                                    params: { deleteFiles: true },
                                                    headers: { "X-Api-Key": settings.lidarrApiKey },
                                                    timeout: 10000,
                                                }
                                            );
                                            console.log(`    Removed extra artist from Lidarr: ${artistName}`);
                                        } catch (e) {
                                            // Artist might have other albums
                                        }
                                    }
                                }
                            }
                        } catch (e: any) {
                            // Ignore - might already be removed
                            if (e.response?.status !== 404) {
                                console.log(`    Failed to clean up ${albumTitle}: ${e.message}`);
                            }
                        }
                    }
                }
            }
        }

        // Clean up unavailable albums for this user
        await prisma.unavailableAlbum.deleteMany({
            where: { userId },
        });

        // === PHASE 1.5: Clean up failed artists from Lidarr ===
        // Get all failed download jobs for this user and remove their artists from Lidarr
        if (settings.lidarrEnabled && settings.lidarrUrl && settings.lidarrApiKey) {
            console.log(`\n[CLEANUP] Checking for failed artists to remove from Lidarr...`);
            
            const failedJobs = await prisma.downloadJob.findMany({
                where: {
                    userId,
                    status: "failed",
                    discoveryBatchId: { not: null },
                },
            });

            // Group by artist
            const failedArtistMbids = new Set<string>();
            const artistNames = new Map<string, string>();
            
            for (const job of failedJobs) {
                const metadata = job.metadata as any;
                if (metadata?.artistMbid) {
                    failedArtistMbids.add(metadata.artistMbid);
                    artistNames.set(metadata.artistMbid, metadata.artistName || "Unknown");
                }
            }

            // Remove failed artists that don't have native library content
            for (const artistMbid of failedArtistMbids) {
                try {
                    // Check if artist has any NATIVE library content (real user library)
                    const hasNativeOwnedAlbums = await prisma.ownedAlbum.findFirst({
                        where: {
                            artist: { mbid: artistMbid },
                            source: "native_scan",
                        },
                    });

                    if (hasNativeOwnedAlbums) {
                        console.log(`   Keeping ${artistNames.get(artistMbid)} - has native library content`);
                        continue;
                    }

                    // Check if artist has any LIKED discovery albums
                    const hasLikedDiscovery = await prisma.discoveryAlbum.findFirst({
                        where: {
                            artistMbid,
                            status: { in: ["LIKED", "MOVED"] },
                        },
                    });

                    if (hasLikedDiscovery) {
                        console.log(`   Keeping ${artistNames.get(artistMbid)} - has liked discovery albums`);
                        continue;
                    }

                    // Find and remove from Lidarr
                    const searchResponse = await axios.get(
                        `${settings.lidarrUrl}/api/v1/artist`,
                        {
                            headers: { "X-Api-Key": settings.lidarrApiKey },
                            timeout: 10000,
                        }
                    );

                    const lidarrArtist = searchResponse.data.find(
                        (a: any) => a.foreignArtistId === artistMbid
                    );

                    if (lidarrArtist) {
                        await axios.delete(
                            `${settings.lidarrUrl}/api/v1/artist/${lidarrArtist.id}`,
                            {
                                params: { deleteFiles: true },
                                headers: { "X-Api-Key": settings.lidarrApiKey },
                                timeout: 10000,
                            }
                        );
                        console.log(`   ✓ Removed failed artist from Lidarr: ${artistNames.get(artistMbid)}`);
                    }
                } catch (e: any) {
                    // Ignore errors - artist might already be removed
                }
            }

            // DON'T delete download jobs immediately - scanner needs them to identify discovery albums
            // They will be cleaned up by the data integrity worker after 30 days
            // Only delete FAILED jobs (they won't help with matching anyway)
            await prisma.downloadJob.deleteMany({
                where: {
                    userId,
                    discoveryBatchId: { not: null },
                    status: "failed",
                },
            });
        }

        // === PHASE 2: Clean up orphaned discovery records ===
        // These are Album/Track records with location="DISCOVER" that weren't linked to a DiscoveryAlbum
        // This can happen if downloads failed or playlist build failed
        console.log(`\n Cleaning up orphaned discovery records...`);

        // Find all DISCOVER albums that don't have a corresponding DiscoveryAlbum record
        const orphanedAlbums = await prisma.album.findMany({
            where: {
                location: "DISCOVER",
            },
            include: { artist: true, tracks: true },
        });

        let orphanedAlbumsDeleted = 0;
        for (const orphanAlbum of orphanedAlbums) {
            // Check if there's a DiscoveryAlbum record for this
            // Include MOVED status because liked albums are marked MOVED during clear
            const hasDiscoveryRecord = await prisma.discoveryAlbum.findFirst({
                where: {
                    OR: [
                        { rgMbid: orphanAlbum.rgMbid },
                        {
                            albumTitle: orphanAlbum.title,
                            artistName: orphanAlbum.artist.name,
                        },
                    ],
                    status: { in: ["ACTIVE", "LIKED", "MOVED"] }, // Keep if active, liked, or moved to library
                },
            });
            
            // Also check if there's an OwnedAlbum record (user liked it)
            const hasOwnedRecord = await prisma.ownedAlbum.findFirst({
                where: {
                    rgMbid: orphanAlbum.rgMbid,
                },
            });

            if (!hasDiscoveryRecord && !hasOwnedRecord) {
                // Delete tracks first
                await prisma.track.deleteMany({
                    where: { albumId: orphanAlbum.id },
                });
                // Delete album
                await prisma.album.delete({
                    where: { id: orphanAlbum.id },
                });
                orphanedAlbumsDeleted++;
                console.log(
                    `    Deleted orphaned album: ${orphanAlbum.artist.name} - ${orphanAlbum.title}`
                );
            }
        }

        if (orphanedAlbumsDeleted > 0) {
            console.log(
                `  Cleaned up ${orphanedAlbumsDeleted} orphaned discovery albums`
            );
        }

        // Clean up orphaned artists (artists with no albums)
        const orphanedArtists = await prisma.artist.findMany({
            where: {
                albums: { none: {} },
            },
        });

        if (orphanedArtists.length > 0) {
            const orphanIds = orphanedArtists.map((a) => a.id);
            
            // Delete artist relations first (SimilarArtist records)
            // Note: SimilarArtist uses fromArtistId/toArtistId field names
            await prisma.similarArtist.deleteMany({
                where: {
                    OR: [
                        { fromArtistId: { in: orphanIds } },
                        { toArtistId: { in: orphanIds } },
                    ],
                },
            });

            await prisma.artist.deleteMany({
                where: { id: { in: orphanIds } },
            });
            console.log(
                `  Cleaned up ${orphanedArtists.length} orphaned artists`
            );
        }

        // Clean up orphaned DiscoveryTrack records (tracks whose album was deleted)
        const orphanedDiscoveryTracks = await prisma.discoveryTrack.deleteMany({
            where: {
                trackId: null, // Track was deleted but DiscoveryTrack record remains
            },
        });

        if (orphanedDiscoveryTracks.count > 0) {
            console.log(
                `  Cleaned up ${orphanedDiscoveryTracks.count} orphaned discovery track records`
            );
        }

        // Clean up old DiscoveryAlbum records that are DELETED or MOVED (older than 30 days)
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

        const oldDiscoveryAlbums = await prisma.discoveryAlbum.deleteMany({
            where: {
                userId,
                status: { in: ["DELETED", "MOVED"] },
                downloadedAt: { lt: thirtyDaysAgo },
            },
        });

        if (oldDiscoveryAlbums.count > 0) {
            console.log(
                `  Cleaned up ${oldDiscoveryAlbums.count} old discovery album records`
            );
        }

        // === PHASE 3: Tag-based Lidarr cleanup ===
        // Only remove artists that have the "lidify-discovery" tag
        // This is the ONLY reliable way to identify discovery artists
        // User's pre-existing library is NEVER touched (no tag = safe)
        let lidarrArtistsRemoved = 0;
        if (settings.lidarrEnabled && settings.lidarrUrl && settings.lidarrApiKey) {
            console.log(`\n[LIDARR CLEANUP] Tag-based cleanup (lidify-discovery tag)...`);
            
            try {
                // Get all artists with the discovery tag
                const discoveryArtists = await lidarrService.getDiscoveryArtists();
                console.log(`   Found ${discoveryArtists.length} artists with discovery tag`);
                
                for (const lidarrArtist of discoveryArtists) {
                    const artistMbid = lidarrArtist.foreignArtistId;
                    const artistName = lidarrArtist.artistName;
                    
                    if (!artistMbid) continue;
                    
                    // Double-check: if artist has LIKED albums, remove tag but don't delete
                    // (This is a safety net - the like endpoint should have already removed the tag)
                    const hasKeptDiscovery = await prisma.discoveryAlbum.findFirst({
                        where: {
                            artistMbid: artistMbid,
                            status: { in: ["LIKED", "MOVED"] },
                        },
                    });
                    
                    if (hasKeptDiscovery) {
                        // Remove the tag but keep the artist
                        console.log(`   Keeping ${artistName} - has liked albums (removing tag)`);
                        await lidarrService.removeDiscoveryTagByMbid(artistMbid);
                        continue;
                    }
                    
                    // Artist has discovery tag AND no liked albums = safe to delete
                    try {
                        const result = await lidarrService.deleteArtistById(lidarrArtist.id, true);
                        if (result.success) {
                            lidarrArtistsRemoved++;
                            console.log(`   ✓ Removed: ${artistName}`);
                        }
                    } catch (deleteError: any) {
                        console.log(`   ✗ Failed to remove ${artistName}: ${deleteError.message}`);
                    }
                }
                
                console.log(`   Tag-based cleanup complete: ${lidarrArtistsRemoved} artists removed`);
            } catch (lidarrError: any) {
                console.log(`   Lidarr cleanup failed: ${lidarrError.message}`);
            }
        }

        // === PHASE 4: Trigger library scan to sync database with filesystem ===
        console.log(`\n[SCAN] Triggering library scan to sync database...`);
        try {
            await scanQueue.add("scan", {
                userId,
                musicPath: config.music.musicPath,
            });
            console.log(`   Library scan queued successfully`);
        } catch (scanError: any) {
            console.log(`   Library scan queue failed: ${scanError.message}`);
            // Non-fatal - continue with response
        }

        console.log(
            `\nClear complete: ${likedMoved} moved to library, ${activeDeleted} deleted, ${orphanedAlbumsDeleted} orphans cleaned, ${lidarrArtistsRemoved} Lidarr artists removed`
        );

        res.json({
            success: true,
            message: "Discovery playlist cleared",
            likedMoved,
            activeDeleted,
            orphanedAlbumsDeleted,
            lidarrArtistsRemoved,
        });
    } catch (error: any) {
        console.error("Clear discovery playlist error:", error?.message || error);
        console.error("Stack:", error?.stack);
        res.status(500).json({ 
            error: "Failed to clear discovery playlist",
            details: error?.message || "Unknown error"
        });
    }
});

// GET /discover/exclusions - Get all exclusions for current user
router.get("/exclusions", async (req, res) => {
    try {
        const userId = req.user!.id;

        const exclusions = await prisma.discoverExclusion.findMany({
            where: { 
                userId,
                expiresAt: { gt: new Date() } // Only active exclusions
            },
            orderBy: { lastSuggestedAt: "desc" },
        });

        // Return exclusions with names
        const mapped = exclusions.map((exc) => ({
            id: exc.id,
            albumMbid: exc.albumMbid,
            artistName: exc.artistName || "Unknown Artist",
            albumTitle: exc.albumTitle || exc.albumMbid.slice(0, 8) + "...",
            lastSuggestedAt: exc.lastSuggestedAt,
            expiresAt: exc.expiresAt,
        }));

        res.json({
            exclusions: mapped,
            count: exclusions.length,
        });
    } catch (error: any) {
        console.error("Get exclusions error:", error?.message || error);
        console.error("Stack:", error?.stack);
        res.status(500).json({ error: "Failed to get exclusions", details: error?.message });
    }
});

// DELETE /discover/exclusions - Clear all exclusions for current user
router.delete("/exclusions", async (req, res) => {
    try {
        const userId = req.user!.id;

        const result = await prisma.discoverExclusion.deleteMany({
            where: { userId },
        });

        console.log(`[Discovery] Cleared ${result.count} exclusions for user ${userId}`);

        res.json({
            success: true,
            message: `Cleared ${result.count} exclusions`,
            clearedCount: result.count,
        });
    } catch (error) {
        console.error("Clear exclusions error:", error);
        res.status(500).json({ error: "Failed to clear exclusions" });
    }
});

// DELETE /discover/exclusions/:id - Remove a specific exclusion
router.delete("/exclusions/:id", async (req, res) => {
    try {
        const userId = req.user!.id;
        const { id } = req.params;

        const exclusion = await prisma.discoverExclusion.findFirst({
            where: { id, userId },
        });

        if (!exclusion) {
            return res.status(404).json({ error: "Exclusion not found" });
        }

        await prisma.discoverExclusion.delete({
            where: { id },
        });

        res.json({
            success: true,
            message: "Exclusion removed",
        });
    } catch (error) {
        console.error("Remove exclusion error:", error);
        res.status(500).json({ error: "Failed to remove exclusion" });
    }
});

// POST /discover/cleanup-lidarr - Remove discovery-only artists from Lidarr
// This cleans up artists that were added for discovery but shouldn't remain
router.post("/cleanup-lidarr", async (req, res) => {
    try {
        console.log("\n[CLEANUP] Starting Lidarr cleanup of discovery-only artists...");
        
        const settings = await getSystemSettings();
        
        if (!settings.lidarrEnabled || !settings.lidarrUrl || !settings.lidarrApiKey) {
            return res.status(400).json({ error: "Lidarr not configured" });
        }
        
        // Get all artists from Lidarr
        const lidarrResponse = await axios.get(
            `${settings.lidarrUrl}/api/v1/artist`,
            {
                headers: { "X-Api-Key": settings.lidarrApiKey },
                timeout: 30000,
            }
        );
        
        const lidarrArtists = lidarrResponse.data;
        console.log(`[CLEANUP] Found ${lidarrArtists.length} artists in Lidarr`);
        
        const artistsRemoved: string[] = [];
        const artistsKept: string[] = [];
        const errors: string[] = [];
        
        for (const lidarrArtist of lidarrArtists) {
            const artistMbid = lidarrArtist.foreignArtistId;
            const artistName = lidarrArtist.artistName;
            
            if (!artistMbid) continue;
            
            try {
                // Check if this artist has any NATIVE library content (real user library)
                // This is more reliable than checking Album.location which can be wrong
                const hasNativeOwnedAlbums = await prisma.ownedAlbum.findFirst({
                    where: {
                        artist: { mbid: artistMbid },
                        source: "native_scan",
                    },
                });
                
                // Check if artist has any LIKED/MOVED discovery albums
                const hasKeptDiscoveryAlbums = await prisma.discoveryAlbum.findFirst({
                    where: {
                        artistMbid: artistMbid,
                        status: { in: ["LIKED", "MOVED"] },
                    },
                });
                
                // Check if artist has any ACTIVE discovery albums (current playlist)
                const hasActiveDiscoveryAlbums = await prisma.discoveryAlbum.findFirst({
                    where: {
                        artistMbid: artistMbid,
                        status: "ACTIVE",
                    },
                });
                
                if (hasNativeOwnedAlbums || hasKeptDiscoveryAlbums) {
                    // This artist should stay in Lidarr
                    artistsKept.push(`${artistName} (has native library or kept albums)`);
                    continue;
                }
                
                if (hasActiveDiscoveryAlbums) {
                    // This artist has a current discovery album, keep for now
                    artistsKept.push(`${artistName} (has active discovery)`);
                    continue;
                }
                
                // This artist has no library albums and no active/kept discovery albums
                // They should be removed from Lidarr
                console.log(`[CLEANUP] Removing discovery-only artist: ${artistName}`);
                
                await axios.delete(
                    `${settings.lidarrUrl}/api/v1/artist/${lidarrArtist.id}`,
                    {
                        params: { deleteFiles: true },
                        headers: { "X-Api-Key": settings.lidarrApiKey },
                        timeout: 30000,
                    }
                );
                
                artistsRemoved.push(artistName);
                console.log(`[CLEANUP] ✓ Removed: ${artistName}`);
                
            } catch (error: any) {
                const msg = `Failed to process ${artistName}: ${error.message}`;
                errors.push(msg);
                console.error(`[CLEANUP] ✗ ${msg}`);
            }
        }
        
        console.log(`\n[CLEANUP] Complete:`);
        console.log(`   - Removed: ${artistsRemoved.length}`);
        console.log(`   - Kept: ${artistsKept.length}`);
        console.log(`   - Errors: ${errors.length}`);
        
        res.json({
            success: true,
            removed: artistsRemoved,
            kept: artistsKept,
            errors,
            summary: {
                removed: artistsRemoved.length,
                kept: artistsKept.length,
                errors: errors.length,
            },
        });
    } catch (error: any) {
        console.error("[CLEANUP] Lidarr cleanup error:", error?.message || error);
        res.status(500).json({ 
            error: "Failed to cleanup Lidarr",
            details: error?.message || "Unknown error",
        });
    }
});

// POST /discover/fix-tagging - Fix albums incorrectly tagged as LIBRARY that should be DISCOVER
// This repairs existing bad data caused by scanner timing issues
// IMPORTANT: Does NOT touch albums that user has LIKED (discovery_liked) or native library
router.post("/fix-tagging", async (req, res) => {
    try {
        console.log("\n[FIX-TAGGING] Starting album tagging repair...");
        
        // Get all discovery artists (from DiscoveryAlbum records)
        const discoveryArtists = await prisma.discoveryAlbum.findMany({
            distinct: ['artistMbid'],
            select: { artistMbid: true, artistName: true },
        });
        
        console.log(`[FIX-TAGGING] Found ${discoveryArtists.length} artists with discovery records`);
        
        let albumsFixed = 0;
        let ownedRecordsRemoved = 0;
        const fixedArtists: string[] = [];
        
        for (const da of discoveryArtists) {
            if (!da.artistMbid) continue;
            
            // Check if artist has ANY protected content:
            // 1. native_scan = real user library from before discovery
            // 2. discovery_liked = user liked a discovery album (should be kept!)
            const hasProtectedContent = await prisma.ownedAlbum.findFirst({
                where: {
                    artist: { mbid: da.artistMbid },
                    source: { in: ["native_scan", "discovery_liked"] },
                },
            });
            
            if (hasProtectedContent) {
                // Artist has protected content - don't touch their albums
                console.log(`[FIX-TAGGING] Skipping ${da.artistName} - has protected content (${hasProtectedContent.source})`);
                continue;
            }
            
            // Also check if artist has any LIKED discovery albums (double-check)
            const hasLikedDiscovery = await prisma.discoveryAlbum.findFirst({
                where: {
                    artistMbid: da.artistMbid,
                    status: { in: ["LIKED", "MOVED"] },
                },
            });
            
            if (hasLikedDiscovery) {
                // User liked albums from this artist - don't touch
                console.log(`[FIX-TAGGING] Skipping ${da.artistName} - has LIKED discovery albums`);
                continue;
            }
            
            // This artist has NO protected content - they're purely an ACTIVE discovery artist
            // Fix any of their albums that are incorrectly tagged as LIBRARY
            const mistaggedAlbums = await prisma.album.findMany({
                where: {
                    artist: { mbid: da.artistMbid },
                    location: "LIBRARY",
                },
            });
            
            if (mistaggedAlbums.length > 0) {
                // Update all these albums to DISCOVER
                const updated = await prisma.album.updateMany({
                    where: {
                        artist: { mbid: da.artistMbid },
                        location: "LIBRARY",
                    },
                    data: { location: "DISCOVER" },
                });
                
                // Remove incorrect OwnedAlbum records (but not protected ones)
                const removed = await prisma.ownedAlbum.deleteMany({
                    where: {
                        artist: { mbid: da.artistMbid },
                        source: { notIn: ["native_scan", "discovery_liked"] },
                    },
                });
                
                albumsFixed += updated.count;
                ownedRecordsRemoved += removed.count;
                fixedArtists.push(da.artistName);
                
                console.log(`[FIX-TAGGING] Fixed ${updated.count} albums for ${da.artistName}`);
            }
        }
        
        console.log(`[FIX-TAGGING] Complete: ${albumsFixed} albums fixed, ${ownedRecordsRemoved} OwnedAlbum records removed`);
        
        res.json({
            success: true,
            albumsFixed,
            ownedRecordsRemoved,
            fixedArtists,
        });
    } catch (error: any) {
        console.error("[FIX-TAGGING] Error:", error?.message || error);
        res.status(500).json({ 
            error: "Failed to fix album tagging",
            details: error?.message || "Unknown error",
        });
    }
});

export default router;
