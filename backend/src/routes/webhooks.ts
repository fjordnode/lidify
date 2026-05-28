/**
 * Lidarr Webhook Handler (Refactored)
 *
 * Handles Lidarr webhooks for download tracking and Discovery Weekly integration.
 * Uses the stateless simpleDownloadManager for all operations.
 */

import { Router } from "express";
import fs from "fs";
import path from "path";
import { prisma } from "../utils/db";
import { scanQueue } from "../workers/queues";
import { discoverWeeklyService } from "../services/discoverWeekly";
import { simpleDownloadManager } from "../services/simpleDownloadManager";
import { queueCleaner } from "../jobs/queueCleaner";
import { getSystemSettings } from "../utils/systemSettings";

const router = Router();

function collectStringValues(...values: any[]): string[] {
    return values
        .flat(Infinity)
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean);
}

function getCommonAncestorDirectory(pathsToCompare: string[]): string | null {
    if (pathsToCompare.length === 0) return null;

    const splitPaths = pathsToCompare.map((candidate) =>
        path.resolve(candidate).split(path.sep).filter(Boolean)
    );
    const shortestLength = Math.min(...splitPaths.map((parts) => parts.length));
    const commonParts: string[] = [];

    for (let i = 0; i < shortestLength; i += 1) {
        const segment = splitPaths[0][i];
        if (splitPaths.every((parts) => parts[i] === segment)) {
            commonParts.push(segment);
        } else {
            break;
        }
    }

    if (commonParts.length === 0) return null;
    return `${path.sep}${commonParts.join(path.sep)}`;
}

function resolveImportedAlbumScanPath(payload: any, musicRoot: string): string | null {
    const normalizedMusicRoot = path.resolve(musicRoot);

    const dirCandidates = collectStringValues(
        payload.album?.path,
        payload.album?.folderPath,
        payload.release?.path,
        payload.release?.folderPath,
        payload.importedPath,
        payload.path
    )
        .map((candidate) => path.resolve(candidate))
        .filter(
            (candidate) =>
                candidate !== normalizedMusicRoot &&
                candidate.startsWith(`${normalizedMusicRoot}${path.sep}`) &&
                fs.existsSync(candidate) &&
                fs.statSync(candidate).isDirectory()
        );

    const trackFilePaths = collectStringValues(
        payload.trackFile?.path,
        payload.trackFiles?.map((trackFile: any) => trackFile?.path),
        payload.tracks?.map((track: any) => track?.path),
        payload.tracks?.map((track: any) => track?.trackFile?.path)
    )
        .map((candidate) => path.resolve(candidate))
        .filter(
            (candidate) =>
                candidate.startsWith(`${normalizedMusicRoot}${path.sep}`) &&
                fs.existsSync(candidate)
        );

    if (trackFilePaths.length > 0) {
        const commonDir = getCommonAncestorDirectory(trackFilePaths);
        if (
            commonDir &&
            commonDir !== normalizedMusicRoot &&
            commonDir.startsWith(`${normalizedMusicRoot}${path.sep}`) &&
            fs.existsSync(commonDir) &&
            fs.statSync(commonDir).isDirectory()
        ) {
            dirCandidates.push(commonDir);
        }
    }

    if (dirCandidates.length === 0) {
        return null;
    }

    return dirCandidates.sort((a, b) => a.length - b.length)[0];
}

// POST /webhooks/lidarr - Handle Lidarr webhooks
router.post("/lidarr", async (req, res) => {
    try {
        // Check if Lidarr is enabled before processing any webhooks
        const settings = await getSystemSettings();
        if (
            !settings?.lidarrEnabled ||
            !settings?.lidarrUrl ||
            !settings?.lidarrApiKey
        ) {
            console.log(
                `[WEBHOOK] Lidarr webhook received but Lidarr is disabled. Ignoring.`
            );
            return res.status(202).json({
                success: true,
                ignored: true,
                reason: "lidarr-disabled",
            });
        }

        const eventType = req.body.eventType;
        console.log(`[WEBHOOK] Lidarr event: ${eventType}`);

        // Log payload in debug mode only (avoid verbose logs in production)
        if (process.env.DEBUG_WEBHOOKS === "true") {
            console.log(`   Payload:`, JSON.stringify(req.body, null, 2));
        }

        switch (eventType) {
            case "Grab":
                await handleGrab(req.body);
                break;

            case "Download":
            case "AlbumDownload":
            case "TrackRetag":
            case "Rename":
                await handleDownload(req.body);
                break;

            case "ImportFailure":
            case "DownloadFailed":
            case "DownloadFailure":
                await handleImportFailure(req.body);
                break;

            case "Health":
            case "HealthIssue":
            case "HealthRestored":
                // Ignore health events
                break;

            case "Test":
                console.log("   Lidarr test webhook received");
                break;

            default:
                console.log(`   Unhandled event: ${eventType}`);
        }

        res.json({ success: true });
    } catch (error: any) {
        console.error("Webhook error:", error.message);
        res.status(500).json({ error: "Webhook processing failed" });
    }
});

/**
 * Handle Grab event (download started by Lidarr)
 */
