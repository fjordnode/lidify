import { Router } from "express";
import { requireAuthOrToken } from "../middleware/auth";
import { z } from "zod";
import { spotifyService } from "../services/spotify";
import { spotifyImportService } from "../services/spotifyImport";
import { deezerService } from "../services/deezer";
import { youtubeMusicService } from "../services/youtube-music";
import { readSessionLog, getSessionLogPath } from "../utils/playlistLogger";

const router = Router();

// All routes require authentication
router.use(requireAuthOrToken);

// Validation schemas
const parseUrlSchema = z.object({
    url: z.string().url(),
});

const importSchema = z.object({
    spotifyPlaylistId: z.string(),
    url: z.string().url().optional(),
    playlistName: z.string().min(1).max(200),
    // Track-only playlist imports (Soulseek). Keep flexible for backwards compatibility.
    preview: z.any().optional(),
    // If true, just save playlist without downloading missing tracks
    skipDownload: z.boolean().optional(),
});

/**
 * POST /api/spotify/parse
 * Parse a Spotify URL and return basic info
 */
router.post("/parse", async (req, res) => {
    try {
        const { url } = parseUrlSchema.parse(req.body);

        const parsed = spotifyService.parseUrl(url);
        if (!parsed) {
            return res.status(400).json({
                error: "Invalid Spotify URL. Please provide a valid playlist URL.",
            });
        }

        // For now, only support playlists
        if (parsed.type !== "playlist") {
            return res.status(400).json({
                error: `Only playlist imports are supported. Got: ${parsed.type}`,
            });
        }

        res.json({
            type: parsed.type,
            id: parsed.id,
            url: `https://open.spotify.com/playlist/${parsed.id}`,
        });
    } catch (error: any) {
        console.error("Spotify parse error:", error);
        if (error.name === "ZodError") {
            return res.status(400).json({ error: "Invalid request body" });
        }
        res.status(500).json({ error: error.message || "Failed to parse URL" });
    }
});

/**
 * POST /api/spotify/preview
 * Generate a preview of what will be imported from a Spotify or Deezer playlist
 */
router.post("/preview", async (req, res) => {
    try {
        const { url } = parseUrlSchema.parse(req.body);

        console.log(`[Playlist Import] Generating preview for: ${url}`);

        // Detect if it's a Deezer URL
        if (url.includes("deezer.com")) {
            // Extract playlist ID from Deezer URL
            const deezerMatch = url.match(/playlist[\/:](\d+)/);
            if (!deezerMatch) {
                return res
                    .status(400)
                    .json({ error: "Invalid Deezer playlist URL" });
            }

            const playlistId = deezerMatch[1];
            const deezerPlaylist = await deezerService.getPlaylist(playlistId);

            if (!deezerPlaylist) {
                return res
                    .status(404)
                    .json({ error: "Deezer playlist not found" });
            }

            // Convert Deezer format to Spotify Import format
            const preview =
                await spotifyImportService.generatePreviewFromDeezer(
                    deezerPlaylist
                );

            console.log(
                `[Playlist Import] Deezer preview generated: ${preview.summary.total} tracks, ${preview.summary.inLibrary} in library`
            );
            res.json(preview);
        } else if (youtubeMusicService.parseUrl(url)?.type === "playlist") {
            // Handle YouTube Music URL
            const parsed = youtubeMusicService.parseUrl(url);
            if (!parsed) {
                return res
                    .status(400)
                    .json({ error: "Invalid YouTube Music playlist URL" });
            }

            const ytPlaylist = await youtubeMusicService.getPlaylist(parsed.id);
            if (!ytPlaylist) {
                return res
                    .status(404)
                    .json({ error: "YouTube Music playlist not found" });
            }

            const preview =
                await spotifyImportService.generatePreviewFromYouTube(ytPlaylist);

            console.log(
                `[Playlist Import] YouTube Music preview generated: ${preview.summary.total} tracks, ${preview.summary.inLibrary} in library`
            );
            res.json(preview);
        } else {
            // Handle Spotify URL
            const preview = await spotifyImportService.generatePreview(url);

            console.log(
                `[Spotify Import] Preview generated: ${preview.summary.total} tracks, ${preview.summary.inLibrary} in library`
            );
            res.json(preview);
        }
    } catch (error: any) {
        console.error("Playlist preview error:", error);
        if (error.name === "ZodError") {
            return res.status(400).json({ error: "Invalid request body" });
        }
        res.status(500).json({
            error: error.message || "Failed to generate preview",
        });
    }
});

