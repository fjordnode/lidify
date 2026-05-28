import * as fs from "fs";
import * as path from "path";
import { parseFile } from "music-metadata";
import { prisma } from "../utils/db";
import PQueue from "p-queue";
import { CoverArtExtractor } from "./coverArtExtractor";
import { deezerService } from "./deezer";
import { musicBrainzService } from "./musicbrainz";
import { normalizeArtistName, areArtistNamesSimilar, canonicalizeVariousArtists } from "../utils/artistNormalization";

/**
 * Sanitize metadata strings by removing null bytes and other invalid UTF-8 characters
 * PostgreSQL throws "invalid byte sequence for encoding UTF8: 0x00" if these slip through
 * Also handles Unicode escape sequences like \u0000 that some metadata parsers produce
 */
function sanitizeMetadataString(str: string | undefined): string {
    if (!str) return "";
    return str
        // Remove Unicode escape sequences for null (e.g., \u0000)
        .replace(/\\u0000/gi, "")
        // Remove raw null bytes (0x00) and other control characters except common whitespace
        // eslint-disable-next-line no-control-regex
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
        // Remove any remaining invisible/zero-width characters
        .replace(/[\u200B-\u200D\uFEFF]/g, "")
        .trim();
}

// Supported audio formats
const AUDIO_EXTENSIONS = new Set([
    ".mp3",
    ".flac",
    ".m4a",
    ".aac",
    ".ogg",
    ".opus",
    ".wav",
    ".wma",
    ".ape",
    ".wv",
]);

interface ScanProgress {
    filesScanned: number;
    filesTotal: number;
    currentFile: string;
    errors: Array<{ file: string; error: string }>;
}

interface ScanResult {
    tracksAdded: number;
    tracksUpdated: number;
    tracksRemoved: number;
    affectedArtistIds: string[];
    errors: Array<{ file: string; error: string }>;
    duration: number;
}

export class MusicScannerService {
    // Process files serially so same-artist/same-album creates cannot race into duplicates.
    private scanQueue = new PQueue({ concurrency: 1 });
    private progressCallback?: (progress: ScanProgress) => void;
    private coverArtExtractor?: CoverArtExtractor;
    // When true: marks albums as DISCOVER (hidden from library), skips OwnedAlbum, skips lastSynced
    // Used for Soulseek/playlist downloads that should only appear in playlists
    private playlistOnlyMode: boolean;
    private excludedRelativePrefixes: string[] = [];

    constructor(
        progressCallback?: (progress: ScanProgress) => void,
        coverCachePath?: string,
        playlistOnlyMode: boolean = false
    ) {
        this.progressCallback = progressCallback;
        this.playlistOnlyMode = playlistOnlyMode;
        if (coverCachePath) {
            this.coverArtExtractor = new CoverArtExtractor(coverCachePath);
        }
    }

