/**
 * Subsonic API Routes
 *
 * Implements the Subsonic/OpenSubsonic API for compatibility with
 * desktop clients like Supersonic, Symfonium, DSub, etc.
 *
 * API Documentation: https://www.subsonic.org/pages/api.jsp
 * OpenSubsonic: https://opensubsonic.netlify.app/
 */

import { Router, Request, Response } from "express";
import path from "path";
import fs from "fs";
import axios from "axios";
import sharp from "sharp";
import { prisma } from "../utils/db";
import { config } from "../config";
import { requireSubsonicAuth } from "../middleware/subsonicAuth";
import { AudioStreamingService, Quality, QUALITY_SETTINGS } from "../services/audioStreaming";
import { scanQueue } from "../workers/queues";
import {
    sendSubsonicSuccess,
    sendSubsonicError,
    SubsonicErrorCode,
    getResponseFormat,
    formatTrackForSubsonic,
    formatAlbumForSubsonic,
    formatArtistForSubsonic,
    parseSubsonicId,
    SUBSONIC_API_VERSION,
    LIDIFY_SERVER_VERSION,
} from "../utils/subsonicResponse";

const router = Router();

// Normalize paths: some clients omit the .view suffix.
router.use((req: Request, _res: Response, next) => {
    if (!req.path.endsWith(".view")) {
        const query = req.url.includes("?") ? req.url.substring(req.url.indexOf("?")) : "";
        req.url = `${req.path}.view${query}`;
    }
    next();
});

// Log all Subsonic API requests for debugging
router.use((req: Request, res: Response, next) => {
    const endpoint = req.path;
    const client = req.query.c || 'unknown';
    // Skip noisy endpoints
    if (!endpoint.includes('ping') && !endpoint.includes('stream') && !endpoint.includes('getCoverArt')) {
        console.log(`[Subsonic] ${req.method} ${endpoint} from client=${client}`);
    }
    next();
});

// Apply Subsonic authentication to all routes
router.get("/tokenInfo.view", async (req: Request, res: Response) => {
    const format = getResponseFormat(req.query);
    const apiKey = req.query.apiKey as string | undefined;

    if (!apiKey) {
        return sendSubsonicError(
            res,
            SubsonicErrorCode.MISSING_PARAMETER,
            "Required parameter 'apiKey' is missing",
            format,
            req.query.callback as string
        );
    }

    const keyRecord = await prisma.apiKey.findUnique({
        where: { key: apiKey },
        select: {
            id: true,
            user: {
                select: {
                    username: true,
                },
            },
        },
    });

    if (!keyRecord) {
        return sendSubsonicError(
            res,
            SubsonicErrorCode.WRONG_CREDENTIALS,
            "Wrong username or password",
            format,
            req.query.callback as string
        );
    }

    prisma.apiKey.update({
        where: { id: keyRecord.id },
        data: { lastUsed: new Date() },
    }).catch(() => {});

    return sendSubsonicSuccess(
        res,
        {
            tokenInfo: {
                username: keyRecord.user.username,
            },
        },
        format,
        req.query.callback as string
    );
});

router.use(requireSubsonicAuth);

function parseRepeatedQueryParam(raw: unknown): string[] {
    if (Array.isArray(raw)) {
        return raw.filter(Boolean) as string[];
    }
    return raw ? [raw as string] : [];
}

function normalizeTrackIds(rawIds: string[]): string[] {
    return rawIds.map((id) => parseSubsonicId(id).id);
}

function getQueueTrackIds(queue: unknown): string[] {
    if (!Array.isArray(queue)) {
        return [];
    }

    return queue
        .map((item) => {
            if (typeof item === "string") {
                return item;
            }
            if (item && typeof item === "object" && "id" in item && typeof item.id === "string") {
                return item.id;
            }
            return null;
        })
        .filter((id): id is string => Boolean(id));
}

async function resolveTrackPath(
    trackFilePath: string,
    fileStorage: string = "music"
): Promise<string | null> {
    const normalizedFilePath = trackFilePath.replace(/\\/g, "/");

    const settings = await prisma.systemSettings.findFirst();
    const downloadPath = settings?.downloadPath || "/soulseek-downloads";
    const roots = fileStorage === "download"
        ? [downloadPath, config.music.musicPath]
        : [config.music.musicPath, downloadPath];
    const downloadPathPrefix = path.basename(downloadPath);
    const pathVariants = fileStorage === "download" && normalizedFilePath.startsWith(`${downloadPathPrefix}/`)
        ? [normalizedFilePath.slice(downloadPathPrefix.length + 1), normalizedFilePath]
        : [normalizedFilePath];
    if (fileStorage !== "download" && !normalizedFilePath.startsWith("Playlists/")) {
        pathVariants.push(`Playlists/${normalizedFilePath}`);
    }

    for (const root of roots) {
        for (const pathVariant of pathVariants) {
            const normalizedRoot = path.normalize(root);
            const candidate = path.normalize(path.join(root, pathVariant));

            // Prevent path traversal
            if (!candidate.startsWith(normalizedRoot + path.sep) && candidate !== normalizedRoot) {
                continue;
            }

            if (fs.existsSync(candidate)) {
                return candidate;
            }
        }
    }

    return null;
}

// ============================================================================
// SYSTEM ENDPOINTS
// ============================================================================

/**
 * ping.view - Test connectivity
 */
router.get("/ping.view", (req: Request, res: Response) => {
    const format = getResponseFormat(req.query);
    sendSubsonicSuccess(res, {}, format, req.query.callback as string);
});
router.post("/ping.view", (req: Request, res: Response) => {
    const format = getResponseFormat(req.query);
    sendSubsonicSuccess(res, {}, format, req.query.callback as string);
});

/**
 * getLicense.view - Return license info (always valid for self-hosted)
 */
router.get("/getLicense.view", (req: Request, res: Response) => {
    const format = getResponseFormat(req.query);
    sendSubsonicSuccess(
        res,
        {
            license: {
                valid: true,
                email: "self-hosted@lidify.local",
                licenseExpires: "2099-12-31T23:59:59",
            },
        },
        format,
        req.query.callback as string
    );
});

/**
 * getOpenSubsonicExtensions.view - Declare OpenSubsonic capabilities
 */
router.get("/getOpenSubsonicExtensions.view", (req: Request, res: Response) => {
    const format = getResponseFormat(req.query);
    sendSubsonicSuccess(
        res,
        {
            openSubsonicExtensions: [
                { name: "transcodeOffset", versions: [1] },
                { name: "songPlayedDate", versions: [1] },
                { name: "albumPlayedDate", versions: [1] },
                { name: "apiKeyAuthentication", versions: [1] },
                { name: "indexBasedQueue", versions: [1] },
            ],
        },
        format,
        req.query.callback as string
    );
});

// ============================================================================
// BROWSING ENDPOINTS
// ============================================================================

/**
 * getMusicFolders.view - Return available music folders
 */
router.get("/getMusicFolders.view", (req: Request, res: Response) => {
    const format = getResponseFormat(req.query);
    sendSubsonicSuccess(
        res,
        {
            musicFolders: {
                musicFolder: [{ id: 1, name: "Music" }],
            },
        },
        format,
        req.query.callback as string
    );
});

/**
 * getIndexes.view - Artists indexed by first letter (for folder browsing)
 */
router.get("/getIndexes.view", async (req: Request, res: Response) => {
    const format = getResponseFormat(req.query);

    try {
        const artists = await prisma.artist.findMany({
            select: {
                id: true,
                name: true,
                heroUrl: true,
                _count: { select: { albums: true } },
            },
            orderBy: { name: "asc" },
        });

        // Group by first letter
        const indexMap = new Map<string, any[]>();

        for (const artist of artists) {
            const firstChar = artist.name.charAt(0).toUpperCase();
            const indexKey = /[A-Z]/.test(firstChar) ? firstChar : "#";

            if (!indexMap.has(indexKey)) {
                indexMap.set(indexKey, []);
            }

            indexMap.get(indexKey)!.push({
                id: `ar-${artist.id}`,
                name: artist.name,
                artistImageUrl: artist.heroUrl || undefined,
                albumCount: artist._count.albums,
            });
        }

        const indexes = Array.from(indexMap.entries())
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([name, artists]) => ({
                name,
                artist: artists,
            }));

        sendSubsonicSuccess(
            res,
            {
                indexes: {
                    lastModified: Date.now(),
                    ignoredArticles: "The El La Los Las Le Les",
                    index: indexes,
                },
            },
            format,
            req.query.callback as string
        );
    } catch (error) {
        console.error("[Subsonic] getIndexes error:", error);
        sendSubsonicError(
            res,
            SubsonicErrorCode.GENERIC,
            "Failed to fetch indexes",
            format,
            req.query.callback as string
        );
    }
});

/**
 * getArtists.view - All artists (ID3 mode)
 */
router.get("/getArtists.view", async (req: Request, res: Response) => {
    const format = getResponseFormat(req.query);

    try {
        const artists = await prisma.artist.findMany({
            select: {
                id: true,
                name: true,
                heroUrl: true,
                _count: { select: { albums: true } },
            },
            orderBy: { name: "asc" },
        });

        // Group by first letter
        const indexMap = new Map<string, any[]>();

        for (const artist of artists) {
            const firstChar = artist.name.charAt(0).toUpperCase();
            const indexKey = /[A-Z]/.test(firstChar) ? firstChar : "#";

            if (!indexMap.has(indexKey)) {
                indexMap.set(indexKey, []);
            }

            indexMap.get(indexKey)!.push(formatArtistForSubsonic(artist));
        }

        const indexes = Array.from(indexMap.entries())
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([name, artists]) => ({
                name,
                artist: artists,
            }));

        sendSubsonicSuccess(
            res,
            {
                artists: {
                    ignoredArticles: "The El La Los Las Le Les",
                    index: indexes,
                },
            },
            format,
            req.query.callback as string
        );
    } catch (error) {
        console.error("[Subsonic] getArtists error:", error);
        sendSubsonicError(
            res,
            SubsonicErrorCode.GENERIC,
            "Failed to fetch artists",
            format,
            req.query.callback as string
        );
    }
});

/**
 * getArtist.view - Single artist with albums
 */
router.get("/getArtist.view", async (req: Request, res: Response) => {
    const format = getResponseFormat(req.query);
    const { id } = req.query;

    if (!id) {
        return sendSubsonicError(
            res,
            SubsonicErrorCode.MISSING_PARAMETER,
            "Required parameter 'id' is missing",
            format,
            req.query.callback as string
        );
    }

    try {
        const { type, id: artistId } = parseSubsonicId(id as string);

        const artist = await prisma.artist.findUnique({
            where: { id: artistId },
            include: {
                albums: {
                    include: {
                        _count: { select: { tracks: true } },
                        tracks: { select: { duration: true, id: true } },
                    },
                    orderBy: [{ year: "desc" }, { title: "asc" }],
                },
                _count: { select: { albums: true } },
            },
        });

        if (!artist) {
            return sendSubsonicError(
                res,
                SubsonicErrorCode.NOT_FOUND,
                "Artist not found",
                format,
                req.query.callback as string
            );
        }

        // Query play data for all albums
        const albumIds = artist.albums.map(a => a.id);

        const [lastPlayedData, playCountData] = await Promise.all([
            prisma.$queryRaw<Array<{ albumId: string; lastPlayed: Date }>>`
                SELECT t."albumId", MAX(p."playedAt") as "lastPlayed"
                FROM "Play" p
                INNER JOIN "Track" t ON t.id = p."trackId"
                WHERE t."albumId" = ANY(${albumIds})
                GROUP BY t."albumId"
            `,
            prisma.$queryRaw<Array<{ albumId: string; playCount: bigint }>>`
                SELECT t."albumId", COUNT(p.id) as "playCount"
                FROM "Play" p
                INNER JOIN "Track" t ON t.id = p."trackId"
                WHERE t."albumId" = ANY(${albumIds})
                GROUP BY t."albumId"
            `
        ]);

        const lastPlayedMap = new Map(lastPlayedData.map(d => [d.albumId, d.lastPlayed]));
        const playCountMap = new Map(playCountData.map(d => [d.albumId, Number(d.playCount)]));

        const albums = artist.albums.map((album) => ({
            id: `al-${album.id}`,
            parent: `ar-${artist.id}`,
            isDir: true,
            title: album.title,
            name: album.title,
            album: album.title,
            artist: artist.name,
            year: album.year || undefined,
            coverArt: album.coverUrl ? `al-${album.id}` : undefined,
            songCount: album._count.tracks,
            duration: album.tracks.reduce((sum, t) => sum + (t.duration || 0), 0),
            artistId: `ar-${artist.id}`,
            musicFolderId: 1,
            created: album.location === "LIBRARY" ? album.createdAt?.toISOString() || "" : undefined,
            played: lastPlayedMap.get(album.id)?.toISOString(),
            playCount: playCountMap.get(album.id) || 0,
        }));

        sendSubsonicSuccess(
            res,
            {
                artist: {
                    id: `ar-${artist.id}`,
                    name: artist.name,
                    coverArt: artist.heroUrl ? `ar-${artist.id}` : undefined,
                    albumCount: artist._count.albums,
                    artistImageUrl: artist.heroUrl || undefined,
                    album: albums,
                },
            },
            format,
            req.query.callback as string
        );
    } catch (error) {
        console.error("[Subsonic] getArtist error:", error);
        sendSubsonicError(
            res,
            SubsonicErrorCode.GENERIC,
            "Failed to fetch artist",
            format,
            req.query.callback as string
        );
    }
});

