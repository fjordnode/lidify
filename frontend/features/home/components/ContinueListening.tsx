"use client";

import Link from "next/link";
import Image from "next/image";
import { Music, Disc } from "lucide-react";
import { api } from "@/lib/api";
import { HorizontalCarousel, CarouselItem } from "@/components/ui/HorizontalCarousel";
import { memo } from "react";

interface ContinueListeningItem {
    id: string;
    mbid?: string;
    name: string;
    type: "artist" | "podcast" | "audiobook";
    coverArt?: string;
    progress?: number;
    author?: string;
}

interface ContinueListeningProps {
    items: ContinueListeningItem[];
}

// Helper to get the correct image source
const getArtistImageSrc = (coverArt: string | undefined) => {
    if (!coverArt) {
        return null;
    }
    return api.getCoverArtUrl(coverArt, 300);
};

const getImageForItem = (item: ContinueListeningItem) => {
    if (item.coverArt) {
        return getArtistImageSrc(item.coverArt);
    }

    return null;
};

const getDescriptionLabel = (item: ContinueListeningItem) => {
    if (item.type === "podcast") {
        if (
            item.author &&
            item.author.trim().length > 0 &&
            item.author.trim().toLowerCase() !== item.name.trim().toLowerCase()
        ) {
            return item.author;
        }
        return "Podcast";
    }

    return "Artist";
};

interface ContinueListeningCardProps {
    item: ContinueListeningItem;
    index: number;
}

const ContinueListeningCard = memo(function ContinueListeningCard({ 
    item, 
    index 
}: ContinueListeningCardProps) {
    const isPodcast = item.type === "podcast";
    const imageSrc = getImageForItem(item);
    const href = isPodcast
        ? `/podcasts/${item.id}`
        : `/artist/${item.id}`;
    const hasProgress =
        isPodcast &&
        item.progress &&
        item.progress > 0;

    return (
        <CarouselItem>
            <Link
                href={href}
                data-tv-card
                data-tv-card-index={index}
                tabIndex={0}
            >
                <div className="p-3 rounded-md group cursor-pointer hover:bg-white/5 transition-colors h-full flex flex-col">
                    <div className="aspect-square bg-[#282828] rounded-full mb-3 flex items-center justify-center overflow-hidden relative shadow-lg shrink-0">
                        {imageSrc ? (
                            <Image
                                src={imageSrc}
                                alt={item.name}
                                fill
                                className="object-cover group-hover:scale-105 transition-transform duration-300"
                                sizes="180px"
                                priority={false}
                                unoptimized
                            />
                        ) : isPodcast ? (
                            <Disc className="w-10 h-10 text-gray-600" />
                        ) : (
                            <Music className="w-10 h-10 text-gray-600" />
                        )}
                        {hasProgress && (
                            <div className="absolute bottom-0 left-0 right-0 h-1 bg-black/50">
                                <div
                                    className="h-full bg-brand"
                                    style={{
                                        width: `${item.progress}%`,
                                    }}
                                />
                            </div>
                        )}
                    </div>
                    <div className="flex-1 flex flex-col">
                        <h3 className="text-sm font-semibold text-white truncate text-center">
                            {item.name}
                        </h3>
                        <p className="text-xs text-gray-400 truncate mt-0.5 text-center">
                            {getDescriptionLabel(item)}
                        </p>
                    </div>
                </div>
            </Link>
        </CarouselItem>
    );
});

export function ContinueListening({ items }: ContinueListeningProps) {
    // Filter out audiobooks (feature hidden)
    const filteredItems = items.filter(item => item.type !== "audiobook");
    
    return (
        <HorizontalCarousel>
            {filteredItems.map((item, index) => (
                <ContinueListeningCard 
                    key={`${item.type}-${item.id}`} 
                    item={item} 
                    index={index} 
                />
            ))}
        </HorizontalCarousel>
    );
}
