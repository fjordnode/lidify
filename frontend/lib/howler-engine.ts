/**
 * Howler.js Audio Engine
 *
 * Singleton manager for audio playback using Howler.js
 * Handles: play, pause, seek, volume, track changes, events
 */

import { Howl, type HowlOptions } from "howler";

export type HowlerEventType =
    | "play"
    | "pause"
    | "stop"
    | "end"
    | "seek"
    | "volume"
    | "load"
    | "loaderror"
    | "playerror"
    | "timeupdate";

export type HowlerEventCallback = (data?: unknown) => void;

interface HowlerEngineState {
    currentSrc: string | null;
    isPlaying: boolean;
    currentTime: number;
    duration: number;
    volume: number;
    isMuted: boolean;
}

interface HowlInternal extends Howl {
    _sounds?: Array<{ _node?: HTMLMediaElement }>;
    _format?: string[];
}

class HowlerEngine {
    private howl: Howl | null = null;
    private timeUpdateInterval: NodeJS.Timeout | null = null;
    private eventListeners: Map<HowlerEventType, Set<HowlerEventCallback>> =
        new Map();
    private state: HowlerEngineState = {
        currentSrc: null,
        isPlaying: false,
        currentTime: 0,
        duration: 0,
        volume: 1,
        isMuted: false,
    };
    private isLoading: boolean = false; // Guard against duplicate loads
    private userInitiatedPlay: boolean = false; // Track if play was user-initiated
    private pendingPlay: boolean = false; // Guard against multiple play() calls before audio starts
    private isChangingTrack: boolean = false; // Suppress errors during track changes
    private retryCount: number = 0; // Track retry attempts
    private maxRetries: number = 3; // Max retry attempts for load errors
    private pendingAutoplay: boolean = false; // Track pending autoplay for retries
    private lastFormat: string | undefined; // Store format for retries
    private readonly popFadeMs: number = 10; // ms - micro-fade to reduce click/pop on track changes
    private shouldRetryLoads: boolean = false; // Only retry transient load errors where it helps (Android WebView)
    private cleanupTimeoutId: NodeJS.Timeout | null = null; // Track cleanup timeout to prevent race conditions
    
    // Seek state management - prevents stale timeupdate events during seeks
    private isSeeking: boolean = false;
    private seekTargetTime: number | null = null;
    private seekTimeoutId: NodeJS.Timeout | null = null;

    constructor() {
        // Initialize event listener maps
        const events: HowlerEventType[] = [
            "play",
            "pause",
            "stop",
            "end",
            "seek",
            "volume",
            "load",
            "loaderror",
            "playerror",
            "timeupdate",
        ];
        events.forEach((event) => this.eventListeners.set(event, new Set()));
    }

