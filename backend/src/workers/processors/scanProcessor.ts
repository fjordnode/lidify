import { Job } from "bull";
import { MusicScannerService } from "../../services/musicScanner";
import { config } from "../../config";
import * as path from "path";

export interface ScanJobData {
    userId: string;
    musicPath?: string; // Optional: use custom path or default from config
    basePath?: string; // Optional: base path used for relative filePath in DB
    albumMbid?: string; // Optional: if scan triggered by download completion
    artistMbid?: string; // Optional: if scan triggered by download completion
    source?: string; // Optional: source of scan (e.g., "lidarr-webhook", "discover-weekly-completion", "spotify-import")
    downloadId?: string; // Optional: Lidarr download ID for precise job linking
    discoveryBatchId?: string; // Optional: Discovery Weekly batch ID
    spotifyImportJobId?: string; // Optional: Spotify Import job ID
    // Lidarr import data - used to set proper MBID on imported albums
    lidarrAlbumMbid?: string; // Release MBID from Lidarr (will be converted to Release Group MBID)
    lidarrArtistName?: string; // Artist name for matching
    lidarrAlbumTitle?: string; // Album title for matching
    playlistOnlyMode?: boolean; // Override inferred download-path behavior for direct library downloads
}

export interface ScanJobResult {
    tracksAdded: number;
    tracksUpdated: number;
    tracksRemoved: number;
    affectedArtistIds?: string[];
    errors: Array<{ file: string; error: string }>;
    duration: number;
}

