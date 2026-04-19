"use client";

import { useState, useEffect } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import Image from "next/image";
import {
    ArrowLeft,
    Play,
    Pause,
    Download,
    Loader2,
    ExternalLink,
    Music2,
    Plus,
} from "lucide-react";
import { api } from "@/lib/api";
import { useToast } from "@/lib/toast-context";
import { useAudio } from "@/lib/audio-context";
import { Track } from "@/lib/audio-state-context";
import { cn } from "@/utils/cn";
import { GradientSpinner } from "@/components/ui/GradientSpinner";

// Deezer icon component
const DeezerIcon = ({ className }: { className?: string }) => (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor">
        <path d="M18.81 4.16v3.03H24V4.16h-5.19zM6.27 8.38v3.027h5.189V8.38h-5.19zm12.54 0v3.027H24V8.38h-5.19zM6.27 12.595v3.027h5.189v-3.027h-5.19zm6.27 0v3.027h5.19v-3.027h-5.19zm6.27 0v3.027H24v-3.027h-5.19zM0 16.81v3.029h5.19v-3.03H0zm6.27 0v3.029h5.189v-3.03h-5.19zm6.27 0v3.029h5.19v-3.03h-5.19zm6.27 0v3.029H24v-3.03h-5.19z" />
    </svg>
);

// Spotify icon component
const SpotifyIcon = ({ className }: { className?: string }) => (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor">
        <path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z"/>
    </svg>
);

// YouTube Music icon component
const YouTubeMusicIcon = ({ className }: { className?: string }) => (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor">
        <path d="M12 0C5.376 0 0 5.376 0 12s5.376 12 12 12 12-5.376 12-12S18.624 0 12 0zm0 19.104c-3.924 0-7.104-3.18-7.104-7.104S8.076 4.896 12 4.896s7.104 3.18 7.104 7.104-3.18 7.104-7.104 7.104zm0-13.332c-3.432 0-6.228 2.796-6.228 6.228S8.568 18.228 12 18.228 18.228 15.432 18.228 12 15.432 5.772 12 5.772zM9.684 15.54V8.46L16.2 12l-6.516 3.54z" />
    </svg>
);

// Types for browse playlist (normalized format from backend)
interface BrowseTrack {
    id: string;              // deezerId or spotifyId (normalized by backend)
    title: string;
    artist: string;
    artistId: string;
    album: string;
    albumId: string;
    durationMs: number;
    previewUrl: string | null;
    coverUrl: string | null;
    isrc?: string | null;    // Spotify provides ISRC
}

interface BrowsePlaylistFull {
    id: string;
    title: string;
    description: string | null;
    creator: string;
    imageUrl: string | null;
    trackCount: number;
    tracks: BrowseTrack[];
    isPublic: boolean;
    source: "deezer" | "spotify" | "youtube";
    url: string;
}

// Convert browse track to main player Track format
const convertToTrack = (track: BrowseTrack, source: "deezer" | "spotify" | "youtube"): Track => ({
    id: `${source}-${track.id}`,
    title: track.title,
    artist: { name: track.artist },
    album: {
        title: track.album,
        coverArt: track.coverUrl || undefined,
    },
    duration: Math.round(track.durationMs / 1000),
    // No filePath = HowlerAudioElement will use YouTube fallback
});

