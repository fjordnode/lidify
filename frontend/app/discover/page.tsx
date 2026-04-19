"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import Image from "next/image";
import Link from "next/link";
import { Compass, Play, Pause, RefreshCw, Music, ChevronDown, ChevronUp, Disc3, ExternalLink, Sparkles, Target, Lightbulb, Shuffle, Library } from "lucide-react";
import { api } from "@/lib/api";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import { cn } from "@/utils/cn";
import { toast } from "sonner";
import { howlerEngine } from "@/lib/howler-engine";

// Types
type DiscoveryMode = "safe" | "adjacent" | "adventurous" | "mix";
type DiscoveryTimeframe = "7d" | "28d" | "90d" | "all";

interface AlbumRecommendation {
    artistName: string;
    artistMbid?: string;
    albumTitle: string;
    albumMbid: string;
    similarity: number;
    tier: "high" | "medium" | "explore" | "wildcard";
    coverUrl?: string;
    year?: number;
    reason?: string;
    listeners?: number;
    tags?: string[];
    bio?: string;
}

interface DiscoverData {
    recommendations: AlbumRecommendation[];
    sections?: {
        safe: AlbumRecommendation[];
        adjacent: AlbumRecommendation[];
        wildcard: AlbumRecommendation[];
    };
    seedArtists: string[];
    mode: DiscoveryMode;
    timeframe: DiscoveryTimeframe;
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

// Cache helpers - include mode, timeframe, and includeLibrary in key
const getCacheKey = (mode: DiscoveryMode, timeframe: DiscoveryTimeframe, includeLibrary: boolean) =>
    `lidify_discover_${mode}_${timeframe}_${includeLibrary ? "inclib" : "exclib"}`;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function getCachedData(mode: DiscoveryMode, timeframe: DiscoveryTimeframe, includeLibrary: boolean): DiscoverData | null {
    if (typeof window === "undefined") return null;
    try {
        const cached = localStorage.getItem(getCacheKey(mode, timeframe, includeLibrary));
        if (!cached) return null;
        const { data, timestamp } = JSON.parse(cached);
        if (Date.now() - timestamp > CACHE_TTL_MS) {
            localStorage.removeItem(getCacheKey(mode, timeframe, includeLibrary));
            return null;
        }
        return data;
    } catch {
        return null;
    }
}

function setCachedData(mode: DiscoveryMode, timeframe: DiscoveryTimeframe, includeLibrary: boolean, data: DiscoverData) {
    if (typeof window === "undefined") return;
    try {
        localStorage.setItem(getCacheKey(mode, timeframe, includeLibrary), JSON.stringify({ data, timestamp: Date.now() }));
    } catch {
        // Ignore storage errors
    }
}

const modeConfig: Record<DiscoveryMode, { label: string; icon: typeof Target; description: string }> = {
    safe: { label: "Safe", icon: Target, description: "More of what you love" },
    adjacent: { label: "Adjacent", icon: Lightbulb, description: "Same vibe, new names" },
    adventurous: { label: "Adventurous", icon: Sparkles, description: "Unexpected but still you" },
    mix: { label: "Mix", icon: Shuffle, description: "A bit of everything" },
};

const timeframeConfig: Record<DiscoveryTimeframe, { label: string; description: string }> = {
    "7d": { label: "7 days", description: "What you're into right now" },
    "28d": { label: "28 days", description: "Your current taste" },
    "90d": { label: "90 days", description: "Your stable preferences" },
    "all": { label: "All time", description: "Your musical identity" },
};

export default function DiscoverPage() {
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [data, setData] = useState<DiscoverData | null>(null);
    const [, setPrefsLoaded] = useState(false);

    // User controls - loaded from preferences
    const [mode, setMode] = useState<DiscoveryMode>("mix");
    const [timeframe, setTimeframe] = useState<DiscoveryTimeframe>("28d");
    const [includeLibrary, setIncludeLibrary] = useState(false);

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

    // Load user preferences on mount (but don't auto-generate)
    useEffect(() => {
        const loadPreferences = async () => {
            try {
                const config = await api.getDiscoverConfig();
                if (config.discoveryMode) setMode(config.discoveryMode);
                if (config.discoveryTimeframe) setTimeframe(config.discoveryTimeframe);
                if (config.includeLibraryArtists !== undefined) setIncludeLibrary(config.includeLibraryArtists);

                // Check if we have cached data for these settings
                const cached = getCachedData(
                    config.discoveryMode || "mix",
                    config.discoveryTimeframe || "28d",
                    config.includeLibraryArtists || false
                );
                if (cached) {
                    setData(cached);
                }
            } catch (err) {
                // Use defaults if preferences fail to load
                console.error("Failed to load discovery preferences:", err);
                // Check cache with defaults
                const cached = getCachedData("mix", "28d", false);
                if (cached) {
                    setData(cached);
                }
            } finally {
                setPrefsLoaded(true);
            }
        };
        loadPreferences();
    }, []);

    // Handle mode change - save preference, show cached data if available
    // User clicks Generate to fetch new data
    const handleModeChange = async (newMode: DiscoveryMode) => {
        if (newMode === mode || loading) return;
        setMode(newMode);

        // Save preference (fire and forget)
        api.updateDiscoverConfig({ discoveryMode: newMode }).catch(() => {});

        // Check if we have cached data for this setting - show it if available
        const cached = getCachedData(newMode, timeframe, includeLibrary);
        if (cached) {
            setData(cached);
        }
        // Don't auto-generate - user will click Generate when ready
    };

    // Handle timeframe change - save preference, show cached data if available
    // User clicks Generate to fetch new data
    const handleTimeframeChange = async (newTimeframe: DiscoveryTimeframe) => {
        if (newTimeframe === timeframe || loading) return;
        setTimeframe(newTimeframe);

        // Save preference (fire and forget)
        api.updateDiscoverConfig({ discoveryTimeframe: newTimeframe }).catch(() => {});

        // Check if we have cached data for this setting - show it if available
        const cached = getCachedData(mode, newTimeframe, includeLibrary);
        if (cached) {
            setData(cached);
        }
        // Don't auto-generate - user will click Generate when ready
    };

    // Handle include library toggle - just update setting, don't auto-generate
    const handleIncludeLibraryChange = async (newValue: boolean) => {
        if (newValue === includeLibrary || loading) return;
        setIncludeLibrary(newValue);

        // Save preference (fire and forget)
        api.updateDiscoverConfig({ includeLibraryArtists: newValue }).catch(() => {});

        // Check if we have cached data for this setting - show it if available
        const cached = getCachedData(mode, timeframe, newValue);
        if (cached) {
            setData(cached);
        }
        // Don't auto-generate - user will click Generate when ready
    };

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
        handleGenerateWithSettings(mode, timeframe, includeLibrary, forceRefresh);
    };

