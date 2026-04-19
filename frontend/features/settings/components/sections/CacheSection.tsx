"use client";

import { useState } from "react";
import { SettingsSection, SettingsRow, SettingsToggle } from "../ui";
import { SystemSettings } from "../../types";
import { api } from "@/lib/api";
import { useQueryClient } from "@tanstack/react-query";

interface CacheSectionProps {
    settings: SystemSettings;
    onUpdate: (updates: Partial<SystemSettings>) => void;
}

export function CacheSection({ settings, onUpdate }: CacheSectionProps) {
    const [clearingCaches, setClearingCaches] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const queryClient = useQueryClient();

    const refreshNotifications = () => {
        queryClient.invalidateQueries({ queryKey: ["notifications"] });
        queryClient.invalidateQueries({ queryKey: ["unread-notification-count"] });
        window.dispatchEvent(new CustomEvent("notifications-changed"));
    };

    const handleClearCaches = async () => {
        setClearingCaches(true);
        setError(null);
        try {
            await api.clearAllCaches();
            refreshNotifications();
        } catch (_err) {
            setError("Failed to clear caches");
        } finally {
            setClearingCaches(false);
        }
    };

    return (
        <SettingsSection id="cache" title="Cache & Automation">
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