    /**
     * Scan the music directory and update the database
     */
    async scanLibrary(musicPath: string, basePathForDb: string = musicPath): Promise<ScanResult> {
        const startTime = Date.now();
        const result: ScanResult = {
            tracksAdded: 0,
            tracksUpdated: 0,
            tracksRemoved: 0,
            affectedArtistIds: [],
            errors: [],
            duration: 0,
        };
        const affectedArtistIds = new Set<string>();

        console.log(`Starting library scan: ${musicPath}`);

        const settings = await prisma.systemSettings.findFirst();
        const downloadPath = settings?.downloadPath || "/soulseek-downloads";
        const fileStorage = path.resolve(basePathForDb) === path.resolve(downloadPath)
            ? "download"
            : "music";

        const excludedDirs: string[] = [];
        this.excludedRelativePrefixes = [];

        // When the same download directory is mounted both at /soulseek-downloads and nested
        // inside the main library (e.g. /music/soulseek-downloads), a normal library scan can
        // accidentally ingest download-only files as owned library content. Exclude that nested
        // mirror from full library scans and keep a defensive prefix guard below.
        const canRunOrphanCleanup =
            !this.playlistOnlyMode &&
            fileStorage === "music" &&
            path.resolve(musicPath) === path.resolve(basePathForDb);

        if (canRunOrphanCleanup) {
            const nestedDownloadDir = path.join(
                musicPath,
                path.basename(downloadPath)
            );
            const normalizedMusicPath = path.resolve(musicPath);
            const normalizedNestedDownloadDir = path.resolve(nestedDownloadDir);

            if (
                normalizedNestedDownloadDir !== normalizedMusicPath &&
                fs.existsSync(nestedDownloadDir)
            ) {
                excludedDirs.push(nestedDownloadDir);
                const relativePrefix = path
                    .relative(musicPath, nestedDownloadDir)
                    .replace(/\\/g, "/");
                if (relativePrefix && relativePrefix !== ".") {
                    this.excludedRelativePrefixes.push(`${relativePrefix}/`);
                }
                console.log(
                    `[Scanner] Excluding nested download mirror from library scan: ${nestedDownloadDir}`
                );
            }
        }

        // Step 1: Find all audio files
        const audioFiles = await this.findAudioFiles(musicPath, excludedDirs);
        console.log(`Found ${audioFiles.length} audio files`);

        // Step 2: Get existing tracks from database
        const existingTracks = await prisma.track.findMany({
            where: { fileStorage },
            select: {
                id: true,
                filePath: true,
                fileStorage: true,
                fileModified: true,
                album: {
                    select: {
                        artistId: true,
                    },
                },
            },
        });

        const tracksByPath = new Map(
            existingTracks.map((t) => [t.filePath, t])
        );

        // Step 3: Process each audio file
        let filesScanned = 0;
        const progress: ScanProgress = {
            filesScanned: 0,
            filesTotal: audioFiles.length,
            currentFile: "",
            errors: [],
        };

        for (const audioFile of audioFiles) {
            await this.scanQueue.add(async () => {
                try {
                    const relativePath = path.relative(basePathForDb, audioFile);
                    progress.currentFile = relativePath;
                    this.progressCallback?.(progress);

                    const stats = await fs.promises.stat(audioFile);
                    const fileModified = stats.mtime;

                    const existingTrack = tracksByPath.get(relativePath);

                    // Check if file needs updating
                    const isUpdate = !!existingTrack;
                    if (existingTrack) {
                        if (
                            existingTrack.fileModified &&
                            existingTrack.fileModified >= fileModified
                        ) {
                            // File hasn't changed, skip
                            // Note: Don't increment filesScanned here - finally block handles it
                            return;
                        }
                    }

                    // Extract metadata and update database
                    const affectedArtistId = await this.processAudioFile(
                        audioFile,
                        relativePath,
                        basePathForDb
                    );
                    if (affectedArtistId) {
                        affectedArtistIds.add(affectedArtistId);
                    }

                    // Increment counters only after successful insert/update
                    if (isUpdate) {
                        result.tracksUpdated++;
                    } else {
                        result.tracksAdded++;
                    }
                } catch (err: any) {
                    const error = {
                        file: audioFile,
                        error: err.message || String(err),
                    };
                    result.errors.push(error);
                    progress.errors.push(error);
                    console.error(`Error processing ${audioFile}:`, err);
                } finally {
                    filesScanned++;
                    progress.filesScanned = filesScanned;
                    this.progressCallback?.(progress);
                }
            });
        }

        await this.scanQueue.onIdle();

        const sparseScanCleanupThreshold = 0.5;
        const sparseFullScanWithExistingTracks =
            canRunOrphanCleanup &&
            existingTracks.length > 0 &&
            audioFiles.length < existingTracks.length * sparseScanCleanupThreshold;
        if (sparseFullScanWithExistingTracks) {
            const message =
                `Full library scan found ${audioFiles.length} audio file(s) while ` +
                `${existingTracks.length} track(s) exist; skipping orphan cleanup to avoid ` +
                `mass deletion from an unavailable or partially mounted library.`;
            console.warn(`[Scanner] ${message}`);
            result.errors.push({ file: musicPath, error: message });
        }

        // Step 4-6: Remove orphaned tracks/albums/artists
        // Only full music-root scans are allowed to delete missing rows. Partial scans,
        // download-storage scans, and suspicious sparse full scans should only add/update.
        if (canRunOrphanCleanup && !sparseFullScanWithExistingTracks) {
            // Step 4: Remove tracks for files that no longer exist
            // IMPORTANT: Check BOTH musicPath AND downloadPath before deleting
            // Tracks can exist in either location
            const scannedPaths = new Set(
                audioFiles.map((f) => path.relative(basePathForDb, f))
            );

            // Only remove tracks that don't exist in EITHER location
            const tracksToRemove: typeof existingTracks = [];
            for (const track of existingTracks) {
                if (scannedPaths.has(track.filePath)) continue; // Found in scan

                // Check if file exists in download path
                const dlFullPath = path.join(downloadPath, track.filePath);
                try {
                    await fs.promises.access(dlFullPath, fs.constants.F_OK);
                    continue; // File exists in download path, don't delete
                } catch {
                    // File doesn't exist in either location
                    tracksToRemove.push(track);
                }
            }

            if (tracksToRemove.length > 0) {
                for (const track of tracksToRemove) {
                    affectedArtistIds.add(track.album.artistId);
                }

                await prisma.track.deleteMany({
                    where: {
                        id: { in: tracksToRemove.map((t) => t.id) },
                    },
                });
                result.tracksRemoved = tracksToRemove.length;
                console.log(`Removed ${tracksToRemove.length} missing tracks`);
            }

            // Step 5: Clean up orphaned albums (albums with no tracks)
            const orphanedAlbums = await prisma.album.findMany({
                where: {
                    tracks: { none: {} },
                },
                select: { id: true, title: true },
            });

            if (orphanedAlbums.length > 0) {
                console.log(`Removing ${orphanedAlbums.length} orphaned albums...`);
                await prisma.album.deleteMany({
                    where: {
                        id: { in: orphanedAlbums.map((a) => a.id) },
                    },
                });
            }

            // Step 6: Clean up orphaned artists (artists with no albums)
            const orphanedArtists = await prisma.artist.findMany({
                where: {
                    albums: { none: {} },
                },
                select: { id: true, name: true },
            });

            if (orphanedArtists.length > 0) {
                console.log(`Removing ${orphanedArtists.length} orphaned artists: ${orphanedArtists.map(a => a.name).join(', ')}`);
                await prisma.artist.deleteMany({
                    where: {
                        id: { in: orphanedArtists.map((a) => a.id) },
                    },
                });
            }
        } else {
            console.log(`Skipping orphan cleanup (partial, download, or playlist-only scan)`);
        }

        result.duration = Date.now() - startTime;
        result.affectedArtistIds = Array.from(affectedArtistIds);
        console.log(
            `Scan complete: +${result.tracksAdded} ~${result.tracksUpdated} -${result.tracksRemoved} (${result.duration}ms)`
        );

        return result;
    }

