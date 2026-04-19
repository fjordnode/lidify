import React from "react";
import { Play, Pause, Music } from "lucide-react";
import { cn } from "@/utils/cn";
import Image from "next/image";
import { api } from "@/lib/api";
import type { Track, Artist } from "../types";
import type { ColorPalette } from "@/hooks/useImageColor";

interface PreviewAlbumInfo {
    title: string;
    cover: string | null;
}

interface PopularTracksProps {
    tracks: Track[];
    artist: Artist;
    currentTrackId: string | undefined;
    colors: ColorPalette | null;
    onPlayTrack: (track: Track) => void;
    previewTrack: string | null;
    previewPlaying: boolean;
    previewAlbumInfo?: Record<string, PreviewAlbumInfo>;
    noPreviewTracks?: Set<string>;
    onPreview: (track: Track, e: React.MouseEvent) => void;
}

export const PopularTracks: React.FC<PopularTracksProps> = ({
    tracks,
    currentTrackId,
    onPlayTrack,
    previewTrack,
    previewPlaying,
    previewAlbumInfo,
    noPreviewTracks,
    onPreview,
}) => {
    const formatDuration = (seconds: number) => {
        const mins = Math.floor(seconds / 60);
        const secs = seconds % 60;
        return `${mins}:${secs.toString().padStart(2, "0")}`;
    };

    const formatNumber = (num: number) => {
        if (num >= 1000000) {
            return `${(num / 1000000).toFixed(1)}M`;
        } else if (num >= 1000) {
            return `${(num / 1000).toFixed(1)}K`;
        }
        return num.toString();
    };

    return (
        <section>
            <h2 className="text-xl font-bold mb-4">Popular</h2>
            <div data-tv-section="tracks">
                {tracks.slice(0, 5).map((track, index) => {
                    const isPlaying = currentTrackId === track.id;
                    const isPreviewPlaying =
                        previewTrack === track.id && previewPlaying;
                    const isUnowned =
                        !track.album?.id ||
                        !track.album?.title ||
                        track.album.title === "Unknown Album";
                    // Use Deezer album cover for previews, fall back to track's album art
                    const previewCover = previewAlbumInfo?.[track.id]?.cover;
                    const coverUrl = previewCover
                        ? previewCover  // Deezer cover is already a full URL
                        : track.album?.coverArt
                            ? api.getCoverArtUrl(track.album.coverArt, 80)
                            : null;

                    return (
                        <div
                            key={track.id}
                            data-track-row
                            data-tv-card
                            data-tv-card-index={index}
                            tabIndex={0}
                            className={cn(
                                "grid grid-cols-[40px_1fr_auto] md:grid-cols-[40px_minmax(200px,4fr)_minmax(80px,1fr)_80px] gap-4 py-2 rounded-md hover:bg-white/5 transition-colors group cursor-pointer",
                                isPlaying && "bg-white/10",
                                isPreviewPlaying && "bg-blue-500/10"
                            )}
                            onClick={(e) => {
                                if (isUnowned) {
                                    // Only try preview if not already known to be unavailable
                                    if (!noPreviewTracks?.has(track.id)) {
                                        onPreview(track, e);
                                    }
                                } else {
                                    onPlayTrack(track);
                                }
                            }}
                        >
                            {/* Track Number / Play Icon */}
                            <div className="flex items-center justify-center">
                                <span
                                    className={cn(
                                        "text-sm",
                                        // Hide number/icon on hover to show play/pause
                                        "group-hover:hidden",
                                        isPlaying
                                            ? "text-brand"
                                            : isPreviewPlaying
                                            ? "text-blue-400"
                                            : "text-gray-400"
                                    )}
                                >
                                    {isPlaying ? (
                                        <Music className="w-4 h-4 text-brand animate-pulse" />
                                    ) : isPreviewPlaying ? (
                                        <Pause className="w-4 h-4 text-blue-400" />
                                    ) : (
                                        index + 1
                                    )}
                                </span>
                                {/* Show pause on hover when playing, play otherwise */}
                                {isPlaying ? (
                                    <Pause className="w-4 h-4 text-brand hidden group-hover:block" />
                                ) : isPreviewPlaying ? (
                                    <Pause className="w-4 h-4 text-blue-400 hidden group-hover:block" />
                                ) : (
                                    <Play className="w-4 h-4 text-white hidden group-hover:block" />
                                )}
                            </div>

                            {/* Title + Album Art */}
                            <div className="flex items-center gap-3 min-w-0">
                                <div className="w-10 h-10 bg-[#282828] rounded shrink-0 overflow-hidden">
                                    {coverUrl ? (
                                        <Image
                                            src={coverUrl}
                                            alt={track.title}
                                            width={40}
                                            height={40}
                                            className="object-cover"
                                            unoptimized
                                        />
                                    ) : (
                                        <div className="w-full h-full flex items-center justify-center">
                                            <Music className="w-5 h-5 text-gray-600" />
                                        </div>
                                    )}
                                </div>
                                <div className="min-w-0">
                                    <div
                                        className={cn(
                                            "text-sm font-medium truncate flex items-center gap-2",
                                            isPlaying
                                                ? "text-brand"
                                                : isPreviewPlaying
                                                ? "text-blue-400"
                                                : "text-white"
                                        )}
                                    >
                                        <span className="truncate">
                                            {track.title}
                                        </span>
                                        {isUnowned && (
                                            <span className={cn(
                                                "shrink-0 text-[10px] px-1.5 py-0.5 rounded font-medium",
                                                noPreviewTracks?.has(track.id)
                                                    ? "bg-gray-500/20 text-gray-500"
                                                    : "bg-blue-500/20 text-blue-400"
                                            )}>
                                                {noPreviewTracks?.has(track.id) ? "NO PREVIEW" : "PREVIEW"}
                                            </span>
                                        )}
                                    </div>
                                    <p className="text-xs text-gray-400 truncate">
                                        {/* Use Deezer album info if available, otherwise fall back to track data */}
                                        {previewAlbumInfo?.[track.id]?.title ||
                                         (track.album?.title && track.album.title !== "Unknown Album"
                                            ? track.album.title
                                            : null)}
                                    </p>
                                </div>
                            </div>

                            {/* Play Count (hidden on mobile) */}
                            <div className="hidden md:flex items-center text-sm text-gray-400">
                                {track.playCount !== undefined &&
                                    track.playCount > 0 && (
                                        <span className="flex items-center gap-1">
                                            <Play className="w-3 h-3" />
                                            {formatNumber(track.playCount)}
                                        </span>
                                    )}
                            </div>

                            {/* Duration - only show if > 0 */}
                            <div className="flex items-center justify-end">
                                {track.duration > 0 && (
                                    <span className="text-sm text-gray-400 w-10 text-right">
                                        {formatDuration(track.duration)}
                                    </span>
                                )}
                            </div>
                        </div>
                    );
                })}
            </div>
        </section>
    );
};
