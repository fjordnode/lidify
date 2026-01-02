import { Router } from "express";
import { requireAuth, requireAdmin } from "../middleware/auth";
import { enrichmentService } from "../services/enrichment";
import { getEnrichmentProgress, runFullEnrichment } from "../workers/unifiedEnrichment";
import { prisma } from "../utils/db";
import { musicBrainzService } from "../services/musicbrainz";
import { imageProviderService } from "../services/imageProvider";
import { coverArtService } from "../services/coverArt";

const router = Router();

router.use(requireAuth);

/**
 * GET /enrichment/progress
 * Get comprehensive enrichment progress (artists, track tags, audio analysis)
 */
router.get("/progress", async (req, res) => {
    try {
        const progress = await getEnrichmentProgress();
        res.json(progress);
    } catch (error) {
        console.error("Get enrichment progress error:", error);
        res.status(500).json({ error: "Failed to get progress" });
    }
});

/**
 * POST /enrichment/full
 * Trigger full enrichment (re-enriches everything regardless of status)
 * Admin only
 */
router.post("/full", requireAdmin, async (req, res) => {
    try {
        // This runs in the background
        runFullEnrichment().catch(err => {
            console.error("Full enrichment error:", err);
        });
        
        res.json({ 
            message: "Full enrichment started",
            description: "All artists, track tags, and audio analysis will be re-processed"
        });
    } catch (error) {
        console.error("Trigger full enrichment error:", error);
        res.status(500).json({ error: "Failed to start full enrichment" });
    }
});

/**
 * GET /enrichment/settings
 * Get enrichment settings for current user
 */
router.get("/settings", async (req, res) => {
    try {
        const userId = req.user!.id;
        const settings = await enrichmentService.getSettings(userId);
        res.json(settings);
    } catch (error) {
        console.error("Get enrichment settings error:", error);
        res.status(500).json({ error: "Failed to get settings" });
    }
});

/**
 * PUT /enrichment/settings
 * Update enrichment settings for current user
 */
router.put("/settings", async (req, res) => {
    try {
        const userId = req.user!.id;
        const settings = await enrichmentService.updateSettings(userId, req.body);
        res.json(settings);
    } catch (error) {
        console.error("Update enrichment settings error:", error);
        res.status(500).json({ error: "Failed to update settings" });
    }
});

/**
 * POST /enrichment/artist/:id
 * Enrich a single artist
 */
router.post("/artist/:id", async (req, res) => {
    try {
        const userId = req.user!.id;
        const settings = await enrichmentService.getSettings(userId);

        if (!settings.enabled) {
            return res.status(400).json({ error: "Enrichment is not enabled" });
        }

        const enrichmentData = await enrichmentService.enrichArtist(req.params.id, settings);

        if (!enrichmentData) {
            return res.status(404).json({ error: "No enrichment data found" });
        }

        if (enrichmentData.confidence > 0.3) {
            await enrichmentService.applyArtistEnrichment(req.params.id, enrichmentData);
        }

        res.json({
            success: true,
            confidence: enrichmentData.confidence,
            data: enrichmentData,
        });
    } catch (error: any) {
        console.error("Enrich artist error:", error);
        res.status(500).json({ error: error.message || "Failed to enrich artist" });
    }
});

/**
 * POST /enrichment/album/:id
 * Enrich a single album
 */
router.post("/album/:id", async (req, res) => {
    try {
        const userId = req.user!.id;
        const settings = await enrichmentService.getSettings(userId);

        if (!settings.enabled) {
            return res.status(400).json({ error: "Enrichment is not enabled" });
        }

        const enrichmentData = await enrichmentService.enrichAlbum(req.params.id, settings);

        if (!enrichmentData) {
            return res.status(404).json({ error: "No enrichment data found" });
        }

        if (enrichmentData.confidence > 0.3) {
            await enrichmentService.applyAlbumEnrichment(req.params.id, enrichmentData);
        }

        res.json({
            success: true,
            confidence: enrichmentData.confidence,
            data: enrichmentData,
        });
    } catch (error: any) {
        console.error("Enrich album error:", error);
        res.status(500).json({ error: error.message || "Failed to enrich album" });
    }
});

/**
 * POST /enrichment/start
 * Start library-wide enrichment (runs in background)
 */
