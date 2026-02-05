"use client";

/* eslint-disable react-hooks/preserve-manual-memoization -- Complex control forwarding requires manual memoization */

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
    const {
        isActivePlayer,
        activePlayerId,
        activePlayerState,
        sendCommand,
        getActivePlayerId,
        getControlMode,
        getControlTargetId,
        currentDeviceId,
        becomeActivePlayer,
    } = remote;

    const ensureLocalDeviceActive = useCallback(
        (reason: string) => {
            const currentActivePlayerId = getActivePlayerId();
            if (!currentDeviceId) return;

            // If another device is active, explicitly take ownership before local playback actions.
            if (currentActivePlayerId !== null && currentActivePlayerId !== currentDeviceId) {
                console.log(
                    `[RemoteAware] Taking active player before local ${reason}: ${currentActivePlayerId} -> ${currentDeviceId}`
                );
                becomeActivePlayer();
            }
        },
        [getActivePlayerId, currentDeviceId, becomeActivePlayer]
    );

    // Helper to either execute locally or send to controlled device
    // CRITICAL: Uses getter functions to get CURRENT values, not stale closure values
    // NEW: Uses controlMode to determine routing, not isActivePlayer
    const executeOrForward = useCallback(
        (
            command: "play" | "pause" | "next" | "prev" | "seek" | "volume",
            localAction: () => void,
            payload?: any
        ) => {
            // Get current values from refs via getters (avoids stale closures)
            const currentControlMode = getControlMode();
            const currentControlTargetId = getControlTargetId();
            const currentActivePlayerId = getActivePlayerId();

            console.log(`[RemoteAware] ${command}: controlMode=${currentControlMode}, controlTargetId=${currentControlTargetId}, activePlayerId=${currentActivePlayerId}`);

            if (currentControlMode === "local") {
                if (command !== "pause" && command !== "volume") {
                    ensureLocalDeviceActive(command);
                }
                // Local mode - execute locally after taking ownership if needed
                console.log(`[RemoteAware] Executing ${command} locally (local control mode)`);
                localAction();
            } else if (currentControlTargetId) {
                // Remote mode - forward command to the controlled device
                console.log(`[RemoteAware] Forwarding ${command} to controlled device ${currentControlTargetId}`);
                sendCommand(currentControlTargetId, command, payload);
                // DON'T execute locally - only forward
            } else {
                // Remote mode but no target - shouldn't happen, fallback to local
                console.warn(`[RemoteAware] Remote mode but no controlTargetId, executing ${command} locally as fallback`);
                localAction();
            }
        },
        [getControlMode, getControlTargetId, getActivePlayerId, sendCommand, ensureLocalDeviceActive]
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
            const currentControlMode = getControlMode();
            const currentControlTargetId = getControlTargetId();
            console.log(`[RemoteAware] skipForward: controlMode=${currentControlMode}, controlTargetId=${currentControlTargetId}`);

            if (currentControlMode === "local") {
                ensureLocalDeviceActive("skipForward");
                controls.skipForward(seconds);
            } else if (currentControlTargetId) {
                // For skip, we send a relative seek command
                sendCommand(currentControlTargetId, "seek", { relative: seconds });
            } else {
                controls.skipForward(seconds);
            }
        },
        [getControlMode, getControlTargetId, sendCommand, controls.skipForward, ensureLocalDeviceActive]
    );

    const skipBackward = useCallback(
        (seconds: number = 30) => {
            const currentControlMode = getControlMode();
            const currentControlTargetId = getControlTargetId();
            console.log(`[RemoteAware] skipBackward: controlMode=${currentControlMode}, controlTargetId=${currentControlTargetId}`);

            if (currentControlMode === "local") {
                ensureLocalDeviceActive("skipBackward");
                controls.skipBackward(seconds);
            } else if (currentControlTargetId) {
                sendCommand(currentControlTargetId, "seek", { relative: -seconds });
            } else {
                controls.skipBackward(seconds);
            }
        },
        [getControlMode, getControlTargetId, sendCommand, controls.skipBackward, ensureLocalDeviceActive]
    );

    // For playTrack - when controlling remotely, send the track to play
    const playTrack = useCallback(
        (track: Track) => {
            const currentControlMode = getControlMode();
            const currentControlTargetId = getControlTargetId();
            console.log(`[RemoteAware] playTrack: controlMode=${currentControlMode}, controlTargetId=${currentControlTargetId}`);

            if (currentControlMode === "local") {
                ensureLocalDeviceActive("playTrack");
                controls.playTrack(track);
            } else if (currentControlTargetId) {
                // Send playTrack command to remote device
                sendCommand(currentControlTargetId, "playTrack", { track });
            } else {
                controls.playTrack(track);
            }
        },
        [getControlMode, getControlTargetId, sendCommand, controls.playTrack, ensureLocalDeviceActive]
    );

    // For playTracks - when controlling remotely, send the queue
    const playTracks = useCallback(
        (tracks: Track[], startIndex: number = 0, isVibeQueue: boolean = false) => {
            const currentControlMode = getControlMode();
            const currentControlTargetId = getControlTargetId();
            console.log(`[RemoteAware] playTracks: controlMode=${currentControlMode}, controlTargetId=${currentControlTargetId}`);
            
            // DEBUG: Log track filePath on send
            const firstTrack = tracks[startIndex];
            if (firstTrack) {
                console.log(`[RemoteAware] SENDING track: "${firstTrack.title}"`);
                console.log(`[RemoteAware] SENDING filePath: ${firstTrack.filePath || 'MISSING'}`);
                console.log(`[RemoteAware] SENDING keys: ${Object.keys(firstTrack).join(', ')}`);
            }

            if (currentControlMode === "local") {
                ensureLocalDeviceActive("playTracks");
                controls.playTracks(tracks, startIndex, isVibeQueue);
            } else if (currentControlTargetId) {
                sendCommand(currentControlTargetId, "setQueue", { tracks, startIndex });
            } else {
                controls.playTracks(tracks, startIndex, isVibeQueue);
            }
        },
        [getControlMode, getControlTargetId, sendCommand, controls.playTracks, ensureLocalDeviceActive]
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
