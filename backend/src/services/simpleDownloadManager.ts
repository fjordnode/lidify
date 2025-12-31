/**
 * Simple Download Manager (Refactored)
 *
 * Stateless download service that uses the database as the single source of truth.
 * Handles album downloads with automatic retry, blocklisting, and completion tracking.
 * No in-memory state - survives server restarts.
 */

import { prisma } from "../utils/db";
import { lidarrService, LidarrRelease } from "./lidarr";
import { musicBrainzService } from "./musicbrainz";
import { getSystemSettings } from "../utils/systemSettings";
import { notificationService } from "./notificationService";
import { sessionLog } from "../utils/playlistLogger";
import axios from "axios";
import * as crypto from "crypto";

// Generate a UUID v4 without external dependency
function generateCorrelationId(): string {
    return crypto.randomUUID();
}

class SimpleDownloadManager {
    private readonly DEFAULT_MAX_ATTEMPTS = 3;
    // Increased timeouts for batch processing (Discovery requests 30+ albums at once)
    private readonly IMPORT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes (large batches need more time)
    private readonly PENDING_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes for pending (batch queuing)

    /**
     * Get max retry attempts from user's discover config, fallback to default
     */
    private async getMaxAttempts(userId: string): Promise<number> {
        try {
            const config = await prisma.userDiscoverConfig.findUnique({
                where: { userId },
            });
            return config?.maxRetryAttempts || this.DEFAULT_MAX_ATTEMPTS;
        } catch {
            return this.DEFAULT_MAX_ATTEMPTS;
        }
    }

    /**
     * Start a new download
     * Returns the correlation ID for webhook matching
     * @param isDiscovery - If true, tags the artist in Lidarr for discovery cleanup
     */
    async startDownload(
        jobId: string,
        artistName: string,
        albumTitle: string,
        albumMbid: string,
        userId: string,
        isDiscovery: boolean = false
    ): Promise<{ success: boolean; correlationId?: string; error?: string }> {
        console.log(`\n Starting download: ${artistName} - ${albumTitle}${isDiscovery ? " (discovery)" : ""}`);
        console.log(`   Job ID: ${jobId}`);
        console.log(`   Album MBID: ${albumMbid}`);

        // Generate correlation ID for webhook matching
        const correlationId = generateCorrelationId();

        try {
            // Fetch artist MBID from MusicBrainz using the album MBID
            let artistMbid: string | undefined;
            try {
                console.log(`   Fetching artist MBID from MusicBrainz...`);
                const releaseGroup = await musicBrainzService.getReleaseGroup(
                    albumMbid
                );

                if (releaseGroup?.["artist-credit"]?.[0]?.artist) {
                    const mbArtist = releaseGroup["artist-credit"][0].artist;
                    const mbArtistName = mbArtist.name || "";
                    const mbArtistId = mbArtist.id;

                    // Validate artist name matches before trusting the MBID
                    // This prevents downloading wrong artist when MusicBrainz data is incorrect
                    const requestedNorm = artistName.toLowerCase().trim();
                    const mbNorm = mbArtistName.toLowerCase().trim();

                    if (mbNorm === requestedNorm || mbNorm.includes(requestedNorm) || requestedNorm.includes(mbNorm)) {
                        artistMbid = mbArtistId;
                        console.log(`   Found artist MBID: ${artistMbid} (${mbArtistName})`);
                    } else {
                        console.warn(`   Artist name mismatch - ignoring MBID`);
                        console.warn(`   Requested: "${artistName}"`);
                        console.warn(`   MusicBrainz returned: "${mbArtistName}" (${mbArtistId})`);
                        console.warn(`   Will use name-based matching instead`);
                        // Don't set artistMbid - let Lidarr use name-based matching
                    }
                } else {
                    console.warn(
                        `   Could not extract artist MBID from release group`
                    );
                }
            } catch (mbError) {
                console.error(
                    `   Failed to fetch artist MBID from MusicBrainz:`,
                    mbError
                );
            }

            // Add album to Lidarr (with discovery tag if this is a discovery download)
            const result = await lidarrService.addAlbum(
                albumMbid,
                artistName,
                albumTitle,
                "/music",
                artistMbid,
                isDiscovery
            );

            if (!result) {
                throw new Error(
                    "Failed to add album to Lidarr - album not found"
                );
            }

            console.log(`   Album queued in Lidarr (ID: ${result.id})`);

            // Lidarr may have matched by name and returned a different MBID
            const actualLidarrMbid = result.foreignAlbumId;
            if (actualLidarrMbid && actualLidarrMbid !== albumMbid) {
                console.log(
                    `   MBID mismatch - original: ${albumMbid}, Lidarr: ${actualLidarrMbid}`
                );
            }

            // Update job with all tracking information
            // IMPORTANT: Preserve existing metadata (especially tier/similarity from discovery jobs)
            const now = new Date();
            const existingJob = await prisma.downloadJob.findUnique({
                where: { id: jobId },
                select: { metadata: true },
            });
            const existingMetadata = (existingJob?.metadata as any) || {};
            
            await prisma.downloadJob.update({
                where: { id: jobId },
                data: {
                    correlationId, // Unique ID for webhook matching
                    status: "processing",
                    startedAt: now, // For timeout tracking (if field exists)
                    lidarrAlbumId: result.id, // Store Lidarr album ID for retry/cleanup
                    artistMbid: artistMbid, // Store artist MBID for same-artist fallback
                    attempts: 1,
                    metadata: {
                        ...existingMetadata, // Preserve tier, similarity, etc.
                        albumTitle,
                        artistName,
                        artistMbid,
                        albumMbid, // Original requested MBID
                        lidarrMbid: actualLidarrMbid, // Actual Lidarr MBID (may differ)
                        downloadType: existingMetadata.downloadType || "library",
                        startedAt: now.toISOString(), // Backup in metadata for timeout tracking
                    },
                },
            });

            console.log(
                `   Download started with correlation ID: ${correlationId}`
            );
            return { success: true, correlationId };
        } catch (error: any) {
            console.error(`   Failed to start download:`, error.message);

            // Get the job to check if it's a discovery job
            const job = await prisma.downloadJob.findUnique({
                where: { id: jobId },
            });

            // If album wasn't found, try same-artist fallback ONLY for non-discovery jobs
            // Discovery jobs should find NEW artists via the discovery system instead
            if (job && error.message?.includes("album not found")) {
                if (job.discoveryBatchId) {
                    console.log(`   Album not found - Discovery job, skipping same-artist fallback`);
                    console.log(`   Discovery system will find a different artist instead`);
                } else {
                    console.log(`   Album not found - trying same-artist fallback...`);

                    // Use the new tryNextAlbumFromArtist approach instead of findReplacementAlbum
                    const metadata = (job.metadata as any) || {};
                    const artistMbid = job.artistMbid || metadata.artistMbid;

                    if (artistMbid) {
                        const fallbackResult = await this.tryNextAlbumFromArtist(
                            { ...job, metadata },
                            "Album not found in Lidarr"
                        );

                        if (fallbackResult.retried && fallbackResult.jobId) {
                            return { success: true, replacedWith: fallbackResult.jobId };
                        }
                    }
                }
            }

            // No replacement found - mark as failed
            await prisma.downloadJob.update({
                where: { id: jobId },
                data: {
                    correlationId,
                    status: "failed",
                    error: error.message || "Failed to add album to Lidarr",
                    completedAt: new Date(),
                },
            });

            // Check batch completion for discovery jobs
            if (job?.discoveryBatchId) {
                const { discoverWeeklyService } = await import("./discoverWeekly");
                await discoverWeeklyService.checkBatchCompletion(job.discoveryBatchId);
            }

            return { success: false, error: error.message };
        }
    }

