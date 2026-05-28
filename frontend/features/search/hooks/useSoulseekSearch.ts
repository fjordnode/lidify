import { useState, useEffect, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { refreshLibraryCaches } from "@/lib/library-refresh";
import { toast } from "sonner";
import type { SoulseekResult } from "../types";

interface UseSoulseekSearchProps {
    query: string;
}

interface UseSoulseekSearchReturn {
    soulseekResults: SoulseekResult[];
    isSoulseekSearching: boolean;
    isSoulseekPolling: boolean;
    soulseekEnabled: boolean;
    downloadingFiles: Set<string>;
    handleDownload: (result: SoulseekResult) => Promise<void>;
}

export function useSoulseekSearch({
    query,
}: UseSoulseekSearchProps): UseSoulseekSearchReturn {
    const [soulseekResults, setSoulseekResults] = useState<SoulseekResult[]>(
        []
    );
    const [isSoulseekSearching, setIsSoulseekSearching] = useState(false);
    const [isSoulseekPolling, setIsSoulseekPolling] = useState(false);
    const [soulseekEnabled, setSoulseekEnabled] = useState(false);
    const [downloadingFiles, setDownloadingFiles] = useState<Set<string>>(
        new Set()
    );
    const queryClient = useQueryClient();

    // Check if Soulseek is configured (has credentials)
    useEffect(() => {
        const checkSoulseekStatus = async () => {
            try {
                const settings = await api.getSystemSettings();
                // Soulseek is enabled if both username and password are configured
                setSoulseekEnabled(
                    Boolean(
                        settings.soulseekUsername && settings.soulseekPassword
                    )
                );
            } catch (error) {
                console.error("Failed to check Soulseek status:", error);
                setSoulseekEnabled(false);
            }
        };

        checkSoulseekStatus();
    }, []);

    // Soulseek search with polling
    useEffect(() => {
        if (!query.trim() || !soulseekEnabled) {
            setSoulseekResults([]);
            setIsSoulseekSearching(false);
            setIsSoulseekPolling(false);
            return;
        }

        let cancelled = false;

        const timer = setTimeout(async () => {
            setIsSoulseekSearching(true);
            setIsSoulseekPolling(true);

            try {
                const { results } = await api.searchSoulseek(query);
                if (!cancelled) {
                    setSoulseekResults(results || []);
                }
            } catch (error: unknown) {
                console.error("Soulseek search error:", error);
                const errorMessage = error instanceof Error ? error.message : "";
                if (errorMessage.includes("not enabled")) {
                    setSoulseekEnabled(false);
                }
            } finally {
                if (!cancelled) {
                    setIsSoulseekSearching(false);
                    setIsSoulseekPolling(false);
                }
            }
        }, 800);

        return () => {
            cancelled = true;
            clearTimeout(timer);
            setIsSoulseekPolling(false);
        };
    }, [query, soulseekEnabled]);

    // Handle downloads
    const handleDownload = useCallback(async (result: SoulseekResult) => {
        try {
            setDownloadingFiles((prev) => new Set([...prev, result.filename]));

            const downloadResult = await api.downloadFromSoulseek(
                result.username,
                result.path,
                result.filename,
                result.size,
                result.parsedArtist,
                result.parsedAlbum
            );

            if (downloadResult.scanJobId) {
                const scanJobId = String(downloadResult.scanJobId);
                for (let attempt = 0; attempt < 20; attempt++) {
                    await new Promise((resolve) => setTimeout(resolve, 1500));
                    const status = await api.getScanStatus(scanJobId);
                    if (status.status === "completed" || status.status === "failed") {
                        break;
                    }
                }
            }

            // Use the activity sidebar (Active tab) instead of a toast/modal
            if (typeof window !== "undefined") {
                refreshLibraryCaches(queryClient);
                window.dispatchEvent(
                    new CustomEvent("set-activity-panel-tab", {
                        detail: { tab: "active" },
                    })
                );
                window.dispatchEvent(new CustomEvent("open-activity-panel"));
                window.dispatchEvent(new CustomEvent("notifications-changed"));
            }

            setTimeout(() => {
                setDownloadingFiles((prev) => {
                    const newSet = new Set(prev);
                    newSet.delete(result.filename);
                    return newSet;
                });
            }, 5000);
        } catch (error: unknown) {
            console.error("Download error:", error);
            const message = error instanceof Error ? error.message : "Failed to start download";
            toast.error(message);
            setDownloadingFiles((prev) => {
                const newSet = new Set(prev);
                newSet.delete(result.filename);
                return newSet;
            });
        }
    }, [queryClient]);

    return {
        soulseekResults,
        isSoulseekSearching,
        isSoulseekPolling,
        soulseekEnabled,
        downloadingFiles,
        handleDownload,
    };
}
