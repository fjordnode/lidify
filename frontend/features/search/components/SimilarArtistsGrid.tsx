import Link from "next/link";
import Image from "next/image";
import { Music } from "lucide-react";
import { cn } from "@/utils/cn";
import { DiscoverResult } from "../types";
import { api } from "@/lib/api";

interface SimilarArtistsGridProps {
    discoverResults: DiscoverResult[];
    skipFirst?: boolean; // Skip first result if it was shown in TopResult
    isLoading?: boolean;
}

// Always proxy images through the backend for caching and mobile compatibility
const getProxiedImageUrl = (imageUrl: string | undefined): string | null => {
    if (!imageUrl) return null;
    return api.getCoverArtUrl(imageUrl, 300);
};

export function SimilarArtistsGrid({
    discoverResults,
    skipFirst = true,
    isLoading = false,
}: SimilarArtistsGridProps) {
    const artistResults = discoverResults.filter((r) => r.type === "music");

    // Skip first if it was shown in TopResult, otherwise show all
    const startIndex = skipFirst ? 1 : 0;
    const displayResults = artistResults.slice(startIndex, startIndex + 3);

    // Show loading state
    if (isLoading) {
        return (
            <section>
                <h2 className="text-2xl font-bold text-white mb-6">
                    More on Last.fm
                </h2>
                <div className="flex items-center gap-3 text-gray-400">
                    <div className="w-5 h-5 border-2 border-gray-400 border-t-transparent rounded-full animate-spin" />
                    <span>Searching Last.fm...</span>
                </div>
            </section>
        );
    }

    if (displayResults.length === 0) {
        return null;
    }

    return (
        <section>
            <h2 className="text-2xl font-bold text-white mb-6">
                More on Last.fm
            </h2>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-8 3xl:grid-cols-10 gap-4" data-tv-section="search-results-artists">
                {displayResults.map((result, index) => {
                    // Use MBID if available, otherwise use name (Next.js Link handles encoding)
                    const artistId = result.mbid || result.name;
                    const imageUrl = getProxiedImageUrl(result.image);

                    return (
                        <Link
                            key={`artist-${artistId}-${index}`}
                            href={`/artist/${artistId}`}
                            data-tv-card
                            data-tv-card-index={index}
                            tabIndex={0}
                        >
                            <div className="bg-[#121212] hover:bg-[#181818] transition-all p-4 rounded-lg group cursor-pointer">
                                <div className="aspect-square bg-[#181818] rounded-full mb-4 flex items-center justify-center overflow-hidden relative">
                                    {imageUrl ? (
                                        <Image
                                            src={imageUrl}
                                            alt={result.name}
                                            fill
                                            sizes="(max-width: 640px) 50vw, (max-width: 768px) 33vw, (max-width: 1024px) 25vw, 16vw"
                                            className="object-cover group-hover:scale-110 transition-all"
                                            unoptimized
                                        />
                                    ) : (
                                        <Music className="w-12 h-12 text-gray-600" />
                                    )}
                                </div>
                                <h3 className="text-base font-bold text-white line-clamp-1 mb-1">
                                    {result.name}
                                </h3>
                                <p className="text-sm text-[#b3b3b3]">Artist</p>
                            </div>
                        </Link>
                    );
                })}
            </div>
        </section>
    );
}
