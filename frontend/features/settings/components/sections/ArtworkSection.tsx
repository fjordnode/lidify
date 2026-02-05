"use client";

import { useState } from "react";
import { SettingsSection, SettingsRow, SettingsInput, SettingsToggle } from "../ui";
import { SystemSettings } from "../../types";
import { InlineStatus, StatusType } from "@/components/ui/InlineStatus";

interface ArtworkSectionProps {
    settings: SystemSettings;
    onUpdate: (updates: Partial<SystemSettings>) => void;
    onTest: (service: string) => Promise<{ success: boolean; version?: string; error?: string }>;
    isTesting: boolean;
}

export function ArtworkSection({ settings, onUpdate, onTest, isTesting }: ArtworkSectionProps) {
    const [fanartTestStatus, setFanartTestStatus] = useState<StatusType>("idle");
    const [fanartTestMessage, setFanartTestMessage] = useState("");

    const handleFanartTest = async () => {
        setFanartTestStatus("loading");
        setFanartTestMessage("Testing...");
        const result = await onTest("fanart");
        if (result.success) {
            setFanartTestStatus("success");
            setFanartTestMessage("Connected");
        } else {
            setFanartTestStatus("error");
            setFanartTestMessage(result.error || "Failed");
        }
    };

    return (
        <SettingsSection
            id="artwork"
            title="Artwork Sources"
            description="Additional sources for high-quality artist and album images during enrichment"
        >
            {/* Fanart.tv */}
            <SettingsRow
                label="Enable Fanart.tv"
                description="High-quality artist backgrounds, logos, and album art"
                htmlFor="fanart-enabled"
            >
                <SettingsToggle
                    id="fanart-enabled"
                    checked={settings.fanartEnabled}
                    onChange={(checked) => onUpdate({ fanartEnabled: checked })}
                />
            </SettingsRow>

            {settings.fanartEnabled && (
                <>
                    <SettingsRow label="API Key">
                        <SettingsInput
                            type="password"
                            value={settings.fanartApiKey}
                            onChange={(v) => onUpdate({ fanartApiKey: v })}
                            placeholder="Enter Fanart.tv API key"
                            className="w-64"
                        />
                    </SettingsRow>

                    <div className="pt-2">
                        <div className="inline-flex items-center gap-3">
                            <button
                                onClick={handleFanartTest}
                                disabled={isTesting || !settings.fanartApiKey}
                                className="px-4 py-1.5 text-sm bg-[#333] text-white rounded-full
                                    hover:bg-[#404040] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                            >
                                {fanartTestStatus === "loading" ? "Testing..." : "Test Connection"}
                            </button>
                            <InlineStatus
                                status={fanartTestStatus}
                                message={fanartTestMessage}
                                onClear={() => setFanartTestStatus("idle")}
                            />
                        </div>
                    </div>
                </>
            )}
        </SettingsSection>
    );
}
