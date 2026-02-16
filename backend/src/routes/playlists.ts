import { Router } from "express";
import path from "path";
import PQueue from "p-queue";
import { requireAuthOrToken } from "../middleware/auth";
import { prisma } from "../utils/db";
import { z } from "zod";
import { sessionLog } from "../utils/playlistLogger";
import { youtubeMusicService } from "../services/youtube-music";
import { rewriteAudioTags } from "../utils/audioTags";

const router = Router();

router.use(requireAuthOrToken);

function sanitizePathPart(name: string): string {
    return (name || "").replace(/[<>:"/\\|?*]/g, "_").trim();
}

const createPlaylistSchema = z.object({
    name: z.string().min(1).max(200),
    isPublic: z.boolean().optional().default(false),
});

const addTrackSchema = z.object({
    trackId: z.string(),
});

// GET /playlists
router.get("/", async (req, res) => {
    try {
        const userId = req.user!.id;

        const playlists = await prisma.playlist.findMany({
            where: {
                OR: [{ userId }, { isPublic: true }],
            },
            orderBy: { createdAt: "desc" },
            include: {
                user: {
                    select: {
                        username: true,
                    },
                },
                items: {
                    include: {
                        track: {
                            include: {
                                album: {
                                    include: {
                                        artist: {
                                            select: {
                                                id: true,
                                                name: true,
                                            },
                                        },
                                    },
                                },
                            },
                        },
                    },
                    orderBy: { sort: "asc" },
                },
            },
        });

        const playlistsWithCounts = playlists.map((playlist) => ({
            ...playlist,
            trackCount: playlist.items.length,
            isOwner: playlist.userId === userId,
            // Map items to include coverArt (frontend expects this field name)
            items: playlist.items.map((item) => ({
                ...item,
                track: {
                    ...item.track,
                    album: item.track.album
                        ? {
                              ...item.track.album,
                              coverArt: item.track.album.coverUrl,
                          }
                        : null,
                },
            })),
        }));

        // Debug: log shared playlists with user info
        const sharedPlaylists = playlistsWithCounts.filter((p) => !p.isOwner);
        if (sharedPlaylists.length > 0) {
            console.log(
                `[Playlists] Found ${sharedPlaylists.length} shared playlists for user ${userId}:`
            );
            sharedPlaylists.forEach((p) => {
                console.log(
                    `  - "${p.name}" by ${
                        p.user?.username || "UNKNOWN"
                    } (owner: ${p.userId})`
                );
            });
        }

        res.json(playlistsWithCounts);
    } catch (error) {
        console.error("Get playlists error:", error);
        res.status(500).json({ error: "Failed to get playlists" });
    }
});

// POST /playlists
router.post("/", async (req, res) => {
    try {
        const userId = req.user!.id;
        const data = createPlaylistSchema.parse(req.body);

        const playlist = await prisma.playlist.create({
            data: {
                userId,
                name: data.name,
                isPublic: data.isPublic,
            },
        });

        res.json(playlist);
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res
                .status(400)
                .json({ error: "Invalid request", details: error.errors });
        }
        console.error("Create playlist error:", error);
        res.status(500).json({ error: "Failed to create playlist" });
    }
});

// GET /playlists/:id
router.get("/:id", async (req, res) => {
    try {
        const userId = req.user!.id;

        const playlist = await prisma.playlist.findUnique({
            where: { id: req.params.id },
            include: {
                user: {
                    select: {
                        username: true,
                    },
                },
                items: {
                    include: {
                        track: {
                            include: {
                                album: {
                                    include: {
                                        artist: {
                                            select: {
                                                id: true,
                                                name: true,
                                                mbid: true,
                                            },
                                        },
                                    },
                                },
                            },
                        },
                    },
                    orderBy: { sort: "asc" },
                },
                pendingTracks: {
                    orderBy: { sort: "asc" },
                },
            },
        });

        if (!playlist) {
            return res.status(404).json({ error: "Playlist not found" });
        }

        // Check access permissions
        if (!playlist.isPublic && playlist.userId !== userId) {
            return res.status(403).json({ error: "Access denied" });
        }

        // Format playlist items
        const formattedItems = playlist.items.map((item) => ({
            ...item,
            type: "track" as const,
            track: {
                ...item.track,
                album: {
                    ...item.track.album,
                    coverArt: item.track.album.coverUrl,
                },
            },
        }));

        // Format pending tracks
        const formattedPending = playlist.pendingTracks.map((pending) => ({
            id: pending.id,
            type: "pending" as const,
            sort: pending.sort,
            pending: {
                id: pending.id,
                artist: pending.spotifyArtist,
                title: pending.spotifyTitle,
                album: pending.spotifyAlbum,
                previewUrl: pending.deezerPreviewUrl,
                duration: pending.duration,
                albumArt: pending.albumArt,
            },
        }));

        // Merge and sort by position
        const mergedItems = [
            ...formattedItems.map((item) => ({ ...item, sort: item.sort })),
            ...formattedPending,
        ].sort((a, b) => a.sort - b.sort);

        res.json({
            ...playlist,
            isOwner: playlist.userId === userId,
            trackCount: playlist.items.length,
            pendingCount: playlist.pendingTracks.length,
            items: formattedItems,
            pendingTracks: formattedPending,
            mergedItems,
        });
    } catch (error) {
        console.error("Get playlist error:", error);
        res.status(500).json({ error: "Failed to get playlist" });
    }
});

// PUT /playlists/:id
router.put("/:id", async (req, res) => {
    try {
        const userId = req.user!.id;
        const data = createPlaylistSchema.parse(req.body);

        // Check ownership
        const existing = await prisma.playlist.findUnique({
            where: { id: req.params.id },
        });

        if (!existing) {
            return res.status(404).json({ error: "Playlist not found" });
        }

        if (existing.userId !== userId) {
            return res.status(403).json({ error: "Access denied" });
        }

        const playlist = await prisma.playlist.update({
            where: { id: req.params.id },
            data: {
                name: data.name,
                isPublic: data.isPublic,
            },
        });

        res.json(playlist);
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res
                .status(400)
                .json({ error: "Invalid request", details: error.errors });
        }
        console.error("Update playlist error:", error);
        res.status(500).json({ error: "Failed to update playlist" });
    }
});

