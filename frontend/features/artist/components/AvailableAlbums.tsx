"use client";

import { useState, useEffect, useMemo } from "react";
import { Album, ArtistSource } from "../types";
import type { ColorPalette } from "@/hooks/useImageColor";
import { PlayableCard } from "@/components/ui/PlayableCard";
import { Disc3 } from "lucide-react";
import { api } from "@/lib/api";

interface AvailableAlbumsProps {
    albums: Album[];
    artistName: string;
    source: ArtistSource;
    colors: ColorPalette | null;
    onDownloadAlbum: (album: Album, e: React.MouseEvent) => void;
    onSearchAlbum: (album: Album, e: React.MouseEvent) => void;
    isPendingDownload: (mbid: string) => boolean;
}

type AvailableAlbumSort = "release-desc" | "release-asc" | "popularity-desc" | "title-asc";

function getReleaseTime(album: Album) {
    if (album.releaseDate) {
        const parsed = Date.parse(album.releaseDate);
        if (Number.isFinite(parsed)) return parsed;
    }
    return album.year ? Date.UTC(album.year, 0, 1) : 0;
}

function getPopularity(album: Album) {
    return album.playCount || album.listeners || 0;
}

function formatPlayCount(count: number) {
    if (count >= 1000000) return `${(count / 1000000).toFixed(1)}M plays`;
    if (count >= 1000) return `${Math.round(count / 1000)}K plays`;
    return `${count} plays`;
}

function sortAlbums(albums: Album[], sort: AvailableAlbumSort) {
    return [...albums].sort((a, b) => {
        if (sort === "popularity-desc") {
            const popularityDiff = getPopularity(b) - getPopularity(a);
            if (popularityDiff !== 0) return popularityDiff;
            return getReleaseTime(b) - getReleaseTime(a);
        }

        if (sort === "release-asc") {
            const releaseDiff = getReleaseTime(a) - getReleaseTime(b);
            if (releaseDiff !== 0) return releaseDiff;
            return a.title.localeCompare(b.title);
        }

        if (sort === "title-asc") {
            return a.title.localeCompare(b.title);
        }

        const releaseDiff = getReleaseTime(b) - getReleaseTime(a);
        if (releaseDiff !== 0) return releaseDiff;
        return a.title.localeCompare(b.title);
    });
}

// Component to handle lazy-loading cover art for albums without cached covers
function LazyAlbumCard({
    album,
    colors,
    onDownloadAlbum,
    onSearchAlbum,
    isPendingDownload,
    index,
}: {
    album: Album;
    source: ArtistSource;
    colors: ColorPalette | null;
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
    if (album.playCount) subtitleParts.push(formatPlayCount(album.playCount));
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
    source,
    colors,
    onDownloadAlbum,
    onSearchAlbum,
    isPendingDownload,
}: AvailableAlbumsProps) {
    const [sort, setSort] = useState<AvailableAlbumSort>("release-desc");
    const hasPopularity = useMemo(
        () => albums?.some((album) => getPopularity(album) > 0) ?? false,
        [albums]
    );

    if (!albums || albums.length === 0) {
        return null;
    }

    // Separate studio albums from EPs/Singles/Demos
    const studioAlbums = sortAlbums(
        albums.filter((album) => album.type?.toLowerCase() === "album"),
        sort
    );
    const epsAndSingles = sortAlbums(
        albums.filter((album) => album.type?.toLowerCase() !== "album"),
        sort
    );

    const sortControl = (
        <div className="flex items-center gap-2 text-sm text-white/60">
            <span>Sort</span>
            <select
                value={sort}
                onChange={(event) => setSort(event.target.value as AvailableAlbumSort)}
                className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-white outline-none transition hover:bg-white/10 focus:border-brand/60"
            >
                <option value="release-desc" className="bg-neutral-950">Newest release</option>
                <option value="release-asc" className="bg-neutral-950">Oldest release</option>
                <option value="popularity-desc" className="bg-neutral-950" disabled={!hasPopularity}>
                    Last.fm plays
                </option>
                <option value="title-asc" className="bg-neutral-950">Title</option>
            </select>
        </div>
    );

    return (
        <>
            {/* Studio Albums Section */}
            {studioAlbums.length > 0 && (
                <section>
                    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                        <h2 className="text-xl font-bold">Albums Available</h2>
                        {sortControl}
                    </div>
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
                    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                        <h2 className="text-xl font-bold">Singles and EPs</h2>
                        {studioAlbums.length === 0 ? sortControl : null}
                    </div>
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
