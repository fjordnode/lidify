"use client";

import { useState, useEffect, useCallback } from "react";
import { SettingsSection } from "../ui";
import { api } from "@/lib/api";
import { useQueryClient, useQuery } from "@tanstack/react-query";
import { CheckCircle, Loader2, AlertCircle, User, Activity, Tag } from "lucide-react";
import { toast } from "sonner";

interface GenreTaggingStatus {
    running: boolean;
    total: number;
    processed: number;
    success: number;
    failed: number;
    skipped: number;
    startedAt: string | null;
    finishedAt: string | null;
    currentAlbum: string | null;
    lastError: string | null;
}

// Progress bar component
function ProgressBar({ 
    progress, 
    color = "bg-brand",
}: { 
    progress: number; 
    color?: string;
}) {
    return (
        <div className="flex items-center gap-2 flex-1">
            <div className="flex-1 h-1.5 bg-white/10 rounded-full overflow-hidden">
                <div 
                    className={`h-full ${color} transition-all duration-500 ease-out`}
                    style={{ width: `${Math.min(100, progress)}%` }}
                />
            </div>
            <span className="text-xs text-white/50 w-10 text-right">{Math.round(progress)}%</span>
        </div>
    );
}

// Enrichment stage component
function EnrichmentStage({
    icon: Icon,
    label,
    description,
    completed,
    total,
    progress,
    isBackground = false,
    failed = 0,
    skipped = 0,
    processing = 0,
    showAllStats = false,
}: {
    icon: React.ElementType;
    label: string;
    description: string;
    completed: number;
    total: number;
    progress: number;
    isBackground?: boolean;
    failed?: number;
    skipped?: number;
    processing?: number;
    showAllStats?: boolean;
}) {
    // Complete when: 100% OR (no processing AND all tracks accounted for by completed+skipped+failed)
    const allAccountedFor = (completed + skipped + failed) >= total && total > 0;
    const isComplete = progress === 100 || (processing === 0 && allAccountedFor);
    const hasActivity = processing > 0;
    
    return (
        <div className="flex items-start gap-3 py-2">
            <div className={`mt-0.5 p-1.5 rounded-lg ${isComplete ? "bg-green-500/20" : "bg-white/5"}`}>
                {isComplete ? (
                    <CheckCircle className="w-4 h-4 text-green-400" />
                ) : hasActivity ? (
                    <Loader2 className="w-4 h-4 text-brand animate-spin" />
                ) : (
                    <Icon className="w-4 h-4 text-white/40" />
                )}
            </div>
            <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-white">{label}</span>
                    {isBackground && !isComplete && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/10 text-white/50">
                            background
                        </span>
                    )}
                </div>
                <p className="text-xs text-white/40 mt-0.5">{description}</p>
                <div className="flex items-center gap-2 mt-2">
                    <ProgressBar 
                        progress={progress} 
                        color={isComplete ? "bg-green-500" : isBackground ? "bg-purple-500" : "bg-brand"}
                    />
                </div>
                <div className="flex items-center gap-3 mt-1 text-[10px] text-white/30">
                    <span>{completed} / {total}</span>
                    {processing > 0 && <span className="text-brand">{processing} processing</span>}
                    {(showAllStats || skipped > 0) && (
                        <span className="text-orange-400">{skipped} skipped</span>
                    )}
                    {(showAllStats || failed > 0) && (
                        <span className={failed > 0 ? "text-red-400" : "text-white/30"}>{failed} errors</span>
                    )}
                </div>
            </div>
        </div>
    );
}

