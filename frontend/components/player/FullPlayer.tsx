"use client";

import { useAudioState } from "@/lib/audio-state-context";
import { useAudioPlayback } from "@/lib/audio-playback-context";
import { useRemoteAwareAudioControls } from "@/lib/remote-aware-audio-controls-context";
import { useRemotePlayback } from "@/lib/remote-playback-context";
import { api } from "@/lib/api";
import Image from "next/image";
import Link from "next/link";
import {
    Play,
    Pause,
    SkipBack,
    SkipForward,
    Volume2,
    VolumeX,
    Maximize2,
    Music as MusicIcon,
    Shuffle,
    Repeat,
    Repeat1,
    RotateCcw,
    RotateCw,
    Loader2,
    AudioWaveform,
    ChevronUp,
    ChevronDown,
    Cast,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { KeyboardShortcutsTooltip } from "./KeyboardShortcutsTooltip";
import { DeviceSelector } from "./DeviceSelector";
import { EnhancedVibeOverlay } from "./VibeOverlayEnhanced";
import { cn, isLocalUrl } from "@/utils/cn";
import { formatTime } from "@/utils/formatTime";

/**
 * FullPlayer - UI-only component for desktop bottom player
 * Does NOT manage audio element - that's handled by AudioElement component
 */
export function FullPlayer() {
    // Use split contexts to avoid re-rendering on every currentTime update
    const {
        currentTrack,
        currentAudiobook,
        currentPodcast,
        playbackType,
        volume,
        isMuted,
        isShuffle,
        repeatMode,
        playerMode,
        vibeMode,
        vibeSourceFeatures,
        queue,
        currentIndex,
    } = useAudioState();

    const {
        isPlaying,
        isBuffering,
        currentTime,
        duration: playbackDuration,
        canSeek,
        downloadProgress,
    } = useAudioPlayback();

    const {
        pause,
        resume,
        next,
        previous,
        setPlayerMode,
        seek,
        skipForward,
        skipBackward,
        setVolume,
        toggleMute,
        toggleShuffle,
        toggleRepeat,
        setUpcoming,
        startVibeMode,
        stopVibeMode,
        isActivePlayer,
        activePlayerState,
    } = useRemoteAwareAudioControls();

    // Get remote playback info for the indicator
    const { devices, activePlayerId } = useRemotePlayback();
    const activeDevice = devices.find(d => d.deviceId === activePlayerId);

    const [isVibeLoading, setIsVibeLoading] = useState(false);
    const [isVibePanelExpanded, setIsVibePanelExpanded] = useState(false);

    // Get current track's audio features for vibe comparison
    const currentTrackFeatures = queue[currentIndex]?.audioFeatures || null;

    // Handle Vibe Mode toggle - finds tracks that sound like the current track
    const handleVibeToggle = async () => {
        if (!currentTrack?.id) return;
        
        // If vibe mode is on, turn it off
        if (vibeMode) {
            stopVibeMode();
            toast.success("Vibe mode off");
            return;
        }
        
        // Otherwise, start vibe mode
        setIsVibeLoading(true);
        try {
            const response = await api.getRadioTracks("vibe", currentTrack.id, 50);
            
            if (response.tracks && response.tracks.length > 0) {
                // Get the source track's features from the API response
                const sf = (response as any).sourceFeatures;
                const sourceFeatures = {
                    bpm: sf?.bpm,
                    energy: sf?.energy,
                    valence: sf?.valence,
                    arousal: sf?.arousal,
                    danceability: sf?.danceability,
                    keyScale: sf?.keyScale,
                    instrumentalness: sf?.instrumentalness,
                    analysisMode: sf?.analysisMode,
                    // ML Mood predictions
                    moodHappy: sf?.moodHappy,
                    moodSad: sf?.moodSad,
                    moodRelaxed: sf?.moodRelaxed,
                    moodAggressive: sf?.moodAggressive,
                    moodParty: sf?.moodParty,
                    moodAcoustic: sf?.moodAcoustic,
                    moodElectronic: sf?.moodElectronic,
                };

                // Start vibe mode with the queue IDs (include current track)
                const queueIds = [currentTrack.id, ...response.tracks.map((t: any) => t.id)];
                startVibeMode(sourceFeatures, queueIds);

                // Add vibe tracks as upcoming (after current song finishes)
                setUpcoming(response.tracks, true); // preserveOrder=true for vibe mode
                
                toast.success(`Vibe mode on`, {
                    description: `${response.tracks.length} matching tracks queued up next`,
                    icon: <AudioWaveform className="w-4 h-4 text-[#ecb200]" />,
                });
            } else {
                toast.error("Couldn't find matching tracks in your library");
            }
        } catch (error) {
            console.error("Failed to start vibe match:", error);
            toast.error("Failed to match vibe");
        } finally {
            setIsVibeLoading(false);
        }
    };

    const duration = (() => {
        // Prefer canonical durations for long-form media to avoid stale/misreported playbackDuration.
        if (playbackType === "podcast" && currentPodcast?.duration) {
            return currentPodcast.duration;
        }
        if (playbackType === "audiobook" && currentAudiobook?.duration) {
            return currentAudiobook.duration;
        }
        return (
            playbackDuration ||
            currentTrack?.duration ||
            currentAudiobook?.duration ||
            currentPodcast?.duration ||
            0
        );
    })();

    // When controlling a remote device, consider media from remote state
    const hasMedia = !!(currentTrack || currentAudiobook || currentPodcast ||
        (!isActivePlayer && activePlayerState?.currentTrack));

    // When controlling a remote device, use remote state for display
    // This syncs the progress bar and time with what's actually playing on the remote
    const displayTime = (() => {
        // If controlling a remote device, use the remote device's currentTime
        if (!isActivePlayer && activePlayerState?.currentTime !== undefined) {
            return activePlayerState.currentTime;
        }

        // If we're actively playing or have seeked, use the live currentTime
        if (currentTime > 0) return currentTime;

        // Otherwise, show saved progress for audiobooks/podcasts
        if (playbackType === "audiobook" && currentAudiobook?.progress?.currentTime) {
            return currentAudiobook.progress.currentTime;
        }
        if (playbackType === "podcast" && currentPodcast?.progress?.currentTime) {
            return currentPodcast.progress.currentTime;
        }

        return currentTime;
    })();

    // Use remote duration when controlling a remote device
    const displayDuration = (!isActivePlayer && activePlayerState?.currentTrack?.duration)
        ? activePlayerState.currentTrack.duration
        : duration;

    // Use remote isPlaying state when controlling a remote device
    const displayIsPlaying = (!isActivePlayer && activePlayerState)
        ? activePlayerState.isPlaying
        : isPlaying;

    const progress = displayDuration > 0 ? Math.min(100, Math.max(0, (displayTime / displayDuration) * 100)) : 0;

    const handleSeek = (e: React.MouseEvent<HTMLDivElement>) => {
        // Don't allow seeking if canSeek is false (uncached podcast)
        if (!canSeek) {
            console.log("[FullPlayer] Seeking disabled - podcast not cached");
            return;
        }
        const rect = e.currentTarget.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const percentage = x / rect.width;
        const time = percentage * displayDuration;
        seek(time);
    };

    // Determine if seeking is allowed
    const seekEnabled = hasMedia && canSeek;

    const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const newVolume = parseInt(e.target.value) / 100;
        setVolume(newVolume);
    };

    // Get current media info
    // When controlling a remote device, use activePlayerState for track info
    // This ensures track name/artwork updates immediately when remote device changes tracks
    let title = "";
    let subtitle = "";
    let coverUrl: string | null = null;
    let albumLink: string | null = null;
    let artistLink: string | null = null;
    let mediaLink: string | null = null;

    // Use remote track info when controlling another device
    const displayTrack = (!isActivePlayer && activePlayerState?.currentTrack)
        ? activePlayerState.currentTrack
        : currentTrack;

    // Check for track playback - either local track type OR remote device has a track
    const isTrackPlayback = playbackType === "track" || (!isActivePlayer && activePlayerState?.currentTrack);
    if (isTrackPlayback && displayTrack) {
        title = displayTrack.title;
        // Handle both local Track type (has artist object) and remote track (has artist string)
        subtitle = typeof displayTrack.artist === 'string'
            ? displayTrack.artist
            : displayTrack.artist?.name || "Unknown Artist";
        // Handle coverArt - remote sends coverArt directly, local has album.coverArt
        // Local Track has album: { coverArt: string }, remote has coverArt: string directly
        const album = (displayTrack as any).album;
        const coverArt = (album && typeof album === 'object' && album.coverArt)
            ? album.coverArt
            : (displayTrack as any).coverArt;
        coverUrl = coverArt ? api.getCoverArtUrl(coverArt, 100) : null;
        // Links only work for local tracks (remote doesn't send IDs for navigation)
        if (!isActivePlayer && activePlayerState?.currentTrack) {
            // Remote track - no navigation links
            albumLink = null;
            artistLink = null;
            mediaLink = null;
        } else if (currentTrack) {
            albumLink = currentTrack.album?.id ? `/album/${currentTrack.album.id}` : null;
            artistLink = currentTrack.artist?.id ? `/artist/${currentTrack.artist.id}` : null;
            mediaLink = albumLink;
        }
    } else if (playbackType === "audiobook" && currentAudiobook) {
        title = currentAudiobook.title;
        subtitle = currentAudiobook.author;
        coverUrl = currentAudiobook.coverUrl
            ? api.getCoverArtUrl(currentAudiobook.coverUrl, 100)
            : null;
        mediaLink = `/audiobooks/${currentAudiobook.id}`;
    } else if (playbackType === "podcast" && currentPodcast) {
        title = currentPodcast.title;
        subtitle = currentPodcast.podcastTitle;
        coverUrl = currentPodcast.coverUrl
            ? api.getCoverArtUrl(currentPodcast.coverUrl, 100)
            : null;
        const podcastId = currentPodcast.id.split(":")[0];
        mediaLink = `/podcasts/${podcastId}`;
    } else {
        // Idle state - no media playing
        title = "Not Playing";
        subtitle = "Select something to play";
    }

    return (
        <div className="relative flex-shrink-0">
            {/* Floating Vibe Overlay - shows when tab is clicked */}
            {vibeMode && isVibePanelExpanded && (
                <div className="absolute bottom-full right-4 mb-2 z-50">
                    <EnhancedVibeOverlay
                        currentTrackFeatures={currentTrackFeatures}
                        variant="floating"
                        onClose={() => setIsVibePanelExpanded(false)}
                    />
                </div>
            )}

            {/* Vibe Tab - shows when vibe mode is active */}
            {vibeMode && (
                <button
                    onClick={() => setIsVibePanelExpanded(!isVibePanelExpanded)}
                    className={cn(
                        "absolute -top-8 right-4 z-10",
                        "flex items-center gap-1.5 px-3 py-1.5 rounded-t-lg",
                        "bg-[#181818] border border-b-0 border-white/10",
                        "text-xs font-medium transition-colors",
                        isVibePanelExpanded ? "text-brand" : "text-white/70 hover:text-brand"
                    )}
                >
                    <AudioWaveform className="w-3.5 h-3.5" />
                    <span>Vibe Analysis</span>
                    {isVibePanelExpanded ? (
                        <ChevronDown className="w-3.5 h-3.5" />
                    ) : (
                        <ChevronUp className="w-3.5 h-3.5" />
                    )}
                </button>
            )}

            {/* Remote Control Indicator - shows when controlling another device */}
            {!isActivePlayer && activeDevice && (
                <div className="absolute -top-12 left-4 right-4 z-10">
                    <div className="bg-[#1a1a1a] border border-white/10 rounded-lg px-4 py-2 flex items-center gap-3 shadow-lg">
                        <div className="flex items-center gap-2 text-emerald-400">
                            <Cast className="w-4 h-4" />
                            <span className="text-xs font-medium">
                                Controlling: {activeDevice.deviceName}
                            </span>
                        </div>
                        {activePlayerState?.currentTrack && (
                            <>
                                <div className="h-4 w-px bg-white/10" />
                                <div className="flex items-center gap-3 flex-1 min-w-0">
                                    {activePlayerState.currentTrack.coverArt && (
                                        <div className="w-8 h-8 rounded overflow-hidden flex-shrink-0">
                                            <Image
                                                src={api.getCoverArtUrl(activePlayerState.currentTrack.coverArt, 50)}
                                                alt=""
                                                width={32}
                                                height={32}
                                                className="object-cover"
                                                unoptimized
                                            />
                                        </div>
                                    )}
                                    <div className="min-w-0 flex-1">
                                        <p className="text-sm text-white truncate">
                                            {activePlayerState.currentTrack.title}
                                        </p>
                                        <p className="text-xs text-gray-400 truncate">
                                            {activePlayerState.currentTrack.artist}
                                        </p>
                                    </div>
                                    <div className="flex items-center gap-1">
                                        {activePlayerState.isPlaying ? (
                                            <div className="flex items-center gap-0.5">
                                                <div className="w-0.5 h-3 bg-emerald-400 rounded-full animate-pulse" />
                                                <div className="w-0.5 h-4 bg-emerald-400 rounded-full animate-pulse delay-75" />
                                                <div className="w-0.5 h-2 bg-emerald-400 rounded-full animate-pulse delay-150" />
                                            </div>
                                        ) : (
                                            <Pause className="w-3 h-3 text-gray-400" />
                                        )}
                                    </div>
                                </div>
                            </>
                        )}
                    </div>
                </div>
            )}

            <div className="h-24 bg-black border-t border-white/[0.08]">
                {/* Subtle top glow */}
                <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-white/10 to-transparent" />
            <div className="flex items-center h-full px-6 gap-6">
                {/* Artwork & Info */}
                <div className="flex items-center gap-4 w-80">
                    {mediaLink ? (
                        <Link href={mediaLink} className="relative w-14 h-14 flex-shrink-0 group">
                            <div className="absolute inset-0 bg-gradient-to-br from-white/20 to-transparent rounded-full blur-sm opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
                            <div className="relative w-full h-full bg-gradient-to-br from-[#2a2a2a] to-[#1a1a1a] rounded-full overflow-hidden shadow-lg flex items-center justify-center">
                                {coverUrl ? (
                                    <Image
                                        key={coverUrl}
                                        src={coverUrl}
                                        alt={title}
                                        fill
                                        sizes="56px"
                                        className="object-cover"
                                        priority
                                        unoptimized
                                    />
                                ) : (
                                    <MusicIcon className="w-6 h-6 text-gray-500" />
                                )}
                            </div>
                        </Link>
                    ) : (
                        <div className="relative w-14 h-14 flex-shrink-0">
                            <div className="relative w-full h-full bg-gradient-to-br from-[#2a2a2a] to-[#1a1a1a] rounded-full overflow-hidden shadow-lg flex items-center justify-center">
                                <MusicIcon className="w-6 h-6 text-gray-500" />
                            </div>
                        </div>
                    )}
                    <div className="flex-1 min-w-0">
                        {mediaLink ? (
                            <Link href={mediaLink} className="block hover:underline">
                                <h4 className="text-white font-semibold truncate text-sm">{title}</h4>
                            </Link>
                        ) : (
                            <h4 className="text-white font-semibold truncate text-sm">{title}</h4>
                        )}
                        {artistLink ? (
                            <Link href={artistLink} className="block hover:underline">
                                <p className="text-xs text-gray-400 truncate">{subtitle}</p>
                            </Link>
                        ) : mediaLink ? (
                            <Link href={mediaLink} className="block hover:underline">
                                <p className="text-xs text-gray-400 truncate">{subtitle}</p>
                            </Link>
                        ) : (
                            <p className="text-xs text-gray-400 truncate">{subtitle}</p>
                        )}
                    </div>
                </div>

                {/* Controls */}
                <div className="flex-1 flex flex-col items-center gap-2">
                    {/* Buttons */}
                    <div className="flex items-center gap-5">
                        {/* Shuffle */}
                        <button
                            onClick={toggleShuffle}
                            className={cn(
                                "transition-all duration-200 hover:scale-110 disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:scale-100",
                                isShuffle
                                    ? "text-green-500 hover:text-green-400"
                                    : "text-gray-400 hover:text-white"
                            )}
                            disabled={!hasMedia || playbackType !== "track"}
                            title="Shuffle"
                        >
                            <Shuffle className="w-4 h-4" />
                        </button>

                        {/* Skip Backward 30s */}
                        <button
                            onClick={() => skipBackward(30)}
                            className={cn(
                                "transition-all duration-200 hover:scale-110 relative disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:scale-100",
                                hasMedia ? "text-gray-400 hover:text-white" : "text-gray-600"
                            )}
                            disabled={!hasMedia}
                            title="Rewind 30 seconds"
                        >
                            <RotateCcw className="w-4 h-4" />
                            <span className="absolute text-[8px] font-bold top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2">
                                30
                            </span>
                        </button>

                        <button
                            onClick={previous}
                            className="text-gray-400 hover:text-white transition-all duration-200 hover:scale-110 disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:scale-100"
                            disabled={!hasMedia || playbackType !== "track"}
                        >
                            <SkipBack className="w-5 h-5" />
                        </button>

                        <button
                            onClick={isBuffering ? undefined : displayIsPlaying ? pause : resume}
                            className={cn(
                                "w-10 h-10 rounded-full flex items-center justify-center transition-all duration-200 relative group",
                                hasMedia && !isBuffering
                                    ? "bg-white text-black hover:scale-110 shadow-lg shadow-white/20 hover:shadow-white/30"
                                    : isBuffering
                                    ? "bg-white/80 text-black"
                                    : "bg-gray-700 text-gray-500 cursor-not-allowed"
                            )}
                            disabled={!hasMedia || isBuffering}
                            title={isBuffering ? "Buffering..." : displayIsPlaying ? "Pause" : "Play"}
                        >
                            {hasMedia && !isBuffering && (
                                <div className="absolute inset-0 rounded-full bg-white blur-md opacity-0 group-hover:opacity-50 transition-opacity duration-200" />
                            )}
                            {isBuffering ? (
                                <Loader2 className="w-5 h-5 animate-spin relative z-10" />
                            ) : displayIsPlaying ? (
                                <Pause className="w-5 h-5 relative z-10" />
                            ) : (
                                <Play className="w-5 h-5 ml-0.5 relative z-10" />
                            )}
                        </button>

                        <button
                            onClick={next}
                            className="text-gray-400 hover:text-white transition-all duration-200 hover:scale-110 disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:scale-100"
                            disabled={!hasMedia || playbackType !== "track"}
                        >
                            <SkipForward className="w-5 h-5" />
                        </button>

                        {/* Skip Forward 30s */}
                        <button
                            onClick={() => skipForward(30)}
                            className={cn(
                                "transition-all duration-200 hover:scale-110 relative disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:scale-100",
                                hasMedia ? "text-gray-400 hover:text-white" : "text-gray-600"
                            )}
                            disabled={!hasMedia}
                            title="Forward 30 seconds"
                        >
                            <RotateCw className="w-4 h-4" />
                            <span className="absolute text-[8px] font-bold top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2">
                                30
                            </span>
                        </button>

                        {/* Repeat */}
                        <button
                            onClick={toggleRepeat}
                            className={cn(
                                "transition-all duration-200 hover:scale-110 disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:scale-100",
                                repeatMode !== "off"
                                    ? "text-green-500 hover:text-green-400"
                                    : "text-gray-400 hover:text-white"
                            )}
                            disabled={!hasMedia || playbackType !== "track"}
                            title={
                                repeatMode === "off"
                                    ? "Repeat: Off"
                                    : repeatMode === "all"
                                    ? "Repeat: All (loop queue)"
                                    : "Repeat: One (play current track twice)"
                            }
                        >
                            {repeatMode === "one" ? (
                                <Repeat1 className="w-4 h-4" />
                            ) : (
                                <Repeat className="w-4 h-4" />
                            )}
                        </button>

                        {/* Vibe Mode Toggle */}
                        <button
                            onClick={handleVibeToggle}
                            className={cn(
                                "transition-all duration-200 hover:scale-110 disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:scale-100",
                                !hasMedia || playbackType !== "track"
                                    ? "text-gray-600"
                                    : vibeMode
                                    ? "text-[#ecb200] hover:text-[#d4a000]"
                                    : "text-gray-400 hover:text-[#ecb200]"
                            )}
                            disabled={!hasMedia || playbackType !== "track" || isVibeLoading}
                            title={vibeMode ? "Turn off vibe mode" : "Match this vibe - find similar sounding tracks"}
                        >
                            {isVibeLoading ? (
                                <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                                <AudioWaveform className="w-4 h-4" />
                            )}
                        </button>
                    </div>

                    {/* Progress Bar */}
                    <div className="w-full flex items-center gap-3">
                        <span className={cn(
                            "text-xs text-right font-medium tabular-nums",
                            hasMedia ? "text-gray-400" : "text-gray-600",
                            duration >= 3600 ? "w-14" : "w-10" // Wider for h:mm:ss format
                        )}>
                            {formatTime(displayTime)}
                        </span>
                        <div
                            className={cn(
                                "flex-1 h-1 bg-white/[0.15] rounded-full relative",
                                seekEnabled ? "cursor-pointer group" : "cursor-not-allowed"
                            )}
                            onClick={seekEnabled ? handleSeek : undefined}
                            title={
                                !hasMedia 
                                    ? undefined 
                                    : !canSeek 
                                    ? downloadProgress !== null 
                                        ? `Downloading ${downloadProgress}%... Seek will be available when cached`
                                        : "Downloading... Seeking will be available when cached" 
                                    : "Click to seek"
                            }
                        >
                            <div
                                className={cn(
                                    "h-full rounded-full relative transition-all duration-150",
                                    seekEnabled ? "bg-white group-hover:bg-white" : hasMedia ? "bg-white/50" : "bg-gray-600"
                                )}
                                style={{ width: `${progress}%` }}
                            >
                                {seekEnabled && (
                                    <div className="absolute right-0 top-1/2 -translate-y-1/2 w-3 h-3 bg-white rounded-full opacity-0 group-hover:opacity-100 transition-opacity shadow-lg shadow-white/50" />
                                )}
                            </div>
                        </div>
                        <span className={cn(
                            "text-xs font-medium tabular-nums",
                            hasMedia ? "text-gray-400" : "text-gray-600",
                            displayDuration >= 3600 ? "w-14" : "w-10" // Wider for h:mm:ss format
                        )}>
                            {formatTime(displayDuration)}
                        </span>
                    </div>
                </div>

                {/* Volume & Expand */}
                <div className="flex items-center gap-3 w-52 justify-end">
                    <button
                        onClick={toggleMute}
                        className="text-gray-400 hover:text-white transition-all duration-200 hover:scale-110"
                    >
                        {isMuted || volume === 0 ? (
                            <VolumeX className="w-5 h-5" />
                        ) : (
                            <Volume2 className="w-5 h-5" />
                        )}
                    </button>

                    <div className="relative flex-1">
                        <input
                            type="range"
                            min="0"
                            max="100"
                            value={volume * 100}
                            onChange={handleVolumeChange}
                            className="w-full h-1 bg-white/[0.15] rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:shadow-lg [&::-webkit-slider-thumb]:shadow-white/30 [&::-webkit-slider-thumb]:transition-all [&::-webkit-slider-thumb]:hover:scale-110"
                        />
                    </div>

                    {/* Remote Playback Device Selector */}
                    <DeviceSelector />

                    {/* Keyboard Shortcuts Info */}
                    <KeyboardShortcutsTooltip />

                    <button
                        onClick={() => setPlayerMode("overlay")}
                        className={cn(
                            "transition-all duration-200 border-l border-white/[0.08] pl-3",
                            hasMedia
                                ? "text-gray-400 hover:text-white hover:scale-110"
                                : "text-gray-600 cursor-not-allowed"
                        )}
                        disabled={!hasMedia}
                        title="Expand to full screen"
                    >
                        <Maximize2 className="w-4 h-4" />
                    </button>
                </div>
            </div>
            </div>
        </div>
    );
}