    /**
     * Handle download grabbed event (from webhook)
     * Links the Lidarr downloadId to our job
     * 
     * IMPORTANT: One logical album = one job, regardless of MBID.
     * MBIDs can differ between MusicBrainz and Lidarr, but artist+album name is canonical.
     */
    async onDownloadGrabbed(
        downloadId: string,
        albumMbid: string,
        albumTitle: string,
        artistName: string,
        lidarrAlbumId: number
    ): Promise<{ matched: boolean; jobId?: string }> {
        console.log(`[DOWNLOAD] Grabbed: ${artistName} - ${albumTitle}`);
        console.log(`   Download ID: ${downloadId}`);
        console.log(`   Album MBID: ${albumMbid}`);
        console.log(`   Lidarr Album ID: ${lidarrAlbumId}`);

        // Get ALL active jobs (pending + processing) for matching
        // Include pending because job might not have transitioned to processing yet
        const activeJobs = await prisma.downloadJob.findMany({
            where: {
                status: { in: ["pending", "processing"] },
            },
        });

        console.log(
            `   Found ${activeJobs.length} active job(s) to match against`
        );

        let job: (typeof activeJobs)[0] | undefined;

        // Normalize artist/album for name-based matching
        const normalizedArtist = artistName?.toLowerCase().trim() || "";
        const normalizedAlbum = albumTitle?.toLowerCase().trim() || "";

        // Strategy 1: Match by targetMbid (exact MBID match)
        job = activeJobs.find(
            (j) => j.targetMbid === albumMbid && !j.lidarrRef
        );
        if (job) {
            console.log(`    Matched by targetMbid`);
        }

        // Strategy 2: Match by lidarrMbid in metadata
        if (!job) {
            job = activeJobs.find((j) => {
                const metadata = j.metadata as any;
                return metadata?.lidarrMbid === albumMbid && !j.lidarrRef;
            });
            if (job) {
                console.log(`    Matched by lidarrMbid`);
            }
        }

        // Strategy 3: Match by lidarrAlbumId (stored when download started)
        if (!job && lidarrAlbumId > 0) {
            job = activeJobs.find((j) => {
                const metadata = j.metadata as any;
                return (
                    (j as any).lidarrAlbumId === lidarrAlbumId ||
                    metadata?.lidarrAlbumId === lidarrAlbumId
                );
            });
            if (job) {
                console.log(`    Matched by lidarrAlbumId`);
            }
        }

        // Strategy 4: Match by artist + album title in metadata (CANONICAL - most important)
        // This handles MBID mismatches between MusicBrainz and Lidarr
        if (!job && normalizedArtist && normalizedAlbum) {
            job = activeJobs.find((j) => {
                if (j.lidarrRef) return false; // Already linked to a different download
                const metadata = j.metadata as any;
                const candidateArtist = metadata?.artistName?.toLowerCase().trim() || "";
                const candidateAlbum = metadata?.albumTitle?.toLowerCase().trim() || "";
                return (
                    candidateArtist === normalizedArtist &&
                    candidateAlbum === normalizedAlbum
                );
            });
            if (job) {
                console.log(`    Matched by artist/album title in metadata`);
            }
        }

        // Strategy 5: Match by subject field (format: "Artist - Album")
        if (!job && normalizedArtist && normalizedAlbum) {
            job = activeJobs.find((j) => {
                if (j.lidarrRef) return false; // Already linked
                const subject = j.subject?.toLowerCase().trim() || "";
                // Check if subject contains BOTH artist AND album (more precise)
                return (
                    subject.includes(normalizedArtist) &&
                    subject.includes(normalizedAlbum)
                );
            });
            if (job) {
                console.log(`    Matched by subject field`);
            }
        }

        // Strategy 6: For retries - update job that already has a different lidarrRef
        if (!job && lidarrAlbumId > 0) {
            job = activeJobs.find((j) => {
                const metadata = j.metadata as any;
                return (
                    ((j as any).lidarrAlbumId === lidarrAlbumId ||
                        metadata?.lidarrAlbumId === lidarrAlbumId) &&
                    j.lidarrRef !== null
                );
            });
            if (job) {
                console.log(`    Matched retry by lidarrAlbumId (updating lidarrRef)`);
            }
        }

        if (!job) {
            // Before creating a new job, do one final check: search ALL active jobs by name
            // This catches jobs that might have been created with different casing or formatting
            console.log(`   No match in active jobs with first pass - doing thorough name search...`);
            
            // Search all active jobs (including ones we might have filtered out)
            for (const j of activeJobs) {
                if (j.lidarrRef) continue; // Already linked
                
                const metadata = j.metadata as any;
                const candidateArtist = metadata?.artistName?.toLowerCase().trim() || "";
                const candidateAlbum = metadata?.albumTitle?.toLowerCase().trim() || "";
                const subject = j.subject?.toLowerCase().trim() || "";
                
                // More lenient matching - check metadata OR subject
                const artistMatches = 
                    candidateArtist === normalizedArtist || 
                    (normalizedArtist && subject.includes(normalizedArtist));
                const albumMatches = 
                    candidateAlbum === normalizedAlbum || 
                    (normalizedAlbum && subject.includes(normalizedAlbum));
                
                if (artistMatches && albumMatches) {
                    console.log(`    Found existing job by thorough name search: ${j.id}`);
                    job = j;
                    break;
                }
            }
        }

        if (!job) {
            // Still no match - this is truly an external download or timing issue
            // Create a tracking job, but first check we're not creating a duplicate
            console.log(`   No matching job found - checking for duplicates before creating tracking job`);

            // Check if there's already a tracking job for this exact download
            const existingTrackingJob = await prisma.downloadJob.findFirst({
                where: {
                    lidarrRef: downloadId,
                },
            });

            if (existingTrackingJob) {
                console.log(`   Tracking job already exists: ${existingTrackingJob.id}`);
                return { matched: true, jobId: existingTrackingJob.id };
            }

            // Check if there's a job for this artist+album that we somehow missed
            const duplicateCheck = await prisma.downloadJob.findFirst({
                where: {
                    status: { in: ["pending", "processing"] },
                    OR: [
                        { targetMbid: albumMbid },
                        { lidarrAlbumId: lidarrAlbumId > 0 ? lidarrAlbumId : undefined },
                    ],
                },
            });

            if (duplicateCheck) {
                console.log(`   Found job by MBID/lidarrAlbumId: ${duplicateCheck.id} - linking instead of creating new`);
                job = duplicateCheck;
            }
        }

        if (!job) {
            // Truly no existing job - create tracking job for retry support
            console.log(`   Creating tracking job for untracked download`);

            try {
                // Find the user from a recent artist download request
                const recentJob = await prisma.downloadJob.findFirst({
                    where: {
                        type: "artist",
                        status: { in: ["pending", "processing", "completed"] },
                        metadata: {
                            path: ["artistName"],
                            string_contains: artistName,
                        },
                    },
                    orderBy: { createdAt: "desc" },
                });

                const userId = recentJob?.userId;

                if (userId) {
                    const newJob = await prisma.downloadJob.create({
                        data: {
                            userId,
                            subject: `${artistName} - ${albumTitle}`,
                            type: "album",
                            targetMbid: albumMbid,
                            status: "processing",
                            lidarrRef: downloadId,
                            lidarrAlbumId,
                            attempts: 1,
                            metadata: {
                                artistName,
                                albumTitle,
                                downloadId,
                                grabbedAt: new Date().toISOString(),
                                source: "lidarr-auto-grab",
                            },
                        },
                    });
                    console.log(`   Created tracking job: ${newJob.id}`);
                    return { matched: true, jobId: newJob.id };
                } else {
                    console.log(`   Could not determine user, skipping job creation`);
                    return { matched: false };
                }
            } catch (error: any) {
                console.log(`   Failed to create tracking job: ${error.message}`);
                return { matched: false };
            }
        }

        // Update job with Lidarr reference and ensure status is processing
        await prisma.downloadJob.update({
            where: { id: job.id },
            data: {
                status: "processing", // Ensure status is processing (might have been pending)
                lidarrRef: downloadId,
                lidarrAlbumId,
                targetMbid: job.targetMbid || albumMbid, // Keep original or use Lidarr's
                metadata: {
                    ...((job.metadata as any) || {}),
                    downloadId,
                    lidarrMbid: albumMbid, // Store Lidarr's MBID for future matching
                    grabbedAt: new Date().toISOString(),
                },
            },
        });

        console.log(`   Linked to job: ${job.id}`);
        return { matched: true, jobId: job.id };
    }