/**
 * getAlbum.view - Album details with tracks
 */
router.get("/getAlbum.view", async (req: Request, res: Response) => {
    const format = getResponseFormat(req.query);
    const { id } = req.query;

    if (!id) {
        return sendSubsonicError(
            res,
            SubsonicErrorCode.MISSING_PARAMETER,
            "Required parameter 'id' is missing",
            format,
            req.query.callback as string
        );
    }

    try {
        const { id: albumId } = parseSubsonicId(id as string);

        const album = await prisma.album.findUnique({
            where: { id: albumId },
            include: {
                artist: { select: { id: true, name: true } },
                tracks: {
                    orderBy: [{ discNo: "asc" }, { trackNo: "asc" }],
                },
            },
        });

        if (!album) {
            return sendSubsonicError(
                res,
                SubsonicErrorCode.NOT_FOUND,
                "Album not found",
                format,
                req.query.callback as string
            );
        }

        // Query play data for this album
        const [lastPlayedResult, playCountResult] = await Promise.all([
            prisma.$queryRaw<Array<{ lastPlayed: Date }>>`
                SELECT MAX(p."playedAt") as "lastPlayed"
                FROM "Play" p
                INNER JOIN "Track" t ON t.id = p."trackId"
                WHERE t."albumId" = ${albumId}
            `,
            prisma.$queryRaw<Array<{ playCount: bigint }>>`
                SELECT COUNT(p.id) as "playCount"
                FROM "Play" p
                INNER JOIN "Track" t ON t.id = p."trackId"
                WHERE t."albumId" = ${albumId}
            `
        ]);

        const lastPlayed = lastPlayedResult[0]?.lastPlayed;
        const playCount = Number(playCountResult[0]?.playCount || 0);

        // Get play data for all tracks in this album
        const trackIds = album.tracks.map(t => t.id);
        const trackPlayData = trackIds.length > 0 ? await prisma.$queryRaw<Array<{ trackId: string; lastPlayed: Date; playCount: bigint }>>`
            SELECT p."trackId", MAX(p."playedAt") as "lastPlayed", COUNT(p.id) as "playCount"
            FROM "Play" p
            WHERE p."trackId" = ANY(${trackIds})
            GROUP BY p."trackId"
        ` : [];
        const trackLastPlayed = new Map(trackPlayData.map(d => [d.trackId, d.lastPlayed]));
        const trackPlayCount = new Map(trackPlayData.map(d => [d.trackId, Number(d.playCount)]));

        const songs = album.tracks.map((track) =>
            formatTrackForSubsonic({
                ...track,
                album: {
                    id: album.id,
                    title: album.title,
                    coverUrl: album.coverUrl,
                    year: album.year,
                    createdAt: album.createdAt,
                    location: album.location,
                    artist: album.artist,
                },
            }, {
                played: trackLastPlayed.get(track.id),
                playCount: trackPlayCount.get(track.id) || 0,
            })
        );

        sendSubsonicSuccess(
            res,
            {
                album: {
                    id: `al-${album.id}`,
                    parent: `ar-${album.artist.id}`,
                    isDir: true,
                    title: album.title,
                    name: album.title,
                    album: album.title,
                    artist: album.artist.name,
                    year: album.year || undefined,
                    coverArt: album.coverUrl ? `al-${album.id}` : undefined,
                    songCount: album.tracks.length,
                    duration: album.tracks.reduce((sum, t) => sum + (t.duration || 0), 0),
                    artistId: `ar-${album.artist.id}`,
                    musicFolderId: 1,
                    created: album.location === "LIBRARY" ? album.createdAt?.toISOString() || "" : undefined,
                    played: lastPlayed?.toISOString(),
                    playCount,
                    song: songs,
                },
            },
            format,
            req.query.callback as string
        );
    } catch (error) {
        console.error("[Subsonic] getAlbum error:", error);
        sendSubsonicError(
            res,
            SubsonicErrorCode.GENERIC,
            "Failed to fetch album",
            format,
            req.query.callback as string
        );
    }
});

/**
 * getSong.view - Single track details
 */
router.get("/getSong.view", async (req: Request, res: Response) => {
    const format = getResponseFormat(req.query);
    const { id } = req.query;

    if (!id) {
        return sendSubsonicError(
            res,
            SubsonicErrorCode.MISSING_PARAMETER,
            "Required parameter 'id' is missing",
            format,
            req.query.callback as string
        );
    }

    try {
        const { id: trackId } = parseSubsonicId(id as string);

        const track = await prisma.track.findUnique({
            where: { id: trackId },
            include: {
                album: {
                    include: {
                        artist: { select: { id: true, name: true } },
                    },
                },
            },
        });

        if (!track || !track.album) {
            return sendSubsonicError(
                res,
                SubsonicErrorCode.NOT_FOUND,
                "Song not found",
                format,
                req.query.callback as string
            );
        }

        // Get play data for this track
        const playData = await prisma.$queryRaw<Array<{ lastPlayed: Date; playCount: bigint }>>`
            SELECT MAX(p."playedAt") as "lastPlayed", COUNT(p.id) as "playCount"
            FROM "Play" p
            WHERE p."trackId" = ${trackId}
        `;
        const lastPlayed = playData[0]?.lastPlayed;
        const playCount = Number(playData[0]?.playCount || 0);

        sendSubsonicSuccess(
            res,
            {
                song: formatTrackForSubsonic({
                    ...track,
                    album: {
                        id: track.album.id,
                        title: track.album.title,
                        coverUrl: track.album.coverUrl,
                        year: track.album.year,
                        createdAt: track.album.createdAt,
                        location: track.album.location,
                        artist: track.album.artist,
                    },
                }, {
                    played: lastPlayed,
                    playCount,
                }),
            },
            format,
            req.query.callback as string
        );
    } catch (error) {
        console.error("[Subsonic] getSong error:", error);
        sendSubsonicError(
            res,
            SubsonicErrorCode.GENERIC,
            "Failed to fetch song",
            format,
            req.query.callback as string
        );
    }
});

/**
 * getAlbumList.view / getAlbumList2.view - Album list with sorting options
 */
const albumListHandler = async (req: Request, res: Response) => {
    const format = getResponseFormat(req.query);
    const {
        type = "alphabeticalByName",
        size = "10",
        offset = "0",
        fromYear,
        toYear,
        genre,
    } = req.query;

    try {
        const limit = Math.min(parseInt(size as string, 10) || 10, 500);
        const skip = parseInt(offset as string, 10) || 0;

        console.log(`[Subsonic] getAlbumList2: type=${type}, limit=${limit}, offset=${skip}`);

        // Handle special sort types that need aggregation
        if (type === "frequent" || type === "highest") {
            // Get albums sorted by play count
            const albumsWithPlays = await prisma.$queryRaw<Array<{ albumId: string; playCount: bigint }>>`
                SELECT a.id as "albumId", COUNT(p.id) as "playCount"
                FROM "Album" a
                LEFT JOIN "Track" t ON t."albumId" = a.id
                LEFT JOIN "Play" p ON p."trackId" = t.id
                GROUP BY a.id
                ORDER BY "playCount" DESC
                LIMIT ${limit} OFFSET ${skip}
            `;

            const albumIds = albumsWithPlays.map(a => a.albumId);
            const albums = await prisma.album.findMany({
                where: { id: { in: albumIds } },
                include: {
                    artist: { select: { id: true, name: true } },
                    _count: { select: { tracks: true } },
                    tracks: { select: { duration: true } },
                },
            });

            // Sort by original order and build play count map
            const albumMap = new Map(albums.map(a => [a.id, a]));
            const playCountMap = new Map(albumsWithPlays.map(a => [a.albumId, Number(a.playCount)]));
            const sortedAlbums = albumIds.map(id => albumMap.get(id)).filter(Boolean);

            // Get last played times
            const lastPlayedData = await prisma.$queryRaw<Array<{ albumId: string; lastPlayed: Date }>>`
                SELECT t."albumId", MAX(p."playedAt") as "lastPlayed"
                FROM "Play" p
                INNER JOIN "Track" t ON t.id = p."trackId"
                WHERE t."albumId" = ANY(${albumIds})
                GROUP BY t."albumId"
            `;
            const lastPlayedMap = new Map(lastPlayedData.map(d => [d.albumId, d.lastPlayed]));

            const albumList = sortedAlbums.map((album) => ({
                id: `al-${album!.id}`,
                parent: `ar-${album!.artist.id}`,
                isDir: true,
                title: album!.title,
                name: album!.title,
                album: album!.title,
                artist: album!.artist.name,
                year: album!.year || undefined,
                coverArt: album!.coverUrl ? `al-${album!.id}` : undefined,
                songCount: album!._count.tracks,
                duration: album!.tracks.reduce((sum, t) => sum + (t.duration || 0), 0),
                artistId: `ar-${album!.artist.id}`,
                musicFolderId: 1,
                created: album!.location === "LIBRARY" ? album!.createdAt?.toISOString() || "" : undefined,
                played: lastPlayedMap.get(album!.id) ? lastPlayedMap.get(album!.id)!.toISOString() : undefined,
                playCount: playCountMap.get(album!.id) || 0,
            }));

            return sendSubsonicSuccess(
                res,
                { albumList2: { album: albumList } },
                format,
                req.query.callback as string
            );
        }

        if (type === "recent") {
            // Get albums sorted by most recent play with play count
            const albumsWithRecent = await prisma.$queryRaw<Array<{ albumId: string; lastPlayed: Date; playCount: bigint }>>`
                SELECT a.id as "albumId", MAX(p."playedAt") as "lastPlayed", COUNT(p.id) as "playCount"
                FROM "Album" a
                INNER JOIN "Track" t ON t."albumId" = a.id
                INNER JOIN "Play" p ON p."trackId" = t.id
                GROUP BY a.id
                ORDER BY "lastPlayed" DESC
                LIMIT ${limit} OFFSET ${skip}
            `;

            const albumIds = albumsWithRecent.map(a => a.albumId);
            const lastPlayedMap = new Map(albumsWithRecent.map(a => [a.albumId, a.lastPlayed]));
            const playCountMap = new Map(albumsWithRecent.map(a => [a.albumId, Number(a.playCount)]));

            const albums = await prisma.album.findMany({
                where: { id: { in: albumIds } },
                include: {
                    artist: { select: { id: true, name: true } },
                    _count: { select: { tracks: true } },
                    tracks: { select: { duration: true } },
                },
            });

            const albumMap = new Map(albums.map(a => [a.id, a]));
            const sortedAlbums = albumIds.map(id => albumMap.get(id)).filter(Boolean);

            const albumList = sortedAlbums.map((album) => ({
                id: `al-${album!.id}`,
                parent: `ar-${album!.artist.id}`,
                isDir: true,
                title: album!.title,
                name: album!.title,
                album: album!.title,
                artist: album!.artist.name,
                year: album!.year || undefined,
                coverArt: album!.coverUrl ? `al-${album!.id}` : undefined,
                songCount: album!._count.tracks,
                duration: album!.tracks.reduce((sum, t) => sum + (t.duration || 0), 0),
                artistId: `ar-${album!.artist.id}`,
                musicFolderId: 1,
                created: album!.location === "LIBRARY" ? album!.createdAt?.toISOString() || "" : undefined,
                played: lastPlayedMap.get(album!.id) ? lastPlayedMap.get(album!.id)!.toISOString() : undefined,
                playCount: playCountMap.get(album!.id) || 0,
            }));

            return sendSubsonicSuccess(
                res,
                { albumList2: { album: albumList } },
                format,
                req.query.callback as string
            );
        }

        let orderBy: any = { title: "asc" };
        let where: any = {};

        switch (type) {
            case "random":
                // Prisma doesn't support random ordering natively
                // We'll fetch more and shuffle
                break;
            case "newest":
                orderBy = { createdAt: "desc" };
                // Keep global "recently added" scoped to main library only.
                // Playlist-only imports should be discoverable via playlist/search endpoints,
                // but not surfaced in the global recent feed.
                where = {
                    AND: [
                        { location: "LIBRARY" },
                        {
                            tracks: {
                                some: {
                                    NOT: {
                                        OR: [
                                            { filePath: { startsWith: "Playlists/" } },
                                            { filePath: { startsWith: "soulseek-downloads/Playlists/" } },
                                        ],
                                    },
                                },
                            },
                        },
                    ],
                };
                break;
            case "alphabeticalByName":
                orderBy = { title: "asc" };
                break;
            case "alphabeticalByArtist":
                orderBy = { artist: { name: "asc" } };
                break;
            case "starred":
                where = {
                    location: "LIBRARY",
                    tracks: {
                        some: {
                            likedBy: {
                                some: {
                                    userId: req.user!.id,
                                },
                            },
                        },
                    },
                };
                break;
            case "byYear":
                if (fromYear && toYear) {
                    where.year = {
                        gte: parseInt(fromYear as string, 10),
                        lte: parseInt(toYear as string, 10),
                    };
                }
                orderBy = { year: "desc" };
                break;
            case "byGenre":
                // Would need genre data on albums - fall back to alphabetical
                orderBy = { title: "asc" };
                break;
        }

        let albums = await prisma.album.findMany({
            where,
            include: {
                artist: { select: { id: true, name: true } },
                _count: { select: { tracks: true } },
                tracks: { select: { duration: true } },
            },
            orderBy,
            skip: type === "random" ? 0 : skip,
            take: type === "random" ? limit * 3 : limit,
        });

        // Handle random sorting
        if (type === "random") {
            albums = albums.sort(() => Math.random() - 0.5).slice(0, limit);
        }

        // Get play data for albums
        const albumIds = albums.map(a => a.id);
        const albumPlayData = albumIds.length > 0 ? await prisma.$queryRaw<Array<{ albumId: string; lastPlayed: Date; playCount: bigint }>>`
            SELECT t."albumId", MAX(p."playedAt") as "lastPlayed", COUNT(p.id) as "playCount"
            FROM "Play" p
            INNER JOIN "Track" t ON t.id = p."trackId"
            WHERE t."albumId" = ANY(${albumIds})
            GROUP BY t."albumId"
        ` : [];
        const albumLastPlayed = new Map(albumPlayData.map(d => [d.albumId, d.lastPlayed]));
        const albumPlayCount = new Map(albumPlayData.map(d => [d.albumId, Number(d.playCount)]));

        const albumList = albums.map((album) => {
            const lastPlay = albumLastPlayed.get(album.id);
            const playCount = albumPlayCount.get(album.id) || 0;
            return {
                id: `al-${album.id}`,
                parent: `ar-${album.artist.id}`,
                isDir: true,
                title: album.title,
                name: album.title,
                album: album.title,
                artist: album.artist.name,
                year: album.year || undefined,
                coverArt: album.coverUrl ? `al-${album.id}` : undefined,
                songCount: album._count.tracks,
                duration: album.tracks.reduce((sum, t) => sum + (t.duration || 0), 0),
                artistId: `ar-${album.artist.id}`,
                musicFolderId: 1,
                created: album.location === "LIBRARY" ? album.createdAt?.toISOString() || "" : undefined,
                played: lastPlay ? lastPlay.toISOString() : undefined,
                playCount,
            };
        });

        sendSubsonicSuccess(
            res,
            { albumList2: { album: albumList } },
            format,
            req.query.callback as string
        );
    } catch (error) {
        console.error("[Subsonic] getAlbumList2 error:", error);
        sendSubsonicError(
            res,
            SubsonicErrorCode.GENERIC,
            "Failed to fetch album list",
            format,
            req.query.callback as string
        );
    }
};

