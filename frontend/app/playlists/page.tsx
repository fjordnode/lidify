"use client";

import { useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import { usePlaylistsQuery } from "@/hooks/useQueries";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/hooks/useQueries";
import { useAuth } from "@/lib/auth-context";
import { useAudio } from "@/lib/audio-context";
import { Play, Music } from "lucide-react";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import { api } from "@/lib/api";
import { cn } from "@/utils/cn";

// Brand color for JS contexts (matches Tailwind brand color)
const BRAND_COLOR = "#fca200";

interface PlaylistItem {
    id: string;
    track: {
        album?: {
            coverArt?: string;
        };
    };
}

interface Playlist {
    id: string;
    name: string;
    trackCount?: number;
    items?: PlaylistItem[];
    isOwner?: boolean;
    user?: {
        username: string;
    };
}

// Generate mosaic cover from playlist tracks
function PlaylistMosaic({
    items,
    size = 4,
    greyed = false,
}: {
    items?: PlaylistItem[];
    size?: number;
    greyed?: boolean;
}) {
    const coverUrls = useMemo(() => {
        if (!items || items.length === 0) return [];

        const tracksWithCovers = items.filter(
            (item) => item.track?.album?.coverArt
        );
        if (tracksWithCovers.length === 0) return [];

        // Get unique cover arts (up to 4)
        const uniqueCovers = Array.from(
            new Set(tracksWithCovers.map((item) => item.track.album!.coverArt))
        ).slice(0, size);

        return uniqueCovers.map((cover) => api.getCoverArtUrl(cover!, 200));
    }, [items, size]);

    if (coverUrls.length === 0) {
        return (
            <div
                className={cn(
                    "w-full h-full flex items-center justify-center bg-gradient-to-br from-[#282828] to-[#181818]",
                    greyed && "opacity-50"
                )}
            >
                <Music className="w-10 h-10 text-gray-600" />
            </div>
        );
    }

    if (coverUrls.length === 1) {
        return (
            <Image
                src={coverUrls[0]}
                alt=""
                fill
                className={cn("object-cover", greyed && "opacity-50 grayscale")}
                sizes="200px"
                unoptimized
            />
        );
    }

    return (
        <div
            className={cn(
                "grid grid-cols-2 w-full h-full",
                greyed && "opacity-50 grayscale"
            )}
        >
            {coverUrls.slice(0, 4).map((url, index) => (
                <div key={index} className="relative">
                    <Image
                        src={url}
                        alt=""
                        fill
                        className="object-cover"
                        sizes="100px"
                        unoptimized
                    />
                </div>
            ))}
            {Array.from({ length: Math.max(0, 4 - coverUrls.length) }).map(
                (_, index) => (
                    <div
                        key={`empty-${index}`}
                        className="relative bg-[#282828] flex items-center justify-center"
                    >
                        <Music className="w-5 h-5 text-gray-600" />
                    </div>
                )
            )}
        </div>
    );
}

function PlaylistCard({
    playlist,
    index,
    onPlay,
}: {
    playlist: Playlist;
    index: number;
    onPlay: (playlistId: string) => void;
}) {
    const isShared = playlist.isOwner === false;

    return (
        <Link href={`/playlist/${playlist.id}`}>
            <div
                className="group cursor-pointer p-3 rounded-md transition-colors hover:bg-white/5"
                data-tv-card
                data-tv-card-index={index}
                tabIndex={0}
            >
                {/* Cover Image */}
                <div className="relative aspect-square mb-3 rounded-md overflow-hidden bg-[#282828] shadow-lg">
                    <PlaylistMosaic items={playlist.items} />

                    {/* Play button overlay */}
                    <button
                        onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            onPlay(playlist.id);
                        }}
                        style={{ backgroundColor: BRAND_COLOR }}
                        className={cn(
                            "absolute bottom-2 right-2 w-10 h-10 rounded-full flex items-center justify-center",
                            "shadow-lg shadow-black/40 transition-all duration-200",
                            "hover:scale-105 hover:brightness-110",
                            "opacity-0 translate-y-2 group-hover:opacity-100 group-hover:translate-y-0"
                        )}
                        title="Play playlist"
                    >
                        <Play className="w-4 h-4 fill-current ml-0.5 text-black" />
                    </button>
                </div>

                {/* Title and info */}
                <h3 className="text-sm font-semibold truncate text-white">
                    {playlist.name}
                </h3>
                <p className="text-xs text-gray-400 mt-0.5 truncate">
                    {isShared && playlist.user?.username ? (
                        <span className="text-gray-500">
                            By {playlist.user.username} ·{" "}
                        </span>
                    ) : null}
                    {playlist.trackCount || 0}{" "}
                    {playlist.trackCount === 1 ? "song" : "songs"}
                </p>
            </div>
        </Link>
    );
}

