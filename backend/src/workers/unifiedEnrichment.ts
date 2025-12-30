/**
 * Unified Enrichment Worker
 *
 * Handles ALL enrichment in one place:
 * - Artist metadata (Last.fm, MusicBrainz)
 * - Track mood tags (Last.fm)
 * - Audio analysis (triggers Essentia via Redis queue)
 *
 * Two modes:
 * 1. FULL: Re-enriches everything regardless of status (Settings > Enrich)
 * 2. INCREMENTAL: Only new material and incomplete items (Sync)
 */

import { prisma } from "../utils/db";
import { enrichSimilarArtist } from "./artistEnrichment";
import { lastFmService } from "../services/lastfm";
import Redis from "ioredis";
import { config } from "../config";

// Configuration
const ARTIST_BATCH_SIZE = 10;
const TRACK_BATCH_SIZE = 50; // Increased from 20 for faster enrichment
const ENRICHMENT_INTERVAL_MS = 30 * 1000; // 30 seconds

let isRunning = false;
let enrichmentInterval: NodeJS.Timeout | null = null;
let redis: Redis | null = null;

// Mood tags to extract from Last.fm
const MOOD_TAGS = new Set([
    // Energy/Activity
    "chill",
    "relax",
    "relaxing",
    "calm",
    "peaceful",
    "ambient",
    "energetic",
    "upbeat",
    "hype",
    "party",
    "dance",
    "workout",
    "gym",
    "running",
    "exercise",
    "motivation",
    // Emotions
    "sad",
    "melancholy",
    "melancholic",
    "depressing",
    "heartbreak",
    "happy",
    "feel good",
    "feel-good",
    "joyful",
    "uplifting",
    "angry",
    "aggressive",
    "intense",
    "romantic",
    "love",
    "sensual",
    // Time/Setting
    "night",
    "late night",
    "evening",
    "morning",
    "summer",
    "winter",
    "rainy",
    "sunny",
    "driving",
    "road trip",
    "travel",
    // Activity
    "study",
    "focus",
    "concentration",
    "work",
    "sleep",
    "sleeping",
    "bedtime",
    // Vibe
    "dreamy",
    "atmospheric",
    "ethereal",
    "spacey",
    "groovy",
    "funky",
    "smooth",
    "dark",
    "moody",
    "brooding",
    "epic",
    "cinematic",
    "dramatic",
    "nostalgic",
    "throwback",
]);

/**
 * Filter tags to only include mood-relevant ones
 */
function filterMoodTags(tags: string[]): string[] {
    return tags
        .map((t) => t.toLowerCase().trim())
        .filter((t) => {
            if (MOOD_TAGS.has(t)) return true;
            for (const mood of MOOD_TAGS) {
                if (t.includes(mood) || mood.includes(t)) return true;
            }
            return false;
        })
        .slice(0, 10);
}

/**
 * Initialize Redis connection for audio analysis queue
 */
function getRedis(): Redis {
    if (!redis) {
        redis = new Redis(config.redisUrl);
    }
    return redis;
}

/**
 * Start the unified enrichment worker (incremental mode)
 */
export async function startUnifiedEnrichmentWorker() {
    console.log("\n=== Starting Unified Enrichment Worker ===");
    console.log(`   Artist batch: ${ARTIST_BATCH_SIZE}`);
    console.log(`   Track batch: ${TRACK_BATCH_SIZE}`);
    console.log(`   Interval: ${ENRICHMENT_INTERVAL_MS / 1000}s`);
    console.log("");

    // Run immediately
    await runEnrichmentCycle(false);

    // Then run at interval
    enrichmentInterval = setInterval(async () => {
        await runEnrichmentCycle(false);
    }, ENRICHMENT_INTERVAL_MS);
}

/**
 * Stop the enrichment worker
 */
export function stopUnifiedEnrichmentWorker() {
    if (enrichmentInterval) {
        clearInterval(enrichmentInterval);
        enrichmentInterval = null;
        console.log("[Enrichment] Worker stopped");
    }
    if (redis) {
        redis.disconnect();
        redis = null;
    }
}

/**
 * Run a full enrichment (re-enrich everything regardless of status)
 * Called from Settings > Enrich All
 */
