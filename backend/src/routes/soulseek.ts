/**
 * Soulseek routes - Direct connection via soulseek-ts
 * Simplified API for status and manual search/download
 */

import { Router } from "express";
import path from "path";
import { requireAuth } from "../middleware/auth";
import { soulseekService } from "../services/soulseek";
import { getSystemSettings } from "../utils/systemSettings";
import { scanQueue } from "../workers/queues";

const router = Router();

const audioExtensions = new Set([
    ".flac",
    ".mp3",
    ".m4a",
    ".ogg",
    ".opus",
    ".wav",
    ".aac",
]);

function parseArtistAlbum(filePath: string): { artist?: string; album?: string } {
    const parts = filePath.split(/[/\\]+/).filter(Boolean);
    if (parts.length < 2) {
        return {};
    }
    const album = parts[parts.length - 2];
    const artist = parts[parts.length - 3];
    return {
        artist: artist || undefined,
        album: album || undefined,
    };
}

function sanitizeFolderName(name: string): string {
    return name.replace(/[<>:"/\\|?*]/g, "_").trim();
}

// Middleware to check if Soulseek credentials are configured
async function requireSoulseekConfigured(req: any, res: any, next: any) {
    try {
        const available = await soulseekService.isAvailable();

        if (!available) {
            return res.status(403).json({
                error: "Soulseek credentials not configured. Add username/password in System Settings.",
            });
        }

        next();
    } catch (error) {
        console.error("Error checking Soulseek settings:", error);
        res.status(500).json({ error: "Failed to check settings" });
    }
}

/**
 * GET /soulseek/status
 * Check connection status
 */
router.get("/status", requireAuth, async (req, res) => {
    try {
        const available = await soulseekService.isAvailable();

        if (!available) {
            return res.json({
                enabled: false,
                connected: false,
                message: "Soulseek credentials not configured",
            });
        }

        const status = await soulseekService.getStatus();

        res.json({
            enabled: true,
            connected: status.connected,
            username: status.username,
        });
    } catch (error: any) {
        console.error("Soulseek status error:", error.message);
        res.status(500).json({
            error: "Failed to get Soulseek status",
            details: error.message,
        });
    }
});

/**
 * POST /soulseek/connect
 * Manually trigger connection to Soulseek network
 */
router.post("/connect", requireAuth, requireSoulseekConfigured, async (req, res) => {
    try {
        await soulseekService.connect();

        res.json({
            success: true,
            message: "Connected to Soulseek network",
        });
    } catch (error: any) {
        console.error("Soulseek connect error:", error.message);
        res.status(500).json({
            error: "Failed to connect to Soulseek",
            details: error.message,
        });
    }
});

/**
 * POST /soulseek/search
 * Search for a track
 */
router.post("/search", requireAuth, requireSoulseekConfigured, async (req, res) => {
    try {
        const { artist, title } = req.body;

        if (!artist || !title) {
            return res.status(400).json({
                error: "Artist and title are required",
            });
        }

        console.log(`[Soulseek] Searching: "${artist} - ${title}"`);

        const result = await soulseekService.searchTrack(artist, title);

        if (result.found && result.bestMatch) {
            res.json({
                found: true,
                match: {
                    user: result.bestMatch.username,
                    filename: result.bestMatch.filename,
                    size: result.bestMatch.size,
                    quality: result.bestMatch.quality,
                    score: result.bestMatch.score,
                },
            });
        } else {
            res.json({
                found: false,
                message: "No suitable matches found",
            });
        }
    } catch (error: any) {
        console.error("Soulseek search error:", error.message);
        res.status(500).json({
            error: "Search failed",
            details: error.message,
        });
    }
});

/**
 * POST /soulseek/search-query
 * Search by free-form query (for UI search results)
 */
router.post(
    "/search-query",
    requireAuth,
    requireSoulseekConfigured,
    async (req, res) => {
        try {
            const { query } = req.body;
            if (!query || typeof query !== "string") {
                return res.status(400).json({
                    error: "Query is required",
                });
            }

            const results = await soulseekService.searchQuery(query);

            const audioFiles = results
                .filter((r) => {
                    const ext = (r.file || "").toLowerCase();
                    return Array.from(audioExtensions).some((e) =>
                        ext.endsWith(e)
                    );
                })
                .slice(0, 50)
                .map((r) => {
                    const filename = r.file?.split(/[/\\]/).pop() || r.file;
                    const ext = filename
                        ? filename.split(".").pop()?.toLowerCase() || "unknown"
                        : "unknown";
                    const parsed = parseArtistAlbum(r.file || "");
                    return {
                        username: r.user,
                        path: r.file,
                        filename: filename || r.file,
                        size: r.size || 0,
                        bitrate: r.bitrate || 0,
                        format: ext,
                        parsedArtist: parsed.artist,
                        parsedAlbum: parsed.album,
                    };
                });

            res.json({
                results: audioFiles,
                count: audioFiles.length,
            });
        } catch (error: any) {
            console.error("Soulseek search query error:", error.message);
            res.status(500).json({
                error: "Search failed",
                details: error.message,
            });
        }
    }
);

/**
 * POST /soulseek/download
 * Download a track directly
 */
router.post("/download", requireAuth, requireSoulseekConfigured, async (req, res) => {
    try {
        const { artist, title, album } = req.body;

        if (!artist || !title) {
            return res.status(400).json({
                error: "Artist and title are required",
            });
        }

        const settings = await getSystemSettings();
        const musicPath = settings?.musicPath;

        if (!musicPath) {
            return res.status(400).json({
                error: "Music path not configured",
            });
        }

        console.log(`[Soulseek] Downloading: "${artist} - ${title}"`);

        const result = await soulseekService.searchAndDownload(
            artist,
            title,
            album || "Unknown Album",
            musicPath
        );

        if (result.success) {
            res.json({
                success: true,
                filePath: result.filePath,
            });
        } else {
            res.status(404).json({
                success: false,
                error: result.error || "Download failed",
            });
        }
    } catch (error: any) {
        console.error("Soulseek download error:", error.message);
        res.status(500).json({
            error: "Download failed",
            details: error.message,
        });
    }
});

/**
 * POST /soulseek/download-file
 * Download a specific file from a user (uses path + username)
 */
router.post(
    "/download-file",
    requireAuth,
    requireSoulseekConfigured,
    async (req, res) => {
        try {
            const { username, filepath, filename, size, artist, album } =
                req.body;

            if (!username || !filepath) {
                return res.status(400).json({
                    error: "username and filepath are required",
                });
            }

            const settings = await getSystemSettings();
            const musicPath = settings?.musicPath;

            if (!musicPath) {
                return res.status(400).json({
                    error: "Music path not configured",
                });
            }

            const parsed = parseArtistAlbum(filepath);
            const artistName = artist || parsed.artist || "Unknown Artist";
            const albumName = album || parsed.album || "Unknown Album";
            const resolvedFilename =
                filename || filepath.split(/[/\\]/).pop() || filepath;
            const downloadBase = settings?.downloadPath || "/soulseek-downloads";
            // Use dedicated writable mount (main music library is read-only)
            const destPath = path.join(
                downloadBase,
                sanitizeFolderName(artistName),
                sanitizeFolderName(albumName),
                sanitizeFolderName(resolvedFilename)
            );

            const result = await soulseekService.downloadFile(
                username,
                filepath,
                destPath,
                size
            );

            if (result.success) {
                const albumScanPath = path.dirname(destPath);
                const scanJob = await scanQueue.add("scan", {
                    userId: req.user!.id,
                    musicPath: albumScanPath,
                    basePath: downloadBase,
                    source: "soulseek_direct",
                    playlistOnlyMode: false,
                });

                res.json({
                    success: true,
                    filePath: destPath,
                    scanJobId: scanJob.id,
                });
            } else {
                res.status(404).json({
                    success: false,
                    error: result.error || "Download failed",
                });
            }
        } catch (error: any) {
            console.error("Soulseek file download error:", error.message);
            res.status(500).json({
                error: "Download failed",
                details: error.message,
            });
        }
    }
);

/**
 * POST /soulseek/disconnect
 * Disconnect from Soulseek network
 */
router.post("/disconnect", requireAuth, async (req, res) => {
    try {
        soulseekService.disconnect();
        res.json({ success: true, message: "Disconnected" });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

export default router;