    private isExcludedLibrarySubpath(relativePath: string): boolean {
        if (this.excludedRelativePrefixes.length === 0) {
            return false;
        }
        const normalizedPath = relativePath.replace(/\\/g, "/");
        return this.excludedRelativePrefixes.some((prefix) =>
            normalizedPath.startsWith(prefix)
        );
    }

    /**
     * Extract the primary artist from collaboration strings
     * Examples:
     *   "CHVRCHES & Robert Smith" -> "CHVRCHES"
     *   "Artist feat. Someone" -> "Artist"
     *   "Artist ft. Someone" -> "Artist"
     *   "Artist, Someone" -> "Artist"
     * 
     * But preserves band names:
     *   "Earth, Wind & Fire" -> "Earth, Wind & Fire" (kept as-is)
     *   "The Naked and Famous" -> "The Naked and Famous" (kept as-is)
     */
    private extractPrimaryArtist(artistName: string): string {
        // Trim whitespace
        artistName = artistName.trim();

        // HIGH PRIORITY: These patterns almost always indicate collaborations
        // (not band names) so we always split on them
        const definiteCollaborationPatterns = [
            / feat\.? /i, // "feat." or "feat "
            / ft\.? /i, // "ft." or "ft "
            / featuring /i,
        ];

        for (const pattern of definiteCollaborationPatterns) {
            const match = artistName.split(pattern);
            if (match.length > 1) {
                return match[0].trim();
            }
        }

        // LOWER PRIORITY: Only split on "with", which is usually additive featuring credit.
        // Do NOT split on "and" here. Duo/score acts like "Trent Reznor and Atticus Ross"
        // and band names like "The Naked and Famous" should stay intact.
        // NOTE: Removed " & " - too many false positives (Above & Beyond, Nick Cave & the Bad Seeds, etc.)
        // NOTE: Removed ", " - false positives like "Tyler, The Creator", "Earth, Wind & Fire"
        const ambiguousPatterns = [
            { pattern: / with /i, name: "with" },
        ];

        for (const { pattern } of ambiguousPatterns) {
            const parts = artistName.split(pattern);
            if (parts.length > 1) {
                const firstPart = parts[0].trim();
                const lastWord = firstPart.split(/\s+/).pop()?.toLowerCase() || "";
                
                // Don't split if the first part ends with common incomplete words
                // These suggest it's a band name, not a collaboration
                const incompleteEndings = ["the", "a", "an", "and", "of", ","];
                if (incompleteEndings.includes(lastWord)) {
                    continue; // Skip this pattern, try the next one
                }
                
                // Don't split if the first part is very short (likely incomplete)
                if (firstPart.length < 4) {
                    continue;
                }
                
                return firstPart;
            }
        }

        // No collaboration found, return as-is
        return artistName;
    }

    /**
     * Strip disc number prefixes/suffixes from album titles to merge multi-disc albums.
     * The actual disc number is read from the disc metadata tag separately.
     *
     * Examples (suffixes):
     *   "Master Of Reality {2016 Deluxe Ed.} (Disc 1)" -> "Master Of Reality {2016 Deluxe Ed.}"
     *   "Abbey Road [Disc 2]" -> "Abbey Road"
     *   "The Wall - CD 1" -> "The Wall"
     *   "Mellon Collie (Disc One)" -> "Mellon Collie"
     * Examples (prefixes):
     *   "CD1 - (Mankind) The Crafty Ape" -> "(Mankind) The Crafty Ape"
     *   "Disc 2 - Abbey Road" -> "Abbey Road"
     */
    private stripDiscSuffix(albumTitle: string): string {
        // SUFFIX patterns to remove (case-insensitive):
        // - (Disc 1), (Disc 2), [Disc 1], {Disc 1}
        // - (CD 1), (CD 2), [CD 1], {CD 1}
        // - (Disc One), (Disc Two), etc.
        // - - Disc 1, - CD 1 (with leading dash)
        // - , Dsc 1 (comma separator, abbreviated)
        const suffixPatterns = [
            /\s*[\(\[\{]\s*(?:disc|cd|dsc)\s*\d+\s*[\)\]\}]\s*$/i,
            /\s*[\(\[\{]\s*(?:disc|cd|dsc)\s*(?:one|two|three|four|five|six|seven|eight|nine|ten)\s*[\)\]\}]\s*$/i,
            /\s*-\s*(?:disc|cd|dsc)\s*\d+\s*$/i,
            /\s*-\s*(?:disc|cd|dsc)\s*(?:one|two|three|four|five|six|seven|eight|nine|ten)\s*$/i,
            /\s*,\s*(?:disc|cd|dsc)\s*\d+\s*$/i,
            /\s*,\s*(?:disc|cd|dsc)\s*(?:one|two|three|four|five|six|seven|eight|nine|ten)\s*$/i,
        ];

        // PREFIX patterns to remove (case-insensitive):
        // - CD1 - Album, CD 1 - Album, Disc1 - Album, Disc 1 - Album
        // - CD1: Album, Disc 1: Album (with colon)
        const prefixPatterns = [
            /^(?:disc|cd|dsc)\s*\d+\s*[-:]\s*/i,
            /^(?:disc|cd|dsc)\s*(?:one|two|three|four|five|six|seven|eight|nine|ten)\s*[-:]\s*/i,
        ];

        let result = albumTitle;

        // Remove suffixes
        for (const pattern of suffixPatterns) {
            result = result.replace(pattern, '');
        }

        // Remove prefixes
        for (const pattern of prefixPatterns) {
            result = result.replace(pattern, '');
        }

        return result.trim();
    }