    /**
     * Handle download complete event (from webhook)
     * 
     * IMPORTANT: One logical album = one job. Match by name if MBID doesn't match.
     */
    async onDownloadComplete(
        downloadId: string,
        albumMbid?: string,
        artistName?: string,
        albumTitle?: string,
        lidarrAlbumId?: number
    ): Promise<{ jobId?: string; batchId?: string; downloadBatchId?: string }> {
        console.log(`\n[COMPLETE] Download completed: ${downloadId}`);
        if (albumMbid) console.log(`   Album MBID: ${albumMbid}`);
        if (lidarrAlbumId) console.log(`   Lidarr Album ID: ${lidarrAlbumId}`);
        if (artistName && albumTitle)
            console.log(`   Album: ${artistName} - ${albumTitle}`);

        // Get ALL active jobs (pending + processing) for matching
        const activeJobs = await prisma.downloadJob.findMany({
            where: { status: { in: ["pending", "processing"] } },
        });

        console.log(
            `   Found ${activeJobs.length} active job(s) to match against`
        );

        // Normalize for name matching
        const normalizedArtist = artistName?.toLowerCase().trim() || "";
        const normalizedAlbum = albumTitle?.toLowerCase().trim() || "";

        let job: (typeof activeJobs)[0] | undefined;
        let matchedJobs: (typeof activeJobs) = [];

        // Strategy 1: Find job by lidarrRef (most reliable)
        job = activeJobs.find((j) => j.lidarrRef === downloadId);
        if (job) console.log(`    Matched by lidarrRef`);

        // Strategy 2: Find job by lidarrAlbumId
        if (!job && lidarrAlbumId) {
            job = activeJobs.find((j) => j.lidarrAlbumId === lidarrAlbumId);
            if (job) console.log(`    Matched by lidarrAlbumId`);
        }

        // Strategy 3: Match by previousDownloadIds (for retried downloads)
        if (!job) {
            job = activeJobs.find((j) => {
                const metadata = j.metadata as any;
                const prevIds = metadata?.previousDownloadIds as string[] | undefined;
                return prevIds?.includes(downloadId);
            });
            if (job) console.log(`    Matched by previousDownloadIds`);
        }

        // Strategy 4: Match by MBID (targetMbid or lidarrMbid in metadata)
        if (!job && albumMbid) {
            job = activeJobs.find((j) => j.targetMbid === albumMbid);
            if (job) {
                console.log(`    Matched by targetMbid`);
            } else {
                job = activeJobs.find((j) => {
                    const metadata = j.metadata as any;
                    return metadata?.lidarrMbid === albumMbid;
                });
                if (job) console.log(`    Matched by lidarrMbid in metadata`);
            }
        }

        // Strategy 5: Match by artist+album name (CANONICAL - handles MBID mismatches)
        if (!job && normalizedArtist && normalizedAlbum) {
            // Find ALL jobs matching this artist+album (we'll dedupe after)
            matchedJobs = activeJobs.filter((j) => {
                const metadata = j.metadata as any;
                const candidateArtist = metadata?.artistName?.toLowerCase().trim() || "";
                const candidateAlbum = metadata?.albumTitle?.toLowerCase().trim() || "";
                const subject = j.subject?.toLowerCase().trim() || "";
                
                // Match by metadata or subject
                const metaMatch = candidateArtist === normalizedArtist && candidateAlbum === normalizedAlbum;
                const subjectMatch = subject.includes(normalizedArtist) && subject.includes(normalizedAlbum);
                
                return metaMatch || subjectMatch;
            });

            if (matchedJobs.length > 0) {
                // Pick the first one (oldest), will clean up duplicates below
                job = matchedJobs[0];
                console.log(`    Matched by artist/album name (found ${matchedJobs.length} matching job(s))`);
            }
        }

        // Strategy 6: Match by subject containing artist (last resort)
        if (!job && normalizedArtist) {
            job = activeJobs.find((j) => {
                const subject = j.subject?.toLowerCase().trim() || "";
                return subject.includes(normalizedArtist);
            });
            if (job) console.log(`    Matched by subject containing artist`);
        }

        if (!job) {
            console.log(`   No matching job found for downloadId: ${downloadId}`);
            return {};
        }

        // Clean up duplicate jobs for the same artist+album
        // Mark extras as completed too (they're the same logical download)
        // Always search for duplicates, regardless of how we found the primary job
        const jobMeta = job.metadata as any;
        const jobArtist = jobMeta?.artistName?.toLowerCase().trim() || "";
        const jobAlbum = jobMeta?.albumTitle?.toLowerCase().trim() || "";
        const jobSubject = job.subject?.toLowerCase().trim() || "";
        
        const duplicateJobs = activeJobs.filter((j) => {
            if (j.id === job.id) return false; // Skip the matched job
            
            const meta = j.metadata as any;
            const candArtist = meta?.artistName?.toLowerCase().trim() || "";
            const candAlbum = meta?.albumTitle?.toLowerCase().trim() || "";
            const candSubject = j.subject?.toLowerCase().trim() || "";
            
            // Match by metadata
            if (jobArtist && jobAlbum && candArtist === jobArtist && candAlbum === jobAlbum) {
                return true;
            }
            
            // Match by subject
            if (jobSubject && candSubject === jobSubject) {
                return true;
            }
            
            // Match if subjects contain both artist and album
            if (jobArtist && jobAlbum && candSubject.includes(jobArtist) && candSubject.includes(jobAlbum)) {
                return true;
            }
            
            return false;
        });
        
        if (duplicateJobs.length > 0) {
            console.log(`   Found ${duplicateJobs.length} duplicate job(s) for same album - marking as completed`);
            const duplicateIds = duplicateJobs.map(j => j.id);
            await prisma.downloadJob.updateMany({
                where: { id: { in: duplicateIds } },
                data: {
                    status: "completed",
                    completedAt: new Date(),
                    error: null,
                },
            });
        }

        // Mark job as completed (clear any previous error messages)
        await prisma.downloadJob.update({
            where: { id: job.id },
            data: {
                status: "completed",
                completedAt: new Date(),
                error: null, // Clear any timeout errors since download succeeded
                metadata: {
                    ...((job.metadata as any) || {}),
                    completedAt: new Date().toISOString(),
                },
            },
        });

        console.log(`   Job ${job.id} marked complete`);

        // Send notification for completed download (skip for discovery/import batches)
        // Also skip if notification was already sent (dedup for same artist+album)
        const meta = job.metadata as any;
        const isDiscovery = meta?.downloadType === "discovery";
        const isSpotifyImport = !!meta?.spotifyImportJobId;
        const notificationAlreadySent = meta?.notificationSent === true;
        
        if (!isDiscovery && !isSpotifyImport && !notificationAlreadySent) {
            try {
                await notificationService.notifyDownloadComplete(
                    job.userId,
                    job.subject,
                    undefined,
                    meta?.artistId
                );
                
                // Mark notification as sent to prevent duplicates
                await prisma.downloadJob.update({
                    where: { id: job.id },
                    data: {
                        metadata: {
                            ...meta,
                            notificationSent: true,
                        },
                    },
                });
            } catch (notifError) {
                console.error("Failed to send download notification:", notifError);
            }
        }

        const metadata = job.metadata as any;
        const downloadBatchId = metadata?.batchId as string | undefined;
        const spotifyImportJobId = metadata?.spotifyImportJobId as string | undefined;

        // Check if part of discovery batch
        if (job.discoveryBatchId) {
            console.log(`   Part of Discovery batch: ${job.discoveryBatchId}`);
            // Use dynamic import to avoid circular dependency
            const { discoverWeeklyService } = await import("./discoverWeekly");
            await discoverWeeklyService.checkBatchCompletion(
                job.discoveryBatchId
            );
            return {
                jobId: job.id,
                batchId: job.discoveryBatchId,
                downloadBatchId,
            };
        }

        // Check if part of Spotify import
        if (spotifyImportJobId) {
            console.log(`   Part of Spotify Import: ${spotifyImportJobId}`);
            // Use dynamic import to avoid circular dependency
            const { spotifyImportService } = await import("./spotifyImport");
            await spotifyImportService.checkImportCompletion(spotifyImportJobId);
            return {
                jobId: job.id,
                spotifyImportJobId,
                downloadBatchId,
            };
        }

        // Check if part of download batch (artist download)
        if (downloadBatchId) {
            console.log(`   Part of download batch: ${downloadBatchId}`);
        }

        return { jobId: job.id, downloadBatchId };
    }

