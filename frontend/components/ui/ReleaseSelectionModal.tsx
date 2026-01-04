"use client";

import { useState, useEffect } from "react";
import { Modal } from "./Modal";
import { Button } from "./Button";
import { api, AlbumRelease } from "@/lib/api";
import { useDownloadContext } from "@/lib/download-context";
import { cn } from "@/utils/cn";
import {
    Download,
    Loader2,
    AlertCircle,
    CheckCircle2,
    XCircle,
    HardDrive,
    Users,
    FileAudio,
    ExternalLink,
} from "lucide-react";
import { toast } from "sonner";

interface ReleaseSelectionModalProps {
    isOpen: boolean;
    onClose: () => void;
    albumMbid: string;
    artistName: string;
    albumTitle: string;
}

export function ReleaseSelectionModal({
    isOpen,
    onClose,
    albumMbid,
    artistName,
    albumTitle,
}: ReleaseSelectionModalProps) {
    const { addPendingDownload } = useDownloadContext();
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [releases, setReleases] = useState<AlbumRelease[]>([]);
    const [lidarrAlbumId, setLidarrAlbumId] = useState<number | null>(null);
    const [grabbing, setGrabbing] = useState<string | null>(null);

    useEffect(() => {
        if (isOpen && albumMbid) {
            fetchReleases();
        }
    }, [isOpen, albumMbid]);

    const fetchReleases = async () => {
        setLoading(true);
        setError(null);

        try {
            const result = await api.getAlbumReleases(
                albumMbid,
                artistName,
                albumTitle
            );
            setReleases(result.releases);
            setLidarrAlbumId(result.lidarrAlbumId);
        } catch (err: any) {
            console.error("Failed to fetch releases:", err);
            setError(err.message || "Failed to search for releases");
        } finally {
            setLoading(false);
        }
    };

    const handleGrabRelease = async (release: AlbumRelease) => {
        if (!lidarrAlbumId) {
            toast.error("Album not ready in Lidarr");
            return;
        }

        setGrabbing(release.guid);

        try {
            // Add to pending downloads for UI feedback
            addPendingDownload("album", `${artistName} - ${albumTitle}`, albumMbid);

            await api.grabRelease({
                guid: release.guid,
                indexerId: release.indexerId,
                albumMbid,
                lidarrAlbumId,
                artistName,
                albumTitle,
                title: release.title,
            });

            toast.success(`Downloading "${albumTitle}"`, {
                description: `Selected: ${release.title}`,
            });

            onClose();
        } catch (err: any) {
            console.error("Failed to grab release:", err);
            toast.error("Failed to start download", {
                description: err.message,
            });
        } finally {
            setGrabbing(null);
        }
    };

    const approvedReleases = releases.filter((r) => r.approved);
    const rejectedReleases = releases.filter((r) => r.rejected);

    return (
        <Modal
            isOpen={isOpen}
            onClose={onClose}
            title={`Select Release: ${albumTitle}`}
            className="max-w-4xl max-h-[80vh] overflow-hidden flex flex-col"
        >
            <div className="text-sm text-white/50 mb-4">
                {artistName}
            </div>

            {loading ? (
                <div className="flex flex-col items-center justify-center py-12 gap-4">
                    <Loader2 className="w-8 h-8 animate-spin text-[#ecb200]" />
                    <p className="text-white/60 text-sm">
                        Searching indexers for releases...
                    </p>
                    <p className="text-white/40 text-xs">
                        This may take up to 60 seconds
                    </p>
                </div>
            ) : error ? (
                <div className="flex flex-col items-center justify-center py-12 gap-4">
                    <AlertCircle className="w-8 h-8 text-red-400" />
                    <p className="text-white/60 text-sm">{error}</p>
                    <Button variant="secondary" onClick={fetchReleases}>
                        Retry
                    </Button>
                </div>
            ) : releases.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 gap-4">
                    <FileAudio className="w-8 h-8 text-white/40" />
                    <p className="text-white/60 text-sm">
                        No releases found from indexers
                    </p>
                    <p className="text-white/40 text-xs">
                        The album may not be available on your configured indexers
                    </p>
                </div>
            ) : (
                <div className="flex-1 overflow-y-auto -mx-6 px-6">
                    {/* Approved Releases */}
                    {approvedReleases.length > 0 && (
                        <div className="mb-6">
                            <div className="flex items-center gap-2 mb-3">
                                <CheckCircle2 className="w-4 h-4 text-green-400" />
                                <h3 className="text-sm font-medium text-white/80">
                                    Available Releases ({approvedReleases.length})
                                </h3>
                            </div>
                            <div className="space-y-2">
                                {approvedReleases.map((release) => (
                                    <ReleaseRow
                                        key={release.guid}
                                        release={release}
                                        onGrab={handleGrabRelease}
                                        grabbing={grabbing === release.guid}
                                        disabled={!!grabbing}
                                    />
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Rejected Releases */}
                    {rejectedReleases.length > 0 && (
                        <div>
                            <div className="flex items-center gap-2 mb-3">
                                <XCircle className="w-4 h-4 text-red-400/60" />
                                <h3 className="text-sm font-medium text-white/50">
                                    Rejected ({rejectedReleases.length})
                                </h3>
                            </div>
                            <div className="space-y-2 opacity-60">
                                {rejectedReleases.map((release) => (
                                    <ReleaseRow
                                        key={release.guid}
                                        release={release}
                                        onGrab={handleGrabRelease}
                                        grabbing={grabbing === release.guid}
                                        disabled={true}
                                        showRejections
                                    />
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            )}
        </Modal>
    );
}

interface ReleaseRowProps {
    release: AlbumRelease;
    onGrab: (release: AlbumRelease) => void;
    grabbing: boolean;
    disabled: boolean;
    showRejections?: boolean;
}

function ReleaseRow({
    release,
    onGrab,
    grabbing,
    disabled,
    showRejections,
}: ReleaseRowProps) {
    return (
        <div
            className={cn(
                "flex flex-col gap-2 p-3 rounded-lg bg-white/5 border border-white/10",
                "hover:bg-white/10 transition-colors",
                disabled && !grabbing && "opacity-50 cursor-not-allowed"
            )}
        >
            {/* Top row: Title + Download Button */}
            <div className="flex items-start gap-3">
                <div className="flex-1 min-w-0">
                    {release.infoUrl ? (
                        <a
                            href={release.infoUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-sm text-white hover:text-[#ecb200] flex items-start gap-1.5 group"
                            title={`Open on ${release.indexer}`}
                            onClick={(e) => e.stopPropagation()}
                        >
                            <span className="break-words line-clamp-2">{release.title}</span>
                            <ExternalLink className="w-3 h-3 opacity-0 group-hover:opacity-100 transition-opacity shrink-0 mt-0.5" />
                        </a>
                    ) : (
                        <p className="text-sm text-white break-words line-clamp-2" title={release.title}>
                            {release.title}
                        </p>
                    )}
                </div>

                {/* Download Button */}
                <button
                    onClick={() => onGrab(release)}
                    disabled={disabled}
                    className={cn(
                        "shrink-0 p-2 rounded-full transition-all",
                        disabled
                            ? "text-white/30 cursor-not-allowed"
                            : "text-[#ecb200] hover:text-[#d4a000] hover:bg-white/10 hover:scale-105"
                    )}
                >
                    {grabbing ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                        <Download className="w-4 h-4" />
                    )}
                </button>
            </div>

            {/* Bottom row: Tags + Stats */}
            <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="flex items-center gap-2 text-xs flex-wrap">
                    <span className="px-1.5 py-0.5 bg-white/10 rounded text-white/70">
                        {release.indexer}
                    </span>
                    <span className="px-1.5 py-0.5 bg-white/10 rounded text-white/70">
                        {release.quality}
                    </span>
                    <span className="px-1.5 py-0.5 bg-white/10 rounded text-white/70 uppercase">
                        {release.protocol}
                    </span>
                </div>

                <div className="flex items-center gap-3 text-xs text-white/50">
                    <div className="flex items-center gap-1" title="Size">
                        <HardDrive className="w-3.5 h-3.5" />
                        <span>{release.sizeFormatted}</span>
                    </div>
                    {release.seeders !== undefined && (
                        <div
                            className={cn(
                                "flex items-center gap-1",
                                release.seeders > 10
                                    ? "text-green-400"
                                    : release.seeders > 0
                                    ? "text-yellow-400"
                                    : "text-red-400"
                            )}
                            title="Seeders"
                        >
                            <Users className="w-3.5 h-3.5" />
                            <span>{release.seeders}</span>
                        </div>
                    )}
                </div>
            </div>

            {showRejections && release.rejections.length > 0 && (
                <p className="text-xs text-red-400/80 truncate">
                    {release.rejections.join(", ")}
                </p>
            )}
        </div>
    );
}
