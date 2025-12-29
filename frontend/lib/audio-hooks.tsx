"use client";

import { useAudioState } from "./audio-state-context";
import { useAudioPlayback } from "./audio-playback-context";
import { useRemoteAwareAudioControls } from "./remote-aware-audio-controls-context";

/**
 * Unified hook that combines all audio contexts.
 * Use this for backward compatibility with existing code.
 *
 * NOTE: This hook uses RemoteAwareAudioControls which automatically routes
 * playback commands (play, pause, next, etc.) to the active player device.
 * When this device is NOT the active player, commands are forwarded via WebSocket.
 *
 * For optimal performance, prefer using the individual hooks:
 * - useAudioState() - for rarely changing data (currentTrack, queue, etc.)
 * - useAudioPlayback() - for frequently changing data (currentTime, isPlaying)
 * - useRemoteAwareAudioControls() - for remote-aware playback actions
 */
export function useAudio() {
    const state = useAudioState();
    const playback = useAudioPlayback();
    const controls = useRemoteAwareAudioControls();

    return {
        // State
        currentTrack: state.currentTrack,
        currentAudiobook: state.currentAudiobook,
        currentPodcast: state.currentPodcast,
        playbackType: state.playbackType,
        queue: state.queue,
        currentIndex: state.currentIndex,
        isShuffle: state.isShuffle,
        isRepeat: state.isRepeat,
        repeatMode: state.repeatMode,
        playerMode: state.playerMode,
        volume: state.volume,
        isMuted: state.isMuted,
        
        // Vibe mode state
        vibeMode: state.vibeMode,
        vibeSourceFeatures: state.vibeSourceFeatures,
        vibeQueueIds: state.vibeQueueIds,

        // Playback
        isPlaying: playback.isPlaying,
        currentTime: playback.currentTime,
        duration: playback.duration,
        isBuffering: playback.isBuffering,
        targetSeekPosition: playback.targetSeekPosition,
        canSeek: playback.canSeek,
        downloadProgress: playback.downloadProgress,

        // Controls
        playTrack: controls.playTrack,
        playTracks: controls.playTracks,
        playAudiobook: controls.playAudiobook,
        playPodcast: controls.playPodcast,
        pause: controls.pause,
        resume: controls.resume,
        next: controls.next,
        previous: controls.previous,
        addToQueue: controls.addToQueue,
        removeFromQueue: controls.removeFromQueue,
        clearQueue: controls.clearQueue,
        setUpcoming: controls.setUpcoming,
        toggleShuffle: controls.toggleShuffle,
        toggleRepeat: controls.toggleRepeat,
        updateCurrentTime: controls.updateCurrentTime,
        seek: controls.seek,
        skipForward: controls.skipForward,
        skipBackward: controls.skipBackward,
        setPlayerMode: controls.setPlayerMode,
        returnToPreviousMode: controls.returnToPreviousMode,
        setVolume: controls.setVolume,
        toggleMute: controls.toggleMute,
        
        // Vibe mode controls
        startVibeMode: controls.startVibeMode,
        stopVibeMode: controls.stopVibeMode,

        // Remote playback state
        isActivePlayer: controls.isActivePlayer,
        activePlayerState: controls.activePlayerState,
    };
}
