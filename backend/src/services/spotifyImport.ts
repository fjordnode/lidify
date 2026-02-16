import { spotifyService, SpotifyTrack, SpotifyPlaylist } from "./spotify";
import { musicBrainzService } from "./musicbrainz";
import { lidarrService } from "./lidarr";
import { soulseekService } from "./soulseek";
import { deezerService } from "./deezer";
import {
    createPlaylistLogger,
    logPlaylistEvent,
} from "../utils/playlistLogger";
import { notificationService } from "./notificationService";
import { getSystemSettings } from "../utils/systemSettings";
import { prisma } from "../utils/db";
import { redisClient } from "../utils/redis";
import { normalizeArtistName } from "../utils/artistNormalization";
import { youtubeMusicService } from "./youtube-music";
import { rewriteAudioTags } from "../utils/audioTags";
import PQueue from "p-queue";
import path from "path";
// Note: We DON'T use simpleDownloadManager here because it has same-artist fallback logic
// For Spotify Import, we need EXACT album matching - no substitutions

// Store loggers for each job
const jobLoggers = new Map<string, ReturnType<typeof createPlaylistLogger>>();

/**
 * Spotify Import Service
 *
 * Handles matching Spotify tracks to local library and managing imports
 */

export interface MatchedTrack {
    spotifyTrack: SpotifyTrack;
    localTrack: {
        id: string;
        title: string;
        albumId: string;
        albumTitle: string;
        artistName: string;
    } | null;
    matchType: "exact" | "fuzzy" | "none";
    matchConfidence: number; // 0-100
}

export interface AlbumToDownload {
    spotifyAlbumId: string;
    albumName: string;
    artistName: string;
    artistMbid: string | null;
    albumMbid: string | null;
    coverUrl: string | null;
    trackCount: number;
    tracksNeeded: SpotifyTrack[];
}

export interface ImportPreview {
    playlist: {
        id: string;
        name: string;
        description: string | null;
        owner: string;
        imageUrl: string | null;
        trackCount: number;
    };
    matchedTracks: MatchedTrack[];
    // Deprecated: playlist imports are track-only; kept for backward compatibility
    albumsToDownload: AlbumToDownload[];
    summary: {
        total: number;
        inLibrary: number;
        downloadable: number;
        notFound: number;
    };
}

export interface ImportJob {
    id: string;
    userId: string;
    spotifyPlaylistId: string;
    playlistName: string;
    status:
        | "pending"
        | "downloading"
        | "scanning"
        | "creating_playlist"
        | "matching_tracks"
        | "completed"
        | "failed"
        | "cancelled";
    progress: number;
    albumsTotal: number;
    albumsCompleted: number;
    tracksMatched: number;
    tracksTotal: number;
    tracksDownloadable: number; // Tracks from albums being downloaded
    createdPlaylistId: string | null;
    error: string | null;
    createdAt: Date;
    updatedAt: Date;
    // Store the original track list so we can match after downloads
    pendingTracks: Array<{
        artist: string;
        title: string;
        album: string;
        durationMs: number;
        sort: number;
        previewUrl: string | null;
        coverUrl: string | null; // Album art URL from Spotify/Deezer
        preMatchedTrackId: string | null; // Track ID if already matched in preview
    }>;
}

// Redis key pattern for import jobs
const IMPORT_JOB_KEY = (id: string) => `import:job:${id}`;
const IMPORT_JOB_TTL = 24 * 60 * 60; // 24 hours

/**
 * Save import job to both database and Redis cache for cross-process sharing
 */
async function saveImportJob(job: ImportJob): Promise<void> {
    // Save to database for durability
    await prisma.spotifyImportJob.upsert({
        where: { id: job.id },
        create: {
            id: job.id,
            userId: job.userId,
            spotifyPlaylistId: job.spotifyPlaylistId,
            playlistName: job.playlistName,
            status: job.status,
            progress: job.progress,
            albumsTotal: job.albumsTotal,
            albumsCompleted: job.albumsCompleted,
            tracksMatched: job.tracksMatched,
            tracksTotal: job.tracksTotal,
            tracksDownloadable: job.tracksDownloadable,
            createdPlaylistId: job.createdPlaylistId,
            error: job.error,
            pendingTracks: job.pendingTracks as any,
        },
        update: {
            status: job.status,
            progress: job.progress,
            albumsCompleted: job.albumsCompleted,
            tracksMatched: job.tracksMatched,
            createdPlaylistId: job.createdPlaylistId,
            error: job.error,
            updatedAt: new Date(),
        },
    });

    // Save to Redis for cross-process sharing
    try {
        await redisClient.setEx(
            IMPORT_JOB_KEY(job.id),
            IMPORT_JOB_TTL,
            JSON.stringify(job)
        );
    } catch (error) {
        console.warn(
            `⚠️  Failed to cache import job ${job.id} in Redis:`,
            error
        );
        // Continue - Redis is optional, DB is source of truth
    }
}

/**
 * Get import job from Redis cache or database
 * Redis provides cross-process sharing between API and worker processes
 */
async function getImportJob(importJobId: string): Promise<ImportJob | null> {
    // Try Redis cache first (shared across all processes)
    try {
        const cached = await redisClient.get(IMPORT_JOB_KEY(importJobId));
        if (cached) {
            return JSON.parse(cached);
        }
    } catch (error) {
        console.warn(
            `⚠️  Failed to read import job ${importJobId} from Redis:`,
            error
        );
        // Fall through to DB
    }

    // Load from database as fallback
    const dbJob = await prisma.spotifyImportJob.findUnique({
        where: { id: importJobId },
    });

    if (!dbJob) return null;

    // Convert database job to ImportJob format
    const job: ImportJob = {
        id: dbJob.id,
        userId: dbJob.userId,
        spotifyPlaylistId: dbJob.spotifyPlaylistId,
        playlistName: dbJob.playlistName,
        status: dbJob.status as ImportJob["status"],
        progress: dbJob.progress,
        albumsTotal: dbJob.albumsTotal,
        albumsCompleted: dbJob.albumsCompleted,
        tracksMatched: dbJob.tracksMatched,
        tracksTotal: dbJob.tracksTotal,
        tracksDownloadable: dbJob.tracksDownloadable,
        createdPlaylistId: dbJob.createdPlaylistId,
        error: dbJob.error,
        createdAt: dbJob.createdAt,
        updatedAt: dbJob.updatedAt,
        pendingTracks: ((dbJob.pendingTracks as any) || []).map((t: any) => ({
            ...t,
            durationMs: typeof t?.durationMs === "number" ? t.durationMs : 0,
        })),
    };

    // Populate Redis for next time
    try {
        await redisClient.setEx(
            IMPORT_JOB_KEY(importJobId),
            IMPORT_JOB_TTL,
            JSON.stringify(job)
        );
    } catch (error) {
        console.warn(
            `⚠️  Failed to cache import job ${importJobId} in Redis:`,
            error
        );
        // Continue - Redis is optional
    }

    return job;
}

/**
 * Normalize a string for fuzzy matching
 * Handles: special characters, punctuation, remaster suffixes, etc.
 */
function normalizeString(str: string): string {
    return (
        str
            .toLowerCase()
            // Normalize special characters (ö→o, é→e, etc.)
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            // Remove punctuation but keep spaces
            .replace(/[^\w\s]/g, "")
            .replace(/\s+/g, " ")
            .trim()
    );
}

/**
 * Normalize apostrophes and quotes to ASCII versions
 * Handles: ' ' ` ′ ʼ → '
 */