export async function runFullEnrichment(): Promise<{
    artists: number;
    tracks: number;
    audioQueued: number;
}> {
    console.log("\n=== FULL ENRICHMENT: Re-enriching everything ===\n");

    // Reset all statuses to pending
    await prisma.artist.updateMany({
        data: { enrichmentStatus: "pending" },
    });

    await prisma.track.updateMany({
        data: {
            lastfmTags: [],
            analysisStatus: "pending",
        },
    });

    // Now run the enrichment cycle
    const result = await runEnrichmentCycle(true);

    return result;
}

/**
 * Main enrichment cycle
 *
 * Flow:
 * 1. Artist metadata (Last.fm/MusicBrainz) - blocking, required for track enrichment
 * 2. Track tags (Last.fm mood tags) - blocking, quick API calls
 * 3. Audio analysis (Essentia) - NON-BLOCKING, queued to Redis for background processing
 *
 * Steps 1 & 2 must complete before enrichment is "done".
 * Step 3 runs entirely in background via the audio-analyzer Docker container.
 *
 * @param fullMode - If true, processes everything. If false, only pending items.
 */
async function runEnrichmentCycle(fullMode: boolean): Promise<{
    artists: number;
    tracks: number;
    audioQueued: number;
}> {
    if (isRunning && !fullMode) {
        return { artists: 0, tracks: 0, audioQueued: 0 };
    }

    isRunning = true;
    let artistsProcessed = 0;
    let tracksProcessed = 0;
    let audioQueued = 0;

    try {
        // Step 1: Enrich artists (blocking - required for step 2)
        artistsProcessed = await enrichArtistsBatch();

        // Step 2: Last.fm track tags - DISABLED
        // Essentia audio analysis already provides better mood tags from actual audio
        // Last.fm coverage is poor (~98% of tracks have no tags)
        // tracksProcessed = await enrichTrackTagsBatch();

        // Step 3: Queue audio analysis (NON-BLOCKING)
        // Just adds to Redis queue - actual processing happens in audio-analyzer container
        // This is intentionally fire-and-forget so it doesn't slow down enrichment
        audioQueued = await queueAudioAnalysis();

        // Log progress (only if work was done)
        if (artistsProcessed > 0 || tracksProcessed > 0 || audioQueued > 0) {
            const progress = await getEnrichmentProgress();
            console.log(`\n[Enrichment Progress]`);
            console.log(
                `   Artists: ${progress.artists.completed}/${progress.artists.total} (${progress.artists.progress}%)`
            );
            console.log(
                `   Track Tags: ${progress.trackTags.enriched}/${progress.trackTags.total} (${progress.trackTags.progress}%)`
            );
            console.log(
                `   Audio Analysis: ${progress.audioAnalysis.completed}/${progress.audioAnalysis.total} (${progress.audioAnalysis.progress}%) [background]`
            );
            console.log("");
        }
    } catch (error) {
        console.error("[Enrichment] Cycle error:", error);
    } finally {
        isRunning = false;
    }

    return { artists: artistsProcessed, tracks: tracksProcessed, audioQueued };
}

/**
 * Step 1: Enrich artist metadata
 */
async function enrichArtistsBatch(): Promise<number> {
    const artists = await prisma.artist.findMany({
        where: {
            OR: [
                { enrichmentStatus: "pending" },
                { enrichmentStatus: "failed" },
            ],
            albums: { some: {} },
        },
        orderBy: { name: "asc" },
        take: ARTIST_BATCH_SIZE,
    });

    if (artists.length === 0) return 0;

    console.log(`[Artists] Processing ${artists.length} artists...`);

    await Promise.allSettled(
        artists.map(async (artist) => {
            try {
                await enrichSimilarArtist(artist);
                console.log(`   ✓ ${artist.name}`);
            } catch (error) {
                console.error(`   ✗ ${artist.name}:`, error);
            }
        })
    );

    return artists.length;
}

/**
 * Step 2: Enrich track mood tags from Last.fm
 * Note: No longer waits for artist enrichment - runs in parallel
 */
