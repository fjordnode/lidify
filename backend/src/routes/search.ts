import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { prisma } from "../utils/db";
import { audiobookshelfService } from "../services/audiobookshelf";
import { lastFmService } from "../services/lastfm";
import { searchService } from "../services/search";
import axios from "axios";
import { redisClient } from "../utils/redis";

const router = Router();

router.use(requireAuth);

/**
 * @openapi
 * /search:
 *   get:
 *     summary: Search across your music library
 *     description: Search for artists, albums, tracks, audiobooks, and podcasts in your library using PostgreSQL full-text search
 *     tags: [Search]
 *     security:
 *       - sessionAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: q
 *         schema:
 *           type: string
 *         required: true
 *         description: Search query
 *         example: "radiohead"
 *       - in: query
 *         name: type
 *         schema:
 *           type: string
 *           enum: [all, artists, albums, tracks, audiobooks, podcasts]
 *         description: Type of content to search
 *         default: all
 *       - in: query
 *         name: genre
 *         schema:
 *           type: string
 *         description: Filter tracks by genre
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *         description: Maximum number of results per type
 *         default: 20
 *     responses:
 *       200:
 *         description: Search results
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 artists:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Artist'
 *                 albums:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Album'
 *                 tracks:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Track'
 *                 audiobooks:
 *                   type: array
 *                   items:
 *                     type: object
 *                 podcasts:
 *                   type: array
 *                   items:
 *                     type: object
 *       401:
 *         description: Not authenticated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get("/", async (req, res) => {
    try {
        const { q = "", type = "all", genre, limit = "20" } = req.query;

        const query = (q as string).trim();
        const searchLimit = Math.min(parseInt(limit as string, 10), 100);

        if (!query) {
            return res.json({
                artists: [],
                albums: [],
                tracks: [],
                audiobooks: [],
                podcasts: [],
            });
        }

        // Check cache for library search (short TTL since library can change)
        const cacheKey = `search:library:${type}:${genre || ""}:${query}:${searchLimit}`;
        try {
            const cached = await redisClient.get(cacheKey);
            if (cached) {
                console.log(`[SEARCH] Cache hit for query="${query}"`);
                return res.json(JSON.parse(cached));
            }
        } catch (err) {
            // Redis errors are non-critical
        }

        const results: any = {
            artists: [],
            albums: [],
            tracks: [],
            audiobooks: [],
            podcasts: [],
        };

        const artistSearchPromise =
            type === "all" || type === "artists"
                ? searchService.searchArtists({ query, limit: searchLimit })
                : Promise.resolve([]);
        const albumSearchPromise =
            type === "all" || type === "albums"
                ? searchService.searchAlbums({ query, limit: searchLimit })
                : Promise.resolve([]);
        const trackSearchPromise =
            type === "all" || type === "tracks"
                ? searchService.searchTracks({ query, limit: searchLimit })
                : Promise.resolve([]);
        const audiobookSearchPromise =
            type === "all" || type === "audiobooks"
                ? audiobookshelfService
                      .searchAudiobooks(query)
                      .catch((error) => {
                          console.error("Audiobook search error:", error);
                          return [];
                      })
                : Promise.resolve([]);
        const podcastSearchPromise =
            type === "all" || type === "podcasts"
                ? audiobookshelfService.getAllPodcasts().catch((error) => {
                      console.error("Podcast search error:", error);
                      return [];
                  })
                : Promise.resolve([]);

        if (type === "all" || type === "artists") {
            const artistResults = await artistSearchPromise;
            if (artistResults.length > 0) {
                const artistIds = artistResults.map((a) => a.id);
                const artistsWithAlbums = await prisma.artist.findMany({
                    where: {
                        id: { in: artistIds },
                        albums: {
                            some: {},
                        },
                    },
                    select: {
                        id: true,
                        mbid: true,
                        name: true,
                        heroUrl: true,
                        summary: true,
                    },
                });

                // Preserve rank order from search, with name as secondary sort
                const rankMap = new Map(
                    artistResults.map((a) => [a.id, a.rank])
                );
                results.artists = artistsWithAlbums.sort((a, b) => {
                    const rankA = rankMap.get(a.id) || 0;
                    const rankB = rankMap.get(b.id) || 0;
                    if (rankB !== rankA) return rankB - rankA; // Sort by rank DESC
                    return a.name.localeCompare(b.name); // Then by name ASC
                });
            } else {
                results.artists = [];
            }
        }

        if (type === "all" || type === "albums") {
            const albumResults = await albumSearchPromise;
            results.albums = albumResults.map((album) => ({
                id: album.id,
                title: album.title,
                artistId: album.artistId,
                year: album.year,
                coverUrl: album.coverUrl,
                artist: {
                    id: album.artistId,
                    name: album.artistName,
                    mbid: "", // Not included in search result
                },
            }));
        }

        if (type === "all" || type === "tracks") {
            const trackResults = await trackSearchPromise;
            if (genre) {
                const trackIds = trackResults.map((t) => t.id);
                const tracksWithGenre = await prisma.track.findMany({
                    where: {
                        id: { in: trackIds },
                        trackGenres: {
                            some: {
                                genre: {
                                    name: {
                                        equals: genre as string,
                                        mode: "insensitive",
                                    },
                                },
                            },
                        },
                    },
                    select: { id: true },
                });

                const genreTrackIds = new Set(tracksWithGenre.map((t) => t.id));
                results.tracks = trackResults
                    .filter((t) => genreTrackIds.has(t.id))
                    .map((track) => ({
                        id: track.id,
                        title: track.title,
                        albumId: track.albumId,
                        duration: track.duration,
                        trackNo: 0,
                        album: {
                            id: track.albumId,
                            title: track.albumTitle,
                            artistId: track.artistId,
                            coverUrl: track.albumCoverUrl,
                            artist: {
                                id: track.artistId,
                                name: track.artistName,
                                mbid: "",
                            },
                        },
                    }));
            } else {
                results.tracks = trackResults.map((track) => ({
                    id: track.id,
                    title: track.title,
                    albumId: track.albumId,
                    duration: track.duration,
                    trackNo: 0,
                    album: {
                        id: track.albumId,
                        title: track.albumTitle,
                        artistId: track.artistId,
                        coverUrl: track.albumCoverUrl,
                        artist: {
                            id: track.artistId,
                            name: track.artistName,
                            mbid: "",
                        },
                    },
                }));
            }
        }

        if (type === "all" || type === "audiobooks") {
            const audiobooks = await audiobookSearchPromise;
            results.audiobooks = audiobooks.slice(0, searchLimit);
        }

        if (type === "all" || type === "podcasts") {
            const allPodcasts = await podcastSearchPromise;
            results.podcasts = allPodcasts
                .filter(
                    (p) =>
                        p.media?.metadata?.title
                            ?.toLowerCase()
                            .includes(query.toLowerCase()) ||
                        p.media?.metadata?.author
                            ?.toLowerCase()
                            .includes(query.toLowerCase())
                )
                .slice(0, searchLimit);
        }

        // Cache search results for 2 minutes (library can change)
        try {
            await redisClient.setEx(cacheKey, 120, JSON.stringify(results));
        } catch (err) {
            // Redis errors are non-critical
        }

        res.json(results);
    } catch (error) {
        console.error("Search error:", error);
        res.status(500).json({ error: "Search failed" });
    }
});

// GET /search/genres
router.get("/genres", async (req, res) => {
    try {
        const genres = await prisma.genre.findMany({
            orderBy: { name: "asc" },
            include: {
                _count: {
                    select: { trackGenres: true },
                },
            },
        });

        res.json(
            genres.map((g) => ({
                id: g.id,
                name: g.name,
                trackCount: g._count.trackGenres,
            }))
        );
    } catch (error) {
        console.error("Get genres error:", error);
        res.status(500).json({ error: "Failed to get genres" });
    }
});

/**
 * GET /search/discover?q=query&type=music|podcasts
 * Search for NEW content to discover (not in your library)
 */