    /**
     * Check if a file path is within the discovery folder
     * Discovery albums are stored in paths like "discovery/Artist/Album/track.flac"
     * or "Discover/Artist/Album/track.flac" (case-insensitive)
     */
    private isDiscoveryPath(relativePath: string): boolean {
        const normalizedPath = relativePath.toLowerCase().replace(/\\/g, "/");
        // Check if path starts with "discovery/" or "discover/"
        return (
            normalizedPath.startsWith("discovery/") ||
            normalizedPath.startsWith("discover/")
        );
    }

    /**
     * Normalize string for matching - handles encoding differences between
     * file metadata and database records
     */
    private normalizeForMatching(str: string): string {
        return str
            .toLowerCase()
            .trim()
            .normalize('NFD').replace(/[\u0300-\u036f]/g, '')  // Remove diacritics (café → cafe)
            .replace(/[''´`]/g, "'")       // Normalize apostrophes
            .replace(/[""„]/g, '"')        // Normalize quotes
            .replace(/[–—−]/g, '-')        // Normalize dashes
            .replace(/\s+/g, ' ')          // Collapse whitespace
            .replace(/[^\w\s'"-]/g, '');   // Remove other special chars
    }

    /**
     * Check if an album is part of a discovery download by matching artist name + album title.
     * Uses multi-pass matching: exact match first, then partial match as fallback.
     */
    private async isDiscoveryDownload(
        artistName: string,
        albumTitle: string,
        allowDiscoveryAlbumFallback: boolean = true
    ): Promise<boolean> {
        if (!artistName || !albumTitle) return false;

        const normalizedArtist = this.normalizeForMatching(artistName);
        const normalizedAlbum = this.normalizeForMatching(albumTitle);
        
        // Also try with primary artist extracted (handles "Artist A feat. Artist B")
        const primaryArtist = this.extractPrimaryArtist(artistName);
        const normalizedPrimaryArtist = this.normalizeForMatching(primaryArtist);

        console.log(`[Scanner] Checking discovery: "${artistName}" → "${normalizedArtist}"`);
        if (primaryArtist !== artistName) {
            console.log(`[Scanner]   Primary artist: "${primaryArtist}" → "${normalizedPrimaryArtist}"`);
        }
        console.log(`[Scanner]   Album: "${albumTitle}" → "${normalizedAlbum}"`);

        try {
            // Get all discovery jobs (pending, processing, or recently completed)
            const discoveryJobs = await prisma.downloadJob.findMany({
                where: {
                    discoveryBatchId: { not: null },
                    status: { in: ["pending", "processing", "completed"] },
                },
            });

            console.log(`[Scanner]   Found ${discoveryJobs.length} discovery jobs to check`);

            // Pass 1: Exact match after normalization
            for (const job of discoveryJobs) {
                const metadata = job.metadata as any;
                const jobArtist = this.normalizeForMatching(metadata?.artistName || "");
                const jobAlbum = this.normalizeForMatching(metadata?.albumTitle || "");

                if ((jobArtist === normalizedArtist || jobArtist === normalizedPrimaryArtist) && jobAlbum === normalizedAlbum) {
                    console.log(`[Scanner] EXACT MATCH: job ${job.id}`);
                    return true;
                }
            }

            // Pass 2: Partial match fallback (handles "Album" vs "Album (Deluxe)")
            for (const job of discoveryJobs) {
                const metadata = job.metadata as any;
                const jobArtist = this.normalizeForMatching(metadata?.artistName || "");
                const jobAlbum = this.normalizeForMatching(metadata?.albumTitle || "");

                // Try matching both full artist name and extracted primary artist
                const artistMatch = jobArtist === normalizedArtist ||
                                   jobArtist === normalizedPrimaryArtist ||
                                   normalizedArtist.includes(jobArtist) ||
                                   jobArtist.includes(normalizedArtist) ||
                                   normalizedPrimaryArtist.includes(jobArtist) ||
                                   jobArtist.includes(normalizedPrimaryArtist);
                const albumMatch = jobAlbum === normalizedAlbum ||
                                  normalizedAlbum.includes(jobAlbum) ||
                                  jobAlbum.includes(normalizedAlbum);

                if (artistMatch && albumMatch) {
                    console.log(`[Scanner] PARTIAL MATCH: job ${job.id}`);
                    console.log(`[Scanner]   Job: "${jobArtist}" - "${jobAlbum}"`);
                    return true;
                }
            }

            // Pass 3: Album-only match (handles featured artists on discovery albums)
            // If the album title matches exactly, this track is likely a featured artist on a discovery album
            for (const job of discoveryJobs) {
                const metadata = job.metadata as any;
                const jobAlbum = this.normalizeForMatching(metadata?.albumTitle || "");

                if (jobAlbum === normalizedAlbum && normalizedAlbum.length > 3) {
                    console.log(`[Scanner] ALBUM-ONLY MATCH (featured artist): job ${job.id}`);
                    console.log(`[Scanner]   Track artist "${normalizedArtist}" is likely featured on "${jobAlbum}"`);
                    return true;
                }
            }

            if (!allowDiscoveryAlbumFallback) {
                console.log(`[Scanner] Skipping DiscoveryAlbum fallback for main library path`);
                return false;
            }

            // Pass 4: Check DiscoveryAlbum table (for already processed albums) by album title AND artist
            // IMPORTANT: Must match BOTH title and artist to avoid false positives
            // (e.g., "Above & Beyond - Acoustic" should NOT match "Above - Acoustic")
            const discoveryAlbumByTitleAndArtist = await prisma.discoveryAlbum.findFirst({
                where: {
                    albumTitle: { equals: albumTitle, mode: "insensitive" },
                    artistName: { equals: artistName, mode: "insensitive" },
                    status: { in: ["ACTIVE", "LIKED"] },
                },
            });

            if (discoveryAlbumByTitleAndArtist) {
                console.log(`[Scanner] DiscoveryAlbum match (by title+artist): ${discoveryAlbumByTitleAndArtist.id}`);
                return true;
            }
            
            // Pass 5: Check if artist name matches any discovery album
            // This catches cases where Lidarr downloads a different album than requested
            // e.g., requested "Broods - Broods" but got "Broods - Evergreen"
            // NOTE: Don't include DELETED status - deleted discovery albums should not
            // block library imports (fixes: Discovery Album Blocking Library Import)
            const discoveryAlbumByArtist = await prisma.discoveryAlbum.findFirst({
                where: {
                    artistName: { equals: artistName, mode: "insensitive" },
                    status: { in: ["ACTIVE", "LIKED"] },
                },
            });

            if (discoveryAlbumByArtist) {
                // Double-check: only match if this artist has NO library albums yet
                // This prevents marking albums from artists that exist in both library and discovery
                const existingLibraryAlbum = await prisma.album.findFirst({
                    where: {
                        artist: { name: { equals: artistName, mode: "insensitive" } },
                        location: "LIBRARY",
                    },
                });
                
                if (!existingLibraryAlbum) {
                    console.log(`[Scanner] DiscoveryAlbum match (by artist): ${discoveryAlbumByArtist.id}`);
                    console.log(`[Scanner]   Artist "${artistName}" is a discovery-only artist`);
                    return true;
                }
            }

            console.log(`[Scanner] No discovery match found`);
            return false;
        } catch (error) {
            console.error(`[Scanner] Error checking discovery status:`, error);
            return false;
        }
    }

    /**
     * Recursively find all audio files in a directory
     */
    private async findAudioFiles(
        dirPath: string,
        excludedDirs: string[] = []
    ): Promise<string[]> {
        const files: string[] = [];
        const excluded = new Set(
            excludedDirs.map((dir) => path.resolve(dir))
        );

        async function walk(dir: string) {
            if (excluded.has(path.resolve(dir))) {
                return;
            }

            const entries = await fs.promises.readdir(dir, {
                withFileTypes: true,
            });

            for (const entry of entries) {
                // Skip hidden files/folders (starting with .)
                if (entry.name.startsWith(".")) {
                    continue;
                }

                const fullPath = path.join(dir, entry.name);

                if (entry.isDirectory()) {
                    await walk(fullPath);
                } else if (entry.isFile()) {
                    const ext = path.extname(entry.name).toLowerCase();
                    if (AUDIO_EXTENSIONS.has(ext)) {
                        files.push(fullPath);
                    }
                }
            }
        }

        await walk(dirPath);
        return files;
    }

    /**
     * Process a single audio file and update database
     */
    private async processAudioFile(
        absolutePath: string,
        relativePath: string,
        musicPath: string
    ): Promise<string | null> {
        // Extract metadata - if parsing fails due to malformed picture data, retry without covers
        let metadata;
        let skipCoverExtraction = false;
        try {
            metadata = await parseFile(absolutePath);
        } catch (err: any) {
            // Some files have malformed embedded images that cause base64 decoding errors
            // Retry without loading pictures - we'll extract cover via ffmpeg later
            if (err.name === "InvalidCharacterError" || 
                err.message?.includes("InvalidCharacterError") ||
                err.message?.includes("not correctly encoded")) {
                console.warn(`[Scanner] Malformed picture data in ${path.basename(absolutePath)}, retrying without covers`);
                metadata = await parseFile(absolutePath, { skipCovers: true });
                skipCoverExtraction = false; // Still try to extract cover via ffmpeg fallback
            } else {
                throw err;
            }
        }
        const stats = await fs.promises.stat(absolutePath);

        // Parse basic info - sanitize all strings to remove null bytes that break PostgreSQL
        const title = sanitizeMetadataString(metadata.common.title) ||
            path.basename(relativePath, path.extname(relativePath));
        const trackNo = metadata.common.track.no || 0;
        const discNo = metadata.common.disk?.no || 1;
        let duration = Math.floor(metadata.format.duration || 0);
        const mime = metadata.format.codec || "audio/mpeg";

        // Fallback to ffprobe for duration if music-metadata didn't get it
        if (duration === 0) {
            try {
                const { execSync } = await import("child_process");
                const ffprobeOutput = execSync(
                    `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${absolutePath}"`,
                    { timeout: 10000, encoding: "utf8" }
                );
                const parsedDuration = parseFloat(ffprobeOutput.trim());
                if (!isNaN(parsedDuration) && parsedDuration > 0) {
                    duration = Math.floor(parsedDuration);
                }
            } catch {
                // ffprobe fallback failed, keep duration as 0
            }
        }