async function enrichTrackTagsBatch(): Promise<number> {
    // Note: Nested orderBy on relations doesn't work with isEmpty filtering in Prisma
    // Track tag enrichment doesn't depend on artist enrichment status, so we just order by recency
    // Use raw SQL to properly match NULL, empty array, or isEmpty
    // Prisma's array filters don't handle NULL correctly
    const tracks = await prisma.$queryRaw<
        Array<{ id: string; title: string; albumId: string }>
    >`
        SELECT t.id, t.title, t."albumId"
        FROM "Track" t
        WHERE t."lastfmTags" IS NULL
           OR t."lastfmTags" = '{}'
           OR array_length(t."lastfmTags", 1) IS NULL
        ORDER BY t."fileModified" DESC
        LIMIT ${TRACK_BATCH_SIZE}
    `;

    if (tracks.length === 0) return 0;

    // Fetch full track data with relations for the IDs we found
    const fullTracks = await prisma.track.findMany({
        where: { id: { in: tracks.map((t) => t.id) } },
        include: {
            album: {
                include: {
                    artist: { select: { name: true } },
                },
            },
        },
    });

    console.log(`[Track Tags] Processing ${fullTracks.length} tracks...`);

    for (const track of fullTracks) {
        try {
            const artistName = track.album.artist.name;
            const trackInfo = await lastFmService.getTrackInfo(
                artistName,
                track.title
            );

            if (trackInfo?.toptags?.tag) {
                const allTags = trackInfo.toptags.tag.map((t: any) => t.name);
                const moodTags = filterMoodTags(allTags);

                await prisma.track.update({
                    where: { id: track.id },
                    data: {
                        lastfmTags:
                            moodTags.length > 0 ? moodTags : ["_no_mood_tags"],
                    },
                });

                if (moodTags.length > 0) {
                    console.log(
                        `   ✓ ${track.title}: [${moodTags
                            .slice(0, 3)
                            .join(", ")}...]`
                    );
                }
            } else {
                await prisma.track.update({
                    where: { id: track.id },
                    data: { lastfmTags: ["_not_found"] },
                });
            }

            // Rate limit
            await new Promise((resolve) => setTimeout(resolve, 200));
        } catch (error: any) {
            console.error(`   ✗ ${track.title}: ${error?.message || error}`);
        }
    }

    return fullTracks.length;
}

/**
 * Step 3: Queue pending tracks for audio analysis (Essentia)
 */
async function queueAudioAnalysis(): Promise<number> {
    // Find tracks that need audio analysis
    // All tracks should have filePath, so no null check needed
    const tracks = await prisma.track.findMany({
        where: {
            analysisStatus: "pending",
        },
        select: {
            id: true,
            filePath: true,
            title: true,
        },
        take: 50, // Queue more at once since Essentia processes async
        orderBy: { fileModified: "desc" },
    });

    if (tracks.length === 0) return 0;

    console.log(
        `[Audio Analysis] Queueing ${tracks.length} tracks for Essentia...`
    );

    const redis = getRedis();
    let queued = 0;

    for (const track of tracks) {
        try {
            // Queue for the Python audio analyzer
            await redis.rpush(
                "audio:analysis:queue",
                JSON.stringify({
                    trackId: track.id,
                    filePath: track.filePath,
                })
            );

            // Mark as queued (processing)
            await prisma.track.update({
                where: { id: track.id },
                data: { analysisStatus: "processing" },
            });

            queued++;
        } catch (error) {
            console.error(`   Failed to queue ${track.title}:`, error);
        }
    }

    if (queued > 0) {
        console.log(`   ✓ Queued ${queued} tracks for audio analysis`);
    }

    return queued;
}

/**
 * Get comprehensive enrichment progress
 *
 * Returns separate progress for:
 * - Artists & Track Tags: "Core" enrichment (must complete before app is fully usable)
 * - Audio Analysis: "Background" enrichment (runs in separate container, non-blocking)
 */
