"use client";

import { useState, useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { useAudio } from "@/lib/audio-context";
import { api } from "@/lib/api";
import { Podcast, Episode, PodcastPreview } from "../types";
import { queryKeys } from "@/hooks/useQueries";

export function usePodcastActions(podcastId: string) {
    const router = useRouter();
    const queryClient = useQueryClient();
    const { playPodcast, currentPodcast, isPlaying, pause, resume } =
        useAudio();

    const [isSubscribing, setIsSubscribing] = useState(false);
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
    const [adRemovalAvailable, setAdRemovalAvailable] = useState(false);

    // Check if ad removal is available globally
    useEffect(() => {
        api.getAdRemovalStatus()
            .then((status) => setAdRemovalAvailable(status.available))
            .catch(() => setAdRemovalAvailable(false));
    }, []);

    const handleSubscribe = useCallback(
        async (previewData: PodcastPreview | null) => {
            if (!previewData) return;

            setIsSubscribing(true);
            try {
                const response = await api.subscribePodcast(
                    previewData.feedUrl!,
                    previewData.itunesId
                );

                if (response.success && response.podcast?.id) {
                    // Invalidate podcasts cache so the list refreshes
                    queryClient.invalidateQueries({ queryKey: queryKeys.podcasts() });
                    router.push(`/podcasts/${response.podcast.id}`);
                }
            } catch (error: unknown) {
                console.error("Subscribe error:", error);
                const message = error instanceof Error ? error.message : "Failed to subscribe to podcast";
                alert(message);
            } finally {
                setIsSubscribing(false);
            }
        },
        [router, queryClient]
    );

    const handleRemovePodcast = useCallback(async () => {
        try {
            await api.removePodcast(podcastId);
            // Invalidate podcasts cache so the list refreshes without the removed podcast
            queryClient.invalidateQueries({ queryKey: queryKeys.podcasts() });
            router.push("/podcasts");
        } catch (error) {
            console.error("Failed to remove podcast:", error);
        }
    }, [podcastId, router, queryClient]);

    const handlePlayEpisode = useCallback(
        (episode: Episode, podcast: Podcast) => {
            playPodcast({
                id: `${podcastId}:${episode.id}`,
                title: episode.title,
                podcastTitle: podcast.title,
                coverUrl: podcast.coverUrl,
                duration: episode.duration,
                progress: episode.progress || null,
            });
        },
        [podcastId, playPodcast]
    );

    const handlePlayPauseEpisode = useCallback(
        (episode: Episode, podcast: Podcast) => {
            const isCurrentEpisode =
                currentPodcast?.id === `${podcastId}:${episode.id}`;

            if (isCurrentEpisode && isPlaying) {
                pause();
            } else if (isCurrentEpisode) {
                resume();
            } else {
                handlePlayEpisode(episode, podcast);
            }
        },
        [podcastId, currentPodcast, isPlaying, pause, resume, handlePlayEpisode]
    );

    const isEpisodePlaying = useCallback(
        (episodeId: string) => {
            return currentPodcast?.id === `${podcastId}:${episodeId}`;
        },
        [podcastId, currentPodcast]
    );

    const handleSetAutoMode = useCallback(
        async (mode: "off" | "download" | "download_and_adfree") => {
            try {
                const settings = {
                    autoDownload: mode === "download" || mode === "download_and_adfree",
                    autoRemoveAds: mode === "download_and_adfree",
                };
                await api.updatePodcastSubscription(podcastId, settings);
                // Invalidate to refresh the podcast data with new settings
                queryClient.invalidateQueries({ queryKey: queryKeys.podcast(podcastId) });
            } catch (error) {
                console.error("Failed to update auto mode:", error);
            }
        },
        [podcastId, queryClient]
    );

    return {
        isSubscribing,
        showDeleteConfirm,
        setShowDeleteConfirm,
        handleSubscribe,
        handleRemovePodcast,
        handlePlayEpisode,
        handlePlayPauseEpisode,
        isEpisodePlaying,
        isPlaying,
        pause,
        resume,
        // Auto-download/ad-removal
        adRemovalAvailable,
        handleSetAutoMode,
    };
}