    // Track recently processed failure events to prevent duplicate handling
    private processedFailures = new Map<string, number>();
    private readonly FAILURE_DEDUP_WINDOW_MS = 30000; // 30 seconds

    /**
     * Handle import failure - LET LIDARR HANDLE RELEASE ITERATION
     *
     * Strategy:
     * 1. Blocklist the failed release with skipRedownload=false (Lidarr searches for alternatives)
     * 2. Track the failure but DON'T limit retries - let Lidarr exhaust all releases
     * 3. Only intervene when Lidarr has NO more releases (detected via stale job timeout)
     * 4. At that point, try a different album from the same artist
     */
    async onImportFailed(
        downloadId: string,
        reason: string,
        albumMbid?: string
    ): Promise<{ retried: boolean; failed: boolean; jobId?: string }> {
        console.log(`\n[RETRY] Import failed: ${downloadId}`);
        console.log(`   Reason: ${reason}`);

        // Deduplicate failure events - same downloadId within 30 seconds
        const now = Date.now();
        const lastProcessed = this.processedFailures.get(downloadId);
        if (
            lastProcessed &&
            now - lastProcessed < this.FAILURE_DEDUP_WINDOW_MS
        ) {
            console.log(
                `   Duplicate failure event (within ${
                    this.FAILURE_DEDUP_WINDOW_MS / 1000
                }s), skipping`
            );
            return { retried: false, failed: false };
        }
        this.processedFailures.set(downloadId, now);

        // Clean up old entries periodically
        if (this.processedFailures.size > 100) {
            for (const [id, time] of this.processedFailures) {
                if (now - time > this.FAILURE_DEDUP_WINDOW_MS * 2) {
                    this.processedFailures.delete(id);
                }
            }
        }

        // Find all processing jobs to match against
        const processingJobs = await prisma.downloadJob.findMany({
            where: { status: "processing" },
        });

        let job: (typeof processingJobs)[0] | undefined;

        // Strategy 1: Match by current lidarrRef
        job = processingJobs.find((j) => j.lidarrRef === downloadId);
        if (job) console.log(`    Matched by lidarrRef`);

        // Strategy 2: Match by previousDownloadIds in metadata
        if (!job) {
            job = processingJobs.find((j) => {
                const metadata = j.metadata as any;
                const prevIds = metadata?.previousDownloadIds as
                    | string[]
                    | undefined;
                return prevIds?.includes(downloadId);
            });
            if (job) console.log(`    Matched by previousDownloadIds`);
        }

        // Strategy 3: Match by MBID
        if (!job && albumMbid) {
            job = processingJobs.find((j) => j.targetMbid === albumMbid);
            if (job) console.log(`    Matched by albumMbid`);
        }

        if (!job) {
            console.log(
                `   No matching job found - cleaning up Lidarr queue anyway`
            );
            // Still try to remove from Lidarr queue to prevent it from being stuck
            await this.removeFromLidarrQueue(downloadId);
            return { retried: false, failed: false };
        }

        console.log(`   Found job: ${job.id}`);
        console.log(`   Album: ${job.subject}`);

        // ============================================
        // LET LIDARR HANDLE RELEASE ITERATION
        // ============================================
        // Blocklist current release and let Lidarr search for alternatives
        // skipRedownload=false means Lidarr will automatically search for another release

        const metadata = (job.metadata as any) || {};
        const failureCount = (metadata.failureCount || 0) + 1;
        const previousDownloadIds = metadata.previousDownloadIds || [];
        if (downloadId && !previousDownloadIds.includes(downloadId)) {
            previousDownloadIds.push(downloadId);
        }

        // Update job with failure tracking (no retry limit - let Lidarr exhaust options)
        await prisma.downloadJob.update({
            where: { id: job.id },
            data: {
                lidarrRef: null, // Clear - we'll get a new one from Lidarr's next grab
                metadata: {
                    ...metadata,
                    failureCount,
                    lastError: reason,
                    lastFailureAt: new Date().toISOString(),
                    previousDownloadIds,
                },
            },
        });

        console.log(`   Failure #${failureCount} - blocklisting and letting Lidarr find alternative`);

        // Blocklist with skipRedownload=false so Lidarr searches for alternatives
        await this.removeFromLidarrQueue(downloadId);

        // For Spotify Import jobs, check if this failure completes the import
        // (Unlike regular downloads, we don't do fallback, so failure might mean completion)
        if (metadata.spotifyImportJobId) {
            // Don't check immediately - let Lidarr try alternative releases first
            // The stale job cleanup will eventually mark it as exhausted
        }

        return { retried: true, failed: false, jobId: job.id };
    }