export async function getEnrichmentProgress() {
    // Artist progress
    const artistCounts = await prisma.artist.groupBy({
        by: ["enrichmentStatus"],
        _count: true,
    });

    const artistTotal = artistCounts.reduce((sum, s) => sum + s._count, 0);
    const artistCompleted =
        artistCounts.find((s) => s.enrichmentStatus === "completed")?._count ||
        0;
    const artistPending =
        artistCounts.find((s) => s.enrichmentStatus === "pending")?._count || 0;

    // Track tag progress
    const trackTotal = await prisma.track.count();
    const trackTagsEnriched = await prisma.track.count({
        where: { NOT: { lastfmTags: { equals: [] } } },
    });

    // Audio analysis progress (background task)
    const audioCompleted = await prisma.track.count({
        where: { analysisStatus: "completed" },
    });
    const audioPending = await prisma.track.count({
        where: { analysisStatus: "pending" },
    });
    const audioProcessing = await prisma.track.count({
        where: { analysisStatus: "processing" },
    });
    const audioFailed = await prisma.track.count({
        where: { analysisStatus: "failed" },
    });

    // Core enrichment is complete when artists and track tags are done
    // Audio analysis is separate - it runs in background and doesn't block
    const coreComplete =
        artistPending === 0 && trackTotal - trackTagsEnriched === 0;

    return {
        // Core enrichment (blocking)
        artists: {
            total: artistTotal,
            completed: artistCompleted,
            pending: artistPending,
            failed:
                artistCounts.find((s) => s.enrichmentStatus === "failed")
                    ?._count || 0,
            progress:
                artistTotal > 0
                    ? Math.round((artistCompleted / artistTotal) * 100)
                    : 0,
        },
        trackTags: {
            total: trackTotal,
            enriched: trackTagsEnriched,
            pending: trackTotal - trackTagsEnriched,
            progress:
                trackTotal > 0
                    ? Math.round((trackTagsEnriched / trackTotal) * 100)
                    : 0,
        },

        // Background enrichment (non-blocking, runs in audio-analyzer container)
        audioAnalysis: {
            total: trackTotal,
            completed: audioCompleted,
            pending: audioPending,
            processing: audioProcessing,
            failed: audioFailed,
            progress:
                trackTotal > 0
                    ? Math.round((audioCompleted / trackTotal) * 100)
                    : 0,
            isBackground: true, // Flag to indicate this runs separately
        },

        // Overall status
        coreComplete, // True when artists + track tags are done
        isFullyComplete:
            coreComplete && audioPending === 0 && audioProcessing === 0,
    };
}

/**
 * Trigger enrichment for a specific artist (used after new album added)
 */
export async function enrichArtistNow(artistId: string) {
    const artist = await prisma.artist.findUnique({
        where: { id: artistId },
    });

    if (!artist) return;

    console.log(`[Enrichment] Enriching artist: ${artist.name}`);
    await enrichSimilarArtist(artist);
}

/**
 * Trigger enrichment for a specific album's tracks
 */
/**
 * Trigger an immediate enrichment cycle (non-blocking)
 * Used when new tracks are added and we want to collect mood tags right away
 * instead of waiting for the 30s background interval
 */
export async function triggerEnrichmentNow(): Promise<{
    artists: number;
    tracks: number;
    audioQueued: number;
}> {
    console.log("[Enrichment] Triggering immediate enrichment cycle...");
    return runEnrichmentCycle(false);
}

export async function enrichAlbumTracksNow(albumId: string) {
    const tracks = await prisma.track.findMany({
        where: { albumId },
        include: {
            album: {
                include: {
                    artist: { select: { name: true } },
                },
            },
        },
    });

    console.log(
        `[Enrichment] Enriching ${tracks.length} tracks for album ${albumId}`
    );

    for (const track of tracks) {
        try {
            const trackInfo = await lastFmService.getTrackInfo(
                track.album.artist.name,
                track.title
            );

            if (trackInfo?.toptags?.tag) {
                const allTags = trackInfo.toptags.tag.map((t: any) => t.name);
                const moodTags = filterMoodTags(allTags);

                await prisma.track.update({
                    where: { id: track.id },
                    data: {
                        lastfmTags:
                            moodTags.length > 0 ? moodTags : ["_no_mood_tags"],
                        analysisStatus: "pending", // Queue for audio analysis
                    },
                });
            }

            await new Promise((resolve) => setTimeout(resolve, 200));
        } catch (error) {
            console.error(`Failed to enrich track ${track.title}:`, error);
        }
    }
}
