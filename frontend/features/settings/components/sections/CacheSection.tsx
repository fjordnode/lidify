"use client";

import { useState } from "react";
import { SettingsSection, SettingsRow, SettingsToggle } from "../ui";
import { SystemSettings } from "../../types";
import { api } from "@/lib/api";
import { useQueryClient, useQuery } from "@tanstack/react-query";
import { CheckCircle, Loader2, User, Heart, Activity } from "lucide-react";

interface CacheSectionProps {
    settings: SystemSettings;
    onUpdate: (updates: Partial<SystemSettings>) => void;
}

// Progress bar component
function ProgressBar({ 
    progress, 
    color = "bg-[#ecb200]",
    showPercentage = true 
}: { 
    progress: number; 
    color?: string;
    showPercentage?: boolean;
}) {
    return (
        <div className="flex items-center gap-2 flex-1">
            <div className="flex-1 h-1.5 bg-white/10 rounded-full overflow-hidden">
                <div 
                    className={`h-full ${color} transition-all duration-500 ease-out`}
                    style={{ width: `${Math.min(100, progress)}%` }}
                />
            </div>
            {showPercentage && (
                <span className="text-xs text-white/50 w-10 text-right">{progress}%</span>
            )}
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
            <div className={`mt-0.5 p-1.5 rounded-lg ${isComplete ? 'bg-green-500/20' : 'bg-white/5'}`}>
                {isComplete ? (
                    <CheckCircle className="w-4 h-4 text-green-400" />
                ) : hasActivity ? (
                    <Loader2 className="w-4 h-4 text-[#ecb200] animate-spin" />
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
                        color={isComplete ? "bg-green-500" : isBackground ? "bg-purple-500" : "bg-[#ecb200]"}
                    />
                </div>
                <div className="flex items-center gap-3 mt-1 text-[10px] text-white/30">
                    <span>{completed} / {total}</span>
                    {processing > 0 && <span className="text-[#ecb200]">{processing} processing</span>}
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

export function CacheSection({ settings, onUpdate }: CacheSectionProps) {
    const [syncing, setSyncing] = useState(false);
    const [clearingCaches, setClearingCaches] = useState(false);
    const [reEnriching, setReEnriching] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const queryClient = useQueryClient();

    // Fetch enrichment progress
    const { data: enrichmentProgress, refetch: refetchProgress } = useQuery({
        queryKey: ["enrichment-progress"],
        queryFn: () => api.getEnrichmentProgress(),
        refetchInterval: 5000, // Refresh every 5 seconds
        staleTime: 2000,
    });

    const refreshNotifications = () => {
        queryClient.invalidateQueries({ queryKey: ["notifications"] });
        queryClient.invalidateQueries({ queryKey: ["unread-notification-count"] });
        window.dispatchEvent(new CustomEvent("notifications-changed"));
    };

    const handleSyncAndEnrich = async () => {
        setSyncing(true);
        setError(null);
        try {
            if (settings.autoEnrichMetadata) {
                await api.post("/audiobooks/sync", {});
            }
            await api.post("/podcasts/sync-covers", {});
            await api.startLibraryEnrichment();
            refreshNotifications();
            refetchProgress();
        } catch (err) {
            console.error("Sync error:", err);
            setError("Failed to sync");
        } finally {
            setSyncing(false);
        }
    };

    const handleFullEnrichment = async () => {
        setReEnriching(true);
        setError(null);
        try {
            await api.triggerFullEnrichment();
            refreshNotifications();
            refetchProgress();
        } catch (err) {
            console.error("Full enrichment error:", err);
            setError("Failed to start full enrichment");
        } finally {
            setReEnriching(false);
        }
    };

    const handleClearCaches = async () => {
        setClearingCaches(true);
        setError(null);
        try {
            await api.clearAllCaches();
            refreshNotifications();
        } catch (err) {
            setError("Failed to clear caches");
        } finally {
            setClearingCaches(false);
        }
    };

    return (
        <SettingsSection id="cache" title="Cache & Automation">
            {/* Enrichment Progress */}
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
                            icon={Heart}
                            label="Mood Tags"
                            description="Vibes and mood data from Last.fm"
                            completed={enrichmentProgress.trackTags.enriched}
                            total={enrichmentProgress.trackTags.total}
                            progress={enrichmentProgress.trackTags.progress}
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
                    </div>
                </div>
            )}

            {/* Cache Sizes */}
            <SettingsRow 
                label="User cache size"
                description="Maximum storage for offline content"
            >
                <div className="flex items-center gap-3">
                    <input
                        type="range"
                        min={512}
                        max={20480}
                        step={512}
                        value={settings.maxCacheSizeMb}
                        onChange={(e) => onUpdate({ maxCacheSizeMb: parseInt(e.target.value) })}
                        className="w-32 h-1 bg-[#404040] rounded-lg appearance-none cursor-pointer
                            [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3
                            [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white"
                    />
                    <span className="text-sm text-white w-16 text-right">
                        {(settings.maxCacheSizeMb / 1024).toFixed(1)} GB
                    </span>
                </div>
            </SettingsRow>

            <SettingsRow 
                label="Transcode cache size"
                description="Server restart required for changes"
            >
                <div className="flex items-center gap-3">
                    <input
                        type="range"
                        min={1}
                        max={50}
                        value={settings.transcodeCacheMaxGb}
                        onChange={(e) => onUpdate({ transcodeCacheMaxGb: parseInt(e.target.value) })}
                        className="w-32 h-1 bg-[#404040] rounded-lg appearance-none cursor-pointer
                            [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3
                            [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white"
                    />
                    <span className="text-sm text-white w-16 text-right">
                        {settings.transcodeCacheMaxGb} GB
                    </span>
                </div>
            </SettingsRow>

            {/* Automation */}
            <SettingsRow 
                label="Auto sync library"
                description="Automatically sync library changes"
                htmlFor="auto-sync"
            >
                <SettingsToggle
                    id="auto-sync"
                    checked={settings.autoSync}
                    onChange={(checked) => onUpdate({ autoSync: checked })}
                />
            </SettingsRow>

            <SettingsRow 
                label="Auto enrich metadata"
                description="Automatically enrich metadata for new content"
                htmlFor="auto-enrich"
            >
                <SettingsToggle
                    id="auto-enrich"
                    checked={settings.autoEnrichMetadata}
                    onChange={(checked) => onUpdate({ autoEnrichMetadata: checked })}
                />
            </SettingsRow>

            {/* Cache Actions */}
            <div className="flex flex-col gap-3 pt-4">
                <button
                    onClick={handleClearCaches}
                    disabled={clearingCaches}
                    className="px-4 py-1.5 text-sm bg-[#333] text-white rounded-full w-fit
                        hover:bg-[#404040] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                    {clearingCaches ? "Clearing..." : "Clear All Caches"}
                </button>
                {error && (
                    <p className="text-sm text-red-400">{error}</p>
                )}
            </div>
        </SettingsSection>
    );
}

