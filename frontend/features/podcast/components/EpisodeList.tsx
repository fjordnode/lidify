"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Play, Pause, Check, ArrowUpDown, MoreVertical, Sparkles, Download, Loader2, Trash2 } from "lucide-react";
import { cn } from "@/utils/cn";
import { queryKeys } from "@/hooks/useQueries";
import { Podcast, Episode } from "../types";
import { formatDuration, formatDate } from "../utils";
import { api } from "@/lib/api";
import { toast } from "sonner";

interface EpisodeListProps {
    podcast: Podcast;
    episodes: Episode[];
    sortOrder: "newest" | "oldest";
    onSortOrderChange: (order: "newest" | "oldest") => void;
    isEpisodePlaying: (episodeId: string) => boolean;
    isPlaying: boolean;
    onPlayPause: (episode: Episode) => void;
    onPlay: (episode: Episode) => void;
}

export function EpisodeList({
    podcast,
    episodes,
    sortOrder,
    onSortOrderChange,
    isEpisodePlaying,
    isPlaying,
    onPlayPause,
    onPlay,
}: EpisodeListProps) {
    const queryClient = useQueryClient();
    const [openMenuId, setOpenMenuId] = useState<string | null>(null);
    const [processingIds, setProcessingIds] = useState<Set<string>>(new Set());

    const invalidatePodcast = () => {
        queryClient.invalidateQueries({ queryKey: queryKeys.podcast(podcast.id) });
    };

    const handleRemoveAds = async (episode: Episode) => {
        setOpenMenuId(null);
        setProcessingIds(prev => new Set(prev).add(episode.id));

        try {
            const result = await api.removeAdsFromEpisode(episode.id);

            if (result.success) {
                if (result.status === "download_started") {
                    toast.success("Downloading episode...", {
                        description: "Ad removal will start automatically when download completes",
                    });
                } else if (result.status === "downloading") {
                    toast.info("Episode is downloading", {
                        description: "Ad removal will run when download completes",
                    });
                } else {
                    toast.success("Ad removal started!", {
                        description: "Processing may take a few minutes",
                    });
                }
                // Invalidate immediately to show download status, then periodically check for completion
                invalidatePodcast();
                // Poll for ad removal completion (runs in background for several minutes)
                const pollInterval = setInterval(() => {
                    invalidatePodcast();
                }, 30000); // Check every 30 seconds
                // Stop polling after 10 minutes
                setTimeout(() => clearInterval(pollInterval), 600000);
            }
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : "";
            if (message.includes("not available")) {
                toast.error("Ad removal not available", {
                    description: "Whishper service not running or not configured",
                });
            } else {
                toast.error("Failed to start ad removal", {
                    description: message || undefined,
                });
            }
        } finally {
            // Keep processing indicator for a bit since it's async
            setTimeout(() => {
                setProcessingIds(prev => {
                    const next = new Set(prev);
                    next.delete(episode.id);
                    return next;
                });
            }, 3000);
        }
    };

    const handleDownload = async (episode: Episode) => {
        setOpenMenuId(null);

        try {
            const result = await api.downloadPodcastEpisode(episode.id);

            if (result.status === "already_cached") {
                toast.info("Episode already downloaded");
                invalidatePodcast();
            } else if (result.status === "downloading") {
                toast.info("Download in progress", {
                    description: `${result.progress || 0}% complete`,
                });
            } else {
                toast.success("Download started!");
                // Poll for completion and update UI
                setTimeout(invalidatePodcast, 2000);
            }
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : undefined;
            toast.error("Failed to download", {
                description: message,
            });
        }
    };

    const handleDeleteDownload = async (episode: Episode) => {
        setOpenMenuId(null);

        try {
            await api.deleteDownloadedEpisode(episode.id);
            toast.success("Download deleted");
            invalidatePodcast();
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : undefined;
            toast.error("Failed to delete download", {
                description: message,
            });
        }
    };

    return (
        <section>
            <div className="flex items-center justify-between mb-4">
                <h2 className="text-xl font-bold text-white">All Episodes</h2>
                <button
                    onClick={() =>
                        onSortOrderChange(
                            sortOrder === "newest" ? "oldest" : "newest"
                        )
                    }
                    className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/5 hover:bg-white/10 text-sm text-white/70 hover:text-white transition-all"
                >
                    <ArrowUpDown className="w-4 h-4" />
                    {sortOrder === "newest" ? "Newest First" : "Oldest First"}
                </button>
            </div>

            <div className="space-y-1">
                {episodes.map((episode) => {
                    const isCurrentEpisode = isEpisodePlaying(episode.id);

                    return (
                        <div
                            key={episode.id}
                            className={cn(
                                "group relative rounded-md transition-all",
                                isCurrentEpisode ? "bg-white/10" : "hover:bg-white/5"
                            )}
                        >
                            {/* Progress bar at the bottom */}
                            {episode.progress && episode.progress.progress > 0 && (
                                <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-white/5 rounded-full overflow-hidden">
                                    <div
                                        className="h-full bg-brand/60 transition-all"
                                        style={{
                                            width: `${episode.progress.progress}%`,
                                        }}
                                    />
                                </div>
                            )}

                            <div
                                onClick={() => {
                                    if (!isCurrentEpisode) {
                                        onPlay(episode);
                                    }
                                }}
                                className="flex items-center gap-3 px-3 py-3 cursor-pointer"
                            >
                                {/* Play/Pause Icon */}
                                <div className="w-8 flex items-center justify-center shrink-0">
                                    {episode.progress?.isFinished ? (
                                        <Check className="w-4 h-4 text-green-400" />
                                    ) : isCurrentEpisode && isPlaying ? (
                                        <Pause
                                            className="w-4 h-4 text-brand cursor-pointer"
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                onPlayPause(episode);
                                            }}
                                        />
                                    ) : (
                                        <Play
                                            className={cn(
                                                "w-4 h-4 cursor-pointer",
                                                isCurrentEpisode
                                                    ? "text-brand"
                                                    : "text-white/40 group-hover:text-white"
                                            )}
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                onPlayPause(episode);
                                            }}
                                        />
                                    )}
                                </div>

                                {/* Episode Info */}
                                <div className="flex-1 min-w-0">
                                    <h3
                                        className={cn(
                                            "font-medium truncate text-sm",
                                            isCurrentEpisode
                                                ? "text-brand"
                                                : "text-white"
                                        )}
                                    >
                                        {episode.title}
                                    </h3>
                                    <div className="flex items-center gap-2 text-xs text-white/50 mt-0.5">
                                        <span>{formatDate(episode.publishedAt)}</span>
                                        {episode.season && (
                                            <>
                                                <span>•</span>
                                                <span>S{episode.season}</span>
                                            </>
                                        )}
                                        {episode.episodeNumber && (
                                            <>
                                                <span>•</span>
                                                <span>E{episode.episodeNumber}</span>
                                            </>
                                        )}
                                        <span>•</span>
                                        <span>{formatDuration(episode.duration)}</span>
                                        {episode.adsRemoved ? (
                                            <>
                                                <span>•</span>
                                                <span title="Ad-free" className="text-brand">
                                                    <Sparkles className="w-3 h-3 inline" />
                                                </span>
                                            </>
                                        ) : episode.isDownloaded ? (
                                            <>
                                                <span>•</span>
                                                <span title="Downloaded" className="text-green-400/70">
                                                    <Download className="w-3 h-3 inline" />
                                                </span>
                                            </>
                                        ) : null}
                                        {episode.progress?.isFinished && (
                                            <>
                                                <span>•</span>
                                                <span className="text-green-400">Finished</span>
                                            </>
                                        )}
                                    </div>
                                </div>

                                {/* Menu Button */}
                                <div className="relative shrink-0 ml-2">
                                    <button
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            setOpenMenuId(openMenuId === episode.id ? null : episode.id);
                                        }}
                                        className={cn(
                                            "p-1.5 rounded-full transition-all",
                                            openMenuId === episode.id
                                                ? "bg-white/20 text-white"
                                                : "text-white/30 hover:text-white hover:bg-white/10"
                                        )}
                                    >
                                        {processingIds.has(episode.id) ? (
                                            <Loader2 className="w-4 h-4 animate-spin text-brand" />
                                        ) : (
                                            <MoreVertical className="w-4 h-4" />
                                        )}
                                    </button>

                                    {/* Dropdown Menu */}
                                    {openMenuId === episode.id && (
                                        <>
                                            {/* Backdrop to close menu */}
                                            <div
                                                className="fixed inset-0 z-10"
                                                onClick={() => setOpenMenuId(null)}
                                            />
                                            <div className="absolute right-0 top-full mt-1 z-20 bg-zinc-900 border border-white/10 rounded-lg shadow-xl py-1 min-w-[160px]">
                                                {/* Download - show if not downloaded */}
                                                {!episode.isDownloaded && (
                                                    <button
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            handleDownload(episode);
                                                        }}
                                                        className="w-full flex items-center gap-3 px-4 py-2 text-sm text-white/80 hover:bg-white/10 hover:text-white transition-colors"
                                                    >
                                                        <Download className="w-4 h-4" />
                                                        Download
                                                    </button>
                                                )}
                                                {/* Remove Ads - show if ads not removed (will auto-download if needed) */}
                                                {!episode.adsRemoved && (
                                                    <button
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            handleRemoveAds(episode);
                                                        }}
                                                        className="w-full flex items-center gap-3 px-4 py-2 text-sm text-white/80 hover:bg-white/10 hover:text-white transition-colors"
                                                    >
                                                        <Sparkles className="w-4 h-4 text-brand" />
                                                        Remove Ads
                                                    </button>
                                                )}
                                                {/* Delete - show if downloaded */}
                                                {episode.isDownloaded && (
                                                    <button
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            handleDeleteDownload(episode);
                                                        }}
                                                        className="w-full flex items-center gap-3 px-4 py-2 text-sm text-red-400/80 hover:bg-white/10 hover:text-red-400 transition-colors"
                                                    >
                                                        <Trash2 className="w-4 h-4" />
                                                        Delete
                                                    </button>
                                                )}
                                            </div>
                                        </>
                                    )}
                                </div>
                            </div>
                        </div>
                    );
                })}
            </div>
        </section>
    );
}
