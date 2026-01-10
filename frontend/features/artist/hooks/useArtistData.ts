import { useParams, useRouter } from "next/navigation";
import { toast } from "sonner";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/hooks/useQueries";
import { api } from "@/lib/api";
import { useDownloadContext } from "@/lib/download-context";
import { Artist, Album, ArtistSource } from "../types";
import { useMemo, useEffect, useRef } from "react";

export function useArtistData() {
    const params = useParams();
    const router = useRouter();
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

    // Use React Query - no polling needed, webhook events trigger refresh via download context
    const {
        data: artist,
        isLoading,
        error,
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
                    return await api.getArtist(id);
                } catch (error) {
                    // Library lookup failed, try discovery (might be an MBID)
                    console.log(`[useArtistData] Library failed, trying discovery for: ${id}`);
                    return await api.getArtistDiscovery(id);
                }
            } else {
                // It's an artist name, use discovery directly
                console.log(`[useArtistData] Using discovery for artist name: ${id}`);
                return await api.getArtistDiscovery(id);
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

    // Determine source from the artist data (if it came from library or discovery)
    const source: ArtistSource | null = useMemo(() => {
        if (!artist) return null;
        return artist.id && !artist.id.includes("-") ? "library" : "discovery";
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
                queryClient.setQueryData(queryKeys.artist(id), fullArtist);
            })
            .catch(() => {
                // Ignore background fetch errors
            });
    }, [artist, id, source, queryClient]);

    // Sort albums by year (newest first, nulls last) - memoized
    const albums = useMemo(() => {
        if (!artist?.albums) return [];

        return [...artist.albums].sort((a, b) => {
            if (a.year == null && b.year == null) return 0;
            if (a.year == null) return 1;
            if (b.year == null) return -1;
            return b.year - a.year;
        });
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