router.get("/getAlbumList.view", albumListHandler);
router.get("/getAlbumList2.view", albumListHandler);

/**
 * getRandomSongs.view - Random tracks
 */
router.get("/getRandomSongs.view", async (req: Request, res: Response) => {
    const format = getResponseFormat(req.query);
    const { size = "10", genre, fromYear, toYear } = req.query;

    try {
        const limit = Math.min(parseInt(size as string, 10) || 10, 500);

        const where: any = {};
        if (fromYear || toYear) {
            where.album = {
                year: {
                    ...(fromYear ? { gte: parseInt(fromYear as string, 10) } : {}),
                    ...(toYear ? { lte: parseInt(toYear as string, 10) } : {}),
                },
            };
        }

        // Fetch more tracks and shuffle
        const tracks = await prisma.track.findMany({
            where,
            include: {
                album: {
                    include: {
                        artist: { select: { id: true, name: true } },
                    },
                },
            },
            take: limit * 5,
        });

        const shuffled = tracks.sort(() => Math.random() - 0.5).slice(0, limit);

        // Get play data for shuffled tracks
        const trackIds = shuffled.filter(t => t.album).map(t => t.id);
        const trackPlayData = trackIds.length > 0 ? await prisma.$queryRaw<Array<{ trackId: string; lastPlayed: Date; playCount: bigint }>>`
            SELECT p."trackId", MAX(p."playedAt") as "lastPlayed", COUNT(p.id) as "playCount"
            FROM "Play" p
            WHERE p."trackId" = ANY(${trackIds})
            GROUP BY p."trackId"
        ` : [];
        const trackLastPlayed = new Map(trackPlayData.map(d => [d.trackId, d.lastPlayed]));
        const trackPlayCount = new Map(trackPlayData.map(d => [d.trackId, Number(d.playCount)]));

        const songs = shuffled
            .filter((t) => t.album)
            .map((track) =>
                formatTrackForSubsonic({
                    ...track,
                    album: {
                        id: track.album!.id,
                        title: track.album!.title,
                        coverUrl: track.album!.coverUrl,
                        year: track.album!.year,
                        createdAt: track.album!.createdAt,
                        location: track.album!.location,
                        artist: track.album!.artist,
                    },
                }, {
                    played: trackLastPlayed.get(track.id),
                    playCount: trackPlayCount.get(track.id) || 0,
                })
            );

        sendSubsonicSuccess(
            res,
            { randomSongs: { song: songs } },
            format,
            req.query.callback as string
        );
    } catch (error) {
        console.error("[Subsonic] getRandomSongs error:", error);
        sendSubsonicError(
            res,
            SubsonicErrorCode.GENERIC,
            "Failed to fetch random songs",
            format,
            req.query.callback as string
        );
    }
});

// ============================================================================
// SEARCH ENDPOINTS
// ============================================================================

/**
 * search3.view - Search for artists, albums, songs (ID3 mode)
 */
