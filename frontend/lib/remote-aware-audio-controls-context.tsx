"use client";

import {
    createContext,
    useContext,
    useCallback,
    ReactNode,
    useMemo,
} from "react";
import { useAudioControls } from "./audio-controls-context";
import { useRemotePlayback } from "./remote-playback-context";
import { Track, Audiobook, Podcast, PlayerMode } from "./audio-state-context";

/**
 * RemoteAwareAudioControlsContext
 *
 * This context wraps the standard audio controls and adds remote playback awareness.
 * When this device is NOT the active player, playback commands (play, pause, next, etc.)
 * are forwarded to the active player via WebSocket instead of executing locally.
 *
 * This implements the Spotify Connect behavior where:
 * - Only ONE device plays audio at any time
 * - All playback controls go to the active player device
 * - Selecting a device transfers playback to it
 */

interface RemoteAwareAudioControlsContextType {
    // Track methods
    playTrack: (track: Track) => void;
    playTracks: (tracks: Track[], startIndex?: number, isVibeQueue?: boolean) => void;

    // Audiobook methods
    playAudiobook: (audiobook: Audiobook) => void;

    // Podcast methods
    playPodcast: (podcast: Podcast) => void;

    // Playback controls
    pause: () => void;
    resume: () => void;
    play: () => void;
    next: () => void;
    previous: () => void;

    // Queue controls
    addToQueue: (track: Track) => void;
    removeFromQueue: (index: number) => void;
    clearQueue: () => void;
    setUpcoming: (tracks: Track[], preserveOrder?: boolean) => void;

    // Playback modes
    toggleShuffle: () => void;
    toggleRepeat: () => void;

    // Time controls
    updateCurrentTime: (time: number) => void;
    seek: (time: number) => void;
    skipForward: (seconds?: number) => void;
    skipBackward: (seconds?: number) => void;

    // Player mode controls
    setPlayerMode: (mode: PlayerMode) => void;
    returnToPreviousMode: () => void;

    // Volume controls
    setVolume: (volume: number) => void;
    toggleMute: () => void;

    // Vibe mode controls
    startVibeMode: (sourceFeatures: {
        bpm?: number | null;
        energy?: number | null;
        valence?: number | null;
        arousal?: number | null;
        danceability?: number | null;
        keyScale?: string | null;
        instrumentalness?: number | null;
        analysisMode?: string | null;
        moodHappy?: number | null;
        moodSad?: number | null;
        moodRelaxed?: number | null;
        moodAggressive?: number | null;
        moodParty?: number | null;
        moodAcoustic?: number | null;
        moodElectronic?: number | null;
    }, queueIds: string[]) => void;
    stopVibeMode: () => void;

    // Remote playback info
    isActivePlayer: boolean;
    activePlayerId: string | null;

    // Active player's state (for display when controlling remotely)
    // Returns null if this device is the active player
    activePlayerState: {
        isPlaying: boolean;
        currentTrack: {
            id: string;
            title: string;
            artist: string;
            album: string;
            coverArt?: string;
            duration: number;
        } | null;
        currentTime: number;
        volume: number;
    } | null;
}

const RemoteAwareAudioControlsContext = createContext<
    RemoteAwareAudioControlsContextType | undefined
>(undefined);

