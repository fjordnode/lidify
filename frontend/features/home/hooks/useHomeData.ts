/**
 * useHomeData Hook
 *
 * Manages data loading for the Home page, fetching all 7 sections using React Query
 * and providing refresh functionality for mixes.
 */

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth-context";
import { toast } from "sonner";
import type {
    Artist,
    ListenedItem,
    Mix,
} from "../types";
import {
    useRecentlyListenedQuery,
    useRecentlyAddedQuery,
    useRecommendationsQuery,
    useMixesQuery,
    useRefreshMixesMutation,
    useBrowseAllQuery,
    queryKeys,
} from "@/hooks/useQueries";

interface PlaylistPreview {
    id: string;
    source: string;
    type: string;
    title: string;
    description: string | null;
    creator: string;
    imageUrl: string | null;
    trackCount: number;
    url: string;
}

export interface UseHomeDataReturn {
    // Data sections
    recentlyListened: ListenedItem[];
    recentlyAdded: Artist[];
    recommended: Artist[];
    mixes: Mix[];
    featuredPlaylists: PlaylistPreview[];

    // Loading states
    isLoading: boolean;
    isRefreshingMixes: boolean;
    isBrowseLoading: boolean;

    // Actions
    handleRefreshMixes: () => Promise<void>;
}

/**
 * Custom hook to load all Home page data sections using React Query
 *
 * Loads the following sections with automatic caching:
 * 1. Recently listened (Continue Listening)
 * 2. Recently added artists
 * 3. Recommended for you
 * 4. Mixes (Made For You)
 * 5. Popular artists
 * 6. Recent podcasts
 *
 * @returns {UseHomeDataReturn} All home page data and loading states
 */
export function useHomeData(): UseHomeDataReturn {
    const { isAuthenticated } = useAuth();
    const queryClient = useQueryClient();

    // Listen for mixes-updated event (fired when user saves mood preferences)
    // Use refetchQueries instead of invalidateQueries to force immediate UI update
    useEffect(() => {
        const handleMixesUpdated = () => {
            // refetchQueries forces immediate refetch, unlike invalidateQueries which only marks stale
            queryClient.refetchQueries({ queryKey: queryKeys.mixes() });
        };

        window.addEventListener("mixes-updated", handleMixesUpdated);
        return () =>
            window.removeEventListener("mixes-updated", handleMixesUpdated);
    }, [queryClient]);

    // Listen for discover recommendations refresh (fired from /discover page)
    useEffect(() => {
        const handleDiscoverUpdated = () => {
            // Refetch recommendations to pick up new localStorage cache
            queryClient.refetchQueries({ queryKey: queryKeys.recommendations(10) });
        };

        window.addEventListener("discover-recommendations-updated", handleDiscoverUpdated);
        return () =>
            window.removeEventListener("discover-recommendations-updated", handleDiscoverUpdated);
    }, [queryClient]);

    // React Query hooks - these automatically handle caching, refetching, and loading states
    const { data: recentlyListenedData, isLoading: isLoadingListened } =
        useRecentlyListenedQuery(10);
    const { data: recentlyAddedData, isLoading: isLoadingAdded } =
        useRecentlyAddedQuery(10);
    const { data: recommendedData, isLoading: isLoadingRecommended } =
        useRecommendationsQuery(10);
    const { data: mixesData, isLoading: isLoadingMixes } = useMixesQuery();
    const { data: browseData, isLoading: isBrowseLoading } =
        useBrowseAllQuery();

    // Mutation for refreshing mixes
    const { mutateAsync: refreshMixes, isPending: isRefreshingMixes } =
        useRefreshMixesMutation();

    /**
     * Refresh mixes and update cache
     */
    const handleRefreshMixes = async () => {
        try {
            await refreshMixes();
            toast.success("Mixes refreshed! Check out your new daily picks");
        } catch (error) {
            console.error("Failed to refresh mixes:", error);
            toast.error("Failed to refresh mixes");
        }
    };

    // Process recently listened data - can contain artists, podcasts, or audiobooks
    const items = recentlyListenedData?.items || [];

    // Calculate overall loading state - true if any query is loading
    const isLoading =
        !isAuthenticated ||
        isLoadingListened ||
        isLoadingAdded ||
        isLoadingRecommended ||
        isLoadingMixes;

    return {
        recentlyListened: items,
        recentlyAdded: recentlyAddedData?.artists || [],
        recommended: recommendedData?.artists || [],
        mixes: Array.isArray(mixesData) ? mixesData : [],
        featuredPlaylists: browseData?.playlists || [],
        isLoading,
        isRefreshingMixes,
        isBrowseLoading,
        handleRefreshMixes,
    };
}