router.get("/search3.view", async (req: Request, res: Response) => {
    const format = getResponseFormat(req.query);
    const query = (req.query.query as string) ?? ""; // Allow empty query for full library sync
    const artistCount = req.query.artistCount as string | undefined;
    const artistOffset = req.query.artistOffset as string | undefined;
    const albumCount = req.query.albumCount as string | undefined;
    const albumOffset = req.query.albumOffset as string | undefined;
    const songCount = req.query.songCount as string | undefined;
    const songOffset = req.query.songOffset as string | undefined;

    try {
        // Handle empty query - Symfonium sends "" (literal quotes) for full library sync
        let searchTerm = ((query as string) || "").toLowerCase().trim();
        // Remove surrounding quotes if present (e.g., '""' or '"something"')
        if (searchTerm.startsWith('"') && searchTerm.endsWith('"')) {
            searchTerm = searchTerm.slice(1, -1);
        }

        // Many clients do full sync with query="" and omit *Count params.
        // In that case, returning only the Subsonic default (20) causes partial local indexes.
        const parseCount = (value: string | undefined, fullSyncDefault: number): number => {
            const parsed = value !== undefined ? parseInt(value, 10) : NaN;
            if (!Number.isFinite(parsed) || parsed < 0) {
                return fullSyncDefault;
            }
            if (parsed === 0) {
                return fullSyncDefault;
            }
            return parsed;
        };
        const parseOffset = (value: string | undefined): number => {
            const parsed = value !== undefined ? parseInt(value, 10) : NaN;
            if (!Number.isFinite(parsed) || parsed < 0) {
                return 0;
            }
            return parsed;
        };

        const isFullSyncQuery = searchTerm.length === 0;
        const artistTake = parseCount(artistCount, isFullSyncQuery ? 5000 : 20);
        const albumTake = parseCount(albumCount, isFullSyncQuery ? 5000 : 20);
        const songTake = parseCount(songCount, isFullSyncQuery ? 50000 : 20);
        const artistSkip = parseOffset(artistOffset);
        const albumSkip = parseOffset(albumOffset);
        const songSkip = parseOffset(songOffset);

        console.log(
            `[Subsonic] search3.view: query="${searchTerm}" artist=${artistTake}/${artistSkip} album=${albumTake}/${albumSkip} song=${songTake}/${songSkip}`
        );

        // Build where clauses - empty search term returns all results.
        // Include tracks/albums/artists that are either in LIBRARY or referenced by this
        // user's playlists, so Subsonic clients can resolve playlist entries reliably.
        const playlistVisibilityFilter = {
            playlistItems: {
                some: {
                    playlist: {
                        userId: req.user!.id,
                    },
                },
            },
        };

        const artistVisibilityFilter = {
            albums: {
                some: {
                    OR: [
                        { location: "LIBRARY" as const },
                        {
                            tracks: {
                                some: playlistVisibilityFilter,
                            },
                        },
                    ],
                },
            },
        };

        const albumVisibilityFilter = {
            OR: [
                { location: "LIBRARY" as const },
                {
                    tracks: {
                        some: playlistVisibilityFilter,
                    },
                },
            ],
        };

        const trackVisibilityFilter = {
            OR: [
                { album: { location: "LIBRARY" as const } },
                playlistVisibilityFilter,
            ],
        };

        const artistWhere = searchTerm
            ? {
                  ...artistVisibilityFilter,
                  name: { contains: searchTerm, mode: "insensitive" as const },
              }
            : artistVisibilityFilter;
        const albumWhere = searchTerm
            ? {
                  AND: [
                      albumVisibilityFilter,
                      {
                          OR: [
                              { title: { contains: searchTerm, mode: "insensitive" as const } },
                              { artist: { name: { contains: searchTerm, mode: "insensitive" as const } } },
                          ],
                      },
                  ],
              }
            : albumVisibilityFilter;
        const trackWhere = searchTerm
            ? {
                  AND: [
                      trackVisibilityFilter,
                      {
                          OR: [
                              { title: { contains: searchTerm, mode: "insensitive" as const } },
                              { album: { title: { contains: searchTerm, mode: "insensitive" as const } } },
                              { album: { artist: { name: { contains: searchTerm, mode: "insensitive" as const } } } },
                          ],
                      },
                  ],
              }
            : trackVisibilityFilter;

        // Run all searches in parallel for better performance
        const [artists, albums, songs] = await Promise.all([
            // Search artists - count=0 means return all (Symfonium behavior)
            prisma.artist.findMany({
                where: artistWhere,
                select: {
                    id: true,
                    name: true,
                    heroUrl: true,
                    lastSynced: true, // Use lastSynced for "date added" sorting (when content was last added)
                    _count: { select: { albums: true } },
                },
                orderBy: { name: "asc" },
                skip: artistSkip,
                take: artistTake,
            }),
            // Search albums - count=0 means return all (Symfonium behavior)
            prisma.album.findMany({
                where: albumWhere,
                include: {
                    artist: { select: { id: true, name: true } },
                    _count: { select: { tracks: true } },
                    tracks: { select: { duration: true } },
                },
                orderBy: { title: "asc" },
                skip: albumSkip,
                take: albumTake,
            }),
            // Search songs - count=0 means return all (Symfonium behavior)
            prisma.track.findMany({
                where: trackWhere,
                include: {
                    album: {
                        include: {
                            artist: { select: { id: true, name: true } },
                        },
                    },
                },
                orderBy: { title: "asc" },
                skip: songSkip,
                take: songTake,
            }),
        ]);

        // Get last played time and play count for all albums in one query
        const albumIds = albums.map(a => a.id);
        const albumPlayData = albumIds.length > 0 ? await prisma.$queryRaw<Array<{ albumId: string; lastPlayed: Date; playCount: bigint }>>`
            SELECT t."albumId", MAX(p."playedAt") as "lastPlayed", COUNT(p.id) as "playCount"
            FROM "Play" p
            INNER JOIN "Track" t ON t.id = p."trackId"
            WHERE t."albumId" = ANY(${albumIds})
            GROUP BY t."albumId"
        ` : [];
        const albumLastPlayed = new Map(albumPlayData.map(d => [d.albumId, d.lastPlayed]));
        const albumPlayCount = new Map(albumPlayData.map(d => [d.albumId, Number(d.playCount)]));

        // Get last played time and play count for all artists in one query
        const artistIds = artists.map(a => a.id);
        const artistPlayData = artistIds.length > 0 ? await prisma.$queryRaw<Array<{ artistId: string; lastPlayed: Date; playCount: bigint }>>`
            SELECT al."artistId", MAX(p."playedAt") as "lastPlayed", COUNT(p.id) as "playCount"
            FROM "Play" p
            INNER JOIN "Track" t ON t.id = p."trackId"
            INNER JOIN "Album" al ON al.id = t."albumId"
            WHERE al."artistId" = ANY(${artistIds})
            GROUP BY al."artistId"
        ` : [];
        const artistLastPlayed = new Map(artistPlayData.map(d => [d.artistId, d.lastPlayed]));
        const artistPlayCount = new Map(artistPlayData.map(d => [d.artistId, Number(d.playCount)]));

        // Get last played time and play count for all songs in one query
        const songIds = songs.map(s => s.id);
        const songPlayData = songIds.length > 0 ? await prisma.$queryRaw<Array<{ trackId: string; lastPlayed: Date; playCount: bigint }>>`
            SELECT p."trackId", MAX(p."playedAt") as "lastPlayed", COUNT(p.id) as "playCount"
            FROM "Play" p
            WHERE p."trackId" = ANY(${songIds})
            GROUP BY p."trackId"
        ` : [];
        const songLastPlayed = new Map(songPlayData.map(d => [d.trackId, d.lastPlayed]));
        const songPlayCount = new Map(songPlayData.map(d => [d.trackId, Number(d.playCount)]));

        // Debug: Log a sample album with plays
        const sampleAlbum = albums.find(a => albumLastPlayed.has(a.id));
        if (sampleAlbum) {
            const lp = albumLastPlayed.get(sampleAlbum.id);
            const pc = albumPlayCount.get(sampleAlbum.id);
            const obj = {
                id: `al-${sampleAlbum.id}`,
                title: sampleAlbum.title,
                created: sampleAlbum.createdAt?.toISOString(),
                played: lp?.toISOString(),
                playCount: pc,
            };
            console.log(`[Subsonic] Sample album JSON: ${JSON.stringify(obj)}`);
        }

        sendSubsonicSuccess(
            res,
            {
                searchResult3: {
                    artist: artists.map((a) => {
                        const lastPlay = artistLastPlayed.get(a.id);
                        const playCount = artistPlayCount.get(a.id) || 0;
                        return {
                            id: `ar-${a.id}`,
                            name: a.name,
                            coverArt: a.heroUrl ? `ar-${a.id}` : undefined,
                            albumCount: a._count?.albums || 0,
                            artistImageUrl: a.heroUrl || undefined,
                            created: a.lastSynced?.toISOString() || "", // lastSynced = when content was last added
                            played: lastPlay ? lastPlay.toISOString() : undefined,
                            playCount,
                        };
                    }),
                    album: albums.map((album) => {
                        const lastPlay = albumLastPlayed.get(album.id);
                        const playCount = albumPlayCount.get(album.id) || 0;
                        return {
                            id: `al-${album.id}`,
                            parent: `ar-${album.artist.id}`,
                            isDir: true,
                            title: album.title,
                            name: album.title,
                            album: album.title,
                            artist: album.artist.name,
                            year: album.year || undefined,
                            coverArt: album.coverUrl ? `al-${album.id}` : undefined,
                            songCount: album._count.tracks,
                            duration: album.tracks.reduce((sum, t) => sum + (t.duration || 0), 0),
                            artistId: `ar-${album.artist.id}`,
                            musicFolderId: 1,
                            created: album.location === "LIBRARY" ? album.createdAt?.toISOString() || "" : undefined,
                            played: lastPlay ? lastPlay.toISOString() : undefined, // Must always include, even if empty
                            playCount,
                        };
                    }),
                    song: songs
                        .filter((t) => t.album)
                        .map((track) =>
                            formatTrackForSubsonic({
                                ...track,
                                album: {
                                    id: track.album!.id,
                                    title: track.album!.title,
                                    coverUrl: track.album!.coverUrl,
                                    year: track.album!.year,
                                    createdAt: track.album!.createdAt,
                                    location: track.album!.location,
                                    artist: track.album!.artist,
                                },
                            }, {
                                played: songLastPlayed.get(track.id),
                                playCount: songPlayCount.get(track.id) || 0,
                            })
                        ),
                },
            },
            format,
            req.query.callback as string
        );
    } catch (error) {
        console.error("[Subsonic] search3 error:", error);
        sendSubsonicError(
            res,
            SubsonicErrorCode.GENERIC,
            "Search failed",
            format,
            req.query.callback as string
        );
    }
});

// ============================================================================
// MEDIA RETRIEVAL ENDPOINTS
// ============================================================================

/**
 * stream.view - Stream audio file
 */
router.get("/stream.view", async (req: Request, res: Response) => {
    const format = getResponseFormat(req.query);
    const { id, maxBitRate, format: targetFormat } = req.query;

    if (!id) {
        return sendSubsonicError(
            res,
            SubsonicErrorCode.MISSING_PARAMETER,
            "Required parameter 'id' is missing",
            format,
            req.query.callback as string
        );
    }

    try {
        const { id: trackId } = parseSubsonicId(id as string);

        const track = await prisma.track.findUnique({
            where: { id: trackId },
        });

        if (!track || !track.filePath || !track.fileModified) {
            return sendSubsonicError(
                res,
                SubsonicErrorCode.NOT_FOUND,
                "Song not found",
                format,
                req.query.callback as string
            );
        }

        // Determine quality from maxBitRate
        let quality: Quality = "original";
        if (maxBitRate) {
            const bitrate = parseInt(maxBitRate as string, 10);
            if (bitrate > 0 && bitrate < 128) {
                quality = "low";
            } else if (bitrate >= 128 && bitrate < 192) {
                quality = "low";
            } else if (bitrate >= 192 && bitrate < 320) {
                quality = "medium";
            } else if (bitrate >= 320) {
                quality = "high";
            }
        }

        // If format=raw or no bitrate limit, use original
        if (targetFormat === "raw" || !maxBitRate) {
            quality = "original";
        }

        // Initialize streaming service
        const streamingService = new AudioStreamingService(
            config.music.musicPath,
            config.music.transcodeCachePath,
            config.music.transcodeCacheMaxGb
        );

        const absolutePath = await resolveTrackPath(track.filePath, track.fileStorage);

        if (!absolutePath) {
            return sendSubsonicError(
                res,
                SubsonicErrorCode.NOT_FOUND,
                "File not found",
                format,
                req.query.callback as string
            );
        }

        // Get stream file
        const { filePath, mimeType } = await streamingService.getStreamFilePath(
            track.id,
            quality,
            track.fileModified,
            absolutePath
        );

        // Stream file
        res.sendFile(
            filePath,
            {
                headers: {
                    "Content-Type": mimeType,
                    "Accept-Ranges": "bytes",
                    "Cache-Control": "public, max-age=31536000",
                },
            },
            (err) => {
                streamingService.destroy();
                if (err && (err as any).code !== "ECONNABORTED") {
                    console.error("[Subsonic] stream error:", err);
                }
            }
        );
    } catch (error) {
        console.error("[Subsonic] stream error:", error);
        sendSubsonicError(
            res,
            SubsonicErrorCode.GENERIC,
            "Failed to stream",
            format,
            req.query.callback as string
        );
    }
});

/**
 * download.view - Download original file
 */
router.get("/download.view", async (req: Request, res: Response) => {
    const format = getResponseFormat(req.query);
    const { id } = req.query;

    if (!id) {
        return sendSubsonicError(
            res,
            SubsonicErrorCode.MISSING_PARAMETER,
            "Required parameter 'id' is missing",
            format,
            req.query.callback as string
        );
    }

    try {
        const { id: trackId } = parseSubsonicId(id as string);

        const track = await prisma.track.findUnique({
            where: { id: trackId },
        });

        if (!track || !track.filePath) {
            return sendSubsonicError(
                res,
                SubsonicErrorCode.NOT_FOUND,
                "Song not found",
                format,
                req.query.callback as string
            );
        }

        const absolutePath = await resolveTrackPath(track.filePath, track.fileStorage);

        if (!absolutePath) {
            return sendSubsonicError(
                res,
                SubsonicErrorCode.NOT_FOUND,
                "File not found",
                format,
                req.query.callback as string
            );
        }

        const ext = path.extname(track.filePath);
        const filename = `${track.title}${ext}`;

        res.download(absolutePath, filename);
    } catch (error) {
        console.error("[Subsonic] download error:", error);
        sendSubsonicError(
            res,
            SubsonicErrorCode.GENERIC,
            "Failed to download",
            format,
            req.query.callback as string
        );
    }
});

/**
 * getCoverArt.view - Get cover art image
 */
