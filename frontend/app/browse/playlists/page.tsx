"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { Search, Loader2, Music2, Link2, X, ChevronRight } from "lucide-react";
import { api } from "@/lib/api";
import { useToast } from "@/lib/toast-context";

// Types
interface PlaylistPreview {
    id: string;
    source: "deezer" | "spotify" | "youtube";
    type: "playlist" | "radio";
    title: string;
    description: string | null;
    creator: string;
    imageUrl: string | null;
    trackCount: number;
    url: string;
}

interface Genre {
    id: number;
    name: string;
    imageUrl: string | null;
}

interface Category {
    id: string;
    name: string;
    imageUrl: string | null;
}

// Deezer icon component
const DeezerIcon = ({ className }: { className?: string }) => (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor">
        <path d="M18.81 4.16v3.03H24V4.16h-5.19zM6.27 8.38v3.027h5.189V8.38h-5.19zm12.54 0v3.027H24V8.38h-5.19zM6.27 12.595v3.027h5.189v-3.027h-5.19zm6.27 0v3.027h5.19v-3.027h-5.19zm6.27 0v3.027H24v-3.027h-5.19zM0 16.81v3.029h5.19v-3.03H0zm6.27 0v3.029h5.189v-3.03h-5.19zm6.27 0v3.029h5.19v-3.03h-5.19zm6.27 0v3.029H24v-3.03h-5.19z" />
    </svg>
);

// Spotify icon component
const SpotifyIcon = ({ className }: { className?: string }) => (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor">
        <path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z" />
    </svg>
);

// YouTube Music icon component
const YouTubeMusicIcon = ({ className }: { className?: string }) => (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor">
        <path d="M12 0C5.376 0 0 5.376 0 12s5.376 12 12 12 12-5.376 12-12S18.624 0 12 0zm0 19.104c-3.924 0-7.104-3.18-7.104-7.104S8.076 4.896 12 4.896s7.104 3.18 7.104 7.104-3.18 7.104-7.104 7.104zm0-13.332c-3.432 0-6.228 2.796-6.228 6.228S8.568 18.228 12 18.228 18.228 15.432 18.228 12 15.432 5.772 12 5.772zM9.684 15.54V8.46L16.2 12l-6.516 3.54z" />
    </svg>
);

// Source type
type BrowseSource = "deezer" | "spotify" | "youtube";

// Tab type (radios removed - now personal library content at /radio)
type BrowseTab = "playlists" | "genres";
type YouTubeTab = "featured" | "community";

// Loading skeleton for cards
const CardSkeleton = () => (
    <div className="animate-pulse">
        <div className="aspect-square rounded-md bg-white/10 mb-3" />
        <div className="h-4 w-3/4 bg-white/10 rounded mb-2" />
        <div className="h-3 w-1/2 bg-white/5 rounded" />
    </div>
);