router.post("/start", async (req, res) => {
    try {
        const userId = req.user!.id;
        const { notificationService } = await import("../services/notificationService");

        // Check if enrichment is enabled in system settings
        const { prisma } = await import("../utils/db");
        const systemSettings = await prisma.systemSettings.findUnique({
            where: { id: "default" },
            select: { autoEnrichMetadata: true },
        });

        if (!systemSettings?.autoEnrichMetadata) {
            return res.status(400).json({ error: "Enrichment is not enabled. Enable it in settings first." });
        }

        // Get user enrichment settings or use defaults
        const settings = await enrichmentService.getSettings(userId);

        // Override enabled flag with system setting
        settings.enabled = true;

        // Send notification that enrichment is starting
        await notificationService.notifySystem(
            userId,
            "Library Enrichment Started",
            "Enriching artist metadata in the background..."
        );

        // Start enrichment in background
        enrichmentService.enrichLibrary(userId).then(async () => {
            // Send notification when complete
            await notificationService.notifySystem(
                userId,
                "Library Enrichment Complete",
                "All artist metadata has been enriched"
            );
        }).catch(async (error) => {
            console.error("Background enrichment failed:", error);
            await notificationService.create({
                userId,
                type: "error",
                title: "Enrichment Failed",
                message: error.message || "Failed to enrich library metadata",
            });
        });

        res.json({
            success: true,
            message: "Library enrichment started in background",
        });
    } catch (error: any) {
        console.error("Start enrichment error:", error);
        res.status(500).json({ error: error.message || "Failed to start enrichment" });
    }
});

/**
 * PUT /library/artists/:id/metadata
 * Update artist metadata manually
 */
router.put("/artists/:id/metadata", async (req, res) => {
    try {
        const { name, bio, genres, mbid, heroUrl } = req.body;

        const updateData: any = {};
        if (name) updateData.name = name;
        if (bio) updateData.summary = bio;
        if (mbid) updateData.mbid = mbid;
        if (heroUrl) updateData.heroUrl = heroUrl;
        if (genres) updateData.manualGenres = JSON.stringify(genres);

        // Mark as manually edited
        updateData.manuallyEdited = true;

        const { prisma } = await import("../utils/db");
        const artist = await prisma.artist.update({
            where: { id: req.params.id },
            data: updateData,
            include: {
                albums: {
                    select: {
                        id: true,
                        title: true,
                        year: true,
                        coverUrl: true,
                    },
                },
            },
        });

        res.json(artist);
    } catch (error: any) {
        console.error("Update artist metadata error:", error);
        res.status(500).json({ error: error.message || "Failed to update artist" });
    }
});

/**
 * PUT /library/albums/:id/metadata
 * Update album metadata manually
 */
router.put("/albums/:id/metadata", async (req, res) => {
    try {
        const { title, year, genres, rgMbid, coverUrl } = req.body;

        const updateData: any = {};
        if (title) updateData.title = title;
        if (year) updateData.year = parseInt(year);
        if (rgMbid) updateData.rgMbid = rgMbid;
        if (coverUrl) updateData.coverUrl = coverUrl;
        if (genres) updateData.manualGenres = JSON.stringify(genres);

        // Mark as manually edited
        updateData.manuallyEdited = true;

        const { prisma } = await import("../utils/db");
        const album = await prisma.album.update({
            where: { id: req.params.id },
            data: updateData,
            include: {
                artist: {
                    select: {
                        id: true,
                        name: true,
                    },
                },
                tracks: {
                    select: {
                        id: true,
                        title: true,
                        trackNo: true,
                        duration: true,
                    },
                },
            },
        });

        res.json(album);
    } catch (error: any) {
        console.error("Update album metadata error:", error);
        res.status(500).json({ error: error.message || "Failed to update album" });
    }
});

/**
 * POST /enrichment/repair/album-mbids
 * Repair albums with temp MBIDs by looking up correct MBIDs from MusicBrainz
 * Admin only - runs in background
 */
router.post("/repair/album-mbids", requireAdmin, async (req, res) => {
    try {
        // Return immediately, run in background
        res.json({
            message: "Album MBID repair started",
            description: "Albums with temp MBIDs will be matched against MusicBrainz"
        });

        // Run repair in background
        repairAlbumMbids().catch(err => {
            console.error("[REPAIR] Album MBID repair failed:", err);
        });
    } catch (error) {
        console.error("Start album MBID repair error:", error);
        res.status(500).json({ error: "Failed to start repair" });
    }
});

/**
 * POST /enrichment/repair/album-covers
 * Repair albums missing cover art using Deezer/CAA fallback
 * Admin only - runs in background
 */
router.post("/repair/album-covers", requireAdmin, async (req, res) => {
    try {
        // Return immediately, run in background
        res.json({
            message: "Album cover repair started",
            description: "Albums without covers will be fetched from Deezer/CAA"
        });

        // Run repair in background
        repairAlbumCovers().catch(err => {
            console.error("[REPAIR] Album cover repair failed:", err);
        });
    } catch (error) {
        console.error("Start album cover repair error:", error);
        res.status(500).json({ error: "Failed to start repair" });
    }
});

/**
 * GET /enrichment/repair/status
 * Get counts of albums needing repair
 */
router.get("/repair/status", async (req, res) => {
    try {
        const [tempMbidCount, noCoverCount, totalAlbums] = await Promise.all([
            prisma.album.count({ where: { rgMbid: { startsWith: "temp-" } } }),
            prisma.album.count({ where: { OR: [{ coverUrl: null }, { coverUrl: "" }] } }),
            prisma.album.count(),
        ]);

        res.json({
            totalAlbums,
            tempMbidCount,
            noCoverCount,
            healthyCount: totalAlbums - Math.max(tempMbidCount, noCoverCount),
        });
    } catch (error) {
        console.error("Get repair status error:", error);
        res.status(500).json({ error: "Failed to get repair status" });
    }
});

