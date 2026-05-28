"use client";

import Link from "next/link";
import Image from "next/image";
import { Music } from "lucide-react";
import { api } from "@/lib/api";
import { memo } from "react";
import { HorizontalCarousel, CarouselItem } from "@/components/ui/HorizontalCarousel";

type TierType = "high" | "medium" | "explore" | "wildcard";

interface Artist {
    id: string;
    mbid?: string;
    name: string;
    coverArt?: string;
    albumCount?: number;
    tier?: TierType;
    reason?: string;
}

const tierConfig: Record<TierType, { label: string; bgColor: string; textColor: string }> = {
    high: { label: "Safe Pick", bgColor: "bg-emerald-500/20", textColor: "text-emerald-400" },
    medium: { label: "Adjacent", bgColor: "bg-violet-500/20", textColor: "text-violet-300" },
    explore: { label: "Adjacent", bgColor: "bg-violet-500/20", textColor: "text-violet-300" },
    wildcard: { label: "Wildcard", bgColor: "bg-amber-400/20", textColor: "text-amber-300" },
};

interface ArtistsGridProps {
    artists: Artist[];
}

// Helper to get the correct image source
const getArtistImageSrc = (coverArt: string | undefined) => {
    if (!coverArt) {
        return null;
    }
    return api.getCoverArtUrl(coverArt, 300);
};

interface ArtistCardProps {
    artist: Artist;
    index: number;
}

const ArtistCard = memo(
    function ArtistCard({ artist, index }: ArtistCardProps) {
        const imageSrc = getArtistImageSrc(artist.coverArt);
        const tier = artist.tier ? tierConfig[artist.tier] : null;

        return (
            <CarouselItem>
                <Link
                    href={`/artist/${artist.id}`}
                    data-tv-card
                    data-tv-card-index={index}
                    tabIndex={0}
                >
                    <div className="p-3 rounded-md group/card cursor-pointer hover:bg-white/5 transition-colors relative">
                        <div className="aspect-square bg-[#282828] rounded-full mb-2 flex items-center justify-center overflow-hidden relative shadow-lg">
                            {artist.coverArt && imageSrc ? (
                                <Image
                                    src={imageSrc}
                                    alt={artist.name}
                                    fill
                                    className="object-cover group-hover/card:scale-105 transition-transform duration-300"
                                    sizes="180px"
                                    priority={false}
                                    unoptimized
                                />
                            ) : (
                                <Music className="w-10 h-10 text-gray-600" />
                            )}
                        </div>
                        {/* Tier badge below image */}
                        {tier && (
                            <div className="flex justify-center mb-1">
                                <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${tier.bgColor} ${tier.textColor}`}>
                                    {tier.label}
                                </span>
                            </div>
                        )}
                        <h3 className="text-sm font-semibold text-white truncate text-center">
                            {artist.name}
                        </h3>
                        {/* Show AI reason always, or fallback to "Artist" label */}
                        {artist.reason ? (
                            <p className="text-[11px] text-gray-400 mt-1 text-center leading-snug">
                                {artist.reason}
                            </p>
                        ) : (
                            <p className="text-xs text-gray-400 mt-0.5 text-center">Artist</p>
                        )}
                    </div>
                </Link>
            </CarouselItem>
        );
    },
    (prevProps, nextProps) => {
        return prevProps.artist.id === nextProps.artist.id && prevProps.index === nextProps.index;
    }
);

const ArtistsGrid = memo(function ArtistsGrid({ artists }: ArtistsGridProps) {
    return (
        <HorizontalCarousel>
            {artists.map((artist, index) => (
                <ArtistCard key={artist.id} artist={artist} index={index} />
            ))}
        </HorizontalCarousel>
    );
});

export { ArtistsGrid, getArtistImageSrc };
