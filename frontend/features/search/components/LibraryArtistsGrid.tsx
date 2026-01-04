import Link from "next/link";
import Image from "next/image";
import { Music } from "lucide-react";
import { api } from "@/lib/api";

interface LibraryArtist {
    id: string;
    mbid?: string;
    name: string;
    heroUrl?: string | null;
    summary?: string | null;
}

interface LibraryArtistsGridProps {
    artists: LibraryArtist[];
}

// Always proxy images through the backend for caching and mobile compatibility
const getProxiedImageUrl = (imageUrl: string | undefined | null): string | null => {
    if (!imageUrl) return null;
    return api.getCoverArtUrl(imageUrl, 300);
};

export function LibraryArtistsGrid({ artists }: LibraryArtistsGridProps) {
    if (!artists || artists.length === 0) {
        return null;
    }

    return (
        <section>
            <h2 className="text-2xl font-bold text-white mb-6">
                Artists in Your Library
            </h2>
            <div
                className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-8 3xl:grid-cols-10 gap-4"
                data-tv-section="search-results-library-artists"
            >
                {artists.map((artist, index) => {
                    const imageUrl = getProxiedImageUrl(artist.heroUrl);

                    return (
                        <Link
                            key={artist.id}
                            href={`/artist/${artist.id}`}
                            data-tv-card
                            data-tv-card-index={index}
                            tabIndex={0}
                        >
                            <div className="bg-[#121212] hover:bg-[#181818] transition-all p-4 rounded-lg group cursor-pointer">
                                <div className="aspect-square bg-[#181818] rounded-full mb-4 flex items-center justify-center overflow-hidden relative">
                                    {imageUrl ? (
                                        <Image
                                            src={imageUrl}
                                            alt={artist.name}
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
                                    {artist.name}
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