        // Artist and album info
        // IMPORTANT: Prefer albumartist over artist to keep albums grouped under the primary artist
        // This prevents featured artists from creating separate album entries
        // e.g., "Artist A feat. Artist B" track should still be under "Artist A"'s album
        let rawArtistName = sanitizeMetadataString(
            metadata.common.albumartist ||
            metadata.common.artist
        ) || "Unknown Artist";

        const rawAlbumTitle = sanitizeMetadataString(metadata.common.album) || "Unknown Album";
        const albumTitle = this.stripDiscSuffix(rawAlbumTitle);
        // Prefer originalyear (original release) over year (may be remaster date)
        // Some files have year=1 from invalid DATE tags like "0001-01-01"
        const rawYear = metadata.common.originalyear || metadata.common.year || null;
        // Validate year is reasonable (between 1900 and current year + 1)
        const currentYear = new Date().getFullYear();
        const year = (rawYear && rawYear >= 1900 && rawYear <= currentYear + 1) ? rawYear : null;
        // Sanitize each genre string to remove null bytes
        const genres = (metadata.common.genre || []).map(g => sanitizeMetadataString(g)).filter(g => g.length > 0);

        // Prefer albumartist as-is when present. Album artist tags usually represent the
        // intended canonical artist for the whole release, including duo/score projects
        // like "Trent Reznor and Atticus Ross". Only collapse featured artists when we
        // have to fall back to per-track artist tags.
        const hasAlbumArtist =
            !!sanitizeMetadataString(metadata.common.albumartist);
        const extractedPrimaryArtist = hasAlbumArtist
            ? rawArtistName
            : this.extractPrimaryArtist(rawArtistName);
        let artistName = extractedPrimaryArtist;