    const handleGenerateWithSettings = async (
        targetMode: DiscoveryMode,
        targetTimeframe: DiscoveryTimeframe,
        targetIncludeLibrary: boolean,
        forceRefresh = false
    ) => {
        if (!forceRefresh) {
            const cached = getCachedData(targetMode, targetTimeframe, targetIncludeLibrary);
            if (cached) {
                setData(cached);
                return;
            }
        }

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
            const result = await api.getDiscoverRecommendations(16, targetTimeframe, targetMode, targetIncludeLibrary, "auto", forceRefresh);
            setData(result);
            // Only cache if we got actual recommendations
            if (result.recommendations && result.recommendations.length > 0) {
                setCachedData(targetMode, targetTimeframe, targetIncludeLibrary, result);
                // Notify other pages (main page) that recommendations were refreshed
                window.dispatchEvent(new Event("discover-recommendations-updated"));
            }
        } catch (err: unknown) {
            const errObj = err as Record<string, unknown> | undefined;
            const dataMsg = errObj?.data && typeof errObj.data === "object" ? (errObj.data as Record<string, unknown>)?.message : undefined;
            setError((typeof dataMsg === "string" ? dataMsg : undefined) || (err instanceof Error ? err.message : "Failed to generate recommendations"));
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

        // Check if we already have top tracks cached
        const existing = artistDetails[artistName];
        if (existing?.topTracks && existing.topTracks.length > 0) {
            return;
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
                    mbid: details.mbid || details.id || null,
                    topTracks,
                }
            }));

            // Fetch album art for tracks
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
            } catch {
                // Ignore
            }
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
            } catch {
                // Ignore abort errors
            }
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

    const formatListeners = (count: number) => {
        if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M listeners`;
        if (count >= 1_000) return `${(count / 1_000).toFixed(0)}K listeners`;
        return `${count} listeners`;
    };

    // Render album card
    const renderAlbumCard = (album: AlbumRecommendation, idx: number) => {
        const albumKey = `${album.artistName}:${album.albumTitle}`;
        const details = artistDetails[album.artistName];
        const isExpanded = expandedAlbum === albumKey;
        const isLoadingDetails = loadingArtist === album.artistName;
        const bioText = album.bio?.trim();

        return (
            <div key={idx} className="bg-white/5 rounded-lg overflow-hidden">
                {/* Album Header */}
                <button
                    onClick={() => handleExpandAlbum(albumKey, album.artistName)}
                    className="w-full flex items-center gap-4 p-4 hover:bg-white/5 transition-colors text-left"
                >
                    {/* Album Cover */}
                    <div className="w-16 h-16 bg-[#282828] rounded shrink-0 overflow-hidden">
                        {album.coverUrl ? (
                            <Image
                                src={album.coverUrl}
                                alt={album.artistName}
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

                    {/* Album Info */}
                    <div className="flex-1 min-w-0">
                        {/* Artist Name - Primary */}
                        <div className="flex items-center gap-2">
                            <p className="text-lg font-semibold text-white truncate">
                                {album.artistName}
                            </p>
                            <Link
                                href={album.artistMbid
                                    ? `/artist/${album.artistMbid}`
                                    : `/search?q=${encodeURIComponent(album.artistName)}`
                                }
                                className="text-xs text-ai hover:text-ai-hover shrink-0 flex items-center gap-1"
                                onClick={(e) => e.stopPropagation()}
                            >
                                <ExternalLink className="w-3 h-3" />
                            </Link>
                        </div>
                        {/* Tags + Listeners */}
                        <div className="flex items-center gap-2">
                            {album.tags && album.tags.length > 0 && (
                                <p className="text-sm text-gray-400 truncate">
                                    {album.tags.slice(0, 4).join(" · ")}
                                </p>
                            )}
                            {album.listeners && (
                                <span className="text-xs text-gray-500">
                                    {formatListeners(album.listeners)}
                                </span>
                            )}
                        </div>
                        {/* Reason */}
                        {album.reason && (
                            <p className="text-xs text-gray-400 mt-1 line-clamp-2">
                                {album.reason}
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
                                Popular Tracks by {album.artistName}
                            </p>
                        </div>

                        {isLoadingDetails ? (
                            <div className="flex items-center justify-center py-4">
                                <div className="w-5 h-5 border-2 border-ai border-t-transparent rounded-full animate-spin" />
                                <span className="ml-2 text-sm text-gray-300">Loading tracks...</span>
                            </div>
                        ) : details?.topTracks && details.topTracks.length > 0 ? (
                            <div className="space-y-1">
                                {details.topTracks.slice(0, 5).map((track, trackIdx) => {
                                    const trackKey = `${album.artistName}:${track.title}`;
                                    const isThisPlaying = previewingTrack === trackKey;
                                    const isLoading = loadingPreview === trackKey;
                                    const preview = trackPreviews[trackKey];

                                    return (
                                        <div
                                            key={trackIdx}
                                            onClick={() => handlePreview(album.artistName, track.title)}
                                            className={cn(
                                                "flex items-center gap-3 p-2 rounded hover:bg-white/5 transition-colors group cursor-pointer",
                                                isThisPlaying && "bg-white/10"
                                            )}
                                        >
                                            <span className={cn(
                                                "w-5 text-center text-sm",
                                                isThisPlaying ? "text-ai" : "text-gray-300"
                                            )}>
                                                {isThisPlaying && previewPlaying ? (
                                                    <Music className="w-4 h-4 text-ai animate-pulse inline" />
                                                ) : (
                                                    trackIdx + 1
                                                )}
                                            </span>

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
                                                <p className={cn(
                                                    "text-sm truncate",
                                                    isThisPlaying ? "text-ai" : "text-white"
                                                )}>
                                                    {track.title}
                                                </p>
                                                {preview?.albumTitle && (
                                                    <p className="text-xs text-gray-400 truncate">
                                                        {preview.albumTitle}
                                                    </p>
                                                )}
                                            </div>

                                            <button
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    handlePreview(album.artistName, track.title);
                                                }}
                                                disabled={isLoading}
                                                className={cn(
                                                    "p-2 rounded-full transition-all",
                                                    isThisPlaying
                                                        ? "bg-ai/20 text-ai"
                                                        : "hover:bg-white/10 text-gray-300 hover:text-white",
                                                    isLoading && "opacity-50"
                                                )}
                                                title="Play Deezer preview"
                                            >
                                                {isLoading ? (
                                                    <div className="w-4 h-4 border-2 border-gray-300 border-t-transparent rounded-full animate-spin" />
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
                    background: 'linear-gradient(to bottom, rgba(59, 130, 246, 0.4), #1a1a1a, transparent)'
                }}
            >
                <div className="flex items-end gap-6">
                    <div className="w-[140px] h-[140px] md:w-[192px] md:h-[192px] bg-gradient-to-br from-ai to-ai-hover rounded shadow-2xl shrink-0 flex items-center justify-center">
                        <Compass className="w-20 h-20 md:w-24 md:h-24 text-white" />
                    </div>

                    <div className="flex-1 min-w-0 pb-1">
                        <p className="text-xs font-medium text-white/90 mb-1">Album Discovery</p>
                        <h1 className="text-2xl md:text-4xl lg:text-5xl font-bold text-white leading-tight mb-2">
                            Discover Weekly
                        </h1>
                        <p className="text-sm text-white/60 mb-2">
                            Artists similar to your favorites — preview before you download
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

            {/* Controls Section */}
            <div className="bg-gradient-to-b from-[#1a1a1a]/60 to-transparent px-4 md:px-8 py-4">
                {/* Mode Selector */}
                <div className="mb-4">
                    <label className="text-xs text-gray-500 uppercase tracking-wider mb-2 block">Discovery Mode</label>
                    <div className="flex flex-wrap gap-2">
                        {(Object.keys(modeConfig) as DiscoveryMode[]).map((m) => {
                            const config = modeConfig[m];
                            const Icon = config.icon;
                            const isActive = mode === m;
                            return (
                                <button
                                    key={m}
                                    onClick={() => handleModeChange(m)}
                                    disabled={loading}
                                    className={cn(
                                        "flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium transition-all",
                                        isActive
                                            ? "bg-ai text-white"
                                            : "bg-white/5 text-white/70 hover:bg-white/10 hover:text-white",
                                        loading && "opacity-50 cursor-not-allowed"
                                    )}
                                    title={config.description}
                                >
                                    <Icon className="w-4 h-4" />
                                    {config.label}
                                </button>
                            );
                        })}
                    </div>
                </div>

                {/* Timeframe Selector */}
                <div className="mb-4">
                    <label className="text-xs text-gray-500 uppercase tracking-wider mb-2 block">Taste Source</label>
                    <div className="flex flex-wrap gap-2">
                        {(Object.keys(timeframeConfig) as DiscoveryTimeframe[]).map((t) => {
                            const config = timeframeConfig[t];
                            const isActive = timeframe === t;
                            return (
                                <button
                                    key={t}
                                    onClick={() => handleTimeframeChange(t)}
                                    disabled={loading}
                                    className={cn(
                                        "px-4 py-2 rounded-full text-sm font-medium transition-all",
                                        isActive
                                            ? "bg-white/20 text-white"
                                            : "bg-white/5 text-white/70 hover:bg-white/10 hover:text-white",
                                        loading && "opacity-50 cursor-not-allowed"
                                    )}
                                    title={config.description}
                                >
                                    {config.label}
                                </button>
                            );
                        })}
                    </div>
                </div>

                {/* Include Library Toggle */}
                <div className="mb-4">
                    <button
                        onClick={() => handleIncludeLibraryChange(!includeLibrary)}
                        disabled={loading}
                        className={cn(
                            "flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium transition-all",
                            includeLibrary
                                ? "bg-ai/20 text-ai border border-ai/30"
                                : "bg-white/5 text-white/70 hover:bg-white/10 hover:text-white",
                            loading && "opacity-50 cursor-not-allowed"
                        )}
                        title={includeLibrary
                            ? "Recommendations may include artists you already own"
                            : "Recommendations exclude artists you already own"
                        }
                    >
                        <Library className="w-4 h-4" />
                        <span>{includeLibrary ? "Including library artists" : "Excluding library artists"}</span>
                    </button>
                    <p className="text-xs text-gray-500 mt-1 ml-1">
                        {includeLibrary
                            ? "May recommend albums from artists you already have"
                            : "Only recommends new artists you don't own yet"
                        }
                    </p>
                </div>

                {/* Action Buttons */}
                <div className="flex items-center gap-4">
                    <button
                        onClick={() => handleGenerate(true)}
                        disabled={loading}
                        className={cn(
                            "flex items-center gap-2 h-10 px-4 rounded-full text-sm font-medium transition-all",
                            loading
                                ? "bg-ai/50 text-white/70"
                                : "bg-ai hover:bg-ai-hover text-white"
                        )}
                    >
                        <RefreshCw className={cn("w-4 h-4", loading && "animate-spin")} />
                        <span>{loading ? "Generating..." : "Generate"}</span>
                    </button>
                </div>
                {error && <p className="text-red-400 mt-3 text-sm">{error}</p>}
            </div>

            {/* Loading State */}
            {loading && !data && (
                <div className="flex flex-col items-center justify-center py-24">
                    <GradientSpinner size="lg" />
                    <p className="text-gray-200 mt-4">Analyzing your listening history...</p>
                    <p className="text-gray-400 text-sm mt-1">
                        {mode === "safe" && "Finding artists who sound just like your favorites"}
                        {mode === "adjacent" && "Finding artists with the same energy and mood"}
                        {mode === "adventurous" && "Finding unexpected connections you'll love"}
                        {mode === "mix" && "Building a balanced mix of familiar and new"}
                    </p>
                </div>
            )}

            {/* Sectioned Output for Mix Mode */}
            {data && mode === "mix" && data.sections && (
                <div className="px-4 md:px-8 pb-32">
                    <div className="mb-4 text-sm text-gray-300">
                        Click an artist to preview top tracks • Visit artist page to add to library
                    </div>

                    {/* Safe Section */}
                    {data.sections.safe.length > 0 && (
                        <div className="mb-8">
                            <div className="flex items-center gap-2 mb-3">
                                <Target className="w-5 h-5 text-green-400" />
                                <h2 className="text-lg font-semibold text-white">Safe Picks</h2>
                                <span className="text-sm text-gray-400">— More of what you love</span>
                            </div>
                            <div className="space-y-3">
                                {data.sections.safe.map((album, idx) => renderAlbumCard(album, idx))}
                            </div>
                        </div>
                    )}

                    {/* Adjacent Section */}
                    {data.sections.adjacent.length > 0 && (
                        <div className="mb-8">
                            <div className="flex items-center gap-2 mb-3">
                                <Lightbulb className="w-5 h-5 text-yellow-400" />
                                <h2 className="text-lg font-semibold text-white">Adjacent</h2>
                                <span className="text-sm text-gray-400">— Same vibe, new names</span>
                            </div>
                            <div className="space-y-3">
                                {data.sections.adjacent.map((album, idx) => renderAlbumCard(album, idx))}
                            </div>
                        </div>
                    )}

                    {/* Wildcard Section */}
                    {data.sections.wildcard.length > 0 && (
                        <div className="mb-8">
                            <div className="flex items-center gap-2 mb-3">
                                <Sparkles className="w-5 h-5 text-ai" />
                                <h2 className="text-lg font-semibold text-white">Wildcards</h2>
                                <span className="text-sm text-gray-400">— Unexpected but still you</span>
                            </div>
                            <div className="space-y-3">
                                {data.sections.wildcard.map((album, idx) => renderAlbumCard(album, idx))}
                            </div>
                        </div>
                    )}
                </div>
            )}

            {/* Flat List for Non-Mix Modes */}
            {data && (mode !== "mix" || !data.sections) && data.recommendations.length > 0 && (
                <div className="px-4 md:px-8 pb-32">
                    <div className="mb-4 text-sm text-gray-300">
                        Click an artist to preview top tracks • Visit artist page to add to library
                    </div>

                    <div className="space-y-3">
                        {data.recommendations.map((album, idx) => renderAlbumCard(album, idx))}
                    </div>
                </div>
            )}

            {/* Empty State */}
            {!loading && !data && (
                <div className="flex flex-col items-center justify-center py-24 text-center px-4">
                    <div className="w-20 h-20 bg-ai/20 rounded-full flex items-center justify-center mb-4">
                        <Compass className="w-10 h-10 text-ai" />
                    </div>
                    <h3 className="text-lg font-medium text-white mb-1">Discover New Music</h3>
                    <p className="text-sm text-gray-300 max-w-md mb-2">
                        Find albums from artists similar to your favorites.
                        Preview tracks via Deezer, then add to your library if you like them.
                    </p>
                    <p className="text-xs text-gray-400 max-w-md">
                        No automatic downloads — you decide what to keep.
                    </p>
                </div>
            )}
        </div>
    );
}