function normalizeApostrophes(str: string): string {
    return str
        .replace(/[''`′ʼ]/g, "'") // Various apostrophe forms → ASCII apostrophe
        .replace(/[""]/g, '"'); // Smart quotes → ASCII quotes
}

/**
 * Strip remaster/version suffixes but KEEP punctuation
 * "Ain't Gonna Rain Anymore - 2011 Remaster" → "Ain't Gonna Rain Anymore"
 * Used for database searches where we need to match punctuation
 */
function stripTrackSuffix(str: string): string {
    return (
        normalizeApostrophes(str)
            // Remove " - YEAR Remaster", " - Remastered YEAR", " - Radio Edit", etc.
            // Note: remaster(ed)? matches "remaster" or "remastered"
            .replace(
                /\s*-\s*(\d{4}\s+)?(remaster(ed)?|deluxe|bonus|single|radio edit|remix|acoustic|live|mono|stereo|version|edition|mix)(\s+\d{4})?(\s+(version|edition|mix))?.*$/i,
                ""
            )
            // Remove " - YEAR" at end
            .replace(/\s*-\s*\d{4}\s*$/, "")
            // Remove "(Live at...)", "(Live from...)", "(Recorded at...)" parenthetical content
            .replace(
                /\s*\([^)]*(?:live at|live from|recorded at|performed at)[^)]*\)\s*/gi,
                " "
            )
            // Remove parenthetical content like "(Remastered)" or "(2011 Remastered Version)"
            .replace(/\s*\([^)]*remaster[^)]*\)\s*/gi, " ")
            .replace(/\s*\([^)]*version[^)]*\)\s*/gi, " ")
            .replace(/\s*\([^)]*edition[^)]*\)\s*/gi, " ")
            // Remove general "(Live)" or "(Live 2021)" etc
            .replace(/\s*\(\s*live\s*(\d{4})?\s*\)\s*/gi, " ")
            // Remove bracketed content like "[Deluxe Edition]"
            .replace(/\s*\[[^\]]*\]\s*/g, " ")
            .replace(/\s+/g, " ")
            .trim()
    );
}

/**
 * Normalize track title - removes remaster/version suffixes AND punctuation
 * "Ain't Gonna Rain Anymore - 2011 Remaster" → "aint gonna rain anymore"
 * Used for similarity comparisons
 */
function normalizeTrackTitle(str: string): string {
    return normalizeString(stripTrackSuffix(str));
}

/**
 * Keep path sanitization in sync with SoulseekService.
 * Used to reliably locate playlist download folders under downloadPath/Playlists.
 */
function sanitizePathPart(name: string): string {
    return name.replace(/[<>:"/\\|?*]/g, "_").trim();
}

/**
 * Calculate similarity between two strings (0-100)
 */
function stringSimilarity(a: string, b: string): number {
    const s1 = normalizeString(a);
    const s2 = normalizeString(b);

    if (s1 === s2) return 100;

    // Check if one contains the other
    if (s1.includes(s2) || s2.includes(s1)) {
        const longer = Math.max(s1.length, s2.length);
        const shorter = Math.min(s1.length, s2.length);
        return Math.round((shorter / longer) * 100);
    }

    // Simple word overlap similarity
    const words1 = new Set(s1.split(" "));
    const words2 = new Set(s2.split(" "));
    const intersection = [...words1].filter((w) => words2.has(w)).length;
    const union = new Set([...words1, ...words2]).size;

    return Math.round((intersection / union) * 100);
}

class SpotifyImportService {
    private async acquirePlaylistTrack(
        track: { artist: string; title: string; album: string; durationMs: number },
        settings: any,
        options: {
            soulseekUsable: boolean;
            youtubeUsable: boolean;
        }
    ): Promise<{ success: boolean; source: "soulseek" | "youtube" | "none"; filePath?: string; error?: string }> {
        const albumFolder =
            track.album && track.album !== "Unknown Album" ? track.album : track.artist;

        const musicPath = settings?.musicPath || "/music";
        const downloadBase = settings?.downloadPath || "/soulseek-downloads";

        if (options.soulseekUsable) {
            try {
                const searchResult = await soulseekService.searchTrack(
                    track.artist,
                    track.title,
                    false,
                    {
                        preferFlac: true,
                        allowMp3320Fallback: true,
                        allowMp3256Fallback: true,
                        timeoutMs: 3500,
                    }
                );

                if (searchResult.found && searchResult.allMatches.length > 0) {
                    const dl = await soulseekService.downloadBestMatch(
                        track.artist,
                        track.title,
                        albumFolder,
                        searchResult.allMatches,
                        musicPath,
                        { downloadSubdir: "Playlists" }
                    );
                    if (dl.success) {
                        return { success: true, source: "soulseek", filePath: dl.filePath };
                    }
                }
            } catch (err: any) {
                // Fall through to YouTube
                void err;
            }
        }

        // YouTube fallback (if enabled)
        if (!options.youtubeUsable) {
            return {
                success: false,
                source: "none",
                error: "Soulseek failed and YouTube is disabled",
            };
        }

        const durationSeconds = track.durationMs
            ? Math.round(track.durationMs / 1000)
            : undefined;

        const match = await youtubeMusicService.findTrack(
            track.artist,
            track.title,
            durationSeconds,
            albumFolder
        );
        if (!match?.videoId) {
            return {
                success: false,
                source: "youtube",
                error: "No YouTube match found",
            };
        }

        const outputDir = path.join(
            downloadBase,
            "Playlists",
            sanitizePathPart(track.artist),
            sanitizePathPart(albumFolder)
        );

        const filename = `${sanitizePathPart(track.artist)} - ${sanitizePathPart(track.title)} - ${match.videoId}`;

        try {
            const dl = await youtubeMusicService.downloadTrack(
                match.videoId,
                outputDir,
                filename
            );

            try {
                await rewriteAudioTags(dl.filePath, {
                    title: track.title,
                    artist: track.artist,
                    album: albumFolder,
                });
            } catch (tagErr: any) {
                // Tagging improves reconcile reliability but isn't required for scan.
                console.warn(
                    `[Spotify Import] Tag rewrite failed for ${dl.filePath}: ${tagErr.message}`
                );
            }

            return { success: true, source: "youtube", filePath: dl.filePath };
        } catch (err: any) {
            return {
                success: false,
                source: "youtube",
                error: err?.message || "YouTube download failed",
            };
        }
    }

    private async findLocalTrackForPendingTrack(pendingTrack: {
        artist: string;
        title: string;
        album: string;
    }) {
        const normalizedArtist = normalizeString(pendingTrack.artist);
        const artistFirstWord = normalizedArtist.split(" ")[0];
        const strippedTitle = stripTrackSuffix(pendingTrack.title);
        const normalizedTitle = normalizeApostrophes(pendingTrack.title);
        const cleanedTitle = normalizeTrackTitle(pendingTrack.title);

        // Strategy 1: Exact title match with fuzzy artist (contains first word)
        let localTrack = await prisma.track.findFirst({
            where: {
                title: { equals: normalizedTitle, mode: "insensitive" },
                album: {
                    artist: {
                        normalizedName: {
                            contains: artistFirstWord,
                            mode: "insensitive",
                        },
                    },
                },
            },
            select: { id: true, title: true },
        });

        // Strategy 2: Stripped title match
        if (!localTrack && strippedTitle !== normalizedTitle) {
            localTrack = await prisma.track.findFirst({
                where: {
                    title: { equals: strippedTitle, mode: "insensitive" },
                    album: {
                        artist: {
                            normalizedName: {
                                contains: artistFirstWord,
                                mode: "insensitive",
                            },
                        },
                    },
                },
                select: { id: true, title: true },
            });
        }

        // Strategy 3: Contains + similarity/containment
        if (!localTrack && strippedTitle.length >= 5) {
            const searchTerm = strippedTitle
                .split(" ")
                .slice(0, 4)
                .join(" ");

            const candidates = await prisma.track.findMany({
                where: {
                    title: { contains: searchTerm, mode: "insensitive" },
                    album: {
                        artist: {
                            normalizedName: {
                                contains: artistFirstWord,
                                mode: "insensitive",
                            },
                        },
                    },
                },
                select: { id: true, title: true },
                take: 10,
            });

            for (const candidate of candidates) {
                const candidateNormalized = normalizeTrackTitle(candidate.title);
                const sim = stringSimilarity(cleanedTitle, candidateNormalized);
                if (sim >= 80) {
                    localTrack = candidate;
                    break;
                }

                const spotifyNorm = cleanedTitle.toLowerCase();
                const libraryNorm = candidateNormalized.toLowerCase();
                if (libraryNorm.startsWith(spotifyNorm) || spotifyNorm.startsWith(libraryNorm)) {
                    localTrack = candidate;
                    break;
                }
            }
        }

        // Strategy 3.5: Preview-style fuzzy artist+title scoring
        if (!localTrack) {
            const candidates = await prisma.track.findMany({
                where: {
                    album: {
                        artist: {
                            normalizedName: {
                                contains: artistFirstWord,
                                mode: "insensitive",
                            },
                        },
                    },
                },
                include: { album: { include: { artist: true } } },
                take: 50,
            });

            for (const candidate of candidates) {
                const titleSim = stringSimilarity(
                    cleanedTitle,
                    normalizeTrackTitle(candidate.title)
                );
                const artistSim = stringSimilarity(
                    pendingTrack.artist,
                    candidate.album.artist.name
                );
                const score = titleSim * 0.6 + artistSim * 0.4;
                if (score >= 70) {
                    localTrack = { id: candidate.id, title: candidate.title };
                    break;
                }
            }
        }

        // Strategy 4: startsWith + verify
        if (!localTrack && strippedTitle.length > 10) {
            const candidate = await prisma.track.findFirst({
                where: {
                    title: {
                        startsWith: strippedTitle.substring(
                            0,
                            Math.min(20, strippedTitle.length)
                        ),
                        mode: "insensitive",
                    },
                    album: {
                        artist: {
                            normalizedName: {
                                contains: artistFirstWord,
                                mode: "insensitive",
                            },
                        },
                    },
                },
                select: { id: true, title: true },
            });

            if (candidate) {
                const dbTitleNormalized = normalizeTrackTitle(candidate.title);
                if (stringSimilarity(cleanedTitle, dbTitleNormalized) >= 70) {
                    localTrack = candidate;
                }
            }
        }

        // Strategy 5: Very fuzzy (last resort)
        if (!localTrack) {
            const searchWords = strippedTitle
                .split(" ")
                .slice(0, 3)
                .join(" ");
            if (searchWords.length >= 4) {
                const candidates = await prisma.track.findMany({
                    where: {
                        title: {
                            contains: searchWords.split(" ")[0],
                            mode: "insensitive",
                        },
                        album: {
                            artist: {
                                normalizedName: {
                                    contains: artistFirstWord,
                                    mode: "insensitive",
                                },
                            },
                        },
                    },
                    include: { album: { include: { artist: true } } },
                    take: 20,
                });

                let bestMatch: { id: string; title: string } | null = null;
                let bestScore = 0;
                for (const candidate of candidates) {
                    const titleScore = stringSimilarity(
                        cleanedTitle,
                        normalizeTrackTitle(candidate.title)
                    );
                    const artistScore = stringSimilarity(
                        normalizedArtist,
                        normalizeString(candidate.album.artist.name)
                    );
                    const combinedScore = titleScore * 0.7 + artistScore * 0.3;
                    if (combinedScore > bestScore && combinedScore >= 65) {
                        bestScore = combinedScore;
                        bestMatch = { id: candidate.id, title: candidate.title };
                    }
                }
                if (bestMatch) localTrack = bestMatch;
            }
        }

        // Strategy 6: Title-only fallback
        if (!localTrack && cleanedTitle.length >= 10) {
            const titleSearchTerm = strippedTitle
                .split(" ")
                .slice(0, 4)
                .join(" ");
            const candidates = await prisma.track.findMany({
                where: {
                    title: { contains: titleSearchTerm, mode: "insensitive" },
                },
                select: { id: true, title: true },
                take: 50,
            });

            let bestTitleMatch: { id: string; title: string } | null = null;
            let bestTitleScore = 0;
            for (const candidate of candidates) {
                const titleScore = stringSimilarity(
                    cleanedTitle,
                    normalizeTrackTitle(candidate.title)
                );
                if (titleScore > bestTitleScore && titleScore >= 85) {
                    bestTitleScore = titleScore;
                    bestTitleMatch = candidate;
                }
            }
            if (bestTitleMatch) localTrack = bestTitleMatch;
        }

        return localTrack;
    }

    /**
     * Match a Spotify track to the local library
     */
    private async matchTrack(
        spotifyTrack: SpotifyTrack
    ): Promise<MatchedTrack> {
        const normalizedTitle = normalizeString(spotifyTrack.title);
        const normalizedArtist = normalizeString(spotifyTrack.artist);
        const normalizedAlbum = normalizeString(spotifyTrack.album);

        // Strategy 1: Exact match by artist + album + title
        const exactMatch = await prisma.track.findFirst({
            where: {
                album: {
                    artist: {
                        normalizedName: normalizedArtist,
                    },
                    title: {
                        mode: "insensitive",
                        equals: spotifyTrack.album,
                    },
                },
                title: {
                    mode: "insensitive",
                    equals: spotifyTrack.title,
                },
            },
            include: {
                album: {
                    include: {
                        artist: true,
                    },
                },
            },
        });

        if (exactMatch) {
            return {
                spotifyTrack,
                localTrack: {
                    id: exactMatch.id,
                    title: exactMatch.title,
                    albumId: exactMatch.albumId,
                    albumTitle: exactMatch.album.title,
                    artistName: exactMatch.album.artist.name,
                },
                matchType: "exact",
                matchConfidence: 100,
            };
        }

        // Strategy 2: Fuzzy match by artist + title (any album)
        const fuzzyMatches = await prisma.track.findMany({
            where: {
                album: {
                    artist: {
                        normalizedName: {
                            contains: normalizedArtist.split(" ")[0], // First word of artist
                        },
                    },
                },
            },
            include: {
                album: {
                    include: {
                        artist: true,
                    },
                },
            },
            take: 50, // Limit for performance
        });

        let bestMatch: typeof fuzzyMatches[number] | null = null;
        let bestScore = 0;

        for (const track of fuzzyMatches) {
            // Use cleaned titles for comparison (strips "- 2011 Remaster", etc.)
            const titleSim = stringSimilarity(
                normalizeTrackTitle(spotifyTrack.title),
                normalizeTrackTitle(track.title)
            );
            const artistSim = stringSimilarity(
                spotifyTrack.artist,
                track.album.artist.name
            );

            // Weight: title 60%, artist 40%
            const score = titleSim * 0.6 + artistSim * 0.4;

            if (score > bestScore && score >= 70) {
                bestScore = score;
                bestMatch = track;
            }
        }

        if (bestMatch) {
            return {
                spotifyTrack,
                localTrack: {
                    id: bestMatch.id,
                    title: bestMatch.title,
                    albumId: bestMatch.albumId,
                    albumTitle: bestMatch.album.title,
                    artistName: bestMatch.album.artist.name,
                },
                matchType: "fuzzy",
                matchConfidence: Math.round(bestScore),
            };
        }

        return {
            spotifyTrack,
            localTrack: null,
            matchType: "none",
            matchConfidence: 0,
        };
    }

    /**
     * Look up album info from MusicBrainz for downloading
     */
    private async findAlbumMbid(
        artistName: string,
        albumName: string
    ): Promise<{ artistMbid: string | null; albumMbid: string | null }> {
        try {
            // Search for artist first
            const artists = await musicBrainzService.searchArtist(
                artistName,
                5
            );
            if (!artists || artists.length === 0) {
                return { artistMbid: null, albumMbid: null };
            }

            // Find best matching artist
            let bestArtist = artists[0];
            for (const artist of artists) {
                if (
                    normalizeString(artist.name) === normalizeString(artistName)
                ) {
                    bestArtist = artist;
                    break;
                }
            }

            const artistMbid = bestArtist.id;

            // Search for album by this artist
            const releaseGroups = await musicBrainzService.getReleaseGroups(
                artistMbid
            );

            for (const rg of releaseGroups || []) {
                if (stringSimilarity(rg.title, albumName) >= 80) {
                    return { artistMbid, albumMbid: rg.id };
                }
            }

            return { artistMbid, albumMbid: null };
        } catch (error) {
            console.error("MusicBrainz lookup error:", error);
            return { artistMbid: null, albumMbid: null };
        }
    }

    /**
     * Shared preview generator for any source tracklist
     */
    private async buildPreviewFromTracklist(
        tracks: SpotifyTrack[],
        playlistMeta: {
            id: string;
            name: string;
            description: string | null;
            owner: string;
            imageUrl: string | null;
            trackCount: number;
        },
        source: "Spotify" | "Deezer" | "YouTube Music"
    ): Promise<ImportPreview> {
        // Track-only preview: avoid MusicBrainz/Lidarr. We only need to know what's already
        // in the library vs what needs Soulseek downloads.
        const matchedTracks: MatchedTrack[] = [];
        const matchQueue = new PQueue({ concurrency: 10 });

        await Promise.all(
            tracks.map((track) =>
                matchQueue.add(async () => {
                    const matched = await this.matchTrack(track);
                    matchedTracks.push(matched);
                })
            )
        );

        // Preserve original order (queue completes out-of-order)
        const indexById = new Map<string, number>();
        tracks.forEach((t, i) => indexById.set(t.spotifyId, i));
        matchedTracks.sort(
            (a, b) =>
                (indexById.get(a.spotifyTrack.spotifyId) ?? 0) -
                (indexById.get(b.spotifyTrack.spotifyId) ?? 0)
        );

        const inLibrary = matchedTracks.filter((m) => m.localTrack !== null)
            .length;
        const downloadable = matchedTracks.filter((m) => m.localTrack === null)
            .length;
        const notFound = 0;

        const albumsToDownload: AlbumToDownload[] = [];

        return {
            playlist: playlistMeta,
            matchedTracks,
            albumsToDownload,
            summary: {
                total: playlistMeta.trackCount,
                inLibrary,
                downloadable,
                notFound,
            },
        };
    }

    /**
     * Generate a preview of what will be imported
     */
    async generatePreview(spotifyUrl: string): Promise<ImportPreview> {
        const playlist = await spotifyService.getPlaylist(spotifyUrl);
        if (!playlist) {
            throw new Error(
                "Could not fetch playlist from Spotify. Make sure it's a valid public playlist URL."
            );
        }

        return this.buildPreviewFromTracklist(
            playlist.tracks,
            {
                id: playlist.id,
                name: playlist.name,
                description: playlist.description,
                owner: playlist.owner,
                imageUrl: playlist.imageUrl,
                trackCount: playlist.trackCount,
            },
            "Spotify"
        );
    }

    /**
     * Generate a preview from a Deezer playlist
     * Converts Deezer tracks to Spotify format and processes them
     */
    async generatePreviewFromDeezer(
        deezerPlaylist: any
    ): Promise<ImportPreview> {
        const spotifyTracks: SpotifyTrack[] = deezerPlaylist.tracks.map(
            (track: any, index: number) => ({
                spotifyId: track.deezerId,
                title: track.title,
                artist: track.artist,
                artistId: track.artistId || "",
                album: track.album || "Unknown Album",
                albumId: track.albumId || "",
                isrc: null,
                durationMs: track.durationMs,
                trackNumber: track.trackNumber || index + 1,
                previewUrl: track.previewUrl || null,
                coverUrl: track.coverUrl || deezerPlaylist.imageUrl || null,
            })
        );

        return this.buildPreviewFromTracklist(
            spotifyTracks,
            {
                id: deezerPlaylist.id,
                name: deezerPlaylist.title,
                description: deezerPlaylist.description || null,
                owner: deezerPlaylist.creator || "Deezer",
                imageUrl: deezerPlaylist.imageUrl || null,
                trackCount: deezerPlaylist.trackCount || spotifyTracks.length,
            },
            "Deezer"
        );
    }

    /**
     * Generate a preview from a YouTube Music playlist
     * Converts YouTube Music tracks to Spotify format and processes them
     */
    async generatePreviewFromYouTube(
        youtubePlaylist: {
            id: string;
            title: string;
            description: string | null;
            creator: string;
            imageUrl: string | null;
            trackCount: number;
            tracks: Array<{
                videoId: string;
                title: string;
                artist: string;
                album?: string;
                duration: number;
                thumbnail?: string;
            }>;
        }
    ): Promise<ImportPreview> {
        const spotifyTracks: SpotifyTrack[] = youtubePlaylist.tracks.map(
            (track, index) => ({
                spotifyId: track.videoId,
                title: track.title,
                artist: track.artist,
                artistId: "",
                album: track.album || "Unknown Album",
                albumId: "",
                isrc: null,
                durationMs: track.duration * 1000,
                trackNumber: index + 1,
                previewUrl: null,
                coverUrl: track.thumbnail || youtubePlaylist.imageUrl || null,
            })
        );

        return this.buildPreviewFromTracklist(
            spotifyTracks,
            {
                id: youtubePlaylist.id,
                name: youtubePlaylist.title,
                description: youtubePlaylist.description || null,
                owner: youtubePlaylist.creator || "YouTube Music",
                imageUrl: youtubePlaylist.imageUrl || null,
                trackCount: youtubePlaylist.trackCount || spotifyTracks.length,
            },
            "YouTube Music"
        );
    }

    /**
     * Start an import job
     * @param skipDownload - If true, just save playlist without downloading missing tracks
     */
    async startImport(
        userId: string,
        spotifyPlaylistId: string,
        playlistName: string,
        preview: ImportPreview,
        skipDownload: boolean = false
    ): Promise<ImportJob> {
        const jobId = `import_${Date.now()}_${Math.random()
            .toString(36)
            .substring(7)}`;

        // Create dedicated logger for this job
        const logger = createPlaylistLogger(jobId);
        jobLoggers.set(jobId, logger);

        logger.logJobStart(playlistName, preview.summary.total, userId);
        logger.info(`Playlist ID: ${spotifyPlaylistId}`);
        logger.info(`Tracks already in library: ${preview.summary.inLibrary}`);

        // Track-only: download every track not already in the library
        const tracksFromDownloads = preview.matchedTracks.filter(
            (m) => !m.localTrack
        ).length;

        // Extract the track info we need to match after downloads
        // Include ALL tracks, both matched and unmatched
        // IMPORTANT: Store pre-matched track IDs so we don't have to re-search them!
        // NOTE: `PlaylistPendingTrack.spotifyAlbum` should reflect Spotify's album name.
        // Only fall back to a resolved album name when Spotify returns "Unknown Album".
        const pendingTracks = preview.matchedTracks.map((m, index) => ({
            artist: m.spotifyTrack.artist,
            title: m.spotifyTrack.title,
            album: m.spotifyTrack.album || "Unknown Album",
            durationMs: m.spotifyTrack.durationMs || 0,
            sort: index,
            previewUrl: m.spotifyTrack.previewUrl || null,
            coverUrl: m.spotifyTrack.coverUrl || null,
            preMatchedTrackId: m.localTrack?.id || null,
        }));

        const job: ImportJob = {
            id: jobId,
            userId,
            spotifyPlaylistId,
            playlistName,
            status: "pending",
            progress: 0,
            albumsTotal: tracksFromDownloads,
            albumsCompleted: 0,
            tracksMatched: preview.summary.inLibrary,
            tracksTotal: preview.summary.total,
            tracksDownloadable: tracksFromDownloads,
            createdPlaylistId: null,
            error: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            pendingTracks,
        };

        // Save to database and memory cache
        await saveImportJob(job);

        // Start processing in background
        this.processImport(job, preview, skipDownload).catch(
            async (error) => {
                job.status = "failed";
                job.error = error.message;
                job.updatedAt = new Date();
                await saveImportJob(job);
                logger.logJobFailed(error.message);
            }
        );

        return job;
    }

    /**
     * Process the import (download albums, create playlist)
     * Uses simpleDownloadManager for proper webhook tracking and Lidarr release iteration
     * @param skipDownload - If true, just save playlist without downloading missing tracks
     */
    private async processImport(
        job: ImportJob,
        preview: ImportPreview,
        skipDownload: boolean = false
    ): Promise<void> {
        const logger = jobLoggers.get(job.id);

        // Track-only import:
        // - Create playlist immediately with in-library tracks
        // - Save unmatched tracks as pending
        // - Download missing tracks via Soulseek
        // - Queue scan of downloadPath/Playlists
        // - scanProcessor will reconcile pending tracks after scan

        const settings = await getSystemSettings();
        const downloadBase = settings?.downloadPath || "/soulseek-downloads";
        const playlistScanPath = path.join(downloadBase, "Playlists");

        job.status = "creating_playlist";
        job.progress = 5;
        job.updatedAt = new Date();
        await saveImportJob(job);

        // Create playlist with already-matched tracks (preserve original sort)
        const matchedItems = job.pendingTracks
            .filter((t) => t.preMatchedTrackId)
            .map((t) => ({
                trackId: t.preMatchedTrackId as string,
                sort: t.sort,
            }));

        const playlist = await prisma.playlist.create({
            data: {
                userId: job.userId,
                name: job.playlistName,
                isPublic: false,
                spotifyPlaylistId: job.spotifyPlaylistId,
                items:
                    matchedItems.length > 0
                        ? { create: matchedItems }
                        : undefined,
            },
        });

        job.createdPlaylistId = playlist.id;
        job.status = "downloading";
        job.progress = matchedItems.length > 0 ? 10 : 5;
        job.updatedAt = new Date();
        await saveImportJob(job);

        // Save pending tracks (including original sort) for later reconciliation
        const pendingTracksToSave = job.pendingTracks
            .filter((t) => !t.preMatchedTrackId)
            .map((t) => ({
                playlistId: playlist.id,
                spotifyArtist: t.artist,
                spotifyTitle: t.title,
                spotifyAlbum: t.album,
                deezerPreviewUrl: t.previewUrl,
                duration: t.durationMs ? Math.round(t.durationMs / 1000) : null,
                albumArt: t.coverUrl,
                sort: t.sort,
            }));

        if (pendingTracksToSave.length > 0) {
            await prisma.playlistPendingTrack.createMany({
                data: pendingTracksToSave,
                skipDuplicates: true,
            });
        }

        // Download missing tracks (Soulseek -> YouTube fallback) unless skipDownload
        if (!skipDownload) {
            const tracksToDownload = job.pendingTracks
                .filter((t) => !t.preMatchedTrackId)
                .map((t) => ({
                    artist: t.artist,
                    title: t.title,
                    album: t.album,
                    durationMs: t.durationMs,
                }));

            if (tracksToDownload.length > 0) {
                const soulseekUsable = Boolean(
                    settings?.soulseekEnabled !== false &&
                        settings?.soulseekUsername &&
                        settings?.soulseekPassword &&
                        (await soulseekService.isAvailable())
                );
                const youtubeUsable = settings?.youtubeEnabled !== false;

                logger?.info(
                    `Playlist download: tracks=${tracksToDownload.length} soulseek=${
                        soulseekUsable ? "yes" : "no"
                    } youtube=${youtubeUsable ? "yes" : "no"}`
                );

                const queue = new PQueue({ concurrency: 3 });
                let successful = 0;
                let failed = 0;

                await Promise.all(
                    tracksToDownload.map((t) =>
                        queue.add(async () => {
                            const result = await this.acquirePlaylistTrack(t, settings, {
                                soulseekUsable,
                                youtubeUsable,
                            });
                            if (result.success) {
                                successful++;
                            } else {
                                failed++;
                                logger?.warn(
                                    `Track download failed: ${t.artist} - ${t.title} (${result.source}): ${
                                        result.error || "unknown error"
                                    }`
                                );
                            }
                        })
                    )
                );

                job.albumsCompleted = successful;
                job.updatedAt = new Date();
                await saveImportJob(job);

                logger?.info(
                    `Playlist download complete: ${successful} succeeded, ${failed} failed`
                );
            }

            job.status = "scanning";
            job.progress = 80;
            job.updatedAt = new Date();
            await saveImportJob(job);

            try {
                const { scanQueue } = await import("../workers/queues");
                await scanQueue.add("scan", {
                    userId: job.userId,
                    musicPath: playlistScanPath,
                    basePath: downloadBase,
                    source: "spotify-import",
                    spotifyImportJobId: job.id,
                });
            } catch (err: any) {
                logger?.error(`Failed to queue scan: ${err.message}`);
            }
        } else {
            logger?.info(`Skipping downloads (save only mode)`);
        }

        // We don't wait for scan completion; scanProcessor will reconcile and notify.
        job.status = "completed";
        job.progress = 100;
        job.updatedAt = new Date();
        await saveImportJob(job);

        try {
            await notificationService.notifyImportComplete(
                job.userId,
                job.playlistName,
                playlist.id,
                matchedItems.length,
                job.tracksTotal
            );
        } catch (notifError) {
            console.error("Failed to send import notification:", notifError);
        }

        return;
    }

    /**
     * Try Soulseek for downloading tracks
     * Uses TRACK-based searching (more effective on Soulseek than album search)
     * Downloads directly to Singles/Artist/Album/ using soulseek-ts
     */
    private async trySoulseekDownload(
        job: ImportJob,
        album: AlbumToDownload,
        downloadJobId: string,
        logger: ReturnType<typeof createPlaylistLogger> | undefined
    ): Promise<{ success: boolean; error?: string; tracksFound?: number }> {
        // Check if Soulseek is available
        const soulseekAvailable = await soulseekService.isAvailable();
        if (!soulseekAvailable) {
            console.log(
                `[Spotify Import] Soulseek not available, skipping fallback`
            );
            return { success: false, error: "Soulseek not configured" };
        }

        console.log(
            `[Spotify Import] Trying Soulseek for: ${album.artistName} - ${album.albumName}`
        );
        console.log(
            `[Spotify Import] Searching for ${album.tracksNeeded.length} individual track(s)`
        );
        logger?.logSlskdFallbackStart(album.albumName, album.artistName);

        // Get music path for direct download
        const settings = await getSystemSettings();
        const musicPath = settings?.musicPath;
        if (!musicPath) {
            return { success: false, error: "Music path not configured" };
        }

        try {
            // Prepare track list for batch download - normalize titles for better search results
            const tracks = album.tracksNeeded.map((track) => ({
                artist: track.artist,
                title: stripTrackSuffix(track.title), // Remove live/remaster suffixes
                album: album.albumName,
            }));

            // Log individual track searches for debugging
            console.log(
                `[Spotify Import] Soulseek: Searching for ${tracks.length} track(s):`
            );
            album.tracksNeeded.forEach((t, i) => {
                const normalized = stripTrackSuffix(t.title);
                if (normalized !== t.title) {
                    console.log(
                        `   ${i + 1}. "${t.artist}" - "${
                            t.title
                        }" → "${normalized}"`
                    );
                } else {
                    console.log(`   ${i + 1}. "${t.artist}" - "${t.title}"`);
                }
            });

            // Use parallel batch download (4 concurrent by default)
            const result = await soulseekService.searchAndDownloadBatch(
                tracks,
                musicPath,
                4, // concurrency
                {
                    // Namespace playlist downloads to avoid collisions with /music paths
                    downloadSubdir: "Playlists",
                    preferFlac: true,
                    allowMp3320Fallback: true,
                    searchTimeoutMs: 3500,
                    searchTimeoutLongMs: 12000,
                    searchConcurrency: 8,
                }
            );

            if (result.successful === 0) {
                console.log(`[Spotify Import] Soulseek: No tracks downloaded`);
                logger?.logSlskdSearchResult(false);
                return { success: false, error: "No tracks found on Soulseek" };
            }

            // Calculate total size of downloaded files
            const fs = await import("fs");
            const totalSizeMB = result.files.reduce((sum, file) => {
                try {
                    const stats = fs.statSync(file);
                    return sum + stats.size / 1024 / 1024;
                } catch {
                    return sum;
                }
            }, 0);

            console.log(
                `[Spotify Import] ✓ Soulseek: Downloaded ${result.successful}/${
                    album.tracksNeeded.length
                } tracks (${Math.round(totalSizeMB)}MB)`
            );
            logger?.logSlskdSearchResult(
                true,
                "Mixed",
                "direct",
                result.successful,
                Math.round(totalSizeMB)
            );
            logger?.logSlskdDownloadQueued(result.successful, "direct");

            // Mark download job as completed immediately - files are already in place!
            await prisma.downloadJob
                .update({
                    where: { id: downloadJobId },
                    data: {
                        status: "completed",
                        completedAt: new Date(),
                        error: null,
                        metadata: {
                            spotifyImportJobId: job.id,
                            artistName: album.artistName,
                            albumTitle: album.albumName,
                            downloadType: "spotify_import",
                            source: "soulseek_direct",
                            tracksDownloaded: result.successful,
                            totalNeeded: album.tracksNeeded.length,
                            files: result.files,
                        },
                    },
                })
                .catch(() => {});

            return { success: true, tracksFound: result.successful };
        } catch (error: any) {
            console.error(`[Spotify Import] Soulseek error:`, error.message);
            logger?.logAlbumFailed(
                album.albumName,
                album.artistName,
                `Soulseek error: ${error.message}`
            );
            return { success: false, error: error.message };
        }
    }

    /**
     * Check if all downloads for this import are complete (called by webhook handler)
     */
    async checkImportCompletion(importJobId: string): Promise<void> {
        console.log(
            `\n[Spotify Import] Checking completion for job ${importJobId}...`
        );

        const job = await getImportJob(importJobId);
        if (!job) {
            console.log(`   Job not found`);
            return;
        }

        const logger = jobLoggers.get(importJobId);

        // Check download jobs for this import
        const downloadJobs = await prisma.downloadJob.findMany({
            where: {
                id: { startsWith: `spotify_${importJobId}_` },
            },
        });

        const total = downloadJobs.length;
        const completed = downloadJobs.filter(
            (j) => j.status === "completed"
        ).length;
        const failed = downloadJobs.filter((j) => j.status === "failed").length;
        const pending = total - completed - failed;

        if (total === 0 && job.albumsTotal > 0) {
            const message =
                "No download jobs were created for this import. This usually means the import preview did not include the selected albums.";
            console.log(`   ${message}`);
            logger?.warn(message);

            job.status = "failed";
            job.error = message;
            job.updatedAt = new Date();
            await saveImportJob(job);
            return;
        }

        console.log(
            `   Download status: ${completed}/${total} completed, ${failed} failed, ${pending} pending`
        );
        logger?.logDownloadProgress(completed, failed, pending);

        // Update progress
        job.progress =
            total > 0
                ? 30 + Math.round((completed / total) * 40) // 30-70% for downloads
                : 30;
        job.updatedAt = new Date();

        if (pending > 0) {
            // Check how long we've been waiting for these downloads
            const oldestPending = downloadJobs
                .filter(
                    (j) => j.status === "pending" || j.status === "processing"
                )
                .sort(
                    (a, b) => a.createdAt.getTime() - b.createdAt.getTime()
                )[0];

            const waitTimeMs = oldestPending
                ? Date.now() - oldestPending.createdAt.getTime()
                : 0;
            const waitTimeMins = Math.round(waitTimeMs / 60000);

            // After 10 minutes of waiting, proceed anyway to avoid stuck jobs
            if (waitTimeMs < 600000) {
                // 10 minutes
                console.log(
                    `   Still waiting for ${pending} downloads... (${waitTimeMins} min elapsed)`
                );
                logger?.info(`Waiting for Soulseek downloads to complete...`);
                await saveImportJob(job);
                return;
            }

            console.log(
                `   Timeout: ${pending} downloads still pending after ${waitTimeMins} minutes, proceeding anyway`
            );
            logger?.warn(
                `Download timeout: ${pending} pending after ${waitTimeMins}m, proceeding with available tracks`
            );

            // Mark stale pending jobs as failed
            await prisma.downloadJob.updateMany({
                where: {
                    id: { startsWith: `spotify_${importJobId}_` },
                    status: { in: ["pending", "processing"] },
                },
                data: {
                    status: "failed",
                    error: "Timed out waiting for download",
                    completedAt: new Date(),
                },
            });
        }

        // All downloads finished (completed or failed)
        console.log(`   All downloads finished! Triggering library scan...`);
        logger?.info(
            `All ${total} download jobs finished (${completed} completed, ${failed} failed)`
        );

        // Trigger library scan to import the new files from the download path
        const { scanQueue } = await import("../workers/queues");
        const settings = await getSystemSettings();
        const downloadBase = settings?.downloadPath || "/soulseek-downloads";
        const playlistScanPath = path.join(downloadBase, "Playlists");
        const scanJob = await scanQueue.add("scan", {
            userId: job.userId,
            musicPath: playlistScanPath,
            basePath: downloadBase,
            source: "spotify-import",
            spotifyImportJobId: importJobId,
        });

        logger?.info(
            `Queued library scan (bullJobId=${scanJob.id ?? "unknown"})`
        );

        job.status = "scanning";
        job.progress = 75;
        job.updatedAt = new Date();
        await saveImportJob(job);
    }

    /**
     * Build playlist after library scan completes (called by scan worker)
     */
    async buildPlaylistAfterScan(importJobId: string): Promise<void> {
        console.log(
            `\n[Spotify Import] Building playlist for job ${importJobId}...`
        );

        const job = await getImportJob(importJobId);
        if (!job) {
            console.log(`   Job not found`);
            return;
        }

        await this.buildPlaylist(job);
    }

    /**
     * Internal: Build the playlist with matched tracks
     */
    private async buildPlaylist(job: ImportJob): Promise<void> {
        const logger = jobLoggers.get(job.id);

        job.status = "creating_playlist";
        job.progress = 90;
        job.updatedAt = new Date();
        await saveImportJob(job);

        logger?.logPlaylistCreationStart();
        logger?.logTrackMatchingStart();

        // Match all pending tracks against the library
        const matchedTrackIds: string[] = [];
        const matchedInputIndices = new Set<number>();
        let trackIndex = 0;

        for (let originalIndex = 0; originalIndex < job.pendingTracks.length; originalIndex++) {
            const pendingTrack = job.pendingTracks[originalIndex];
            trackIndex++;

            // FAST PATH: If already matched in preview, use that ID directly
            // This ensures tracks found during preview are included in the final playlist
            if (pendingTrack.preMatchedTrackId) {
                // Verify the track still exists
                const existingTrack = await prisma.track.findUnique({
                    where: { id: pendingTrack.preMatchedTrackId },
                    select: { id: true, title: true },
                });
                if (existingTrack) {
                    matchedTrackIds.push(existingTrack.id);
                    matchedInputIndices.add(originalIndex);
                    console.log(
                        `   ✓ Pre-matched: "${pendingTrack.title}" -> track ${existingTrack.id}`
                    );
                    logger?.logTrackMatch(
                        trackIndex,
                        job.tracksTotal,
                        pendingTrack.title,
                        pendingTrack.artist,
                        true,
                        existingTrack.id
                    );
                    continue;
                }
            }

            const normalizedArtist = normalizeString(pendingTrack.artist);
            // Get first word for fuzzy artist matching (handles "Nick Cave & The Bad Seeds" -> "nick")
            const artistFirstWord = normalizedArtist.split(" ")[0];
            // Strip suffix but keep punctuation for DB queries: "Ain't Gonna Rain Anymore - 2011 Remaster" -> "Ain't Gonna Rain Anymore"
            const strippedTitle = stripTrackSuffix(pendingTrack.title);
            // Also normalize apostrophes in the original title for searching
            const normalizedTitle = normalizeApostrophes(pendingTrack.title);
            // Fully normalized for similarity comparison: "aint gonna rain anymore"
            const cleanedTitle = normalizeTrackTitle(pendingTrack.title);

            logger?.log(
                `   Matching: "${pendingTrack.title}" by ${pendingTrack.artist}`
            );
            logger?.log(
                `   strippedTitle: "${strippedTitle}", artistFirstWord: "${artistFirstWord}"`
            );

            const localTrack = await this.findLocalTrackForPendingTrack({
                artist: pendingTrack.artist,
                title: pendingTrack.title,
                album: pendingTrack.album,
            });

            if (localTrack) {
                matchedTrackIds.push(localTrack.id);
                matchedInputIndices.add(originalIndex);
                console.log(
                    `   ✓ Matched: "${pendingTrack.title}" -> track ${localTrack.id}`
                );
                logger?.logTrackMatch(
                    trackIndex,
                    job.tracksTotal,
                    pendingTrack.title,
                    pendingTrack.artist,
                    true,
                    localTrack.id
                );
            } else {
                // Debug: Check if artist exists at all
                const artistExists = await prisma.artist.findFirst({
                    where: {
                        normalizedName: {
                            contains: normalizedArtist.split(" ")[0],
                            mode: "insensitive",
                        },
                    },
                    select: { name: true, normalizedName: true },
                });
                if (artistExists) {
                    console.log(
                        `   ✗ No match: "${pendingTrack.title}" by ${pendingTrack.artist} (artist "${artistExists.name}" exists but track not found)`
                    );
                } else {
                    console.log(
                        `   ✗ No match: "${pendingTrack.title}" by ${pendingTrack.artist} (artist not in library)`
                    );
                }
                logger?.logTrackMatch(
                    trackIndex,
                    job.tracksTotal,
                    pendingTrack.title,
                    pendingTrack.artist,
                    false
                );
            }
        }

        const uniqueTrackIds = Array.from(new Set(matchedTrackIds));
        if (uniqueTrackIds.length < matchedTrackIds.length) {
            const removed = matchedTrackIds.length - uniqueTrackIds.length;
            console.log(
                `   Removed ${removed} duplicate track references before playlist creation`
            );
            logger?.info(
                `Removed ${removed} duplicate track references before playlist creation`
            );
        }

        console.log(
            `   Matched ${uniqueTrackIds.length}/${job.tracksTotal} tracks`
        );
        logger?.info(
            `Matched tracks after scan: ${uniqueTrackIds.length}/${job.tracksTotal}`
        );
        // Create the playlist with Spotify metadata
        const playlist = await prisma.playlist.create({
            data: {
                userId: job.userId,
                name: job.playlistName,
                isPublic: false,
                spotifyPlaylistId: job.spotifyPlaylistId,
                items:
                    uniqueTrackIds.length > 0
                        ? {
                              create: uniqueTrackIds.map((trackId, index) => ({
                                  trackId,
                                  sort: index,
                              })),
                          }
                        : undefined,
            },
        });

        // Save pending tracks that weren't matched
        const pendingTracksToSave = job.pendingTracks
            .map((track, index) => ({ ...track, originalIndex: index }))
            .filter((_, index) => !matchedInputIndices.has(index));

        if (pendingTracksToSave.length > 0) {
            console.log(
                `   Saving ${pendingTracksToSave.length} pending tracks for future auto-matching`
            );
            console.log(
                `   Fetching Deezer preview URLs for pending tracks...`
            );
            logger?.info(
                `Saving pending tracks: ${pendingTracksToSave.length}`
            );

            // Fetch Deezer previews in parallel for all pending tracks
            const pendingTracksWithPreviews = await Promise.all(
                pendingTracksToSave.map(async (track) => {
                    let deezerPreviewUrl: string | null = null;
                    try {
                        deezerPreviewUrl = await deezerService.getTrackPreview(
                            track.artist,
                            track.title
                        );
                    } catch (e) {
                        // Preview not critical, continue without it
                    }
                    return {
                        ...track,
                        deezerPreviewUrl,
                    };
                })
            );

            const previewsFound = pendingTracksWithPreviews.filter(
                (t) => t.deezerPreviewUrl
            ).length;
            console.log(
                `   Found ${previewsFound}/${pendingTracksToSave.length} Deezer preview URLs`
            );
            logger?.info(
                `Pending previews found: ${previewsFound}/${pendingTracksToSave.length}`
            );

            await prisma.playlistPendingTrack.createMany({
                data: pendingTracksWithPreviews.map((track) => ({
                    playlistId: playlist.id,
                    spotifyArtist: track.artist,
                    spotifyTitle: track.title,
                    spotifyAlbum: track.album,
                    deezerPreviewUrl: track.deezerPreviewUrl,
                    duration: track.durationMs ? Math.round(track.durationMs / 1000) : null,
                    albumArt: track.coverUrl,
                    sort: track.originalIndex,
                })),
                skipDuplicates: true,
            });
        }

        job.createdPlaylistId = playlist.id;
        job.tracksMatched = uniqueTrackIds.length;
        job.status = "completed";
        job.progress = 100;
        job.updatedAt = new Date();
        await saveImportJob(job);

        console.log(`[Spotify Import] Job ${job.id} completed:`);
        console.log(`   Playlist created: ${playlist.id}`);
        console.log(
            `   Tracks matched: ${matchedTrackIds.length}/${job.tracksTotal}`
        );

        logger?.logPlaylistCreated(
            playlist.id,
            matchedTrackIds.length,
            job.tracksTotal
        );
        logger?.logJobComplete(
            matchedTrackIds.length,
            job.tracksTotal,
            playlist.id
        );

        // Send notification about import completion
        try {
            await notificationService.notifyImportComplete(
                job.userId,
                job.playlistName,
                playlist.id,
                matchedTrackIds.length,
                job.tracksTotal
            );
        } catch (notifError) {
            console.error("Failed to send import notification:", notifError);
        }
    }

    /**
     * Re-match pending tracks and add newly downloaded ones to the playlist
     */
    async refreshJobMatches(
        jobId: string
    ): Promise<{ added: number; total: number }> {
        const logger = jobLoggers.get(jobId);
        const job = await getImportJob(jobId);
        if (!job) {
            throw new Error("Import job not found");
        }
        if (!job.createdPlaylistId) {
            throw new Error("No playlist created for this job");
        }

        let added = 0;

        // Get existing tracks in playlist
        const existingItems = await prisma.playlistItem.findMany({
            where: { playlistId: job.createdPlaylistId },
            select: { trackId: true },
        });
        const existingTrackIds = new Set(
            existingItems.map((item) => item.trackId)
        );

        // Get next sort position (use max sort, not item count)
        const maxSortResult = await prisma.playlistItem.aggregate({
            where: { playlistId: job.createdPlaylistId },
            _max: { sort: true },
        });
        let nextSort = (maxSortResult._max.sort ?? -1) + 1;

        // Try to match each pending track
        for (const pendingTrack of job.pendingTracks) {
            const normalizedArtist = normalizeString(pendingTrack.artist);

            // Track model doesn't have normalizedTitle - use case-insensitive title matching
            const localTrack = await prisma.track.findFirst({
                where: {
                    title: {
                        equals: pendingTrack.title,
                        mode: "insensitive",
                    },
                    album: {
                        artist: {
                            normalizedName: normalizedArtist,
                        },
                    },
                },
            });

            if (localTrack && !existingTrackIds.has(localTrack.id)) {
                // Add to playlist
                await prisma.playlistItem.create({
                    data: {
                        playlistId: job.createdPlaylistId,
                        trackId: localTrack.id,
                        sort: nextSort++,
                    },
                });
                existingTrackIds.add(localTrack.id);
                added++;
            }
        }

        job.tracksMatched += added;
        job.updatedAt = new Date();

        // Touch playlist so Subsonic clients detect the change
        if (added > 0 && job.createdPlaylistId) {
            await prisma.playlist.update({ where: { id: job.createdPlaylistId }, data: { updatedAt: new Date() } });
        }

        console.log(
            `[Spotify Import] Refresh job ${jobId}: added ${added} newly downloaded tracks`
        );
        logger?.info(
            `Refresh: added ${added} newly downloaded track(s), totalMatchedNow=${job.tracksMatched}`
        );

        return { added, total: job.tracksMatched };
    }

    /**
     * Repair an existing playlist by re-matching the full import tracklist.
     * This is useful if tracks were deleted/re-scanned and playlist items were lost.
     */
    async repairPlaylist(jobId: string): Promise<{
        added: number;
        pendingRemoved: number;
    }> {
        const job = await getImportJob(jobId);
        if (!job) throw new Error("Import job not found");
        if (!job.createdPlaylistId) throw new Error("No playlist created for this job");

        const playlistId = job.createdPlaylistId;

        const existingItems = await prisma.playlistItem.findMany({
            where: { playlistId },
            select: { trackId: true },
        });
        const existingTrackIds = new Set(existingItems.map((i) => i.trackId));

        let added = 0;
        let pendingRemoved = 0;

        for (let originalIndex = 0; originalIndex < job.pendingTracks.length; originalIndex++) {
            const pendingTrack = job.pendingTracks[originalIndex];

            // Prefer the original pre-match if still valid
            let trackId: string | null = null;
            if (pendingTrack.preMatchedTrackId) {
                const existingTrack = await prisma.track.findUnique({
                    where: { id: pendingTrack.preMatchedTrackId },
                    select: { id: true },
                });
                if (existingTrack) trackId = existingTrack.id;
            }

            if (!trackId) {
                const localTrack = await this.findLocalTrackForPendingTrack({
                    artist: pendingTrack.artist,
                    title: pendingTrack.title,
                    album: pendingTrack.album,
                });
                trackId = localTrack?.id || null;
            }

            if (!trackId || existingTrackIds.has(trackId)) {
                continue;
            }

            try {
                await prisma.playlistItem.create({
                    data: {
                        playlistId,
                        trackId,
                        sort: originalIndex,
                    },
                });
                existingTrackIds.add(trackId);
                added++;
            } catch {
                // Ignore unique constraint collisions
            }

            // If this track was previously marked pending, remove it now
            const deleteRes = await prisma.playlistPendingTrack.deleteMany({
                where: {
                    playlistId,
                    spotifyArtist: pendingTrack.artist,
                    spotifyTitle: pendingTrack.title,
                },
            });
            pendingRemoved += deleteRes.count;
        }

        // Touch playlist so Subsonic clients detect the change
        if (added > 0) {
            await prisma.playlist.update({ where: { id: playlistId }, data: { updatedAt: new Date() } });
        }

        return { added, pendingRemoved };
    }

    /**
     * Get import job status (public method for routes)
     */
    async getJob(jobId: string): Promise<ImportJob | null> {
        return await getImportJob(jobId);
    }

    /**
     * Get all jobs for a user
     */
    async getUserJobs(userId: string): Promise<ImportJob[]> {
        // Get from database to include jobs across restarts
        const dbJobs = await prisma.spotifyImportJob.findMany({
            where: { userId },
            orderBy: { createdAt: "desc" },
        });

        return dbJobs
            .map((dbJob) => ({
                id: dbJob.id,
                userId: dbJob.userId,
                spotifyPlaylistId: dbJob.spotifyPlaylistId,
                playlistName: dbJob.playlistName,
                status: dbJob.status as ImportJob["status"],
                progress: dbJob.progress,
                albumsTotal: dbJob.albumsTotal,
                albumsCompleted: dbJob.albumsCompleted,
                tracksMatched: dbJob.tracksMatched,
                tracksTotal: dbJob.tracksTotal,
                tracksDownloadable: dbJob.tracksDownloadable,
                createdPlaylistId: dbJob.createdPlaylistId,
                error: dbJob.error,
                createdAt: dbJob.createdAt,
                updatedAt: dbJob.updatedAt,
                pendingTracks: ((dbJob.pendingTracks as any) || []).map((t: any) => ({
                    ...t,
                    durationMs: typeof t?.durationMs === "number" ? t.durationMs : 0,
                })),
            }))
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    }

    /**
     * Cancel an import job without creating a playlist.
     * All pending downloads are marked as failed and the job is marked as cancelled.
     */
    async cancelJob(jobId: string): Promise<{
        playlistCreated: boolean;
        playlistId: string | null;
        tracksMatched: number;
    }> {
        const job = await getImportJob(jobId);
        if (!job) {
            throw new Error("Import job not found");
        }

        const logger = jobLoggers.get(jobId);
        console.log(`[Spotify Import] Cancelling job ${jobId}...`);
        logger?.info(`Job cancelled by user`);

        // If already completed, cancelled, or failed, nothing to do
        if (
            job.status === "completed" ||
            job.status === "failed" ||
            job.status === "cancelled"
        ) {
            return {
                playlistCreated: !!job.createdPlaylistId,
                playlistId: job.createdPlaylistId || null,
                tracksMatched: job.tracksMatched,
            };
        }

        // Mark any pending download jobs as cancelled
        await prisma.downloadJob.updateMany({
            where: {
                id: { startsWith: `spotify_${jobId}_` },
                status: { in: ["pending", "processing"] },
            },
            data: {
                status: "failed",
                error: "Import cancelled by user",
                completedAt: new Date(),
            },
        });

        // Mark job as cancelled - do NOT create a playlist
        job.status = "cancelled";
        job.updatedAt = new Date();
        logger?.info(`Import cancelled by user - no playlist created`);

        return {
            playlistCreated: false,
            playlistId: null,
            tracksMatched: 0,
        };
    }

    /**
     * Reconcile pending tracks for ALL playlists after a library scan
     * This checks if any previously unmatched tracks now have matches in the library
     * and automatically adds them to their playlists
     */
    async reconcilePendingTracks(): Promise<{
        playlistsUpdated: number;
        tracksAdded: number;
    }> {
        console.log(
            `\n[Spotify Import] Reconciling pending tracks across all playlists...`
        );

        // Get all pending tracks grouped by playlist
        const allPendingTracks = await prisma.playlistPendingTrack.findMany({
            include: {
                playlist: {
                    select: {
                        id: true,
                        name: true,
                        userId: true,
                    },
                },
            },
            orderBy: [{ playlistId: "asc" }, { sort: "asc" }],
        });

        if (allPendingTracks.length === 0) {
            console.log(`   No pending tracks to reconcile`);
            return { playlistsUpdated: 0, tracksAdded: 0 };
        }

        console.log(
            `   Found ${allPendingTracks.length} pending tracks across playlists`
        );

        let totalTracksAdded = 0;
        const playlistsWithAdditions = new Set<string>();
        const matchedPendingTrackIds: string[] = [];

        // Group by playlist for efficient processing
        const tracksByPlaylist = new Map<string, typeof allPendingTracks>();
        for (const pt of allPendingTracks) {
            const existing = tracksByPlaylist.get(pt.playlistId) || [];
            existing.push(pt);
            tracksByPlaylist.set(pt.playlistId, existing);
        }

        for (const [playlistId, pendingTracks] of tracksByPlaylist) {
            // Get existing track IDs in playlist to avoid duplicates
            const existingItems = await prisma.playlistItem.findMany({
                where: { playlistId },
                select: { trackId: true },
            });
            const existingTrackIds = new Set(
                existingItems.map((item) => item.trackId)
            );

            for (const pendingTrack of pendingTracks) {
                // Playlist imports should only ever reconcile against playlist downloads.
                // Tags can be "Various Artists" etc, so we match by filePath under Playlists/.
                const artistFolder = sanitizePathPart(pendingTrack.spotifyArtist);
                const albumFolder = pendingTrack.spotifyAlbum
                    ? sanitizePathPart(pendingTrack.spotifyAlbum)
                    : "";

                const strippedTitle = stripTrackSuffix(pendingTrack.spotifyTitle);
                const cleanedTitle = normalizeTrackTitle(strippedTitle);

                console.log(
                    `   Trying to match (playlist-only): "${pendingTrack.spotifyTitle}" by ${pendingTrack.spotifyArtist}`
                );

                const buildPrefixes = (artist: string, album?: string) => {
                    const base = `Playlists/${artist}/`;
                    const legacyBase = `soulseek-downloads/Playlists/${artist}/`;
                    if (album && album.length > 0) {
                        return [
                            `${base}${album}/`,
                            `${legacyBase}${album}/`,
                        ];
                    }
                    return [base, legacyBase];
                };

                const queryByPrefixes = async (prefixes: string[]) => {
                    if (prefixes.length === 0) return [] as Array<{ id: string; title: string; filePath: string }>;
                    return prisma.track.findMany({
                        where: {
                            OR: prefixes.map((p) => ({
                                filePath: { startsWith: p, mode: "insensitive" },
                            })),
                        },
                        select: { id: true, title: true, filePath: true },
                        take: 200,
                    });
                };

                // Prefer album folder, but fall back to artist folder (playlists are typically single-track downloads).
                let candidates = await queryByPrefixes(
                    buildPrefixes(artistFolder, albumFolder)
                );
                if (candidates.length === 0) {
                    candidates = await queryByPrefixes(buildPrefixes(artistFolder));
                }

                // Optional fallback: some setups may drop a leading "The" in folder names.
                if (candidates.length === 0) {
                    const artistWithoutTheRaw = pendingTrack.spotifyArtist
                        .replace(/^the\s+/i, "")
                        .trim();
                    const artistWithoutThe = sanitizePathPart(artistWithoutTheRaw);
                    if (artistWithoutThe && artistWithoutThe !== artistFolder) {
                        candidates = await queryByPrefixes(
                            buildPrefixes(artistWithoutThe, albumFolder)
                        );
                        if (candidates.length === 0) {
                            candidates = await queryByPrefixes(
                                buildPrefixes(artistWithoutThe)
                            );
                        }
                    }
                }

                if (candidates.length === 0) {
                    console.log(
                        `      No playlist-download candidates found for artist folder "${artistFolder}"`
                    );
                    continue;
                }

                // Pick best candidate by title match (safe because candidate set is constrained to Playlists/<artist>/...)
                let best: { id: string; title: string; filePath: string } | null = null;
                let bestScore = 0;
                for (const candidate of candidates) {
                    const candidateNorm = normalizeTrackTitle(candidate.title);
                    let score = stringSimilarity(cleanedTitle, candidateNorm);

                    // Exact match / containment boosts
                    if (candidateNorm === cleanedTitle) score = 100;
                    else {
                        const a = cleanedTitle.toLowerCase();
                        const b = candidateNorm.toLowerCase();
                        if (a.length > 0 && (b.includes(a) || a.includes(b))) {
                            score = Math.max(score, 90);
                        }
                    }

                    if (score > bestScore) {
                        bestScore = score;
                        best = candidate;
                    }
                }

                const wordCount = cleanedTitle.split(/\s+/).filter(Boolean).length;
                const minScore = wordCount <= 2 ? 60 : 75;

                if (!best || bestScore < minScore) {
                    console.log(
                        `      Found ${candidates.length} candidates, but best title score ${bestScore.toFixed(
                            0
                        )}% is below threshold ${minScore}%`
                    );
                    continue;
                }

                const localTrack = { id: best.id, title: best.title };
                console.log(
                    `      ✓ Matched via playlist path: "${best.title}" (${bestScore.toFixed(
                        0
                    )}%)`
                );

                if (localTrack && !existingTrackIds.has(localTrack.id)) {
                    // Add to playlist
                    await prisma.playlistItem.create({
                        data: {
                            playlistId,
                            trackId: localTrack.id,
                            sort: pendingTrack.sort,
                        },
                    });

                    existingTrackIds.add(localTrack.id);
                    matchedPendingTrackIds.push(pendingTrack.id);
                    totalTracksAdded++;
                    playlistsWithAdditions.add(playlistId);

                    console.log(
                        `   ✓ Matched: "${pendingTrack.spotifyTitle}" by ${pendingTrack.spotifyArtist}`
                    );
                }
            }
        }

        // Delete the matched pending tracks
        if (matchedPendingTrackIds.length > 0) {
            await prisma.playlistPendingTrack.deleteMany({
                where: { id: { in: matchedPendingTrackIds } },
            });
        }

        // Touch updatedAt on all playlists that gained tracks so Subsonic clients detect the change
        if (playlistsWithAdditions.size > 0) {
            await prisma.playlist.updateMany({
                where: { id: { in: [...playlistsWithAdditions] } },
                data: { updatedAt: new Date() },
            });
        }

        // Send notifications for each playlist that was updated
        if (playlistsWithAdditions.size > 0) {
            const { notificationService } = await import(
                "./notificationService"
            );

            for (const playlistId of playlistsWithAdditions) {
                const playlist = await prisma.playlist.findUnique({
                    where: { id: playlistId },
                    select: { id: true, name: true, userId: true },
                });

                if (playlist) {
                    const tracksAddedToPlaylist = matchedPendingTrackIds.filter(
                        (id) =>
                            allPendingTracks.find(
                                (pt) =>
                                    pt.id === id && pt.playlistId === playlistId
                            )
                    ).length;

                    await notificationService.create({
                        userId: playlist.userId,
                        type: "playlist_ready",
                        title: "Playlist Updated",
                        message: `${tracksAddedToPlaylist} new track${
                            tracksAddedToPlaylist !== 1 ? "s" : ""
                        } added to "${playlist.name}"`,
                        metadata: {
                            playlistId: playlist.id,
                            tracksAdded: tracksAddedToPlaylist,
                        },
                    });
                }
            }
        }

        console.log(
            `   Reconciliation complete: ${totalTracksAdded} tracks added to ${playlistsWithAdditions.size} playlists`
        );

        return {
            playlistsUpdated: playlistsWithAdditions.size,
            tracksAdded: totalTracksAdded,
        };
    }

    /**
     * Get pending tracks count for a playlist
     */
    async getPendingTracksCount(playlistId: string): Promise<number> {
        return prisma.playlistPendingTrack.count({
            where: { playlistId },
        });
    }

    /**
     * Get pending tracks for a playlist
     */
    async getPendingTracks(playlistId: string): Promise<
        Array<{
            id: string;
            artist: string;
            title: string;
            album: string;
        }>
    > {
        const tracks = await prisma.playlistPendingTrack.findMany({
            where: { playlistId },
            orderBy: { sort: "asc" },
        });

        return tracks.map((t) => ({
            id: t.id,
            artist: t.spotifyArtist,
            title: t.spotifyTitle,
            album: t.spotifyAlbum,
        }));
    }
}

export const spotifyImportService = new SpotifyImportService();
