"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import Image from "next/image";
import Link from "next/link";
import { Music2, Play, Pause, RefreshCw, Music, ChevronDown, ChevronUp, Disc3, ExternalLink } from "lucide-react";
import { api } from "@/lib/api";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import { cn } from "@/utils/cn";
import { toast } from "sonner";
import { howlerEngine } from "@/lib/howler-engine";

interface ArtistRecommendation {
    artistName: string;
    artistMbid?: string;
    albumTitle: string;   // Now empty string ""
    albumMbid: string;    // Now empty string ""
    similarity: number;
    coverUrl?: string;    // Artist image from Last.fm
    listeners?: number;   // Last.fm listener count
    tags?: string[];      // Genre tags like ["rock", "indie", "alternative"]
    bio?: string;
    reason?: string;      // AI-generated explanation of why this artist was recommended
}

interface RecommendationsData {
    recommendations: ArtistRecommendation[];
    seedArtists: string[];
    generatedAt: string;
}

interface ArtistDetails {
    image: string | null;
    mbid: string | null;
    topTracks: Array<{
        title: string;
        playCount?: number;
    }>;
}

interface TrackPreview {
    previewUrl: string | null;
    albumCover: string | null;
    albumTitle: string | null;
}

// Cache helpers
const CACHE_KEY = "lidify_lastfm_recommendations";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function getCachedData(): RecommendationsData | null {
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

function setCachedData(data: RecommendationsData) {
    if (typeof window === "undefined") return;
    try {
        localStorage.setItem(CACHE_KEY, JSON.stringify({ data, timestamp: Date.now() }));
    } catch {
        // Ignore storage errors
    }
}

export default function RecommendationsPage() {
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [data, setData] = useState<RecommendationsData | null>(null);

    // Artist details (fetched on expand)
    const [artistDetails, setArtistDetails] = useState<Record<string, ArtistDetails>>({});
    const [expandedAlbum, setExpandedAlbum] = useState<string | null>(null);
    const [loadingArtist, setLoadingArtist] = useState<string | null>(null);

    // Preview state
    const [previewingTrack, setPreviewingTrack] = useState<string | null>(null);
    const [previewPlaying, setPreviewPlaying] = useState(false);
    const [trackPreviews, setTrackPreviews] = useState<Record<string, TrackPreview>>({});
    const [loadingPreview, setLoadingPreview] = useState<string | null>(null);
    const audioRef = useRef<HTMLAudioElement | null>(null);
    const noPreviewSet = useRef<Set<string>>(new Set());

    // Load cached data on mount
    useEffect(() => {
        const cached = getCachedData();
        if (cached) {
            setData(cached);
        } else {
            // Auto-load on first visit
            handleGenerate();
        }
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

    const handleGenerate = async () => {
        setLoading(true);
        setError(null);
        setExpandedAlbum(null);
        setArtistDetails({});
        setTrackPreviews({});
        noPreviewSet.current.clear();
        if (audioRef.current) {
            audioRef.current.pause();
            audioRef.current = null;
        }

        try {
            // Force Last.fm source
            const result = await api.getDiscoverRecommendations(20, "28d", "mix", false, "lastfm");
            setData(result);
            setCachedData(result);
        } catch (err: unknown) {
            const errObj = err as Record<string, unknown> | undefined;
            const dataMsg = errObj?.data && typeof errObj.data === "object" ? (errObj.data as Record<string, unknown>)?.message : undefined;
            setError((typeof dataMsg === "string" ? dataMsg : undefined) || (err instanceof Error ? err.message : "Failed to load recommendations"));
        } finally {
            setLoading(false);
        }
    };

    const handleExpandAlbum = useCallback(async (albumKey: string, artistName: string) => {
        if (expandedAlbum === albumKey) {
            setExpandedAlbum(null);
            return;
        }

        setExpandedAlbum(albumKey);

        const existing = artistDetails[artistName];
        if (existing?.topTracks && existing.topTracks.length > 0) {
            return;
        }

        setLoadingArtist(artistName);
        try {
            const details = await api.getArtistDiscovery(artistName);
            const topTracks = details.topTracks || [];

            setArtistDetails(prev => ({
                ...prev,
                [artistName]: {
                    image: existing?.image || details.image || null,
                    mbid: details.mbid || details.id || null,
                    topTracks,
                }
            }));

            if (topTracks.length > 0) {
                const trackResults = await Promise.allSettled(
                    topTracks.slice(0, 5).map(async (track: { title: string }) => {
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
                [artistName]: { image: existing?.image || null, mbid: existing?.mbid || null, topTracks: [] }
            }));
        } finally {
            setLoadingArtist(null);
        }
    }, [expandedAlbum, artistDetails]);

    const handlePreview = useCallback(async (artistName: string, trackTitle: string) => {
        const trackKey = `${artistName}:${trackTitle}`;

        if (previewingTrack === trackKey && previewPlaying) {
            audioRef.current?.pause();
            setPreviewPlaying(false);
            return;
        }

        if (previewingTrack === trackKey && !previewPlaying && audioRef.current) {
            try {
                await audioRef.current.play();
                setPreviewPlaying(true);
            } catch { /* ignore */ }
            return;
        }

        if (noPreviewSet.current.has(trackKey)) {
            toast("No Deezer preview available", { duration: 1500 });
            return;
        }

        if (audioRef.current) {
            audioRef.current.pause();
            audioRef.current = null;
        }

        const cached = trackPreviews[trackKey];
        if (cached) {
            if (!cached.previewUrl) {
                toast("No Deezer preview available", { duration: 1500 });
                return;
            }
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
            } catch { /* ignore */ }
            return;
        }

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
        } catch (err: unknown) {
            const errObj = err as Record<string, unknown> | undefined;
            const errMsg = err instanceof Error ? err.message : "";
            if (errObj?.error === "Preview not found" || /preview not found/i.test(errMsg)) {
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

    const formatListeners = (count: number): string => {
        if (count >= 1_000_000) {
            return `${(count / 1_000_000).toFixed(1)}M listeners`;
        }
        if (count >= 1_000) {
            return `${(count / 1_000).toFixed(0)}K listeners`;
        }
        return `${count} listeners`;
    };

    const renderArtistCard = (artist: ArtistRecommendation, idx: number) => {
        const artistKey = `${artist.artistName}:${artist.albumTitle}`;
        const details = artistDetails[artist.artistName];
        const isExpanded = expandedAlbum === artistKey;
        const isLoadingDetails = loadingArtist === artist.artistName;
        const bioText = artist.bio?.trim();

        return (
            <div key={idx} className="bg-white/5 rounded-lg overflow-hidden">
                <button
                    onClick={() => handleExpandAlbum(artistKey, artist.artistName)}
                    className="w-full flex items-center gap-4 p-4 hover:bg-white/5 transition-colors text-left"
                >
                    <div className="w-16 h-16 bg-[#282828] rounded shrink-0 overflow-hidden">
                        {artist.coverUrl ? (
                            <Image
                                src={artist.coverUrl}
                                alt={artist.artistName}
                                width={64}
                                height={64}
                                className="w-full h-full object-cover"
                                unoptimized
                            />
                        ) : (
                            <div className="w-full h-full flex items-center justify-center">
                                <Disc3 className="w-6 h-6 text-gray-600" />
                            </div>
                        )}
                    </div>

                    <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                            <p className="text-lg font-semibold text-white truncate">
                                {artist.artistName}
                            </p>
                            <Link
                                href={artist.artistMbid
                                    ? `/artist/${artist.artistMbid}`
                                    : `/search?q=${encodeURIComponent(artist.artistName)}`
                                }
                                className="text-xs text-blue-400 hover:text-blue-300 shrink-0 flex items-center gap-1"
                                onClick={(e) => e.stopPropagation()}
                            >
                                <ExternalLink className="w-3 h-3" />
                            </Link>
                        </div>
                        <div className="flex items-center gap-2">
                            {artist.tags && artist.tags.length > 0 && (
                                <p className="text-sm text-gray-400 truncate">
                                    {artist.tags.slice(0, 4).join(" · ")}
                                </p>
                            )}
                            {artist.listeners && (
                                <span className="text-xs text-gray-500">
                                    {formatListeners(artist.listeners)}
                                </span>
                            )}
                        </div>
                        {artist.reason && (
                            <p className="text-xs text-brand mt-1 line-clamp-2">
                                {artist.reason}
                            </p>
                        )}
                        {bioText && !isExpanded && !artist.reason && (
                            <p className="text-xs text-gray-400 mt-1 line-clamp-2">
                                {bioText}
                            </p>
                        )}
                    </div>

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

                {isExpanded && (
                    <div className="border-t border-white/10 px-4 pb-4">
                        {bioText && (
                            <p className="text-sm text-gray-300 mb-4">
                                {bioText}
                            </p>
                        )}
                        <div className={cn(
                            "pt-3 pb-2",
                            bioText && "border-t border-white/10"
                        )}>
                            <p className="text-xs text-gray-500 uppercase tracking-wider">
                                Popular Tracks by {artist.artistName}
                            </p>
                        </div>

                        {isLoadingDetails ? (
                            <div className="flex items-center justify-center py-4">
                                <div className="w-5 h-5 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
                                <span className="ml-2 text-sm text-gray-300">Loading tracks...</span>
                            </div>
                        ) : details?.topTracks && details.topTracks.length > 0 ? (
                            <div className="space-y-1">
                                {details.topTracks.slice(0, 5).map((track, trackIdx) => {
                                    const trackKey = `${artist.artistName}:${track.title}`;
                                    const isThisPlaying = previewingTrack === trackKey;
                                    const isLoading = loadingPreview === trackKey;
                                    const preview = trackPreviews[trackKey];

                                    return (
                                        <div
                                            key={trackIdx}
                                            onClick={() => handlePreview(artist.artistName, track.title)}
                                            className={cn(
                                                "flex items-center gap-3 p-2 rounded hover:bg-white/5 transition-colors group cursor-pointer",
                                                isThisPlaying && "bg-white/10"
                                            )}
                                        >
                                            {/* Track Number / Play Icon - matches PopularTracks pattern */}
                                            <div className="w-5 flex items-center justify-center">
                                                <span className={cn(
                                                    "text-sm group-hover:hidden",
                                                    isThisPlaying ? "text-deezer" : "text-gray-400"
                                                )}>
                                                    {isThisPlaying && previewPlaying ? (
                                                        <Pause className="w-4 h-4 text-deezer" />
                                                    ) : (
                                                        trackIdx + 1
                                                    )}
                                                </span>
                                                {/* Show play/pause on hover */}
                                                {isThisPlaying && previewPlaying ? (
                                                    <Pause className="w-4 h-4 text-deezer hidden group-hover:block" />
                                                ) : (
                                                    <Play className="w-4 h-4 text-white hidden group-hover:block" />
                                                )}
                                            </div>

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
                                                        <Music className="w-3 h-3 text-gray-500" />
                                                    </div>
                                                )}
                                            </div>

                                            <div className="flex-1 min-w-0">
                                                <div className={cn(
                                                    "text-sm truncate flex items-center gap-2",
                                                    isThisPlaying ? "text-deezer" : "text-white"
                                                )}>
                                                    <span className="truncate">{track.title}</span>
                                                    <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded font-medium bg-deezer/20 text-deezer">
                                                        PREVIEW
                                                    </span>
                                                </div>
                                                {preview?.albumTitle && (
                                                    <p className="text-xs text-gray-400 truncate">
                                                        {preview.albumTitle}
                                                    </p>
                                                )}
                                            </div>

                                            {isLoading && (
                                                <div className="w-4 h-4 border-2 border-deezer border-t-transparent rounded-full animate-spin" />
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        ) : (
                            <p className="text-sm text-gray-400 py-2">No tracks available</p>
                        )}
                    </div>
                )}
            </div>
        );
    };

    return (
        <div className="min-h-screen">
            {/* Hero Section */}
            <div
                className="relative pt-16 pb-10 px-4 md:px-8"
                style={{
                    background: 'linear-gradient(to bottom, rgba(213, 16, 7, 0.4), #1a1a1a, transparent)'
                }}
            >
                <div className="flex items-end gap-6">
                    <div className="w-[140px] h-[140px] md:w-[192px] md:h-[192px] bg-gradient-to-br from-red-600 to-red-900 rounded shadow-2xl shrink-0 flex items-center justify-center">
                        <Music2 className="w-20 h-20 md:w-24 md:h-24 text-white" />
                    </div>

                    <div className="flex-1 min-w-0 pb-1">
                        <p className="text-xs font-medium text-white/90 mb-1">Similar Artists</p>
                        <h1 className="text-2xl md:text-4xl lg:text-5xl font-bold text-white leading-tight mb-2">
                            Recommended For You
                        </h1>
                        <p className="text-sm text-white/60 mb-2">
                            Artists similar to your favorites — powered by Last.fm
                        </p>
                        {data && (
                            <div className="flex items-center gap-1 text-sm text-white/70 flex-wrap">
                                <span>{data.recommendations.length} artists</span>
                                <span>·</span>
                                <span>Based on: {data.seedArtists.slice(0, 4).join(", ")}{data.seedArtists.length > 4 ? "..." : ""}</span>
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
                    <button
                        onClick={handleGenerate}
                        disabled={loading}
                        className={cn(
                            "flex items-center gap-2 h-10 px-4 rounded-full text-sm font-medium transition-all",
                            loading
                                ? "bg-red-600/50 text-white/70"
                                : "bg-red-600 hover:bg-red-500 text-white"
                        )}
                    >
                        <RefreshCw className={cn("w-4 h-4", loading && "animate-spin")} />
                        <span>{loading ? "Loading..." : "Refresh"}</span>
                    </button>

                    <Link
                        href="/discover"
                        className="flex items-center gap-2 h-10 px-4 rounded-full text-sm font-medium bg-white/5 hover:bg-white/10 text-white/70 hover:text-white transition-all"
                    >
                        Try AI Discovery
                    </Link>
                </div>
                {error && <p className="text-red-400 mt-3 text-sm">{error}</p>}
            </div>

            {/* Loading State */}
            {loading && !data && (
                <div className="flex flex-col items-center justify-center py-24">
                    <GradientSpinner size="lg" />
                    <p className="text-gray-200 mt-4">Finding similar artists...</p>
                </div>
            )}

            {/* Recommendations List */}
            {data && data.recommendations.length > 0 && (
                <div className="px-4 md:px-8 pb-32">
                    <div className="mb-4 text-sm text-gray-300">
                        Click an artist to preview top tracks
                    </div>
                    <div className="space-y-3">
                        {data.recommendations.map((artist, idx) => renderArtistCard(artist, idx))}
                    </div>
                </div>
            )}

            {/* Empty State */}
            {!loading && !data && (
                <div className="flex flex-col items-center justify-center py-24 text-center px-4">
                    <div className="w-20 h-20 bg-red-500/20 rounded-full flex items-center justify-center mb-4">
                        <Music2 className="w-10 h-10 text-red-400" />
                    </div>
                    <h3 className="text-lg font-medium text-white mb-1">Discover Similar Artists</h3>
                    <p className="text-sm text-gray-300 max-w-md">
                        Find artists similar to the ones you love, powered by Last.fm.
                    </p>
                </div>
            )}
        </div>
    );
}