export default function BrowsePlaylistDetailPage() {
    const params = useParams();
    const router = useRouter();
    const searchParams = useSearchParams();
    const { toast } = useToast();
    const playlistId = params.id as string;
    const source = (searchParams.get("source") as "deezer" | "spotify" | "youtube") || "deezer";

    // Main player hooks
    const { playTracks, currentTrack, isPlaying, pause, resume } = useAudio();

    // State
    const [playlist, setPlaylist] = useState<BrowsePlaylistFull | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [isImporting, setIsImporting] = useState(false);
    const [isSaving, setIsSaving] = useState(false);

    // Fetch playlist data - route based on source
    useEffect(() => {
        async function fetchPlaylist() {
            setIsLoading(true);
            setError(null);
            try {
                // Use source-specific endpoint
                const endpoint = source === "spotify"
                    ? `/browse/spotify/playlists/${playlistId}`
                    : source === "youtube"
                    ? `/browse/youtube/playlists/${playlistId}`
                    : `/browse/playlists/${playlistId}`;

                const data = await api.get<BrowsePlaylistFull>(endpoint);
                setPlaylist(data);

                // Pre-fetch YouTube matches for first 20 tracks to speed up playback
                // Skip for YouTube source - tracks already have videoIds
                if (source !== "youtube" && data.tracks && data.tracks.length > 0) {
                    const tracksToPreFetch = data.tracks.slice(0, 20).map((t) => ({
                        artist: t.artist,
                        title: t.title,
                        duration: Math.round(t.durationMs / 1000),
                        album: t.album,
                    }));
                    api.prefetchYouTubeMatches(tracksToPreFetch);
                }
            } catch (err) {
                const message =
                    err instanceof Error
                        ? err.message
                        : "Failed to load playlist";
                setError(message);
            } finally {
                setIsLoading(false);
            }
        }

        fetchPlaylist();
    }, [playlistId, source]);

    // Handle track play - uses main player system
    const handlePlay = (track: BrowseTrack, index: number) => {
        if (!playlist) return;

        const trackId = `${playlist.source}-${track.id}`;

        // If clicking currently playing track, toggle play/pause
        if (currentTrack?.id === trackId) {
            if (isPlaying) { pause(); } else { resume(); }
            return;
        }

        // Play all tracks starting from this index
        const tracks = playlist.tracks.map(t => convertToTrack(t, playlist.source));
        playTracks(tracks, index);
    };

    // Handle import/download - goes to full import wizard
    const handleImport = () => {
        if (!playlist || isImporting) return;
        setIsImporting(true);
        router.push(
            `/import/spotify?url=${encodeURIComponent(playlist.url)}`
        );
    };

    // Handle save only (no download) - creates playlist with pending tracks
    const handleSaveOnly = async () => {
        if (!playlist || isSaving) return;
        setIsSaving(true);
        try {
            // First get preview data
            const preview = await api.post<{ tracks: unknown[] }>("/spotify/preview", { url: playlist.url });
            
            // Then start import with skipDownload=true
            await api.post<{ jobId: string; status: string }>(
                "/spotify/import",
                {
                    spotifyPlaylistId: playlist.id,
                    url: playlist.url,
                    playlistName: playlist.title,
                    preview,
                    skipDownload: true,
                }
            );

            toast.success(`Playlist "${playlist.title}" saved to library`);
            
            // Navigate to playlists page after short delay
            setTimeout(() => {
                router.push("/playlists");
            }, 500);
        } catch (err) {
            const message = err instanceof Error ? err.message : "Failed to save playlist";
            toast.error(message);
            setIsSaving(false);
        }
    };

    // Format duration
    const formatDuration = (ms: number) => {
        const minutes = Math.floor(ms / 60000);
        const seconds = Math.floor((ms % 60000) / 1000);
        return `${minutes}:${seconds.toString().padStart(2, "0")}`;
    };

    // Calculate total duration
    const totalDuration =
        playlist?.tracks.reduce((sum, track) => sum + track.durationMs, 0) || 0;

    const formatTotalDuration = (ms: number) => {
        const hours = Math.floor(ms / 3600000);
        const mins = Math.floor((ms % 3600000) / 60000);
        if (hours > 0) {
            return `about ${hours} hr ${mins} min`;
        }
        return `${mins} min`;
    };

    // Check if a track is currently playing from this playlist
    const isTrackPlaying = (track: BrowseTrack) => {
        return currentTrack?.id === `${playlist?.source || source}-${track.id}`;
    };

    if (isLoading) {
        return (
            <div className="flex items-center justify-center min-h-screen">
                <GradientSpinner size="md" />
            </div>
        );
    }

    if (error || !playlist) {
        return (
            <div className="min-h-screen relative">
                <div className="absolute inset-0 pointer-events-none">
                    <div
                        className="absolute inset-0 bg-gradient-to-b from-[#EF4444]/15 via-red-900/10 to-transparent"
                        style={{ height: "35vh" }}
                    />
                </div>
                <div className="relative px-4 md:px-8 py-6">
                    <button
                        onClick={() => router.back()}
                        className="flex items-center gap-2 text-gray-400 hover:text-white transition-colors mb-8"
                    >
                        <ArrowLeft className="w-5 h-5" />
                        Back
                    </button>
                    <div className="flex flex-col items-center justify-center py-20 text-center">
                        <div className="w-16 h-16 rounded-full bg-white/5 flex items-center justify-center mb-4">
                            <Music2 className="w-8 h-8 text-gray-500" />
                        </div>
                        <h3 className="text-lg font-medium text-white mb-2">
                            Playlist not found
                        </h3>
                        <p className="text-sm text-gray-400 mb-6 max-w-sm">
                            {error ||
                                "This playlist may be private or no longer available."}
                        </p>
                        <button
                            onClick={() => router.push("/browse/playlists")}
                            className="px-6 py-2.5 rounded-full bg-white text-black text-sm font-medium hover:scale-105 transition-transform"
                        >
                            Browse playlists
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="min-h-screen">
            {/* Hero Section */}
            <div className="relative bg-gradient-to-b from-brand/20 via-[#1a1a1a] to-transparent pt-16 pb-10 px-4 md:px-8">
                <div className="flex items-end gap-6">
                    {/* Cover Art */}
                    <div className="relative w-[140px] h-[140px] md:w-[192px] md:h-[192px] bg-[#282828] rounded shadow-2xl shrink-0 overflow-hidden">
                        {playlist.imageUrl ? (
                            <Image
                                src={playlist.imageUrl}
                                alt={playlist.title}
                                fill
                                unoptimized
                                className="object-cover"
                            />
                        ) : (
                            <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-brand/30 to-brand/10">
                                <Music2 className="w-16 h-16 text-gray-600" />
                            </div>
                        )}
                    </div>

                    {/* Playlist Info */}
                    <div className="flex-1 min-w-0 pb-1">
                        <div className="flex items-center gap-2 mb-1">
                            {playlist.source === "spotify" ? (
                                <SpotifyIcon className="w-4 h-4 text-spotify" />
                            ) : playlist.source === "youtube" ? (
                                <YouTubeMusicIcon className="w-4 h-4 text-[#FF0000]" />
                            ) : (
                                <DeezerIcon className="w-4 h-4 text-[#EF4444]" />
                            )}
                            <p className="text-xs font-medium text-white/90">
                                {playlist.source === "spotify" ? "Spotify" : playlist.source === "youtube" ? "YouTube Music" : "Deezer"} Playlist
                            </p>
                        </div>
                        <h1 className="text-2xl md:text-4xl lg:text-5xl font-bold text-white leading-tight line-clamp-2 mb-2">
                            {playlist.title}
                        </h1>
                        {playlist.description && (
                            <p className="text-sm text-gray-400 line-clamp-2 mb-2">
                                {playlist.description}
                            </p>
                        )}
                        <div className="flex items-center gap-1 text-sm text-white/70">
                            <span className="font-medium text-white">
                                {playlist.creator}
                            </span>
                            <span className="mx-1">•</span>
                            <span>{playlist.trackCount} songs</span>
                            {totalDuration > 0 && (
                                <>
                                    <span>
                                        , {formatTotalDuration(totalDuration)}
                                    </span>
                                </>
                            )}
                        </div>
                    </div>
                </div>
            </div>

            {/* Action Bar */}
            <div className="bg-gradient-to-b from-[#1a1a1a]/60 to-transparent px-4 md:px-8 py-4">
                <div className="flex items-center gap-3">
                    {/* Play All Button */}
                    <button
                        onClick={() =>
                            playlist.tracks.length > 0 &&
                            handlePlay(playlist.tracks[0], 0)
                        }
                        disabled={playlist.tracks.length === 0}
                        className="w-10 h-10 rounded-full bg-brand hover:bg-brand-hover hover:scale-105 flex items-center justify-center shadow-lg transition-all disabled:opacity-50 disabled:hover:scale-100"
                    >
                        <Play className="w-4 h-4 text-black ml-0.5" fill="black" />
                    </button>

                    {/* Save to Library Button (no download) */}
                    <button
                        onClick={handleSaveOnly}
                        disabled={isSaving || isImporting}
                        className="flex items-center gap-2 px-4 py-2 rounded-full bg-white/10 hover:bg-white/20 text-white text-sm font-medium transition-colors disabled:opacity-50"
                    >
                        {isSaving ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                            <Plus className="w-4 h-4" />
                        )}
                        <span className="hidden sm:inline">
                            {isSaving ? "Saving..." : "Save to Library"}
                        </span>
                    </button>

                    {/* Save & Download Button */}
                    <button
                        onClick={handleImport}
                        disabled={isImporting || isSaving}
                        className="flex items-center gap-2 px-4 py-2 rounded-full bg-brand hover:bg-brand-hover text-black text-sm font-medium transition-colors disabled:opacity-50"
                    >
                        {isImporting ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                            <Download className="w-4 h-4" />
                        )}
                        <span className="hidden sm:inline">
                            {isImporting ? "Importing..." : "Save & Download"}
                        </span>
                    </button>

                    {/* Spacer */}
                    <div className="flex-1" />

                    {/* Open in source */}
                    <a
                        href={playlist.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-2 px-4 py-2 rounded-full bg-white/10 hover:bg-white/20 text-white text-sm font-medium transition-colors"
                    >
                        <ExternalLink className="w-4 h-4" />
                        <span className="hidden sm:inline">
                            Open in {playlist.source === "spotify" ? "Spotify" : playlist.source === "youtube" ? "YouTube Music" : "Deezer"}
                        </span>
                    </a>
                </div>
            </div>

            {/* Track Listing */}
            <div className="px-4 md:px-8 pb-32">
                {playlist.tracks.length > 0 ? (
                    <div className="w-full">
                        {/* Table Header */}
                        <div className="hidden md:grid grid-cols-[40px_minmax(200px,4fr)_minmax(100px,1fr)_80px] gap-4 px-4 py-2 text-xs text-gray-400 uppercase tracking-wider border-b border-white/10 mb-2">
                            <span className="text-center">#</span>
                            <span>Title</span>
                            <span>Album</span>
                            <span className="text-right">Duration</span>
                        </div>

                        {/* Track Rows */}
                        <div>
                            {playlist.tracks.map((track, index) => {
                                const isCurrentlyPlaying = isTrackPlaying(track);
                                const isThisTrackPlaying = isCurrentlyPlaying && isPlaying;

                                return (
                                    <div
                                        key={track.id}
                                        onClick={() => {
                                            if (isThisTrackPlaying) {
                                                pause();
                                            } else {
                                                handlePlay(track, index);
                                            }
                                        }}
                                        className={cn(
                                            "grid grid-cols-[40px_1fr_auto] md:grid-cols-[40px_minmax(200px,4fr)_minmax(100px,1fr)_80px] gap-4 px-4 py-2 rounded-md transition-colors group",
                                            "hover:bg-white/5 cursor-pointer",
                                            isCurrentlyPlaying && "bg-white/10"
                                        )}
                                    >
                                        {/* Track Number / Play or Pause Icon */}
                                        <div className="flex items-center justify-center">
                                            <span
                                                className={cn(
                                                    "text-sm group-hover:hidden",
                                                    isCurrentlyPlaying
                                                        ? "text-[#EF4444]"
                                                        : "text-gray-400"
                                                )}
                                            >
                                                {isThisTrackPlaying ? (
                                                    <Pause className="w-4 h-4 text-[#EF4444]" />
                                                ) : (
                                                    index + 1
                                                )}
                                            </span>
                                            {isThisTrackPlaying ? (
                                                <Pause className="w-4 h-4 text-white hidden group-hover:block" />
                                            ) : (
                                                <Play className="w-4 h-4 text-white hidden group-hover:block" />
                                            )}
                                        </div>

                                        {/* Title + Artist */}
                                        <div className="flex items-center gap-3 min-w-0">
                                            <div className="relative w-10 h-10 bg-[#282828] rounded shrink-0 overflow-hidden">
                                                {track.coverUrl ? (
                                                    <Image
                                                        src={track.coverUrl}
                                                        alt={track.title}
                                                        fill
                                                        unoptimized
                                                        className="object-cover"
                                                    />
                                                ) : (
                                                    <div className="w-full h-full flex items-center justify-center">
                                                        <Music2 className="w-5 h-5 text-gray-600" />
                                                    </div>
                                                )}
                                            </div>
                                            <div className="min-w-0">
                                                <p
                                                    className={cn(
                                                        "text-sm font-medium truncate",
                                                        isCurrentlyPlaying
                                                            ? "text-[#EF4444]"
                                                            : "text-white"
                                                    )}
                                                >
                                                    {track.title}
                                                </p>
                                                <p className="text-xs text-gray-400 truncate">
                                                    {track.artist}
                                                </p>
                                            </div>
                                        </div>

                                        {/* Album (hidden on mobile) */}
                                        <p className="hidden md:flex items-center text-sm text-gray-400 truncate">
                                            {track.album || "\u2014"}
                                        </p>

                                        {/* Duration */}
                                        <div className="flex items-center justify-end">
                                            <span className="text-sm text-gray-400">
                                                {formatDuration(track.durationMs)}
                                            </span>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                ) : (
                    <div className="flex flex-col items-center justify-center py-24 text-center">
                        <div className="w-20 h-20 bg-[#282828] rounded-full flex items-center justify-center mb-4">
                            <Music2 className="w-10 h-10 text-gray-500" />
                        </div>
                        <h3 className="text-lg font-medium text-white mb-1">
                            No tracks found
                        </h3>
                        <p className="text-sm text-gray-500">
                            This playlist appears to be empty
                        </p>
                    </div>
                )}
            </div>
        </div>
    );
}
