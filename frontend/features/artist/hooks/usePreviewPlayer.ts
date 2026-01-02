import { useState, useRef, useEffect, useCallback } from "react";
import { api } from "@/lib/api";
import { toast } from "sonner";
import { Track } from "../types";
import { howlerEngine } from "@/lib/howler-engine";

interface PreviewAlbumInfo {
    title: string;
    cover: string | null;
}

interface UsePreviewPlayerOptions {
    artistName?: string;
    tracks?: Track[];
}

export function usePreviewPlayer(options: UsePreviewPlayerOptions = {}) {
    const { artistName, tracks } = options;
    const [previewTrack, setPreviewTrack] = useState<string | null>(null);
    const [previewPlaying, setPreviewPlaying] = useState(false);
    const [previewAlbumInfo, setPreviewAlbumInfo] = useState<Record<string, PreviewAlbumInfo>>({});
    const [noPreviewTracks, setNoPreviewTracks] = useState<Set<string>>(new Set());
    const previewAudioRef = useRef<HTMLAudioElement | null>(null);
    const mainPlayerWasPausedRef = useRef(false);
    const previewRequestIdRef = useRef(0);
    const noPreviewTrackIdsRef = useRef<Set<string>>(new Set());
    const toastShownForNoPreviewRef = useRef<Set<string>>(new Set());
    const inFlightTrackIdRef = useRef<string | null>(null);

    const isAbortError = (err: unknown) => {
        if (!err || typeof err !== "object") return false;
        const e = err as Record<string, unknown>;
        const name = typeof e.name === "string" ? e.name : "";
        const code = typeof e.code === "number" ? e.code : undefined;
        const message = typeof e.message === "string" ? e.message : "";
        return (
            name === "AbortError" ||
            code === 20 ||
            message.includes("interrupted by a call to pause")
        );
    };

    const showNoPreviewToast = (trackId: string) => {
        if (toastShownForNoPreviewRef.current.has(trackId)) return;
        toastShownForNoPreviewRef.current.add(trackId);
        // Small, out-of-the-way notification (not an "error" state)
        toast("No Deezer preview available", { duration: 1500 });
    };

    async function handlePreview(
        track: Track,
        artistName: string,
        e: React.MouseEvent
    ) {
        e.stopPropagation();

        // If clicking the same track that's playing, pause it
        if (previewTrack === track.id && previewPlaying) {
            previewAudioRef.current?.pause();
            setPreviewPlaying(false);
            // Don't auto-resume main player - let user manually click play
            // This prevents the "pop in" effect when spam-clicking preview
            return;
        }

        // If clicking a different track, stop current and play new
        if (previewTrack !== track.id) {
            try {
                if (inFlightTrackIdRef.current === track.id) {
                    return;
                }
                if (noPreviewTrackIdsRef.current.has(track.id)) {
                    showNoPreviewToast(track.id);
                    return;
                }

                const requestId = ++previewRequestIdRef.current;
                inFlightTrackIdRef.current = track.id;

                const response = await api.getTrackPreview(
                    artistName,
                    track.title
                );
                if (requestId !== previewRequestIdRef.current) return;
                if (response.previewUrl) {
                    // Stop current preview if any
                    if (previewAudioRef.current) {
                        previewAudioRef.current.pause();
                        previewAudioRef.current = null;
                    }

                    // Pause the main player if it's playing
                    if (howlerEngine.isPlaying()) {
                        howlerEngine.pause();
                        mainPlayerWasPausedRef.current = true;
                    }

                    // Store album info from Deezer
                    if (response.albumTitle) {
                        setPreviewAlbumInfo(prev => ({
                            ...prev,
                            [track.id]: {
                                title: response.albumTitle!,
                                cover: response.albumCover || null,
                            }
                        }));
                    }

                    // Create new audio element
                    const audio = new Audio(response.previewUrl);
                    previewAudioRef.current = audio;
                    setPreviewTrack(track.id);

                    audio.onended = () => {
                        setPreviewPlaying(false);
                        setPreviewTrack(null);
                        // Don't auto-resume main player - let user manually click play
                        mainPlayerWasPausedRef.current = false;
                    };

                    audio.onerror = () => {
                        toast.error("Failed to load preview");
                        setPreviewPlaying(false);
                        setPreviewTrack(null);
                    };

                    try {
                        await audio.play();
                    } catch (err: unknown) {
                        // Common when user clicks quickly and we pause/replace audio.
                        // Treat AbortError as non-fatal and avoid console spam.
                        if (isAbortError(err)) return;
                        throw err;
                    }
                    setPreviewPlaying(true);
                } else {
                    noPreviewTrackIdsRef.current.add(track.id);
                    showNoPreviewToast(track.id);
                }
            } catch (error: unknown) {
                if (isAbortError(error)) return;
                if (
                    typeof error === "object" &&
                    error !== null &&
                    (((error as Record<string, unknown>).error as unknown) ===
                        "Preview not found" ||
                        /preview not found/i.test(
                            String(
                                (error as Record<string, unknown>).message || ""
                            )
                        ))
                ) {
                    noPreviewTrackIdsRef.current.add(track.id);
                    showNoPreviewToast(track.id);
                    return;
                }
                toast.error("Failed to load preview");
                console.error("Preview error:", error);
            } finally {
                if (inFlightTrackIdRef.current === track.id) {
                    inFlightTrackIdRef.current = null;
                }
            }
        } else {
            // Resume paused preview
            try {
                await previewAudioRef.current?.play();
            } catch (err: unknown) {
                if (isAbortError(err)) return;
                console.error("Preview error:", err);
            }
            setPreviewPlaying(true);
        }
    }

    // Stop preview when main player starts playing
    useEffect(() => {
        const stopPreview = () => {
            if (previewAudioRef.current) {
                previewAudioRef.current.pause();
                previewAudioRef.current = null;
                setPreviewPlaying(false);
                setPreviewTrack(null);
                // Don't resume main player - it's already playing
                mainPlayerWasPausedRef.current = false;
            }
        };

        howlerEngine.on("play", stopPreview);
        return () => {
            howlerEngine.off("play", stopPreview);
        };
    }, []);

    // Cleanup preview on unmount
    useEffect(() => {
        return () => {
            if (previewAudioRef.current) {
                previewAudioRef.current.pause();
                previewAudioRef.current = null;
            }
        };
    }, []);

    // Prefetch album info for unowned tracks (runs once after page load)
    useEffect(() => {
        if (!artistName || !tracks || tracks.length === 0) return;

        // Find unowned tracks that need album info
        const unownedTracks = tracks.filter(track => {
            const isUnowned = !track.album?.id ||
                              !track.album?.title ||
                              track.album.title === "Unknown Album";
            const alreadyFetched = previewAlbumInfo[track.id];
            return isUnowned && !alreadyFetched;
        });

        if (unownedTracks.length === 0) return;

        // Prefetch in background (don't block UI)
        const prefetchAlbumInfo = async () => {
            // Fetch sequentially with small delay to avoid rate limiting
            for (const track of unownedTracks.slice(0, 5)) { // Limit to first 5
                try {
                    const response = await api.getTrackPreview(artistName, track.title);
                    if (response.albumTitle) {
                        setPreviewAlbumInfo(prev => ({
                            ...prev,
                            [track.id]: {
                                title: response.albumTitle!,
                                cover: response.albumCover || null,
                            }
                        }));
                    } else {
                        // No preview available
                        setNoPreviewTracks(prev => new Set(prev).add(track.id));
                        noPreviewTrackIdsRef.current.add(track.id);
                    }
                } catch {
                    // API error - mark as no preview
                    setNoPreviewTracks(prev => new Set(prev).add(track.id));
                    noPreviewTrackIdsRef.current.add(track.id);
                }
                // Small delay between requests
                await new Promise(r => setTimeout(r, 100));
            }
        };

        // Delay prefetch to not block initial page render
        const timeoutId = setTimeout(prefetchAlbumInfo, 500);
        return () => clearTimeout(timeoutId);
    }, [artistName, tracks]); // Only run when artist/tracks change

    return { previewTrack, previewPlaying, previewAlbumInfo, noPreviewTracks, handlePreview };
}