// DELETE /playlists/:id
router.delete("/:id", async (req, res) => {
    try {
        const userId = req.user!.id;

        // Check ownership
        const existing = await prisma.playlist.findUnique({
            where: { id: req.params.id },
        });

        if (!existing) {
            return res.status(404).json({ error: "Playlist not found" });
        }

        if (existing.userId !== userId) {
            return res.status(403).json({ error: "Access denied" });
        }

        await prisma.playlist.delete({
            where: { id: req.params.id },
        });

        res.json({ message: "Playlist deleted" });
    } catch (error) {
        console.error("Delete playlist error:", error);
        res.status(500).json({ error: "Failed to delete playlist" });
    }
});

// POST /playlists/:id/items
router.post("/:id/items", async (req, res) => {
    try {
        const userId = req.user!.id;
        const parsedBody = addTrackSchema.safeParse(req.body);
        if (!parsedBody.success) {
            return res.status(400).json({
                error: "Invalid request",
                details: parsedBody.error.errors,
            });
        }
        const { trackId } = parsedBody.data;

        // Check ownership
        const playlist = await prisma.playlist.findUnique({
            where: { id: req.params.id },
            include: {
                items: {
                    orderBy: { sort: "desc" },
                    take: 1,
                },
            },
        });

        if (!playlist) {
            return res.status(404).json({ error: "Playlist not found" });
        }

        if (playlist.userId !== userId) {
            return res.status(403).json({ error: "Access denied" });
        }

        // Check if track exists
        const track = await prisma.track.findUnique({
            where: { id: trackId },
        });

        if (!track) {
            return res.status(404).json({ error: "Track not found" });
        }

        // Check if track already in playlist
        const existing = await prisma.playlistItem.findUnique({
            where: {
                playlistId_trackId: {
                    playlistId: req.params.id,
                    trackId,
                },
            },
        });

        if (existing) {
            return res.status(200).json({
                message: "Track already in playlist",
                duplicated: true,
                item: existing,
            });
        }

        // Get next sort position
        const maxSort = playlist.items[0]?.sort || 0;

        const item = await prisma.playlistItem.create({
            data: {
                playlistId: req.params.id,
                trackId,
                sort: maxSort + 1,
            },
            include: {
                track: {
                    include: {
                        album: {
                            include: {
                                artist: true,
                            },
                        },
                    },
                },
            },
        });

        // Touch playlist so Subsonic clients see the change
        await prisma.playlist.update({ where: { id: req.params.id }, data: { updatedAt: new Date() } });

        res.json(item);
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res
                .status(400)
                .json({ error: "Invalid request", details: error.errors });
        }
        console.error("Add track to playlist error:", error);
        res.status(500).json({ error: "Failed to add track to playlist" });
    }
});