    /**
     * Load and optionally play a new audio source
     * @param src - Audio URL
     * @param autoplay - Whether to auto-play after loading
     * @param format - Audio format hint (mp3, flac, etc.) - required for URLs without extensions
     */
    load(
        src: string,
        autoplay: boolean = false,
        format?: string,
        isRetry: boolean = false
    ): void {
        // Don't reload if same source and already loaded
        if (this.state.currentSrc === src && this.howl) {
            if (autoplay && !this.state.isPlaying) {
                this.play();
            }
            return;
        }

        // Prevent duplicate loads - if already loading this URL, skip
        if (this.isLoading && this.state.currentSrc === src) {
            return;
        }

        // Set loading guard immediately
        this.isLoading = true;

        // Simple instant switch - no crossfade (crossfade caused duplicate playback bugs)
        // Just stop current track and load new one
        this.cleanup();

        this.state.currentSrc = src;

        // Detect if running in Android WebView (for graceful degradation)
        const isAndroidWebView =
            typeof navigator !== "undefined" &&
            /wv/.test(navigator.userAgent.toLowerCase()) &&
            /android/.test(navigator.userAgent.toLowerCase());
        this.shouldRetryLoads = isAndroidWebView;

        // Check if this is a podcast/audiobook stream (they need HTML5 Audio for Range request support)
        const isPodcastOrAudiobook =
            src.includes("/api/podcasts/") || src.includes("/api/audiobooks/");

        // Build Howl config
        // Note: On Android WebView, HTML5 Audio causes crackling/popping on track changes
        // Use Web Audio API on Android for smoother playback (trades streaming for quality)
        // EXCEPTION: Podcasts always use HTML5 Audio because they need Range request support
        // for seeking in large files. Web Audio would try to download the entire ~100MB file.
        const howlConfig = {
            src: [src],
            html5: isPodcastOrAudiobook || !isAndroidWebView, // HTML5 for podcasts/audiobooks OR non-Android
            autoplay: false, // We'll handle autoplay manually
            preload: true,
            volume: this.state.isMuted ? 0 : this.state.volume,
            pool: 1, // Only allow one sound instance to prevent echo/double playback
            // On Android WebView, increase the xhr timeout
            ...(isAndroidWebView && { xhr: { timeout: 30000 } }),
        } as HowlOptions;

        // Store for potential retry
        this.pendingAutoplay = autoplay;
        this.lastFormat = format;
        // Reset retry count only when this is NOT a retry attempt.
        // If we reset on retries, we can end up in an infinite retry loop.
        if (!isRetry) {
            this.retryCount = 0;
        }

        // Add format hints (required for URLs without file extensions)
        // Include multiple formats as fallbacks - browser will try them in order
        if (format) {
            // Put the expected format first, then common fallbacks
            const formats = [format];
            if (!formats.includes("mp3")) formats.push("mp3");
            if (!formats.includes("flac")) formats.push("flac");
            if (!formats.includes("mp4")) formats.push("mp4");
            if (!formats.includes("webm")) formats.push("webm");
            howlConfig.format = formats;
        } else {
            // Default format order if none specified
            howlConfig.format = ["mp3", "flac", "mp4", "webm", "wav"];
        }

        console.log(`[HowlerEngine] Creating new Howl instance for: ${src.substring(0, 80)}...`);
        
        this.howl = new Howl({
            ...howlConfig,
            onload: () => {
                console.log(`[HowlerEngine] Loaded: ${this.state.currentSrc?.substring(0, 80)}...`);
                this.isLoading = false;
                this.isChangingTrack = false; // Clear flag only after successful load
                this.state.duration = this.howl?.duration() || 0;
                this.emit("load", { duration: this.state.duration });

                if (autoplay) {
                    this.play();
                }
            },
            onloaderror: (id, error) => {
                console.error(
                    "[HowlerEngine] Load error:",
                    error,
                    "Attempt:",
                    this.retryCount + 1
                );
                this.isLoading = false;

                // Retry logic for transient errors (common on Android WebView)
                if (
                    this.shouldRetryLoads &&
                    this.retryCount < this.maxRetries &&
                    this.state.currentSrc
                ) {
                    this.retryCount++;
                    console.log(
                        `[HowlerEngine] Retrying load (attempt ${this.retryCount}/${this.maxRetries})...`
                    );

                    // Save src before cleanup
                    const srcToRetry = this.state.currentSrc;
                    const autoplayToRetry = this.pendingAutoplay;
                    const formatToRetry = this.lastFormat;

                    // CRITICAL: Clean up the failed Howl instance BEFORE retrying
                    // This prevents "HTML5 Audio pool exhausted" errors
                    this.cleanup();

                    // Wait a bit before retrying
                    setTimeout(() => {
                        this.load(
                            srcToRetry,
                            autoplayToRetry,
                            formatToRetry,
                            true
                        );
                    }, 500 * this.retryCount); // Exponential backoff
                    return;
                }

                // All retries failed - clean up and emit error
                this.retryCount = 0;
                this.isChangingTrack = false; // Clear flag on load error
                this.cleanup(); // Clean up failed instance
                this.emit("loaderror", { error });
            },
            onplayerror: (id, error) => {
                // Ignore errors during track changes - they're stale from the old Howl
                if (this.isChangingTrack) {
                    console.log("[HowlerEngine] Ignoring play error during track change");
                    return;
                }
                
                console.error("[HowlerEngine] Play error:", error);
                // Clear playing state so UI shows play button
                this.state.isPlaying = false;
                this.pendingPlay = false; // Clear pending flag - play failed
                this.userInitiatedPlay = false;
                this.stopTimeUpdates();
                this.emit("playerror", { error });
                // Don't try to auto-recover - let the user click play again
                // The 'unlock' mechanism requires a NEW user interaction which won't happen automatically
            },
            onplay: () => {
                const sounds = this.getInternalHowl()?._sounds;
                console.log(
                    `[HowlerEngine] onplay event fired, sounds count: ${sounds?.length || 0}`
                );
                this.state.isPlaying = true;
                this.pendingPlay = false; // Clear pending flag - play succeeded
                this.userInitiatedPlay = false; // Clear flag after successful play
                this.startTimeUpdates();
                this.emit("play");
            },
            onpause: () => {
                this.state.isPlaying = false;
                this.pendingPlay = false; // Clear pending flag
                this.userInitiatedPlay = false;
                this.stopTimeUpdates();
                this.emit("pause");
            },
            onstop: () => {
                this.state.isPlaying = false;
                this.pendingPlay = false; // Clear pending flag
                this.state.currentTime = 0;
                this.stopTimeUpdates();
                this.emit("stop");
            },
            onend: () => {
                this.state.isPlaying = false;
                this.stopTimeUpdates();
                this.emit("end");
            },
            onseek: () => {
                if (this.howl) {
                    this.state.currentTime = this.howl.seek() as number;
                    this.emit("seek", { time: this.state.currentTime });
                }
            },
        });
    }