router.get("/getCoverArt.view", async (req: Request, res: Response) => {
    const format = getResponseFormat(req.query);
    const { id, size } = req.query;

    if (!id) {
        return sendSubsonicError(
            res,
            SubsonicErrorCode.MISSING_PARAMETER,
            "Required parameter 'id' is missing",
            format,
            req.query.callback as string
        );
    }

    try {
        const { type, id: entityId } = parseSubsonicId(id as string);

        // Cover cache directory
        const coverCacheDir = path.join(config.music.transcodeCachePath, "../covers");

        // Ensure covers directory exists
        if (!fs.existsSync(coverCacheDir)) {
            fs.mkdirSync(coverCacheDir, { recursive: true });
        }

        // Handle playlist cover art (2x2 mosaic of album covers)
        if (type === "playlist") {
            const playlistCachePath = path.join(coverCacheDir, `playlist-${entityId}.jpg`);

            // Check if cached mosaic exists and is recent (24h)
            if (fs.existsSync(playlistCachePath)) {
                const stats = fs.statSync(playlistCachePath);
                const ageMs = Date.now() - stats.mtimeMs;
                if (ageMs < 24 * 60 * 60 * 1000) {
                    res.set('Content-Type', 'image/jpeg');
                    res.set('Cache-Control', 'public, max-age=86400');
                    return fs.createReadStream(playlistCachePath).pipe(res);
                }
            }

            // Get first 4 unique album covers from playlist
            const playlist = await prisma.playlist.findUnique({
                where: { id: entityId },
                include: {
                    items: {
                        orderBy: { sort: "asc" },
                        take: 20, // Get more to find unique covers
                        include: {
                            track: {
                                include: {
                                    album: { select: { coverUrl: true } },
                                },
                            },
                        },
                    },
                },
            });

            if (!playlist) {
                return sendSubsonicError(
                    res,
                    SubsonicErrorCode.NOT_FOUND,
                    "Playlist not found",
                    format,
                    req.query.callback as string
                );
            }

            // Get unique cover URLs
            const coverUrls: string[] = [];
            const seenUrls = new Set<string>();
            for (const item of playlist.items) {
                const coverUrl = item.track?.album?.coverUrl;
                if (coverUrl && !seenUrls.has(coverUrl)) {
                    seenUrls.add(coverUrl);
                    coverUrls.push(coverUrl);
                    if (coverUrls.length >= 4) break;
                }
            }

            if (coverUrls.length === 0) {
                return sendSubsonicError(
                    res,
                    SubsonicErrorCode.NOT_FOUND,
                    "No cover art available for playlist",
                    format,
                    req.query.callback as string
                );
            }

            try {
                // Fetch cover images
                const imageBuffers: Buffer[] = [];
                for (const url of coverUrls) {
                    try {
                        let buffer: Buffer;
                        if (url.startsWith("native:")) {
                            // Local file
                            const nativePath = url.replace("native:", "");
                            const filePath = path.join(coverCacheDir, nativePath);
                            if (fs.existsSync(filePath)) {
                                buffer = fs.readFileSync(filePath);
                            } else {
                                continue;
                            }
                        } else {
                            // Remote URL
                            const response = await axios.get(url, {
                                responseType: 'arraybuffer',
                                timeout: 5000,
                            });
                            buffer = Buffer.from(response.data);
                        }
                        imageBuffers.push(buffer);
                    } catch (err) {
                        // Skip failed images
                        console.warn(`[Subsonic] Failed to fetch cover: ${url}`);
                    }
                }

                if (imageBuffers.length === 0) {
                    return sendSubsonicError(
                        res,
                        SubsonicErrorCode.NOT_FOUND,
                        "Failed to fetch cover images",
                        format,
                        req.query.callback as string
                    );
                }

                // Generate mosaic
                const tileSize = 300;
                const outputSize = 600;

                // Resize all images to tile size
                const resizedImages = await Promise.all(
                    imageBuffers.map(buf =>
                        sharp(buf)
                            .resize(tileSize, tileSize, { fit: 'cover' })
                            .toBuffer()
                    )
                );

                // Create 2x2 mosaic (or smaller if fewer images)
                let mosaic: Buffer;
                if (resizedImages.length === 1) {
                    // Single image - just resize
                    mosaic = await sharp(resizedImages[0])
                        .resize(outputSize, outputSize)
                        .jpeg({ quality: 85 })
                        .toBuffer();
                } else if (resizedImages.length === 2) {
                    // 2 images - side by side
                    mosaic = await sharp({
                        create: {
                            width: outputSize,
                            height: outputSize,
                            channels: 3,
                            background: { r: 30, g: 30, b: 30 },
                        },
                    })
                        .composite([
                            { input: resizedImages[0], left: 0, top: 0 },
                            { input: resizedImages[1], left: tileSize, top: 0 },
                        ])
                        .jpeg({ quality: 85 })
                        .toBuffer();
                } else if (resizedImages.length === 3) {
                    // 3 images - 2 on top, 1 centered bottom
                    const halfTile = Math.floor(tileSize / 2);
                    mosaic = await sharp({
                        create: {
                            width: outputSize,
                            height: outputSize,
                            channels: 3,
                            background: { r: 30, g: 30, b: 30 },
                        },
                    })
                        .composite([
                            { input: resizedImages[0], left: 0, top: 0 },
                            { input: resizedImages[1], left: tileSize, top: 0 },
                            { input: resizedImages[2], left: halfTile, top: tileSize },
                        ])
                        .jpeg({ quality: 85 })
                        .toBuffer();
                } else {
                    // 4+ images - 2x2 grid
                    mosaic = await sharp({
                        create: {
                            width: outputSize,
                            height: outputSize,
                            channels: 3,
                            background: { r: 30, g: 30, b: 30 },
                        },
                    })
                        .composite([
                            { input: resizedImages[0], left: 0, top: 0 },
                            { input: resizedImages[1], left: tileSize, top: 0 },
                            { input: resizedImages[2], left: 0, top: tileSize },
                            { input: resizedImages[3], left: tileSize, top: tileSize },
                        ])
                        .jpeg({ quality: 85 })
                        .toBuffer();
                }

                // Cache the mosaic
                fs.writeFileSync(playlistCachePath, mosaic);

                res.set('Content-Type', 'image/jpeg');
                res.set('Cache-Control', 'public, max-age=86400');
                return res.send(mosaic);
            } catch (err) {
                console.error('[Subsonic] Failed to generate playlist mosaic:', err);
                return sendSubsonicError(
                    res,
                    SubsonicErrorCode.GENERIC,
                    "Failed to generate playlist cover",
                    format,
                    req.query.callback as string
                );
            }
        }

        let imageUrl: string | null = null;

        if (type === "album") {
            const album = await prisma.album.findUnique({
                where: { id: entityId },
                select: { coverUrl: true },
            });
            imageUrl = album?.coverUrl || null;
        } else if (type === "artist") {
            const artist = await prisma.artist.findUnique({
                where: { id: entityId },
                select: { heroUrl: true },
            });
            imageUrl = artist?.heroUrl || null;
        } else {
            // Try album first, then artist
            const album = await prisma.album.findUnique({
                where: { id: entityId },
                select: { coverUrl: true },
            });
            if (album?.coverUrl) {
                imageUrl = album.coverUrl;
            } else {
                const artist = await prisma.artist.findUnique({
                    where: { id: entityId },
                    select: { heroUrl: true },
                });
                imageUrl = artist?.heroUrl || null;
            }
        }

        if (!imageUrl) {
            return sendSubsonicError(
                res,
                SubsonicErrorCode.NOT_FOUND,
                "Cover art not found",
                format,
                req.query.callback as string
            );
        }

        // coverCacheDir already defined above for playlist handling
        // Ensure covers directory exists
        if (!fs.existsSync(coverCacheDir)) {
            fs.mkdirSync(coverCacheDir, { recursive: true });
        }

        // Handle native (local) cover files
        if (imageUrl.startsWith("native:")) {
            const nativePath = imageUrl.replace("native:", "");
            const coverCachePath = path.join(coverCacheDir, nativePath);

            // SECURITY: Prevent path traversal attacks
            const resolvedPath = path.resolve(coverCachePath);
            const resolvedCacheDir = path.resolve(coverCacheDir);
            if (!resolvedPath.startsWith(resolvedCacheDir + path.sep)) {
                console.warn(`[Subsonic] Path traversal attempt blocked: ${nativePath}`);
                return sendSubsonicError(
                    res,
                    SubsonicErrorCode.NOT_FOUND,
                    "Invalid cover art path",
                    format,
                    req.query.callback as string
                );
            }

            if (fs.existsSync(coverCachePath)) {
                const ext = path.extname(nativePath).toLowerCase();
                const contentType = ext === '.png' ? 'image/png' :
                                   ext === '.webp' ? 'image/webp' : 'image/jpeg';
                res.set('Content-Type', contentType);
                res.set('Cache-Control', 'public, max-age=86400');
                return fs.createReadStream(coverCachePath).pipe(res);
            } else {
                return sendSubsonicError(
                    res,
                    SubsonicErrorCode.NOT_FOUND,
                    "Cover art file not found",
                    format,
                    req.query.callback as string
                );
            }
        }

        // For external URLs, check if we have a cached version
        const cacheFileName = `ext-${entityId}.jpg`;
        const cachedFilePath = path.join(coverCacheDir, cacheFileName);

        // Serve from cache if exists and is less than 7 days old
        if (fs.existsSync(cachedFilePath)) {
            const stats = fs.statSync(cachedFilePath);
            const ageMs = Date.now() - stats.mtimeMs;
            const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;

            if (ageMs < sevenDaysMs) {
                res.set('Content-Type', 'image/jpeg');
                res.set('Cache-Control', 'public, max-age=86400');
                return fs.createReadStream(cachedFilePath).pipe(res);
            }
        }

        // Download, cache, and serve external URL
        try {
            // SECURITY: Block internal/private URLs to prevent SSRF
            try {
                const parsedUrl = new URL(imageUrl);
                const hostname = parsedUrl.hostname.toLowerCase();

                // Block private/internal addresses
                if (
                    hostname === 'localhost' ||
                    hostname === '127.0.0.1' ||
                    hostname === '::1' ||
                    hostname === '0.0.0.0' ||
                    hostname.startsWith('10.') ||
                    hostname.startsWith('192.168.') ||
                    hostname.match(/^172\.(1[6-9]|2[0-9]|3[0-1])\./) ||
                    hostname.endsWith('.local') ||
                    hostname.endsWith('.internal') ||
                    parsedUrl.protocol === 'file:'
                ) {
                    console.warn(`[Subsonic] SSRF attempt blocked: ${imageUrl}`);
                    return sendSubsonicError(
                        res,
                        SubsonicErrorCode.NOT_FOUND,
                        "Invalid cover art URL",
                        format,
                        req.query.callback as string
                    );
                }
            } catch (urlError) {
                // Invalid URL format
                return sendSubsonicError(
                    res,
                    SubsonicErrorCode.NOT_FOUND,
                    "Invalid cover art URL",
                    format,
                    req.query.callback as string
                );
            }

            const imageResponse = await axios.get(imageUrl, {
                responseType: 'arraybuffer',
                timeout: 10000,
                headers: {
                    'User-Agent': 'Lidify/1.0',
                },
            });

            // Save to cache
            fs.writeFileSync(cachedFilePath, imageResponse.data);

            // Serve the image
            const contentType = imageResponse.headers['content-type'] || 'image/jpeg';
            res.set('Content-Type', contentType);
            res.set('Cache-Control', 'public, max-age=86400');
            res.send(imageResponse.data);
        } catch (proxyError: any) {
            console.error(`[Subsonic] Failed to fetch cover art from ${imageUrl}:`, proxyError.message);
            // Fall back to redirect if fetch fails
            res.redirect(imageUrl);
        }
    } catch (error) {
        console.error("[Subsonic] getCoverArt error:", error);
        sendSubsonicError(
            res,
            SubsonicErrorCode.GENERIC,
            "Failed to get cover art",
            format,
            req.query.callback as string
        );
    }
});

// ============================================================================
// PLAYLIST ENDPOINTS
// ============================================================================

/**
 * getPlaylists.view - Get all playlists
 */
router.get("/getPlaylists.view", async (req: Request, res: Response) => {
    const format = getResponseFormat(req.query);

    try {
        const playlists = await prisma.playlist.findMany({
            where: { userId: req.user!.id },
            include: {
                _count: { select: { items: true } },
                items: {
                    include: {
                        track: { select: { duration: true } },
                    },
                },
            },
            orderBy: { createdAt: "desc" },
        });

        const playlistList = playlists.map((pl) => {
            const duration = pl.items.reduce((sum, item) => sum + (item.track?.duration || 0), 0);
            return {
                id: `pl-${pl.id}`,
                name: pl.name,
                songCount: pl._count.items,
                duration,
                public: false,
                owner: req.user!.username,
                created: pl.createdAt.toISOString(),
                changed: pl.updatedAt.toISOString(),
                coverArt: pl._count.items > 0 ? `pl-${pl.id}` : undefined, // Mosaic generated on demand
            };
        });

        console.log(`[Subsonic] getPlaylists.view: ${playlistList.map(p => `"${p.name}"(${p.songCount})`).join(', ')}`);

        sendSubsonicSuccess(
            res,
            { playlists: { playlist: playlistList } },
            format,
            req.query.callback as string
        );
    } catch (error) {
        console.error("[Subsonic] getPlaylists error:", error);
        sendSubsonicError(
            res,
            SubsonicErrorCode.GENERIC,
            "Failed to fetch playlists",
            format,
            req.query.callback as string
        );
    }
});

/**
 * getPlaylist.view - Get playlist with tracks
 */
