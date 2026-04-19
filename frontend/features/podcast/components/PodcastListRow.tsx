"use client";

import { useState } from "react";
import Image from "next/image";
import { Mic2, Rss, Check } from "lucide-react";
import { api } from "@/lib/api";
import { CompactToggle } from "./CompactToggle";
import { Podcast } from "../types";

interface PodcastListRowProps {
    podcast: Podcast & { episodeCount?: number };
    adRemovalAvailable: boolean;
    onUpdateSettings: (
        podcastId: string,
        settings: { autoDownload?: boolean; autoRemoveAds?: boolean }
    ) => Promise<void>;
    onClick: (podcastId: string) => void;
}

const getProxiedImageUrl = (imageUrl: string | undefined): string | null => {
    if (!imageUrl) return null;
    return api.getCoverArtUrl(imageUrl, 96);
};

const formatRelativeTime = (dateString: string | undefined): string => {
    if (!dateString) return "—";
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);
    const diffWeeks = Math.floor(diffDays / 7);
    const diffMonths = Math.floor(diffDays / 30);

    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    if (diffWeeks < 4) return `${diffWeeks}w ago`;
    return `${diffMonths}mo ago`;
};

export function PodcastListRow({
    podcast,
    adRemovalAvailable,
    onUpdateSettings,
    onClick,
}: PodcastListRowProps) {
    const [autoDownload, setAutoDownload] = useState(podcast.autoDownload);
    const [autoRemoveAds, setAutoRemoveAds] = useState(podcast.autoRemoveAds);
    const [rssCopied, setRssCopied] = useState(false);

    const imageUrl = getProxiedImageUrl(podcast.coverUrl);
    const episodeCount = podcast.episodeCount ?? podcast.episodes?.length ?? 0;
    const lastEpisodeDate = podcast.episodes?.[0]?.publishedAt;

    const handleAutoDownloadChange = async (checked: boolean) => {
        const previousValue = autoDownload;
        setAutoDownload(checked);
        try {
            await onUpdateSettings(podcast.id, { autoDownload: checked });
        } catch (_error) {
            setAutoDownload(previousValue);
        }
    };

    const handleAutoRemoveAdsChange = async (checked: boolean) => {
        const previousAdRemove = autoRemoveAds;
        const previousAutoDownload = autoDownload;

        // When enabling ad-free, also enable auto-download (required dependency)
        if (checked && !autoDownload) {
            setAutoDownload(true);
        }
        setAutoRemoveAds(checked);

        try {
            // If enabling ad-free, ensure auto-download is also enabled
            const settings: { autoRemoveAds: boolean; autoDownload?: boolean } = {
                autoRemoveAds: checked
            };
            if (checked && !previousAutoDownload) {
                settings.autoDownload = true;
            }
            await onUpdateSettings(podcast.id, settings);
        } catch (_error) {
            setAutoRemoveAds(previousAdRemove);
            setAutoDownload(previousAutoDownload);
        }
    };

    // Auto-DL is locked when Ad-free is enabled (ad removal requires downloaded files)
    const autoDownloadLocked = autoRemoveAds;

    const handleCopyRssFeed = async (e: React.MouseEvent) => {
        e.stopPropagation();
        if (!podcast.accessToken) return;

        const baseUrl = window.location.origin;
        const rssUrl = `${baseUrl}/api/podcasts/${podcast.id}/rss?token=${podcast.accessToken}`;

        try {
            await navigator.clipboard.writeText(rssUrl);
            setRssCopied(true);
            setTimeout(() => setRssCopied(false), 2000);
        } catch (error) {
            console.error("Failed to copy RSS URL:", error);
        }
    };

    // Desktop grid template must match header
    const gridTemplate = adRemovalAvailable
        ? "md:grid md:grid-cols-[1fr_80px_80px_48px_48px_40px]"
        : "md:grid md:grid-cols-[1fr_80px_80px_48px_40px]";

    return (
        <div
            onClick={() => onClick(podcast.id)}
            className={`group flex flex-col ${gridTemplate} md:items-center gap-3 md:gap-4 p-3 rounded-lg hover:bg-white/5 transition-colors cursor-pointer`}
        >
            {/* Cover + Title + Author */}
            <div className="flex items-center gap-3 min-w-0">
                {/* Cover */}
                <div className="w-10 h-10 md:w-12 md:h-12 bg-[#282828] rounded-lg flex-shrink-0 overflow-hidden relative">
                    {imageUrl ? (
                        <Image
                            src={imageUrl}
                            alt={podcast.title}
                            fill
                            sizes="48px"
                            className="object-cover"
                            unoptimized
                        />
                    ) : (
                        <div className="w-full h-full flex items-center justify-center">
                            <Mic2 className="w-5 h-5 text-gray-600" />
                        </div>
                    )}
                </div>

                {/* Title + Author (+ Episode count on mobile) */}
                <div className="flex-1 min-w-0">
                    <h3 className="text-sm font-medium text-white truncate">
                        {podcast.title}
                    </h3>
                    <p className="text-xs text-gray-400 truncate">
                        {podcast.author}
                        <span className="md:hidden">
                            {" · "}
                            {episodeCount} ep
                        </span>
                    </p>
                </div>

                {/* Mobile: RSS button in header row */}
                <button
                    onClick={handleCopyRssFeed}
                    className="md:hidden p-2 rounded-lg text-gray-400 hover:text-white hover:bg-white/10 transition-colors flex-shrink-0"
                    title="Copy RSS feed URL"
                    disabled={!podcast.accessToken}
                >
                    {rssCopied ? (
                        <Check className="w-4 h-4 text-green-500" />
                    ) : (
                        <Rss className="w-4 h-4" />
                    )}
                </button>
            </div>

            {/* Desktop: Episode Count Badge */}
            <div className="hidden md:flex items-center justify-center">
                <span className="px-2 py-1 text-xs text-gray-400 bg-[#1a1a1a] rounded">
                    {episodeCount} ep
                </span>
            </div>

            {/* Desktop: Last Updated */}
            <div className="hidden md:flex items-center justify-center">
                <span className="text-xs text-gray-500">
                    {formatRelativeTime(lastEpisodeDate)}
                </span>
            </div>

            {/* Mobile: Toggles Row */}
            <div className="flex md:hidden items-center gap-4 pl-[52px]">
                <div
                    className="flex items-center gap-2"
                    onClick={(e) => e.stopPropagation()}
                >
                    <span className="text-xs text-gray-400">Auto-DL</span>
                    <CompactToggle
                        checked={autoDownload}
                        onChange={handleAutoDownloadChange}
                        locked={autoDownloadLocked}
                        variant="green"
                    />
                </div>

                {adRemovalAvailable && (
                    <div
                        className="flex items-center gap-2"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <span className="text-xs text-gray-400">Ad-free</span>
                        <CompactToggle
                            checked={autoRemoveAds}
                            onChange={handleAutoRemoveAdsChange}
                            variant="purple"
                        />
                    </div>
                )}
            </div>

            {/* Desktop: Auto-Download Toggle */}
            <div
                className="hidden md:flex items-center justify-center"
                onClick={(e) => e.stopPropagation()}
            >
                <CompactToggle
                    checked={autoDownload}
                    onChange={handleAutoDownloadChange}
                    locked={autoDownloadLocked}
                    variant="green"
                />
            </div>

            {/* Desktop: Ad-Free Toggle (only if available) */}
            {adRemovalAvailable && (
                <div
                    className="hidden md:flex items-center justify-center"
                    onClick={(e) => e.stopPropagation()}
                >
                    <CompactToggle
                        checked={autoRemoveAds}
                        onChange={handleAutoRemoveAdsChange}
                        variant="purple"
                    />
                </div>
            )}

            {/* Desktop: RSS Button */}
            <button
                onClick={handleCopyRssFeed}
                className="hidden md:flex items-center justify-center p-2 rounded-lg text-gray-400 hover:text-white hover:bg-white/10 transition-colors"
                title="Copy RSS feed URL"
                disabled={!podcast.accessToken}
            >
                {rssCopied ? (
                    <Check className="w-4 h-4 text-green-500" />
                ) : (
                    <Rss className="w-4 h-4" />
                )}
            </button>
        </div>
    );
}
