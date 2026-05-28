/* eslint-disable react-hooks/preserve-manual-memoization -- Complex album sorting requires manual memoization */
import { useParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/hooks/useQueries";
import { api } from "@/lib/api";
import { useDownloadContext } from "@/lib/download-context";
import type { Artist, ArtistSource } from "../types";
import { useMemo, useEffect, useRef } from "react";

type ArtistWithSource = Artist & { source: ArtistSource };

export function useArtistData() {
    const params = useParams();
    // Decode the ID in case it's still URL-encoded (e.g., special characters like ø, fullwidth chars)
    const rawId = params.id as string;
    let id = rawId;
    if (rawId) {
        try {
            id = decodeURIComponent(rawId);
        } catch {
            // Invalid URI encoding, use raw value
            id = rawId;
        }
    }
    const { downloadStatus } = useDownloadContext();
    const prevActiveCountRef = useRef(downloadStatus.activeDownloads.length);
    const queryClient = useQueryClient();
    const externalLoadedRef = useRef(false);

    useEffect(() => {
        externalLoadedRef.current = false;
    }, [id]);

    // Use React Query - no polling needed, webhook events trigger refresh via download context
    const {
        data: artist,
        isLoading,
        isError,
        refetch,
    } = useQuery({
        queryKey: queryKeys.artist(id || ""),
        queryFn: async () => {
            if (!id) throw new Error("Artist ID is required");

            // Check if ID looks like a database ID (CUID or UUID) vs artist name
            const isCUID = /^c[a-z0-9]{20,}$/i.test(id);
            const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
            const isDatabaseId = isCUID || isUUID;

            console.log(`[useArtistData] Fetching artist: "${id}", isDatabaseId: ${isDatabaseId}`);

            // For database IDs, try library first then discovery
            // For names/MBIDs, go straight to discovery
            if (isDatabaseId) {
                try {
                    console.log(`[useArtistData] Trying library for: ${id}`);
                    const libraryArtist = await api.getArtist(id);
                    return { ...libraryArtist, source: "library" } as ArtistWithSource;
                } catch (_error) {
                    // Library lookup failed, try discovery (might be an MBID)
                    console.log(`[useArtistData] Library failed, trying discovery for: ${id}`);
                    const discoveryArtist = await api.getArtistDiscovery(id);
                    return { ...discoveryArtist, source: "discovery" } as ArtistWithSource;
                }
            } else {
                // It's an artist name, use discovery directly
                console.log(`[useArtistData] Using discovery for artist name: ${id}`);
                const discoveryArtist = await api.getArtistDiscovery(id);
                return { ...discoveryArtist, source: "discovery" } as ArtistWithSource;
            }
        },
        enabled: !!id,
        staleTime: 5 * 60 * 1000, // 5 minutes
        gcTime: 10 * 60 * 1000, // Keep in cache for 10 minutes
        retry: 2,
        refetchOnMount: true,
    });

    // Refetch when downloads complete (active count decreases)
    useEffect(() => {
        const currentActiveCount = downloadStatus.activeDownloads.length;
        if (
            prevActiveCountRef.current > 0 &&
            currentActiveCount < prevActiveCountRef.current
        ) {
            // Downloads have completed, refresh data
            refetch();
        }
        prevActiveCountRef.current = currentActiveCount;
    }, [downloadStatus.activeDownloads.length, refetch]);

    // Source follows the successful API path, not ID shape. UUID library IDs contain hyphens.
    const source: ArtistSource | null = useMemo(() => {
        if (!artist) return null;
        return artist.source;
    }, [artist]);

    useEffect(() => {
        if (!id || !artist || source !== "library") {
            return;
        }
        if (externalLoadedRef.current) {
            return;
        }
        externalLoadedRef.current = true;

        api.getArtist(id, { includeExternal: true })
            .then((fullArtist) => {
                queryClient.setQueryData(queryKeys.artist(id), {
                    ...fullArtist,
                    source: "library",
                } as ArtistWithSource);
            })
            .catch(() => {
                // Ignore background fetch errors
            });
    }, [artist, id, source, queryClient]);

    // Sort albums by year (newest first, nulls last) - memoized
    const albums = useMemo(() => {
        if (!artist?.albums) return [];

        const sorted = [...artist.albums].sort((a, b) => {
            const aYear = typeof a.year === "number" ? a.year : Number(a.year);
            const bYear = typeof b.year === "number" ? b.year : Number(b.year);
            const aHasYear = Number.isFinite(aYear);
            const bHasYear = Number.isFinite(bYear);

            if (!aHasYear && !bHasYear) {
                return a.title.localeCompare(b.title);
            }
            if (!aHasYear) return 1;
            if (!bHasYear) return -1;
            if (aYear !== bYear) return bYear - aYear;

            const aRelease = a.releaseDate ? Date.parse(a.releaseDate as string) : Number.NaN;
            const bRelease = b.releaseDate ? Date.parse(b.releaseDate as string) : Number.NaN;
            const aHasRelease = Number.isFinite(aRelease);
            const bHasRelease = Number.isFinite(bRelease);

            if (aHasRelease && bHasRelease && aRelease !== bRelease) {
                return bRelease - aRelease;  // Descending (newer first) to match year sort
            }

            return a.title.localeCompare(b.title);
        });

        return sorted;
    }, [artist?.albums]);

    // Handle errors - only show toast once, don't auto-navigate
    // The page component should handle displaying a "not found" state
    // Don't call router.back() as it causes navigation loops

    return {
        artist,
        albums,
        loading: isLoading,
        error: isError,
        source,
        reloadArtist: refetch,
    };
}
