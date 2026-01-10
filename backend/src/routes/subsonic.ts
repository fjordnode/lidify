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
import { prisma } from "../utils/db";
import { config } from "../config";
import { requireSubsonicAuth } from "../middleware/subsonicAuth";
import { AudioStreamingService, Quality, QUALITY_SETTINGS } from "../services/audioStreaming";
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

// Apply Subsonic authentication to all routes
router.use(requireSubsonicAuth);

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
                    orderBy: { year: "desc" },
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
            created: album.createdAt?.toISOString() || "",
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
                    created: album.createdAt?.toISOString() || "",
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
 * getAlbumList2.view - Album list (ID3 mode) with sorting options
 */
router.get("/getAlbumList2.view", async (req: Request, res: Response) => {
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
                created: album!.createdAt?.toISOString() || "",
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
                created: album!.createdAt?.toISOString() || "",
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
                break;
            case "alphabeticalByName":
                orderBy = { title: "asc" };
                break;
            case "alphabeticalByArtist":
                orderBy = { artist: { name: "asc" } };
                break;
            case "starred":
                // Would need favorites data - return empty for now
                return sendSubsonicSuccess(
                    res,
                    { albumList2: { album: [] } },
                    format,
                    req.query.callback as string
                );
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
                created: album.createdAt?.toISOString() || "",
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
});

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
    const {
        query = "", // Allow empty query for full library sync (required by Symfonium)
        artistCount = "20",
        artistOffset = "0",
        albumCount = "20",
        albumOffset = "0",
        songCount = "20",
        songOffset = "0",
    } = req.query;

    try {
        // Handle empty query - Symfonium sends "" (literal quotes) for full library sync
        let searchTerm = ((query as string) || "").toLowerCase().trim();
        // Remove surrounding quotes if present (e.g., '""' or '"something"')
        if (searchTerm.startsWith('"') && searchTerm.endsWith('"')) {
            searchTerm = searchTerm.slice(1, -1);
        }

        // Build where clauses - empty search term returns all results
        const artistWhere = searchTerm
            ? { name: { contains: searchTerm, mode: "insensitive" as const } }
            : {};
        const albumWhere = searchTerm
            ? {
                  OR: [
                      { title: { contains: searchTerm, mode: "insensitive" as const } },
                      { artist: { name: { contains: searchTerm, mode: "insensitive" as const } } },
                  ],
              }
            : {};
        const trackWhere = searchTerm
            ? {
                  OR: [
                      { title: { contains: searchTerm, mode: "insensitive" as const } },
                      { album: { title: { contains: searchTerm, mode: "insensitive" as const } } },
                      { album: { artist: { name: { contains: searchTerm, mode: "insensitive" as const } } } },
                  ],
              }
            : {};

        // Run all searches in parallel for better performance
        const [artists, albums, songs] = await Promise.all([
            // Search artists - count=0 means return all (Symfonium behavior)
            prisma.artist.findMany({
                where: artistWhere,
                select: {
                    id: true,
                    name: true,
                    heroUrl: true,
                    createdAt: true,
                    _count: { select: { albums: true } },
                },
                orderBy: { name: "asc" },
                skip: parseInt(artistOffset as string, 10) || 0,
                take: parseInt(artistCount as string, 10) || 5000, // 0 means all
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
                skip: parseInt(albumOffset as string, 10) || 0,
                take: parseInt(albumCount as string, 10) || 5000, // 0 means all
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
                skip: parseInt(songOffset as string, 10) || 0,
                take: parseInt(songCount as string, 10) || 50000, // 0 means all
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
                            created: a.createdAt?.toISOString() || "",
                            played: lastPlay ? lastPlay.toISOString() : undefined, // Must always include, even if empty
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
                            created: album.createdAt?.toISOString() || "",
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

        // Get absolute path
        const normalizedFilePath = track.filePath.replace(/\\/g, "/");
        const absolutePath = path.join(config.music.musicPath, normalizedFilePath);

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

        const normalizedFilePath = track.filePath.replace(/\\/g, "/");
        const absolutePath = path.join(config.music.musicPath, normalizedFilePath);

        if (!fs.existsSync(absolutePath)) {
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

        // Cover cache directory
        const coverCacheDir = path.join(config.music.transcodeCachePath, "../covers");

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
            },
            orderBy: { createdAt: "desc" },
        });

        const playlistList = playlists.map((pl) => ({
            id: `pl-${pl.id}`,
            name: pl.name,
            songCount: pl._count.items,
            duration: 0, // Would need to sum track durations
            public: false,
            owner: req.user!.username,
            created: pl.createdAt.toISOString(),
            changed: pl.createdAt.toISOString(), // No updatedAt field, use createdAt
        }));

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
                    changed: playlist.createdAt.toISOString(), // No updatedAt field
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
                select: { userId: true },
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
                // Clear existing and add new tracks
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

router.get("/getStarred.view", (req: Request, res: Response) => {
    const format = getResponseFormat(req.query);
    sendSubsonicSuccess(res, { starred: {} }, format, req.query.callback as string);
});

router.get("/getStarred2.view", (req: Request, res: Response) => {
    const format = getResponseFormat(req.query);
    sendSubsonicSuccess(res, { starred2: {} }, format, req.query.callback as string);
});

router.get("/star.view", (req: Request, res: Response) => {
    const format = getResponseFormat(req.query);
    // TODO: Implement starring (add to favorites playlist)
    sendSubsonicSuccess(res, {}, format, req.query.callback as string);
});

router.get("/unstar.view", (req: Request, res: Response) => {
    const format = getResponseFormat(req.query);
    sendSubsonicSuccess(res, {}, format, req.query.callback as string);
});

router.get("/getGenres.view", (req: Request, res: Response) => {
    const format = getResponseFormat(req.query);
    sendSubsonicSuccess(res, { genres: { genre: [] } }, format, req.query.callback as string);
});

router.get("/getBookmarks.view", (req: Request, res: Response) => {
    const format = getResponseFormat(req.query);
    sendSubsonicSuccess(res, { bookmarks: {} }, format, req.query.callback as string);
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

router.get("/getScanStatus.view", (req: Request, res: Response) => {
    const format = getResponseFormat(req.query);
    sendSubsonicSuccess(
        res,
        { scanStatus: { scanning: false, count: 0 } },
        format,
        req.query.callback as string
    );
});

router.get("/startScan.view", (req: Request, res: Response) => {
    const format = getResponseFormat(req.query);
    // TODO: Could trigger library scan
    sendSubsonicSuccess(
        res,
        { scanStatus: { scanning: false, count: 0 } },
        format,
        req.query.callback as string
    );
});

export default router;