// DELETE /playlists/:id/items/:trackId
router.delete("/:id/items/:trackId", async (req, res) => {
    try {
        const userId = req.user!.id;

        // Check ownership
        const playlist = await prisma.playlist.findUnique({
            where: { id: req.params.id },
        });

        if (!playlist) {
            return res.status(404).json({ error: "Playlist not found" });
        }

        if (playlist.userId !== userId) {
            return res.status(403).json({ error: "Access denied" });
        }

        await prisma.playlistItem.delete({
            where: {
                playlistId_trackId: {
                    playlistId: req.params.id,
                    trackId: req.params.trackId,
                },
            },
        });

        // Touch playlist so Subsonic clients see the change
        await prisma.playlist.update({ where: { id: req.params.id }, data: { updatedAt: new Date() } });

        res.json({ message: "Track removed from playlist" });
    } catch (error) {
        console.error("Remove track from playlist error:", error);
        res.status(500).json({ error: "Failed to remove track from playlist" });
    }
});

// PUT /playlists/:id/items/reorder
router.put("/:id/items/reorder", async (req, res) => {
    try {
        const userId = req.user!.id;
        const { trackIds } = req.body; // Array of track IDs in new order

        if (!Array.isArray(trackIds)) {
            return res.status(400).json({ error: "trackIds must be an array" });
        }

        // Check ownership
        const playlist = await prisma.playlist.findUnique({
            where: { id: req.params.id },
        });

        if (!playlist) {
            return res.status(404).json({ error: "Playlist not found" });
        }

        if (playlist.userId !== userId) {
            return res.status(403).json({ error: "Access denied" });
        }

        // Update sort order for each track
        const updates = trackIds.map((trackId, index) =>
            prisma.playlistItem.update({
                where: {
                    playlistId_trackId: {
                        playlistId: req.params.id,
                        trackId,
                    },
                },
                data: { sort: index },
            })
        );

        await prisma.$transaction([
            ...updates,
            // Touch playlist so Subsonic clients see the change
            prisma.playlist.update({ where: { id: req.params.id }, data: { updatedAt: new Date() } }),
        ]);

        res.json({ message: "Playlist reordered" });
    } catch (error) {
        console.error("Reorder playlist error:", error);
        res.status(500).json({ error: "Failed to reorder playlist" });
    }
});

// ============================================
// Pending Tracks (from Spotify imports)
// ============================================

/**
 * GET /playlists/:id/pending
 * Get pending tracks for a playlist (tracks from Spotify that haven't been matched yet)
 */
router.get("/:id/pending", async (req, res) => {
    try {
        const userId = req.user!.id;
        const playlistId = req.params.id;

        // Check ownership or public access
        const playlist = await prisma.playlist.findUnique({
            where: { id: playlistId },
        });

        if (!playlist) {
            return res.status(404).json({ error: "Playlist not found" });
        }

        if (playlist.userId !== userId && !playlist.isPublic) {
            return res.status(403).json({ error: "Access denied" });
        }

        const pendingTracks = await prisma.playlistPendingTrack.findMany({
            where: { playlistId },
            orderBy: { sort: "asc" },
        });

        res.json({
            count: pendingTracks.length,
            tracks: pendingTracks.map((t) => ({
                id: t.id,
                artist: t.spotifyArtist,
                title: t.spotifyTitle,
                album: t.spotifyAlbum,
                position: t.sort,
                previewUrl: t.deezerPreviewUrl,
            })),
            spotifyPlaylistId: playlist.spotifyPlaylistId,
        });
    } catch (error) {
        console.error("Get pending tracks error:", error);
        res.status(500).json({ error: "Failed to get pending tracks" });
    }
});

/**
 * DELETE /playlists/:id/pending/:trackId
 * Remove a pending track (user decides they don't want to wait for it)
 */
