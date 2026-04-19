"use client";

import { useState } from "react";
import { ExternalLink, Trash2, Plus, Loader2, Download, Sparkles, Link2, Check } from "lucide-react";
import type { ColorPalette } from "@/hooks/useImageColor";

interface PodcastActionBarProps {
    isSubscribed: boolean;
    podcastId?: string;
    feedUrl?: string;
    colors: ColorPalette | null;
    isSubscribing: boolean;
    showDeleteConfirm: boolean;
    onSubscribe: () => void;
    onRemove: () => void;
    onShowDeleteConfirm: (show: boolean) => void;
    // Auto-download/ad-removal settings
    autoDownload?: boolean;
    autoRemoveAds?: boolean;
    adRemovalAvailable?: boolean;
    onSetAutoMode?: (mode: "off" | "download" | "download_and_adfree") => void;
    // Per-subscription access token for M3U URLs
    accessToken?: string;
}

type AutoMode = "off" | "download" | "download_and_adfree";

export function PodcastActionBar({
    isSubscribed,
    podcastId,
    feedUrl,
    isSubscribing,
    showDeleteConfirm,
    onSubscribe,
    onRemove,
    onShowDeleteConfirm,
    autoDownload = false,
    autoRemoveAds = false,
    adRemovalAvailable = false,
    onSetAutoMode,
    accessToken,
}: PodcastActionBarProps) {
    const [m3uCopied, setM3uCopied] = useState(false);

    // Derive current mode from props
    const currentMode: AutoMode = autoRemoveAds ? "download_and_adfree" : autoDownload ? "download" : "off";

    const handleCopyFeedUrl = async () => {
        if (!podcastId) return;

        const baseUrl = window.location.origin;
        // RSS feed URL for external podcast apps (AntennaPod, Pocket Casts, etc.)
        const feedUrl = accessToken
            ? `${baseUrl}/api/podcasts/${podcastId}/feed.xml?token=${accessToken}`
            : `${baseUrl}/api/podcasts/${podcastId}/feed.xml`;

        try {
            await navigator.clipboard.writeText(feedUrl);
            setM3uCopied(true);
            setTimeout(() => setM3uCopied(false), 2000);
        } catch (err) {
            console.error("Failed to copy feed URL:", err);
        }
    };

    const handleModeSelect = (mode: AutoMode) => {
        if (!onSetAutoMode) return;
        // If clicking the currently selected mode, turn it off
        if (mode === currentMode) {
            onSetAutoMode("off");
        } else {
            onSetAutoMode(mode);
        }
    };

    return (
        <div className="flex flex-wrap items-center gap-3">
            {/* Subscribe Button */}
            {!isSubscribed && (
                <button
                    onClick={onSubscribe}
                    disabled={isSubscribing}
                    className="h-12 px-6 rounded-full bg-brand hover:bg-brand-light hover:scale-105 transition-all flex items-center gap-2 font-semibold text-black disabled:opacity-50"
                >
                    {isSubscribing ? (
                        <>
                            <Loader2 className="w-5 h-5 animate-spin" />
                            <span>Subscribing...</span>
                        </>
                    ) : (
                        <>
                            <Plus className="w-5 h-5" />
                            <span>Subscribe</span>
                        </>
                    )}
                </button>
            )}

            {/* RSS Feed Link */}
            {feedUrl && (
                <a
                    href={feedUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="p-2.5 rounded-full text-white/60 hover:text-white hover:bg-white/10 transition-all"
                    title="RSS Feed"
                >
                    <ExternalLink className="w-5 h-5" />
                </a>
            )}

            {/* Auto-download segmented control */}
            {isSubscribed && onSetAutoMode && (
                <div className="flex rounded-full bg-white/5 p-1">
                    <button
                        onClick={() => handleModeSelect("download")}
                        className={`px-3 py-1.5 rounded-full text-sm font-medium transition-all flex items-center gap-1.5 ${
                            currentMode === "download"
                                ? "bg-green-500/30 text-green-400"
                                : "text-white/60 hover:text-white/80 hover:bg-white/5"
                        }`}
                        title="Automatically download new episodes"
                    >
                        <Download className="w-4 h-4" />
                        <span className="hidden md:inline">Auto-download</span>
                    </button>

                    {adRemovalAvailable && (
                        <button
                            onClick={() => handleModeSelect("download_and_adfree")}
                            className={`px-3 py-1.5 rounded-full text-sm font-medium transition-all flex items-center gap-1.5 ${
                                currentMode === "download_and_adfree"
                                    ? "bg-brand/30 text-brand"
                                    : "text-white/60 hover:text-white/80 hover:bg-white/5"
                            }`}
                            title="Automatically download and remove ads from new episodes"
                        >
                            <Sparkles className="w-4 h-4" />
                            <span className="hidden md:inline">Auto + Ad-removal</span>
                        </button>
                    )}
                </div>
            )}

            {/* RSS Feed Copy Button */}
            {isSubscribed && podcastId && (
                <button
                    onClick={handleCopyFeedUrl}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm transition-all ${
                        m3uCopied
                            ? "bg-green-500/20 text-green-400"
                            : "bg-white/5 text-white/50 hover:bg-white/10 hover:text-white/70"
                    }`}
                    title="Copy RSS feed URL for external podcast apps (AntennaPod, Pocket Casts, etc.)"
                >
                    {m3uCopied ? (
                        <>
                            <Check className="w-4 h-4" />
                            <span className="hidden md:inline">Copied!</span>
                        </>
                    ) : (
                        <>
                            <Link2 className="w-4 h-4" />
                            <span className="hidden md:inline">Feed</span>
                        </>
                    )}
                </button>
            )}

            {/* Spacer */}
            <div className="flex-1" />

            {/* Remove Podcast Button */}
            {isSubscribed && (
                <>
                    {!showDeleteConfirm ? (
                        <button
                            onClick={() => onShowDeleteConfirm(true)}
                            className="flex items-center gap-2 px-4 py-2 rounded-full text-red-400/80 hover:text-red-400 hover:bg-red-500/10 transition-all text-sm"
                        >
                            <Trash2 className="w-4 h-4" />
                            <span className="hidden md:inline">Remove</span>
                        </button>
                    ) : (
                        <div className="flex items-center gap-2">
                            <span className="text-sm text-white/50 hidden md:inline">
                                Remove podcast?
                            </span>
                            <button
                                onClick={onRemove}
                                className="px-4 py-2 rounded-full text-sm font-medium bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-all"
                            >
                                Confirm
                            </button>
                            <button
                                onClick={() => onShowDeleteConfirm(false)}
                                className="px-4 py-2 rounded-full text-sm font-medium bg-white/5 text-white/70 hover:bg-white/10 transition-all"
                            >
                                Cancel
                            </button>
                        </div>
                    )}
                </>
            )}
        </div>
    );
}