    /**
     * Play audio (user-initiated)
     */
    play(): void {
        if (!this.howl) {
            console.warn("[HowlerEngine] No audio loaded");
            return;
        }

        // Don't play if still loading - wait for onload
        if (this.isLoading) {
            console.log("[HowlerEngine] play() called but still loading, skipping");
            return;
        }

        // Don't play if already playing or if a play is already pending
        // This prevents double-play when multiple callers trigger play() simultaneously
        // (especially during loading when onplay hasn't fired yet)
        if (this.state.isPlaying || this.pendingPlay || this.howl.playing()) {
            console.log(`[HowlerEngine] play() called but already playing/pending, skipping (isPlaying=${this.state.isPlaying}, pendingPlay=${this.pendingPlay})`);
            return;
        }

        // Set pendingPlay BEFORE calling howl.play() to guard against rapid re-calls
        this.pendingPlay = true;
        
        const sounds = this.getInternalHowl()?._sounds;
        console.log(
            `[HowlerEngine] play() - starting playback (sounds: ${sounds?.length || 0})`
        );
        
        // Mark as user-initiated for autoplay recovery
        this.userInitiatedPlay = true;

        // Ensure volume is set correctly before playing
        const targetVolume = this.state.isMuted ? 0 : this.state.volume;
        this.howl.volume(targetVolume);
        
        // Always call play() without sound ID - let Howler manage it
        // Using specific sound IDs was causing issues with newly created Howl instances
        this.howl.play();
    }

    /**
     * Check if a play request is pending (audio loading, play called but not yet started)
     */
    isPendingPlay(): boolean {
        return this.pendingPlay;
    }

    /**
     * Pause audio
     */
    pause(): void {
        if (!this.howl || !this.state.isPlaying) return;
        this.howl.pause();
    }

    /**
     * Stop playback completely
     */
    stop(): void {
        if (!this.howl) return;
        this.howl.stop();
    }

