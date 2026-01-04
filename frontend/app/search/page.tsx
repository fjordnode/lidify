"use client";

import { useState, useEffect } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { SearchIcon } from "lucide-react";
import { useSearchData } from "@/features/search/hooks/useSearchData";
import { useSoulseekSearch } from "@/features/search/hooks/useSoulseekSearch";
import { SearchFilters } from "@/features/search/components/SearchFilters";
import { EmptyState } from "@/features/search/components/EmptyState";
import { LibraryArtistsGrid } from "@/features/search/components/LibraryArtistsGrid";
import { LibraryAlbumsGrid } from "@/features/search/components/LibraryAlbumsGrid";
import { LibraryPodcastsGrid } from "@/features/search/components/LibraryPodcastsGrid";
import { LibraryTracksList } from "@/features/search/components/LibraryTracksList";
import { SimilarArtistsGrid } from "@/features/search/components/SimilarArtistsGrid";
import { TopResult } from "@/features/search/components/TopResult";
import { SoulseekSongsList } from "@/features/search/components/SoulseekSongsList";
import { TVSearchInput } from "@/features/search/components/TVSearchInput";
import type { FilterTab } from "@/features/search/types";

export default function SearchPage() {
    const searchParams = useSearchParams();
    const router = useRouter();
    const [filterTab, setFilterTab] = useState<FilterTab>("all");
    const [query, setQuery] = useState("");

    // Custom hooks
    const {
        libraryResults,
        discoverResults,
        isLibrarySearching,
        isDiscoverSearching,
        hasSearched,
    } = useSearchData({ query });
    const {
        soulseekResults,
        isSoulseekSearching,
        isSoulseekPolling,
        soulseekEnabled,
        downloadingFiles,
        handleDownload,
    } = useSoulseekSearch({ query });

    // Read query from URL params on mount
    useEffect(() => {
        const q = searchParams.get("q");
        if (q) {
            setQuery(q);
        }
    }, [searchParams]);

    // Derived state
    const isLoading =
        isLibrarySearching ||
        isDiscoverSearching ||
        isSoulseekSearching ||
        isSoulseekPolling;
    const showLibrary = filterTab === "all" || filterTab === "library";
    const showDiscover = filterTab === "all" || filterTab === "discover";
    const showSoulseek = filterTab === "all" || filterTab === "soulseek";

    // Handle TV search
    const handleTVSearch = (searchQuery: string) => {
        setQuery(searchQuery);
        router.push(`/search?q=${encodeURIComponent(searchQuery)}`);
    };

    return (
        <div className="min-h-screen px-6 py-6">
            {/* TV Search Input - only visible in TV mode */}
            <TVSearchInput initialQuery={query} onSearch={handleTVSearch} />

            <SearchFilters
                filterTab={filterTab}
                onFilterChange={setFilterTab}
                soulseekEnabled={soulseekEnabled}
                hasSearched={hasSearched}
            />

            <div className="pb-24 space-y-12">
                <EmptyState hasSearched={hasSearched} isLoading={isLoading} />

                {/* Loading spinner */}
                {hasSearched &&
                    (isLibrarySearching ||
                        isDiscoverSearching ||
                        isSoulseekSearching) &&
                    (!libraryResults || !libraryResults.artists?.length) &&
                    discoverResults.length === 0 && (
                        <div className="flex flex-col items-center justify-center py-16 relative z-10">
                            <div className="relative w-16 h-16 mb-4">
                                <svg
                                    className="w-16 h-16 animate-spin"
                                    viewBox="0 0 64 64"
                                >
                                    <defs>
                                        <linearGradient
                                            id="spinnerGrad"
                                            x1="0%"
                                            y1="0%"
                                            x2="100%"
                                            y2="100%"
                                        >
                                            <stop
                                                offset="0%"
                                                style={{
                                                    stopColor: "#facc15",
                                                    stopOpacity: 1,
                                                }}
                                            />
                                            <stop
                                                offset="25%"
                                                style={{
                                                    stopColor: "#f59e0b",
                                                    stopOpacity: 1,
                                                }}
                                            />
                                            <stop
                                                offset="50%"
                                                style={{
                                                    stopColor: "#c026d3",
                                                    stopOpacity: 1,
                                                }}
                                            />
                                            <stop
                                                offset="75%"
                                                style={{
                                                    stopColor: "#a855f7",
                                                    stopOpacity: 1,
                                                }}
                                            />
                                            <stop
                                                offset="100%"
                                                style={{
                                                    stopColor: "#facc15",
                                                    stopOpacity: 1,
                                                }}
                                            />
                                        </linearGradient>
                                    </defs>
                                    <circle
                                        cx="32"
                                        cy="32"
                                        r="28"
                                        fill="none"
                                        stroke="url(#spinnerGrad)"
                                        strokeWidth="4"
                                        strokeLinecap="round"
                                        strokeDasharray="140 40"
                                    />
                                </svg>
                            </div>
                            <p className="text-gray-400 text-sm">
                                {isSoulseekSearching || isSoulseekPolling
                                    ? `Searching... (${soulseekResults.length} found)`
                                    : "Searching..."}
                            </p>
                        </div>
                    )}

                {/* Top Result - shows best match from library or discovery */}
                {hasSearched && (showLibrary || showDiscover) && (
                    <TopResult
                        libraryArtist={showLibrary ? libraryResults?.artists?.[0] : undefined}
                        discoveryArtist={showDiscover ? discoverResults.find(r => r.type === "music") : undefined}
                    />
                )}

                {/* Library Artists */}
                {hasSearched &&
                    showLibrary &&
                    libraryResults?.artists &&
                    libraryResults.artists.length > 0 && (
                        <LibraryArtistsGrid
                            artists={libraryResults.artists}
                        />
                    )}

                {/* Soulseek Songs */}
                {hasSearched && showSoulseek && soulseekResults.length > 0 && (
                    <section>
                        <h2 className="text-2xl font-bold text-white mb-6">
                            Songs
                        </h2>
                        <SoulseekSongsList
                            soulseekResults={soulseekResults}
                            downloadingFiles={downloadingFiles}
                            onDownload={handleDownload}
                        />
                    </section>
                )}

                {/* Library Songs */}
                {hasSearched &&
                    showLibrary &&
                    libraryResults?.tracks?.length > 0 && (
                        <section>
                            <h2 className="text-2xl font-bold text-white mb-6">
                                Songs in Your Library
                            </h2>
                            <LibraryTracksList tracks={libraryResults.tracks} />
                        </section>
                    )}

                {/* Library Albums */}
                {hasSearched &&
                    showLibrary &&
                    libraryResults?.albums?.length > 0 && (
                        <section>
                            <h2 className="text-2xl font-bold text-white mb-6">
                                Albums in Your Library
                            </h2>
                            <LibraryAlbumsGrid albums={libraryResults.albums} />
                        </section>
                    )}

                {/* Library Podcasts */}
                {hasSearched &&
                    showLibrary &&
                    libraryResults?.podcasts?.length > 0 && (
                        <section>
                            <h2 className="text-2xl font-bold text-white mb-6">
                                Podcasts
                            </h2>
                            <LibraryPodcastsGrid
                                podcasts={libraryResults.podcasts}
                            />
                        </section>
                    )}

                {/* Last.fm Artists */}
                {hasSearched && showDiscover && (
                    <SimilarArtistsGrid
                        discoverResults={discoverResults}
                        skipFirst={!libraryResults?.artists?.[0]}
                        isLoading={isDiscoverSearching}
                    />
                )}

                {/* No Results */}
                {hasSearched &&
                    !isLoading &&
                    discoverResults.length === 0 &&
                    soulseekResults.length === 0 &&
                    (!libraryResults ||
                        (!libraryResults.artists?.length &&
                            !libraryResults.albums?.length &&
                            !libraryResults.tracks?.length)) && (
                        <div className="flex flex-col items-center justify-center py-24 text-center">
                            <SearchIcon className="w-16 h-16 text-gray-700 mb-4" />
                            <h3 className="text-xl font-bold text-white mb-2">
                                No results found
                            </h3>
                            <p className="text-gray-400">
                                Try searching for something else
                            </p>
                        </div>
                    )}
            </div>
        </div>
    );
}