async function handleGrab(payload: any) {
    const downloadId = payload.downloadId;
    const albumMbid =
        payload.albums?.[0]?.foreignAlbumId || payload.albums?.[0]?.mbId;
    const albumTitle = payload.albums?.[0]?.title;
    const artistName = payload.artist?.name;
    const lidarrAlbumId = payload.albums?.[0]?.id;

    console.log(`   Album: ${artistName} - ${albumTitle}`);
    console.log(`   Download ID: ${downloadId}`);
    console.log(`   MBID: ${albumMbid}`);

    if (!downloadId) {
        console.log(`   Missing downloadId, skipping`);
        return;
    }

    // Use the download manager's multi-strategy matching
    const result = await simpleDownloadManager.onDownloadGrabbed(
        downloadId,
        albumMbid || "",
        albumTitle || "",
        artistName || "",
        lidarrAlbumId || 0
    );

    if (result.matched) {
        // Start queue cleaner to monitor this download
        queueCleaner.start();
    }
}

/**
 * Handle Download event (download complete + imported)
 */
async function handleDownload(payload: any) {
    const settings = await getSystemSettings();
    const musicRoot = settings?.musicPath || "/music";
    const downloadId = payload.downloadId;
    const albumTitle = payload.album?.title || payload.albums?.[0]?.title;
    const artistName = payload.artist?.name;
    // Try multiple paths for MBID - Lidarr uses different field names in different events
    const albumMbid =
        payload.album?.foreignAlbumId ||
        payload.album?.mbId ||
        payload.albums?.[0]?.foreignAlbumId ||
        payload.albums?.[0]?.mbId ||
        payload.release?.foreignReleaseId;
    const lidarrAlbumId = payload.album?.id || payload.albums?.[0]?.id;

    // Debug: log available fields if MBID not found
    if (!albumMbid && process.env.DEBUG_WEBHOOKS !== "true") {
        console.log(`   DEBUG: album keys: ${Object.keys(payload.album || {}).join(", ")}`);
        console.log(`   DEBUG: albums[0] keys: ${Object.keys(payload.albums?.[0] || {}).join(", ")}`);
    }

    console.log(`   Album: ${artistName} - ${albumTitle}`);
    console.log(`   Download ID: ${downloadId}`);
    console.log(`   Album MBID: ${albumMbid}`);
    console.log(`   Lidarr Album ID: ${lidarrAlbumId}`);

    if (!downloadId) {
        console.log(`   Missing downloadId, skipping`);
        return;
    }

    // Handle completion through download manager
    const result = await simpleDownloadManager.onDownloadComplete(
        downloadId,
        albumMbid,
        artistName,
        albumTitle,
        lidarrAlbumId
    );
    const scanPath = resolveImportedAlbumScanPath(payload, musicRoot);

    if (result.jobId) {
        // Check if this is part of a download batch (artist download)
        if (result.downloadBatchId) {
            // Check if all jobs in the batch are complete
            const batchComplete = await checkDownloadBatchComplete(
                result.downloadBatchId
            );
            if (batchComplete) {
                console.log(
                    `   All albums in batch complete, triggering library scan...`
                );
                await scanQueue.add("scan", {
                    type: "full",
                    source: "lidarr-import-batch",
                });
            } else {
                console.log(`   Batch not complete, skipping scan`);
            }
        } else if (!result.batchId) {
            // Single album download (not part of discovery batch)
            console.log(
                `   Triggering library scan with MBID: ${albumMbid}${scanPath ? ` at ${scanPath}` : ""}...`
            );
            await scanQueue.add("scan", {
                type: "full",
                source: "lidarr-import",
                ...(scanPath
                    ? {
                          musicPath: scanPath,
                          basePath: musicRoot,
                      }
                    : {}),
                lidarrAlbumMbid: albumMbid,
                lidarrArtistName: artistName,
                lidarrAlbumTitle: albumTitle,
            });
        }
        // If part of discovery batch, the download manager already called checkBatchCompletion
    } else {
        // No job found - this might be an external download not initiated by us
        // Still trigger a scan to pick up the new music
        console.log(
            `   No matching job, triggering scan with MBID: ${albumMbid}${scanPath ? ` at ${scanPath}` : ""}...`
        );
        await scanQueue.add("scan", {
            type: "full",
            source: "lidarr-import-external",
            ...(scanPath
                ? {
                      musicPath: scanPath,
                      basePath: musicRoot,
                  }
                : {}),
            lidarrAlbumMbid: albumMbid,
            lidarrArtistName: artistName,
            lidarrAlbumTitle: albumTitle,
        });
    }
}

/**
 * Check if all jobs in a download batch are complete
 */
async function checkDownloadBatchComplete(batchId: string): Promise<boolean> {
    const pendingJobs = await prisma.downloadJob.count({
        where: {
            metadata: {
                path: ["batchId"],
                equals: batchId,
            },
            status: { in: ["pending", "processing"] },
        },
    });

    console.log(
        `   Batch ${batchId}: ${pendingJobs} pending/processing jobs remaining`
    );
    return pendingJobs === 0;
}

/**
 * Handle import failure with automatic retry
 */
async function handleImportFailure(payload: any) {
    const downloadId = payload.downloadId;
    const albumMbid =
        payload.album?.foreignAlbumId || payload.albums?.[0]?.foreignAlbumId;
    const albumTitle = payload.album?.title || payload.release?.title;
    const reason = payload.message || "Import failed";

    console.log(`   Album: ${albumTitle}`);
    console.log(`   Download ID: ${downloadId}`);
    console.log(`   Reason: ${reason}`);

    if (!downloadId) {
        console.log(`   Missing downloadId, skipping`);
        return;
    }

    // Handle failure through download manager (handles retry logic)
    await simpleDownloadManager.onImportFailed(downloadId, reason, albumMbid);
}

export default router;