export async function processScan(
    job: Job<ScanJobData>
): Promise<ScanJobResult> {
    const {
        userId,
        musicPath,
        basePath,
        albumMbid,
        artistMbid,
        source,
        downloadId,
        discoveryBatchId,
        spotifyImportJobId,
        lidarrAlbumMbid,
        lidarrArtistName,
        lidarrAlbumTitle,
        playlistOnlyMode: playlistOnlyModeOverride,
    } = job.data;

    console.log(`\n═══════════════════════════════════════════════`);
    console.log(`[ScanJob ${job.id}] Starting library scan for user ${userId}`);
    if (source) {
        console.log(`[ScanJob ${job.id}] Scan source: ${source}`);
    }
    if (albumMbid) {
        console.log(`[ScanJob ${job.id}] Album MBID: ${albumMbid}`);
    }
    if (artistMbid) {
        console.log(`[ScanJob ${job.id}] Artist MBID: ${artistMbid}`);
    }
    console.log(`═══════════════════════════════════════════════`);

    // Report progress
    await job.progress(0);

    // Prepare cover cache path (store alongside transcode cache)
    const coverCachePath = path.join(
        config.music.transcodeCachePath,
        "../covers"
    );

    // Use provided music path or fall back to config
    const scanPath = musicPath || config.music.musicPath;
    const scanBasePath = basePath || scanPath;

    // Check if scanning the download path (soulseek-downloads)
    // If so, use "playlist only" mode: albums marked as DISCOVER, hidden from library views
    const { prisma } = await import("../../utils/db");
    const settings = await prisma.systemSettings.findFirst();
    const downloadPath = settings?.downloadPath || "/soulseek-downloads";
    const inferredPlaylistOnlyMode =
        scanPath === downloadPath ||
        scanPath.startsWith(downloadPath) ||
        scanPath.includes("soulseek-download");
    const playlistOnlyMode =
        typeof playlistOnlyModeOverride === "boolean"
            ? playlistOnlyModeOverride
            : inferredPlaylistOnlyMode;

    // Create scanner with progress callback and cover cache path
    const scanner = new MusicScannerService((progress) => {
        // Calculate percentage (filesScanned / filesTotal * 100)
        const percent = Math.floor(
            (progress.filesScanned / progress.filesTotal) * 100
        );
        job.progress(percent).catch((err) =>
            console.error(`Failed to update job progress:`, err)
        );
    }, coverCachePath, playlistOnlyMode);

    console.log(`[ScanJob ${job.id}] Scanning path: ${scanPath}${playlistOnlyMode ? " (playlist-only mode)" : ""}`);

    try {
        const result = await scanner.scanLibrary(scanPath, scanBasePath);

        await job.progress(100);

        console.log(
            `[ScanJob ${job.id}] Scan complete: +${result.tracksAdded} ~${result.tracksUpdated} -${result.tracksRemoved}`
        );

        if (result.affectedArtistIds.length > 0) {
            try {
                const { redisClient } = await import("../../utils/redis");
                const cacheKeys = result.affectedArtistIds.map(
                    (artistId) => `artist-top-tracks-processed:${artistId}`
                );
                await redisClient.del(cacheKeys);
                console.log(
                    `[ScanJob ${job.id}] Invalidated top track cache for ${result.affectedArtistIds.length} artist(s)`
                );
            } catch (error) {
                console.error(
                    `[ScanJob ${job.id}] Failed to invalidate top track cache:`,
                    error
                );
            }
        }

        // Send ntfy push notification for new music (triggers Symfonium sync via Tasker)
        if (result.tracksAdded > 0) {
            try {
                const { ntfyService } = await import("../../services/ntfyService");
                await ntfyService.notifyNewMusic(result.tracksAdded);
            } catch (error: any) {
                console.error(`[ScanJob ${job.id}] Failed to send ntfy notification:`, error.message);
            }
        }

        // If we have Lidarr album data, fix temp MBIDs on the imported album
        if (lidarrAlbumMbid && lidarrArtistName && lidarrAlbumTitle) {
            try {
                console.log(`[ScanJob ${job.id}] Fixing MBID for Lidarr import: ${lidarrArtistName} - ${lidarrAlbumTitle}`);

                const { prisma } = await import("../../utils/db");
                const { musicBrainzService } = await import("../../services/musicbrainz");

                // Convert Release MBID to Release Group MBID
                const releaseGroupMbid = await musicBrainzService.getReleaseGroupFromRelease(lidarrAlbumMbid);

                if (releaseGroupMbid) {
                    // Find the album by artist name + title that has a temp MBID
                    const album = await prisma.album.findFirst({
                        where: {
                            title: { equals: lidarrAlbumTitle, mode: "insensitive" },
                            artist: { name: { equals: lidarrArtistName, mode: "insensitive" } },
                            rgMbid: { startsWith: "temp-" },
                        },
                        include: { artist: true },
                    });

                    if (album) {
                        const oldMbid = album.rgMbid;

                        // Update the album's MBID
                        await prisma.album.update({
                            where: { id: album.id },
                            data: { rgMbid: releaseGroupMbid },
                        });

                        // Also update OwnedAlbum if it exists
                        await prisma.ownedAlbum.updateMany({
                            where: { rgMbid: oldMbid },
                            data: { rgMbid: releaseGroupMbid },
                        });

                        console.log(`[ScanJob ${job.id}] ✓ Fixed MBID: ${oldMbid} → ${releaseGroupMbid}`);
                    } else {
                        // Try without temp- filter in case album already had a different MBID
                        const existingAlbum = await prisma.album.findFirst({
                            where: {
                                title: { equals: lidarrAlbumTitle, mode: "insensitive" },
                                artist: { name: { equals: lidarrArtistName, mode: "insensitive" } },
                            },
                        });

                        if (existingAlbum) {
                            console.log(`[ScanJob ${job.id}] Album already has MBID: ${existingAlbum.rgMbid}`);
                        } else {
                            console.log(`[ScanJob ${job.id}] Could not find album to fix: ${lidarrArtistName} - ${lidarrAlbumTitle}`);
                        }
                    }
                } else {
                    console.log(`[ScanJob ${job.id}] Could not convert Release MBID to Release Group MBID`);
                }
            } catch (error: any) {
                console.error(`[ScanJob ${job.id}] Failed to fix Lidarr album MBID:`, error.message);
            }
        }

        // If this scan was triggered by a download completion, mark download jobs as completed
        if (
            source === "lidarr-webhook" &&
            (albumMbid || artistMbid || downloadId)
        ) {
            console.log(
                `[ScanJob ${job.id}] Marking download jobs as completed after successful scan`
            );
            const { prisma } = await import("../../utils/db");

            if (artistMbid) {
                await prisma.downloadJob.updateMany({
                    where: {
                        targetMbid: artistMbid,
                        type: "artist",
                        status: { in: ["pending", "processing"] },
                    },
                    data: {
                        status: "completed",
                        completedAt: new Date(),
                    },
                });
                console.log(
                    `[ScanJob ${job.id}] Marked artist download as completed: ${artistMbid}`
                );

                // Trigger enrichment for the newly imported artist
                try {
                    const artist = await prisma.artist.findUnique({
                        where: { mbid: artistMbid },
                    });
                    if (artist && artist.enrichmentStatus === "pending") {
                        console.log(
                            `[ScanJob ${job.id}] Triggering enrichment for artist: ${artist.name}`
                        );
                        const { enrichSimilarArtist } = await import(
                            "../artistEnrichment"
                        );
                        // Run enrichment in background (don't await)
                        enrichSimilarArtist(artist).catch((err) => {
                            console.error(
                                `[ScanJob ${job.id}]  Enrichment failed for ${artist.name}:`,
                                err
                            );
                        });
                    }
                } catch (error) {
                    console.error(
                        `[ScanJob ${job.id}]   Failed to trigger enrichment:`,
                        error
                    );
                }
            }

            if (albumMbid) {
                const updatedByMbid = await prisma.downloadJob.updateMany({
                    where: {
                        targetMbid: albumMbid,
                        type: "album",
                        status: { in: ["pending", "processing"] },
                    },
                    data: {
                        status: "completed",
                        completedAt: new Date(),
                    },
                });

                if (updatedByMbid.count > 0) {
                    console.log(
                        `[ScanJob ${job.id}] Marked ${updatedByMbid.count} album download(s) as completed by MBID: ${albumMbid}`
                    );
                } else {
                    // Fallback: Try to find the album by artist+title and match download jobs
                    console.log(
                        `[ScanJob ${job.id}] No downloads matched by MBID, trying artist+title match...`
                    );

                    const album = await prisma.album.findFirst({
                        where: { rgMbid: albumMbid },
                        include: { artist: true },
                    });

                    if (album) {
                        const updatedByName =
                            await prisma.downloadJob.updateMany({
                                where: {
                                    type: "album",
                                    status: { in: ["pending", "processing"] },
                                    metadata: {
                                        path: ["albumTitle"],
                                        equals: album.title,
                                    },
                                },
                                data: {
                                    status: "completed",
                                    completedAt: new Date(),
                                },
                            });

                        if (updatedByName.count > 0) {
                            console.log(
                                `[ScanJob ${job.id}] Marked ${updatedByName.count} album download(s) as completed by title match: ${album.artist.name} - ${album.title}`
                            );
                        } else {
                            console.log(
                                `[ScanJob ${job.id}]   No pending downloads found for: ${album.artist.name} - ${album.title}`
                            );
                        }
                    }
                }

                // Trigger enrichment for the artist of the newly imported album
                try {
                    const album = await prisma.album.findFirst({
                        where: { rgMbid: albumMbid },
                        include: { artist: true },
                    });
                    if (
                        album?.artist &&
                        album.artist.enrichmentStatus === "pending"
                    ) {
                        console.log(
                            `[ScanJob ${job.id}] Triggering enrichment for artist: ${album.artist.name}`
                        );
                        const { enrichSimilarArtist } = await import(
                            "../artistEnrichment"
                        );
                        // Run enrichment in background (don't await)
                        enrichSimilarArtist(album.artist).catch((err) => {
                            console.error(
                                `[ScanJob ${job.id}]  Enrichment failed for ${album.artist.name}:`,
                                err
                            );
                        });
                    }
                } catch (error) {
                    console.error(
                        `[ScanJob ${job.id}]   Failed to trigger enrichment:`,
                        error
                    );
                }
            }

            if (downloadId) {
                const updated = await prisma.downloadJob.updateMany({
                    where: {
                        lidarrRef: downloadId,
                        status: { in: ["pending", "processing"] },
                    },
                    data: {
                        status: "completed",
                        completedAt: new Date(),
                    },
                });
                if (updated.count > 0) {
                    console.log(
                        `[ScanJob ${job.id}] Linked Lidarr download ${downloadId} to ${updated.count} job(s)`
                    );
                } else {
                    console.log(
                        `[ScanJob ${job.id}]   No download jobs found for Lidarr ID ${downloadId}`
                    );
                }
            }
        }

        // If this scan was for Discovery Weekly, build the final playlist
        if (source === "discover-weekly-completion" && discoveryBatchId) {
            console.log(
                `[ScanJob ${job.id}]  Building Discovery Weekly playlist for batch ${discoveryBatchId}...`
            );
            try {
                const { discoverWeeklyService } = await import(
                    "../../services/discoverWeekly"
                );
                await discoverWeeklyService.buildFinalPlaylist(
                    discoveryBatchId
                );
                console.log(
                    `[ScanJob ${job.id}] Discovery Weekly playlist complete!`
                );
            } catch (error: any) {
                console.error(
                    `[ScanJob ${job.id}]  Failed to build Discovery playlist:`,
                    error.message
                );
            }
        }

        // Playlist imports are now track-only: playlist is created immediately.
        // After scans, we only reconcile pending tracks (see below).

        // Send notification for manual scans (not background/webhook scans)
        if (!source && userId && userId !== "system") {
            try {
                const { notificationService } = await import(
                    "../../services/notificationService"
                );
                await notificationService.notifySystem(
                    userId,
                    "Library Scan Complete",
                    `Added ${result.tracksAdded} tracks, updated ${result.tracksUpdated}, removed ${result.tracksRemoved}`
                );
            } catch (error) {
                console.error(`[ScanJob ${job.id}] Failed to send notification:`, error);
            }
        }

        // Reconcile pending tracks from Spotify playlist imports
        // This checks if any previously unmatched tracks now have matches
        // Run on: new tracks added OR manual sync (no source = manual scan button)
        // Always reconcile after Spotify playlist import scans, even if tracksAdded == 0.
        // Playlist downloads can be tagged as "Various Artists" etc, and matching logic may
        // improve over time; skipping reconcile would leave tracks stuck in pending state.
        const shouldReconcile =
            result.tracksAdded > 0 || !source || source === "spotify-import";
        if (shouldReconcile) {
            try {
                console.log(`[ScanJob ${job.id}] Checking for pending playlist tracks to reconcile...`);
                const { spotifyImportService } = await import(
                    "../../services/spotifyImport"
                );
                const reconcileResult = await spotifyImportService.reconcilePendingTracks();
                if (reconcileResult.tracksAdded > 0) {
                    console.log(
                        `[ScanJob ${job.id}] ✓ Reconciled ${reconcileResult.tracksAdded} pending tracks to ${reconcileResult.playlistsUpdated} playlists`
                    );
                    
                    // Send notification about reconciled tracks
                    if (userId && userId !== "system") {
                        try {
                            const { notificationService } = await import(
                                "../../services/notificationService"
                            );
                            await notificationService.notifySystem(
                                userId,
                                "Playlist Tracks Matched",
                                `${reconcileResult.tracksAdded} previously unmatched tracks were added to your playlists`
                            );
                        } catch (notifyError) {
                            console.error(`[ScanJob ${job.id}] Failed to send reconcile notification:`, notifyError);
                        }
                    }
                } else {
                    console.log(`[ScanJob ${job.id}] No pending tracks to reconcile`);
                }
            } catch (error) {
                console.error(`[ScanJob ${job.id}] Failed to reconcile pending tracks:`, error);
            }
        }

        // Run data integrity check to clean up any orphaned records
        // This catches albums/tracks that weren't cleaned up properly during scan
        // (e.g., if files were deleted but tracks remain in DB)
        try {
            console.log(`[ScanJob ${job.id}] Running post-scan data integrity check...`);
            const { runDataIntegrityCheck } = await import("../dataIntegrity");
            const integrityReport = await runDataIntegrityCheck();
            if (integrityReport.orphanedAlbums > 0 || integrityReport.orphanedArtists > 0) {
                console.log(`[ScanJob ${job.id}] Cleaned up ${integrityReport.orphanedAlbums} orphaned albums, ${integrityReport.orphanedArtists} orphaned artists`);
            }
        } catch (error) {
            console.error(`[ScanJob ${job.id}] Data integrity check failed:`, error);
        }

        // Trigger mood tag collection for new tracks whose artists are already enriched
        // This ensures Last.fm mood tags are collected immediately after scan, not waiting 30s for background worker
        if (result.tracksAdded > 0) {
            try {
                console.log(`[ScanJob ${job.id}] Checking for tracks needing mood tag enrichment...`);
                const { prisma } = await import("../../utils/db");

                // Count new tracks that need mood tags
                // Note: We don't filter by artist enrichmentStatus here because
                // triggerEnrichmentNow() runs runEnrichmentCycle() which handles
                // artist enrichment first (Step 1), then track tags (Step 2)
                const tracksNeedingTags = await prisma.track.count({
                    where: {
                        lastfmTags: { isEmpty: true },
                    },
                });

                if (tracksNeedingTags > 0) {
                    console.log(`[ScanJob ${job.id}] Found ${tracksNeedingTags} tracks needing mood tags, triggering enrichment...`);

                    // Trigger immediate enrichment cycle (non-blocking)
                    const { triggerEnrichmentNow } = await import("../unifiedEnrichment");
                    triggerEnrichmentNow().then(result => {
                        if (result.tracks > 0) {
                            console.log(`[ScanJob ${job.id}] Mood tag enrichment completed: ${result.tracks} tracks enriched`);
                        }
                    }).catch(err => {
                        console.error(`[ScanJob ${job.id}] Mood tag enrichment failed:`, err);
                    });
                } else {
                    console.log(`[ScanJob ${job.id}] No tracks need immediate mood tag enrichment`);
                }
            } catch (error) {
                console.error(`[ScanJob ${job.id}] Failed to check for mood tag enrichment:`, error);
            }
        }

        return result;
    } catch (error: any) {
        console.error(`[ScanJob ${job.id}] Scan failed:`, error);
        throw error;
    }
}