router.delete("/:id/pending/:trackId", async (req, res) => {
    try {
        const userId = req.user!.id;
        const { id: playlistId, trackId: pendingTrackId } = req.params;

        // Check ownership
        const playlist = await prisma.playlist.findUnique({
            where: { id: playlistId },
        });

        if (!playlist) {
            return res.status(404).json({ error: "Playlist not found" });
        }

        if (playlist.userId !== userId) {
            return res.status(403).json({ error: "Access denied" });
        }

        const deleteResult = await prisma.playlistPendingTrack.deleteMany({
            where: {
                id: pendingTrackId,
                playlistId,
            },
        });

        if (deleteResult.count === 0) {
            return res.status(404).json({ error: "Pending track not found" });
        }

        res.json({ message: "Pending track removed" });
    } catch (error) {
        console.error("Delete pending track error:", error);
        res.status(500).json({ error: "Failed to delete pending track" });
    }
});

/**
 * GET /playlists/:id/pending/:trackId/preview
 * Get a fresh Deezer preview URL for a pending track (since they expire)
 */
router.get("/:id/pending/:trackId/preview", async (req, res) => {
    try {
        const userId = req.user!.id;
        const { id: playlistId, trackId: pendingTrackId } = req.params;

        const playlist = await prisma.playlist.findUnique({
            where: { id: playlistId },
        });

        if (!playlist) {
            return res.status(404).json({ error: "Playlist not found" });
        }

        if (!playlist.isPublic && playlist.userId !== userId) {
            return res.status(403).json({ error: "Access denied" });
        }

        // Get the pending track
        const pendingTrack = await prisma.playlistPendingTrack.findFirst({
            where: {
                id: pendingTrackId,
                playlistId,
            },
        });

        if (!pendingTrack) {
            return res.status(404).json({ error: "Pending track not found" });
        }

        // Fetch fresh Deezer preview URL
        const { deezerService } = await import("../services/deezer");
        const previewUrl = await deezerService.getTrackPreview(
            pendingTrack.spotifyArtist,
            pendingTrack.spotifyTitle
        );

        if (!previewUrl) {
            return res
                .status(404)
                .json({ error: "No preview available on Deezer" });
        }

        // Update the stored preview URL for future use
        await prisma.playlistPendingTrack.update({
            where: { id: pendingTrackId },
            data: { deezerPreviewUrl: previewUrl },
        });

        res.json({ previewUrl });
    } catch (error: any) {
        console.error("Get preview URL error:", error);
        res.status(500).json({ error: "Failed to get preview URL" });
    }
});

/**
 * POST /playlists/:id/pending/:trackId/retry
 * Retry downloading a failed/pending track from Soulseek
 * Returns immediately and downloads in background
 */
