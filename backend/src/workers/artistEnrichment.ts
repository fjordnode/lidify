import { Artist } from "@prisma/client";
import { prisma } from "../utils/db";
import { wikidataService } from "../services/wikidata";
import { lastFmService } from "../services/lastfm";
import { fanartService } from "../services/fanart";
import { deezerService } from "../services/deezer";
import { musicBrainzService } from "../services/musicbrainz";
import { normalizeArtistName } from "../utils/artistNormalization";
import { coverArtService } from "../services/coverArt";
import { imageProviderService } from "../services/imageProvider";
import { fetchExternalImage } from "../services/imageProxy";

// MusicBrainz secondary types to exclude from discography
const EXCLUDED_SECONDARY_TYPES = [
    "Live", "Compilation", "Soundtrack", "Remix", "DJ-mix",
    "Mixtape/Street", "Demo", "Interview", "Audio drama", "Audiobook", "Spokenword",
];

/**
 * Enriches an artist with metadata from Wikidata and Last.fm
 * - Fetches artist bio/summary and hero image from Wikidata
 * - Falls back to Last.fm if Wikidata fails
 * - Fetches similar artists from Last.fm
 */
export async function enrichSimilarArtist(artist: Artist): Promise<void> {
    const logPrefix = `[ENRICH ${artist.name}]`;
    console.log(`${logPrefix} Starting enrichment (MBID: ${artist.mbid})`);

    // Mark as enriching
    await prisma.artist.update({
        where: { id: artist.id },
        data: { enrichmentStatus: "enriching" },
    });

    // Track which source provided data
    let imageSource = "none";
    let summarySource = "none";

    try {
        // If artist has a temp MBID, try to get the real one from MusicBrainz
        if (artist.mbid.startsWith("temp-")) {
            console.log(
                `${logPrefix} Temp MBID detected, searching MusicBrainz...`
            );
            try {
                const mbResults = await musicBrainzService.searchArtist(
                    artist.name,
                    1
                );
                if (mbResults.length > 0 && mbResults[0].id) {
                    const realMbid = mbResults[0].id;
                    console.log(
                        `${logPrefix} MusicBrainz: Found real MBID: ${realMbid}`
                    );

                    // Update artist with real MBID
                    await prisma.artist.update({
                        where: { id: artist.id },
                        data: { mbid: realMbid },
                    });

                    // Update the local artist object
                    artist.mbid = realMbid;
                } else {
                    console.log(
                        `${logPrefix} MusicBrainz: No match found, keeping temp MBID`
                    );
                }
            } catch (error: any) {
                console.log(
                    `${logPrefix} MusicBrainz: FAILED - ${
                        error?.message || error
                    }`
                );
            }
        }

        // Try Wikidata first (only if we have a real MBID)
        let summary = null;
        let heroUrl = null;

        if (!artist.mbid.startsWith("temp-")) {
            console.log(
                `${logPrefix} Wikidata: Fetching for MBID ${artist.mbid}...`
            );
            try {
                const wikidataInfo = await wikidataService.getArtistInfo(
                    artist.mbid
                );
                if (wikidataInfo) {
                    summary = wikidataInfo.summary;
                    heroUrl = wikidataInfo.image;
                    if (summary) summarySource = "wikidata";
                    if (heroUrl) imageSource = "wikidata";
                    console.log(
                        `${logPrefix} Wikidata: SUCCESS (image: ${
                            heroUrl ? "yes" : "no"
                        }, summary: ${summary ? "yes" : "no"})`
                    );
                } else {
                    console.log(`${logPrefix} Wikidata: No data returned`);
                }
            } catch (error: any) {
                console.log(
                    `${logPrefix} Wikidata: FAILED - ${error?.message || error}`
                );
            }
        } else {
            console.log(`${logPrefix} Wikidata: Skipped (temp MBID)`);
        }

        // Fallback to Last.fm if Wikidata didn't work
        if (!summary || !heroUrl) {
            console.log(
                `${logPrefix} Last.fm: Fetching (need summary: ${!summary}, need image: ${!heroUrl})...`
            );
            try {
                const validMbid = artist.mbid.startsWith("temp-")
                    ? undefined
                    : artist.mbid;
                const lastfmInfo = await lastFmService.getArtistInfo(
                    artist.name,
                    validMbid
                );
                if (lastfmInfo) {
                    // Extract text from bio object (bio.summary or bio.content)
                    if (!summary && lastfmInfo.bio) {
                        const bio = lastfmInfo.bio as any;
                        summary = bio.summary || bio.content || null;
                        if (summary) {
                            summarySource = "lastfm";
                            console.log(`${logPrefix} Last.fm: Got summary`);
                        }
                    }

                    // Try Fanart.tv for image (only with real MBID)
                    if (!heroUrl && !artist.mbid.startsWith("temp-")) {
                        console.log(
                            `${logPrefix} Fanart.tv: Fetching for MBID ${artist.mbid}...`
                        );
                        try {
                            heroUrl = await fanartService.getArtistImage(
                                artist.mbid
                            );
                            if (heroUrl) {
                                imageSource = "fanart.tv";
                                console.log(
                                    `${logPrefix} Fanart.tv: SUCCESS - ${heroUrl.substring(
                                        0,
                                        60
                                    )}...`
                                );
                            } else {
                                console.log(
                                    `${logPrefix} Fanart.tv: No image found`
                                );
                            }
                        } catch (error: any) {
                            console.log(
                                `${logPrefix} Fanart.tv: FAILED - ${
                                    error?.message || error
                                }`
                            );
                        }
                    }

                    // Fallback to Deezer
                    if (!heroUrl) {
                        console.log(
                            `${logPrefix} Deezer: Fetching for "${artist.name}"...`
                        );
                        try {
                            heroUrl = await deezerService.getArtistImage(
                                artist.name
                            );
                            if (heroUrl) {
                                imageSource = "deezer";
                                console.log(
                                    `${logPrefix} Deezer: SUCCESS - ${heroUrl.substring(
                                        0,
                                        60
                                    )}...`
                                );
                            } else {
                                console.log(
                                    `${logPrefix} Deezer: No image found`
                                );
                            }
                        } catch (error: any) {
                            console.log(
                                `${logPrefix} Deezer: FAILED - ${
                                    error?.message || error
                                }`
                            );
                        }
                    }

                    // Last fallback to Last.fm's own image
                    if (!heroUrl && lastfmInfo.image) {
                        const imageArray = lastfmInfo.image as any[];
                        if (Array.isArray(imageArray)) {
                            const bestImage =
                                imageArray.find(
                                    (img) => img.size === "extralarge"
                                )?.["#text"] ||
                                imageArray.find(
                                    (img) => img.size === "large"
                                )?.["#text"] ||
                                imageArray.find(
                                    (img) => img.size === "medium"
                                )?.["#text"];
                            // Filter out Last.fm's placeholder images
                            if (
                                bestImage &&
                                !bestImage.includes(
                                    "2a96cbd8b46e442fc41c2b86b821562f"
                                )
                            ) {
                                heroUrl = bestImage;
                                imageSource = "lastfm";
                                console.log(
                                    `${logPrefix} Last.fm image: SUCCESS`
                                );
                            } else {
                                console.log(
                                    `${logPrefix} Last.fm image: Placeholder/none`
                                );
                            }
                        }
                    }
                } else {
                    console.log(`${logPrefix} Last.fm: No data returned`);
                }
            } catch (error: any) {
                console.log(
                    `${logPrefix} Last.fm: FAILED - ${error?.message || error}`
                );
            }
        }

        // Get similar artists from Last.fm
        let similarArtists: Array<{
            name: string;
            mbid: string | null;
            similarity: number;
        }> = [];
        try {
            // Filter out temp MBIDs
            const validMbid = artist.mbid.startsWith("temp-")
                ? ""
                : artist.mbid;
            similarArtists = await lastFmService.getSimilarArtists(
                validMbid,
                artist.name
            );
            console.log(
                `${logPrefix} Similar artists: Found ${similarArtists.length}`
            );
        } catch (error: any) {
            console.log(
                `${logPrefix} Similar artists: FAILED - ${
                    error?.message || error
                }`
            );
        }

        // Log enrichment summary
        console.log(
            `${logPrefix} SUMMARY: image=${imageSource}, summary=${summarySource}, heroUrl=${
                heroUrl ? "set" : "null"
            }`
        );

        // Prepare similar artists JSON for storage (full Last.fm data)
        const similarArtistsJson =
            similarArtists.length > 0
                ? similarArtists.map((s) => ({
                      name: s.name,
                      mbid: s.mbid || null,
                      match: s.similarity,
                  }))
                : null;

        // Update artist with enriched data
        await prisma.artist.update({
            where: { id: artist.id },
            data: {
                summary,
                heroUrl,
                similarArtistsJson,
                lastEnriched: new Date(),
                enrichmentStatus: "completed",
            },
        });

        // Store similar artists
        if (similarArtists.length > 0) {
            // Delete existing similar artist relationships
            await prisma.similarArtist.deleteMany({
                where: { fromArtistId: artist.id },
            });

            // Create new relationships
            for (const similar of similarArtists) {
                // Find existing similar artist (don't create new ones)
                let similarArtistRecord = null;

                if (similar.mbid) {
                    // Try to find by MBID first
                    similarArtistRecord = await prisma.artist.findUnique({
                        where: { mbid: similar.mbid },
                    });
                }

                if (!similarArtistRecord) {
                    // Try to find by normalized name (case-insensitive)
                    const normalizedSimilarName = normalizeArtistName(
                        similar.name
                    );
                    similarArtistRecord = await prisma.artist.findFirst({
                        where: { normalizedName: normalizedSimilarName },
                    });
                }

                // Only create similarity relationship if the similar artist already exists in our database
                // This prevents endless crawling of similar artists
                if (similarArtistRecord) {
                    await prisma.similarArtist.upsert({
                        where: {
                            fromArtistId_toArtistId: {
                                fromArtistId: artist.id,
                                toArtistId: similarArtistRecord.id,
                            },
                        },
                        create: {
                            fromArtistId: artist.id,
                            toArtistId: similarArtistRecord.id,
                            weight: similar.similarity,
                        },
                        update: {
                            weight: similar.similarity,
                        },
                    });
                }
            }

            console.log(
                `${logPrefix} Stored ${similarArtists.length} similar artist relationships`
            );
        }

        // ========== ALBUM COVER ENRICHMENT ==========
        // Fetch covers for all albums belonging to this artist that don't have covers yet
        await enrichAlbumCovers(artist.id, heroUrl);

        // Pre-fetch covers for MusicBrainz discography (so artist page loads fast)
        if (!artist.mbid.startsWith("temp-")) {
            await prefetchDiscographyCovers(artist.mbid, artist.name);
        }

    } catch (error: any) {
        console.error(
            `${logPrefix} ENRICHMENT FAILED:`,
            error?.message || error
        );

        // Mark as failed
        await prisma.artist.update({
            where: { id: artist.id },
            data: { enrichmentStatus: "failed" },
        });

        throw error;
    }
}

