"use client";

import { useState, useEffect } from "react";
import { LoadingScreen } from "@/components/ui/LoadingScreen";
import { RefreshCw, AudioWaveform, Compass } from "lucide-react";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import { useHomeData } from "@/features/home/hooks/useHomeData";
import { HomeHero } from "@/features/home/components/HomeHero";
import { SectionHeader } from "@/features/home/components/SectionHeader";
import { ContinueListening } from "@/features/home/components/ContinueListening";
import { ArtistsGrid } from "@/features/home/components/ArtistsGrid";
import { MixesGrid } from "@/features/home/components/MixesGrid";
import { FeaturedPlaylistsGrid } from "@/features/home/components/FeaturedPlaylistsGrid";
import { LibraryRadioStations } from "@/features/home/components/LibraryRadioStations";
import { MostPlayedArtists } from "@/features/home/components/MostPlayedArtists";
import { MoodMixer } from "@/components/MoodMixer";

// Helper to read AI recommendations from discover page cache
type TierType = "high" | "medium" | "explore" | "wildcard";

interface AiArtist {
    id: string;
    mbid?: string;
    name: string;
    coverArt?: string;
    tier?: TierType;
    reason?: string;
}

function getAiRecommendationsFromCache(): AiArtist[] {
    if (typeof window === "undefined") return [];

    const discoverCacheKeys = Object.keys(localStorage).filter((key) =>
        key.startsWith("lidify_discover_")
    );

    const candidates: Array<{ data: any; timestamp: number }> = [];

    for (const key of discoverCacheKeys) {
        try {
            const cached = localStorage.getItem(key);
            if (!cached) continue;

            const { data, timestamp } = JSON.parse(cached);
            // Check if cache is still valid (24 hours)
            if (Date.now() - timestamp > 24 * 60 * 60 * 1000) continue;

            if (!data?.recommendations?.length) continue;

            candidates.push({ data, timestamp });
        } catch {
            continue;
        }
    }

    if (candidates.length === 0) return [];

    const newest = candidates.sort((a, b) => b.timestamp - a.timestamp)[0]?.data;
    if (!newest?.recommendations?.length) return [];

    const seenArtists = new Set<string>();
    const artists: AiArtist[] = [];

    for (const rec of newest.recommendations) {
        if (!rec.artistMbid) continue;
        const artistKey = rec.artistName.toLowerCase();
        if (seenArtists.has(artistKey)) continue;
        seenArtists.add(artistKey);

        artists.push({
            id: rec.artistMbid,
            mbid: rec.artistMbid,
            name: rec.artistName,
            coverArt: rec.coverUrl,
            tier: rec.tier,
            reason: rec.reason,
        });
    }

    return artists;
}

// Loading skeleton for playlist cards
function PlaylistSkeleton() {
    return (
        <div className="flex gap-3 overflow-hidden">
            {[...Array(8)].map((_, i) => (
                <div key={i} className="flex-shrink-0 w-[140px] sm:w-[160px] md:w-[170px] lg:w-[180px] p-3">
                    <div className="aspect-square rounded-md bg-white/5 animate-pulse mb-3" />
                    <div className="h-4 bg-white/5 rounded animate-pulse w-3/4 mb-2" />
                    <div className="h-3 bg-white/5 rounded animate-pulse w-1/2" />
                </div>
            ))}
        </div>
    );
}