    /**
     * Try the next album from the same artist when current album is exhausted
     * This is called when all releases for an album have been tried
     * 
     * IMPORTANT: 
     * - For Discovery Weekly jobs, we DON'T do same-artist fallback.
     *   Discovery should find NEW artists, not more albums from the same artist.
     * - For Spotify Import jobs, we DON'T do same-artist fallback.
     *   User wants EXACT playlist, not substitutes.
     */
    private async tryNextAlbumFromArtist(
        job: any,
        reason: string
    ): Promise<{ retried: boolean; failed: boolean; jobId?: string }> {
        const metadata = (job.metadata as any) || {};
        const artistMbid = job.artistMbid || metadata.artistMbid;
        const artistName = metadata.artistName;

        // CRITICAL: For Discovery Weekly, DON'T try same-artist fallback
        // Discovery should prioritize ARTIST DIVERSITY - let the discovery system
        // find a completely different artist instead
        if (job.discoveryBatchId) {
            console.log(`[RETRY] Discovery job - skipping same-artist fallback (diversity enforced)`);
            console.log(`   Discovery should find NEW artists, not more from: ${artistName}`);
            return await this.markJobExhausted(job, reason);
        }

        // CRITICAL: For Spotify Import, DON'T try same-artist fallback
        // User wants the EXACT playlist, not substitutes from same artist
        if (metadata.spotifyImportJobId || metadata.downloadType === "spotify_import" || metadata.noFallback) {
            console.log(`[RETRY] Spotify Import job - skipping fallback (exact match required)`);
            console.log(`   User wants exact album: ${job.subject}`);
            
            // Mark as failed and trigger completion check
            const result = await this.markJobExhausted(job, reason);
            
            // Check if import is complete
            if (metadata.spotifyImportJobId) {
                const { spotifyImportService } = await import("./spotifyImport");
                await spotifyImportService.checkImportCompletion(metadata.spotifyImportJobId);
            }
            
            return result;
        }

        if (!artistMbid) {
            console.log(`   No artistMbid - cannot try other albums from same artist`);
            return await this.markJobExhausted(job, reason);
        }

        console.log(`[RETRY] Trying other albums from artist: ${artistName || artistMbid}`);

        try {
            // Get albums available in LIDARR for this artist (not MusicBrainz)
            // MusicBrainz has many obscure albums (bootlegs, live recordings) that Lidarr can't find
            const lidarrAlbums = await lidarrService.getArtistAlbums(artistMbid);
            
            if (!lidarrAlbums || lidarrAlbums.length === 0) {
                console.log(`   No albums found in Lidarr for artist`);
                return await this.markJobExhausted(job, reason);
            }

            console.log(`   Found ${lidarrAlbums.length} albums in Lidarr for artist`);

            // Get albums we've already tried
            const triedAlbumMbids = new Set<string>();
            
            // Check for other jobs with same artist
            const artistJobs = await prisma.downloadJob.findMany({
                where: {
                    artistMbid: artistMbid,
                    status: { in: ["processing", "completed", "failed", "exhausted"] },
                },
            });
            artistJobs.forEach((j: any) => {
                triedAlbumMbids.add(j.targetMbid);
            });
            
            // Also add current job's album
            triedAlbumMbids.add(job.targetMbid);

            // Filter to untried albums that exist in Lidarr
            const untriedAlbums = lidarrAlbums.filter(
                (album: any) => !triedAlbumMbids.has(album.foreignAlbumId)
            );

            console.log(`   Untried albums in Lidarr: ${untriedAlbums.length}`);

            if (untriedAlbums.length === 0) {
                console.log(`   All Lidarr albums from artist exhausted`);
                return await this.markJobExhausted(job, reason);
            }

            // Pick the first untried album (prioritize studio albums over singles/EPs if possible)
            const studioAlbums = untriedAlbums.filter((a: any) => 
                a.albumType?.toLowerCase() === 'album' || 
                !a.albumType
            );
            const nextAlbum = studioAlbums.length > 0 ? studioAlbums[0] : untriedAlbums[0];
            console.log(`[RETRY] Trying next album from same artist: ${nextAlbum.title}`);

            // Mark current job as exhausted (not failed - we're continuing with same artist)
            await prisma.downloadJob.update({
                where: { id: job.id },
                data: {
                    status: "exhausted",
                    error: `All releases exhausted - trying: ${nextAlbum.title}`,
                    completedAt: new Date(),
                },
            });

            // Use Lidarr's foreignAlbumId (MBID) for the new job
            const albumMbid = nextAlbum.foreignAlbumId;

            // Create new job for the next album
            const newJob = await prisma.downloadJob.create({
                data: {
                    userId: job.userId,
                    subject: `${artistName || 'Unknown'} - ${nextAlbum.title}`,
                    type: "album",
                    targetMbid: albumMbid,
                    status: "pending",
                    discoveryBatchId: job.discoveryBatchId,
                    artistMbid: artistMbid,
                    metadata: {
                        artistName: artistName,
                        artistMbid: artistMbid,
                        albumTitle: nextAlbum.title,
                        albumMbid: albumMbid,
                        lidarrAlbumId: nextAlbum.id, // Store Lidarr album ID for faster lookup
                        sameArtistFallback: true,
                        originalJobId: job.id,
                        downloadType: metadata.downloadType || "library",
                        rootFolderPath: metadata.rootFolderPath || "/music",
                    },
                },
            });

            console.log(`   Created fallback job: ${newJob.id}`);

            // Start the download
            const result = await this.startDownload(
                newJob.id,
                artistName || "Unknown Artist",
                nextAlbum.title,
                albumMbid,
                job.userId
            );

            if (result.success) {
                console.log(`   Same-artist fallback download started`);
                return { retried: true, failed: false, jobId: newJob.id };
            } else {
                console.log(`   Same-artist fallback failed to start: ${result.error}`);
                // The new job will be marked as failed by startDownload
                return { retried: false, failed: true, jobId: newJob.id };
            }
        } catch (error: any) {
            console.error(`   Error trying same-artist fallback: ${error.message}`);
            return await this.markJobExhausted(job, reason);
        }
    }

