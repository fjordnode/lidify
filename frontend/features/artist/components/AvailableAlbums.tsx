"use client";

import { useState, useEffect } from "react";
import { Album, ArtistSource } from "../types";
import { PlayableCard } from "@/components/ui/PlayableCard";
import { Disc3 } from "lucide-react";
import { api } from "@/lib/api";

interface AvailableAlbumsProps {
    albums: Album[];
    artistName: string;
    source: ArtistSource;
    colors: any;
    onDownloadAlbum: (album: Album, e: React.MouseEvent) => void;
    onSearchAlbum: (album: Album, e: React.MouseEvent) => void;
    isPendingDownload: (mbid: string) => boolean;
}

// Component to handle lazy-loading cover art for albums without cached covers
function LazyAlbumCard({
    album,
    source,
    colors,
    onDownloadAlbum,
    onSearchAlbum,
    isPendingDownload,
    index,
}: {
    album: Album;
    source: ArtistSource;
    colors: any;
    onDownloadAlbum: (album: Album, e: React.MouseEvent) => void;
    onSearchAlbum: (album: Album, e: React.MouseEvent) => void;
    isPendingDownload: (mbid: string) => boolean;
    index: number;
}) {
    const [coverArt, setCoverArt] = useState<string | null>(() => {
        // Initial cover art from props - check both coverArt and coverUrl for compatibility
        const cover = album.coverArt || album.coverUrl;
        if (cover) {
            return api.getCoverArtUrl(cover, 300);
        }
        return null;
    });
    const [fetchAttempted, setFetchAttempted] = useState(false);

    // Lazy-load cover art if not available
    useEffect(() => {
        if (coverArt || fetchAttempted) return;

        const mbid = album.rgMbid || album.mbid;
        if (!mbid || mbid.startsWith("temp-")) return;

        let isMounted = true;

        // Fetch cover art from our backend (which caches it)
        const fetchCover = async () => {
            try {
                const response = await api.request<{ coverUrl: string }>(
                    `/library/album-cover/${mbid}`
                );
                if (isMounted && response.coverUrl) {
                    setCoverArt(api.getCoverArtUrl(response.coverUrl, 300));
                }
            } catch {
                // Cover not found, leave as null
            } finally {
                if (isMounted) {
                    setFetchAttempted(true);
                }
            }
        };

        // Delay fetch slightly to avoid thundering herd on page load
        const timeoutId = setTimeout(fetchCover, index * 100);
        return () => {
            isMounted = false;
            clearTimeout(timeoutId);
        };
    }, [album, coverArt, fetchAttempted, index]);

    // Get MBID for download tracking
    const albumMbid = album.rgMbid || album.mbid || "";

    // Build subtitle with year and type
    const subtitleParts: string[] = [];
    if (album.year) subtitleParts.push(String(album.year));
    if (album.type) subtitleParts.push(album.type);
    const subtitle = subtitleParts.join(" • ");

    return (
        <PlayableCard
            key={album.id}
            href={`/album/${album.id}`}
            coverArt={coverArt}
            title={album.title}
            subtitle={subtitle}
            placeholderIcon={
                <Disc3 className="w-12 h-12 text-gray-600" />
            }
            circular={false}
            badge="download"
            showPlayButton={false}
            colors={colors}
            isDownloading={isPendingDownload(albumMbid)}
            onDownload={(e) => onDownloadAlbum(album, e)}
            onSearch={(e) => onSearchAlbum(album, e)}
            tvCardIndex={index}
        />
    );
}

function AlbumGrid({
    albums,
    source,
    colors,
    onDownloadAlbum,
    onSearchAlbum,
    isPendingDownload,
}: Omit<AvailableAlbumsProps, "artistName">) {
    return (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
            {albums.map((album, index) => (
                <LazyAlbumCard
                    key={album.id}
                    album={album}
                    source={source}
                    colors={colors}
                    onDownloadAlbum={onDownloadAlbum}
                    onSearchAlbum={onSearchAlbum}
                    isPendingDownload={isPendingDownload}
                    index={index}
                />
            ))}
        </div>
    );
}

export function AvailableAlbums({
    albums,
    artistName,
    source,
    colors,
    onDownloadAlbum,
    onSearchAlbum,
    isPendingDownload,
}: AvailableAlbumsProps) {
    if (!albums || albums.length === 0) {
        return null;
    }

    // Separate studio albums from EPs/Singles/Demos
    const studioAlbums = albums.filter(
        (album) => album.type?.toLowerCase() === "album"
    );
    const epsAndSingles = albums.filter(
        (album) => album.type?.toLowerCase() !== "album"
    );

    return (
        <>
            {/* Studio Albums Section */}
            {studioAlbums.length > 0 && (
                <section>
                    <h2 className="text-xl font-bold mb-4">
                        Albums Available
                    </h2>
                    <div data-tv-section="available-albums">
                        <AlbumGrid
                            albums={studioAlbums}
                            source={source}
                            colors={colors}
                            onDownloadAlbum={onDownloadAlbum}
                            onSearchAlbum={onSearchAlbum}
                            isPendingDownload={isPendingDownload}
                        />
                    </div>
                </section>
            )}

            {/* EPs, Singles & Demos Section */}
            {epsAndSingles.length > 0 && (
                <section>
                    <h2 className="text-xl font-bold mb-4">
                        Singles and EPs
                    </h2>
                    <div data-tv-section="available-eps-singles">
                        <AlbumGrid
                            albums={epsAndSingles}
                            source={source}
                            colors={colors}
                            onDownloadAlbum={onDownloadAlbum}
                            onSearchAlbum={onSearchAlbum}
                            isPendingDownload={isPendingDownload}
                        />
                    </div>
                </section>
            )}
        </>
    );
}
