"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import Image from "next/image";
import Link from "next/link";
import { Sparkles, Play, Pause, RefreshCw, Music, ChevronDown, ChevronUp, Disc3 } from "lucide-react";
import { api } from "@/lib/api";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import { cn } from "@/utils/cn";
import { toast } from "sonner";
import { howlerEngine } from "@/lib/howler-engine";

interface AIArtist {
    artistName: string;
    reason: string;
    startWith?: string;
}

interface AIWeeklyData {
    artists: AIArtist[];
    totalPlays: number;
    topArtists: { name: string; playCount: number; genres: string[] }[];
    period: string;
    generatedAt: string;
}

interface ArtistDetails {
    image: string | null;
    topTracks: Array<{
        title: string;  // Backend returns 'title', not 'name'
        playCount?: number;
    }>;
}

interface TrackPreview {
    previewUrl: string | null;
    albumCover: string | null;
    albumTitle: string | null;
}

const CACHE_KEY = "lidify_ai_weekly_artists_cache";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function getCachedData(): AIWeeklyData | null {
    if (typeof window === "undefined") return null;
    try {
        const cached = localStorage.getItem(CACHE_KEY);
        if (!cached) return null;
        const { data, timestamp } = JSON.parse(cached);
        if (Date.now() - timestamp > CACHE_TTL_MS) {
            localStorage.removeItem(CACHE_KEY);
            return null;
        }
        return data;
    } catch {
        return null;
    }
}

function setCachedData(data: AIWeeklyData) {
    if (typeof window === "undefined") return;
    try {
        localStorage.setItem(CACHE_KEY, JSON.stringify({ data, timestamp: Date.now() }));
    } catch {
        // Ignore storage errors
    }
}