    /**
     * Mark a job as exhausted (all releases and same-artist albums tried)
     * 
     * IMPORTANT: Before failing, check if another job for the same album already succeeded.
     * This handles race conditions where duplicates exist and one succeeds.
     */
    private async markJobExhausted(
        job: any,
        reason: string
    ): Promise<{ retried: boolean; failed: boolean; jobId?: string }> {
        console.log(`[RETRY] Job fully exhausted: ${job.id}`);

        const meta = job.metadata as any;
        const artistName = meta?.artistName?.toLowerCase().trim() || "";
        const albumTitle = meta?.albumTitle?.toLowerCase().trim() || "";

        // Before marking as failed, check if another job for the same album already SUCCEEDED
        // This handles duplicate job scenarios
        if (artistName && albumTitle) {
            const completedDuplicate = await prisma.downloadJob.findFirst({
                where: {
                    id: { not: job.id },
                    status: "completed",
                },
            });

            if (completedDuplicate) {
                const dupMeta = completedDuplicate.metadata as any;
                const dupArtist = dupMeta?.artistName?.toLowerCase().trim() || "";
                const dupAlbum = dupMeta?.albumTitle?.toLowerCase().trim() || "";
                
                if (dupArtist === artistName && dupAlbum === albumTitle) {
                    console.log(`   Found completed duplicate job ${completedDuplicate.id} - marking this as completed too`);
                    await prisma.downloadJob.update({
                        where: { id: job.id },
                        data: {
                            status: "completed",
                            completedAt: new Date(),
                            error: null,
                            metadata: {
                                ...meta,
                                mergedWithJob: completedDuplicate.id,
                            },
                        },
                    });
                    return { retried: false, failed: false, jobId: job.id };
                }
            }
        }

        await prisma.downloadJob.update({
            where: { id: job.id },
            data: {
                status: "failed",
                error: `All releases and albums exhausted: ${reason}`,
                completedAt: new Date(),
            },
        });

        // Check batch completion for discovery jobs
        if (job.discoveryBatchId) {
            const { discoverWeeklyService } = await import("./discoverWeekly");
            await discoverWeeklyService.checkBatchCompletion(job.discoveryBatchId);
        }

        // Send failure notification ONLY if:
        // 1. Not discovery/spotify import
        // 2. Notification not already sent for this job
        // 3. No other job for the same album has already notified
        const isDiscovery = meta?.downloadType === "discovery";
        const isSpotifyImport = !!meta?.spotifyImportJobId;
        const notificationAlreadySent = meta?.notificationSent === true;
        
        if (!isDiscovery && !isSpotifyImport && !notificationAlreadySent) {
            // Check if any OTHER job for this album already sent a notification
            const otherNotified = await prisma.downloadJob.findFirst({
                where: {
                    id: { not: job.id },
                    userId: job.userId,
                    metadata: {
                        path: ["artistName"],
                        string_contains: meta?.artistName || "",
                    },
                },
            });

            let skipNotification = false;
            if (otherNotified) {
                const otherMeta = otherNotified.metadata as any;
                if (otherMeta?.notificationSent && 
                    otherMeta?.albumTitle?.toLowerCase() === albumTitle) {
                    skipNotification = true;
                    console.log(`   Skipping notification - another job already notified for this album`);
                }
            }

            if (!skipNotification) {
                try {
                    await notificationService.notifyDownloadFailed(
                        job.userId,
                        job.subject,
                        reason
                    );
                    
                    // Mark notification as sent
                    await prisma.downloadJob.update({
                        where: { id: job.id },
                        data: {
                            metadata: {
                                ...meta,
                                notificationSent: true,
                            },
                        },
                    });
                } catch (notifError) {
                    console.error("Failed to send failure notification:", notifError);
                }
            }
        }

        return { retried: false, failed: true, jobId: job.id };
    }
    // Timeout for "no sources" - if Lidarr hasn't grabbed anything after searching
    private readonly NO_SOURCE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes (indexer searches can be slow)

    /**
     * Mark stale jobs as failed (called by cleanup job)
     * - Pending jobs (never started) timeout after 3 minutes = "download never started"
     * - Processing jobs with no lidarrRef (never grabbed) timeout after 2 minutes = "no sources found"
     * - Processing jobs with lidarrRef (grabbed but not imported) timeout after 5 minutes = "import failed"
     */
    async markStaleJobsAsFailed(): Promise<number> {
        const pendingCutoff = new Date(Date.now() - this.PENDING_TIMEOUT_MS); // 30 minutes for pending (batch processing)
        const noSourceCutoff = new Date(Date.now() - this.NO_SOURCE_TIMEOUT_MS);
        const importCutoff = new Date(Date.now() - this.IMPORT_TIMEOUT_MS);

        // Find all pending and processing jobs
        const activeJobs = await prisma.downloadJob.findMany({
            where: { status: { in: ["pending", "processing"] } },
        });

        // Log to session for debugging Spotify imports
        if (activeJobs.length > 0) {
            const spotifyJobs = activeJobs.filter(j => j.id.startsWith("spotify_"));
            if (spotifyJobs.length > 0) {
                sessionLog('CLEANUP', `Checking ${activeJobs.length} active jobs (${spotifyJobs.length} Spotify import)`);
            }
        }

        // Separate pending from processing
        const pendingJobs = activeJobs.filter(j => j.status === "pending");
        const processingJobs = activeJobs.filter(j => j.status === "processing");

        // Handle old pending jobs first (they never started)
        const stalePendingJobs = pendingJobs.filter(job => job.createdAt < pendingCutoff);

        if (stalePendingJobs.length > 0) {
            console.log(`\n⏰ Found ${stalePendingJobs.length} stuck PENDING jobs (never started)`);
            sessionLog('CLEANUP', `Found ${stalePendingJobs.length} stuck PENDING jobs`);

            for (const job of stalePendingJobs) {
                console.log(`   Timing out: ${job.subject} (never started - ${Math.round((Date.now() - job.createdAt.getTime()) / 60000)}m old)`);
                
                // Mark as failed
                await prisma.downloadJob.update({
                    where: { id: job.id },
                    data: {
                        status: "failed",
                        error: "Download never started - timed out",
                        completedAt: new Date(),
                    },
                });

                // Check batch completion for discovery jobs
                if (job.discoveryBatchId) {
                    const { discoverWeeklyService } = await import("./discoverWeekly");
                    await discoverWeeklyService.checkBatchCompletion(job.discoveryBatchId);
                }
            }
        }

        if (processingJobs.length === 0) {
            return 0;
        }

        const staleJobs: typeof processingJobs = [];

        // Import lidarr service for active download check
        const { isDownloadActive } = await import("./lidarr");

        for (const job of processingJobs) {
            const metadata = job.metadata as any;
            const startedAt = metadata?.startedAt
                ? new Date(metadata.startedAt)
                : job.createdAt;

            // Skip Soulseek jobs - they complete immediately with direct slsk-client
            // Old SLSKD jobs used source: "slskd", new direct jobs use source: "soulseek_direct"
            if (metadata?.source === "slskd" || metadata?.source === "soulseek_direct") {
                console.log(`   ${job.subject}: Soulseek download, skipping stale check`);
                sessionLog('CLEANUP', `Skipping Soulseek job: ${job.subject} (status: ${job.status})`);
                continue;
            }

            // Jobs without lidarrRef = Lidarr never grabbed = no sources found
            if (!job.lidarrRef) {
                if (startedAt < noSourceCutoff) {
                    staleJobs.push(job);
                }
            } else {
                // Jobs with lidarrRef = grabbed but potentially still downloading
                if (startedAt < importCutoff) {
                    // Check if Lidarr is still actively downloading before timing out
                    const downloadStatus = await isDownloadActive(job.lidarrRef);
                    
                    if (downloadStatus.active) {
                        // Still downloading - extend the timeout, don't mark as stale
                        console.log(`   ${job.subject}: Still downloading (${downloadStatus.progress || 0}%), extending timeout`);
                        
                        // Update the startedAt to extend the timeout
                        await prisma.downloadJob.update({
                            where: { id: job.id },
                            data: {
                                metadata: {
                                    ...metadata,
                                    startedAt: new Date().toISOString(),
                                    extendedTimeout: true,
                                }
                            }
                        });
                    } else {
                        // Not actively downloading - mark as stale
                        staleJobs.push(job);
                    }
                }
            }
        }

        if (staleJobs.length === 0) {
            return 0;
        }

        console.log(`\n⏰ Found ${staleJobs.length} stale download jobs`);
        sessionLog('CLEANUP', `Found ${staleJobs.length} stale jobs to mark as failed`);

        // Track unique batch IDs to check
        const batchIds = new Set<string>();
        const downloadBatchIds = new Set<string>();

        for (const job of staleJobs) {
            const hasLidarrRef = !!job.lidarrRef;
            const errorMessage = hasLidarrRef
                ? `Import failed - download stuck for ${
                      this.IMPORT_TIMEOUT_MS / 60000
                  } minutes`
                : `No sources found - no indexer results`;

            console.log(
                `   Timing out: ${job.subject} (${
                    hasLidarrRef ? "stuck import" : "no sources"
                })`
            );
            sessionLog('CLEANUP', `Marking stale: ${job.subject} - ${errorMessage}`);

            const metadata = (job.metadata as any) || {};
            const artistName = metadata?.artistName?.toLowerCase().trim() || "";
            const albumTitle = metadata?.albumTitle?.toLowerCase().trim() || "";

            // FIRST: Check if a COMPLETED job already exists for this album
            // This handles the case where a duplicate job succeeded while this one was processing
            if (artistName && albumTitle) {
                const completedDuplicate = await prisma.downloadJob.findFirst({
                    where: {
                        id: { not: job.id },
                        status: "completed",
                    },
                });

                if (completedDuplicate) {
                    const dupMeta = completedDuplicate.metadata as any;
                    const dupArtist = dupMeta?.artistName?.toLowerCase().trim() || "";
                    const dupAlbum = dupMeta?.albumTitle?.toLowerCase().trim() || "";
                    
                    if (dupArtist === artistName && dupAlbum === albumTitle) {
                        console.log(`   Found completed duplicate - marking this job as completed too`);
                        await prisma.downloadJob.update({
                            where: { id: job.id },
                            data: {
                                status: "completed",
                                completedAt: new Date(),
                                error: null,
                                metadata: {
                                    ...metadata,
                                    mergedWithJob: completedDuplicate.id,
                                },
                            },
                        });
                        continue; // Skip to next stale job
                    }
                }
            }

            // Clean up from Lidarr queue if possible
            const lidarrAlbumId = (job as any).lidarrAlbumId;
            if (lidarrAlbumId && job.lidarrRef) {
                await this.blocklistAndRetry(job.lidarrRef, lidarrAlbumId);
            }

            // Use same-artist fallback ONLY for non-discovery jobs
            // Discovery jobs should find NEW artists via the discovery system
            let replacementStarted = false;
            const artistMbid = job.artistMbid || metadata.artistMbid;

            if (artistMbid && !job.discoveryBatchId) {
                console.log(`   Attempting same-artist fallback...`);
                try {
                    const fallbackResult = await this.tryNextAlbumFromArtist(
                        { ...job, metadata },
                        errorMessage
                    );
                    if (fallbackResult.retried && fallbackResult.jobId) {
                        console.log(`   Same-artist fallback started: ${fallbackResult.jobId}`);
                        replacementStarted = true;
                    }
                } catch (fallbackErr: any) {
                    console.error(`   Same-artist fallback error: ${fallbackErr.message}`);
                }
            } else if (job.discoveryBatchId) {
                console.log(`   Discovery job - letting discovery system find new artist`);
            }

            // If no replacement was started, mark the original job as failed
            // NOTE: No notification here - stale cleanup is a background safety net
            // Notifications are only sent from markJobExhausted when truly exhausted
            if (!replacementStarted) {
                await prisma.downloadJob.update({
                    where: { id: job.id },
                    data: {
                        status: "failed",
                        error: errorMessage,
                        completedAt: new Date(),
                    },
                });
            }

            if (job.discoveryBatchId) {
                batchIds.add(job.discoveryBatchId);
            }

            // Track download batch IDs for artist downloads
            if (metadata?.batchId) {
                downloadBatchIds.add(metadata.batchId);
            }
        }

        // Check discovery batch completion for affected batches
        if (batchIds.size > 0) {
            const { discoverWeeklyService } = await import("./discoverWeekly");
            for (const batchId of batchIds) {
                console.log(
                    `   Checking discovery batch completion: ${batchId}`
                );
                await discoverWeeklyService.checkBatchCompletion(batchId);
            }
        }

        return staleJobs.length;
    }