export default function HomePage() {
    const [showMoodMixer, setShowMoodMixer] = useState(false);
    const [aiRecommendations, setAiRecommendations] = useState<AiArtist[]>(getAiRecommendationsFromCache);

    // Listen for discover page updates to refresh AI recommendations
    useEffect(() => {
        const handleUpdate = () => {
            const updated = getAiRecommendationsFromCache();
            setAiRecommendations(updated);
        };
        window.addEventListener("discover-recommendations-updated", handleUpdate);
        return () => window.removeEventListener("discover-recommendations-updated", handleUpdate);
    }, []);

    const {
        recentlyListened,
        recentlyAdded,
        recommended,
        mixes,
        featuredPlaylists,
        isLoading,
        isRefreshingMixes,
        isBrowseLoading,
        handleRefreshMixes,
    } = useHomeData();

    if (isLoading) {
        return <LoadingScreen />;
    }

    return (
        <div className="relative">
            <HomeHero />

            <div className="relative max-w-[1800px] mx-auto px-4 sm:px-6 pb-8">
                <div className="space-y-8">
                    {/* Library Radio Stations - Quick shuffle from your library */}
                    <section>
                        <SectionHeader title="Library Radio" showAllHref="/radio" />
                        <LibraryRadioStations />
                    </section>

                    {/* Continue Listening - #1 Priority */}
                    {recentlyListened.length > 0 && (
                        <section>
                            <SectionHeader title="Continue Listening" showAllHref="/library?tab=artists" />
                            <ContinueListening items={recentlyListened} />
                        </section>
                    )}

                    {/* Recently Added - #2 Priority */}
                    {recentlyAdded.length > 0 && (
                        <section>
                            <SectionHeader title="Recently Added" showAllHref="/library?tab=artists&sortBy=dateAdded" />
                            <ArtistsGrid artists={recentlyAdded} />
                        </section>
                    )}

                    {/* Most Played Artists */}
                    <MostPlayedArtists />

                    {/* Made For You - #3 Priority */}
                    {mixes.length > 0 && (
                        <section>
                            <SectionHeader
                                title="Made For You"
                                rightAction={
                                    <div className="flex items-center gap-2">
                                        <button
                                            onClick={() => setShowMoodMixer(true)}
                                            className="flex items-center gap-2 px-3 py-1.5 text-sm text-black font-semibold bg-brand hover:bg-brand-hover rounded-full transition-colors"
                                        >
                                            <AudioWaveform className="w-4 h-4" />
                                            <span className="hidden sm:inline">Mood Mixer</span>
                                        </button>
                                        <button
                                            onClick={handleRefreshMixes}
                                            disabled={isRefreshingMixes}
                                            className="flex items-center gap-2 px-3 py-1.5 text-sm text-gray-400 hover:text-white transition-colors font-semibold group bg-white/5 hover:bg-white/10 rounded-full disabled:opacity-50 disabled:cursor-not-allowed"
                                        >
                                            {isRefreshingMixes ? (
                                                <GradientSpinner size="sm" />
                                            ) : (
                                                <RefreshCw className="w-4 h-4 group-hover:rotate-180 transition-transform duration-500" />
                                            )}
                                            <span className="hidden sm:inline">
                                                {isRefreshingMixes ? "Refreshing..." : "Refresh"}
                                            </span>
                                        </button>
                                    </div>
                                }
                            />
                            <MixesGrid mixes={mixes} />
                        </section>
                    )}

                    {/* Discover New Artists - AI-powered */}
                    <section>
                        <SectionHeader
                            title="Discover New Artists"
                            showAllHref="/discover"
                            showAllText="Explore"
                            badge="AI"
                        />
                        {aiRecommendations.length > 0 ? (
                            <ArtistsGrid artists={aiRecommendations} />
                        ) : (
                            <div className="flex items-center gap-4 py-4">
                                <a
                                    href="/discover"
                                    className="flex items-center gap-3 px-5 py-3 bg-gradient-to-r from-fuchsia-600/20 to-purple-600/20 hover:from-fuchsia-600/30 hover:to-purple-600/30 border border-fuchsia-500/30 rounded-xl transition-all group"
                                >
                                    <div className="w-10 h-10 bg-fuchsia-500/20 rounded-lg flex items-center justify-center">
                                        <Compass className="w-5 h-5 text-fuchsia-400" />
                                    </div>
                                    <div>
                                        <p className="text-sm font-medium text-white group-hover:text-fuchsia-300 transition-colors">AI-Powered Discovery</p>
                                        <p className="text-xs text-gray-400">Safe, Adjacent, or Adventurous recommendations</p>
                                    </div>
                                </a>
                            </div>
                        )}
                    </section>

                    {/* Similar to Your Favorites - Last.fm */}
                    {recommended.length > 0 && (
                        <section>
                            <SectionHeader
                                title="Similar to Your Favorites"
                                showAllHref="/recommendations"
                                showAllText="Explore"
                                badge="Last.FM"
                            />
                            <ArtistsGrid artists={recommended} />
                        </section>
                    )}

                    {/* Featured Playlists */}
                    {(isBrowseLoading || featuredPlaylists.length > 0) && (
                        <section>
                            <SectionHeader title="Featured Playlists" showAllHref="/browse/playlists" badge="Deezer" />
                            {isBrowseLoading && featuredPlaylists.length === 0 ? (
                                <PlaylistSkeleton />
                            ) : (
                                <FeaturedPlaylistsGrid playlists={featuredPlaylists} />
                            )}
                        </section>
                    )}

                </div>
            </div>

            {/* Mood Mixer Modal */}
            <MoodMixer isOpen={showMoodMixer} onClose={() => setShowMoodMixer(false)} />
        </div>
    );
}
