import { useState } from "react";
import { Play, Pause, Shuffle, Download, ListPlus, Search } from "lucide-react";
import { cn } from "@/utils/cn";
import type { Album } from "../types";
import type { AlbumSource } from "../types";
import { ReleaseSelectionModal } from "@/components/ui/ReleaseSelectionModal";

const LIDIFY_YELLOW = "#ecb200";

interface AlbumActionBarProps {
    album: Album;
    source: AlbumSource;
    colors: any;
    onPlayAll: () => void;
    onShuffle: () => void;
    onDownloadAlbum: () => void;
    onAddToPlaylist: () => void;
    isPendingDownload: boolean;
    isPlaying?: boolean;
    isPlayingThisAlbum?: boolean;
    onPause?: () => void;
}

export function AlbumActionBar({
    album,
    source,
    colors,
    onPlayAll,
    onShuffle,
    onDownloadAlbum,
    onAddToPlaylist,
    isPendingDownload,
    isPlaying = false,
    isPlayingThisAlbum = false,
    onPause,
}: AlbumActionBarProps) {
    const [showReleaseModal, setShowReleaseModal] = useState(false);

    const isOwned = album.owned !== undefined ? album.owned : source === "library";
    const showDownload = !isOwned && (album.mbid || album.rgMbid);
    const showPause = isPlaying && isPlayingThisAlbum;

    const handlePlayPauseClick = () => {
        if (showPause && onPause) {
            onPause();
        } else {
            onPlayAll();
        }
    };

    const albumMbid = album.rgMbid || album.mbid || album.id;

    return (
        <>
            <div className="flex items-center gap-4">
                {/* Play Button - only for owned albums */}
                {isOwned && (
                    <>
                        <button
                            onClick={handlePlayPauseClick}
                            className="h-12 w-12 rounded-full flex items-center justify-center shadow-lg transition-all hover:scale-105"
                            style={{ backgroundColor: LIDIFY_YELLOW }}
                        >
                            {showPause ? (
                                <Pause className="w-5 h-5 fill-current text-black" />
                            ) : (
                                <Play className="w-5 h-5 fill-current text-black ml-0.5" />
                            )}
                        </button>

                        {/* Shuffle Button */}
                        <button
                            onClick={onShuffle}
                            className="h-8 w-8 rounded-full hover:bg-white/10 flex items-center justify-center text-white/60 hover:text-white transition-all"
                            title="Shuffle play"
                        >
                            <Shuffle className="w-5 h-5" />
                        </button>

                        {/* Add to Playlist Button */}
                        <button
                            onClick={onAddToPlaylist}
                            className="h-8 w-8 rounded-full hover:bg-white/10 flex items-center justify-center text-white/60 hover:text-white transition-all"
                            title="Add to playlist"
                        >
                            <ListPlus className="w-5 h-5" />
                        </button>
                    </>
                )}

                {/* Download Album Buttons - for unowned albums */}
                {showDownload && (
                    <div className="flex items-center gap-2">
                        {/* Quick Download Button (Auto) */}
                        <button
                            onClick={onDownloadAlbum}
                            disabled={isPendingDownload}
                            className={cn(
                                "flex items-center gap-2 px-5 py-2.5 rounded-full font-medium transition-all",
                                isPendingDownload
                                    ? "bg-white/5 text-white/50 cursor-not-allowed"
                                    : "bg-[#ecb200] hover:bg-[#d4a000] text-black hover:scale-105"
                            )}
                            title="Auto-download best release"
                        >
                            <Download className="w-4 h-4" />
                            <span>
                                {isPendingDownload ? "Downloading..." : "Download"}
                            </span>
                        </button>

                        {/* Interactive Search Button */}
                        <button
                            onClick={() => setShowReleaseModal(true)}
                            disabled={isPendingDownload}
                            className={cn(
                                "flex items-center gap-2 px-4 py-2.5 rounded-full font-medium transition-all",
                                isPendingDownload
                                    ? "bg-white/5 text-white/50 cursor-not-allowed"
                                    : "bg-[#ecb200] hover:bg-[#d4a000] text-black hover:scale-105"
                            )}
                            title="Search and select specific release"
                        >
                            <Search className="w-4 h-4" />
                            <span>Search</span>
                        </button>
                    </div>
                )}
            </div>

            {/* Release Selection Modal */}
            {showDownload && (
                <ReleaseSelectionModal
                    isOpen={showReleaseModal}
                    onClose={() => setShowReleaseModal(false)}
                    albumMbid={albumMbid}
                    artistName={album.artist?.name || "Unknown Artist"}
                    albumTitle={album.title}
                />
            )}
        </>
    );
}
