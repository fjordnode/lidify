"use client";

import { Play, Pause, Download, Sparkles } from "lucide-react";
import { cn } from "@/utils/cn";
import { Podcast, Episode } from "../types";
import { formatDuration, formatDate } from "../utils";

interface ContinueListeningProps {
    podcast: Podcast;
    inProgressEpisodes: Episode[];
    sortedEpisodes: Episode[];
    isEpisodePlaying: (episodeId: string) => boolean;
    isPlaying: boolean;
    onPlayEpisode: (episode: Episode) => void;
    onPlayPause: (episode: Episode) => void;
}

export function ContinueListening({
    inProgressEpisodes,
    isEpisodePlaying,
    isPlaying,
    onPlayPause,
}: ContinueListeningProps) {
    if (inProgressEpisodes.length === 0) {
        return null;
    }

    // Get up to 3 in-progress episodes, sorted by last played (most recent first)
    const episodesToShow = [...inProgressEpisodes]
        .sort((a, b) => {
            const aTime = new Date(a.progress?.lastPlayedAt || 0).getTime();
            const bTime = new Date(b.progress?.lastPlayedAt || 0).getTime();
            return bTime - aTime;
        })
        .slice(0, 3);

    return (
        <section>
            <h2 className="text-xl font-bold mb-4">Continue Listening</h2>
            <div className="space-y-1">
                {episodesToShow.map((episode) => {
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
                                onClick={() => onPlayPause(episode)}
                                className="flex items-center gap-3 px-3 py-3 cursor-pointer"
                            >
                                {/* Play/Pause Icon */}
                                <div className="w-8 flex items-center justify-center shrink-0">
                                    {isCurrentEpisode && isPlaying ? (
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
                                    </div>
                                </div>
                            </div>
                        </div>
                    );
                })}
            </div>
        </section>
    );
}
