"use client";

import { useState, memo } from "react";
import Link from "next/link";
import Image from "next/image";
import { Music } from "lucide-react";
import { api } from "@/lib/api";
import { useTopArtistsQuery } from "@/hooks/useQueries";
import { SectionHeader } from "./SectionHeader";
import {
    HorizontalCarousel,
    CarouselItem,
} from "@/components/ui/HorizontalCarousel";
import { cn } from "@/utils/cn";

type Period = "week" | "month" | "year" | "all";

const periods: { value: Period; label: string }[] = [
    { value: "week", label: "1W" },
    { value: "month", label: "1M" },
    { value: "year", label: "1Y" },
    { value: "all", label: "All" },
];

const getArtistImageSrc = (coverArt: string | null | undefined) => {
    if (!coverArt) return null;
    return api.getCoverArtUrl(coverArt, 300);
};

interface TopArtist {
    id: string;
    name: string;
    coverArt: string | null;
    playCount: number;
}

interface ArtistCardProps {
    artist: TopArtist;
    index: number;
    rank: number;
}

const ArtistCard = memo(
    function ArtistCard({ artist, index, rank }: ArtistCardProps) {
        const imageSrc = getArtistImageSrc(artist.coverArt);

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
                            {imageSrc ? (
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
                            {/* Rank badge */}
                            <div className="absolute bottom-0 right-0 w-7 h-7 rounded-full bg-black/80 border border-white/20 flex items-center justify-center">
                                <span className="text-xs font-bold text-white">
                                    {rank}
                                </span>
                            </div>
                        </div>
                        <h3 className="text-sm font-semibold text-white truncate text-center">
                            {artist.name}
                        </h3>
                        <p className="text-xs text-gray-400 mt-0.5 text-center">
                            {artist.playCount} {artist.playCount === 1 ? "play" : "plays"}
                        </p>
                    </div>
                </Link>
            </CarouselItem>
        );
    },
    (prevProps, nextProps) => {
        return (
            prevProps.artist.id === nextProps.artist.id &&
            prevProps.artist.playCount === nextProps.artist.playCount &&
            prevProps.rank === nextProps.rank
        );
    }
);

export function MostPlayedArtists() {
    const [period, setPeriod] = useState<Period>("month");
    const { data, isLoading } = useTopArtistsQuery(period, 20);
    const artists = data?.artists || [];

    // Don't render section at all if no play data exists (all periods empty)
    const { data: allTimeData } = useTopArtistsQuery("all", 1);
    if (!allTimeData?.artists?.length && !isLoading) return null;

    return (
        <section>
            <SectionHeader
                title="Most Played"
                rightAction={
                    <div className="flex items-center gap-1 bg-white/5 rounded-full p-0.5">
                        {periods.map((p) => (
                            <button
                                key={p.value}
                                onClick={() => setPeriod(p.value)}
                                className={cn(
                                    "px-3 py-1 text-xs font-semibold rounded-full transition-all",
                                    period === p.value
                                        ? "bg-white/15 text-white"
                                        : "text-gray-400 hover:text-white"
                                )}
                            >
                                {p.label}
                            </button>
                        ))}
                    </div>
                }
            />
            {isLoading ? (
                <div className="h-[180px] flex items-center justify-center">
                    <div className="w-5 h-5 border-2 border-gray-400 border-t-transparent rounded-full animate-spin" />
                </div>
            ) : artists.length === 0 ? (
                <p className="text-sm text-gray-500 py-4">
                    No plays recorded for this period
                </p>
            ) : (
                <HorizontalCarousel>
                    {artists.map((artist: TopArtist, index: number) => (
                        <ArtistCard
                            key={artist.id}
                            artist={artist}
                            index={index}
                            rank={index + 1}
                        />
                    ))}
                </HorizontalCarousel>
            )}
        </section>
    );
}