export default function AIWeeklyPage() {
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [data, setData] = useState<AIWeeklyData | null>(null);

    // Artist details (fetched on expand)
    const [artistDetails, setArtistDetails] = useState<Record<string, ArtistDetails>>({});
    const [expandedArtist, setExpandedArtist] = useState<string | null>(null);
    const [loadingArtist, setLoadingArtist] = useState<string | null>(null);

    // Preview state
    const [previewingTrack, setPreviewingTrack] = useState<string | null>(null); // "artistName:trackTitle"
    const [previewPlaying, setPreviewPlaying] = useState(false);
    const [trackPreviews, setTrackPreviews] = useState<Record<string, TrackPreview>>({});
    const [loadingPreview, setLoadingPreview] = useState<string | null>(null);
    const audioRef = useRef<HTMLAudioElement | null>(null);
    const noPreviewSet = useRef<Set<string>>(new Set());

    // Load cached data on mount and fetch artist images
    useEffect(() => {
        const cached = getCachedData();
        if (cached) {
            setData(cached);
            // Fetch artist images in background
            fetchArtistImages(cached.artists);
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Stop preview when main player starts
    useEffect(() => {
        const stopPreview = () => {
            if (audioRef.current) {
                audioRef.current.pause();
                audioRef.current = null;
                setPreviewPlaying(false);
                setPreviewingTrack(null);
            }
        };
        howlerEngine.on("play", stopPreview);
        return () => {
            howlerEngine.off("play", stopPreview);
            if (audioRef.current) {
                audioRef.current.pause();
                audioRef.current = null;
            }
        };
    }, []);

    const handleGenerate = async (forceRefresh = false) => {
        if (!forceRefresh) {
            const cached = getCachedData();
            if (cached) {
                setData(cached);
                return;
            }
        }

        setLoading(true);
        setError(null);
        setExpandedArtist(null);
        setArtistDetails({});
        setTrackPreviews({});
        noPreviewSet.current.clear();
        if (audioRef.current) {
            audioRef.current.pause();
            audioRef.current = null;
        }

        try {
            const result = await api.getAIWeeklyArtists(7);
            setData(result);
            setCachedData(result);

            // Fetch artist images in parallel (background, doesn't block UI)
            fetchArtistImages(result.artists);
        } catch (err: any) {
            setError(err.data?.message || err.message || "Failed to generate");
        } finally {
            setLoading(false);
        }
    };

    // Fetch artist images only (lightweight, fast)
    const fetchArtistImages = async (artists: AIArtist[]) => {
        const results = await Promise.allSettled(
            artists.map(async (artist) => {
                try {
                    const { image } = await api.getArtistImage(artist.artistName);
                    return { artistName: artist.artistName, image };
                } catch {
                    return { artistName: artist.artistName, image: null };
                }
            })
        );

        // Update artist details with images only (preserve existing topTracks if any)
        setArtistDetails(prev => {
            const updated = { ...prev };
            for (const result of results) {
                if (result.status === "fulfilled") {
                    const existing = updated[result.value.artistName];
                    updated[result.value.artistName] = {
                        image: result.value.image,
                        topTracks: existing?.topTracks || [],
                    };
                }
            }
            return updated;
        });
    };

    const handleExpandArtist = useCallback(async (artistName: string) => {
        // Toggle collapse
        if (expandedArtist === artistName) {
            setExpandedArtist(null);
            return;
        }

        setExpandedArtist(artistName);

        // Check if we already have top tracks cached
        const existing = artistDetails[artistName];
        if (existing?.topTracks && existing.topTracks.length > 0) {
            return; // Already have full details
        }

        // Fetch artist details (top tracks)
        setLoadingArtist(artistName);
        try {
            const details = await api.getArtistDiscovery(artistName);
            const topTracks = details.topTracks || [];

            setArtistDetails(prev => ({
                ...prev,
                [artistName]: {
                    image: existing?.image || details.image || null,
                    topTracks,
                }
            }));

            // Fetch album art for all tracks in parallel (background, doesn't block UI)
            if (topTracks.length > 0) {
                const trackResults = await Promise.allSettled(
                    topTracks.slice(0, 5).map(async (track: any) => {
                        try {
                            const response = await api.getTrackPreview(artistName, track.title);
                            return {
                                trackKey: `${artistName}:${track.title}`,
                                info: {
                                    previewUrl: response.previewUrl || null,
                                    albumCover: response.albumCover || null,
                                    albumTitle: response.albumTitle || null,
                                }
                            };
                        } catch {
                            return {
                                trackKey: `${artistName}:${track.title}`,
                                info: { previewUrl: null, albumCover: null, albumTitle: null }
                            };
                        }
                    })
                );

                // Update track previews state
                const newPreviews: Record<string, TrackPreview> = {};
                for (const result of trackResults) {
                    if (result.status === "fulfilled") {
                        newPreviews[result.value.trackKey] = result.value.info;
                        if (!result.value.info.previewUrl) {
                            noPreviewSet.current.add(result.value.trackKey);
                        }
                    }
                }
                setTrackPreviews(prev => ({ ...prev, ...newPreviews }));
            }
        } catch (err) {
            console.error(`Failed to load artist details for ${artistName}:`, err);
            setArtistDetails(prev => ({
                ...prev,
                [artistName]: { image: existing?.image || null, topTracks: [] }
            }));
        } finally {
            setLoadingArtist(null);
        }
    }, [expandedArtist, artistDetails]);

    const handlePreview = useCallback(async (artistName: string, trackTitle: string) => {
        const trackKey = `${artistName}:${trackTitle}`;

        // If clicking same track that's playing, pause it
        if (previewingTrack === trackKey && previewPlaying) {
            audioRef.current?.pause();
            setPreviewPlaying(false);
            return;
        }

        // If clicking same track that's paused, resume it
        if (previewingTrack === trackKey && !previewPlaying && audioRef.current) {
            try {
                await audioRef.current.play();
                setPreviewPlaying(true);
            } catch {
                // Ignore
            }
            return;
        }

        // Check if we already know this track has no preview
        if (noPreviewSet.current.has(trackKey)) {
            toast("No Deezer preview available", { duration: 1500 });
            return;
        }

        // Stop current preview
        if (audioRef.current) {
            audioRef.current.pause();
            audioRef.current = null;
        }

        // Check if we already have preview info cached
        const cached = trackPreviews[trackKey];
        if (cached) {
            if (!cached.previewUrl) {
                toast("No Deezer preview available", { duration: 1500 });
                return;
            }
            // Play cached preview
            if (howlerEngine.isPlaying()) {
                howlerEngine.pause();
            }
            const audio = new Audio(cached.previewUrl);
            audioRef.current = audio;
            setPreviewingTrack(trackKey);
            audio.onended = () => {
                setPreviewPlaying(false);
                setPreviewingTrack(null);
            };
            try {
                await audio.play();
                setPreviewPlaying(true);
            } catch {
                // Ignore abort errors
            }
            return;
        }

        // Fetch preview from Deezer
        setLoadingPreview(trackKey);
        try {
            const response = await api.getTrackPreview(artistName, trackTitle);
            const info: TrackPreview = {
                previewUrl: response.previewUrl || null,
                albumCover: response.albumCover || null,
                albumTitle: response.albumTitle || null,
            };
            setTrackPreviews(prev => ({ ...prev, [trackKey]: info }));

            if (!info.previewUrl) {
                noPreviewSet.current.add(trackKey);
                toast("No Deezer preview available", { duration: 1500 });
                return;
            }

            // Pause main player if playing
            if (howlerEngine.isPlaying()) {
                howlerEngine.pause();
            }

            const audio = new Audio(info.previewUrl);
            audioRef.current = audio;
            setPreviewingTrack(trackKey);

            audio.onended = () => {
                setPreviewPlaying(false);
                setPreviewingTrack(null);
            };

            await audio.play();
            setPreviewPlaying(true);
        } catch (err: any) {
            if (err?.error === "Preview not found" || /preview not found/i.test(err?.message || "")) {
                noPreviewSet.current.add(trackKey);
                setTrackPreviews(prev => ({ ...prev, [trackKey]: { previewUrl: null, albumCover: null, albumTitle: null } }));
                toast("No Deezer preview available", { duration: 1500 });
            } else {
                toast.error("Failed to load preview");
            }
        } finally {
            setLoadingPreview(null);
        }
    }, [previewingTrack, previewPlaying, trackPreviews]);

    const formatTimeSince = (isoDate: string) => {
        const hours = Math.floor((Date.now() - new Date(isoDate).getTime()) / (1000 * 60 * 60));
        if (hours < 1) return "just now";
        if (hours === 1) return "1 hour ago";
        if (hours < 24) return `${hours} hours ago`;
        return "yesterday";
    };

    return (
        <div className="min-h-screen">
            {/* Hero Section */}
            <div
                className="relative pt-16 pb-10 px-4 md:px-8"
                style={{
                    background: 'linear-gradient(to bottom, rgba(147, 51, 234, 0.4), #1a1a1a, transparent)'
                }}
            >
                <div className="flex items-end gap-6">
                    {/* Icon */}
                    <div className="w-[140px] h-[140px] md:w-[192px] md:h-[192px] bg-gradient-to-br from-purple-600 to-purple-900 rounded shadow-2xl shrink-0 flex items-center justify-center">
                        <Sparkles className="w-20 h-20 md:w-24 md:h-24 text-white" />
                    </div>

                    {/* Info */}
                    <div className="flex-1 min-w-0 pb-1">
                        <p className="text-xs font-medium text-white/90 mb-1">AI Discovery</p>
                        <h1 className="text-2xl md:text-4xl lg:text-5xl font-bold text-white leading-tight mb-2">
                            AI Weekly
                        </h1>
                        <p className="text-sm text-white/60 mb-2">
                            New artists recommended based on your listening
                        </p>
                        {data && (
                            <div className="flex items-center gap-1 text-sm text-white/70">
                                <span>{data.artists.length} artists</span>
                                <span>·</span>
                                <span>Based on {data.totalPlays} plays</span>
                                <span>·</span>
                                <span>Generated {formatTimeSince(data.generatedAt)}</span>
                            </div>
                        )}
                    </div>
                </div>
            </div>

            {/* Action Bar */}
            <div className="bg-gradient-to-b from-[#1a1a1a]/60 to-transparent px-4 md:px-8 py-4">
                <div className="flex items-center gap-4">
                    {!data ? (
                        <button
                            onClick={() => handleGenerate(false)}
                            disabled={loading}
                            className="px-6 py-3 bg-purple-600 hover:bg-purple-500 text-white font-semibold rounded-full transition-colors disabled:opacity-50"
                        >
                            {loading ? "Generating..." : "Discover Artists"}
                        </button>
                    ) : (
                        <button
                            onClick={() => handleGenerate(true)}
                            disabled={loading}
                            className="flex items-center gap-2 h-10 px-4 rounded-full text-sm font-medium bg-white/5 hover:bg-white/10 text-white/80 hover:text-white transition-all disabled:opacity-50"
                        >
                            <RefreshCw className={cn("w-4 h-4", loading && "animate-spin")} />
                            <span>Regenerate</span>
                        </button>
                    )}
                </div>
                {error && <p className="text-red-400 mt-3 text-sm">{error}</p>}
            </div>

            {/* Loading State */}
            {loading && !data && (
                <div className="flex flex-col items-center justify-center py-24">
                    <GradientSpinner size="lg" />
                    <p className="text-gray-400 mt-4">Analyzing your listening history...</p>
                    <p className="text-gray-500 text-sm mt-1">Finding artists you'll love</p>
                </div>
            )}

            {/* Artist List */}
            {data && data.artists.length > 0 && (
                <div className="px-4 md:px-8 pb-32">
                    {/* Top Artists Context */}
                    <div className="mb-4 text-sm text-gray-400">
                        Because you listen to: {data.topArtists.map(a => a.name).join(", ")}
                    </div>

                    <div className="space-y-3">
                        {data.artists.map((artist, idx) => {
                            const details = artistDetails[artist.artistName];
                            const isExpanded = expandedArtist === artist.artistName;
                            const isLoadingDetails = loadingArtist === artist.artistName;

                            return (
                                <div
                                    key={idx}
                                    className="bg-white/5 rounded-lg overflow-hidden"
                                >
                                    {/* Artist Header */}
                                    <button
                                        onClick={() => handleExpandArtist(artist.artistName)}
                                        className="w-full flex items-center gap-4 p-4 hover:bg-white/5 transition-colors text-left"
                                    >
                                        {/* Artist Image */}
                                        <div className="w-16 h-16 bg-[#282828] rounded-full shrink-0 overflow-hidden">
                                            {details?.image ? (
                                                <Image
                                                    src={details.image}
                                                    alt={artist.artistName}
                                                    width={64}
                                                    height={64}
                                                    className="w-full h-full object-cover"
                                                    unoptimized
                                                />
                                            ) : (
                                                <div className="w-full h-full flex items-center justify-center">
                                                    <Music className="w-6 h-6 text-gray-600" />
                                                </div>
                                            )}
                                        </div>

                                        {/* Artist Info */}
                                        <div className="flex-1 min-w-0">
                                            <div className="flex items-center gap-2">
                                                <p className="text-lg font-semibold text-white truncate">
                                                    {artist.artistName}
                                                </p>
                                                <Link
                                                    href={`/search?q=${encodeURIComponent(artist.artistName)}`}
                                                    className="text-xs text-purple-400 hover:text-purple-300 shrink-0"
                                                    onClick={(e) => e.stopPropagation()}
                                                >
                                                    View →
                                                </Link>
                                            </div>
                                            <p className="text-sm text-gray-400 line-clamp-2">
                                                {artist.reason}
                                            </p>
                                            {artist.startWith && (
                                                <p className="text-xs text-purple-400 mt-1 flex items-center gap-1">
                                                    <Disc3 className="w-3 h-3" />
                                                    Start with: {artist.startWith}
                                                </p>
                                            )}
                                        </div>

                                        {/* Expand Icon */}
                                        <div className="shrink-0">
                                            {isLoadingDetails ? (
                                                <div className="w-5 h-5 border-2 border-gray-400 border-t-transparent rounded-full animate-spin" />
                                            ) : isExpanded ? (
                                                <ChevronUp className="w-5 h-5 text-gray-400" />
                                            ) : (
                                                <ChevronDown className="w-5 h-5 text-gray-400" />
                                            )}
                                        </div>
                                    </button>

                                    {/* Expanded Top Tracks */}
                                    {isExpanded && details && (
                                        <div className="border-t border-white/10 px-4 pb-4">
                                            <div className="pt-3 pb-2">
                                                <p className="text-xs text-gray-500 uppercase tracking-wider">Popular Tracks</p>
                                            </div>

                                            {isLoadingDetails ? (
                                                <div className="flex items-center justify-center py-4">
                                                    <div className="w-5 h-5 border-2 border-purple-400 border-t-transparent rounded-full animate-spin" />
                                                    <span className="ml-2 text-sm text-gray-400">Loading tracks...</span>
                                                </div>
                                            ) : details.topTracks.length > 0 ? (
                                                <div className="space-y-1">
                                                    {details.topTracks.slice(0, 5).map((track, trackIdx) => {
                                                        const trackKey = `${artist.artistName}:${track.title}`;
                                                        const isThisPlaying = previewingTrack === trackKey;
                                                        const isLoading = loadingPreview === trackKey;
                                                        const preview = trackPreviews[trackKey];

                                                        return (
                                                            <div
                                                                key={trackIdx}
                                                                className={cn(
                                                                    "flex items-center gap-3 p-2 rounded hover:bg-white/5 transition-colors group",
                                                                    isThisPlaying && "bg-white/10"
                                                                )}
                                                            >
                                                                {/* Track Number */}
                                                                <span className={cn(
                                                                    "w-5 text-center text-sm",
                                                                    isThisPlaying ? "text-purple-400" : "text-gray-500"
                                                                )}>
                                                                    {isThisPlaying && previewPlaying ? (
                                                                        <Music className="w-4 h-4 text-purple-400 animate-pulse inline" />
                                                                    ) : (
                                                                        trackIdx + 1
                                                                    )}
                                                                </span>

                                                                {/* Album Art (if loaded) */}
                                                                <div className="w-8 h-8 bg-[#282828] rounded shrink-0 overflow-hidden">
                                                                    {preview?.albumCover ? (
                                                                        <Image
                                                                            src={preview.albumCover}
                                                                            alt=""
                                                                            width={32}
                                                                            height={32}
                                                                            className="w-full h-full object-cover"
                                                                            unoptimized
                                                                        />
                                                                    ) : (
                                                                        <div className="w-full h-full flex items-center justify-center">
                                                                            <Music className="w-3 h-3 text-gray-600" />
                                                                        </div>
                                                                    )}
                                                                </div>

                                                                {/* Track Info */}
                                                                <div className="flex-1 min-w-0">
                                                                    <p className={cn(
                                                                        "text-sm truncate",
                                                                        isThisPlaying ? "text-purple-400" : "text-white"
                                                                    )}>
                                                                        {track.title}
                                                                    </p>
                                                                    {preview?.albumTitle && (
                                                                        <p className="text-xs text-gray-500 truncate">
                                                                            {preview.albumTitle}
                                                                        </p>
                                                                    )}
                                                                </div>

                                                                {/* Play Button */}
                                                                <button
                                                                    onClick={(e) => {
                                                                        e.stopPropagation();
                                                                        handlePreview(artist.artistName, track.title);
                                                                    }}
                                                                    disabled={isLoading}
                                                                    className={cn(
                                                                        "p-2 rounded-full transition-all",
                                                                        isThisPlaying
                                                                            ? "bg-purple-600/30 text-purple-400"
                                                                            : "hover:bg-white/10 text-gray-400 hover:text-white",
                                                                        isLoading && "opacity-50"
                                                                    )}
                                                                    title="Play Deezer preview"
                                                                >
                                                                    {isLoading ? (
                                                                        <div className="w-4 h-4 border-2 border-gray-400 border-t-transparent rounded-full animate-spin" />
                                                                    ) : isThisPlaying && previewPlaying ? (
                                                                        <Pause className="w-4 h-4" />
                                                                    ) : (
                                                                        <Play className="w-4 h-4" />
                                                                    )}
                                                                </button>
                                                            </div>
                                                        );
                                                    })}
                                                </div>
                                            ) : (
                                                <p className="text-sm text-gray-500 py-2">No tracks available</p>
                                            )}
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}

            {/* Empty State */}
            {!loading && !data && (
                <div className="flex flex-col items-center justify-center py-24 text-center px-4">
                    <div className="w-20 h-20 bg-purple-600/20 rounded-full flex items-center justify-center mb-4">
                        <Sparkles className="w-10 h-10 text-purple-400" />
                    </div>
                    <h3 className="text-lg font-medium text-white mb-1">Discover New Artists</h3>
                    <p className="text-sm text-gray-500 max-w-md">
                        AI will analyze your listening history from the past 7 days and recommend
                        new artists you might enjoy. Tap any artist to preview their top tracks.
                    </p>
                </div>
            )}
        </div>
    );
}