/**
 * Background job: Repair album MBIDs
 */
async function repairAlbumMbids(): Promise<void> {
    console.log("[REPAIR] Starting album MBID repair...");

    // Find albums with temp MBIDs where artist has valid MBID
    const albumsToRepair = await prisma.album.findMany({
        where: {
            rgMbid: { startsWith: "temp-" },
            artist: {
                mbid: { not: { startsWith: "temp-" } },
            },
        },
        select: {
            id: true,
            title: true,
            rgMbid: true,
            artist: { select: { mbid: true, name: true } },
        },
    });

    console.log(`[REPAIR] Found ${albumsToRepair.length} albums with temp MBIDs to repair`);

    let repaired = 0;
    let failed = 0;

    // Process in batches of 10 (MusicBrainz rate limit)
    for (let i = 0; i < albumsToRepair.length; i += 10) {
        const batch = albumsToRepair.slice(i, i + 10);

        for (const album of batch) {
            try {
                // Get artist's release groups from MusicBrainz
                const releaseGroups = await musicBrainzService.getReleaseGroups(
                    album.artist.mbid!,
                    ["album", "ep", "single"],
                    100
                );

                // Try to match by title (case-insensitive, normalized)
                const normalizedTitle = album.title.toLowerCase().replace(/[^a-z0-9]/g, "");
                const match = releaseGroups.find((rg: any) => {
                    const rgNormalized = rg.title.toLowerCase().replace(/[^a-z0-9]/g, "");
                    return rgNormalized === normalizedTitle ||
                           rg.title.toLowerCase() === album.title.toLowerCase();
                });

                if (match) {
                    await prisma.album.update({
                        where: { id: album.id },
                        data: { rgMbid: match.id },
                    });
                    console.log(`[REPAIR] ✓ ${album.artist.name} - ${album.title} → ${match.id}`);
                    repaired++;
                } else {
                    console.log(`[REPAIR] ✗ No match for: ${album.artist.name} - ${album.title}`);
                    failed++;
                }
            } catch (err) {
                console.error(`[REPAIR] Error repairing ${album.title}:`, err);
                failed++;
            }
        }

        // Rate limit: 1 request per second for MusicBrainz
        if (i + 10 < albumsToRepair.length) {
            await new Promise(resolve => setTimeout(resolve, 1100));
        }
    }

    console.log(`[REPAIR] Album MBID repair complete: ${repaired} repaired, ${failed} failed`);
}

/**
 * Background job: Repair album covers
 */
async function repairAlbumCovers(): Promise<void> {
    console.log("[REPAIR] Starting album cover repair...");

    // Find albums without covers
    const albumsToRepair = await prisma.album.findMany({
        where: {
            OR: [{ coverUrl: null }, { coverUrl: "" }],
        },
        select: {
            id: true,
            title: true,
            rgMbid: true,
            artist: { select: { name: true } },
        },
    });

    console.log(`[REPAIR] Found ${albumsToRepair.length} albums without covers`);

    let repaired = 0;
    let failed = 0;

    // Process in batches of 5
    for (let i = 0; i < albumsToRepair.length; i += 5) {
        const batch = albumsToRepair.slice(i, i + 5);

        await Promise.all(batch.map(async (album) => {
            try {
                let coverUrl: string | null = null;
                const hasValidMbid = album.rgMbid && !album.rgMbid.startsWith("temp-");

                // Try CAA first for valid MBIDs
                if (hasValidMbid) {
                    coverUrl = await coverArtService.getCoverArt(album.rgMbid);
                }

                // Fallback to Deezer/other providers
                if (!coverUrl) {
                    const result = await imageProviderService.getAlbumCover(
                        album.artist.name,
                        album.title,
                        hasValidMbid ? album.rgMbid : undefined
                    );
                    if (result) {
                        coverUrl = result.url;
                    }
                }

                if (coverUrl) {
                    await prisma.album.update({
                        where: { id: album.id },
                        data: { coverUrl },
                    });
                    console.log(`[REPAIR] ✓ Cover found for: ${album.artist.name} - ${album.title}`);
                    repaired++;
                } else {
                    console.log(`[REPAIR] ✗ No cover for: ${album.artist.name} - ${album.title}`);
                    failed++;
                }
            } catch (err) {
                console.error(`[REPAIR] Error fetching cover for ${album.title}:`, err);
                failed++;
            }
        }));

        // Small delay between batches
        if (i + 5 < albumsToRepair.length) {
            await new Promise(resolve => setTimeout(resolve, 500));
        }

        // Progress log every 50 albums
        if ((i + 5) % 50 === 0) {
            console.log(`[REPAIR] Progress: ${i + 5}/${albumsToRepair.length} processed`);
        }
    }

    console.log(`[REPAIR] Album cover repair complete: ${repaired} repaired, ${failed} failed`);
}

export default router;