router.get("/discover", async (req, res) => {
    try {
        const { q = "", type = "music", limit = "20" } = req.query;

        const query = (q as string).trim();
        const searchLimit = Math.min(parseInt(limit as string, 10), 50);

        if (!query) {
            return res.json({ results: [] });
        }

        const cacheKey = `search:discover:${type}:${query}:${searchLimit}`;
        try {
            const cached = await redisClient.get(cacheKey);
            if (cached) {
                console.log(
                    `[SEARCH DISCOVER] Cache hit for query="${query}" type=${type}`
                );
                return res.json(JSON.parse(cached));
            }
        } catch (err) {
            console.warn("[SEARCH DISCOVER] Redis read error:", err);
        }

        const results: any[] = [];

        if (type === "music" || type === "all") {
            // Search Last.fm for artists AND tracks
            try {
                const [lastfmArtistResults, lastfmTrackResults] =
                    await Promise.all([
                        lastFmService.searchArtists(
                            query,
                            searchLimit + 10 // Request extra to account for filtering
                        ),
                        lastFmService.searchTracks(query, searchLimit),
                    ]);

                const candidateNames = Array.from(
                    new Set(
                        lastfmArtistResults
                            .map((artist: any) => artist.name?.trim())
                            .filter(Boolean)
                    )
                );
                const libraryArtistNames = new Set<string>();
                if (candidateNames.length > 0) {
                    const libraryArtists = await prisma.artist.findMany({
                        where: {
                            OR: candidateNames.map((name) => ({
                                name: { equals: name, mode: "insensitive" },
                            })),
                        },
                        select: { name: true },
                    });
                    for (const artist of libraryArtists) {
                        libraryArtistNames.add(artist.name.toLowerCase().trim());
                    }
                }

                // Filter out artists already in library
                const filteredArtists = lastfmArtistResults.filter(
                    (artist: any) => !libraryArtistNames.has(artist.name?.toLowerCase().trim())
                );

                const enrichCount = Math.min(3, filteredArtists.length);
                if (enrichCount > 0) {
                    const enrichedArtists = await Promise.all(
                        filteredArtists
                            .slice(0, enrichCount)
                            .map(async (artist) => {
                                try {
                                    return await lastFmService.enrichArtistSearchResult(
                                        artist
                                    );
                                } catch (err) {
                                    console.warn(
                                        "[SEARCH ENDPOINT] Failed to enrich artist result:",
                                        err
                                    );
                                    return artist;
                                }
                            })
                    );

                    for (let i = 0; i < enrichedArtists.length; i += 1) {
                        filteredArtists[i] = enrichedArtists[i];
                    }
                }

                console.log(
                    `[SEARCH ENDPOINT] Found ${lastfmArtistResults.length} artists, ${filteredArtists.length} after filtering library`
                );
                results.push(...filteredArtists.slice(0, searchLimit));

                console.log(
                    `[SEARCH ENDPOINT] Found ${lastfmTrackResults.length} track results`
                );
                results.push(...lastfmTrackResults);
            } catch (error) {
                console.error("Last.fm search error:", error);
            }
        }

        if (type === "podcasts" || type === "all") {
            // Search iTunes Podcast API
            try {
                const itunesResponse = await axios.get(
                    "https://itunes.apple.com/search",
                    {
                        params: {
                            term: query,
                            media: "podcast",
                            entity: "podcast",
                            limit: searchLimit,
                        },
                        timeout: 5000,
                    }
                );

                const podcasts = itunesResponse.data.results.map(
                    (podcast: any) => ({
                        type: "podcast",
                        id: podcast.collectionId,
                        name: podcast.collectionName,
                        artist: podcast.artistName,
                        description: podcast.description,
                        coverUrl:
                            podcast.artworkUrl600 || podcast.artworkUrl100,
                        feedUrl: podcast.feedUrl,
                        genres: podcast.genres || [],
                        trackCount: podcast.trackCount,
                    })
                );

                results.push(...podcasts);
            } catch (error) {
                console.error("iTunes podcast search error:", error);
            }
        }

        const payload = { results };

        try {
            await redisClient.setEx(cacheKey, 900, JSON.stringify(payload));
        } catch (err) {
            console.warn("[SEARCH DISCOVER] Redis write error:", err);
        }

        res.json(payload);
    } catch (error) {
        console.error("Discovery search error:", error);
        res.status(500).json({ error: "Discovery search failed" });
    }
});

export default router;