router.post("/:id/pending/:trackId/retry", async (req, res) => {
    try {
        const userId = req.user!.id;
        const { id: playlistId, trackId: pendingTrackId } = req.params;

        sessionLog(
            "PENDING-RETRY",
            `Request: userId=${userId} playlistId=${playlistId} pendingTrackId=${pendingTrackId}`
        );

        // Check ownership
        const playlist = await prisma.playlist.findUnique({
            where: { id: playlistId },
        });

        if (!playlist) {
            sessionLog(
                "PENDING-RETRY",
                `Playlist not found: ${playlistId}`,
                "WARN"
            );
            return res.status(404).json({ error: "Playlist not found" });
        }

        if (playlist.userId !== userId) {
            sessionLog(
                "PENDING-RETRY",
                `Access denied: playlistId=${playlistId} userId=${userId}`,
                "WARN"
            );
            return res.status(403).json({ error: "Access denied" });
        }

        // Get the pending track
        const pendingTrack = await prisma.playlistPendingTrack.findFirst({
            where: {
                id: pendingTrackId,
                playlistId,
            },
        });

        if (!pendingTrack) {
            sessionLog(
                "PENDING-RETRY",
                `Pending track not found: ${pendingTrackId}`,
                "WARN"
            );
            return res.status(404).json({ error: "Pending track not found" });
        }

        sessionLog(
            "PENDING-RETRY",
            `Pending track: artist="${pendingTrack.spotifyArtist}" title="${pendingTrack.spotifyTitle}" album="${pendingTrack.spotifyAlbum}"`
        );

        // Create a DownloadJob so this retry appears in Activity (active/history)
        const retryTargetId =
            pendingTrack.albumMbid ||
            pendingTrack.artistMbid ||
            `pendingTrack:${pendingTrack.id}`;

        const downloadJob = await prisma.downloadJob.create({
            data: {
                userId,
                subject: `${pendingTrack.spotifyArtist} - ${pendingTrack.spotifyTitle}`,
                type: "track",
                targetMbid: retryTargetId,
                artistMbid: pendingTrack.artistMbid,
                status: "processing",
                attempts: 1,
                startedAt: new Date(),
                metadata: {
                    downloadType: "pending-track-retry",
                    source: "soulseek",
                    playlistId,
                    pendingTrackId,
                    spotifyArtist: pendingTrack.spotifyArtist,
                    spotifyTitle: pendingTrack.spotifyTitle,
                    spotifyAlbum: pendingTrack.spotifyAlbum,
                    albumMbid: pendingTrack.albumMbid,
                },
            },
        });

        sessionLog(
            "PENDING-RETRY",
            `Created download job: downloadJobId=${downloadJob.id} target=${retryTargetId}`
        );

        // Import soulseek service and try to download
        const { soulseekService } = await import("../services/soulseek");
        const { getSystemSettings } = await import("../utils/systemSettings");

        const settings = await getSystemSettings();
        if (!settings?.musicPath) {
            sessionLog("PENDING-RETRY", `Music path not configured`, "WARN");
            await prisma.downloadJob.update({
                where: { id: downloadJob.id },
                data: {
                    status: "failed",
                    error: "Music path not configured",
                    completedAt: new Date(),
                },
            });
            return res.status(400).json({ error: "Music path not configured" });
        }

        const soulseekUsable = Boolean(
            settings?.soulseekEnabled !== false &&
                settings?.soulseekUsername &&
                settings?.soulseekPassword &&
                (await soulseekService.isAvailable())
        );

        // Use a better album name if possible - extract from stored title or use artist name
        const albumName =
            pendingTrack.spotifyAlbum !== "Unknown Album"
                ? pendingTrack.spotifyAlbum
                : pendingTrack.spotifyArtist; // Use artist as fallback folder name

        console.log(
            `[Retry] Starting download for: ${pendingTrack.spotifyArtist} - ${pendingTrack.spotifyTitle}`
        );
        sessionLog(
            "PENDING-RETRY",
            `Search: ${pendingTrack.spotifyArtist} - ${pendingTrack.spotifyTitle}`
        );

        const searchResult = soulseekUsable
            ? await soulseekService.searchTrack(
                  pendingTrack.spotifyArtist,
                  pendingTrack.spotifyTitle
              )
            : { found: false, bestMatch: null, allMatches: [] as any[] };

        const youtubeMatch =
            !searchResult.found || searchResult.allMatches.length === 0
                ? await youtubeMusicService.findTrack(
                      pendingTrack.spotifyArtist,
                      pendingTrack.spotifyTitle,
                      undefined,
                      albumName
                  )
                : null;

        if (
            (!searchResult.found || searchResult.allMatches.length === 0) &&
            !youtubeMatch
        ) {
            console.log(`[Retry] ✗ No results found (Soulseek/YouTube)`);
            sessionLog(
                "PENDING-RETRY",
                `No results found (soulseek=${soulseekUsable ? "yes" : "no"})`,
                "INFO"
            );

            await prisma.downloadJob.update({
                where: { id: downloadJob.id },
                data: {
                    status: "failed",
                    error: "No matching sources found",
                    completedAt: new Date(),
                },
            });

            return res.status(200).json({
                success: false,
                message: "Track not found",
                error: "No matching sources found",
            });
        }

        console.log(`[Retry] ✓ Starting download in background`);
        sessionLog(
            "PENDING-RETRY",
            `Starting background download (soulseek=${soulseekUsable ? "yes" : "no"}, youtube=${youtubeMatch ? "yes" : "maybe"})`
        );

        // Return immediately - download happens in background
        res.json({
            success: true,
            message: "Download started",
            note: `Downloading... Track will appear after scan.`,
            downloadJobId: downloadJob.id,
        });

        // Start download in background (don't await)
        (async () => {
            let final:
                | { success: true; filePath: string; source: "soulseek" | "youtube" }
                | { success: false; error: string };

            // 1) Soulseek attempt (if usable)
            if (soulseekUsable && searchResult.allMatches.length > 0) {
                const dl = await soulseekService.downloadBestMatch(
                    pendingTrack.spotifyArtist,
                    pendingTrack.spotifyTitle,
                    albumName,
                    searchResult.allMatches,
                    settings.musicPath,
                    {
                        downloadSubdir: "Playlists",
                    }
                );
                if (dl.success && dl.filePath) {
                    final = {
                        success: true,
                        filePath: dl.filePath,
                        source: "soulseek",
                    };
                } else {
                    final = {
                        success: false,
                        error: dl.error || "Soulseek download failed",
                    };
                }
            } else {
                final = {
                    success: false,
                    error: soulseekUsable
                        ? "No Soulseek candidates"
                        : "Soulseek not configured/available",
                };
            }

            // 2) YouTube fallback
            if (!final.success) {
                const match = youtubeMatch
                    ? youtubeMatch
                    : await youtubeMusicService.findTrack(
                          pendingTrack.spotifyArtist,
                          pendingTrack.spotifyTitle,
                          undefined,
                          albumName
                      );

                if (!match?.videoId) {
                    final = {
                        success: false,
                        error: `No YouTube match found (prev: ${final.error})`,
                    };
                } else {
                    const downloadBase =
                        settings.downloadPath || "/soulseek-downloads";
                    const outputDir = path.join(
                        downloadBase,
                        "Playlists",
                        sanitizePathPart(pendingTrack.spotifyArtist),
                        sanitizePathPart(albumName)
                    );
                    const filename = `${sanitizePathPart(pendingTrack.spotifyArtist)} - ${sanitizePathPart(pendingTrack.spotifyTitle)} - ${match.videoId}`;
                    try {
                        const dl = await youtubeMusicService.downloadTrack(
                            match.videoId,
                            outputDir,
                            filename
                        );
                        try {
                            await rewriteAudioTags(dl.filePath, {
                                title: pendingTrack.spotifyTitle,
                                artist: pendingTrack.spotifyArtist,
                                album: albumName,
                            });
                        } catch (tagErr: any) {
                            console.warn(
                                `[Retry] Tag rewrite failed for ${dl.filePath}: ${tagErr.message}`
                            );
                        }
                        final = {
                            success: true,
                            filePath: dl.filePath,
                            source: "youtube",
                        };
                    } catch (err: any) {
                        final = {
                            success: false,
                            error: err?.message || "YouTube download failed",
                        };
                    }
                }
            }

            if (final.success) {
                console.log(
                    `[Retry] ✓ Download complete (${final.source}): ${final.filePath}`
                );
                sessionLog(
                    "PENDING-RETRY",
                    `Download complete (${final.source}): filePath=${final.filePath}`
                );

                await prisma.downloadJob.update({
                    where: { id: downloadJob.id },
                    data: {
                        status: "completed",
                        completedAt: new Date(),
                        metadata: {
                            ...(downloadJob.metadata as any),
                            filePath: final.filePath,
                            source: final.source,
                        },
                    },
                });

                // Trigger a library scan to add the track and reconcile pending
                try {
                    const { scanQueue } = await import("../workers/queues");
                    const downloadBase =
                        settings.downloadPath || "/soulseek-downloads";
                    const scanJob = await scanQueue.add(
                        "scan",
                        {
                            userId,
                            musicPath: path.join(downloadBase, "Playlists"),
                            basePath: downloadBase,
                            source: "retry-pending-track",
                            albumMbid: pendingTrack.albumMbid || undefined,
                            artistMbid: pendingTrack.artistMbid || undefined,
                        },
                        {
                            priority: 1,
                            removeOnComplete: true,
                        }
                    );
                    console.log(
                        `[Retry] Queued library scan to reconcile pending tracks`
                    );
                    sessionLog(
                        "PENDING-RETRY",
                        `Queued library scan (bullJobId=${scanJob.id ?? "unknown"})`
                    );
                } catch (scanError) {
                    console.error(`[Retry] Failed to queue scan:`, scanError);
                    sessionLog(
                        "PENDING-RETRY",
                        `Failed to queue scan: ${(scanError as any)?.message || scanError}`,
                        "ERROR"
                    );
                }
                return;
            }

            console.log(`[Retry] ✗ Download failed: ${final.error}`);
            sessionLog(
                "PENDING-RETRY",
                `Download failed: ${final.error || "unknown error"}`,
                "WARN"
            );

            await prisma.downloadJob.update({
                where: { id: downloadJob.id },
                data: {
                    status: "failed",
                    error: final.error || "Download failed",
                    completedAt: new Date(),
                },
            });
        })().catch((error) => {
            console.error(`[Retry] Download error:`, error);
            sessionLog(
                "PENDING-RETRY",
                `Download exception: ${error?.message || error}`,
                "ERROR"
            );

            prisma.downloadJob
                .update({
                    where: { id: downloadJob.id },
                    data: {
                        status: "failed",
                        error: error?.message || "Download exception",
                        completedAt: new Date(),
                    },
                })
                .catch(() => undefined);
        });
    } catch (error: any) {
        console.error("Retry pending track error:", error);
        sessionLog(
            "PENDING-RETRY",
            `Handler error: ${error?.message || error}`,
            "ERROR"
        );
        res.status(500).json({
            error: "Failed to retry download",
            details: error.message,
        });
    }
});