/**
 * POST /api/spotify/import
 * Start importing a Spotify playlist
 */
router.post("/import", async (req, res) => {
    try {
        const { spotifyPlaylistId, url, playlistName, preview, skipDownload } =
            importSchema.parse(req.body);
        const userId = req.user!.id;

        // Prefer client-provided preview (fast, avoids double-fetching and avoids long work in this request)
        let effectivePreview = preview as any;
        if (!effectivePreview) {
            const effectiveUrl =
                url?.trim() ||
                `https://open.spotify.com/playlist/${spotifyPlaylistId}`;

            if (effectiveUrl.includes("deezer.com")) {
                const deezerMatch = effectiveUrl.match(/playlist[\/:](\d+)/);
                if (!deezerMatch) {
                    return res
                        .status(400)
                        .json({ error: "Invalid Deezer playlist URL" });
                }
                const playlistId = deezerMatch[1];
                const deezerPlaylist = await deezerService.getPlaylist(playlistId);
                if (!deezerPlaylist) {
                    return res
                        .status(404)
                        .json({ error: "Deezer playlist not found" });
                }
                effectivePreview =
                    await spotifyImportService.generatePreviewFromDeezer(
                        deezerPlaylist
                    );
            } else if (youtubeMusicService.parseUrl(effectiveUrl)?.type === "playlist") {
                const parsed = youtubeMusicService.parseUrl(effectiveUrl);
                if (!parsed) {
                    return res
                        .status(400)
                        .json({ error: "Invalid YouTube Music playlist URL" });
                }
                const ytPlaylist = await youtubeMusicService.getPlaylist(parsed.id);
                if (!ytPlaylist) {
                    return res
                        .status(404)
                        .json({ error: "YouTube Music playlist not found" });
                }
                effectivePreview =
                    await spotifyImportService.generatePreviewFromYouTube(ytPlaylist);
            } else {
                effectivePreview =
                    await spotifyImportService.generatePreview(effectiveUrl);
            }
        }

        console.log(
            `[Spotify Import] Starting import for user ${userId}: ${playlistName}${skipDownload ? " (save only, no download)" : ""}`
        );

        const job = await spotifyImportService.startImport(
            userId,
            spotifyPlaylistId,
            playlistName,
            effectivePreview,
            skipDownload
        );

        res.json({
            jobId: job.id,
            status: job.status,
            message: "Import started",
        });
    } catch (error: any) {
        console.error("Spotify import error:", error);
        if (error.name === "ZodError") {
            return res.status(400).json({ error: "Invalid request body" });
        }
        res.status(500).json({
            error: error.message || "Failed to start import",
        });
    }
});

/**
 * GET /api/spotify/import/:jobId/status
 * Get the status of an import job
 */
router.get("/import/:jobId/status", async (req, res) => {
    try {
        const { jobId } = req.params;
        const userId = req.user!.id;

        const job = await spotifyImportService.getJob(jobId);
        if (!job) {
            return res.status(404).json({ error: "Import job not found" });
        }

        // Ensure user owns this job
        if (job.userId !== userId) {
            return res
                .status(403)
                .json({ error: "Not authorized to view this job" });
        }

        res.json(job);
    } catch (error: any) {
        console.error("Spotify job status error:", error);
        res.status(500).json({
            error: error.message || "Failed to get job status",
        });
    }
});

/**
 * GET /api/spotify/imports
 * Get all import jobs for the current user
 */
