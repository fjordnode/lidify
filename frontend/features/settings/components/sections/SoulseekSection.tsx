"use client";

import { useState } from "react";
import { SettingsSection, SettingsRow, SettingsInput, SettingsToggle } from "../ui";
import { SystemSettings } from "../../types";
import { ExternalLink } from "lucide-react";
import { InlineStatus, StatusType } from "@/components/ui/InlineStatus";

interface SoulseekSectionProps {
    settings: SystemSettings;
    onUpdate: (updates: Partial<SystemSettings>) => void;
    onTest: (service: string) => Promise<{ success: boolean; version?: string; error?: string }>;
    isTesting: boolean;
}

export function SoulseekSection({ settings, onUpdate, onTest, isTesting }: SoulseekSectionProps) {
    const [testStatus, setTestStatus] = useState<StatusType>("idle");
    const [testMessage, setTestMessage] = useState("");

    const handleTest = async () => {
        setTestStatus("loading");
        setTestMessage("Connecting...");
        const result = await onTest("soulseek");
        if (result.success) {
            setTestStatus("success");
            setTestMessage("Connected to Soulseek");
        } else {
            setTestStatus("error");
            setTestMessage(result.error || "Connection failed");
        }
    };

    const hasCredentials = settings.soulseekUsername && settings.soulseekPassword;
    const soulseekEnabled = settings.soulseekEnabled !== false;
    const youtubeEnabled = settings.youtubeEnabled !== false;

    return (
        <SettingsSection
            id="soulseek"
            title="Track Downloads"
            description="Download individual tracks for playlist imports"
        >
            {/* Soulseek Toggle */}
            <SettingsRow
                label="Enable Soulseek"
                description="Use Soulseek for track downloads (FLAC/MP3)"
                htmlFor="soulseek-enabled"
            >
                <SettingsToggle
                    id="soulseek-enabled"
                    checked={soulseekEnabled}
                    onChange={(checked) => onUpdate({ soulseekEnabled: checked })}
                />
            </SettingsRow>

            {soulseekEnabled && (
                <>
                    <SettingsRow
                        label="Soulseek Username"
                        description={
                            <span className="flex items-center gap-1.5">
                                Your Soulseek account username
                                <a
                                    href="https://www.slsknet.org/news/node/1"
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="inline-flex items-center gap-1 text-brand hover:underline"
                                >
                                    <ExternalLink className="w-3 h-3" />
                                    Create Account
                                </a>
                            </span>
                        }
                    >
                        <SettingsInput
                            value={settings.soulseekUsername || ""}
                            onChange={(v) => onUpdate({ soulseekUsername: v })}
                            placeholder="your_username"
                            className="w-64"
                        />
                    </SettingsRow>

                    <SettingsRow
                        label="Soulseek Password"
                        description="Your Soulseek account password"
                    >
                        <SettingsInput
                            type="password"
                            value={settings.soulseekPassword || ""}
                            onChange={(v) => onUpdate({ soulseekPassword: v })}
                            placeholder="your_password"
                            className="w-64"
                        />
                    </SettingsRow>

                    <div className="pt-2 space-y-2">
                        <div className="inline-flex items-center gap-3">
                            <button
                                onClick={handleTest}
                                disabled={isTesting || !hasCredentials}
                                className="px-4 py-1.5 text-sm bg-[#333] text-white rounded-full
                                    hover:bg-[#404040] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                            >
                                {testStatus === "loading" ? "Connecting..." : "Test Connection"}
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

            {/* YouTube Toggle */}
            <SettingsRow
                label="Enable YouTube Music"
                description="Fallback when Soulseek fails or is disabled (MP3)"
                htmlFor="youtube-enabled"
            >
                <SettingsToggle
                    id="youtube-enabled"
                    checked={youtubeEnabled}
                    onChange={(checked) => onUpdate({ youtubeEnabled: checked })}
                />
            </SettingsRow>

            {!soulseekEnabled && !youtubeEnabled && (
                <div className="mt-2 p-3 bg-red-500/10 border border-red-500/30 rounded-lg">
                    <p className="text-sm text-red-400">
                        Warning: Both download sources are disabled. Playlist imports will fail for tracks not already in your library.
                    </p>
                </div>
            )}

            <p className="text-xs text-white/40 mt-4">
                Track downloads try Soulseek first for quality, then fall back to YouTube when needed.
            </p>
        </SettingsSection>
    );
}
