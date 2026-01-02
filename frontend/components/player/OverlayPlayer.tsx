"use client";

import { useAudio } from "@/lib/audio-context";
import { api } from "@/lib/api";
import Image from "next/image";
import Link from "next/link";
import { useRef, useState, useEffect } from "react";
import {
    Play,
    Pause,
    SkipBack,
    SkipForward,
    ChevronDown,
    Music as MusicIcon,
    Shuffle,
    Repeat,
    Repeat1,
    AudioWaveform,
    Loader2,
    Volume2,
    VolumeX,
} from "lucide-react";
import { DeviceSelector } from "./DeviceSelector";
import { formatTime } from "@/utils/formatTime";
import { cn } from "@/utils/cn";
import { useIsMobile, useIsTablet } from "@/hooks/useMediaQuery";
import { toast } from "sonner";
import { VibeComparisonArt } from "./VibeOverlay";
import { useAudioState } from "@/lib/audio-state-context";

export function OverlayPlayer() {
    const {
        currentTrack,
        currentAudiobook,
        currentPodcast,
        playbackType,
        isPlaying,
        currentTime,
        canSeek,
        downloadProgress,
        isShuffle,
        repeatMode,
        vibeMode,
        queue,
        currentIndex,
        pause,
        resume,
        next,
        previous,
        returnToPreviousMode,
        seek,
        toggleShuffle,
        toggleRepeat,
        setUpcoming,
        startVibeMode,
        stopVibeMode,
        duration: playbackDuration,
        isActivePlayer,
        activePlayerState,
        volume,
        setVolume,
    } = useAudio();

    // Get display volume - use remote volume when controlling remote device
    const displayVolume = (!isActivePlayer && activePlayerState?.volume !== undefined)
        ? activePlayerState.volume
        : volume;
    
    // Get current track's audio features for vibe comparison
    const currentTrackFeatures = queue[currentIndex]?.audioFeatures || null;
    
    const isMobile = useIsMobile();
    const isTablet = useIsTablet();
    const isMobileOrTablet = isMobile || isTablet;
    
    // Swipe state for track skipping
    const touchStartX = useRef<number | null>(null);
    const [swipeOffset, setSwipeOffset] = useState(0);
    const [isVibeLoading, setIsVibeLoading] = useState(false);

    // Local volume state for smooth slider interaction
    const [localVolume, setLocalVolume] = useState(displayVolume * 100);
    const lastSetVolumeRef = useRef<number | null>(null);

    // Only sync from remote if it's a different value than what we set
    useEffect(() => {
        const remoteVol = Math.round(displayVolume * 100);
        const lastSet = lastSetVolumeRef.current;
        // Only update if remote changed to something different than what we set
        if (lastSet === null || Math.abs(remoteVol - lastSet) > 2) {
            setLocalVolume(remoteVol);
        }
    }, [displayVolume]);

    const handleVolumeChange = (value: number) => {
        setLocalVolume(value);
        lastSetVolumeRef.current = value;
        setVolume(value / 100);
    };

    const duration = (() => {
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

    // When controlling a remote device, also show overlay if remote has a track
    if (!currentTrack && !currentAudiobook && !currentPodcast &&
        !(activePlayerState?.currentTrack && !isActivePlayer)) return null;

    // When controlling a remote device, use remote state for display
    const displayTime = (() => {
        // If controlling a remote device, use the remote device's currentTime
        if (!isActivePlayer && activePlayerState?.currentTime !== undefined) {
            return activePlayerState.currentTime;
        }
        if (currentTime > 0) return currentTime;
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
    const seekEnabled = canSeek;
    const canSkip = playbackType === "track";

    const handleSeek = (e: React.MouseEvent<HTMLDivElement> | React.TouchEvent<HTMLDivElement>) => {
        if (!canSeek) return;
        const rect = e.currentTarget.getBoundingClientRect();
        const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
        const x = clientX - rect.left;
        const percentage = x / rect.width;
        const time = percentage * displayDuration;
        seek(time);
    };

    // Swipe handlers for track skipping
    const handleTouchStart = (e: React.TouchEvent) => {
        touchStartX.current = e.touches[0].clientX;
    };

    const handleTouchMove = (e: React.TouchEvent) => {
        if (touchStartX.current === null) return;
        const deltaX = e.touches[0].clientX - touchStartX.current;
        setSwipeOffset(Math.max(-100, Math.min(100, deltaX)));
    };

    const handleTouchEnd = () => {
        if (touchStartX.current === null) return;
        
        if (canSkip) {
            if (swipeOffset > 60) {
                previous();
            } else if (swipeOffset < -60) {
                next();
            }
        }
        
        setSwipeOffset(0);
        touchStartX.current = null;
    };

    // Handle Vibe toggle
    const handleVibeToggle = async () => {
        if (!currentTrack?.id) return;
        
        if (vibeMode) {
            stopVibeMode();
            toast.success("Vibe mode off");
            return;
        }
        
        setIsVibeLoading(true);
        try {
            const response = await api.getRadioTracks("vibe", currentTrack.id, 50);
            
            if (response.tracks && response.tracks.length > 0) {
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

                const queueIds = [currentTrack.id, ...response.tracks.map((t: any) => t.id)];
                startVibeMode(sourceFeatures, queueIds);
                setUpcoming(response.tracks, true); // preserveOrder=true for vibe mode
                
                toast.success(`Vibe mode on`, {
                    description: `${response.tracks.length} matching tracks queued`,
                    icon: <AudioWaveform className="w-4 h-4 text-[#f5c518]" />,
                });
            } else {
                toast.error("Couldn't find matching tracks");
            }
        } catch (error) {
            console.error("Failed to start vibe match:", error);
            toast.error("Failed to match vibe");
        } finally {
            setIsVibeLoading(false);
        }
    };

    // Get current media info
    // When controlling a remote device, use activePlayerState for track info
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
        coverUrl = coverArt ? api.getCoverArtUrl(coverArt, 500) : null;
        // Links only work for local tracks
        if (!isActivePlayer && activePlayerState?.currentTrack) {
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
            ? api.getCoverArtUrl(currentAudiobook.coverUrl, 500)
            : null;
        mediaLink = `/audiobooks/${currentAudiobook.id}`;
    } else if (playbackType === "podcast" && currentPodcast) {
        title = currentPodcast.title;
        subtitle = currentPodcast.podcastTitle;
        coverUrl = currentPodcast.coverUrl
            ? api.getCoverArtUrl(currentPodcast.coverUrl, 500)
            : null;
        const podcastId = currentPodcast.id.split(":")[0];
        mediaLink = `/podcasts/${podcastId}`;
    }

    return (
        <div 
            className="fixed inset-0 bg-gradient-to-b from-[#1a1a2e] via-[#121218] to-[#000000] z-[9999] flex flex-col overflow-hidden"
            onTouchStart={isMobileOrTablet ? handleTouchStart : undefined}
            onTouchMove={isMobileOrTablet ? handleTouchMove : undefined}
            onTouchEnd={isMobileOrTablet ? handleTouchEnd : undefined}
        >
            {/* Header with close button */}
            <div 
                className="flex items-center justify-between px-4 py-3 flex-shrink-0"
                style={{ paddingTop: 'calc(12px + env(safe-area-inset-top))' }}
            >
                <button
                    onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        returnToPreviousMode();
                    }}
                    className="text-gray-400 hover:text-white transition-colors p-2 -ml-2 rounded-full hover:bg-white/10"
                    title="Close"
                >
                    <ChevronDown className="w-7 h-7" />
                </button>
                
                {/* Now Playing indicator */}
                <span className="text-xs text-gray-500 uppercase tracking-widest font-medium">
                    Now Playing
                </span>
                
                <div className="w-11" /> {/* Spacer for centering */}
            </div>

            {/* Main Content - Portrait vs Landscape */}
            <div className="flex-1 flex flex-col landscape:flex-row items-center justify-center px-6 pb-6 landscape:px-8 landscape:gap-8 overflow-hidden">
                
                {/* Artwork Section */}
                <div 
                    className="w-full max-w-[280px] landscape:max-w-[240px] landscape:w-[240px] aspect-square flex-shrink-0 mb-6 landscape:mb-0 relative"
                    style={{ 
                        transform: `translateX(${swipeOffset * 0.5}px)`,
                        opacity: 1 - Math.abs(swipeOffset) / 200
                    }}
                >
                    {/* Glow effect */}
                    <div className={cn(
                        "absolute inset-0 rounded-2xl blur-2xl opacity-50",
                        vibeMode 
                            ? "bg-gradient-to-br from-brand/30 via-transparent to-purple-500/30" 
                            : "bg-gradient-to-br from-[#f5c518]/20 via-transparent to-[#a855f7]/20"
                    )} />
                    
                    {/* Album art OR Vibe Comparison when in vibe mode */}
                    <div className="relative w-full h-full bg-gradient-to-br from-[#2a2a2a] to-[#1a1a1a] rounded-2xl overflow-hidden shadow-2xl">
                        {vibeMode && currentTrackFeatures ? (
                            <VibeComparisonArt currentTrackFeatures={currentTrackFeatures} />
                        ) : coverUrl ? (
                            <Image
                                key={coverUrl}
                                src={coverUrl}
                                alt={title}
                                fill
                                sizes="280px"
                                className="object-cover"
                                priority
                                unoptimized
                            />
                        ) : (
                            <div className="w-full h-full flex items-center justify-center">
                                <MusicIcon className="w-24 h-24 text-gray-600" />
                            </div>
                        )}
                    </div>
                    
                    {/* Swipe hint indicators */}
                    {canSkip && isMobileOrTablet && Math.abs(swipeOffset) > 20 && (
                        <div className={cn(
                            "absolute top-1/2 -translate-y-1/2 text-white/60",
                            swipeOffset > 0 ? "-left-8" : "-right-8"
                        )}>
                            {swipeOffset > 0 ? (
                                <SkipBack className="w-6 h-6" />
                            ) : (
                                <SkipForward className="w-6 h-6" />
                            )}
                        </div>
                    )}
                </div>

                {/* Info & Controls Section */}
                <div className="w-full max-w-[320px] landscape:max-w-[280px] landscape:flex-1 flex flex-col">
                    {/* Track Info */}
                    <div className="text-center landscape:text-left mb-6">
                        {mediaLink ? (
                            <Link href={mediaLink} onClick={returnToPreviousMode} className="block hover:underline">
                                <h1 className="text-xl font-bold text-white mb-1 truncate">
                                    {title}
                                </h1>
                            </Link>
                        ) : (
                            <h1 className="text-xl font-bold text-white mb-1 truncate">
                                {title}
                            </h1>
                        )}
                        {artistLink ? (
                            <Link href={artistLink} onClick={returnToPreviousMode} className="block hover:underline">
                                <p className="text-base text-gray-400 truncate">
                                    {subtitle}
                                </p>
                            </Link>
                        ) : (
                            <p className="text-base text-gray-400 truncate">
                                {subtitle}
                            </p>
                        )}
                    </div>

                    {/* Progress Bar */}
                    <div className="mb-6">
                        {/* Taller hit area wrapper */}
                        <div
                            className={cn(
                                "w-full h-6 flex items-center mb-2",
                                seekEnabled ? "cursor-pointer" : "cursor-not-allowed"
                            )}
                            onClick={seekEnabled ? handleSeek : undefined}
                            title={!canSeek
                                ? downloadProgress !== null
                                    ? `Downloading ${downloadProgress}%...`
                                    : "Downloading..."
                                : "Tap to seek"}
                        >
                            {/* Visual bar */}
                            <div className="w-full h-1 bg-white/20 rounded-full">
                                <div
                                    className={cn(
                                        "h-full rounded-full transition-all duration-150",
                                        seekEnabled
                                            ? "bg-gradient-to-r from-[#f5c518] to-[#a855f7]"
                                            : "bg-white/40"
                                    )}
                                    style={{ width: `${progress}%` }}
                                />
                            </div>
                        </div>
                        <div className="flex justify-between text-xs text-gray-500 font-medium tabular-nums">
                            <span>{formatTime(displayTime)}</span>
                            <span>{formatTime(displayDuration)}</span>
                        </div>
                    </div>

                    {/* Main Controls */}
                    <div className="flex items-center justify-center gap-6 mb-6">
                        <button
                            onClick={previous}
                            className={cn(
                                "text-white/80 hover:text-white transition-all hover:scale-110",
                                !canSkip && "opacity-30 cursor-not-allowed hover:scale-100"
                            )}
                            disabled={!canSkip}
                            title={canSkip ? "Previous" : "Skip only for music"}
                        >
                            <SkipBack className="w-8 h-8" />
                        </button>

                        <button
                            onClick={displayIsPlaying ? pause : resume}
                            className="w-16 h-16 rounded-full bg-white text-black flex items-center justify-center hover:scale-105 transition-all shadow-xl"
                            title={displayIsPlaying ? "Pause" : "Play"}
                        >
                            {displayIsPlaying ? (
                                <Pause className="w-7 h-7" />
                            ) : (
                                <Play className="w-7 h-7 ml-1" />
                            )}
                        </button>

                        <button
                            onClick={next}
                            className={cn(
                                "text-white/80 hover:text-white transition-all hover:scale-110",
                                !canSkip && "opacity-30 cursor-not-allowed hover:scale-100"
                            )}
                            disabled={!canSkip}
                            title={canSkip ? "Next" : "Skip only for music"}
                        >
                            <SkipForward className="w-8 h-8" />
                        </button>
                    </div>

                    {/* Secondary Controls */}
                    <div className="flex items-center justify-center gap-8">
                        <button
                            onClick={toggleShuffle}
                            disabled={!canSkip}
                            className={cn(
                                "transition-colors",
                                !canSkip
                                    ? "text-gray-700 cursor-not-allowed"
                                    : isShuffle
                                    ? "text-[#f5c518]"
                                    : "text-gray-500 hover:text-white"
                            )}
                            title="Shuffle"
                        >
                            <Shuffle className="w-5 h-5" />
                        </button>

                        <button
                            onClick={toggleRepeat}
                            disabled={!canSkip}
                            className={cn(
                                "transition-colors",
                                !canSkip
                                    ? "text-gray-700 cursor-not-allowed"
                                    : repeatMode !== "off"
                                    ? "text-[#f5c518]"
                                    : "text-gray-500 hover:text-white"
                            )}
                            title={repeatMode === "one" ? "Repeat One" : repeatMode === "all" ? "Repeat All" : "Repeat Off"}
                        >
                            {repeatMode === "one" ? (
                                <Repeat1 className="w-5 h-5" />
                            ) : (
                                <Repeat className="w-5 h-5" />
                            )}
                        </button>

                        <button
                            onClick={handleVibeToggle}
                            disabled={!canSkip || isVibeLoading}
                            className={cn(
                                "transition-colors",
                                !canSkip
                                    ? "text-gray-700 cursor-not-allowed"
                                    : vibeMode
                                    ? "text-[#f5c518]"
                                    : "text-gray-500 hover:text-[#f5c518]"
                            )}
                            title={vibeMode ? "Turn off vibe mode" : "Match this vibe"}
                        >
                            {isVibeLoading ? (
                                <Loader2 className="w-5 h-5 animate-spin" />
                            ) : (
                                <AudioWaveform className="w-5 h-5" />
                            )}
                        </button>

                        {/* Device Selector for remote playback */}
                        <DeviceSelector />
                    </div>

                    {/* Volume Slider - smooth local state */}
                    <div
                        className="flex items-center gap-3 mt-6"
                        onTouchStart={(e) => e.stopPropagation()}
                        onTouchMove={(e) => e.stopPropagation()}
                        onTouchEnd={(e) => e.stopPropagation()}
                    >
                        <button
                            onClick={() => {
                                const newVol = localVolume === 0 ? 100 : 0;
                                setLocalVolume(newVol);
                                setVolume(newVol / 100);
                            }}
                            className="text-gray-400 hover:text-white transition-colors"
                            title={localVolume === 0 ? "Unmute" : "Mute"}
                        >
                            {localVolume === 0 ? (
                                <VolumeX className="w-5 h-5" />
                            ) : (
                                <Volume2 className="w-5 h-5" />
                            )}
                        </button>
                        <input
                            type="range"
                            min="0"
                            max="100"
                            value={localVolume}
                            onChange={(e) => handleVolumeChange(parseInt(e.target.value))}
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
                        />
                        <span className="text-gray-400 text-sm tabular-nums w-10 text-right">
                            {Math.round(localVolume)}%
                        </span>
                    </div>
                </div>
            </div>

        </div>
    );
}
