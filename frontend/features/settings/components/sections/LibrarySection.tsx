"use client";

import { useState, useEffect, useCallback } from "react";
import { SettingsSection, SettingsRow } from "../ui";
import { api } from "@/lib/api";
import { CheckCircle, Loader2, Music2, AlertCircle } from "lucide-react";

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

export function LibrarySection() {
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
        } catch (err: any) {
            console.error("Failed to start genre tagging:", err);
            setError(err?.message || "Failed to start genre tagging");
        } finally {
            setIsStarting(false);
        }
    };

    const progress = status?.total ? (status.processed / status.total) * 100 : 0;
    const isRunning = status?.running || false;

    return (
        <SettingsSection id="library" title="Library Management">
            {/* Genre Tagging */}
            <div className="p-4 bg-white/5 rounded-lg border border-white/10">
                <div className="flex items-start gap-3 mb-4">
                    <div className="p-2 rounded-lg bg-amber-500/20">
                        <Music2 className="w-5 h-5 text-amber-400" />
                    </div>
                    <div className="flex-1">
                        <h3 className="text-sm font-medium text-white">Genre Tagging</h3>
                        <p className="text-xs text-white/50 mt-1">
                            Fetch genre tags from Last.fm for all albums in your library. 
                            This updates the database only — your music files are not modified.
                        </p>
                    </div>
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
                        className="px-4 py-2 text-sm bg-white text-black font-medium rounded-full
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