        // Canonicalize Various Artists variations (VA, V.A., <Various Artists>, etc.)
        artistName = canonicalizeVariousArtists(artistName);

        // Try to find artist with the canonicalized name first
        // This ensures "VA", "V.A.", etc. all find the canonical "Various Artists"
        const normalizedPrimaryName = normalizeArtistName(artistName);
        let artist = await prisma.artist.findFirst({
            where: { normalizedName: normalizedPrimaryName },
        });
        
        // If no match with primary name and we actually extracted something,
        // also try the full raw name (for bands like "Of Mice & Men")
        if (!artist && extractedPrimaryArtist !== rawArtistName) {
            const normalizedRawName = normalizeArtistName(rawArtistName);
            artist = await prisma.artist.findFirst({
                where: { normalizedName: normalizedRawName },
            });
            // If full name matches an existing artist, use that instead
            if (artist) {
                artistName = rawArtistName;
            }
        }

        // Update normalized name for use below
        const normalizedArtistName = normalizeArtistName(artistName);

        // If we found an artist, optionally update to better capitalization
        if (artist && artist.name !== artistName) {
            // Check if the new name has better capitalization (starts with uppercase)
            const currentNameIsLowercase = artist.name[0] === artist.name[0].toLowerCase();
            const newNameIsCapitalized = artistName[0] === artistName[0].toUpperCase();

            if (currentNameIsLowercase && newNameIsCapitalized) {
                console.log(`Updating artist name capitalization: "${artist.name}" -> "${artistName}"`);
                artist = await prisma.artist.update({
                    where: { id: artist.id },
                    data: { name: artistName },
                });
            }
        }

        if (!artist) {
            // Try fuzzy matching to catch typos like "the weeknd" vs "the weekend"
            // Only check artists with similar normalized names (performance optimization)
            const similarArtists = await prisma.artist.findMany({
                where: {
                    normalizedName: {
                        // Get artists whose normalized names start with similar prefix
                        startsWith: normalizedArtistName.substring(0, Math.min(3, normalizedArtistName.length)),
                    },
                },
                select: { id: true, name: true, normalizedName: true, mbid: true },
            });

            // Check for fuzzy matches
            for (const candidate of similarArtists) {
                if (areArtistNamesSimilar(artistName, candidate.name, 95)) {
                    console.log(`Fuzzy match found: "${artistName}" -> "${candidate.name}"`);
                    // Re-fetch full artist to get all fields
                    artist = await prisma.artist.findUnique({
                        where: { id: candidate.id },
                    });
                    break;
                }
            }
        }

        if (!artist) {
            // Try to find by MusicBrainz ID if available
            const artistMbid = metadata.common.musicbrainz_artistid?.[0];
            if (artistMbid) {
                artist = await prisma.artist.findUnique({
                    where: { mbid: artistMbid },
                });

                // If we have a real MBID but no artist exists, check if there's a temp artist we should consolidate
                if (!artist) {
                    const tempArtist = await prisma.artist.findFirst({
                        where: {
                            normalizedName: normalizedArtistName,
                            mbid: { startsWith: 'temp-' },
                        },
                    });

                    if (tempArtist) {
                        // Consolidate: update temp artist to real MBID
                        console.log(`[SCANNER] Consolidating temp artist "${tempArtist.name}" with real MBID: ${artistMbid}`);
                        artist = await prisma.artist.update({
                            where: { id: tempArtist.id },
                            data: { mbid: artistMbid },
                        });
                    }
                }
            }

            if (!artist) {
                // Create new artist (use a temporary MBID for now)
                artist = await prisma.artist.create({
                    data: {
                        name: artistName,
                        normalizedName: normalizedArtistName,
                        mbid:
                            artistMbid || `temp-${Date.now()}-${Math.random()}`,
                        enrichmentStatus: "pending",
                    },
                });
            }
        }

        // Get or create album
        let album = await prisma.album.findFirst({
            where: {
                artistId: artist.id,
                title: albumTitle,
            },
        });