export default function BrowsePlaylistsPage() {
    const router = useRouter();
    const { toast } = useToast();

    // UI State
    const [activeSource, setActiveSource] = useState<BrowseSource>("deezer");
    const [activeTab, setActiveTab] = useState<BrowseTab>("playlists");
    const [activeYouTubeTab, setActiveYouTubeTab] = useState<YouTubeTab>("featured");
    const [searchQuery, setSearchQuery] = useState("");
    const [isLoading, setIsLoading] = useState(true);
    const [isSearching, setIsSearching] = useState(false);
    const [hasSearched, setHasSearched] = useState(false);
    const [showUrlModal, setShowUrlModal] = useState(false);
    const [urlInput, setUrlInput] = useState("");
    const [isParsing, setIsParsing] = useState(false);
    const [loadError, setLoadError] = useState<string | null>(null);

    // Deezer Data State
    const [deezerPlaylists, setDeezerPlaylists] = useState<PlaylistPreview[]>([]);
    const [deezerGenres, setDeezerGenres] = useState<Genre[]>([]);
    const [deezerLoaded, setDeezerLoaded] = useState(false);

    // Spotify Data State
    const [spotifyPlaylists, setSpotifyPlaylists] = useState<PlaylistPreview[]>([]);
    const [spotifyCategories, setSpotifyCategories] = useState<Category[]>([]);
    const [spotifyLoaded, setSpotifyLoaded] = useState(false);

    // YouTube Music Data State
    const [youtubeFeaturedPlaylists, setYoutubeFeaturedPlaylists] = useState<PlaylistPreview[]>([]);
    const [youtubeCommunityPlaylists, setYoutubeCommunityPlaylists] = useState<PlaylistPreview[]>([]);
    const [youtubeLoaded, setYoutubeLoaded] = useState(false);

    // Search results (combined from all sources)
    const [searchResults, setSearchResults] = useState<PlaylistPreview[]>([]);

    // Selected genre/category playlists
    const [selectedGenre, setSelectedGenre] = useState<Genre | null>(null);
    const [selectedCategory, setSelectedCategory] = useState<Category | null>(null);
    const [genrePlaylists, setGenrePlaylists] = useState<PlaylistPreview[]>([]);

    // Get current playlists based on active source
    const playlists =
        activeSource === "deezer"
            ? deezerPlaylists
            : activeSource === "spotify"
            ? spotifyPlaylists
            : activeYouTubeTab === "featured"
            ? youtubeFeaturedPlaylists
            : youtubeCommunityPlaylists;
    const genres = deezerGenres;
    const categories = spotifyCategories;

    // Fetch Deezer content
    const fetchDeezerContent = useCallback(async () => {
        if (deezerLoaded) return;
        
        setIsLoading(true);
        setLoadError(null);
        try {
            const response = await api.get<{
                playlists: PlaylistPreview[];
                genres: Genre[];
            }>("/browse/all");

            setDeezerPlaylists(response.playlists);
            setDeezerGenres(response.genres);
            setDeezerLoaded(true);
        } catch (error) {
            console.error("Failed to fetch Deezer content:", error);
            setLoadError(
                "Couldn't load Deezer playlists. Check your connection and try again."
            );
        } finally {
            setIsLoading(false);
        }
    }, [deezerLoaded]);

    // Fetch Spotify content
    const fetchSpotifyContent = useCallback(async () => {
        if (spotifyLoaded) return;
        
        setIsLoading(true);
        setLoadError(null);
        try {
            const response = await api.get<{
                playlists: PlaylistPreview[];
                categories: Category[];
            }>("/browse/spotify/all");

            setSpotifyPlaylists(response.playlists);
            setSpotifyCategories(response.categories);
            setSpotifyLoaded(true);
        } catch (error) {
            console.error("Failed to fetch Spotify content:", error);
            setLoadError(
                "Couldn't load Spotify playlists. Check your connection and try again."
            );
        } finally {
            setIsLoading(false);
        }
    }, [spotifyLoaded]);

    // Fetch YouTube Music content
    const fetchYouTubeContent = useCallback(async () => {
        if (youtubeLoaded) return;

        setIsLoading(true);
        setLoadError(null);
        try {
            const response = await api.get<{
                playlists: PlaylistPreview[];
                featuredPlaylists?: PlaylistPreview[];
                communityPlaylists?: PlaylistPreview[];
            }>("/browse/youtube/all");

            setYoutubeFeaturedPlaylists(response.featuredPlaylists || []);
            setYoutubeCommunityPlaylists(response.communityPlaylists || []);
            setYoutubeLoaded(true);
        } catch (error) {
            console.error("Failed to fetch YouTube Music content:", error);
            setLoadError(
                "Couldn't load YouTube Music playlists. Check your connection and try again."
            );
        } finally {
            setIsLoading(false);
        }
    }, [youtubeLoaded]);

    // Load Deezer on mount (default source)
    useEffect(() => {
        fetchDeezerContent();
    }, [fetchDeezerContent]);

    // Load Spotify when switching to it
    useEffect(() => {
        if (activeSource === "spotify" && !spotifyLoaded) {
            fetchSpotifyContent();
        }
    }, [activeSource, spotifyLoaded, fetchSpotifyContent]);

    // Load YouTube Music when switching to it
    useEffect(() => {
        if (activeSource === "youtube" && !youtubeLoaded) {
            fetchYouTubeContent();
        }
    }, [activeSource, youtubeLoaded, fetchYouTubeContent]);

    // Handle source change
    const handleSourceChange = (source: BrowseSource) => {
        setActiveSource(source);
        setActiveTab("playlists");
        setActiveYouTubeTab("featured");
        setSelectedGenre(null);
        setSelectedCategory(null);
        setGenrePlaylists([]);
        setHasSearched(false);
        setSearchQuery("");
    };

    // Search playlists (combined search from both sources)
    const handleSearch = async (e?: React.FormEvent) => {
        e?.preventDefault();
        if (!searchQuery.trim() || searchQuery.length < 2) {
            if (!searchQuery.trim()) {
                setHasSearched(false);
            }
            return;
        }

        setIsSearching(true);
        setHasSearched(true);
        setActiveTab("playlists");
        setSelectedGenre(null);
        setSelectedCategory(null);

        try {
            // Use combined search endpoint (both Deezer and Spotify)
            const response = await api.get<{
                playlists: PlaylistPreview[];
                sources: { deezer: number; spotify: number; youtube: number };
            }>(
                `/browse/search?q=${encodeURIComponent(searchQuery)}&limit=50`
            );
            setSearchResults(response.playlists);
        } catch (error) {
            console.error("Search failed:", error);
            toast.error("Failed to search playlists");
        } finally {
            setIsSearching(false);
        }
    };

    // Clear search
    const clearSearch = () => {
        setSearchQuery("");
        setHasSearched(false);
        setSearchResults([]);
    };

    // Parse URL and redirect to import
    const handleUrlSubmit = async () => {
        if (!urlInput.trim()) return;

        setIsParsing(true);

        try {
            const response = await api.post<{
                source: string;
                id: string;
                url: string;
            }>("/browse/playlists/parse", { url: urlInput.trim() });
            setShowUrlModal(false);
            setUrlInput("");
            router.push(
                `/import/spotify?url=${encodeURIComponent(response.url)}`
            );
        } catch (error: unknown) {
            const message =
                error instanceof Error ? error.message : "Invalid playlist URL";
            toast.error(message);
        } finally {
            setIsParsing(false);
        }
    };

    // Handle playlist click - navigate to detail page
    const handleItemClick = (item: PlaylistPreview) => {
        if (item.source === "deezer") {
            router.push(`/browse/playlists/${item.id}`);
        } else {
            router.push(`/browse/playlists/${item.id}?source=${item.source}`);
        }
    };

    // Handle Deezer genre click
    const handleGenreClick = async (genre: Genre) => {
        setSelectedGenre(genre);
        setSelectedCategory(null);
        setIsLoading(true);

        try {
            const response = await api.get<{
                playlists: PlaylistPreview[];
            }>(`/browse/genres/${genre.id}/playlists?limit=50`);
            setGenrePlaylists(response.playlists);
        } catch (error) {
            console.error("Failed to fetch genre playlists:", error);
            toast.error("Failed to load genre playlists");
        } finally {
            setIsLoading(false);
        }
    };

    // Handle Spotify category click
    const handleCategoryClick = async (category: Category) => {
        setSelectedCategory(category);
        setSelectedGenre(null);
        setIsLoading(true);

        try {
            // Pass category name for fallback search if API fails
            const response = await api.get<{
                playlists: PlaylistPreview[];
            }>(`/browse/spotify/categories/${category.id}/playlists?limit=50&name=${encodeURIComponent(category.name)}`);
            setGenrePlaylists(response.playlists);
        } catch (error) {
            console.error("Failed to fetch category playlists:", error);
            toast.error("Failed to load category playlists");
        } finally {
            setIsLoading(false);
        }
    };

    // Back from genre/category view
    const handleBackFromGenre = () => {
        setSelectedGenre(null);
        setSelectedCategory(null);
        setGenrePlaylists([]);
    };

    // Render playlist card
    const renderCard = (
        item: PlaylistPreview,
        index: number,
        context?: string,
        showSourceBadge?: boolean
    ) => (
        <div
            key={`${item.source}-${item.type}-${item.id}-${
                context || "main"
            }-${index}`}
            onClick={() => handleItemClick(item)}
            className="group cursor-pointer"
        >
            <div className="relative aspect-square mb-3 rounded-md overflow-hidden bg-[#282828] shadow-lg">
                {item.imageUrl ? (
                    <Image
                        src={item.imageUrl}
                        alt={item.title}
                        fill
                        unoptimized
                        className="object-cover group-hover:scale-105 transition-transform duration-300"
                    />
                ) : (
                    <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-[#AD47FF]/30 to-[#AD47FF]/10">
                        <Music2 className="w-12 h-12 text-gray-600" />
                    </div>
                )}
                {/* Source badge for search results */}
                {showSourceBadge && (
                    <div className={`absolute top-2 left-2 px-2 py-1 rounded-full text-[10px] font-semibold flex items-center gap-1 ${
                        item.source === "spotify"
                            ? "bg-spotify/90 text-white"
                            : item.source === "youtube"
                            ? "bg-[#FF0000]/90 text-white"
                            : "bg-[#AD47FF]/90 text-white"
                    }`}>
                        {item.source === "spotify" ? (
                            <SpotifyIcon className="w-3 h-3" />
                        ) : item.source === "youtube" ? (
                            <YouTubeMusicIcon className="w-3 h-3" />
                        ) : (
                            <DeezerIcon className="w-3 h-3" />
                        )}
                        <span className="uppercase">{item.source === "youtube" ? "YouTube" : item.source}</span>
                    </div>
                )}
                {/* Import button on hover */}
                <div className="absolute bottom-2 right-2 opacity-0 group-hover:opacity-100 translate-y-2 group-hover:translate-y-0 transition-all duration-200">
                    <div className="w-12 h-12 rounded-full bg-brand flex items-center justify-center shadow-xl hover:scale-105 transition-transform">
                        <svg
                            viewBox="0 0 24 24"
                            className="w-5 h-5 text-black ml-0.5"
                            fill="currentColor"
                        >
                            <path d="M8 5v14l11-7z" />
                        </svg>
                    </div>
                </div>
            </div>
            <h3 className="text-sm font-semibold text-white truncate mb-1">
                {item.title}
            </h3>
            <p className="text-xs text-gray-400 truncate">
                {item.trackCount} songs • {item.creator}
            </p>
        </div>
    );

    // Render genre card (Deezer)
    const renderGenreCard = (genre: Genre) => (
        <div
            key={genre.id}
            onClick={() => handleGenreClick(genre)}
            className="group cursor-pointer relative aspect-square rounded-lg overflow-hidden"
        >
            {genre.imageUrl ? (
                <Image
                    src={genre.imageUrl}
                    alt={genre.name}
                    fill
                    unoptimized
                    className="object-cover group-hover:scale-105 transition-transform duration-300"
                />
            ) : (
                <div className="w-full h-full bg-gradient-to-br from-[#AD47FF] to-brand" />
            )}
            <div className="absolute inset-0 bg-black/40 group-hover:bg-black/30 transition-colors" />
            <div className="absolute bottom-3 left-3 right-3">
                <h3 className="text-lg font-bold text-white">{genre.name}</h3>
            </div>
        </div>
    );

    // Render category card (Spotify)
    const renderCategoryCard = (category: Category) => (
        <div
            key={category.id}
            onClick={() => handleCategoryClick(category)}
            className="group cursor-pointer relative aspect-square rounded-lg overflow-hidden"
        >
            {category.imageUrl ? (
                <Image
                    src={category.imageUrl}
                    alt={category.name}
                    fill
                    unoptimized
                    className="object-cover group-hover:scale-105 transition-transform duration-300"
                />
            ) : (
                <div className="w-full h-full bg-gradient-to-br from-spotify to-[#191414]" />
            )}
            <div className="absolute inset-0 bg-black/40 group-hover:bg-black/30 transition-colors" />
            <div className="absolute bottom-3 left-3 right-3">
                <h3 className="text-lg font-bold text-white">{category.name}</h3>
            </div>
        </div>
    );

    return (
        <div className="min-h-screen relative">
            {/* Gradient - changes based on source */}
            <div className="absolute inset-0 pointer-events-none">
                <div
                    className={`absolute inset-0 bg-gradient-to-b ${
                        activeSource === "spotify"
                            ? "from-spotify/15 via-[#191414]/10"
                            : activeSource === "youtube"
                            ? "from-[#FF0000]/15 via-[#1a0000]/10"
                            : "from-brand/15 via-purple-900/10"
                    } to-transparent`}
                    style={{ height: "35vh" }}
                />
                <div
                    className={`absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,var(--tw-gradient-stops))] ${
                        activeSource === "spotify"
                            ? "from-spotify/8"
                            : activeSource === "youtube"
                            ? "from-[#FF0000]/8"
                            : "from-brand/8"
                    } via-transparent to-transparent`}
                    style={{ height: "25vh" }}
                />
            </div>

            <div className="relative px-4 md:px-8 py-6">
                {/* Header */}
                <div className="mb-6">
                    <div className="flex items-center gap-3 mb-1">
                        {activeSource === "spotify" ? (
                            <SpotifyIcon className="w-8 h-8 text-spotify" />
                        ) : activeSource === "youtube" ? (
                            <YouTubeMusicIcon className="w-8 h-8 text-[#FF0000]" />
                        ) : (
                            <DeezerIcon className="w-8 h-8 text-[#AD47FF]" />
                        )}
                        <h1 className="text-3xl font-bold text-white">
                            Browse
                        </h1>
                    </div>
                    <p className="text-sm text-gray-400">
                        Discover and import playlists from {activeSource === "spotify" ? "Spotify" : activeSource === "youtube" ? "YouTube Music" : "Deezer"}
                    </p>
                </div>

                {/* Source Toggle */}
                <div className="flex items-center gap-2 mb-6">
                    <button
                        onClick={() => handleSourceChange("deezer")}
                        className={`flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium transition-all ${
                            activeSource === "deezer"
                                ? "bg-[#AD47FF] text-white"
                                : "bg-white/10 text-gray-400 hover:text-white hover:bg-white/20"
                        }`}
                    >
                        <DeezerIcon className="w-4 h-4" />
                        Deezer
                    </button>
                    <button
                        onClick={() => handleSourceChange("spotify")}
                        className={`flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium transition-all ${
                            activeSource === "spotify"
                                ? "bg-spotify text-white"
                                : "bg-white/10 text-gray-400 hover:text-white hover:bg-white/20"
                        }`}
                    >
                        <SpotifyIcon className="w-4 h-4" />
                        Spotify
                    </button>
                    <button
                        onClick={() => handleSourceChange("youtube")}
                        className={`flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium transition-all ${
                            activeSource === "youtube"
                                ? "bg-[#FF0000] text-white"
                                : "bg-white/10 text-gray-400 hover:text-white hover:bg-white/20"
                        }`}
                    >
                        <YouTubeMusicIcon className="w-4 h-4" />
                        YouTube
                    </button>
                </div>

                {/* Search Bar & Import URL */}
                <div className="flex items-center gap-3 mb-6">
                    <form
                        onSubmit={handleSearch}
                        className="relative flex-1 max-w-md"
                    >
                        <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-900" />
                        <input
                            type="text"
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            placeholder="Search playlists..."
                            className="w-full bg-white rounded-full pl-11 pr-10 py-3 text-sm text-gray-900 placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-white"
                        />
                        {searchQuery && (
                            <button
                                type="button"
                                onClick={clearSearch}
                                className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-900"
                            >
                                <X className="w-4 h-4" />
                            </button>
                        )}
                    </form>

                    <button
                        onClick={() => setShowUrlModal(true)}
                        className="flex items-center gap-2 px-4 py-3 rounded-full bg-white/10 hover:bg-white/20 text-white text-sm font-medium transition-colors"
                    >
                        <Link2 className="w-4 h-4" />
                        <span className="hidden sm:inline">Import URL</span>
                    </button>
                </div>

                {/* Tabs */}
                {!selectedGenre && !selectedCategory && !hasSearched && (
                    <div className="flex items-center gap-2 mb-6">
                        {activeSource === "youtube" ? (
                            <>
                                <button
                                    onClick={() => setActiveYouTubeTab("featured")}
                                    className={`px-4 py-2 rounded-full text-sm font-medium transition-colors ${
                                        activeYouTubeTab === "featured"
                                            ? "bg-[#FF0000] text-white"
                                            : "bg-white/10 text-white hover:bg-white/20"
                                    }`}
                                >
                                    Featured
                                </button>
                                <button
                                    onClick={() => setActiveYouTubeTab("community")}
                                    className={`px-4 py-2 rounded-full text-sm font-medium transition-colors ${
                                        activeYouTubeTab === "community"
                                            ? "bg-[#FF0000] text-white"
                                            : "bg-white/10 text-white hover:bg-white/20"
                                    }`}
                                >
                                    Community
                                </button>
                            </>
                        ) : (
                            <>
                                <button
                                    onClick={() => setActiveTab("playlists")}
                                    className={`px-4 py-2 rounded-full text-sm font-medium transition-colors ${
                                        activeTab === "playlists"
                                            ? "bg-white text-black"
                                            : "bg-white/10 text-white hover:bg-white/20"
                                    }`}
                                >
                                    Playlists
                                </button>
                                <button
                                    onClick={() => setActiveTab("genres")}
                                    className={`px-4 py-2 rounded-full text-sm font-medium transition-colors ${
                                        activeTab === "genres"
                                            ? activeSource === "spotify" ? "bg-spotify text-white" : "bg-[#AD47FF] text-white"
                                            : "bg-white/10 text-white hover:bg-white/20"
                                    }`}
                                >
                                    {activeSource === "spotify" ? "Categories" : "Genres"}
                                </button>
                            </>
                        )}
                    </div>
                )}

                {/* Genre/Category Breadcrumb */}
                {(selectedGenre || selectedCategory) && (
                    <div className="flex items-center gap-2 mb-6">
                        <button
                            onClick={handleBackFromGenre}
                            className="text-sm text-gray-400 hover:text-white transition-colors"
                        >
                            {activeSource === "spotify" ? "Categories" : "Genres"}
                        </button>
                        <ChevronRight className="w-4 h-4 text-gray-600" />
                        <span className="text-sm text-white font-medium">
                            {selectedGenre?.name || selectedCategory?.name}
                        </span>
                    </div>
                )}

                {/* Loading State with Skeleton Cards */}
                {(isLoading || isSearching) && !loadError && (
                    <div>
                        <div className="h-6 w-48 bg-white/10 rounded mb-4 animate-pulse" />
                        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7 gap-6">
                            {Array.from({ length: 14 }).map((_, i) => (
                                <CardSkeleton key={i} />
                            ))}
                        </div>
                    </div>
                )}

                {/* Error State */}
                {loadError && !isLoading && (
                    <div className="flex flex-col items-center justify-center py-20 text-center">
                        <div className="w-16 h-16 rounded-full bg-white/5 flex items-center justify-center mb-4">
                            <Music2 className="w-8 h-8 text-gray-500" />
                        </div>
                        <h3 className="text-lg font-medium text-white mb-2">
                            Couldn&apos;t load content
                        </h3>
                        <p className="text-sm text-gray-400 mb-6 max-w-sm">
                            {loadError}
                        </p>
                        <button
                            onClick={() => activeSource === "deezer" ? fetchDeezerContent() : activeSource === "spotify" ? fetchSpotifyContent() : fetchYouTubeContent()}
                            className="px-6 py-2.5 rounded-full bg-white text-black text-sm font-medium hover:scale-105 transition-transform"
                        >
                            Try again
                        </button>
                    </div>
                )}

                {/* Search Results (combined from both sources) */}
                {!isLoading && !isSearching && hasSearched && (
                    <>
                        <h2 className="text-xl font-bold text-white mb-4">
                            Results for &ldquo;{searchQuery}&rdquo;
                        </h2>
                        {searchResults.length === 0 ? (
                            <div className="flex flex-col items-center justify-center py-20 text-center">
                                <h3 className="text-lg font-medium text-white mb-2">
                                    No playlists found
                                </h3>
                                <p className="text-sm text-gray-400 mb-4">
                                    Try a different search or import a URL
                                    directly
                                </p>
                                <button
                                    onClick={() => setShowUrlModal(true)}
                                    className="px-6 py-2 rounded-full bg-white text-black text-sm font-medium hover:scale-105 transition-transform"
                                >
                                    Import by URL
                                </button>
                            </div>
                        ) : (
                            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7 gap-6">
                                {searchResults.map((item, idx) =>
                                    renderCard(item, idx, "search", true)
                                )}
                            </div>
                        )}
                    </>
                )}

                {/* Genre/Category Playlists View */}
                {!isLoading && (selectedGenre || selectedCategory) && (
                    <>
                        <h2 className="text-xl font-bold text-white mb-4">
                            {selectedGenre?.name || selectedCategory?.name} Playlists
                        </h2>
                        {genrePlaylists.length === 0 ? (
                            <p className="text-gray-400">
                                No playlists found for this {activeSource === "spotify" ? "category" : "genre"}
                            </p>
                        ) : (
                            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7 gap-6">
                                {genrePlaylists.map((item, idx) =>
                                    renderCard(item, idx, "genre")
                                )}
                            </div>
                        )}
                    </>
                )}

                {/* Main Content (no search, no genre/category selected) */}
                {!isLoading &&
                    !isSearching &&
                    !hasSearched &&
                    !selectedGenre &&
                    !selectedCategory && (
                        <>
                            {/* Playlists Tab */}
                            {activeTab === "playlists" && (
                                <>
                                    <h2 className="text-xl font-bold text-white mb-4">
                                        {activeSource === "youtube"
                                            ? activeYouTubeTab === "featured"
                                                ? "Featured on YouTube Music"
                                                : "Community on YouTube Music"
                                            : "Featured Playlists"}
                                    </h2>
                                    {playlists.length === 0 ? (
                                        <p className="text-sm text-gray-400">
                                            {activeSource === "youtube" && activeYouTubeTab === "community"
                                                ? "No community playlists available right now."
                                                : "No playlists available right now."}
                                        </p>
                                    ) : (
                                        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7 gap-6">
                                            {playlists.map((item, idx) =>
                                                renderCard(item, idx, "featured")
                                            )}
                                        </div>
                                    )}
                                    {playlists.length >= 20 && (
                                        <p className="text-center text-sm text-gray-500 mt-8">
                                            Showing {playlists.length} playlists
                                            • Search for more or import by URL
                                        </p>
                                    )}
                                </>
                            )}

                            {/* Genres/Categories Tab */}
                            {activeTab === "genres" && (
                                <>
                                    <h2 className="text-xl font-bold text-white mb-4">
                                        Browse by {activeSource === "spotify" ? "Category" : "Genre"}
                                    </h2>
                                    <p className="text-sm text-gray-400 mb-6">
                                        Explore playlists organized by {activeSource === "spotify" ? "category" : "musical genre"}
                                    </p>
                                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
                                        {activeSource === "spotify" 
                                            ? categories.map(renderCategoryCard)
                                            : genres.map(renderGenreCard)
                                        }
                                    </div>
                                </>
                            )}
                        </>
                    )}
            </div>

            {/* URL Import Modal - Modern Spotify-style */}
            {showUrlModal && (
                <div
                    className="fixed inset-0 bg-black/80  flex items-center justify-center z-50 p-4 animate-in fade-in duration-200"
                    onClick={() => setShowUrlModal(false)}
                >
                    <div
                        className="bg-[#0d0d0d] rounded-2xl max-w-lg w-full shadow-2xl border border-white/[0.03] animate-in zoom-in-95 duration-200"
                        onClick={(e) => e.stopPropagation()}
                    >
                        {/* Header with gradient accent */}
                        <div className="relative px-6 pt-6 pb-4">
                            <button
                                onClick={() => setShowUrlModal(false)}
                                className="absolute top-4 right-4 p-2 hover:bg-white/10 rounded-full transition-colors group"
                            >
                                <X className="w-5 h-5 text-white/40 group-hover:text-white transition-colors" />
                            </button>

                            <div className="flex items-center gap-3 mb-2">
                                <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-brand to-[#AD47FF] flex items-center justify-center">
                                    <Link2 className="w-5 h-5 text-white" />
                                </div>
                                <h3 className="text-xl font-bold text-white">
                                    Import Playlist
                                </h3>
                            </div>
                            <p className="text-sm text-white/40 ml-[52px]">
                                Paste a link to get started
                            </p>
                        </div>

                        {/* Supported platforms */}
                        <div className="px-6 pb-4">
                            <div className="flex items-center gap-3 p-3 bg-white/[0.03] rounded-xl border border-white/[0.03]">
                                <div className="flex items-center gap-2 px-3 py-1.5 bg-spotify/10 rounded-full">
                                    <svg
                                        viewBox="0 0 24 24"
                                        className="w-4 h-4 text-spotify"
                                        fill="currentColor"
                                    >
                                        <path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z" />
                                    </svg>
                                    <span className="text-xs font-medium text-spotify">
                                        Spotify
                                    </span>
                                </div>
                                <div className="flex items-center gap-2 px-3 py-1.5 bg-[#AD47FF]/10 rounded-full">
                                    <DeezerIcon className="w-4 h-4 text-[#AD47FF]" />
                                    <span className="text-xs font-medium text-[#AD47FF]">
                                        Deezer
                                    </span>
                                </div>
                                <div className="flex items-center gap-2 px-3 py-1.5 bg-[#FF0000]/10 rounded-full">
                                    <YouTubeMusicIcon className="w-4 h-4 text-[#FF0000]" />
                                    <span className="text-xs font-medium text-[#FF0000]">
                                        YouTube
                                    </span>
                                </div>
                                <span className="text-xs text-white/30 ml-auto">
                                    Supported
                                </span>
                            </div>
                        </div>

                        {/* Input area */}
                        <div className="px-6 pb-6">
                            <div className="relative">
                                <input
                                    type="text"
                                    value={urlInput}
                                    onChange={(e) =>
                                        setUrlInput(e.target.value)
                                    }
                                    placeholder="Paste playlist URL here..."
                                    className="w-full bg-black/40 border border-white/[0.06] rounded-xl px-4 py-4 text-white placeholder:text-white/30 focus:outline-none focus:border-brand/40 focus:ring-1 focus:ring-brand/20 transition-all text-sm"
                                    onKeyDown={(e) =>
                                        e.key === "Enter" && handleUrlSubmit()
                                    }
                                    autoFocus
                                />
                                {urlInput && (
                                    <button
                                        onClick={() => setUrlInput("")}
                                        className="absolute right-3 top-1/2 -translate-y-1/2 p-1.5 hover:bg-white/10 rounded-full transition-colors"
                                    >
                                        <X className="w-4 h-4 text-white/40" />
                                    </button>
                                )}
                            </div>

                            <p className="text-xs text-white/30 mt-2 ml-1">
                                Example:
                                https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M
                            </p>
                        </div>

                        {/* Actions */}
                        <div className="px-6 pb-6 flex gap-3">
                            <button
                                onClick={() => setShowUrlModal(false)}
                                className="flex-1 py-3.5 rounded-full bg-white/[0.03] border border-white/[0.06] text-white font-medium hover:bg-white/[0.06] transition-colors"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleUrlSubmit}
                                disabled={isParsing || !urlInput.trim()}
                                className="flex-1 py-3.5 rounded-full bg-brand text-black font-semibold hover:bg-brand-hover disabled:opacity-40 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-2 shadow-lg shadow-brand/20"
                            >
                                {isParsing ? (
                                    <>
                                        <Loader2 className="w-4 h-4 animate-spin" />
                                        <span>Importing...</span>
                                    </>
                                ) : (
                                    <>
                                        <ChevronRight className="w-4 h-4" />
                                        <span>Continue</span>
                                    </>
                                )}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