router.get("/imports", async (req, res) => {
    try {
        const userId = req.user!.id;
        const jobs = await spotifyImportService.getUserJobs(userId);
        res.json(jobs);
    } catch (error: any) {
        console.error("Spotify imports error:", error);
        res.status(500).json({
            error: error.message || "Failed to get imports",
        });
    }
});

/**
 * POST /api/spotify/import/:jobId/refresh
 * Re-match pending tracks and add newly downloaded ones to the playlist
 */
router.post("/import/:jobId/refresh", async (req, res) => {
    try {
        const { jobId } = req.params;
        const userId = req.user!.id;

        const job = await spotifyImportService.getJob(jobId);
        if (!job) {
            return res.status(404).json({ error: "Import job not found" });
        }

        // Ensure user owns this job
        if (job.userId !== userId) {
            return res
                .status(403)
                .json({ error: "Not authorized to refresh this job" });
        }

        const result = await spotifyImportService.refreshJobMatches(jobId);

        res.json({
            message:
                result.added > 0
                    ? `Added ${result.added} newly downloaded track(s)`
                    : "No new tracks found yet. Albums may still be downloading.",
            added: result.added,
            total: result.total,
        });
    } catch (error: any) {
        console.error("Spotify refresh error:", error);
        res.status(500).json({
            error: error.message || "Failed to refresh tracks",
        });
    }
});

/**
 * POST /api/spotify/import/:jobId/repair
 * Rebuild missing playlist items from the original import tracklist.
 */
router.post("/import/:jobId/repair", async (req, res) => {
    try {
        const { jobId } = req.params;
        const userId = req.user!.id;

        const job = await spotifyImportService.getJob(jobId);
        if (!job) {
            return res.status(404).json({ error: "Import job not found" });
        }

        if (job.userId !== userId) {
            return res
                .status(403)
                .json({ error: "Not authorized to repair this job" });
        }

        const result = await spotifyImportService.repairPlaylist(jobId);

        res.json({
            message: `Repaired playlist: added ${result.added} track(s), removed ${result.pendingRemoved} pending entr${
                result.pendingRemoved === 1 ? "y" : "ies"
            }`,
            added: result.added,
            pendingRemoved: result.pendingRemoved,
        });
    } catch (error: any) {
        console.error("Spotify repair error:", error);
        res.status(500).json({
            error: error.message || "Failed to repair playlist",
        });
    }
});

/**
 * POST /api/spotify/import/:jobId/cancel
 * Cancel an import job and create playlist with whatever succeeded
 */
router.post("/import/:jobId/cancel", async (req, res) => {
    try {
        const { jobId } = req.params;
        const userId = req.user!.id;

        const job = await spotifyImportService.getJob(jobId);
        if (!job) {
            return res.status(404).json({ error: "Import job not found" });
        }

        // Ensure user owns this job
        if (job.userId !== userId) {
            return res
                .status(403)
                .json({ error: "Not authorized to cancel this job" });
        }

        const result = await spotifyImportService.cancelJob(jobId);

        res.json({
            message: result.playlistCreated
                ? `Import cancelled. Playlist created with ${result.tracksMatched} track(s).`
                : "Import cancelled. No tracks were downloaded.",
            playlistId: result.playlistId,
            tracksMatched: result.tracksMatched,
        });
    } catch (error: any) {
        console.error("Spotify cancel error:", error);
        res.status(500).json({
            error: error.message || "Failed to cancel import",
        });
    }
});

/**
 * GET /api/spotify/import/session-log
 * Get the current session log for debugging import issues
 */
router.get("/import/session-log", async (req, res) => {
    try {
        const log = readSessionLog();
        const logPath = getSessionLogPath();

        res.json({
            path: logPath,
            content: log,
        });
    } catch (error: any) {
        console.error("Session log error:", error);
        res.status(500).json({
            error: error.message || "Failed to read session log",
        });
    }
});

export default router;