        // If album exists with temp MBID but file has real MBID, update it
        const albumMbidFromFile = metadata.common.musicbrainz_releasegroupid;
        if (album && album.rgMbid?.startsWith("temp-") && albumMbidFromFile) {
            console.log(`[Scanner] Updating temp MBID for "${albumTitle}" with real MBID from file: ${albumMbidFromFile}`);
            try {
                album = await prisma.album.update({
                    where: { id: album.id },
                    data: { rgMbid: albumMbidFromFile },
                });
                // Also update OwnedAlbum if it exists
                await prisma.ownedAlbum.updateMany({
                    where: { artistId: artist.id, rgMbid: { startsWith: "temp-" } },
                    data: { rgMbid: albumMbidFromFile },
                });
            } catch (err: any) {
                // MBID might already exist for another album (duplicate)
                if (err.code === "P2002") {
                    const existingByMbid = await prisma.album.findUnique({
                        where: { rgMbid: albumMbidFromFile },
                    });
                    if (existingByMbid) {
                        console.log(`[Scanner] Using existing album for MBID ${albumMbidFromFile}: "${existingByMbid.title}"`);
                        album = existingByMbid;
                    }
                } else {
                    console.error(`[Scanner] Failed to update MBID for "${albumTitle}":`, err);
                }
            }
        }

        // If album exists but has no genres and file has genres, update it
        if (album && (!album.genres || (Array.isArray(album.genres) && album.genres.length === 0)) && genres.length > 0) {
            album = await prisma.album.update({
                where: { id: album.id },
                data: { genres },
            });
        }

        // Determine whether this scan should keep the album hidden from library views.
        // If a later normal library scan finds an existing DISCOVER album, we may need to
        // promote it back to LIBRARY below.
        const isDiscoveryByPath = this.isDiscoveryPath(relativePath);
        const allowDiscoveryAlbumFallback = isDiscoveryByPath || this.playlistOnlyMode;
        const isDiscoveryByJob = await this.isDiscoveryDownload(
            artistName,
            albumTitle,
            allowDiscoveryAlbumFallback
        );
        const isDiscoveryAlbum = isDiscoveryByPath || isDiscoveryByJob;
        const shouldBeHiddenFromLibrary =
            isDiscoveryAlbum ||
            this.playlistOnlyMode ||
            this.isExcludedLibrarySubpath(relativePath);

        if (!album) {
            // Try to find by release group MBID if available
            const albumMbid = metadata.common.musicbrainz_releasegroupid;
            if (albumMbid) {
                album = await prisma.album.findUnique({
                    where: { rgMbid: albumMbid },
                });
            }

            if (!album) {
                // Try to find MBID from MusicBrainz if not embedded
                let rgMbid = albumMbid;

                if (!rgMbid && artist.mbid && !artist.mbid.startsWith("temp-")) {
                    try {
                        // Look up artist's discography on MusicBrainz
                        const releaseGroups = await musicBrainzService.getReleaseGroups(
                            artist.mbid,
                            ["album", "ep", "single"],
                            100
                        );

                        // Try to match by title (case-insensitive, normalized)
                        const normalizedAlbumTitle = albumTitle.toLowerCase().replace(/[^a-z0-9]/g, "");
                        const match = releaseGroups.find((rg: any) => {
                            const rgNormalized = rg.title.toLowerCase().replace(/[^a-z0-9]/g, "");
                            return rgNormalized === normalizedAlbumTitle ||
                                   rg.title.toLowerCase() === albumTitle.toLowerCase();
                        });

                        if (match) {
                            rgMbid = match.id;
                            console.log(`[Scanner] Found MBID for "${albumTitle}" via MusicBrainz: ${rgMbid}`);

                            // Check if album with this MBID already exists (might have different title)
                            const existingByMbid = await prisma.album.findUnique({
                                where: { rgMbid },
                            });
                            if (existingByMbid) {
                                console.log(`[Scanner] Album already exists with MBID ${rgMbid}: "${existingByMbid.title}"`);
                                album = existingByMbid;
                            }
                        }
                    } catch (err) {
                        // MusicBrainz lookup failed, will fall back to temp MBID
                        console.log(`[Scanner] MusicBrainz lookup failed for "${albumTitle}":`, err);
                    }
                }

                // Fall back to temp MBID if no match found and album not found by MBID
                if (!rgMbid && !album) {
                    rgMbid = `temp-${Date.now()}-${Math.random()}`;
                    console.log(`[Scanner] Using temp MBID for "${albumTitle}" (no MusicBrainz match)`);
                }

                // Only create album if not found by MBID lookup above
                if (!album) {
                    // rgMbid is guaranteed to be set at this point (either from metadata, MB lookup, or temp fallback)
                    const albumMbidToUse = rgMbid!;
                    try {
                        album = await prisma.album.create({
                            data: {
                                title: albumTitle,
                                artistId: artist.id,
                                rgMbid: albumMbidToUse,
                                year,
                                genres: genres.length > 0 ? genres : undefined,
                                primaryType: "Album",
                                location: shouldBeHiddenFromLibrary ? "DISCOVER" : "LIBRARY",
                            },
                        });
                    } catch (err: any) {
                        if (err.code === "P2002") {
                            const existingByMbid = rgMbid
                                ? await prisma.album.findUnique({ where: { rgMbid } })
                                : null;
                            const existingByTitle = existingByMbid
                                ? existingByMbid
                                : await prisma.album.findFirst({
                                      where: { artistId: artist.id, title: albumTitle },
                                  });
                            if (existingByTitle) {
                                // In playlist-only mode, if album already exists as LIBRARY,
                                // skip adding this track (it's already in the main library)
                                if (this.playlistOnlyMode && existingByTitle.location === "LIBRARY") {
                                    console.log(`[Scanner] Skipping track from existing LIBRARY album "${existingByTitle.title}" (playlist mode)`);
                                    return null;
                                }
                                console.log(`[Scanner] Album already exists, reusing: "${existingByTitle.title}"`);
                                album = existingByTitle;
                            } else {
                                throw err;
                            }
                        } else {
                            throw err;
                        }
                    }

                    // Only create OwnedAlbum record and update lastSynced for library albums
                    // Skip for: discovery albums, playlist-only downloads (Soulseek for playlists)
                    if (!shouldBeHiddenFromLibrary) {
                        await prisma.ownedAlbum.upsert({
                            where: {
                                artistId_rgMbid: {
                                    artistId: artist.id,
                                    rgMbid: albumMbidToUse,
                                },
                            },
                            create: {
                                rgMbid: albumMbidToUse,
                                artistId: artist.id,
                                source: "native_scan",
                            },
                            update: {
                                source: "native_scan",
                            },
                        });

                        // Update artist's lastSynced so they appear in "Recently Added"
                        await prisma.artist.update({
                            where: { id: artist.id },
                            data: { lastSynced: new Date() },
                        });
                    }
                }
            }
        }

