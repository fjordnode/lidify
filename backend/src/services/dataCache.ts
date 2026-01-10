/**
 * DataCacheService - Unified data access with consistent storage pattern
 *
 * Pattern: DB first -> API fetch -> save to DB
 *
 * This ensures:
 * - DB is the source of truth for image URLs
 * - API calls only happen when data doesn't exist
 * - All fetched data is persisted for future use
 */

import { prisma } from "../utils/db";
import { fanartService } from "./fanart";
import { deezerService } from "./deezer";
import { lastFmService } from "./lastfm";
import { coverArtService } from "./coverArt";

class DataCacheService {
    /**
     * Get artist hero image with unified caching
     * Order: DB -> Fanart.tv -> Deezer -> Last.fm -> save to DB
     */
    async getArtistImage(
        artistId: string,
        artistName: string,
        mbid?: string | null
    ): Promise<string | null> {
        // 1. Check DB first (source of truth)
        try {
            const artist = await prisma.artist.findUnique({
                where: { id: artistId },
                select: { heroUrl: true },
            });
            if (artist?.heroUrl) {
                return artist.heroUrl;
            }
        } catch (err) {
            console.warn("[DataCache] DB lookup failed for artist:", artistId);
        }

        // 2. Fetch from external APIs
        const heroUrl = await this.fetchArtistImage(artistName, mbid);

        // 3. Save to DB
        if (heroUrl) {
            await this.updateArtistHeroUrl(artistId, heroUrl);
        }

        return heroUrl;
    }

    /**
     * Get album cover with unified caching
     * Order: DB -> Cover Art Archive -> save to DB
     */
    async getAlbumCover(
        albumId: string,
        rgMbid: string
    ): Promise<string | null> {
        // 1. Check DB first
        try {
            const album = await prisma.album.findUnique({
                where: { id: albumId },
                select: { coverUrl: true },
            });
            if (album?.coverUrl) {
                return album.coverUrl;
            }
        } catch (err) {
            console.warn("[DataCache] DB lookup failed for album:", albumId);
        }

        // 2. Fetch from Cover Art Archive
        const coverUrl = await coverArtService.getCoverArt(rgMbid);

        // 3. Save to DB
        if (coverUrl) {
            await this.updateAlbumCoverUrl(albumId, coverUrl);
        }

        return coverUrl;
    }

    /**
     * Get track cover (uses album cover)
     */
    async getTrackCover(
        trackId: string,
        albumId: string,
        rgMbid?: string | null
    ): Promise<string | null> {
        if (!rgMbid) {
            // Try to get album's rgMbid from DB
            const album = await prisma.album.findUnique({
                where: { id: albumId },
                select: { rgMbid: true, coverUrl: true },
            });
            if (album?.coverUrl) return album.coverUrl;
            if (album?.rgMbid) rgMbid = album.rgMbid;
        }

        if (!rgMbid) return null;

        return this.getAlbumCover(albumId, rgMbid);
    }

    /**
     * Batch get artist images - for list views
     * Only returns what's already in the payload, doesn't make API calls
     */
    async getArtistImagesBatch(
        artists: Array<{ id: string; heroUrl?: string | null }>
    ): Promise<Map<string, string | null>> {
        const results = new Map<string, string | null>();

        // First, use any heroUrls already in the data
        for (const artist of artists) {
            if (artist.heroUrl) {
                results.set(artist.id, artist.heroUrl);
            }
        }

        return results;
    }

    /**
     * Batch get album covers - for list views
     * Only returns what's already in the payload, doesn't make API calls
     */
    async getAlbumCoversBatch(
        albums: Array<{ id: string; coverUrl?: string | null }>
    ): Promise<Map<string, string | null>> {
        const results = new Map<string, string | null>();

        for (const album of albums) {
            if (album.coverUrl) {
                results.set(album.id, album.coverUrl);
            }
        }

        return results;
    }

    /**
     * Fetch artist image from external APIs
     * Order: Fanart.tv (if MBID) -> Deezer -> Last.fm
     */
    private async fetchArtistImage(
        artistName: string,
        mbid?: string | null
    ): Promise<string | null> {
        let heroUrl: string | null = null;

        // Try Fanart.tv first if we have a valid MBID
        if (mbid && !mbid.startsWith("temp-")) {
            try {
                heroUrl = await fanartService.getArtistImage(mbid);
                if (heroUrl) {
                    console.log(`[DataCache] Got image from Fanart.tv for ${artistName}`);
                    return heroUrl;
                }
            } catch (err) {
                // Fanart.tv failed, continue
            }
        }

        // Try Deezer
        try {
            heroUrl = await deezerService.getArtistImage(artistName);
            if (heroUrl) {
                console.log(`[DataCache] Got image from Deezer for ${artistName}`);
                return heroUrl;
            }
        } catch (err) {
            // Deezer failed, continue
        }

        // Try Last.fm
        try {
            const validMbid = mbid && !mbid.startsWith("temp-") ? mbid : undefined;
            const lastfmInfo = await lastFmService.getArtistInfo(artistName, validMbid);

            if (lastfmInfo?.image && Array.isArray(lastfmInfo.image)) {
                const largestImage =
                    lastfmInfo.image.find((img: any) => img.size === "extralarge" || img.size === "mega") ||
                    lastfmInfo.image[lastfmInfo.image.length - 1];

                if (largestImage && largestImage["#text"]) {
                    // Filter out Last.fm placeholder images
                    const imageUrl = largestImage["#text"];
                    if (!imageUrl.includes("2a96cbd8b46e442fc41c2b86b821562f")) {
                        console.log(`[DataCache] Got image from Last.fm for ${artistName}`);
                        return imageUrl;
                    }
                }
            }
        } catch (err) {
            // Last.fm failed
        }

        console.log(`[DataCache] No image found for ${artistName}`);
        return null;
    }

    /**
     * Update artist heroUrl in database
     */
    private async updateArtistHeroUrl(artistId: string, heroUrl: string): Promise<void> {
        try {
            await prisma.artist.update({
                where: { id: artistId },
                data: { heroUrl },
            });
        } catch (err) {
            console.warn("[DataCache] Failed to update artist heroUrl:", err);
        }
    }

    /**
     * Update album coverUrl in database
     */
    private async updateAlbumCoverUrl(albumId: string, coverUrl: string): Promise<void> {
        try {
            await prisma.album.update({
                where: { id: albumId },
                data: { coverUrl },
            });
        } catch (err) {
            console.warn("[DataCache] Failed to update album coverUrl:", err);
        }
    }

}

export const dataCacheService = new DataCacheService();