    /**
     * Seek to a specific time
     * Includes seek locking to prevent stale timeupdate events from causing UI flicker
     */
    seek(time: number): void {
        if (!this.howl) return;

        // Set seek lock - this prevents timeupdate from emitting stale values
        this.isSeeking = true;
        this.seekTargetTime = time;

        // Clear any existing seek timeout
        if (this.seekTimeoutId) {
            clearTimeout(this.seekTimeoutId);
        }

        this.state.currentTime = time;
        this.howl.seek(time);
        this.emit("seek", { time });

        // Release seek lock after audio has time to sync
        // This timeout ensures timeupdate doesn't emit stale values during the seek operation
        this.seekTimeoutId = setTimeout(() => {
            this.isSeeking = false;
            this.seekTargetTime = null;
            this.seekTimeoutId = null;
        }, 300);
    }

    /**
     * Check if currently in a seek operation
     */
    isCurrentlySeeking(): boolean {
        return this.isSeeking;
    }

    /**
     * Get the target seek position (if seeking)
     */
    getSeekTarget(): number | null {
        return this.seekTargetTime;
    }

    /**
     * Force reload the audio from current source
     * Used after cache is ready to enable seeking
     */
    reload(): void {
        if (!this.state.currentSrc) return;

        const src = this.state.currentSrc;
        const format = this.getInternalHowl()?._format;

        this.cleanup();
        this.load(src, false, format?.[0]);
    }

    /**
     * Set volume (0-1)
     */
    setVolume(volume: number): void {
        this.state.volume = Math.max(0, Math.min(1, volume));

        if (this.howl && !this.state.isMuted) {
            this.howl.volume(this.state.volume);
        }

        this.emit("volume", { volume: this.state.volume });
    }

    /**
     * Mute/unmute
     */
    setMuted(muted: boolean): void {
        this.state.isMuted = muted;

        if (this.howl) {
            this.howl.volume(muted ? 0 : this.state.volume);
        }
    }

    /**
     * Get current playback state
     */
    getState(): Readonly<HowlerEngineState> {
        return { ...this.state };
    }

    /**
     * Get current time (from Howler's state)
     */
    getCurrentTime(): number {
        if (this.howl) {
            const seek = this.howl.seek();
            return typeof seek === "number" ? seek : 0;
        }
        return 0;
    }

    /**
     * Get the ACTUAL current time from the HTML5 audio element
     * This is more accurate than Howler's reported position after failed seeks
     */
    getActualCurrentTime(): number {
        if (!this.howl) return 0;

        try {
            // Access the underlying HTML5 audio element
            const sounds = this.getInternalHowl()?._sounds;
            if (sounds && sounds.length > 0 && sounds[0]._node) {
                return sounds[0]._node.currentTime || 0;
            }
        } catch (_e) {
            // Fallback to Howler's reported time
        }

        return this.getCurrentTime();
    }

    /**
     * Get duration
     */
    getDuration(): number {
        return this.howl?.duration() || 0;
    }

    /**
     * Check if currently playing
     */
    isPlaying(): boolean {
        return this.howl?.playing() || false;
    }

    /**
     * Check if currently loading audio
     */
    isCurrentlyLoading(): boolean {
        return this.isLoading;
    }

    /**
     * Check if audio is loaded and ready to play
     */
    isLoaded(): boolean {
        return this.howl !== null && !this.isLoading && this.state.duration > 0;
    }

    /**
     * Get current source URL
     */
    getCurrentSrc(): string | null {
        return this.state.currentSrc;
    }

    /**
     * Subscribe to events
     */
    on(event: HowlerEventType, callback: HowlerEventCallback): void {
        this.eventListeners.get(event)?.add(callback);
    }

    /**
     * Unsubscribe from events
     */
    off(event: HowlerEventType, callback: HowlerEventCallback): void {
        this.eventListeners.get(event)?.delete(callback);
    }

    /**
     * Emit event to all listeners
     */
    private getInternalHowl(): HowlInternal | null {
        return this.howl as HowlInternal | null;
    }