        // Existing albums can get stuck as DISCOVER if they were first seen in playlist-only
        // or discovery mode. Promote them when a normal library scan sees them again.
        if (album && !shouldBeHiddenFromLibrary && album.location !== "LIBRARY") {
            album = await prisma.album.update({
                where: { id: album.id },
                data: { location: "LIBRARY" },
            });

            await prisma.ownedAlbum.upsert({
                where: {
                    artistId_rgMbid: {
                        artistId: artist.id,
                        rgMbid: album.rgMbid,
                    },
                },
                create: {
                    artistId: artist.id,
                    rgMbid: album.rgMbid,
                    source: "native_scan",
                },
                update: {
                    source: "native_scan",
                },
            });

            await prisma.artist.update({
                where: { id: artist.id },
                data: { lastSynced: new Date() },
            });
        }

        // Extract cover art if we have an extractor
        // Re-extract if: no cover, OR native cover file is missing
        if (this.coverArtExtractor) {
                let needsExtraction = !album.coverUrl;

                // Check if existing native cover file is missing
                if (album.coverUrl?.startsWith("native:")) {
                    const nativePath = album.coverUrl.replace("native:", "");
                    const coverCachePath = path.join(
                        path.dirname(absolutePath),
                        "..",
                        "..",
                        "cache",
                        "covers",
                        nativePath
                    );
                    // Use the extractor's cache path instead
                    const extractorCachePath = path.join(
                        (this.coverArtExtractor as any).coverCachePath,
                        nativePath
                    );
                    if (!fs.existsSync(extractorCachePath)) {
                        needsExtraction = true;
                    }
                }

                if (needsExtraction) {
                    // Skip embedded cover extraction for YouTube downloads (often corrupted thumbnails)
                    // YouTube-downloaded files have video ID pattern in filename: - XXXXXXXXXXX.opus
                    const isYouTubeDownload = /- [A-Za-z0-9_-]{11}\.(opus|webm|m4a)$/.test(absolutePath);
                    
                    let coverPath: string | null = null;
                    if (!isYouTubeDownload) {
                        coverPath = await this.coverArtExtractor.extractCoverArt(
                            absolutePath,
                            album.id
                        );
                    }
                    
                    if (coverPath) {
                        await prisma.album.update({
                            where: { id: album.id },
                            data: { coverUrl: `native:${coverPath}` },
                        });
                    } else {
                        // No embedded art or YouTube download, try fetching from Deezer
                        try {
                            const deezerCover = await deezerService.getAlbumCover(
                                artistName,
                                albumTitle
                            );
                            if (deezerCover) {
                                await prisma.album.update({
                                    where: { id: album.id },
                                    data: { coverUrl: deezerCover },
                                });
                            }
                        } catch (error) {
                            // Silently fail - cover art is optional
                        }
                    }
            }
        }

        // Check if track with same title already exists in this album (prevents duplicates from playlist downloads)
        const existingTrackInAlbum = await prisma.track.findFirst({
            where: {
                albumId: album.id,
                title: title,
            },
        });

        if (existingTrackInAlbum && this.playlistOnlyMode) {
            // In playlist mode, skip adding duplicate tracks to existing library albums
            console.log(`[Scanner] Skipping duplicate track "${title}" in album "${albumTitle}" (playlist mode)`);
            return null;
        }

        const settings = await prisma.systemSettings.findFirst();
        const downloadPath = settings?.downloadPath || "/soulseek-downloads";
        const fileStorage = path.resolve(musicPath) === path.resolve(downloadPath)
            ? "download"
            : "music";

        // Upsert track
        await prisma.track.upsert({
            where: {
                fileStorage_filePath: {
                    fileStorage,
                    filePath: relativePath,
                },
            },
            create: {
                albumId: album.id,
                title,
                trackNo,
                discNo,
                duration,
                mime,
                filePath: relativePath,
                fileStorage,
                fileModified: stats.mtime,
                fileSize: stats.size,
            },
            update: {
                albumId: album.id,
                title,
                trackNo,
                discNo,
                duration,
                mime,
                fileModified: stats.mtime,
                fileSize: stats.size,
            },
        });

        return artist.id;
    }
}