router.get("/getPlaylist.view", async (req: Request, res: Response) => {
    const format = getResponseFormat(req.query);
    const { id } = req.query;

    if (!id) {
        return sendSubsonicError(
            res,
            SubsonicErrorCode.MISSING_PARAMETER,
            "Required parameter 'id' is missing",
            format,
            req.query.callback as string
        );
    }

    try {
        const { id: playlistId } = parseSubsonicId(id as string);

        const playlist = await prisma.playlist.findUnique({
            where: { id: playlistId },
            include: {
                items: {
                    orderBy: { sort: "asc" },
                    include: {
                        track: {
                            include: {
                                album: {
                                    include: {
                                        artist: { select: { id: true, name: true } },
                                    },
                                },
                            },
                        },
                    },
                },
            },
        });

        if (!playlist || playlist.userId !== req.user!.id) {
            return sendSubsonicError(
                res,
                SubsonicErrorCode.NOT_FOUND,
                "Playlist not found",
                format,
                req.query.callback as string
            );
        }

        // Get play data for all tracks in playlist
        const trackIds = playlist.items.filter(item => item.track?.album).map(item => item.track.id);
        const trackPlayData = trackIds.length > 0 ? await prisma.$queryRaw<Array<{ trackId: string; lastPlayed: Date; playCount: bigint }>>`
            SELECT p."trackId", MAX(p."playedAt") as "lastPlayed", COUNT(p.id) as "playCount"
            FROM "Play" p
            WHERE p."trackId" = ANY(${trackIds})
            GROUP BY p."trackId"
        ` : [];
        const trackLastPlayed = new Map(trackPlayData.map(d => [d.trackId, d.lastPlayed]));
        const trackPlayCount = new Map(trackPlayData.map(d => [d.trackId, Number(d.playCount)]));

        const songs = playlist.items
            .filter((item) => item.track && item.track.album)
            .map((item) =>
                formatTrackForSubsonic({
                    ...item.track,
                    album: {
                        id: item.track.album!.id,
                        title: item.track.album!.title,
                        coverUrl: item.track.album!.coverUrl,
                        year: item.track.album!.year,
                        createdAt: item.track.album!.createdAt,
                        location: item.track.album!.location,
                        artist: item.track.album!.artist,
                    },
                }, {
                    played: trackLastPlayed.get(item.track.id),
                    playCount: trackPlayCount.get(item.track.id) || 0,
                })
            );

        const totalDuration = playlist.items.reduce(
            (sum, item) => sum + (item.track?.duration || 0),
            0
        );

        console.log(`[Subsonic] getPlaylist.view: "${playlist.name}" — items=${playlist.items.length}, filtered=${songs.length}, format=${format}, changed=${playlist.updatedAt.toISOString()}`);
        if (songs.length > 0) {
            const sample = songs[0] as any;
            console.log(`[Subsonic] getPlaylist.view sample entry: id=${sample.id} title="${sample.title}" artist="${sample.artist}" album="${sample.album}" path="${sample.path}" suffix=${sample.suffix} size=${sample.size}`);
        }
        // Log entries with potential issues (missing fields)
        const problematic = (songs as any[]).filter(s => !s.id || !s.title || !s.artist || !s.suffix || !s.size || s.size === 0);
        if (problematic.length > 0) {
            console.log(`[Subsonic] getPlaylist.view WARNING: ${problematic.length} entries with missing/zero fields`);
            console.log(`[Subsonic] First problematic: ${JSON.stringify(problematic[0])}`);
        }

        sendSubsonicSuccess(
            res,
            {
                playlist: {
                    id: `pl-${playlist.id}`,
                    name: playlist.name,
                    songCount: songs.length,
                    duration: totalDuration,
                    public: false,
                    owner: req.user!.username,
                    created: playlist.createdAt.toISOString(),
                    changed: playlist.updatedAt.toISOString(),
                    coverArt: songs.length > 0 ? `pl-${playlist.id}` : undefined,
                    entry: songs,
                },
            },
            format,
            req.query.callback as string
        );
    } catch (error) {
        console.error("[Subsonic] getPlaylist error:", error);
        sendSubsonicError(
            res,
            SubsonicErrorCode.GENERIC,
            "Failed to fetch playlist",
            format,
            req.query.callback as string
        );
    }
});

/**
 * createPlaylist.view - Create or update playlist
 */
router.get("/createPlaylist.view", async (req: Request, res: Response) => {
    const format = getResponseFormat(req.query);
    const { playlistId, name } = req.query;
    let songId = req.query.songId;

    // songId can be a single value or array
    if (songId && !Array.isArray(songId)) {
        songId = [songId];
    }

    try {
        if (playlistId) {
            // Update existing playlist
            const { id: plId } = parseSubsonicId(playlistId as string);

            // Verify ownership
            const existingPlaylist = await prisma.playlist.findUnique({
                where: { id: plId },
                select: { userId: true, _count: { select: { pendingTracks: true, items: true } } },
            });

            if (!existingPlaylist || existingPlaylist.userId !== req.user!.id) {
                return sendSubsonicError(
                    res,
                    SubsonicErrorCode.NOT_AUTHORIZED,
                    "Not authorized to modify this playlist",
                    format,
                    req.query.callback as string
                );
            }

            if (name) {
                await prisma.playlist.update({
                    where: { id: plId },
                    data: { name: name as string },
                });
            }

            if (songId && Array.isArray(songId)) {
                // Guard: don't let a client with stale data wipe a server-managed playlist.
                // If the playlist has pending tracks (import in progress) or the client is
                // sending fewer tracks than the server knows about, skip the destructive replace.
                const hasPending = existingPlaylist._count.pendingTracks > 0;
                const clientHasFewer = (songId as string[]).length < existingPlaylist._count.items;

                if (hasPending || clientHasFewer) {
                    console.log(
                        `[Subsonic] createPlaylist: skipping track replacement for playlist ${plId} ` +
                        `(pending=${existingPlaylist._count.pendingTracks}, server=${existingPlaylist._count.items}, client=${(songId as string[]).length})`
                    );
                } else {
                    // Safe to replace — client has at least as many tracks as server
                    await prisma.playlistItem.deleteMany({
                        where: { playlistId: plId },
                    });

                    const trackIds = (songId as string[]).map((id) => parseSubsonicId(id).id);

                    await prisma.playlistItem.createMany({
                        data: trackIds.map((trackId, index) => ({
                            playlistId: plId,
                            trackId,
                            sort: index,
                        })),
                    });
                }
            }

            // Touch playlist so Subsonic clients detect the change
            await prisma.playlist.update({ where: { id: plId }, data: { updatedAt: new Date() } });

            sendSubsonicSuccess(res, {}, format, req.query.callback as string);
        } else if (name) {
            // Create new playlist
            const playlist = await prisma.playlist.create({
                data: {
                    userId: req.user!.id,
                    name: name as string,
                },
            });

            if (songId && Array.isArray(songId)) {
                const trackIds = (songId as string[]).map((id) => parseSubsonicId(id).id);

                await prisma.playlistItem.createMany({
                    data: trackIds.map((trackId, index) => ({
                        playlistId: playlist.id,
                        trackId,
                        sort: index,
                    })),
                });

                // Touch playlist so Subsonic clients detect the change
                await prisma.playlist.update({ where: { id: playlist.id }, data: { updatedAt: new Date() } });
            }

            sendSubsonicSuccess(res, {}, format, req.query.callback as string);
        } else {
            sendSubsonicError(
                res,
                SubsonicErrorCode.MISSING_PARAMETER,
                "Required parameter 'name' or 'playlistId' is missing",
                format,
                req.query.callback as string
            );
        }
    } catch (error) {
        console.error("[Subsonic] createPlaylist error:", error);
        sendSubsonicError(
            res,
            SubsonicErrorCode.GENERIC,
            "Failed to create/update playlist",
            format,
            req.query.callback as string
        );
    }
});

/**
 * updatePlaylist.view - Update playlist (add/remove songs)
 */
router.get("/updatePlaylist.view", async (req: Request, res: Response) => {
    const format = getResponseFormat(req.query);
    const { playlistId, name, songIdToAdd, songIndexToRemove } = req.query;

    if (!playlistId) {
        return sendSubsonicError(
            res,
            SubsonicErrorCode.MISSING_PARAMETER,
            "Required parameter 'playlistId' is missing",
            format,
            req.query.callback as string
        );
    }

    try {
        const { id: plId } = parseSubsonicId(playlistId as string);

        // Verify ownership
        const playlist = await prisma.playlist.findUnique({
            where: { id: plId },
            select: { userId: true },
        });

        if (!playlist || playlist.userId !== req.user!.id) {
            return sendSubsonicError(
                res,
                SubsonicErrorCode.NOT_AUTHORIZED,
                "Not authorized to modify this playlist",
                format,
                req.query.callback as string
            );
        }

        // Update name if provided
        if (name) {
            await prisma.playlist.update({
                where: { id: plId },
                data: { name: name as string },
            });
        }

        // Add songs
        if (songIdToAdd) {
            const toAdd = Array.isArray(songIdToAdd) ? songIdToAdd : [songIdToAdd];
            const currentMax = await prisma.playlistItem.aggregate({
                where: { playlistId: plId },
                _max: { sort: true },
            });
            const startSort = (currentMax._max.sort ?? -1) + 1;

            const trackIds = toAdd.map((id) => parseSubsonicId(id as string).id);

            await prisma.playlistItem.createMany({
                data: trackIds.map((trackId, index) => ({
                    playlistId: plId,
                    trackId,
                    sort: startSort + index,
                })),
            });
        }

        // Remove songs by index
        if (songIndexToRemove) {
            const toRemove = Array.isArray(songIndexToRemove)
                ? songIndexToRemove.map((i) => parseInt(i as string, 10))
                : [parseInt(songIndexToRemove as string, 10)];

            const items = await prisma.playlistItem.findMany({
                where: { playlistId: plId },
                orderBy: { sort: "asc" },
            });

            const idsToDelete = toRemove
                .filter((i) => i >= 0 && i < items.length)
                .map((i) => items[i].id);

            if (idsToDelete.length > 0) {
                await prisma.playlistItem.deleteMany({
                    where: { id: { in: idsToDelete } },
                });
            }
        }

        // Touch playlist so Subsonic clients detect the change
        if (songIdToAdd || songIndexToRemove || name) {
            await prisma.playlist.update({ where: { id: plId }, data: { updatedAt: new Date() } });
        }

        sendSubsonicSuccess(res, {}, format, req.query.callback as string);
    } catch (error) {
        console.error("[Subsonic] updatePlaylist error:", error);
        sendSubsonicError(
            res,
            SubsonicErrorCode.GENERIC,
            "Failed to update playlist",
            format,
            req.query.callback as string
        );
    }
});

/**
 * deletePlaylist.view - Delete a playlist
 */
router.get("/deletePlaylist.view", async (req: Request, res: Response) => {
    const format = getResponseFormat(req.query);
    const { id } = req.query;

    if (!id) {
        return sendSubsonicError(
            res,
            SubsonicErrorCode.MISSING_PARAMETER,
            "Required parameter 'id' is missing",
            format,
            req.query.callback as string
        );
    }

    try {
        const { id: playlistId } = parseSubsonicId(id as string);

        // Verify ownership
        const playlist = await prisma.playlist.findUnique({
            where: { id: playlistId },
        });

        if (!playlist || playlist.userId !== req.user!.id) {
            return sendSubsonicError(
                res,
                SubsonicErrorCode.NOT_AUTHORIZED,
                "Not authorized to delete this playlist",
                format,
                req.query.callback as string
            );
        }

        // Delete items first (cascade should handle this, but being explicit)
        await prisma.playlistItem.deleteMany({
            where: { playlistId },
        });

        await prisma.playlist.delete({
            where: { id: playlistId },
        });

        sendSubsonicSuccess(res, {}, format, req.query.callback as string);
    } catch (error) {
        console.error("[Subsonic] deletePlaylist error:", error);
        sendSubsonicError(
            res,
            SubsonicErrorCode.GENERIC,
            "Failed to delete playlist",
            format,
            req.query.callback as string
        );
    }
});

// ============================================================================
// SCROBBLING / NOW PLAYING
// ============================================================================

/**
 * scrobble.view - Submit a song as played
 */