/**
 * Enrich album covers for an artist
 * Strategy:
 * 1. For valid MBIDs: Try Cover Art Archive first
 * 2. For temp MBIDs or CAA failures: Use imageProviderService (Deezer -> Fanart -> Last.fm)
 */
async function enrichAlbumCovers(
    artistId: string,
    artistHeroUrl: string | null
): Promise<void> {
    try {
        // Find albums for this artist that don't have cover art
        const albumsWithoutCovers = await prisma.album.findMany({
            where: {
                artistId,
                OR: [{ coverUrl: null }, { coverUrl: "" }],
            },
            select: {
                id: true,
                rgMbid: true,
                title: true,
                artist: { select: { name: true } },
            },
        });

        if (albumsWithoutCovers.length === 0) {
            console.log(`    All albums already have covers`);
            return;
        }

        console.log(
            `    Fetching covers for ${albumsWithoutCovers.length} albums...`
        );

        let fetchedCount = 0;
        const BATCH_SIZE = 3; // Limit concurrent requests

        // Process in batches to avoid overwhelming external APIs
        for (let i = 0; i < albumsWithoutCovers.length; i += BATCH_SIZE) {
            const batch = albumsWithoutCovers.slice(i, i + BATCH_SIZE);

            await Promise.all(
                batch.map(async (album) => {
                    try {
                        let coverUrl: string | null = null;
                        const hasValidMbid = album.rgMbid && !album.rgMbid.startsWith("temp-");

                        // Strategy 1: Try Cover Art Archive for valid MBIDs
                        if (hasValidMbid) {
                            coverUrl = await coverArtService.getCoverArt(album.rgMbid);
                        }

                        // Strategy 2: Fallback to Deezer/other providers
                        // This works even without MBID (uses artist name + album title)
                        if (!coverUrl) {
                            const result = await imageProviderService.getAlbumCover(
                                album.artist.name,
                                album.title,
                                hasValidMbid ? album.rgMbid : undefined
                            );
                            if (result) {
                                coverUrl = result.url;
                                console.log(`      Found cover for "${album.title}" from ${result.source}`);
                            }
                        }

                        if (coverUrl) {
                            // Save to database
                            await prisma.album.update({
                                where: { id: album.id },
                                data: { coverUrl },
                            });

                            fetchedCount++;
                        } else {
                            console.log(`      No cover found for: ${album.title}`);
                        }
                    } catch (err) {
                        // Cover art fetch failed, continue with next album
                        console.log(`      Error fetching cover for "${album.title}":`, err);
                    }
                })
            );

            // Small delay between batches to be nice to APIs
            if (i + BATCH_SIZE < albumsWithoutCovers.length) {
                await new Promise(resolve => setTimeout(resolve, 500));
            }
        }

        console.log(
            `    Fetched ${fetchedCount}/${albumsWithoutCovers.length} album covers`
        );
    } catch (error) {
        console.error(`    Failed to enrich album covers:`, error);
        // Don't throw - album cover failures shouldn't fail the entire enrichment
    }
}