/**
 * POST /playlists/:id/pending/retry-all
 * Retry downloading all pending tracks for a playlist via Soulseek.
 * Returns immediately; downloads and scan run in background.
 */
router.post("/:id/pending/retry-all", async (req, res) => {
    try {
        const userId = req.user!.id;
        const playlistId = req.params.id;

        // Check ownership
        const playlist = await prisma.playlist.findUnique({
            where: { id: playlistId },
            select: { id: true, userId: true, name: true },
        });

        if (!playlist) {
            return res.status(404).json({ error: "Playlist not found" });
        }

        if (playlist.userId !== userId) {
            return res.status(403).json({ error: "Access denied" });
        }

        const pendingTracks = await prisma.playlistPendingTrack.findMany({
            where: { playlistId },
            orderBy: { sort: "asc" },
        });

        if (pendingTracks.length === 0) {
            return res.json({
                success: true,
                count: 0,
                message: "No missing tracks to retry",
            });
        }

        const downloadJob = await prisma.downloadJob.create({
            data: {
                userId,
                subject: `Retry missing tracks: ${playlist.name}`,
                type: "track",
                targetMbid: `playlist:${playlistId}:retry-all`,
                status: "processing",
                attempts: 1,
                startedAt: new Date(),
                metadata: {
                    downloadType: "pending-tracks-retry-all",
                    source: "soulseek",
                    playlistId,
                    playlistName: playlist.name,
                    pendingCount: pendingTracks.length,
                },
            },
        });

        res.json({
            success: true,
            count: pendingTracks.length,
            message: `Retry started for ${pendingTracks.length} track(s)`,
            downloadJobId: downloadJob.id,
        });

        // Background: per-track downloads (Soulseek -> YouTube fallback) + scan
        (async () => {
            try {
                const { soulseekService } = await import("../services/soulseek");
                const { getSystemSettings } = await import(
                    "../utils/systemSettings"
                );
                const { scanQueue } = await import("../workers/queues");

                const settings = await getSystemSettings();
                const downloadBase = settings?.downloadPath || "/soulseek-downloads";
                const playlistScanPath = path.join(downloadBase, "Playlists");

                if (!settings?.musicPath) {
                    throw new Error("Music path not configured");
                }

                const soulseekUsable = Boolean(
                    settings?.soulseekEnabled !== false &&
                        settings?.soulseekUsername &&
                        settings?.soulseekPassword &&
                        (await soulseekService.isAvailable())
                );
                const youtubeUsable = settings?.youtubeEnabled !== false;

                sessionLog(
                    "PENDING-RETRY",
                    `Bulk retry start: playlistId=${playlistId} pending=${pendingTracks.length}`
                );

                const tracksToDownload = pendingTracks.map((t) => ({
                    artist: t.spotifyArtist,
                    title: t.spotifyTitle,
                    album:
                        t.spotifyAlbum && t.spotifyAlbum !== "Unknown Album"
                            ? t.spotifyAlbum
                            : t.spotifyArtist,
                }));

                const queue = new PQueue({ concurrency: 3 });
                let successful = 0;
                let failed = 0;

                await Promise.all(
                    tracksToDownload.map((t) =>
                        queue.add(async () => {
                            let ok = false;

                            if (soulseekUsable) {
                                try {
                                    const searchResult = await soulseekService.searchTrack(
                                        t.artist,
                                        t.title,
                                        false,
                                        {
                                            preferFlac: true,
                                            allowMp3320Fallback: true,
                                            allowMp3256Fallback: true,
                                            timeoutMs: 3500,
                                        }
                                    );
                                    if (
                                        searchResult.found &&
                                        searchResult.allMatches.length > 0
                                    ) {
                                        const dl = await soulseekService.downloadBestMatch(
                                            t.artist,
                                            t.title,
                                            t.album,
                                            searchResult.allMatches,
                                            settings.musicPath,
                                            { downloadSubdir: "Playlists" }
                                        );
                                        ok = Boolean(dl.success);
                                    }
                                } catch {
                                    ok = false;
                                }
                            }

                            if (!ok && youtubeUsable) {
                                const match = await youtubeMusicService.findTrack(
                                    t.artist,
                                    t.title,
                                    undefined,
                                    t.album
                                );
                                if (match?.videoId) {
                                    const outputDir = path.join(
                                        downloadBase,
                                        "Playlists",
                                        sanitizePathPart(t.artist),
                                        sanitizePathPart(t.album)
                                    );
                                    const filename = `${sanitizePathPart(t.artist)} - ${sanitizePathPart(t.title)} - ${match.videoId}`;
                                    try {
                                        const dl =
                                            await youtubeMusicService.downloadTrack(
                                                match.videoId,
                                                outputDir,
                                                filename
                                            );
                                        try {
                                            await rewriteAudioTags(dl.filePath, {
                                                title: t.title,
                                                artist: t.artist,
                                                album: t.album,
                                            });
                                        } catch {
                                            // non-fatal
                                        }
                                        ok = true;
                                    } catch {
                                        ok = false;
                                    }
                                }
                            }

                            if (ok) {
                                successful++;
                            } else {
                                failed++;
                            }
                        })
                    )
                );

                await prisma.downloadJob.update({
                    where: { id: downloadJob.id },
                    data: {
                        status: successful > 0 ? "completed" : "failed",
                        error: successful > 0 ? null : "No tracks downloaded",
                        completedAt: new Date(),
                        metadata: {
                            ...(downloadJob.metadata as any),
                            successful,
                            failed,
                            soulseekUsable,
                        },
                    },
                });

                if (successful > 0) {
                    await scanQueue.add(
                        "scan",
                        {
                            userId,
                            musicPath: playlistScanPath,
                            basePath: downloadBase,
                            source: "retry-missing-tracks",
                        },
                        { priority: 1, removeOnComplete: true }
                    );
                }

                sessionLog(
                    "PENDING-RETRY",
                    `Bulk retry complete: playlistId=${playlistId} ok=${successful} failed=${failed}`
                );
            } catch (err: any) {
                await prisma.downloadJob
                    .update({
                        where: { id: downloadJob.id },
                        data: {
                            status: "failed",
                            error: err?.message || "Bulk retry failed",
                            completedAt: new Date(),
                        },
                    })
                    .catch(() => undefined);

                sessionLog(
                    "PENDING-RETRY",
                    `Bulk retry failed: playlistId=${playlistId} error=${err?.message || err}`,
                    "ERROR"
                );
            }
        })();
    } catch (error: any) {
        console.error("Retry all pending tracks error:", error);
        res.status(500).json({
            error: "Failed to retry missing tracks",
            details: error.message,
        });
    }
});

/**
 * POST /playlists/:id/pending/reconcile
 * Manually trigger reconciliation for a specific playlist
 */
router.post("/:id/pending/reconcile", async (req, res) => {
    try {
        const userId = req.user!.id;
        const playlistId = req.params.id;

        // Check ownership
        const playlist = await prisma.playlist.findUnique({
            where: { id: playlistId },
        });

        if (!playlist) {
            return res.status(404).json({ error: "Playlist not found" });
        }

        if (playlist.userId !== userId) {
            return res.status(403).json({ error: "Access denied" });
        }

        // Import and run reconciliation
        const { spotifyImportService } = await import(
            "../services/spotifyImport"
        );
        const result = await spotifyImportService.reconcilePendingTracks();

        res.json({
            message: "Reconciliation complete",
            tracksAdded: result.tracksAdded,
            playlistsUpdated: result.playlistsUpdated,
        });
    } catch (error) {
        console.error("Reconcile pending tracks error:", error);
        res.status(500).json({ error: "Failed to reconcile pending tracks" });
    }
});

export default router;