    private emit(event: HowlerEventType, data?: unknown): void {
        this.eventListeners.get(event)?.forEach((callback) => {
            try {
                callback(data);
            } catch (err) {
                console.error(
                    `[HowlerEngine] Event listener error (${event}):`,
                    err
                );
            }
        });
    }

    /**
     * Start time update interval
     */
    private startTimeUpdates(): void {
        this.stopTimeUpdates();

        this.timeUpdateInterval = setInterval(() => {
            if (this.howl && this.state.isPlaying) {
                const seek = this.howl.seek();
                if (typeof seek === "number") {
                    // During a seek operation, ignore timeupdate events that report stale positions
                    // This prevents the UI flicker where old position briefly shows during seek
                    if (this.isSeeking && this.seekTargetTime !== null) {
                        const isNearTarget = Math.abs(seek - this.seekTargetTime) < 2;
                        if (!isNearTarget) {
                            // Stale position - don't emit, use target instead
                            return;
                        }
                        // Position is near target, seek completed - clear seek state
                        this.isSeeking = false;
                        this.seekTargetTime = null;
                        if (this.seekTimeoutId) {
                            clearTimeout(this.seekTimeoutId);
                            this.seekTimeoutId = null;
                        }
                    }
                    
                    this.state.currentTime = seek;
                    this.emit("timeupdate", { time: seek });
                }
            }
        }, 250); // Update 4 times per second
    }

    /**
     * Stop time update interval
     */
    private stopTimeUpdates(): void {
        if (this.timeUpdateInterval) {
            clearInterval(this.timeUpdateInterval);
            this.timeUpdateInterval = null;
        }
    }

    /**
     * Cleanup current Howl instance
     */
    private cleanup(): void {
        console.log(`[HowlerEngine] cleanup() called, currentSrc: ${this.state.currentSrc?.substring(0, 50)}...`);
        
        // Mark that we're changing tracks - this suppresses stale errors from the old Howl
        this.isChangingTrack = true;
        
        this.stopTimeUpdates();

        // Cancel any pending cleanup timeout to prevent race conditions
        if (this.cleanupTimeoutId) {
            clearTimeout(this.cleanupTimeoutId);
            this.cleanupTimeoutId = null;
        }

        if (this.howl) {
            const oldHowl = this.howl;
            const internalOldHowl = oldHowl as HowlInternal;
            
            // Debug: check how many sounds exist
            const sounds = internalOldHowl._sounds;
            console.log(`[HowlerEngine] cleanup: ${sounds?.length || 0} sound(s) in Howl instance`);

            // Detach immediately so new loads don't race with cleanup.
            this.howl = null;

            try {
                // Always stop synchronously to prevent echo/double playback
                // The micro-fade caused race conditions where both old and new audio played
                oldHowl.stop();
                oldHowl.unload();
            } catch {
                // Ignore errors during cleanup
            }
        }

        // Note: Removed Howler.unload() - it was unloading ALL audio globally
        // which caused issues. Individual howl.unload() calls are sufficient.

        this.state.currentSrc = null;
        this.state.isPlaying = false;
        this.pendingPlay = false; // Clear pending flag on cleanup
        this.state.currentTime = 0;
        this.state.duration = 0;
    }

    /**
     * Destroy the engine completely
     */
    destroy(): void {
        this.cleanup();
        this.isLoading = false;
        this.eventListeners.clear();
        // Ensure cleanup timeout is cleared
        if (this.cleanupTimeoutId) {
            clearTimeout(this.cleanupTimeoutId);
            this.cleanupTimeoutId = null;
        }
        // Clear seek state
        if (this.seekTimeoutId) {
            clearTimeout(this.seekTimeoutId);
            this.seekTimeoutId = null;
        }
        this.isSeeking = false;
        this.seekTargetTime = null;
    }
}

// Export singleton instance
export const howlerEngine = new HowlerEngine();

// Also export class for testing
export { HowlerEngine };