/**
 * Pre-fetch covers for an artist's MusicBrainz discography
 * This prefetches album images into the disk cache for faster page loads
 * Exported for use by admin endpoints to backfill existing artists
 */
export async function prefetchDiscographyCovers(
    artistMbid: string,
    artistName: string
): Promise<void> {
    try {
        console.log(`    Pre-fetching discography covers for ${artistName}...`);

        // Get discography from MusicBrainz
        const releaseGroups = await musicBrainzService.getReleaseGroups(artistMbid);

        // Filter to albums and EPs only (same filter as library endpoint)
        const filteredReleaseGroups = releaseGroups.filter((rg: any) => {
            const isPrimaryType =
                rg["primary-type"] === "Album" || rg["primary-type"] === "EP";
            if (!isPrimaryType) return false;

            const types = rg["secondary-types"] || [];
            return !types.some((t: string) => EXCLUDED_SECONDARY_TYPES.includes(t));
        });

        if (filteredReleaseGroups.length === 0) {
            console.log(`    No albums/EPs found in discography`);
            return;
        }

        const albumsToFetch = filteredReleaseGroups.map((rg: any) => ({
            id: rg.id,
            title: rg.title,
        }));

        console.log(
            `    Fetching ${albumsToFetch.length}/${filteredReleaseGroups.length} covers...`
        );

        let fetchedCount = 0;
        const BATCH_SIZE = 3;

        for (let i = 0; i < albumsToFetch.length; i += BATCH_SIZE) {
            const batch = albumsToFetch.slice(i, i + BATCH_SIZE);

            await Promise.all(
                batch.map(async (album) => {
                    try {
                        // Try imageProviderService which does Deezer -> CAA -> Fanart.tv
                        const result = await imageProviderService.getAlbumCover(
                            artistName,
                            album.title,
                            album.id
                        );

                        if (result?.url) {
                            await fetchExternalImage({
                                url: result.url,
                                cacheKeySuffix: "original",
                            });
                            fetchedCount++;
                        } else {
                            console.log(
                                `      [PREFETCH] No cover found: "${album.title}" (${album.id})`
                            );
                        }
                    } catch (err: any) {
                        // Log the actual error for debugging
                        const errorMsg = err?.message || err?.code || String(err);
                        console.error(`      [PREFETCH] ERROR for "${album.title}": ${errorMsg}`);
                        // Don't cache - allow retry on next prefetch
                    }
                })
            );

            // Delay between batches to respect rate limits
            if (i + BATCH_SIZE < albumsToFetch.length) {
                await new Promise(resolve => setTimeout(resolve, 500));
            }
        }

        console.log(
            `    Pre-fetched ${fetchedCount}/${albumsToFetch.length} discography covers`
        );
    } catch (error) {
        console.error(`    Failed to pre-fetch discography covers:`, error);
        // Don't throw - this is best-effort
    }
}
