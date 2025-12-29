"use client";

import { useEffect, useRef, useCallback } from "react";
import { useRemotePlayback } from "@/lib/remote-playback-context";
import { useRemoteAwareAudioControls } from "@/lib/remote-aware-audio-controls-context";

/**
 * RemoteVolumeCapture - Captures hardware volume button presses when controlling a remote device
 *
 * Problem: When controlling a remote device, hardware volume buttons on mobile don't do anything
 * because there's no local audio playing.
 *
 * Solution: Play a silent audio loop when controlling remotely. This lets us:
 * 1. Capture volume changes from hardware buttons
 * 2. Forward them to the remote player
 *
 * The audio is completely silent (generated silence) so it doesn't interfere with anything.
 */
export function RemoteVolumeCapture() {
    const { isActivePlayer, activePlayerId, activePlayerState } = useRemotePlayback();
    const { setVolume } = useRemoteAwareAudioControls();

    const audioRef = useRef<HTMLAudioElement | null>(null);
    const audioContextRef = useRef<AudioContext | null>(null);
    const lastVolumeRef = useRef<number>(1);
    const isCapturingRef = useRef(false);

    // Create silent audio source
    const createSilentAudio = useCallback(() => {
        if (audioContextRef.current) return;

        try {
            const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
            audioContextRef.current = audioContext;

            // Create a silent oscillator (or use a buffer of silence)
            const oscillator = audioContext.createOscillator();
            const gainNode = audioContext.createGain();

            // Set gain to 0 - completely silent
            gainNode.gain.value = 0;

            oscillator.connect(gainNode);
            gainNode.connect(audioContext.destination);

            oscillator.start();

            console.log("[RemoteVolumeCapture] Silent audio context created");
        } catch (err) {
            console.error("[RemoteVolumeCapture] Failed to create audio context:", err);
        }
    }, []);

    // Handle volume change from hardware buttons
    const handleVolumeChange = useCallback(() => {
        if (!audioRef.current || !isCapturingRef.current) return;

        const newVolume = audioRef.current.volume;

        // Only forward if volume actually changed
        if (Math.abs(newVolume - lastVolumeRef.current) > 0.01) {
            console.log(`[RemoteVolumeCapture] Volume changed: ${lastVolumeRef.current.toFixed(2)} -> ${newVolume.toFixed(2)}`);
            lastVolumeRef.current = newVolume;
            setVolume(newVolume);
        }
    }, [setVolume]);

    useEffect(() => {
        // Only capture volume when:
        // 1. We're NOT the active player (controlling remotely)
        // 2. There IS an active player to control
        // 3. The remote device is playing something
        const shouldCapture = !isActivePlayer && !!activePlayerId && !!activePlayerState?.currentTrack;

        if (shouldCapture && !isCapturingRef.current) {
            console.log("[RemoteVolumeCapture] Starting volume capture for remote control");
            isCapturingRef.current = true;

            // Create audio element for volume capture
            if (!audioRef.current) {
                const audio = document.createElement("audio");
                audio.id = "remote-volume-capture";

                // Use a data URI for a tiny silent audio file
                // This is a minimal valid MP3 file that's silent
                audio.src = "data:audio/mp3;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4Ljc2LjEwMAAAAAAAAAAAAAAA//tQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWGluZwAAAA8AAAACAAABhgC7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7//////////////////////////////////////////////////////////////////8AAAAATGF2YzU4LjEzAAAAAAAAAAAAAAAAJAAAAAAAAAAAAYYoRwmHAAAAAAD/+1DEAAAGAAGn9AAAIgAANP8AAABMQcM5deyAq23QIIAcOpLy5JocAMgCmBIHCZd1j8P1j8P1j8P1j8P1jw/AAPn/3fBw/ygfb4f//6gfVDmf/+CD4Pgh//0HygICAIAg4P/6wfygICAIP/WD7+XB8HwfB///1g+7lg+D4Pg//+oHyQEB+sH/Wf/yQPPg+sH21h+CAgyD/rP/5QH1QEQCIElgV1k+KGYLsBrNmzj28bFiy+DmSOmLBAkXLh0/HjZ2dnMkZEgQJFw6fjxo0T7Z0Q==";
                audio.loop = true;
                audio.volume = activePlayerState?.volume ?? 1;
                lastVolumeRef.current = audio.volume;

                // Listen for volume changes (from hardware buttons)
                audio.addEventListener("volumechange", handleVolumeChange);

                audioRef.current = audio;

                // Start playing (silent)
                audio.play().catch(err => {
                    console.log("[RemoteVolumeCapture] Autoplay blocked, will retry on interaction:", err.message);
                });
            }

            // Also create AudioContext for browsers that need it
            createSilentAudio();

        } else if (!shouldCapture && isCapturingRef.current) {
            console.log("[RemoteVolumeCapture] Stopping volume capture");
            isCapturingRef.current = false;

            // Clean up audio element
            if (audioRef.current) {
                audioRef.current.pause();
                audioRef.current.removeEventListener("volumechange", handleVolumeChange);
                audioRef.current = null;
            }

            // Clean up audio context
            if (audioContextRef.current) {
                audioContextRef.current.close().catch(() => {});
                audioContextRef.current = null;
            }
        }

        // Sync volume with remote player's volume
        if (audioRef.current && activePlayerState?.volume !== undefined) {
            const remoteVolume = activePlayerState.volume;
            if (Math.abs(audioRef.current.volume - remoteVolume) > 0.01) {
                // Don't trigger our own handler
                audioRef.current.removeEventListener("volumechange", handleVolumeChange);
                audioRef.current.volume = remoteVolume;
                lastVolumeRef.current = remoteVolume;
                audioRef.current.addEventListener("volumechange", handleVolumeChange);
            }
        }

        return () => {
            // Cleanup on unmount
            if (audioRef.current) {
                audioRef.current.pause();
                audioRef.current.removeEventListener("volumechange", handleVolumeChange);
                audioRef.current = null;
            }
            if (audioContextRef.current) {
                audioContextRef.current.close().catch(() => {});
                audioContextRef.current = null;
            }
        };
    }, [isActivePlayer, activePlayerId, activePlayerState?.currentTrack, activePlayerState?.volume, handleVolumeChange, createSilentAudio]);

    // This component renders nothing - it just captures volume
    return null;
}