export function RemoteAwareAudioControlsProvider({ children }: { children: ReactNode }) {
    const controls = useAudioControls();
    const remote = useRemotePlayback();

    // Use getter functions to avoid stale closures - these always return current values
    const { isActivePlayer, activePlayerId, activePlayerState, sendCommand, getIsActivePlayer, getActivePlayerId } = remote;

    // Helper to either execute locally or send to active device
    // CRITICAL: Uses getter functions to get CURRENT values, not stale closure values
    const executeOrForward = useCallback(
        (
            command: "play" | "pause" | "next" | "prev" | "seek" | "volume",
            localAction: () => void,
            payload?: any
        ) => {
            // Get current values from refs via getters (avoids stale closures)
            const currentIsActivePlayer = getIsActivePlayer();
            const currentActivePlayerId = getActivePlayerId();

            console.log(`[RemoteAware] ${command}: isActivePlayer=${currentIsActivePlayer}, activePlayerId=${currentActivePlayerId} (state: isActivePlayer=${isActivePlayer}, activePlayerId=${activePlayerId})`);

            if (currentIsActivePlayer) {
                // This device is active, execute locally
                console.log(`[RemoteAware] Executing ${command} locally (this device is active)`);
                localAction();
            } else if (currentActivePlayerId) {
                // Forward command to the active device
                console.log(`[RemoteAware] Forwarding ${command} to ${currentActivePlayerId}`);
                sendCommand(currentActivePlayerId, command, payload);
                // DON'T execute locally - only forward
            } else {
                // No active player set yet - this shouldn't happen often
                // Execute locally as fallback but log warning
                console.warn(`[RemoteAware] No activePlayerId set, executing ${command} locally as fallback`);
                localAction();
            }
        },
        [getIsActivePlayer, getActivePlayerId, sendCommand, isActivePlayer, activePlayerId]
    );

    // Wrapped playback controls
    const pause = useCallback(() => {
        executeOrForward("pause", controls.pause);
    }, [executeOrForward, controls.pause]);

    const resume = useCallback(() => {
        executeOrForward("play", controls.resume);
    }, [executeOrForward, controls.resume]);

    const play = useCallback(() => {
        executeOrForward("play", controls.play);
    }, [executeOrForward, controls.play]);

    const next = useCallback(() => {
        executeOrForward("next", controls.next);
    }, [executeOrForward, controls.next]);

    const previous = useCallback(() => {
        executeOrForward("prev", controls.previous);
    }, [executeOrForward, controls.previous]);

    const seek = useCallback(
        (time: number) => {
            executeOrForward("seek", () => controls.seek(time), { time });
        },
        [executeOrForward, controls.seek]
    );

    const setVolume = useCallback(
        (volume: number) => {
            executeOrForward("volume", () => controls.setVolume(volume), { volume });
        },
        [executeOrForward, controls.setVolume]
    );

    const skipForward = useCallback(
        (seconds: number = 30) => {
            const currentIsActivePlayer = getIsActivePlayer();
            const currentActivePlayerId = getActivePlayerId();
            console.log(`[RemoteAware] skipForward: isActivePlayer=${currentIsActivePlayer}, activePlayerId=${currentActivePlayerId}`);

            if (currentIsActivePlayer) {
                controls.skipForward(seconds);
            } else if (currentActivePlayerId) {
                // For skip, we need to calculate the new time
                // Since we don't have the remote device's current time,
                // we send a relative seek command
                sendCommand(currentActivePlayerId, "seek", { relative: seconds });
            } else {
                controls.skipForward(seconds);
            }
        },
        [getIsActivePlayer, getActivePlayerId, sendCommand, controls.skipForward]
    );

    const skipBackward = useCallback(
        (seconds: number = 30) => {
            const currentIsActivePlayer = getIsActivePlayer();
            const currentActivePlayerId = getActivePlayerId();
            console.log(`[RemoteAware] skipBackward: isActivePlayer=${currentIsActivePlayer}, activePlayerId=${currentActivePlayerId}`);

            if (currentIsActivePlayer) {
                controls.skipBackward(seconds);
            } else if (currentActivePlayerId) {
                sendCommand(currentActivePlayerId, "seek", { relative: -seconds });
            } else {
                controls.skipBackward(seconds);
            }
        },
        [getIsActivePlayer, getActivePlayerId, sendCommand, controls.skipBackward]
    );

    // For playTrack - when controlling remotely, send the track to play
    const playTrack = useCallback(
        (track: Track) => {
            const currentIsActivePlayer = getIsActivePlayer();
            const currentActivePlayerId = getActivePlayerId();
            console.log(`[RemoteAware] playTrack: isActivePlayer=${currentIsActivePlayer}, activePlayerId=${currentActivePlayerId}`);

            if (currentIsActivePlayer) {
                controls.playTrack(track);
            } else if (currentActivePlayerId) {
                // Send playTrack command to remote device
                sendCommand(currentActivePlayerId, "playTrack", { track });
            } else {
                controls.playTrack(track);
            }
        },
        [getIsActivePlayer, getActivePlayerId, sendCommand, controls.playTrack]
    );

    // For playTracks - when controlling remotely, send the queue
    const playTracks = useCallback(
        (tracks: Track[], startIndex: number = 0, isVibeQueue: boolean = false) => {
            const currentIsActivePlayer = getIsActivePlayer();
            const currentActivePlayerId = getActivePlayerId();
            console.log(`[RemoteAware] playTracks: isActivePlayer=${currentIsActivePlayer}, activePlayerId=${currentActivePlayerId}`);

            if (currentIsActivePlayer) {
                controls.playTracks(tracks, startIndex, isVibeQueue);
            } else if (currentActivePlayerId) {
                sendCommand(currentActivePlayerId, "setQueue", { tracks, startIndex });
            } else {
                controls.playTracks(tracks, startIndex, isVibeQueue);
            }
        },
        [getIsActivePlayer, getActivePlayerId, sendCommand, controls.playTracks]
    );

    // These controls are always local (UI state, not playback)
    const setPlayerMode = controls.setPlayerMode;
    const returnToPreviousMode = controls.returnToPreviousMode;
    const toggleMute = controls.toggleMute;
    const toggleShuffle = controls.toggleShuffle;
    const toggleRepeat = controls.toggleRepeat;
    const updateCurrentTime = controls.updateCurrentTime;
    const addToQueue = controls.addToQueue;
    const removeFromQueue = controls.removeFromQueue;
    const clearQueue = controls.clearQueue;
    const setUpcoming = controls.setUpcoming;
    const playAudiobook = controls.playAudiobook;
    const playPodcast = controls.playPodcast;
    const startVibeMode = controls.startVibeMode;
    const stopVibeMode = controls.stopVibeMode;

    const value = useMemo(
        () => ({
            playTrack,
            playTracks,
            playAudiobook,
            playPodcast,
            pause,
            resume,
            play,
            next,
            previous,
            addToQueue,
            removeFromQueue,
            clearQueue,
            setUpcoming,
            toggleShuffle,
            toggleRepeat,
            updateCurrentTime,
            seek,
            skipForward,
            skipBackward,
            setPlayerMode,
            returnToPreviousMode,
            setVolume,
            toggleMute,
            startVibeMode,
            stopVibeMode,
            isActivePlayer,
            activePlayerId,
            activePlayerState,
        }),
        [
            playTrack,
            playTracks,
            playAudiobook,
            playPodcast,
            pause,
            resume,
            play,
            next,
            previous,
            addToQueue,
            removeFromQueue,
            clearQueue,
            setUpcoming,
            toggleShuffle,
            toggleRepeat,
            updateCurrentTime,
            seek,
            skipForward,
            skipBackward,
            setPlayerMode,
            returnToPreviousMode,
            setVolume,
            toggleMute,
            startVibeMode,
            stopVibeMode,
            isActivePlayer,
            activePlayerId,
            activePlayerState,
        ]
    );

    return (
        <RemoteAwareAudioControlsContext.Provider value={value}>
            {children}
        </RemoteAwareAudioControlsContext.Provider>
    );
}

export function useRemoteAwareAudioControls() {
    const context = useContext(RemoteAwareAudioControlsContext);
    if (!context) {
        throw new Error(
            "useRemoteAwareAudioControls must be used within RemoteAwareAudioControlsProvider"
        );
    }
    return context;
}
