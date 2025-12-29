"use client";

import { useState, useEffect } from "react";
import { SettingsSection, SettingsRow, SettingsInput, SettingsToggle, SettingsSelect } from "../ui";
import { SystemSettings } from "../../types";
import { InlineStatus, StatusType } from "@/components/ui/InlineStatus";

interface QualityProfile {
    id: number;
    name: string;
}

interface LidarrSectionProps {
    settings: SystemSettings;
    onUpdate: (updates: Partial<SystemSettings>) => void;
    onTest: (service: string) => Promise<{ success: boolean; version?: string; error?: string }>;
    isTesting: boolean;
}

export function LidarrSection({ settings, onUpdate, onTest, isTesting }: LidarrSectionProps) {
    const [testStatus, setTestStatus] = useState<StatusType>("idle");
    const [testMessage, setTestMessage] = useState("");
    const [qualityProfiles, setQualityProfiles] = useState<QualityProfile[]>([]);
    const [loadingProfiles, setLoadingProfiles] = useState(false);

    // Function to fetch profiles using current (possibly unsaved) settings
    const fetchProfiles = async (url?: string, apiKey?: string) => {
        const lidarrUrl = url || settings.lidarrUrl;
        const lidarrApiKey = apiKey || settings.lidarrApiKey;

        console.log("[LidarrSection] fetchProfiles called", { lidarrUrl, hasApiKey: !!lidarrApiKey });

        if (!settings.lidarrEnabled || !lidarrUrl || !lidarrApiKey) {
            console.log("[LidarrSection] Missing required settings, skipping fetch");
            setQualityProfiles([]);
            return;
        }

        setLoadingProfiles(true);
        try {
            // Pass current values as query params so we can fetch before saving
            const params = new URLSearchParams({
                url: lidarrUrl,
                apiKey: lidarrApiKey,
            });
            console.log("[LidarrSection] Fetching profiles...");
            const res = await fetch(`/api/system-settings/lidarr-quality-profiles?${params}`, {
                credentials: "include",
            });
            const data = await res.json();
            console.log("[LidarrSection] Response:", data);
            if (data.profiles && data.profiles.length > 0) {
                setQualityProfiles(data.profiles);
                // Auto-select first profile if none selected
                if (!settings.lidarrQualityProfileId) {
                    onUpdate({ lidarrQualityProfileId: data.profiles[0].id });
                }
            } else {
                console.log("[LidarrSection] No profiles in response");
            }
        } catch (err) {
            console.error("[LidarrSection] Failed to fetch quality profiles:", err);
        } finally {
            setLoadingProfiles(false);
        }
    };

    // Fetch quality profiles when settings are loaded/changed
    useEffect(() => {
        if (settings.lidarrEnabled && settings.lidarrUrl && settings.lidarrApiKey) {
            fetchProfiles();
        }
    }, [settings.lidarrEnabled, settings.lidarrUrl, settings.lidarrApiKey]);

    const handleTest = async () => {
        setTestStatus("loading");
        setTestMessage("Testing...");
        const result = await onTest("lidarr");
        if (result.success) {
            setTestStatus("success");
            setTestMessage(result.version ? `v${result.version}` : "Connected");
            // Fetch profiles after successful test - pass values explicitly
            console.log("[LidarrSection] Test succeeded, fetching profiles with:", settings.lidarrUrl);
            fetchProfiles(settings.lidarrUrl, settings.lidarrApiKey);
        } else {
            setTestStatus("error");
            setTestMessage(result.error || "Failed");
        }
    };

    return (
        <SettingsSection 
            id="lidarr" 
            title="Download Services"
            description="Automate music downloads and library management"
        >
            <SettingsRow 
                label="Enable Lidarr"
                description="Connect to Lidarr for music automation"
                htmlFor="lidarr-enabled"
            >
                <SettingsToggle
                    id="lidarr-enabled"
                    checked={settings.lidarrEnabled}
                    onChange={(checked) => onUpdate({ lidarrEnabled: checked })}
                />
            </SettingsRow>

            {settings.lidarrEnabled && (
                <>
                    <SettingsRow label="Lidarr URL">
                        <SettingsInput
                            value={settings.lidarrUrl}
                            onChange={(v) => onUpdate({ lidarrUrl: v })}
                            placeholder="http://localhost:8686"
                            className="w-64"
                        />
                    </SettingsRow>

                    <SettingsRow label="API Key">
                        <SettingsInput
                            type="password"
                            value={settings.lidarrApiKey}
                            onChange={(v) => onUpdate({ lidarrApiKey: v })}
                            placeholder="Enter API key"
                            className="w-64"
                        />
                    </SettingsRow>

                    <SettingsRow
                        label="Quality Profile"
                        description="Quality profile for new downloads"
                    >
                        {loadingProfiles ? (
                            <span className="text-sm text-gray-500">Loading profiles...</span>
                        ) : qualityProfiles.length > 0 ? (
                            <SettingsSelect
                                value={String(settings.lidarrQualityProfileId || qualityProfiles[0]?.id || "")}
                                onChange={(v) => onUpdate({ lidarrQualityProfileId: parseInt(v, 10) })}
                                options={qualityProfiles.map((p) => ({
                                    value: String(p.id),
                                    label: p.name,
                                }))}
                            />
                        ) : (
                            <span className="text-sm text-gray-500">
                                {settings.lidarrUrl && settings.lidarrApiKey
                                    ? "No profiles found - test connection first"
                                    : "Configure Lidarr to see profiles"}
                            </span>
                        )}
                    </SettingsRow>

                    <div className="pt-2">
                        <div className="inline-flex items-center gap-3">
                            <button
                                onClick={handleTest}
                                disabled={isTesting || !settings.lidarrUrl || !settings.lidarrApiKey}
                                className="px-4 py-1.5 text-sm bg-[#333] text-white rounded-full
                                    hover:bg-[#404040] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                            >
                                {testStatus === "loading" ? "Testing..." : "Test Connection"}
                            </button>
                            <InlineStatus 
                                status={testStatus} 
                                message={testMessage}
                                onClear={() => setTestStatus("idle")}
                            />
                        </div>
                    </div>
                </>
            )}
        </SettingsSection>
    );
}