router.get("/scrobble.view", async (req: Request, res: Response) => {
    const format = getResponseFormat(req.query);
    const { id, submission } = req.query;

    if (!id) {
        return sendSubsonicError(
            res,
            SubsonicErrorCode.MISSING_PARAMETER,
            "Required parameter 'id' is missing",
            format,
            req.query.callback as string
        );
    }

    try {
        const { id: trackId } = parseSubsonicId(id as string);

        console.log(`[Subsonic] scrobble: id=${id}, trackId=${trackId}, submission=${submission}`);

        // Only log actual submissions, not "now playing" updates
        if (submission !== "false") {
            await prisma.play.create({
                data: {
                    userId: req.user!.id,
                    trackId,
                },
            });
            console.log(`[Subsonic] scrobble: created play record for track ${trackId}`);
        }

        sendSubsonicSuccess(res, {}, format, req.query.callback as string);
    } catch (error) {
        console.error("[Subsonic] scrobble error:", error);
        sendSubsonicError(
            res,
            SubsonicErrorCode.GENERIC,
            "Failed to scrobble",
            format,
            req.query.callback as string
        );
    }
});

/**
 * getNowPlaying.view - Get currently playing songs
 */
router.get("/getNowPlaying.view", (req: Request, res: Response) => {
    const format = getResponseFormat(req.query);
    // We don't track real-time now playing state
    sendSubsonicSuccess(res, { nowPlaying: {} }, format, req.query.callback as string);
});

// ============================================================================
// USER ENDPOINTS
// ============================================================================

/**
 * getUser.view - Get user info
 */
router.get("/getUser.view", async (req: Request, res: Response) => {
    const format = getResponseFormat(req.query);
    const { username } = req.query;

    // Can only get own user info
    if (username && username !== req.user!.username) {
        return sendSubsonicError(
            res,
            SubsonicErrorCode.NOT_AUTHORIZED,
            "Not authorized to view other users",
            format,
            req.query.callback as string
        );
    }

    sendSubsonicSuccess(
        res,
        {
            user: {
                username: req.user!.username,
                email: `${req.user!.username}@lidify.local`,
                scrobblingEnabled: true,
                adminRole: req.user!.role === "admin",
                settingsRole: true,
                downloadRole: true,
                uploadRole: false,
                playlistRole: true,
                coverArtRole: true,
                commentRole: false,
                podcastRole: false,
                streamRole: true,
                jukeboxRole: false,
                shareRole: false,
            },
        },
        format,
        req.query.callback as string
    );
});

// ============================================================================
// STUB ENDPOINTS (required for client compatibility)
// ============================================================================

// These endpoints exist for compatibility but don't have full implementations

router.get("/getStarred.view", async (req: Request, res: Response) => {
    const format = getResponseFormat(req.query);

    try {
        const likedTracks = await prisma.likedTrack.findMany({
            where: { userId: req.user!.id },
            include: {
                track: {
                    include: {
                        album: {
                            include: {
                                artist: { select: { id: true, name: true } },
                            },
                        },
                    },
                },
            },
            orderBy: { likedAt: "desc" },
        });

        const songs = likedTracks.map((liked) => ({
            ...formatTrackForSubsonic(liked.track),
            starred: liked.likedAt.toISOString(),
        }));

        sendSubsonicSuccess(
            res,
            {
                starred: songs.length > 0 ? { song: songs } : {},
            },
            format,
            req.query.callback as string
        );
    } catch (error) {
        console.error("[Subsonic] getStarred error:", error);
        sendSubsonicError(
            res,
            SubsonicErrorCode.GENERIC,
            "Failed to fetch starred tracks",
            format,
            req.query.callback as string
        );
    }
});

router.get("/getStarred2.view", async (req: Request, res: Response) => {
    const format = getResponseFormat(req.query);

    try {
        const likedTracks = await prisma.likedTrack.findMany({
            where: { userId: req.user!.id },
            include: {
                track: {
                    include: {
                        album: {
                            include: {
                                artist: { select: { id: true, name: true } },
                            },
                        },
                    },
                },
            },
            orderBy: { likedAt: "desc" },
        });

        const songs = likedTracks.map((liked) => ({
            ...formatTrackForSubsonic(liked.track),
            starred: liked.likedAt.toISOString(),
        }));

        sendSubsonicSuccess(
            res,
            {
                starred2: songs.length > 0 ? { song: songs } : {},
            },
            format,
            req.query.callback as string
        );
    } catch (error) {
        console.error("[Subsonic] getStarred2 error:", error);
        sendSubsonicError(
            res,
            SubsonicErrorCode.GENERIC,
            "Failed to fetch starred tracks",
            format,
            req.query.callback as string
        );
    }
});

router.get("/star.view", async (req: Request, res: Response) => {
    const format = getResponseFormat(req.query);

    try {
        const trackIds = new Set(normalizeTrackIds(parseRepeatedQueryParam(req.query.id)));
        const albumIds = parseRepeatedQueryParam(req.query.albumId).map((id) => parseSubsonicId(id).id);
        const artistIds = parseRepeatedQueryParam(req.query.artistId).map((id) => parseSubsonicId(id).id);

        if (albumIds.length > 0 || artistIds.length > 0) {
            const scopedTracks = await prisma.track.findMany({
                where: {
                    OR: [
                        ...(albumIds.length > 0 ? [{ albumId: { in: albumIds } }] : []),
                        ...(artistIds.length > 0 ? [{ album: { artistId: { in: artistIds } } }] : []),
                    ],
                },
                select: { id: true },
            });

            for (const track of scopedTracks) {
                trackIds.add(track.id);
            }
        }

        for (const trackId of trackIds) {
            await prisma.likedTrack.upsert({
                where: { userId_trackId: { userId: req.user!.id, trackId } },
                create: { userId: req.user!.id, trackId },
                update: {},
            }).catch(() => {});
        }

        sendSubsonicSuccess(res, {}, format, req.query.callback as string);
    } catch (error) {
        console.error("[Subsonic] star error:", error);
        sendSubsonicError(
            res,
            SubsonicErrorCode.GENERIC,
            "Failed to star media",
            format,
            req.query.callback as string
        );
    }
});

router.get("/unstar.view", async (req: Request, res: Response) => {
    const format = getResponseFormat(req.query);

    try {
        const trackIds = new Set(normalizeTrackIds(parseRepeatedQueryParam(req.query.id)));
        const albumIds = parseRepeatedQueryParam(req.query.albumId).map((id) => parseSubsonicId(id).id);
        const artistIds = parseRepeatedQueryParam(req.query.artistId).map((id) => parseSubsonicId(id).id);

        if (albumIds.length > 0 || artistIds.length > 0) {
            const scopedTracks = await prisma.track.findMany({
                where: {
                    OR: [
                        ...(albumIds.length > 0 ? [{ albumId: { in: albumIds } }] : []),
                        ...(artistIds.length > 0 ? [{ album: { artistId: { in: artistIds } } }] : []),
                    ],
                },
                select: { id: true },
            });

            for (const track of scopedTracks) {
                trackIds.add(track.id);
            }
        }

        if (trackIds.size > 0) {
            await prisma.likedTrack.deleteMany({
                where: {
                    userId: req.user!.id,
                    trackId: { in: [...trackIds] },
                },
            });
        }

        sendSubsonicSuccess(res, {}, format, req.query.callback as string);
    } catch (error) {
        console.error("[Subsonic] unstar error:", error);
        sendSubsonicError(
            res,
            SubsonicErrorCode.GENERIC,
            "Failed to unstar media",
            format,
            req.query.callback as string
        );
    }
});

router.get("/setRating.view", async (req: Request, res: Response) => {
    const format = getResponseFormat(req.query);
    const { id, rating } = req.query;

    if (!id) {
        return sendSubsonicError(
            res,
            SubsonicErrorCode.MISSING_PARAMETER,
            "Required parameter 'id' is missing",
            format,
            req.query.callback as string
        );
    }

    if (rating === undefined) {
        return sendSubsonicError(
            res,
            SubsonicErrorCode.MISSING_PARAMETER,
            "Required parameter 'rating' is missing",
            format,
            req.query.callback as string
        );
    }

    try {
        const parsedRating = parseInt(rating as string, 10);
        const trackId = parseSubsonicId(id as string).id;

        if (!Number.isInteger(parsedRating) || parsedRating < 0 || parsedRating > 5) {
            return sendSubsonicError(
                res,
                SubsonicErrorCode.GENERIC,
                "rating must be an integer between 0 and 5",
                format,
                req.query.callback as string
            );
        }

        if (parsedRating === 0) {
            await prisma.likedTrack.deleteMany({
                where: { userId: req.user!.id, trackId },
            });
        } else {
            await prisma.likedTrack.upsert({
                where: { userId_trackId: { userId: req.user!.id, trackId } },
                create: { userId: req.user!.id, trackId },
                update: {},
            }).catch(() => {});
        }

        sendSubsonicSuccess(res, {}, format, req.query.callback as string);
    } catch (error) {
        console.error("[Subsonic] setRating error:", error);
        sendSubsonicError(
            res,
            SubsonicErrorCode.GENERIC,
            "Failed to set rating",
            format,
            req.query.callback as string
        );
    }
});

router.get("/getGenres.view", (req: Request, res: Response) => {
    const format = getResponseFormat(req.query);
    sendSubsonicSuccess(res, { genres: { genre: [] } }, format, req.query.callback as string);
});

/**
 * getAlbumInfo2.view - Get album notes/info (required by Symfonium for sync)
 */
router.get("/getAlbumInfo2.view", async (req: Request, res: Response) => {
    const format = getResponseFormat(req.query);
    const { id } = req.query;

    if (!id) {
        return sendSubsonicError(
            res,
            SubsonicErrorCode.MISSING_PARAMETER,
            "Required parameter 'id' is missing",
            format,
            req.query.callback as string
        );
    }

    try {
        const { id: albumId } = parseSubsonicId(id as string);

        const album = await prisma.album.findUnique({
            where: { id: albumId },
            select: {
                id: true,
                title: true,
                rgMbid: true,
                coverUrl: true,
            },
        });

        if (!album) {
            return sendSubsonicError(
                res,
                SubsonicErrorCode.NOT_FOUND,
                "Album not found",
                format,
                req.query.callback as string
            );
        }

        // Return album info - notes are optional, musicBrainzId helps with identification
        sendSubsonicSuccess(
            res,
            {
                albumInfo: {
                    notes: "",
                    musicBrainzId: album.rgMbid && !album.rgMbid.startsWith("temp-") ? album.rgMbid : undefined,
                    smallImageUrl: album.coverUrl || undefined,
                    mediumImageUrl: album.coverUrl || undefined,
                    largeImageUrl: album.coverUrl || undefined,
                },
            },
            format,
            req.query.callback as string
        );
    } catch (error) {
        console.error("[Subsonic] getAlbumInfo2 error:", error);
        sendSubsonicError(
            res,
            SubsonicErrorCode.GENERIC,
            "Failed to fetch album info",
            format,
            req.query.callback as string
        );
    }
});

/**
 * getArtistInfo2.view - Get artist bio/info (required by Symfonium for sync)
 */
router.get("/getArtistInfo2.view", async (req: Request, res: Response) => {
    const format = getResponseFormat(req.query);
    const { id } = req.query;

    if (!id) {
        return sendSubsonicError(
            res,
            SubsonicErrorCode.MISSING_PARAMETER,
            "Required parameter 'id' is missing",
            format,
            req.query.callback as string
        );
    }

    try {
        const { id: artistId } = parseSubsonicId(id as string);

        const artist = await prisma.artist.findUnique({
            where: { id: artistId },
            select: {
                id: true,
                name: true,
                mbid: true,
                heroUrl: true,
                summary: true,
            },
        });

        if (!artist) {
            return sendSubsonicError(
                res,
                SubsonicErrorCode.NOT_FOUND,
                "Artist not found",
                format,
                req.query.callback as string
            );
        }

        sendSubsonicSuccess(
            res,
            {
                artistInfo2: {
                    biography: artist.summary || "",
                    musicBrainzId: artist.mbid && !artist.mbid.startsWith("temp-") ? artist.mbid : undefined,
                    smallImageUrl: artist.heroUrl || undefined,
                    mediumImageUrl: artist.heroUrl || undefined,
                    largeImageUrl: artist.heroUrl || undefined,
                    similarArtist: [], // Could populate from AI similar artists
                },
            },
            format,
            req.query.callback as string
        );
    } catch (error) {
        console.error("[Subsonic] getArtistInfo2 error:", error);
        sendSubsonicError(
            res,
            SubsonicErrorCode.GENERIC,
            "Failed to fetch artist info",
            format,
            req.query.callback as string
        );
    }
});

