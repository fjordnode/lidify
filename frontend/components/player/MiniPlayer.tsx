"use client";

import { useAudio } from "@/lib/audio-context";
import { api } from "@/lib/api";
import { useIsMobile, useIsTablet } from "@/hooks/useMediaQuery";
import Image from "next/image";
import Link from "next/link";
import {
    Play,
    Pause,
    Maximize2,
    Music as MusicIcon,
    SkipBack,
    SkipForward,
    Repeat,
    Repeat1,
    Shuffle,
    MonitorUp,
    RotateCcw,
    RotateCw,
    Loader2,
    AudioWaveform,
    ChevronLeft,
    ChevronUp,
    ChevronDown,
    Volume2,
    VolumeX,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/utils/cn";
import { useState, useRef, useEffect } from "react";
import { KeyboardShortcutsTooltip } from "./KeyboardShortcutsTooltip";
import { EnhancedVibeOverlay } from "./VibeOverlayEnhanced";
import { DeviceSelector } from "./DeviceSelector";

export function MiniPlayer() {
    const {
        currentTrack,
        currentAudiobook,
        currentPodcast,
        playbackType,
        isPlaying,
        isBuffering,
        isShuffle,
        repeatMode,
        currentTime,
        duration: playbackDuration,
        canSeek,
        downloadProgress,
        vibeMode,
        queue,
        currentIndex,
        pause,
        resume,
        next,
        previous,
        toggleShuffle,
        toggleRepeat,
        seek,
        skipForward,
        skipBackward,
        setPlayerMode,
        setUpcoming,
        startVibeMode,
        stopVibeMode,
        isActivePlayer,
        activePlayerState,
        volume,
        setVolume,
    } = useAudio();
    const isMobile = useIsMobile();
    const isTablet = useIsTablet();
    const isMobileOrTablet = isMobile || isTablet;
    const [isVibeLoading, setIsVibeLoading] = useState(false);
    const [isMinimized, setIsMinimized] = useState(false);
    const [isDismissed, setIsDismissed] = useState(false);
    const [swipeOffset, setSwipeOffset] = useState(0);
    const [isVibePanelExpanded, setIsVibePanelExpanded] = useState(false);
    const [showVolumeSlider, setShowVolumeSlider] = useState(false);
    const touchStartX = useRef<number | null>(null);
    const lastMediaIdRef = useRef<string | null>(null);

    // Get display volume - use remote volume when controlling remote device
    const displayVolume = (!isActivePlayer && activePlayerState?.volume !== undefined)
        ? activePlayerState.volume
        : volume;

    // Get current track's audio features for vibe comparison
    const currentTrackFeatures = queue[currentIndex]?.audioFeatures || null;

    // Reset dismissed/minimized state when a new track starts playing
    const currentMediaId =
        currentTrack?.id || currentAudiobook?.id || currentPodcast?.id;

    useEffect(() => {
        if (currentMediaId && currentMediaId !== lastMediaIdRef.current) {
            lastMediaIdRef.current = currentMediaId;
            setIsDismissed(false);
            setIsMinimized(false);
        }
    }, [currentMediaId]);

    // Handle Vibe Match toggle - finds tracks that sound like the current track
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
            const response = await api.getRadioTracks(
                "vibe",
                currentTrack.id,
                50
            );

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
                const queueIds = [
                    currentTrack.id,
                    ...response.tracks.map((t: any) => t.id),
                ];
                startVibeMode(sourceFeatures, queueIds);

                // Add vibe tracks as upcoming (after current song finishes)
                setUpcoming(response.tracks, true); // preserveOrder=true for vibe mode

                toast.success(`Vibe mode on`, {
                    description: `${response.tracks.length} matching tracks queued up next`,
                    icon: <AudioWaveform className="w-4 h-4 text-brand" />,
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

    // When controlling a remote device, consider media from remote state
    const hasMedia = !!(currentTrack || currentAudiobook || currentPodcast ||
        (!isActivePlayer && activePlayerState?.currentTrack));

    // Get current media info
    // When controlling a remote device, use activePlayerState for track info
    let title = "";
    let subtitle = "";
    let coverUrl: string | null = null;
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
        // Links only work for local tracks
        if (!isActivePlayer && activePlayerState?.currentTrack) {
            mediaLink = null;
        } else if (currentTrack) {
            mediaLink = currentTrack.album?.id ? `/album/${currentTrack.album.id}` : null;
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
        title = "Not Playing";
        subtitle = "Select something to play";
    }

    // Check if controls should be enabled (only for tracks)
    const canSkip = playbackType === "track";

    // Calculate duration - use remote when controlling a remote device
    const duration = (() => {
        // If controlling a remote device, use its track duration
        if (!isActivePlayer && activePlayerState?.currentTrack?.duration) {
            return activePlayerState.currentTrack.duration;
        }
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

    // When controlling a remote device, use remote state for display
    const displayTime = (!isActivePlayer && activePlayerState?.currentTime !== undefined)
        ? activePlayerState.currentTime
        : currentTime;

    // Use remote isPlaying state when controlling a remote device
    const displayIsPlaying = (!isActivePlayer && activePlayerState)
        ? activePlayerState.isPlaying
        : isPlaying;

    const progress =
        duration > 0
            ? Math.min(100, Math.max(0, (displayTime / duration) * 100))
            : 0;

    // Handle progress bar click
    const handleProgressClick = (e: React.MouseEvent<HTMLDivElement>) => {
        if (!canSeek) return;
        const rect = e.currentTarget.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const percentage = x / rect.width;
        const newTime = percentage * duration;
        seek(newTime);
    };

    const seekEnabled = hasMedia && canSeek;

    // ============================================
    // MOBILE/TABLET: Spotify-style compact player
    // ============================================
    if (isMobileOrTablet) {
        // Don't render if no media
        if (!hasMedia) return null;

        // Handle swipe gestures:
        // - Swipe RIGHT: minimize to tab
        // - Swipe LEFT + playing: open overlay
        // - Swipe LEFT + not playing: dismiss completely
        const handleTouchStart = (e: React.TouchEvent) => {
            touchStartX.current = e.touches[0].clientX;
        };

        const handleTouchMove = (e: React.TouchEvent) => {
            if (touchStartX.current === null) return;
            const deltaX = e.touches[0].clientX - touchStartX.current;
            // Track both directions, cap at ±150px
            setSwipeOffset(Math.max(-150, Math.min(150, deltaX)));
        };

        const handleTouchEnd = () => {
            if (touchStartX.current === null) return;

            // Swipe RIGHT (positive) → minimize to tab
            if (swipeOffset > 80) {
                setIsMinimized(true);
            }
            // Swipe LEFT (negative) → open overlay OR dismiss
            else if (swipeOffset < -80) {
                if (isPlaying) {
                    // If playing, open full-screen overlay
                    setPlayerMode("overlay");
                } else {
                    // If not playing, dismiss completely
                    setIsDismissed(true);
                }
            }

            // Reset
            setSwipeOffset(0);
            touchStartX.current = null;
        };

        // Completely dismissed - don't render anything
        if (isDismissed) {
            return null;
        }

        // Minimized tab - small pill on RIGHT to bring player back
        if (isMinimized) {
            return (
                <button
                    onClick={() => setIsMinimized(false)}
                    className="fixed right-0 z-50 bg-gradient-to-l from-[#f5c518] via-[#e6a700] to-[#a855f7] rounded-l-full pl-3 pr-2 py-2 shadow-lg flex items-center gap-2 transition-transform hover:scale-105 active:scale-95"
                    style={{
                        bottom: "calc(56px + env(safe-area-inset-bottom, 0px) + 16px)",
                    }}
                    title="Show player"
                >
                    <ChevronLeft className="w-4 h-4 text-black" />
                    {coverUrl ? (
                        <div className="relative w-8 h-8 rounded-full overflow-hidden ring-2 ring-black/20">
                            <Image
                                src={coverUrl}
                                alt={title}
                                fill
                                sizes="32px"
                                className="object-cover"
                                unoptimized
                            />
                        </div>
                    ) : (
                        <div className="w-8 h-8 rounded-full bg-black/30 flex items-center justify-center">
                            <MusicIcon className="w-4 h-4 text-white" />
                        </div>
                    )}
                </button>
            );
        }

        // Calculate opacity for swipe feedback
        const swipeOpacity = 1 - Math.abs(swipeOffset) / 200;

        return (
            <div
                className="fixed left-2 right-2 z-50 rounded-xl overflow-hidden shadow-xl"
                style={{
                    bottom: "calc(56px + env(safe-area-inset-bottom, 0px) + 8px)",
                    transform: `translateX(${swipeOffset}px)`,
                    opacity: swipeOpacity,
                    transition: swipeOffset === 0 ? 'transform 0.25s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.25s cubic-bezier(0.4, 0, 0.2, 1)' : 'none',
                }}
                onTouchStart={handleTouchStart}
                onTouchMove={handleTouchMove}
                onTouchEnd={handleTouchEnd}
            >
                {/* Gradient background - richer, more vibrant colors */}
                <div className="absolute inset-0 bg-gradient-to-r from-[#1a1a2e] via-[#2d1847] to-[#1a1a2e]" />
                <div className="absolute inset-0 bg-gradient-to-r from-[#f5c518]/30 via-[#a855f7]/40 to-[#f5c518]/30" />
                {/* Edge glow effects */}
                <div className="absolute inset-y-0 left-0 w-1 bg-gradient-to-b from-[#f5c518] via-[#e6a700] to-[#f5c518]" />
                <div className="absolute inset-y-0 right-0 w-1 bg-gradient-to-b from-[#a855f7] via-[#7c3aed] to-[#a855f7]" />

                {/* Progress bar at top */}
                <div className="relative h-[2px] bg-white/20 w-full">
                    <div
                        className="h-full bg-gradient-to-r from-[#f5c518] via-[#e6a700] to-[#a855f7] transition-all duration-150"
                        style={{ width: `${progress}%` }}
                    />
                </div>

                {/* Volume slider - collapsible */}
                <div
                    className={cn(
                        "relative overflow-hidden transition-all duration-200 ease-out",
                        showVolumeSlider ? "max-h-12 opacity-100" : "max-h-0 opacity-0"
                    )}
                >
                    <div className="flex items-center gap-3 px-4 py-2 bg-black/20">
                        <VolumeX className="w-4 h-4 text-gray-400 flex-shrink-0" />
                        <input
                            type="range"
                            min="0"
                            max="100"
                            value={Math.round(displayVolume * 100)}
                            onChange={(e) => setVolume(parseInt(e.target.value) / 100)}
                            className="flex-1 h-1 bg-white/20 rounded-full appearance-none cursor-pointer
                                [&::-webkit-slider-thumb]:appearance-none
                                [&::-webkit-slider-thumb]:w-4
                                [&::-webkit-slider-thumb]:h-4
                                [&::-webkit-slider-thumb]:rounded-full
                                [&::-webkit-slider-thumb]:bg-white
                                [&::-webkit-slider-thumb]:shadow-md
                                [&::-moz-range-thumb]:w-4
                                [&::-moz-range-thumb]:h-4
                                [&::-moz-range-thumb]:rounded-full
                                [&::-moz-range-thumb]:bg-white
                                [&::-moz-range-thumb]:border-0"
                            onClick={(e) => e.stopPropagation()}
                        />
                        <Volume2 className="w-4 h-4 text-gray-400 flex-shrink-0" />
                        <span className="text-xs text-gray-400 w-8 text-right tabular-nums">
                            {Math.round(displayVolume * 100)}%
                        </span>
                    </div>
                </div>

                {/* Player content - more spacious padding */}
                <div
                    className="relative flex items-center gap-3 px-3 py-3 cursor-pointer"
                    onClick={() => setPlayerMode("overlay")}
                >
                    {/* Album Art - slightly larger */}
                    <div className="relative w-12 h-12 flex-shrink-0 rounded-lg overflow-hidden bg-black/30 shadow-md">
                        {coverUrl ? (
                            <Image
                                src={coverUrl}
                                alt={title}
                                fill
                                sizes="48px"
                                className="object-cover"
                                unoptimized
                            />
                        ) : (
                            <div className="w-full h-full flex items-center justify-center">
                                <MusicIcon className="w-5 h-5 text-gray-400" />
                            </div>
                        )}
                    </div>

                    {/* Track Info */}
                    <div className="flex-1 min-w-0">
                        <p className="text-white text-sm font-medium truncate leading-tight">
                            {title}
                        </p>
                        <p className="text-gray-300/70 text-xs truncate leading-tight mt-0.5">
                            {subtitle}
                        </p>
                    </div>

                    {/* Controls - Volume, Vibe & Play/Pause */}
                    <div
                        className="flex items-center gap-1 flex-shrink-0"
                        onClick={(e) => e.stopPropagation()}
                    >
                        {/* Volume Button */}
                        <button
                            onClick={() => setShowVolumeSlider(!showVolumeSlider)}
                            className={cn(
                                "w-9 h-9 flex items-center justify-center rounded-full transition-colors",
                                showVolumeSlider
                                    ? "text-[#f5c518] bg-white/10"
                                    : "text-white/80 hover:text-white active:bg-white/10"
                            )}
                            title="Volume"
                        >
                            <Volume2 className="w-5 h-5" />
                        </button>

                        {/* Vibe Button */}
                        <button
                            onClick={handleVibeToggle}
                            disabled={!canSkip || isVibeLoading}
                            className={cn(
                                "w-9 h-9 flex items-center justify-center rounded-full transition-colors",
                                !canSkip
                                    ? "text-gray-600"
                                    : vibeMode
                                    ? "text-[#f5c518]"
                                    : "text-white/70 hover:text-[#f5c518]"
                            )}
                            title={
                                vibeMode
                                    ? "Turn off vibe mode"
                                    : "Match this vibe"
                            }
                        >
                            {isVibeLoading ? (
                                <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                                <AudioWaveform className="w-4 h-4" />
                            )}
                        </button>

                        {/* Play/Pause */}
                        <button
                            onClick={() => {
                                if (!isBuffering) {
                                    if (displayIsPlaying) {
                                        pause();
                                    } else {
                                        resume();
                                    }
                                }
                            }}
                            className={cn(
                                "w-10 h-10 rounded-full flex items-center justify-center transition shadow-md",
                                isBuffering
                                    ? "bg-white/80 text-black"
                                    : "bg-white text-black hover:scale-105"
                            )}
                            title={
                                isBuffering
                                    ? "Buffering..."
                                    : displayIsPlaying
                                    ? "Pause"
                                    : "Play"
                            }
                        >
                            {isBuffering ? (
                                <Loader2 className="w-5 h-5 animate-spin" />
                            ) : displayIsPlaying ? (
                                <Pause className="w-5 h-5" />
                            ) : (
                                <Play className="w-5 h-5 ml-0.5" />
                            )}
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    // ============================================
    // DESKTOP: Full-featured mini player
    // ============================================
    return (
        <div className="relative">
            {/* Collapsible Vibe Panel - slides up from player */}
            {vibeMode && (
                <div
                    className={cn(
                        "absolute left-0 right-0 bottom-full transition-all duration-300 ease-out overflow-hidden border-t border-white/[0.08]",
                        isVibePanelExpanded ? "max-h-[500px]" : "max-h-0"
                    )}
                >
                    <div className="bg-[#121212]">
                        <EnhancedVibeOverlay
                            currentTrackFeatures={currentTrackFeatures}
                            variant="inline"
                            onClose={() => setIsVibePanelExpanded(false)}
                        />
                    </div>
                </div>
            )}

            {/* Vibe Tab - shows when vibe mode is active */}
            {vibeMode && (
                <button
                    onClick={() => setIsVibePanelExpanded(!isVibePanelExpanded)}
                    className={cn(
                        "absolute -top-8 left-1/2 -translate-x-1/2 z-10",
                        "flex items-center gap-1.5 px-3 py-1 rounded-t-lg",
                        "bg-[#121212] border border-b-0 border-white/[0.08]",
                        "text-xs font-medium transition-colors",
                        isVibePanelExpanded
                            ? "text-brand"
                            : "text-white/70 hover:text-brand"
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

            <div className="bg-gradient-to-t from-[#0a0a0a] via-[#0f0f0f] to-[#0a0a0a] border-t border-white/[0.08] relative backdrop-blur-xl">
                {/* Subtle top glow */}
                <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-white/10 to-transparent" />

                {/* Progress Bar - tall hit area with thin visual bar */}
                <div
                    className={cn(
                        "absolute top-0 left-0 right-0 h-3 flex items-start group",
                        seekEnabled
                            ? "cursor-pointer"
                            : "cursor-not-allowed"
                    )}
                    onClick={seekEnabled ? handleProgressClick : undefined}
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
                    {/* Visual bar - thin but expands on hover */}
                    <div className={cn(
                        "w-full bg-white/[0.15] transition-all",
                        seekEnabled ? "h-1 group-hover:h-2" : "h-1"
                    )}>
                        <div
                            className={cn(
                                "h-full rounded-full relative transition-all duration-150",
                                seekEnabled
                                    ? "bg-white"
                                    : hasMedia
                                    ? "bg-white/50"
                                    : "bg-gray-600"
                            )}
                            style={{ width: `${progress}%` }}
                        >
                            {seekEnabled && (
                                <div className="absolute right-0 top-1/2 -translate-y-1/2 w-3 h-3 bg-white rounded-full opacity-0 group-hover:opacity-100 transition-opacity shadow-lg shadow-white/50" />
                            )}
                        </div>
                    </div>
                </div>

                {/* Player Content */}
                <div className="px-3 py-2.5 pt-3">
                    {/* Artwork & Track Info */}
                    <div className="flex items-center gap-2 mb-2">
                        {/* Artwork */}
                        {mediaLink ? (
                            <Link
                                href={mediaLink}
                                className="relative flex-shrink-0 group w-12 h-12"
                            >
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
                            <div className="relative flex-shrink-0 w-12 h-12">
                                <div className="relative w-full h-full bg-gradient-to-br from-[#2a2a2a] to-[#1a1a1a] rounded-full overflow-hidden shadow-lg flex items-center justify-center">
                                    <MusicIcon className="w-6 h-6 text-gray-500" />
                                </div>
                            </div>
                        )}

                        {/* Track Info */}
                        <div className="flex-1 min-w-0">
                            {mediaLink ? (
                                <Link
                                    href={mediaLink}
                                    className="block hover:underline"
                                >
                                    <p className="text-white font-semibold truncate text-sm">
                                        {title}
                                    </p>
                                </Link>
                            ) : (
                                <p className="text-white font-semibold truncate text-sm">
                                    {title}
                                </p>
                            )}
                            <p className="text-gray-400 truncate text-xs">
                                {subtitle}
                            </p>
                        </div>

                        {/* Mode Switch Buttons */}
                        <div className="flex items-center gap-1 flex-shrink-0">
                            <button
                                onClick={() => setPlayerMode("full")}
                                className="text-gray-400 hover:text-white transition p-1"
                                title="Show bottom player"
                            >
                                <MonitorUp className="w-3.5 h-3.5" />
                            </button>
                            <button
                                onClick={() => setPlayerMode("overlay")}
                                className={cn(
                                    "transition p-1",
                                    hasMedia
                                        ? "text-gray-400 hover:text-white"
                                        : "text-gray-600 cursor-not-allowed"
                                )}
                                disabled={!hasMedia}
                                title="Expand to full screen"
                            >
                                <Maximize2 className="w-3.5 h-3.5" />
                            </button>
                        </div>
                    </div>

                    {/* Playback Controls */}
                    <div className="flex items-center justify-between gap-1">
                        {/* Shuffle */}
                        <button
                            onClick={toggleShuffle}
                            disabled={!hasMedia || !canSkip}
                            className={cn(
                                "rounded p-1.5 transition-colors",
                                hasMedia && canSkip
                                    ? isShuffle
                                        ? "text-green-500 hover:text-green-400"
                                        : "text-gray-400 hover:text-white"
                                    : "text-gray-600 cursor-not-allowed"
                            )}
                            title={canSkip ? "Shuffle" : "Shuffle (music only)"}
                        >
                            <Shuffle className="w-3.5 h-3.5" />
                        </button>

                        {/* Skip Backward 30s */}
                        <button
                            onClick={() => skipBackward(30)}
                            disabled={!hasMedia}
                            className={cn(
                                "rounded p-1.5 transition-colors relative",
                                hasMedia
                                    ? "text-gray-400 hover:text-white"
                                    : "text-gray-600 cursor-not-allowed"
                            )}
                            title="Rewind 30 seconds"
                        >
                            <RotateCcw className="w-3.5 h-3.5" />
                            <span className="absolute text-[8px] font-bold top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2">
                                30
                            </span>
                        </button>

                        {/* Previous */}
                        <button
                            onClick={previous}
                            disabled={!hasMedia || !canSkip}
                            className={cn(
                                "rounded p-1.5 transition-colors",
                                hasMedia && canSkip
                                    ? "text-gray-400 hover:text-white"
                                    : "text-gray-600 cursor-not-allowed"
                            )}
                            title={
                                canSkip ? "Previous" : "Previous (music only)"
                            }
                        >
                            <SkipBack className="w-4 h-4" />
                        </button>

                        {/* Play/Pause */}
                        <button
                            onClick={
                                isBuffering
                                    ? undefined
                                    : displayIsPlaying
                                    ? pause
                                    : resume
                            }
                            disabled={!hasMedia || isBuffering}
                            className={cn(
                                "w-8 h-8 rounded-full flex items-center justify-center transition",
                                hasMedia && !isBuffering
                                    ? "bg-white text-black hover:scale-105"
                                    : isBuffering
                                    ? "bg-white/80 text-black"
                                    : "bg-gray-700 text-gray-500 cursor-not-allowed"
                            )}
                            title={
                                isBuffering
                                    ? "Buffering..."
                                    : displayIsPlaying
                                    ? "Pause"
                                    : "Play"
                            }
                        >
                            {isBuffering ? (
                                <Loader2 className="w-4 h-4 animate-spin" />
                            ) : displayIsPlaying ? (
                                <Pause className="w-4 h-4" />
                            ) : (
                                <Play className="w-4 h-4 ml-0.5" />
                            )}
                        </button>

                        {/* Next */}
                        <button
                            onClick={next}
                            disabled={!hasMedia || !canSkip}
                            className={cn(
                                "rounded p-1.5 transition-colors",
                                hasMedia && canSkip
                                    ? "text-gray-400 hover:text-white"
                                    : "text-gray-600 cursor-not-allowed"
                            )}
                            title={canSkip ? "Next" : "Next (music only)"}
                        >
                            <SkipForward className="w-4 h-4" />
                        </button>

                        {/* Skip Forward 30s */}
                        <button
                            onClick={() => skipForward(30)}
                            disabled={!hasMedia}
                            className={cn(
                                "rounded p-1.5 transition-colors relative",
                                hasMedia
                                    ? "text-gray-400 hover:text-white"
                                    : "text-gray-600 cursor-not-allowed"
                            )}
                            title="Forward 30 seconds"
                        >
                            <RotateCw className="w-3.5 h-3.5" />
                            <span className="absolute text-[8px] font-bold top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2">
                                30
                            </span>
                        </button>

                        {/* Repeat */}
                        <button
                            onClick={toggleRepeat}
                            disabled={!hasMedia || !canSkip}
                            className={cn(
                                "rounded p-1.5 transition-colors",
                                hasMedia && canSkip
                                    ? repeatMode !== "off"
                                        ? "text-green-500 hover:text-green-400"
                                        : "text-gray-400 hover:text-white"
                                    : "text-gray-600 cursor-not-allowed"
                            )}
                            title={
                                canSkip
                                    ? repeatMode === "off"
                                        ? "Repeat: Off"
                                        : repeatMode === "all"
                                        ? "Repeat: All"
                                        : "Repeat: One"
                                    : "Repeat (music only)"
                            }
                        >
                            {repeatMode === "one" ? (
                                <Repeat1 className="w-3.5 h-3.5" />
                            ) : (
                                <Repeat className="w-3.5 h-3.5" />
                            )}
                        </button>

                        {/* Volume Control */}
                        <div className="flex items-center gap-1 ml-1">
                            <button
                                onClick={() => setVolume(displayVolume === 0 ? 1 : 0)}
                                disabled={!hasMedia}
                                className={cn(
                                    "rounded p-1.5 transition-colors",
                                    hasMedia
                                        ? "text-gray-400 hover:text-white"
                                        : "text-gray-600 cursor-not-allowed"
                                )}
                                title={displayVolume === 0 ? "Unmute" : "Mute"}
                            >
                                {displayVolume === 0 ? (
                                    <VolumeX className="w-3.5 h-3.5" />
                                ) : (
                                    <Volume2 className="w-3.5 h-3.5" />
                                )}
                            </button>
                            <input
                                type="range"
                                min="0"
                                max="100"
                                value={Math.round(displayVolume * 100)}
                                onChange={(e) => setVolume(parseInt(e.target.value) / 100)}
                                disabled={!hasMedia}
                                className={cn(
                                    "w-16 h-1 rounded-full appearance-none cursor-pointer",
                                    hasMedia ? "bg-white/20" : "bg-white/10 cursor-not-allowed",
                                    "[&::-webkit-slider-thumb]:appearance-none",
                                    "[&::-webkit-slider-thumb]:w-3",
                                    "[&::-webkit-slider-thumb]:h-3",
                                    "[&::-webkit-slider-thumb]:rounded-full",
                                    "[&::-webkit-slider-thumb]:bg-white",
                                    "[&::-moz-range-thumb]:w-3",
                                    "[&::-moz-range-thumb]:h-3",
                                    "[&::-moz-range-thumb]:rounded-full",
                                    "[&::-moz-range-thumb]:bg-white",
                                    "[&::-moz-range-thumb]:border-0"
                                )}
                                title={`Volume: ${Math.round(displayVolume * 100)}%`}
                            />
                        </div>

                        {/* Vibe Mode Toggle */}
                        <button
                            onClick={handleVibeToggle}
                            disabled={!hasMedia || !canSkip || isVibeLoading}
                            className={cn(
                                "rounded p-1.5 transition-colors",
                                !hasMedia || !canSkip
                                    ? "text-gray-600 cursor-not-allowed"
                                    : vibeMode
                                    ? "text-brand hover:text-brand-hover"
                                    : "text-gray-400 hover:text-brand"
                            )}
                            title={
                                vibeMode
                                    ? "Turn off vibe mode"
                                    : "Match this vibe - find similar sounding tracks"
                            }
                        >
                            {isVibeLoading ? (
                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            ) : (
                                <AudioWaveform className="w-3.5 h-3.5" />
                            )}
                        </button>

                        {/* Remote Playback Device Selector */}
                        <DeviceSelector compact />

                        {/* Keyboard Shortcuts */}
                        <KeyboardShortcutsTooltip />
                    </div>
                </div>
            </div>
        </div>
    );
}
