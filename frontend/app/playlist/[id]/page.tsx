"use client";

import { useState, useMemo, useRef, useEffect, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import Image from "next/image";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { api } from "@/lib/api";
import { useAudio } from "@/lib/audio-context";
import { cn } from "@/utils/cn";
import { usePlaylistQuery } from "@/hooks/useQueries";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/lib/toast-context";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import {
    Play,
    Pause,
    Trash2,
    Shuffle,
    ListPlus,
    ListMusic,
    Music,
    AlertCircle,
    AlertTriangle,
    X,
    Loader2,
    Download,
} from "lucide-react";

interface Track {
    id: string;
    title: string;
    duration: number;
    filePath?: string;
    fileSize?: number;
    mime?: string | null;
    album: {
        id?: string;
        title: string;
        coverArt?: string;
        artist: {
            id?: string;
            name: string;
        };
    };
}

interface PlaylistItem {
    id: string;
    track: Track;
    type?: "track";
    sort?: number;
}

interface PendingTrack {
    id: string;
    type: "pending";
    sort: number;
    pending: {
        id: string;
        artist: string;
        title: string;
        album: string;
        previewUrl: string | null;
        duration: number | null;
        albumArt: string | null;
    };
}

export default function PlaylistDetailPage() {
    const params = useParams();
    const router = useRouter();
    const queryClient = useQueryClient();
    const { toast } = useToast();
    const { playTracks, addToQueue, currentTrack, isPlaying, pause, resume, next } =
        useAudio();
    const playlistId = params.id as string;

    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
    const [playingPreviewId, setPlayingPreviewId] = useState<string | null>(
        null
    );
    const [retryingTrackId, setRetryingTrackId] = useState<string | null>(null);
    const [isRetryingMissing, setIsRetryingMissing] = useState(false);
    const previewAudioRef = useRef<HTMLAudioElement | null>(null);

    // Track removal dialog state
    const [removeTrackDialog, setRemoveTrackDialog] = useState<{
        trackId: string;
        trackTitle: string;
        artistName: string;
        otherPlaylistCount: number | null; // null = loading
        deleteFromFilesystem: boolean;
    } | null>(null);

    // Pending deletions for pending tracks (undo toast pattern — no file on disk)
    const pendingDeletionsRef = useRef<
        Map<string, { type: "pending"; timeoutId: NodeJS.Timeout }>
    >(new Map());

    // Clean up preview audio AND flush pending deletions on unmount
    useEffect(() => {
        const pendingDeletions = pendingDeletionsRef.current;
        return () => {
            if (previewAudioRef.current) {
                previewAudioRef.current.pause();
                previewAudioRef.current = null;
            }
            // Fire any pending (undo-window) deletions immediately on unmount
            pendingDeletions.forEach((entry, id) => {
                clearTimeout(entry.timeoutId);
                api.removePendingTrack(playlistId, id).catch(() => {});
            });
            pendingDeletions.clear();
        };
    }, [playlistId]);

    // Handle Deezer preview playback
    const _handlePlayPreview = async (pendingId: string) => {
        // If already playing this preview, stop it
        if (playingPreviewId === pendingId && previewAudioRef.current) {
            previewAudioRef.current.pause();
            setPlayingPreviewId(null);
            return;
        }

        // Stop any currently playing preview
        if (previewAudioRef.current) {
            previewAudioRef.current.pause();
        }

        // Show loading state
        setPlayingPreviewId(pendingId);

        try {
            // Always fetch a fresh preview URL since Deezer URLs expire quickly
            const result = await api.getFreshPreviewUrl(playlistId, pendingId);
            const previewUrl = result.previewUrl;

            // Create and play new audio
            const audio = new Audio(previewUrl);
            audio.volume = 0.5;
            audio.onended = () => setPlayingPreviewId(null);
            audio.onerror = (e) => {
                console.error("Deezer preview playback failed:", e);
                setPlayingPreviewId(null);
                toast.error("Preview playback failed");
            };
            previewAudioRef.current = audio;

            await audio.play();
        } catch (err) {
            console.error("Failed to play Deezer preview:", err);
            setPlayingPreviewId(null);
            toast.error("No preview available");
        }
    };

    // Handle retry download for pending track
    const handleRetryPendingTrack = async (pendingId: string) => {
        setRetryingTrackId(pendingId);
        try {
            const result = await api.retryPendingTrack(playlistId, pendingId);
            if (result.success) {
                // Use the activity sidebar (Active tab) instead of a toast/modal
                window.dispatchEvent(
                    new CustomEvent("set-activity-panel-tab", {
                        detail: { tab: "active" },
                    })
                );
                window.dispatchEvent(new CustomEvent("open-activity-panel"));
                // If the backend emits a scan/download notification, refresh it
                window.dispatchEvent(new CustomEvent("notifications-changed"));
                // Refresh playlist data after a delay to allow download + scan to complete
                setTimeout(() => {
                    queryClient.invalidateQueries({
                        queryKey: ["playlist", playlistId],
                    });
                }, 10000); // 10 seconds for download + scan
            } else {
                toast.error(result.message || "Track not found on Soulseek");
            }
        } catch (error) {
            console.error("Failed to retry download:", error);
            toast.error("Failed to retry download");
        } finally {
            setRetryingTrackId(null);
        }
    };

    const handleRetryMissingTracks = async () => {
        if (!playlistId) return;
        setIsRetryingMissing(true);
        try {
            const result = await api.retryAllPendingTracks(playlistId);
            if (result.success) {
                window.dispatchEvent(
                    new CustomEvent("set-activity-panel-tab", {
                        detail: { tab: "active" },
                    })
                );
                window.dispatchEvent(new CustomEvent("open-activity-panel"));
                window.dispatchEvent(new CustomEvent("notifications-changed"));

                // Refresh after a delay to allow downloads + scan to progress
                setTimeout(() => {
                    queryClient.invalidateQueries({
                        queryKey: ["playlist", playlistId],
                    });
                }, 20000);

                toast.success(result.message || "Retry started");
            } else {
                toast.error(result.message || "Retry failed");
            }
        } catch (error) {
            console.error("Failed to retry missing tracks:", error);
            toast.error("Failed to retry missing tracks");
        } finally {
            // Hide while in progress; show again after a short cooldown if still pending
            setTimeout(() => setIsRetryingMissing(false), 60000);
        }
    };

    // Handle remove pending track (optimistic with undo)
    const handleRemovePendingTrack = useCallback((pendingId: string) => {
        // Snapshot current cache data for rollback
        const queryKey = ["playlist", playlistId];
        const previousData = queryClient.getQueryData(queryKey);

        // Optimistically remove from cache (pendingTracks + mergedItems)
        queryClient.setQueryData(queryKey, (old: Record<string, unknown> | undefined) => {
            if (!old) return old;
            const pendingTracks = old.pendingTracks as Array<{ id: string }> | undefined;
            const mergedItems = old.mergedItems as Array<{ type: string; pending?: { id: string } }> | undefined;
            return {
                ...old,
                pendingTracks: pendingTracks?.filter(
                    (pt) => pt.id !== pendingId
                ),
                mergedItems: mergedItems?.filter(
                    (item) =>
                        item.type !== "pending" || item.pending?.id !== pendingId
                ),
            };
        });

        const UNDO_DELAY = 5000;

        // Schedule the actual deletion
        const timeoutId = setTimeout(() => {
            pendingDeletionsRef.current.delete(pendingId);
            api.removePendingTrack(playlistId, pendingId).catch((error) => {
                console.error("Failed to remove pending track:", error);
                // Rollback on failure
                queryClient.setQueryData(queryKey, previousData);
                toast.error("Failed to remove track");
            });
        }, UNDO_DELAY);

        pendingDeletionsRef.current.set(pendingId, { type: "pending", timeoutId });

        toast.info("Track removed", {
            duration: UNDO_DELAY,
            action: {
                label: "Undo",
                onClick: () => {
                    // Cancel the deletion
                    const entry = pendingDeletionsRef.current.get(pendingId);
                    if (entry) {
                        clearTimeout(entry.timeoutId);
                        pendingDeletionsRef.current.delete(pendingId);
                    }
                    // Restore the cached data
                    queryClient.setQueryData(queryKey, previousData);
                },
            },
        });
    }, [playlistId, queryClient, toast]);

    // Use React Query hook for playlist
    const { data: playlist, isLoading } = usePlaylistQuery(playlistId);

    // Check if this is a shared playlist
    const isShared = playlist?.isOwner === false;

    // Calculate cover arts from playlist tracks for mosaic (memoized)
    const coverUrls = useMemo(() => {
        if (!playlist?.items || playlist.items.length === 0) return [];

        const tracksWithCovers = playlist.items.filter(
            (item: PlaylistItem) => item.track.album?.coverArt
        );
        if (tracksWithCovers.length === 0) return [];

        // Get unique cover arts (up to 4)
        const uniqueCovers = Array.from(
            new Set(tracksWithCovers.map((item) => item.track.album.coverArt))
        ).slice(0, 4);

        return uniqueCovers;
    }, [playlist]);

    // Open the remove-track confirmation dialog
    const handleRemoveTrack = useCallback((trackId: string, trackTitle: string, artistName: string) => {
        // Set dialog state with loading indicator for playlist count
        setRemoveTrackDialog({
            trackId,
            trackTitle,
            artistName,
            otherPlaylistCount: null,
            deleteFromFilesystem: false,
        });

        // Fetch how many other playlists contain this track
        api.getTrackPlaylistCount(trackId, playlistId).then((result) => {
            setRemoveTrackDialog((prev) =>
                prev && prev.trackId === trackId
                    ? { ...prev, otherPlaylistCount: result.count }
                    : prev
            );
        }).catch(() => {
            setRemoveTrackDialog((prev) =>
                prev && prev.trackId === trackId
                    ? { ...prev, otherPlaylistCount: 0 }
                    : prev
            );
        });
    }, [playlistId]);

    // Confirm track removal (and optionally delete from filesystem)
    const confirmRemoveTrack = useCallback(async () => {
        if (!removeTrackDialog) return;
        const { trackId, deleteFromFilesystem } = removeTrackDialog;
        setRemoveTrackDialog(null);

        // If currently playing this track, skip to next
        if (currentTrack?.id === trackId) {
            next();
        }

        try {
            if (deleteFromFilesystem) {
                // Delete from filesystem (cascade removes all PlaylistItem rows)
                await api.deleteTrack(trackId);
            } else {
                // Just remove from this playlist
                await api.removeTrackFromPlaylist(playlistId, trackId);
            }

            // Refresh playlist data
            queryClient.invalidateQueries({
                queryKey: ["playlist", playlistId],
            });
        } catch (error) {
            console.error("Failed to remove track:", error);
            toast.error("Failed to remove track");
        }
    }, [removeTrackDialog, playlistId, queryClient, toast, currentTrack, next]);

    const handleDeletePlaylist = async () => {
        try {
            await api.deletePlaylist(playlistId);

            // Dispatch event to update sidebar
            window.dispatchEvent(
                new CustomEvent("playlist-deleted", { detail: { playlistId } })
            );

            router.push("/playlists");
        } catch (error) {
            console.error("Failed to delete playlist:", error);
        }
    };

    // Check if this playlist is currently playing
    const playlistTrackIds = useMemo(() => {
        return new Set(
            playlist?.items?.map((item: PlaylistItem) => item.track.id) || []
        );
    }, [playlist?.items]);

    const isThisPlaylistPlaying = useMemo(() => {
        if (!isPlaying || !currentTrack || !playlist?.items?.length)
            return false;
        // Check if current track is in this playlist
        return playlistTrackIds.has(currentTrack.id);
    }, [isPlaying, currentTrack, playlistTrackIds, playlist?.items?.length]);

    // Calculate total duration - MUST be before early returns
    const totalDuration = useMemo(() => {
        if (!playlist?.items) return 0;
        return playlist.items.reduce(
            (sum: number, item: PlaylistItem) =>
                sum + (item.track.duration || 0),
            0
        );
    }, [playlist?.items]);

    const formatTotalDuration = (seconds: number) => {
        const hours = Math.floor(seconds / 3600);
        const mins = Math.floor((seconds % 3600) / 60);
        if (hours > 0) {
            return `about ${hours} hr ${mins} min`;
        }
        return `${mins} min`;
    };

    // Convert any item (local or pending) to playable track format
    const itemToPlayableTrack = (item: PlaylistItem | PendingTrack) => {
        if (item.type === "pending") {
            const pending = (item as PendingTrack).pending;
            return {
                id: `pending-${pending.id}`,
                title: pending.title,
                // No filePath = triggers YouTube Music fallback
                artist: { name: pending.artist },
                album: { 
                    title: pending.album,
                    coverArt: pending.albumArt, // Pass album art for miniplayer
                },
                duration: pending.duration || 0,
            };
        }
        const playlistItem = item as PlaylistItem;
        return {
            id: playlistItem.track.id,
            title: playlistItem.track.title,
            filePath: playlistItem.track.filePath,
            artist: {
                name: playlistItem.track.album.artist.name,
                id: playlistItem.track.album.artist.id,
            },
            album: {
                title: playlistItem.track.album.title,
                coverArt: playlistItem.track.album.coverArt,
                id: playlistItem.track.album.id,
            },
            duration: playlistItem.track.duration,
        };
    };

    // Get all tracks (local + pending) as playable format
    const getAllPlayableTracks = () => {
        const items = playlist?.mergedItems || playlist?.items || [];
        return items.map(itemToPlayableTrack);
    };

    const handlePlayPlaylist = () => {
        const allTracks = getAllPlayableTracks();
        if (allTracks.length === 0) return;

        // If this playlist is playing, toggle pause/resume
        if (isThisPlaylistPlaying) {
            if (isPlaying) {
                pause();
            } else {
                resume();
            }
            return;
        }

        playTracks(allTracks, 0);
    };

    const handlePlayTrack = (index: number) => {
        const allTracks = getAllPlayableTracks();
        if (allTracks.length === 0) return;
        playTracks(allTracks, index);
    };

    const handleAddToQueue = (track: Track) => {
        const formattedTrack = {
            id: track.id,
            title: track.title,
            filePath: track.filePath, // Include filePath to use local streaming
            artist: {
                name: track.album.artist.name,
                id: track.album.artist.id,
            },
            album: {
                title: track.album.title,
                coverArt: track.album.coverArt,
                id: track.album.id,
            },
            duration: track.duration,
        };
        addToQueue(formattedTrack);
    };

    const formatDuration = (seconds: number) => {
        const mins = Math.floor(seconds / 60);
        const secs = seconds % 60;
        return `${mins}:${secs.toString().padStart(2, "0")}`;
    };

    // Extract codec/format from mime type or file path
    const getCodecLabel = (mime?: string | null, filePath?: string): string | null => {
        if (mime) {
            const mimeMap: Record<string, string> = {
                "audio/flac": "FLAC",
                "audio/x-flac": "FLAC",
                flac: "FLAC",
                "audio/mpeg": "MP3",
                "audio/mp3": "MP3",
                "audio/aac": "AAC",
                "audio/mp4": "AAC",
                "audio/x-m4a": "AAC",
                "audio/ogg": "OGG",
                "audio/vorbis": "OGG",
                "audio/opus": "OPUS",
                "audio/wav": "WAV",
                "audio/x-wav": "WAV",
                "audio/alac": "ALAC",
                "audio/x-alac": "ALAC",
                "audio/aiff": "AIFF",
                "audio/x-aiff": "AIFF",
            };
            const normalized = mime.toLowerCase();
            if (mimeMap[normalized]) return mimeMap[normalized];
        }

        if (filePath) {
            const ext = filePath.split(".").pop()?.toLowerCase();
            const extMap: Record<string, string> = {
                flac: "FLAC",
                mp3: "MP3",
                aac: "AAC",
                m4a: "AAC",
                ogg: "OGG",
                opus: "OPUS",
                wav: "WAV",
                alac: "ALAC",
                aiff: "AIFF",
                aif: "AIFF",
                wma: "WMA",
            };
            if (ext && extMap[ext]) return extMap[ext];
        }

        return null;
    };

    const formatBitrate = (fileSize?: number, duration?: number): string | null => {
        if (!fileSize || !duration || duration === 0) return null;
        const bitrate = Math.round((fileSize * 8) / duration / 1000);
        return `${bitrate}`;
    };

    const isLossless = (codec: string | null): boolean => {
        if (!codec) return false;
        return ["FLAC", "ALAC", "WAV", "AIFF"].includes(codec);
    };

    if (isLoading) {
        return (
            <div className="flex items-center justify-center min-h-screen">
                <GradientSpinner size="md" />
            </div>
        );
    }

    if (!playlist) {
        return (
            <div className="flex items-center justify-center min-h-screen">
                <p className="text-gray-500">Playlist not found</p>
            </div>
        );
    }

    return (
        <div className="min-h-screen">
            {/* Compact Hero - Spotify Style */}
            <div className="relative bg-gradient-to-b from-[#3d2a1e] via-[#1a1a1a] to-transparent pt-16 pb-10 px-4 md:px-8">
                <div className="flex items-end gap-6">
                    {/* Cover Art */}
                    <div className="w-[140px] h-[140px] md:w-[192px] md:h-[192px] bg-[#282828] rounded shadow-2xl shrink-0 overflow-hidden">
                        {coverUrls && coverUrls.length > 0 ? (
                            <div className="grid grid-cols-2 gap-0 w-full h-full">
                                {coverUrls
                                    .slice(0, 4)
                                    .map(
                                        (
                                            url: string | undefined,
                                            index: number
                                        ) => {
                                            if (!url) return null;
                                            const proxiedUrl =
                                                api.getCoverArtUrl(url, 200);
                                            return (
                                                <div
                                                    key={index}
                                                    className="relative bg-[#181818]"
                                                >
                                                    <Image
                                                        src={proxiedUrl}
                                                        alt=""
                                                        fill
                                                        className="object-cover"
                                                        sizes="96px"
                                                        unoptimized
                                                    />
                                                </div>
                                            );
                                        }
                                    )}
                                {Array.from({
                                    length: Math.max(
                                        0,
                                        4 - (coverUrls?.length || 0)
                                    ),
                                }).map((_, index) => (
                                    <div
                                        key={`empty-${index}`}
                                        className="relative bg-[#282828]"
                                    />
                                ))}
                            </div>
                        ) : (
                            <div className="w-full h-full bg-[#282828]" />
                        )}
                    </div>

                    {/* Playlist Info - Bottom Aligned */}
                    <div className="flex-1 min-w-0 pb-1">
                        <p className="text-xs font-medium text-white/90 mb-1">
                            {isShared ? "Public Playlist" : "Playlist"}
                        </p>
                        <h1 className="text-2xl md:text-4xl lg:text-5xl font-bold text-white leading-tight line-clamp-2 mb-2">
                            {playlist.name}
                        </h1>
                        <div className="flex items-center gap-1 text-sm text-white/70">
                            {isShared && playlist.user?.username && (
                                <>
                                    <span className="font-medium text-white">
                                        {playlist.user.username}
                                    </span>
                                    <span className="mx-1">•</span>
                                </>
                            )}
                            <span>{(playlist.items?.length || 0) + (playlist.pendingCount || 0)} songs</span>
                            {totalDuration > 0 && (
                                <>
                                    <span>
                                        , {formatTotalDuration(totalDuration)}
                                    </span>
                                </>
                            )}
                        </div>
                        {/* Show "X of Y available locally" only when there are streaming tracks */}
                        {playlist.pendingCount > 0 && (
                            <p className="text-xs text-gray-500 mt-1">
                                {playlist.items?.length || 0} of {(playlist.items?.length || 0) + playlist.pendingCount} songs available locally
                            </p>
                        )}
                    </div>
                </div>
            </div>

            {/* Action Bar */}
            <div className="bg-gradient-to-b from-[#1a1a1a]/60 to-transparent px-4 md:px-8 py-4">
                <div className="flex items-center gap-4">
                    {/* Play Button */}
                    {playlist.items && playlist.items.length > 0 && (
                        <button
                            onClick={handlePlayPlaylist}
                            className="h-12 w-12 rounded-full bg-brand hover:bg-brand-hover hover:scale-105 flex items-center justify-center shadow-lg transition-all"
                        >
                            {isThisPlaylistPlaying && isPlaying ? (
                                <Pause className="w-5 h-5 fill-current text-black" />
                            ) : (
                                <Play className="w-5 h-5 fill-current text-black ml-0.5" />
                            )}
                        </button>
                    )}

                    {/* Shuffle Button */}
                    {((playlist.items?.length || 0) + (playlist.pendingCount || 0)) > 1 && (
                        <button
                            onClick={() => {
                                const allTracks = getAllPlayableTracks();
                                if (allTracks.length === 0) return;
                                // Shuffle the tracks
                                const shuffled = [...allTracks].sort(
                                    () => Math.random() - 0.5
                                );
                                playTracks(shuffled, 0);
                            }}
                            className="h-8 w-8 rounded-full hover:bg-white/10 flex items-center justify-center text-white/60 hover:text-white transition-all"
                            title="Shuffle play"
                        >
                            <Shuffle className="w-5 h-5" />
                        </button>
                    )}

                    {/* Spacer */}
                    <div className="flex-1" />

                    {/* Delete Button */}
                    {playlist.isOwner && (
                        <button
                            onClick={() => setShowDeleteConfirm(true)}
                            className="h-8 w-8 rounded-full flex items-center justify-center text-white/40 hover:text-red-400 transition-all"
                            title="Delete Playlist"
                        >
                            <Trash2 className="w-5 h-5" />
                        </button>
                    )}
                </div>
            </div>

            {/* Track Listing */}
            <div className="px-4 md:px-8 pb-32">
                {/* Show pending count banner if any */}
                {playlist.pendingCount > 0 && (
                    <div className="mb-4 px-4 py-2 bg-red-900/20 border border-red-500/30 rounded-lg flex items-center justify-between gap-3">
                        <div className="flex items-center gap-2">
                            <AlertCircle className="w-4 h-4 text-red-400" />
                            <span className="text-sm text-red-200">
                                {playlist.pendingCount} track
                                {playlist.pendingCount !== 1 ? "s" : ""} not downloaded yet.
                            </span>
                        </div>

                        {playlist.isOwner && !isRetryingMissing && (
                            <button
                                onClick={handleRetryMissingTracks}
                                className="shrink-0 px-3 py-1.5 rounded-full text-xs font-medium bg-red-500/20 text-red-200 border border-red-500/30 hover:bg-red-500/30 transition-colors"
                                title="Retry downloading missing tracks"
                            >
                                Retry all
                            </button>
                        )}
                    </div>
                )}

                {playlist.items?.length > 0 ||
                playlist.pendingTracks?.length > 0 ? (
                    <div className="w-full">
                        {/* Table Header */}
                        <div className="hidden md:grid grid-cols-[40px_minmax(200px,3fr)_minmax(100px,1fr)_70px_110px] gap-4 px-4 py-2 text-xs text-gray-400 uppercase tracking-wider border-b border-white/10 mb-2">
                            <span className="text-center">#</span>
                            <span>Title</span>
                            <span>Album</span>
                            <span className="text-right">Format</span>
                            <span className="text-right">Duration</span>
                        </div>

                        {/* Track Rows - use mergedItems to show tracks and pending in correct order */}
                        <div>
                            {(playlist.mergedItems || playlist.items || []).map(
                                (
                                    item: PlaylistItem | PendingTrack,
                                    index: number
                                ) => {
                                    // Handle streaming (pending) tracks - same design as local tracks
                                    if (item.type === "pending") {
                                        const pending = (item as PendingTrack).pending;
                                        const pendingTrackId = `pending-${pending.id}`;
                                        const isCurrentlyPlaying = currentTrack?.id === pendingTrackId;
                                        const isActuallyPlaying = isCurrentlyPlaying && isPlaying;
                                        const isRetrying = retryingTrackId === pending.id;
                                        // removal is now optimistic – no loading state needed

                                        return (
                                            <div
                                                key={`pending-${pending.id}`}
                                                onClick={() => {
                                                    if (isActuallyPlaying) {
                                                        pause();
                                                    } else {
                                                        handlePlayTrack(index);
                                                    }
                                                }}
                                                className={cn(
                                                    "grid grid-cols-[40px_1fr_auto] md:grid-cols-[40px_minmax(200px,3fr)_minmax(100px,1fr)_70px_110px] gap-4 px-4 py-2 rounded-md hover:bg-white/5 transition-colors group cursor-pointer",
                                                    isCurrentlyPlaying && "bg-white/10"
                                                )}
                                            >
                                                {/* Track Number / Play or Pause Icon */}
                                                {/* Track Number / Play or Pause Icon - RED for YouTube streaming */}
                                                <div className="flex items-center justify-center">
                                                    <span
                                                        className={cn(
                                                            "text-sm group-hover:hidden",
                                                            isCurrentlyPlaying
                                                                ? "text-red-500"
                                                                : "text-gray-400"
                                                        )}
                                                    >
                                                        {isActuallyPlaying ? (
                                                            <Music className="w-4 h-4 text-red-500 animate-pulse" />
                                                        ) : (
                                                            index + 1
                                                        )}
                                                    </span>
                                                    {isActuallyPlaying ? (
                                                        <Pause className="w-4 h-4 text-white hidden group-hover:block" />
                                                    ) : (
                                                        <Play className="w-4 h-4 text-white hidden group-hover:block" />
                                                    )}
                                                </div>

                                                {/* Title + Artist - RED for YouTube streaming */}
                                                <div className="flex items-center gap-3 min-w-0">
                                                    <div className="relative w-10 h-10 bg-[#282828] rounded shrink-0 overflow-hidden flex items-center justify-center">
                                                        {pending.albumArt ? (
                                                            <Image
                                                                src={pending.albumArt}
                                                                alt={pending.title}
                                                                fill
                                                                unoptimized
                                                                className="object-cover"
                                                            />
                                                        ) : (
                                                            <Music className="w-5 h-5 text-gray-600" />
                                                        )}
                                                    </div>
                                                    <div className="min-w-0">
                                                        <p
                                                            className={cn(
                                                                "text-sm font-medium truncate",
                                                                isCurrentlyPlaying
                                                                    ? "text-red-500"
                                                                    : "text-white"
                                                            )}
                                                        >
                                                            {pending.title}
                                                        </p>
                                                        <p className="text-xs text-gray-400 truncate">
                                                            {pending.artist}
                                                        </p>
                                                    </div>
                                                </div>

                                                {/* Album (hidden on mobile) */}
                                                <p className="hidden md:flex items-center text-sm text-gray-400 truncate">
                                                    {pending.album}
                                                </p>

                                                {/* YT Badge for streaming tracks */}
                                                <div className="hidden md:flex items-center justify-end">
                                                    <span
                                                        className="flex-shrink-0 px-1 py-0.5 text-[9px] font-semibold rounded bg-red-600/80 text-white leading-none"
                                                        title="Streaming from YouTube Music"
                                                    >
                                                        YT
                                                    </span>
                                                </div>

                                                {/* Duration + Actions */}
                                                <div className="flex items-center justify-end gap-2">
                                                    {/* Download button */}
                                                    <button
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            handleRetryPendingTrack(pending.id);
                                                        }}
                                                        disabled={isRetrying}
                                                        className={cn(
                                                            "p-1.5 rounded-full opacity-0 group-hover:opacity-100 hover:bg-white/10 transition-all",
                                                            isRetrying
                                                                ? "text-brand opacity-100"
                                                                : "text-gray-400 hover:text-white"
                                                        )}
                                                        title="Download track"
                                                    >
                                                        {isRetrying ? (
                                                            <Loader2 className="w-4 h-4 animate-spin" />
                                                        ) : (
                                                            <Download className="w-4 h-4" />
                                                        )}
                                                    </button>

                                                     {/* Remove button */}
                                                    {playlist.isOwner && (
                                                        <button
                                                            onClick={(e) => {
                                                                e.stopPropagation();
                                                                handleRemovePendingTrack(pending.id);
                                                            }}
                                                            className="p-1.5 rounded-full opacity-0 group-hover:opacity-100 hover:bg-white/10 text-gray-400 hover:text-red-400 transition-all"
                                                            title="Remove from playlist"
                                                        >
                                                            <X className="w-4 h-4" />
                                                        </button>
                                                    )}

                                                    <span className="text-sm text-gray-400 w-12 text-right">
                                                        {pending.duration ? formatDuration(pending.duration) : "--:--"}
                                                    </span>
                                                </div>
                                            </div>
                                        );
                                    }

                                    // Handle regular tracks
                                    const playlistItem = item as PlaylistItem;
                                    const isCurrentlyPlaying =
                                        currentTrack?.id ===
                                        playlistItem.track.id;
                                    const isActuallyPlaying = isCurrentlyPlaying && isPlaying;
                                    // Track streams from YouTube if no local file
                                    const isYouTubeTrack = !playlistItem.track.filePath;

                                    return (
                                        <div
                                            key={playlistItem.id}
                                            onClick={() => {
                                                if (isActuallyPlaying) {
                                                    pause();
                                                } else {
                                                    handlePlayTrack(index);
                                                }
                                            }}
                                            className={cn(
                                                "grid grid-cols-[40px_1fr_auto] md:grid-cols-[40px_minmax(200px,3fr)_minmax(100px,1fr)_70px_110px] gap-4 px-4 py-2 rounded-md hover:bg-white/5 transition-colors group cursor-pointer",
                                                isCurrentlyPlaying &&
                                                    "bg-white/10"
                                            )}
                                        >
                                            {/* Track Number / Play or Pause Icon - RED for YouTube, YELLOW for local */}
                                            <div className="flex items-center justify-center">
                                                <span
                                                    className={cn(
                                                        "text-sm group-hover:hidden",
                                                        isCurrentlyPlaying
                                                            ? isYouTubeTrack ? "text-red-500" : "text-brand"
                                                            : "text-gray-400"
                                                    )}
                                                >
                                                    {isActuallyPlaying ? (
                                                        <Music className={cn("w-4 h-4 animate-pulse", isYouTubeTrack ? "text-red-500" : "text-brand")} />
                                                    ) : (
                                                        index + 1
                                                    )}
                                                </span>
                                                {isActuallyPlaying ? (
                                                    <Pause className="w-4 h-4 text-white hidden group-hover:block" />
                                                ) : (
                                                    <Play className="w-4 h-4 text-white hidden group-hover:block" />
                                                )}
                                            </div>

                                            {/* Title + Artist - RED for YouTube, YELLOW for local */}
                                            <div className="flex items-center gap-3 min-w-0">
                                                <div className="relative w-10 h-10 bg-[#282828] rounded shrink-0 overflow-hidden">
                                                    {playlistItem.track.album
                                                        ?.coverArt ? (
                                                        <Image
                                                            src={api.getCoverArtUrl(
                                                                playlistItem
                                                                    .track.album
                                                                    .coverArt,
                                                                100
                                                            )}
                                                            alt={
                                                                playlistItem
                                                                    .track.title
                                                            }
                                                            fill
                                                            unoptimized
                                                            className="object-cover"
                                                        />
                                                    ) : (
                                                        <div className="w-full h-full flex items-center justify-center">
                                                            <Music className="w-5 h-5 text-gray-600" />
                                                        </div>
                                                    )}
                                                </div>
                                                <div className="min-w-0">
                                                    <p
                                                        className={cn(
                                                            "text-sm font-medium truncate",
                                                            isCurrentlyPlaying
                                                                ? isYouTubeTrack ? "text-red-500" : "text-brand"
                                                                : "text-white"
                                                        )}
                                                    >
                                                        {
                                                            playlistItem
                                                                .track.title
                                                        }
                                                    </p>
                                                    <p className="text-xs text-gray-400 truncate">
                                                        {
                                                            playlistItem.track
                                                                .album.artist
                                                                .name
                                                        }
                                                    </p>
                                                </div>
                                            </div>

                                            {/* Album (hidden on mobile) */}
                                            <p className="hidden md:flex items-center text-sm text-gray-400 truncate">
                                                {playlistItem.track.album.title}
                                            </p>

                                            {/* Codec/Bitrate column OR YT badge (hidden on mobile) */}
                                            <div className="hidden md:flex items-center justify-end">
                                                {(() => {
                                                    // Show YT badge if no local file
                                                    if (isYouTubeTrack) {
                                                        return (
                                                            <span
                                                                className="flex-shrink-0 px-1 py-0.5 text-[9px] font-semibold rounded bg-red-600/80 text-white leading-none"
                                                                title="Will stream from YouTube Music"
                                                            >
                                                                YT
                                                            </span>
                                                        );
                                                    }
                                                    const codec = getCodecLabel(
                                                        playlistItem.track.mime,
                                                        playlistItem.track.filePath
                                                    );
                                                    const bitrate = formatBitrate(
                                                        playlistItem.track.fileSize,
                                                        playlistItem.track.duration
                                                    );
                                                    if (!codec && !bitrate) return null;
                                                    const lossless = isLossless(codec);
                                                    return (
                                                        <div
                                                            className={cn(
                                                                "flex shrink-0 items-center gap-1 text-[10px] px-1.5 py-0.5 rounded font-medium",
                                                                lossless
                                                                    ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/20"
                                                                    : "bg-gray-500/15 text-gray-400 border border-gray-500/20"
                                                            )}
                                                            title={`${codec || "Unknown"}${bitrate ? ` @ ${bitrate} kbps` : ""}`}
                                                        >
                                                            {codec && <span>{codec}</span>}
                                                            {bitrate && <span className="opacity-70">{bitrate}</span>}
                                                        </div>
                                                    );
                                                })()}
                                            </div>

                                            {/* Duration + Actions */}
                                            <div className="flex items-center justify-end gap-2">
                                                <button
                                                    className="p-1.5 rounded-full opacity-0 group-hover:opacity-100 hover:bg-white/10 text-gray-400 hover:text-white transition-all"
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        handleAddToQueue(
                                                            playlistItem.track
                                                        );
                                                    }}
                                                    title="Add to Queue"
                                                >
                                                    <ListPlus className="w-4 h-4" />
                                                </button>

                                                <span className="text-sm text-gray-400 w-12 text-right">
                                                    {formatDuration(
                                                        playlistItem.track
                                                            .duration
                                                    )}
                                                </span>
                                                {playlist.isOwner && (
                                                    <button
                                                        className="p-1.5 rounded-full opacity-0 group-hover:opacity-100 hover:bg-white/10 text-gray-400 hover:text-red-400 transition-all"
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            handleRemoveTrack(
                                                                playlistItem.track.id,
                                                                playlistItem.track.title,
                                                                playlistItem.track.album.artist.name
                                                            );
                                                        }}
                                                        title="Remove from Playlist"
                                                    >
                                                        <Trash2 className="w-4 h-4" />
                                                    </button>
                                                )}
                                            </div>
                                        </div>
                                    );
                                }
                            )}
                        </div>
                    </div>
                ) : (
                    <div className="flex flex-col items-center justify-center py-24 text-center">
                        <div className="w-20 h-20 bg-[#282828] rounded-full flex items-center justify-center mb-4">
                            <ListMusic className="w-10 h-10 text-gray-500" />
                        </div>
                        <h3 className="text-lg font-medium text-white mb-1">
                            No tracks yet
                        </h3>
                        <p className="text-sm text-gray-500">
                            Add some tracks to get started
                        </p>
                    </div>
                )}
            </div>

            {/* Remove Track Confirmation Dialog */}
            {removeTrackDialog && (
                <div
                    className="fixed inset-0 bg-black/75 flex items-center justify-center z-50 p-4"
                    onClick={() => setRemoveTrackDialog(null)}
                >
                    <div
                        className="bg-[#121212] rounded-xl max-w-md w-full overflow-hidden border border-white/10 shadow-2xl"
                        onClick={(e) => e.stopPropagation()}
                    >
                        {/* Header */}
                        <div className="flex items-start gap-4 p-6 border-b border-white/10">
                            <div className="w-12 h-12 rounded-full bg-red-500/10 flex items-center justify-center flex-shrink-0">
                                <AlertTriangle className="w-6 h-6 text-red-500" />
                            </div>
                            <div className="flex-1 min-w-0">
                                <h2 className="text-xl font-bold text-white mb-2">
                                    Remove Track?
                                </h2>
                                <p className="text-sm text-gray-400">
                                    Remove <span className="text-white font-medium">{removeTrackDialog.trackTitle}</span> by{" "}
                                    <span className="text-white font-medium">{removeTrackDialog.artistName}</span> from this playlist?
                                </p>
                            </div>
                            <button
                                onClick={() => setRemoveTrackDialog(null)}
                                className="p-1 hover:bg-white/10 rounded-full transition-colors text-gray-400 hover:text-white flex-shrink-0"
                            >
                                <X className="w-5 h-5" />
                            </button>
                        </div>

                        {/* Filesystem delete option */}
                        <div className="px-6 py-4 border-b border-white/10">
                            <label className="flex items-start gap-3 cursor-pointer group">
                                <input
                                    type="checkbox"
                                    checked={removeTrackDialog.deleteFromFilesystem}
                                    onChange={(e) =>
                                        setRemoveTrackDialog((prev) =>
                                            prev ? { ...prev, deleteFromFilesystem: e.target.checked } : prev
                                        )
                                    }
                                    className="mt-0.5 w-4 h-4 rounded border-white/20 bg-white/5 text-red-500 focus:ring-red-500/50 accent-red-500"
                                />
                                <div>
                                    <span className="text-sm text-white font-medium group-hover:text-red-400 transition-colors">
                                        Also delete from filesystem
                                    </span>
                                    <p className="text-xs text-gray-500 mt-0.5">
                                        Permanently removes the file from disk and all playlists
                                    </p>
                                    {removeTrackDialog.deleteFromFilesystem && removeTrackDialog.otherPlaylistCount === null && (
                                        <p className="text-xs text-gray-500 mt-1 flex items-center gap-1">
                                            <Loader2 className="w-3 h-3 animate-spin" />
                                            Checking other playlists...
                                        </p>
                                    )}
                                    {removeTrackDialog.deleteFromFilesystem && removeTrackDialog.otherPlaylistCount !== null && removeTrackDialog.otherPlaylistCount > 0 && (
                                        <p className="text-xs text-yellow-400 mt-1 flex items-center gap-1">
                                            <AlertCircle className="w-3 h-3" />
                                            This track is in {removeTrackDialog.otherPlaylistCount} other playlist{removeTrackDialog.otherPlaylistCount !== 1 ? "s" : ""}
                                        </p>
                                    )}
                                </div>
                            </label>
                        </div>

                        {/* Actions */}
                        <div className="flex gap-3 p-6 bg-[#0a0a0a]/50">
                            <button
                                onClick={() => setRemoveTrackDialog(null)}
                                className="flex-1 px-4 py-3 bg-white/5 hover:bg-white/10 text-white font-semibold rounded-lg transition-all border border-white/10"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={confirmRemoveTrack}
                                className={cn(
                                    "flex-1 px-4 py-3 font-semibold rounded-lg transition-all",
                                    removeTrackDialog.deleteFromFilesystem
                                        ? "bg-red-500 hover:bg-red-600 text-white"
                                        : "bg-brand hover:bg-brand/90 text-black"
                                )}
                            >
                                {removeTrackDialog.deleteFromFilesystem ? "Delete" : "Remove"}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Delete Playlist Confirm Dialog */}
            <ConfirmDialog
                isOpen={showDeleteConfirm}
                onClose={() => setShowDeleteConfirm(false)}
                onConfirm={handleDeletePlaylist}
                title="Delete Playlist?"
                message={`Are you sure you want to delete "${playlist.name}"? This action cannot be undone.`}
                confirmText="Delete"
                cancelText="Cancel"
                variant="danger"
            />
        </div>
    );
}
