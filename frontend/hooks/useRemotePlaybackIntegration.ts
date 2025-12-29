"use client";

import { useEffect, useRef, useCallback } from "react";
import { useRemotePlayback, RemoteCommand } from "@/lib/remote-playback-context";
import { useAudioState, Track } from "@/lib/audio-state-context";
import { useAudioPlayback } from "@/lib/audio-playback-context";
import { useAudioControls } from "@/lib/audio-controls-context";
import { howlerEngine } from "@/lib/howler-engine";

/**
 * Hook that integrates the remote playback system with the audio controls.
 *
 * This hook:
 * 1. Registers a command handler to execute remote commands
 * 2. Broadcasts playback state changes to other devices
 * 3. Handles playback transfer from other devices
 */
export function useRemotePlaybackIntegration() {
    const remote = useRemotePlayback();
    const state = useAudioState();
    const playback = useAudioPlayback();
    const controls = useAudioControls();

    // Track last broadcast to avoid duplicate updates
    const lastBroadcastRef = useRef<string>("");
    const broadcastTimeoutRef = useRef<NodeJS.Timeout | null>(null);

    // Track pending remote playback for autoplay error handling
    const pendingRemotePlayRef = useRef<{
        track: Track | null;
        currentTime: number;
        volume: number;
    } | null>(null);

    // Command queue for commands that arrive while loading
    const commandQueueRef = useRef<RemoteCommand[]>([]);
    const isProcessingQueueRef = useRef<boolean>(false);

    // Keep refs for current state to avoid dependency array issues
    const currentTrackRef = useRef(state.currentTrack);
    const volumeRef = useRef(state.volume);
    currentTrackRef.current = state.currentTrack;
    volumeRef.current = state.volume;

    // Execute a command immediately (internal helper)
    const executeCommand = useCallback((command: RemoteCommand) => {
        console.log("[RemoteIntegration] Executing command:", command.command, command.payload);

        switch (command.command) {
            case "play":
                // Mark that we have a pending remote play for autoplay error handling
                pendingRemotePlayRef.current = {
                    track: currentTrackRef.current,
                    currentTime: howlerEngine.getCurrentTime(),
                    volume: volumeRef.current,
                };
                controls.resume();
                // Clear pending after a short delay if no error occurred
                setTimeout(() => {
                    if (pendingRemotePlayRef.current?.track?.id === currentTrackRef.current?.id) {
                        pendingRemotePlayRef.current = null;
                    }
                }, 1000);
                break;

            case "pause":
                controls.pause();
                break;

            case "next":
                controls.next();
                break;

            case "prev":
                controls.previous();
                break;

            case "seek":
                // Support both absolute time and relative seek
                if (typeof command.payload?.time === "number") {
                    controls.seek(command.payload.time);
                } else if (typeof command.payload?.relative === "number") {
                    // Relative seek (e.g., +30 or -30 seconds)
                    // Use howlerEngine directly to get current time at execution moment
                    // This avoids needing playback.currentTime in the dependency array
                    const currentTime = howlerEngine.getCurrentTime();
                    const newTime = Math.max(0, currentTime + command.payload.relative);
                    controls.seek(newTime);
                }
                break;

            case "volume":
                if (typeof command.payload?.volume === "number") {
                    controls.setVolume(command.payload.volume);
                }
                break;

            case "playTrack":
                if (command.payload?.track) {
                    const track = command.payload.track as Track;
                    // Set pending for autoplay error recovery
                    pendingRemotePlayRef.current = {
                        track,
                        currentTime: 0,
                        volume: volumeRef.current,
                    };
                    controls.playTrack(track);
                    // Clear pending after a delay if no error occurred
                    setTimeout(() => {
                        if (pendingRemotePlayRef.current?.track?.id === track.id) {
                            pendingRemotePlayRef.current = null;
                        }
                    }, 2000);
                }
                break;

            case "setQueue":
                if (command.payload?.tracks && Array.isArray(command.payload.tracks)) {
                    const tracks = command.payload.tracks as Track[];
                    const startIndex = command.payload.startIndex || 0;
                    const firstTrack = tracks[startIndex];
                    // Set pending for autoplay error recovery
                    if (firstTrack) {
                        pendingRemotePlayRef.current = {
                            track: firstTrack,
                            currentTime: 0,
                            volume: volumeRef.current,
                        };
                    }
                    controls.playTracks(tracks, startIndex);
                    // Clear pending after a delay if no error occurred
                    setTimeout(() => {
                        if (firstTrack && pendingRemotePlayRef.current?.track?.id === firstTrack.id) {
                            pendingRemotePlayRef.current = null;
                        }
                    }, 2000);
                }
                break;

            case "transferPlayback":
                // Another device is transferring playback to us
                if (command.payload) {
                    const { track, currentTime, isPlaying, volume } = command.payload;

                    if (track) {
                        // Store pending playback info for autoplay error recovery
                        pendingRemotePlayRef.current = {
                            track: track as Track,
                            currentTime: typeof currentTime === "number" ? currentTime : 0,
                            volume: typeof volume === "number" ? volume : 1,
                        };

                        // Play the track
                        controls.playTrack(track as Track);

                        // After a short delay, seek to the position and set volume
                        setTimeout(() => {
                            if (typeof currentTime === "number" && currentTime > 0) {
                                controls.seek(currentTime);
                            }
                            if (typeof volume === "number") {
                                controls.setVolume(volume);
                            }
                            // If source was playing, make sure we're playing
                            if (isPlaying) {
                                controls.resume();
                            }

                            // Clear pending after successful setup
                            // (will be cleared earlier if autoplay error occurs)
                            setTimeout(() => {
                                pendingRemotePlayRef.current = null;
                            }, 1000);
                        }, 500);
                    }
                }
                break;

            default:
                console.warn("[RemoteIntegration] Unknown command:", command.command);
        }
    }, [controls]);

    // Process queued commands after load completes
    const processQueue = useCallback(() => {
        if (isProcessingQueueRef.current || commandQueueRef.current.length === 0) {
            return;
        }

        isProcessingQueueRef.current = true;
        console.log(`[RemoteIntegration] Processing ${commandQueueRef.current.length} queued command(s)`);

        // Take the LAST command of each type (e.g., if multiple "next" commands, only execute once)
        const commandsByType = new Map<string, RemoteCommand>();
        for (const cmd of commandQueueRef.current) {
            // For next/prev, only keep the last one to avoid skipping multiple tracks
            if (cmd.command === "next" || cmd.command === "prev") {
                commandsByType.set(cmd.command, cmd);
            } else {
                // For other commands, execute all
                commandsByType.set(`${cmd.command}-${Date.now()}`, cmd);
            }
        }

        // Clear queue before processing
        commandQueueRef.current = [];

        // Execute deduplicated commands
        for (const cmd of commandsByType.values()) {
            executeCommand(cmd);
        }

        isProcessingQueueRef.current = false;
    }, [executeCommand]);

    // Handle incoming remote commands - queue if loading, execute immediately otherwise
    const handleRemoteCommand = useCallback((command: RemoteCommand) => {
        const isLoading = howlerEngine.isCurrentlyLoading();
        const hasTrack = currentTrackRef.current !== null;

        console.log(`[RemoteIntegration] Received command: ${command.command}, isLoading=${isLoading}, hasTrack=${hasTrack}`);

        // Commands that should always execute immediately
        const immediateCommands = ["pause", "volume", "setQueue", "playTrack", "transferPlayback"];

        if (immediateCommands.includes(command.command)) {
            executeCommand(command);
            return;
        }

        // For play/next/prev: if loading OR no track loaded, queue the command
        if (isLoading || !hasTrack) {
            console.log(`[RemoteIntegration] Queueing ${command.command} - loading or no track`);
            commandQueueRef.current.push(command);

            // If no track and not loading, this might be a fresh page
            // Wait a bit for the queue/track to be set up
            if (!hasTrack && !isLoading) {
                setTimeout(() => {
                    if (currentTrackRef.current) {
                        processQueue();
                    }
                }, 500);
            }
            return;
        }

        // Execute immediately if loaded and has track
        executeCommand(command);
    }, [executeCommand, processQueue]);

    // Listen for load complete to process queued commands
    useEffect(() => {
        const handleLoad = () => {
            console.log("[RemoteIntegration] Audio loaded, processing queue");
            // Small delay to ensure state is fully updated
            setTimeout(() => {
                processQueue();
            }, 100);
        };

        howlerEngine.on("load", handleLoad);
        return () => {
            howlerEngine.off("load", handleLoad);
        };
    }, [processQueue]);

    // Register the command handler
    useEffect(() => {
        remote.setOnRemoteCommand(handleRemoteCommand);
    }, [remote, handleRemoteCommand]);

    // Note: Autoplay error toast is handled by HowlerAudioElement directly
    // This hook just clears the pending remote play ref on autoplay errors
    useEffect(() => {
        const handlePlayerError = (data: { error: any }) => {
            const errorMsg = String(data?.error || "");
            const isAutoplayError = errorMsg.includes("user interaction") ||
                errorMsg.includes("play()") ||
                errorMsg.includes("autoplay") ||
                errorMsg.includes("NotAllowedError");

            if (isAutoplayError) {
                // Clear pending remote play - toast is shown by HowlerAudioElement
                pendingRemotePlayRef.current = null;
            }
        };

        howlerEngine.on("playerror", handlePlayerError);

        return () => {
            howlerEngine.off("playerror", handlePlayerError);
        };
    }, []);

    // Register stop playback handler (when another device becomes active)
    useEffect(() => {
        remote.setOnStopPlayback(() => {
            console.log("[RemoteIntegration] Stopping local playback - another device is now active");
            // Pause through the controls context (updates state)
            controls.pause();
            // Also directly pause the audio engine to ensure immediate stop
            // This handles any timing issues with React state updates
            howlerEngine.pause();
        });
    }, [remote, controls]);

    // Register become active player handler
    useEffect(() => {
        remote.setOnBecomeActivePlayer(() => {
            console.log("[RemoteIntegration] This device is now the active player");
            // Resume playback if we were playing before
        });
    }, [remote]);

    // Track the last broadcast track ID to detect track changes
    const lastBroadcastTrackIdRef = useRef<string | null>(null);

    // Interval-based broadcast for continuous time updates when active player
    const broadcastIntervalRef = useRef<NodeJS.Timeout | null>(null);

    // Keep refs for values needed in interval callback to avoid stale closures
    const playbackRef = useRef(playback);
    const stateRef = useRef(state);
    playbackRef.current = playback;
    stateRef.current = state;

    useEffect(() => {
        // Only set up interval if this device is the active player
        const isActive = remote.getIsActivePlayer();

        if (isActive && remote.isConnected && playback.isPlaying) {
            // Broadcast every 1 second while playing
            broadcastIntervalRef.current = setInterval(() => {
                const currentPlayback = playbackRef.current;
                const currentState = stateRef.current;

                let currentTrack = null;
                if (currentState.playbackType === "track" && currentState.currentTrack) {
                    currentTrack = {
                        id: currentState.currentTrack.id,
                        title: currentState.currentTrack.title,
                        artist: currentState.currentTrack.artist?.name || "Unknown Artist",
                        album: currentState.currentTrack.album?.title || "Unknown Album",
                        coverArt: currentState.currentTrack.album?.coverArt,
                        duration: currentState.currentTrack.duration,
                    };
                }

                console.log(`[RemoteIntegration] Interval broadcast: time=${currentPlayback.currentTime.toFixed(1)}, playing=${currentPlayback.isPlaying}`);
                remote.broadcastState({
                    isPlaying: currentPlayback.isPlaying,
                    currentTrack,
                    currentTime: currentPlayback.currentTime,
                    volume: currentState.volume,
                });
            }, 1000);
        }

        return () => {
            if (broadcastIntervalRef.current) {
                clearInterval(broadcastIntervalRef.current);
                broadcastIntervalRef.current = null;
            }
        };
    }, [remote, playback.isPlaying]);

    // Broadcast state changes (debounced, but immediate for track changes)
    // IMPORTANT: Only the active player should broadcast its state
    useEffect(() => {
        // Only broadcast if connected AND this device is the active player
        if (!remote.isConnected) return;

        // Don't broadcast if we're not the active player - we'd be overwriting
        // the actual playing device's state with our stale local state
        const isActive = remote.getIsActivePlayer();
        console.log(`[RemoteIntegration] Broadcast check: isActive=${isActive}, currentTime=${playback.currentTime.toFixed(1)}, isPlaying=${playback.isPlaying}`);
        if (!isActive) {
            console.log("[RemoteIntegration] Skipping broadcast - not active player");
            return;
        }

        // Build current track info
        let currentTrack = null;
        if (state.playbackType === "track" && state.currentTrack) {
            currentTrack = {
                id: state.currentTrack.id,
                title: state.currentTrack.title,
                artist: state.currentTrack.artist?.name || "Unknown Artist",
                album: state.currentTrack.album?.title || "Unknown Album",
                coverArt: state.currentTrack.album?.coverArt,
                duration: state.currentTrack.duration,
            };
        }

        const currentTrackId = currentTrack?.id || null;
        const trackChanged = currentTrackId !== lastBroadcastTrackIdRef.current;

        // Create a state signature to avoid duplicate broadcasts
        // Include rounded currentTime (to nearest second) so time updates are broadcast
        const stateSignature = JSON.stringify({
            isPlaying: playback.isPlaying,
            trackId: currentTrackId,
            volume: state.volume,
            // Round to nearest second to throttle time updates to ~1/second
            currentTimeRounded: Math.floor(playback.currentTime),
        });

        if (stateSignature === lastBroadcastRef.current && !trackChanged) {
            return;
        }

        const doBroadcast = () => {
            lastBroadcastRef.current = stateSignature;
            lastBroadcastTrackIdRef.current = currentTrackId;
            console.log("[RemoteIntegration] Broadcasting state:", {
                trackId: currentTrackId,
                isPlaying: playback.isPlaying,
                currentTime: playback.currentTime.toFixed(1),
                volume: state.volume,
                trackChanged
            });
            remote.broadcastState({
                isPlaying: playback.isPlaying,
                currentTrack,
                currentTime: playback.currentTime,
                volume: state.volume,
            });
        };

        // If track changed, broadcast IMMEDIATELY (no debounce)
        if (trackChanged) {
            if (broadcastTimeoutRef.current) {
                clearTimeout(broadcastTimeoutRef.current);
            }
            doBroadcast();
            return;
        }

        // Debounce other updates (isPlaying, volume) to avoid flooding
        if (broadcastTimeoutRef.current) {
            clearTimeout(broadcastTimeoutRef.current);
        }

        broadcastTimeoutRef.current = setTimeout(doBroadcast, 500);

        return () => {
            if (broadcastTimeoutRef.current) {
                clearTimeout(broadcastTimeoutRef.current);
            }
        };
    }, [
        remote,
        playback.isPlaying,
        playback.currentTime,
        state.playbackType,
        state.currentTrack,
        state.volume,
    ]);

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            if (broadcastTimeoutRef.current) {
                clearTimeout(broadcastTimeoutRef.current);
            }
        };
    }, []);
}