    /**
     * Blocklist a failed release and let Lidarr search for alternatives
     * skipRedownload=false tells Lidarr to automatically search for another release
     */
    private async blocklistAndRetry(downloadId: string, _lidarrAlbumId: number) {
        try {
            const settings = await getSystemSettings();
            if (!settings?.lidarrUrl || !settings?.lidarrApiKey) return;

            // Get queue to find the specific release
            try {
                const queueResponse = await axios.get(
                    `${settings.lidarrUrl}/api/v1/queue`,
                    {
                        headers: { "X-Api-Key": settings.lidarrApiKey },
                        timeout: 10000,
                    }
                );

                const queueItem = queueResponse.data.records?.find(
                    (item: any) => item.downloadId === downloadId
                );

                if (queueItem) {
                    // Remove from queue with blocklist=true and skipRedownload=false
                    // Lidarr will automatically search for another release
                    await axios.delete(
                        `${settings.lidarrUrl}/api/v1/queue/${queueItem.id}?removeFromClient=true&blocklist=true&skipRedownload=false`,
                        {
                            headers: { "X-Api-Key": settings.lidarrApiKey },
                            timeout: 10000,
                        }
                    );
                    console.log(`   Blocklisted release, Lidarr searching for alternative`);
                }
            } catch (queueError: any) {
                // Queue item may have already been removed
                console.log(`   Queue cleanup: ${queueError.message}`);
            }
        } catch (error: any) {
            console.error(`   Blocklist/retry failed:`, error.message);
        }
    }

    /**
     * Remove a failed download from Lidarr's queue (without retrying)
     * Used when we don't have a tracking job but still need to clean up
     */
    private async removeFromLidarrQueue(downloadId: string) {
        try {
            const settings = await getSystemSettings();
            if (!settings?.lidarrUrl || !settings?.lidarrApiKey) return;

            const queueResponse = await axios.get(
                `${settings.lidarrUrl}/api/v1/queue`,
                {
                    headers: { "X-Api-Key": settings.lidarrApiKey },
                    timeout: 10000,
                }
            );

            const queueItem = queueResponse.data.records?.find(
                (item: any) => item.downloadId === downloadId
            );

            if (queueItem) {
                // Remove from queue with blocklist=true and skipRedownload=false
                // skipRedownload=false tells Lidarr to search for another release
                await axios.delete(
                    `${settings.lidarrUrl}/api/v1/queue/${queueItem.id}?removeFromClient=true&blocklist=true&skipRedownload=false`,
                    {
                        headers: { "X-Api-Key": settings.lidarrApiKey },
                        timeout: 10000,
                    }
                );
                console.log(`   Removed from Lidarr queue, blocklisted, triggering new search`);
            } else {
                console.log(
                    `   Item not found in Lidarr queue (may already be removed)`
                );
            }
        } catch (error: any) {
            console.error(
                `   Failed to remove from Lidarr queue:`,
                error.message
            );
        }
    }