router.get("/getBookmarks.view", (req: Request, res: Response) => {
    const format = getResponseFormat(req.query);
    sendSubsonicSuccess(res, { bookmarks: {} }, format, req.query.callback as string);
});

router.get("/getPlayQueue.view", async (req: Request, res: Response) => {
    const format = getResponseFormat(req.query);

    try {
        const state = await prisma.playbackState.findUnique({
            where: { userId: req.user!.id },
        });

        const queueTrackIds = getQueueTrackIds(state?.queue).map((id) => parseSubsonicId(id).id);
        const tracks = queueTrackIds.length > 0
            ? await prisma.track.findMany({
                where: { id: { in: queueTrackIds } },
                include: {
                    album: {
                        include: {
                            artist: { select: { id: true, name: true } },
                        },
                    },
                },
            })
            : [];

        const trackMap = new Map(tracks.map((track) => [track.id, track]));
        const entry = queueTrackIds
            .map((id) => trackMap.get(id))
            .filter((track): track is NonNullable<typeof track> => Boolean(track))
            .map((track) => formatTrackForSubsonic(track));

        const currentTrackId = state?.trackId
            || (queueTrackIds.length > 0 ? queueTrackIds[Math.min(state?.currentIndex ?? 0, queueTrackIds.length - 1)] : undefined);

        sendSubsonicSuccess(
            res,
            {
                playQueue: {
                    current: currentTrackId ? `tr-${currentTrackId}` : undefined,
                    position: 0,
                    username: req.user!.username,
                    changed: state?.updatedAt?.toISOString() || new Date().toISOString(),
                    changedBy: (req.query.c as string | undefined) || "Lidify",
                    entry,
                },
            },
            format,
            req.query.callback as string
        );
    } catch (error) {
        console.error("[Subsonic] getPlayQueue error:", error);
        sendSubsonicError(
            res,
            SubsonicErrorCode.GENERIC,
            "Failed to fetch play queue",
            format,
            req.query.callback as string
        );
    }
});

router.get("/getPlayQueueByIndex.view", async (req: Request, res: Response) => {
    const format = getResponseFormat(req.query);

    try {
        const state = await prisma.playbackState.findUnique({
            where: { userId: req.user!.id },
        });

        const queueTrackIds = getQueueTrackIds(state?.queue).map((id) => parseSubsonicId(id).id);
        const tracks = queueTrackIds.length > 0
            ? await prisma.track.findMany({
                where: { id: { in: queueTrackIds } },
                include: {
                    album: {
                        include: {
                            artist: { select: { id: true, name: true } },
                        },
                    },
                },
            })
            : [];

        const trackMap = new Map(tracks.map((track) => [track.id, track]));
        const entry = queueTrackIds
            .map((id) => trackMap.get(id))
            .filter((track): track is NonNullable<typeof track> => Boolean(track))
            .map((track) => formatTrackForSubsonic(track));

        sendSubsonicSuccess(
            res,
            {
                playQueueByIndex: {
                    currentIndex: queueTrackIds.length > 0
                        ? Math.min(Math.max(state?.currentIndex ?? 0, 0), queueTrackIds.length - 1)
                        : 0,
                    position: 0,
                    username: req.user!.username,
                    changed: state?.updatedAt?.toISOString() || new Date().toISOString(),
                    changedBy: (req.query.c as string | undefined) || "Lidify",
                    entry,
                },
            },
            format,
            req.query.callback as string
        );
    } catch (error) {
        console.error("[Subsonic] getPlayQueueByIndex error:", error);
        sendSubsonicError(
            res,
            SubsonicErrorCode.GENERIC,
            "Failed to fetch play queue",
            format,
            req.query.callback as string
        );
    }
});

router.get("/savePlayQueue.view", async (req: Request, res: Response) => {
    const format = getResponseFormat(req.query);

    try {
        const rawIds = parseRepeatedQueryParam(req.query.id);
        const queueTrackIds = normalizeTrackIds(rawIds);
        const current = req.query.current as string | undefined;
        const currentTrackId = current ? parseSubsonicId(current).id : null;

        if (queueTrackIds.length > 0 && currentTrackId && !queueTrackIds.includes(currentTrackId)) {
            return sendSubsonicError(
                res,
                SubsonicErrorCode.MISSING_PARAMETER,
                "Parameter 'current' must be included in 'id'",
                format,
                req.query.callback as string
            );
        }

        const currentIndex = currentTrackId && queueTrackIds.includes(currentTrackId)
            ? queueTrackIds.indexOf(currentTrackId)
            : 0;

        await prisma.playbackState.upsert({
            where: { userId: req.user!.id },
            update: {
                playbackType: "track",
                trackId: currentTrackId,
                audiobookId: null,
                podcastId: null,
                queue: queueTrackIds,
                currentIndex,
                isShuffle: false,
            },
            create: {
                userId: req.user!.id,
                playbackType: "track",
                trackId: currentTrackId,
                audiobookId: null,
                podcastId: null,
                queue: queueTrackIds,
                currentIndex,
                isShuffle: false,
            },
        });

        sendSubsonicSuccess(res, {}, format, req.query.callback as string);
    } catch (error) {
        console.error("[Subsonic] savePlayQueue error:", error);
        sendSubsonicError(
            res,
            SubsonicErrorCode.GENERIC,
            "Failed to save play queue",
            format,
            req.query.callback as string
        );
    }
});

router.get("/savePlayQueueByIndex.view", async (req: Request, res: Response) => {
    const format = getResponseFormat(req.query);

    try {
        const rawIds = parseRepeatedQueryParam(req.query.id);
        const queueTrackIds = normalizeTrackIds(rawIds);

        if (queueTrackIds.length > 0 && req.query.currentIndex === undefined) {
            return sendSubsonicError(
                res,
                SubsonicErrorCode.MISSING_PARAMETER,
                "Required parameter 'currentIndex' is missing",
                format,
                req.query.callback as string
            );
        }

        if (queueTrackIds.length === 0 && req.query.currentIndex !== undefined) {
            return sendSubsonicError(
                res,
                SubsonicErrorCode.MISSING_PARAMETER,
                "Parameter 'currentIndex' must not be set when 'id' is missing",
                format,
                req.query.callback as string
            );
        }

        const parsedIndex = parseInt((req.query.currentIndex as string | undefined) || "0", 10);
        if (
            queueTrackIds.length > 0 &&
            (!Number.isInteger(parsedIndex) || parsedIndex < 0 || parsedIndex >= queueTrackIds.length)
        ) {
            return sendSubsonicError(
                res,
                SubsonicErrorCode.MISSING_PARAMETER,
                "Parameter 'currentIndex' must be between 0 and queue length - 1",
                format,
                req.query.callback as string
            );
        }

        const currentIndex = Number.isInteger(parsedIndex) && parsedIndex >= 0 && parsedIndex < queueTrackIds.length
            ? parsedIndex
            : 0;
        const currentTrackId = queueTrackIds.length > 0 ? queueTrackIds[currentIndex] : null;

        await prisma.playbackState.upsert({
            where: { userId: req.user!.id },
            update: {
                playbackType: "track",
                trackId: currentTrackId,
                audiobookId: null,
                podcastId: null,
                queue: queueTrackIds,
                currentIndex,
                isShuffle: false,
            },
            create: {
                userId: req.user!.id,
                playbackType: "track",
                trackId: currentTrackId,
                audiobookId: null,
                podcastId: null,
                queue: queueTrackIds,
                currentIndex,
                isShuffle: false,
            },
        });

        sendSubsonicSuccess(res, {}, format, req.query.callback as string);
    } catch (error) {
        console.error("[Subsonic] savePlayQueueByIndex error:", error);
        sendSubsonicError(
            res,
            SubsonicErrorCode.GENERIC,
            "Failed to save play queue",
            format,
            req.query.callback as string
        );
    }
});

/**
 * getTopSongs.view - Get top songs for an artist (required by Symfonium)
 */
router.get("/getTopSongs.view", async (req: Request, res: Response) => {
    const format = getResponseFormat(req.query);
    const { artist, count = "50" } = req.query;

    try {
        const limit = Math.min(parseInt(count as string, 10) || 50, 100);

        let where: any = {};
        if (artist) {
            where.album = {
                artist: {
                    name: { contains: artist as string, mode: "insensitive" },
                },
            };
        }

        // Get tracks, ordered by play count if available
        const tracks = await prisma.track.findMany({
            where,
            include: {
                album: {
                    include: {
                        artist: { select: { id: true, name: true } },
                    },
                },
            },
            take: limit * 2,
        });

        // Shuffle and take requested count
        const shuffled = tracks.sort(() => Math.random() - 0.5).slice(0, limit);

        // Get play data for shuffled tracks
        const trackIds = shuffled.filter(t => t.album).map(t => t.id);
        const trackPlayData = trackIds.length > 0 ? await prisma.$queryRaw<Array<{ trackId: string; lastPlayed: Date; playCount: bigint }>>`
            SELECT p."trackId", MAX(p."playedAt") as "lastPlayed", COUNT(p.id) as "playCount"
            FROM "Play" p
            WHERE p."trackId" = ANY(${trackIds})
            GROUP BY p."trackId"
        ` : [];
        const trackLastPlayed = new Map(trackPlayData.map(d => [d.trackId, d.lastPlayed]));
        const trackPlayCount = new Map(trackPlayData.map(d => [d.trackId, Number(d.playCount)]));

        const songs = shuffled
            .filter((t) => t.album)
            .map((track) =>
                formatTrackForSubsonic({
                    ...track,
                    album: {
                        id: track.album!.id,
                        title: track.album!.title,
                        coverUrl: track.album!.coverUrl,
                        year: track.album!.year,
                        createdAt: track.album!.createdAt,
                        location: track.album!.location,
                        artist: track.album!.artist,
                    },
                }, {
                    played: trackLastPlayed.get(track.id),
                    playCount: trackPlayCount.get(track.id) || 0,
                })
            );

        sendSubsonicSuccess(
            res,
            { topSongs: { song: songs } },
            format,
            req.query.callback as string
        );
    } catch (error) {
        console.error("[Subsonic] getTopSongs error:", error);
        sendSubsonicError(
            res,
            SubsonicErrorCode.GENERIC,
            "Failed to fetch top songs",
            format,
            req.query.callback as string
        );
    }
});

router.get("/getScanStatus.view", async (req: Request, res: Response) => {
    const format = getResponseFormat(req.query);
    try {
        const [albumCount, trackCount, activeJobs, waitingJobs] = await Promise.all([
            prisma.album.count(),
            prisma.track.count(),
            scanQueue.getActive(),
            scanQueue.getWaiting(),
        ]);
        const scanning = activeJobs.length > 0 || waitingJobs.length > 0;
        sendSubsonicSuccess(
            res,
            { scanStatus: { scanning, count: trackCount, folderCount: albumCount } },
            format,
            req.query.callback as string
        );
    } catch (error) {
        console.error("[Subsonic] getScanStatus error:", error);
        sendSubsonicSuccess(res, { scanStatus: { scanning: false, count: 0 } }, format, req.query.callback as string);
    }
});

router.get("/startScan.view", async (req: Request, res: Response) => {
    const format = getResponseFormat(req.query);
    if (!config.music.musicPath) {
        return sendSubsonicError(
            res,
            SubsonicErrorCode.GENERIC,
            "Music path not configured",
            format,
            req.query.callback as string
        );
    }

    try {
        const userId = req.user?.id || "system";
        await scanQueue.add("scan", {
            userId,
            musicPath: config.music.musicPath,
        });
        sendSubsonicSuccess(
            res,
            { scanStatus: { scanning: true, count: 0 } },
            format,
            req.query.callback as string
        );
    } catch (error) {
        console.error("[Subsonic] startScan error:", error);
        sendSubsonicError(
            res,
            SubsonicErrorCode.GENERIC,
            "Failed to start scan",
            format,
            req.query.callback as string
        );
    }
});

export default router;