export function LibrarySection() {
    const [syncing, setSyncing] = useState(false);
    const [reEnriching, setReEnriching] = useState(false);
    const [cleaningOrphans, setCleaningOrphans] = useState(false);
    const [enrichmentError, setEnrichmentError] = useState<string | null>(null);
    const [cleanOrphansError, setCleanOrphansError] = useState<string | null>(null);
    const [cleanOrphansResult, setCleanOrphansResult] = useState<string | null>(null);
    const [status, setStatus] = useState<GenreTaggingStatus | null>(null);
    const [isStarting, setIsStarting] = useState(false);
    const [forceRetag, setForceRetag] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [lastResult, setLastResult] = useState<{
        success: number;
        failed: number;
        skipped: number;
        duration: string;
    } | null>(null);
    const queryClient = useQueryClient();

    // Fetch enrichment progress
    const { data: enrichmentProgress, refetch: refetchProgress } = useQuery({
        queryKey: ["enrichment-progress"],
        queryFn: () => api.getEnrichmentProgress(),
        refetchInterval: 5000,
        staleTime: 2000,
    });

    const refreshNotifications = () => {
        queryClient.invalidateQueries({ queryKey: ["notifications"] });
        queryClient.invalidateQueries({ queryKey: ["unread-notification-count"] });
        window.dispatchEvent(new CustomEvent("notifications-changed"));
    };

    const handleSyncAndEnrich = async () => {
        setSyncing(true);
        setEnrichmentError(null);
        try {
            // 1. Scan for new files
            const scanResult = await api.scanLibrary();

            // 2. Poll scan status until complete
            let scanDone = false;
            let added = 0;
            let updated = 0;
            while (!scanDone) {
                await new Promise((r) => setTimeout(r, 1500));
                try {
                    const status = await api.getScanStatus(scanResult.jobId);
                    if (status.status === "completed") {
                        scanDone = true;
                        added = status.result?.tracksAdded ?? 0;
                        updated = status.result?.tracksUpdated ?? 0;
                    } else if (status.status === "failed") {
                        scanDone = true;
                    }
                } catch {
                    scanDone = true;
                }
            }

            // 3. Kick off background tasks (covers + enrichment)
            api.post("/podcasts/sync-covers", {}).catch(() => {});
            await api.startLibraryEnrichment();

            // 4. Show appropriate feedback based on scan results
            if (added > 0) {
                toast.success(`Found ${added} new track${added !== 1 ? "s" : ""}`, {
                    description: updated > 0
                        ? `${updated} existing track${updated !== 1 ? "s" : ""} also updated`
                        : "Enrichment running in background",
                });
            } else if (updated > 0) {
                toast.info(`Updated ${updated} track${updated !== 1 ? "s" : ""}`, {
                    description: "Metadata changes detected",
                });
            } else {
                toast.info("Library is up to date");
            }

            refreshNotifications();
            refetchProgress();
        } catch (err) {
            console.error("Sync error:", err);
            setEnrichmentError("Failed to sync");
        } finally {
            setSyncing(false);
        }
    };

    const handleFullEnrichment = async () => {
        setReEnriching(true);
        setEnrichmentError(null);
        try {
            await api.triggerFullEnrichment();
            refreshNotifications();
            refetchProgress();
        } catch (err) {
            console.error("Full enrichment error:", err);
            setEnrichmentError("Failed to start full enrichment");
        } finally {
            setReEnriching(false);
        }
    };

    const handleCleanOrphans = async () => {
        setCleaningOrphans(true);
        setCleanOrphansError(null);
        setCleanOrphansResult(null);
        try {
            const result = await api.cleanOrphanedTracks();
            setCleanOrphansResult(
                `Removed ${result.deleted} orphaned tracks (checked ${result.checked}).`
            );
        } catch (err) {
            console.error("Clean orphans error:", err);
            setCleanOrphansError("Failed to clean orphaned tracks");
        } finally {
            setCleaningOrphans(false);
        }
    };

    // Poll for status while running
    const fetchStatus = useCallback(async () => {
        try {
            const response = await api.get<GenreTaggingStatus>("/admin/tag-genres/status");
            setStatus(response);
            
            // If just finished, save the result
            if (!response.running && response.finishedAt && response.total > 0) {
                const startTime = response.startedAt ? new Date(response.startedAt).getTime() : 0;
                const endTime = new Date(response.finishedAt).getTime();
                const durationMs = endTime - startTime;
                const minutes = Math.floor(durationMs / 60000);
                const seconds = Math.floor((durationMs % 60000) / 1000);
                
                setLastResult({
                    success: response.success,
                    failed: response.failed,
                    skipped: response.skipped,
                    duration: minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`,
                });
            }
            
            return response.running;
        } catch (err) {
            console.error("Failed to fetch genre tagging status:", err);
            return false;
        }
    }, []);

    // Initial fetch and polling
    useEffect(() => {
        fetchStatus();
    }, [fetchStatus]);

    useEffect(() => {
        if (!status?.running) return;
        
        const interval = setInterval(async () => {
            const stillRunning = await fetchStatus();
            if (!stillRunning) {
                clearInterval(interval);
            }
        }, 2000);
        
        return () => clearInterval(interval);
    }, [status?.running, fetchStatus]);

    const handleStartTagging = async () => {
        setIsStarting(true);
        setError(null);
        setLastResult(null);
        
        try {
            await api.post("/admin/tag-genres", { force: forceRetag });
            // Start polling
            await fetchStatus();
        } catch (err: unknown) {
            console.error("Failed to start genre tagging:", err);
            setError(err instanceof Error ? err.message : "Failed to start genre tagging");
        } finally {
            setIsStarting(false);
        }
    };

    const progress = status?.total ? (status.processed / status.total) * 100 : 0;
    const isRunning = status?.running || false;

    return (
        <SettingsSection id="library" title="Library Management">
            {/* Library Enrichment */}
            {enrichmentProgress && (
                <div className="mb-6 p-4 bg-white/5 rounded-lg border border-white/10">
                    <div className="flex items-center justify-between mb-4">
                        <h3 className="text-sm font-medium text-white">Library Enrichment</h3>
                        {enrichmentProgress.coreComplete && !enrichmentProgress.isFullyComplete && (
                            <span className="text-xs text-purple-400 flex items-center gap-1">
                                <Loader2 className="w-3 h-3 animate-spin" />
                                Audio analysis running
                            </span>
                        )}
                        {enrichmentProgress.isFullyComplete && (
                            <span className="text-xs text-green-400 flex items-center gap-1">
                                <CheckCircle className="w-3 h-3" />
                                Complete
                            </span>
                        )}
                    </div>
                    
                    <div className="space-y-1">
                        <EnrichmentStage
                            icon={User}
                            label="Artist Metadata"
                            description="Bios, images, and similar artists from Last.fm"
                            completed={enrichmentProgress.artists.completed}
                            total={enrichmentProgress.artists.total}
                            progress={enrichmentProgress.artists.progress}
                            failed={enrichmentProgress.artists.failed}
                        />
                        
                        <EnrichmentStage
                            icon={Activity}
                            label="Audio Analysis"
                            description="BPM, key, energy, and danceability from audio files"
                            completed={enrichmentProgress.audioAnalysis.completed}
                            total={enrichmentProgress.audioAnalysis.total}
                            progress={enrichmentProgress.audioAnalysis.progress}
                            processing={enrichmentProgress.audioAnalysis.processing}
                            failed={enrichmentProgress.audioAnalysis.failed}
                            skipped={enrichmentProgress.audioAnalysis.skipped}
                            isBackground={true}
                            showAllStats={true}
                        />

                        <EnrichmentStage
                            icon={Tag}
                            label="Genre Tags"
                            description="Album genres from Last.fm"
                            completed={enrichmentProgress.genreTags.completed}
                            total={enrichmentProgress.genreTags.total}
                            progress={enrichmentProgress.genreTags.progress}
                        />
                    </div>
                    
                    <div className="flex gap-2 mt-4 pt-3 border-t border-white/10">
                        <button
                            onClick={handleSyncAndEnrich}
                            disabled={syncing || reEnriching}
                            className="px-3 py-1.5 text-xs bg-white text-black font-medium rounded-full
                                hover:scale-105 disabled:opacity-50 disabled:cursor-not-allowed transition-transform"
                        >
                            {syncing ? "Syncing..." : "Sync New"}
                        </button>
                        <button
                            onClick={handleFullEnrichment}
                            disabled={syncing || reEnriching}
                            className="px-3 py-1.5 text-xs bg-[#333] text-white rounded-full
                                hover:bg-[#404040] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                        >
                            {reEnriching ? "Starting..." : "Re-enrich All"}
                        </button>
                        <button
                            onClick={handleCleanOrphans}
                            disabled={syncing || reEnriching || cleaningOrphans}
                            className="px-3 py-1.5 text-xs bg-[#333] text-white rounded-full
                                hover:bg-[#404040] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                        >
                            {cleaningOrphans ? "Cleaning..." : "Clean Orphans"}
                        </button>
                    </div>
                    {enrichmentError && (
                        <p className="mt-3 text-sm text-red-400">{enrichmentError}</p>
                    )}
                    {cleanOrphansError && (
                        <p className="mt-3 text-sm text-red-400">{cleanOrphansError}</p>
                    )}
                    {cleanOrphansResult && (
                        <p className="mt-3 text-sm text-green-400">{cleanOrphansResult}</p>
                    )}
                </div>
            )}
            {/* Genre Tagging */}
            <div className="p-4 bg-white/5 rounded-lg border border-white/10">
                <div className="mb-4">
                    <h3 className="text-sm font-medium text-white">Genre Tagging</h3>
                    <p className="text-xs text-white/50 mt-1">
                        Fetch genre tags from Last.fm for all albums in your library. 
                        This updates the database only — your music files are not modified.
                    </p>
                </div>

                {/* Progress display when running */}
                {isRunning && status && (
                    <div className="mb-4 p-3 bg-black/20 rounded-lg">
                        <div className="flex items-center gap-2 mb-2">
                            <Loader2 className="w-4 h-4 text-brand animate-spin" />
                            <span className="text-sm text-white">Tagging in progress...</span>
                        </div>
                        <ProgressBar progress={progress} />
                        <div className="flex items-center gap-4 mt-2 text-[11px] text-white/40">
                            <span>{status.processed} / {status.total} albums</span>
                            <span className="text-green-400">{status.success} tagged</span>
                            {status.failed > 0 && (
                                <span className="text-red-400">{status.failed} failed</span>
                            )}
                            {status.skipped > 0 && (
                                <span className="text-orange-400">{status.skipped} skipped</span>
                            )}
                        </div>
                        {status.currentAlbum && (
                            <p className="text-[10px] text-white/30 mt-2 truncate">
                                Current: {status.currentAlbum}
                            </p>
                        )}
                    </div>
                )}

                {/* Last result display */}
                {!isRunning && lastResult && (
                    <div className="mb-4 p-3 bg-green-500/10 border border-green-500/20 rounded-lg">
                        <div className="flex items-center gap-2 mb-1">
                            <CheckCircle className="w-4 h-4 text-green-400" />
                            <span className="text-sm text-green-400">Tagging complete</span>
                        </div>
                        <div className="flex items-center gap-4 text-[11px] text-white/50">
                            <span>{lastResult.success} albums tagged</span>
                            {lastResult.failed > 0 && (
                                <span className="text-red-400">{lastResult.failed} failed</span>
                            )}
                            {lastResult.skipped > 0 && (
                                <span className="text-orange-400">{lastResult.skipped} skipped</span>
                            )}
                            <span>in {lastResult.duration}</span>
                        </div>
                    </div>
                )}

                {/* Error display */}
                {error && (
                    <div className="mb-4 p-3 bg-red-500/10 border border-red-500/20 rounded-lg">
                        <div className="flex items-center gap-2">
                            <AlertCircle className="w-4 h-4 text-red-400" />
                            <span className="text-sm text-red-400">{error}</span>
                        </div>
                    </div>
                )}

                {/* Controls */}
                <div className="flex items-center gap-4">
                    <button
                        onClick={handleStartTagging}
                        disabled={isRunning || isStarting}
                        className="px-3 py-1.5 text-xs bg-white text-black font-medium rounded-full
                            hover:scale-105 disabled:opacity-50 disabled:cursor-not-allowed 
                            disabled:hover:scale-100 transition-transform"
                    >
                        {isStarting ? "Starting..." : isRunning ? "Running..." : "Tag Genres"}
                    </button>
                    
                    <label className="flex items-center gap-2 cursor-pointer">
                        <input
                            type="checkbox"
                            checked={forceRetag}
                            onChange={(e) => setForceRetag(e.target.checked)}
                            disabled={isRunning}
                            className="w-4 h-4 rounded border-white/20 bg-white/5 
                                checked:bg-brand checked:border-brand
                                focus:ring-brand focus:ring-offset-0
                                disabled:opacity-50"
                        />
                        <span className="text-xs text-white/60">
                            Re-tag albums that already have genres
                        </span>
                    </label>
                </div>
            </div>
        </SettingsSection>
    );
}