export default function PlaylistsPage() {
    useRouter();
    useAuth();
    const { playTracks } = useAudio();
    const queryClient = useQueryClient();

    // Use React Query hook for playlists
    const { data: playlists = [], isLoading } = usePlaylistsQuery();

    // Listen for playlist events and invalidate cache
    useEffect(() => {
        const handlePlaylistEvent = () => {
            queryClient.invalidateQueries({ queryKey: queryKeys.playlists() });
        };

        window.addEventListener("playlist-created", handlePlaylistEvent);
        window.addEventListener("playlist-updated", handlePlaylistEvent);
        window.addEventListener("playlist-deleted", handlePlaylistEvent);

        return () => {
            window.removeEventListener("playlist-created", handlePlaylistEvent);
            window.removeEventListener("playlist-updated", handlePlaylistEvent);
            window.removeEventListener("playlist-deleted", handlePlaylistEvent);
        };
    }, [queryClient]);

    const handlePlayPlaylist = async (playlistId: string) => {
        try {
            const playlist = await api.getPlaylist(playlistId);
            if (playlist?.items && playlist.items.length > 0) {
                const tracks = playlist.items.map((item: { track: { id: string; title: string; filePath: string; artist?: { name: string; id?: string }; album?: { title: string; coverArt?: string; id?: string; artist?: { name: string; id?: string } }; duration: number } }) => ({
                    id: item.track.id,
                    title: item.track.title,
                    filePath: item.track.filePath,
                    artist: {
                        name: item.track.album?.artist?.name || "Unknown",
                        id: item.track.album?.artist?.id,
                    },
                    album: {
                        title: item.track.album?.title || "Unknown",
                        coverArt: item.track.album?.coverArt,
                        id: item.track.album?.id,
                    },
                    duration: item.track.duration,
                }));
                playTracks(tracks, 0);
            }
        } catch (error) {
            console.error("Failed to play playlist:", error);
        }
    };

    if (isLoading) {
        return (
            <div className="flex items-center justify-center min-h-screen">
                <GradientSpinner size="md" />
            </div>
        );
    }

    return (
        <div className="min-h-screen relative">
            {/* Quick gradient fade - yellow to purple */}
            <div className="absolute inset-0 pointer-events-none">
                <div
                    className="absolute inset-0 bg-gradient-to-b from-brand/15 via-purple-900/10 to-transparent"
                    style={{ height: "35vh" }}
                />
                <div
                    className="absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,var(--tw-gradient-stops))] from-brand/8 via-transparent to-transparent"
                    style={{ height: "25vh" }}
                />
            </div>

            {/* Header */}
            <div className="relative px-6 pt-6 pb-4">
                <div className="flex items-center justify-between">
                    <div>
                        <h1 className="text-2xl font-bold text-white">
                            Playlists
                        </h1>
                        <p className="text-sm text-gray-400 mt-0.5">
                            {playlists.length}{" "}
                            {playlists.length === 1
                                ? "playlist"
                                : "playlists"}
                        </p>
                    </div>

                    <div className="flex items-center gap-2">
                        {/* Browse Public Playlists */}
                        <Link
                            href="/browse/playlists"
                            className="px-4 py-2 rounded-full text-sm font-medium bg-brand text-black hover:brightness-110 transition-all"
                        >
                            Browse Playlists
                        </Link>
                    </div>
                </div>
            </div>

            {/* Content */}
            <div className="relative px-4 pb-24">
                {playlists.length > 0 ? (
                    <div
                        data-tv-section="playlists"
                        className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7 gap-2"
                    >
                        {playlists.map(
                            (playlist: Playlist, index: number) => (
                                <PlaylistCard
                                    key={playlist.id}
                                    playlist={playlist}
                                    index={index}
                                    onPlay={handlePlayPlaylist}
                                />
                            )
                        )}
                    </div>
                ) : (
                    <div className="flex flex-col items-center justify-center py-24 text-center">
                        <div className="w-16 h-16 rounded-full bg-white/5 flex items-center justify-center mb-4">
                            <Music className="w-8 h-8 text-gray-500" />
                        </div>
                        <h2 className="text-lg font-semibold text-white mb-1">
                            No playlists yet
                        </h2>
                        <p className="text-sm text-gray-400 max-w-sm">
                            Create your first playlist by adding songs from albums or artists
                        </p>
                        <Link
                            href="/browse/playlists"
                            className="mt-6 px-5 py-2.5 rounded-full text-sm font-medium bg-brand text-black hover:brightness-110 transition-all"
                        >
                            Browse Playlists
                        </Link>
                    </div>
                )}
            </div>
        </div>
    );
}