    /**
     * Clear all failed/stuck items from Lidarr's download queue
     * and trigger new searches for the albums
     */
    async clearLidarrQueue(): Promise<{ removed: number; errors: string[] }> {
        const errors: string[] = [];
        let removed = 0;
        const albumIdsToSearch: number[] = [];

        try {
            const settings = await getSystemSettings();
            if (!settings?.lidarrUrl || !settings?.lidarrApiKey) {
                return { removed: 0, errors: ["Lidarr not configured"] };
            }

            console.log(`\nClearing Lidarr download queue...`);

            const queueResponse = await axios.get(
                `${settings.lidarrUrl}/api/v1/queue`,
                {
                    headers: { "X-Api-Key": settings.lidarrApiKey },
                    timeout: 10000,
                }
            );

            const records = queueResponse.data.records || [];

            if (records.length === 0) {
                return { removed: 0, errors: [] };
            }

            console.log(`   Found ${records.length} items in queue`);

            // Filter for failed/warning status items
            // NOTE: importPending is NOT a failure - it means download complete, waiting for import
            const failedItems = records.filter(
                (item: any) =>
                    item.status === "failed" ||
                    item.trackedDownloadStatus === "error" ||
                    item.trackedDownloadState === "importFailed" ||
                    // Only treat warnings with status messages as failures
                    ((item.status === "warning" || item.trackedDownloadStatus === "warning") &&
                        item.statusMessages && item.statusMessages.length > 0)
            );

            if (failedItems.length === 0) {
                return { removed: 0, errors: [] };
            }

            console.log(`   ${failedItems.length} items have errors/warnings`);

            for (const item of failedItems) {
                try {
                    // Collect album IDs for re-search
                    if (item.albumId) {
                        albumIdsToSearch.push(item.albumId);
                    }

                    // Remove from queue with blocklist
                    await axios.delete(
                        `${settings.lidarrUrl}/api/v1/queue/${item.id}?removeFromClient=true&blocklist=true&skipRedownload=false`,
                        {
                            headers: { "X-Api-Key": settings.lidarrApiKey },
                            timeout: 10000,
                        }
                    );
                    console.log(
                        `    Removed: ${
                            item.title || item.album?.title || "Unknown"
                        }`
                    );
                    removed++;
                } catch (error: any) {
                    const msg = `Failed to remove ${item.id}: ${error.message}`;
                    console.log(`   ✗ ${msg}`);
                    errors.push(msg);
                }
            }

            // Explicitly trigger album searches for removed items
            if (albumIdsToSearch.length > 0) {
                try {
                    console.log(
                        `    Triggering search for ${albumIdsToSearch.length} album(s)...`
                    );
                    await axios.post(
                        `${settings.lidarrUrl}/api/v1/command`,
                        {
                            name: "AlbumSearch",
                            albumIds: albumIdsToSearch,
                        },
                        {
                            headers: { "X-Api-Key": settings.lidarrApiKey },
                            timeout: 10000,
                        }
                    );
                    console.log(
                        `    Search triggered for alternative releases`
                    );
                } catch (searchError: any) {
                    console.log(
                        ` Failed to trigger search: ${searchError.message}`
                    );
                }
            }

            console.log(`   Removed ${removed} items from queue`);
            return { removed, errors };
        } catch (error: any) {
            console.error(`   Queue cleanup failed:`, error.message);
            return { removed, errors: [error.message] };
        }
    }

    /**
     * Get statistics about current downloads
     */
    async getStats(): Promise<{
        pending: number;
        processing: number;
        completed: number;
        failed: number;
    }> {
        const [pending, processing, completed, failed] = await Promise.all([
            prisma.downloadJob.count({ where: { status: "pending" } }),
            prisma.downloadJob.count({ where: { status: "processing" } }),
            prisma.downloadJob.count({ where: { status: "completed" } }),
            prisma.downloadJob.count({ where: { status: "failed" } }),
        ]);

        return { pending, processing, completed, failed };
    }

    /**
     * Reconcile processing jobs with Lidarr
     * Checks if albums in "processing" state are already available in Lidarr
     * and marks them as completed if so (fixes missed webhook completion events)
     * 
     * IMPORTANT: Checks by both MBID and artist+album name to handle MBID mismatches
     */
    async reconcileWithLidarr(): Promise<{ reconciled: number; errors: string[] }> {
        console.log(`\n[RECONCILE] Checking processing jobs against Lidarr...`);
        
        const processingJobs = await prisma.downloadJob.findMany({
            where: { status: "processing" },
        });

        if (processingJobs.length === 0) {
            console.log(`   No processing jobs to reconcile`);
            return { reconciled: 0, errors: [] };
        }

        console.log(`   Found ${processingJobs.length} processing job(s)`);

        let reconciled = 0;
        const errors: string[] = [];

        for (const job of processingJobs) {
            const metadata = job.metadata as any;
            const albumMbid = job.targetMbid || metadata?.albumMbid || metadata?.lidarrMbid;
            const artistName = metadata?.artistName;
            const albumTitle = metadata?.albumTitle;

            try {
                let isAvailable = false;

                // Strategy 1: Check by MBID(s)
                if (albumMbid) {
                    isAvailable = await lidarrService.isAlbumAvailable(albumMbid);
                    
                    // Also try lidarrMbid if different
                    if (!isAvailable && metadata?.lidarrMbid && metadata.lidarrMbid !== albumMbid) {
                        isAvailable = await lidarrService.isAlbumAvailable(metadata.lidarrMbid);
                    }
                }

                // Strategy 2: Check by artist+album name (handles MBID mismatches)
                if (!isAvailable && artistName && albumTitle) {
                    isAvailable = await lidarrService.isAlbumAvailableByTitle(artistName, albumTitle);
                }

                // Strategy 3: Parse subject if no metadata (format: "Artist - Album")
                if (!isAvailable && !artistName && job.subject) {
                    const parts = job.subject.split(" - ");
                    if (parts.length >= 2) {
                        const parsedArtist = parts[0].trim();
                        const parsedAlbum = parts.slice(1).join(" - ").trim();
                        isAvailable = await lidarrService.isAlbumAvailableByTitle(parsedArtist, parsedAlbum);
                    }
                }

                if (isAvailable) {
                    console.log(`   Job ${job.id}: Album "${job.subject}" found in Lidarr - marking complete`);
                    
                    await prisma.downloadJob.update({
                        where: { id: job.id },
                        data: {
                            status: "completed",
                            completedAt: new Date(),
                            error: null,
                            metadata: {
                                ...metadata,
                                completedAt: new Date().toISOString(),
                                reconciledFromLidarr: true,
                            },
                        },
                    });

                    // Check batch completion for discovery jobs
                    if (job.discoveryBatchId) {
                        const { discoverWeeklyService } = await import("./discoverWeekly");
                        await discoverWeeklyService.checkBatchCompletion(job.discoveryBatchId);
                    }

                    reconciled++;
                } else {
                    // Only log for jobs older than 5 minutes
                    const jobAge = Date.now() - (job.createdAt?.getTime() || 0);
                    if (jobAge > 5 * 60 * 1000) {
                        console.log(`   Job ${job.id}: "${job.subject}" not yet available in Lidarr (${Math.round(jobAge / 60000)}m old)`);
                    }
                }
            } catch (error: any) {
                const msg = `Job ${job.id}: Error checking Lidarr - ${error.message}`;
                console.error(`   ${msg}`);
                errors.push(msg);
            }
        }

        console.log(`[RECONCILE] Reconciled ${reconciled} job(s)`);
        return { reconciled, errors };
    }
}

// Singleton instance
export const simpleDownloadManager = new SimpleDownloadManager();
