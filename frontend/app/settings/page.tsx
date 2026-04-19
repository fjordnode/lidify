"use client";

import { useEffect, useState, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { RestartModal } from "@/components/ui/RestartModal";
import { useSettingsData } from "@/features/settings/hooks/useSettingsData";
import { useSystemSettings } from "@/features/settings/hooks/useSystemSettings";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import { InlineStatus, useInlineStatus } from "@/components/ui/InlineStatus";
import {
    SettingsLayout,
    SidebarItem
} from "@/features/settings/components/ui";

// Section components
import { AccountSection } from "@/features/settings/components/sections/AccountSection";
import { PlaybackSection } from "@/features/settings/components/sections/PlaybackSection";
import { SubsonicSection } from "@/features/settings/components/sections/SubsonicSection";
import { LidarrSection } from "@/features/settings/components/sections/LidarrSection";
import { SoulseekSection } from "@/features/settings/components/sections/SoulseekSection";
import { AIServicesSection } from "@/features/settings/components/sections/AIServicesSection";
import { ArtworkSection } from "@/features/settings/components/sections/ArtworkSection";
import { StoragePathsSection } from "@/features/settings/components/sections/StoragePathsSection";
import { CacheSection } from "@/features/settings/components/sections/CacheSection";
import { LibrarySection } from "@/features/settings/components/sections/LibrarySection";
import { UserManagementSection } from "@/features/settings/components/sections/UserManagementSection";

// Define sidebar items - organized by logical groupings
const sidebarItems: SidebarItem[] = [
    // User Settings (all users)
    { id: "account", label: "Account" },
    { id: "playback", label: "Playback" },
    { id: "subsonic", label: "Subsonic" },
    // Download Sources (admin)
    { id: "lidarr", label: "Album Downloads", adminOnly: true },
    { id: "soulseek", label: "Track Downloads", adminOnly: true },
    // AI & Enrichment (admin)
    { id: "ai-services", label: "AI Services", adminOnly: true },
    { id: "artwork", label: "Artwork Sources", adminOnly: true },
    // System (admin)
    { id: "storage", label: "Storage", adminOnly: true },
    { id: "cache", label: "Cache & Automation", adminOnly: true },
    { id: "library", label: "Library Management", adminOnly: true },
    { id: "users", label: "User Management", adminOnly: true },
];

export default function SettingsPage() {
    const { isAuthenticated, isLoading: authLoading, user } = useAuth();
    useSearchParams();
    const [isSaving, setIsSaving] = useState(false);
    const [showRestartModal, setShowRestartModal] = useState(false);
    const [testingServices, setTestingServices] = useState<Record<string, boolean>>({});
    const saveStatus = useInlineStatus();

    const isAdmin = user?.role === "admin";

    // User settings hook
    const {
        settings: userSettings,
        updateSettings: updateUserSettings,
        saveSettings: saveUserSettings,
    } = useSettingsData();

    // System settings hook (only used if admin)
    const {
        systemSettings,
        changedServices,
        updateSystemSettings,
        saveSystemSettings,
        testService,
    } = useSystemSettings();

    // Handle initial hash for section scrolling
    useEffect(() => {
        if (typeof window !== "undefined") {
            const hash = window.location.hash.substring(1);
            if (hash) {
                setTimeout(() => {
                    const element = document.getElementById(hash);
                    if (element) {
                        element.scrollIntoView({ behavior: "smooth", block: "start" });
                    }
                }, 100);
            }
        }
    }, []);

    // Unified save function
    const handleSaveAll = useCallback(async () => {
        setIsSaving(true);
        saveStatus.setLoading();
        let hasError = false;
        let changedSystemServices: string[] = [];

        try {
            await saveUserSettings(userSettings);
        } catch (error) {
            console.error("Failed to save user settings:", error);
            hasError = true;
        }

        if (isAdmin) {
            try {
                changedSystemServices = await saveSystemSettings(systemSettings) || [];
            } catch (error) {
                console.error("Failed to save system settings:", error);
                hasError = true;
            }
        }

        setIsSaving(false);

        if (hasError) {
            saveStatus.setError("Failed to save");
        } else {
            saveStatus.setSuccess("Saved");
            if (changedSystemServices.length > 0) {
                setShowRestartModal(true);
            }
        }
    }, [userSettings, systemSettings, isAdmin, saveUserSettings, saveSystemSettings, saveStatus]);

    // Test service wrapper
    const handleTestService = useCallback(async (service: string) => {
        setTestingServices(prev => ({ ...prev, [service]: true }));
        try {
            return await testService(service);
        } finally {
            setTestingServices(prev => ({ ...prev, [service]: false }));
        }
    }, [testService]);

    if (authLoading) {
        return (
            <div className="flex items-center justify-center min-h-screen bg-[#0a0a0a]">
                <GradientSpinner size="md" />
            </div>
        );
    }

    if (!isAuthenticated) {
        return null;
    }

    return (
        <>
            <SettingsLayout sidebarItems={sidebarItems} isAdmin={isAdmin}>
                {/* ═══════════════════════════════════════════════════════════
                    USER SETTINGS (all users)
                ═══════════════════════════════════════════════════════════ */}
                
                {/* Account Section */}
                <AccountSection />

                {/* Playback Section */}
                <PlaybackSection
                    value={userSettings.playbackQuality}
                    onChange={(quality) => updateUserSettings({ playbackQuality: quality })}
                />

                {/* Subsonic Section - API compatibility for external apps */}
                <SubsonicSection />

                {/* ═══════════════════════════════════════════════════════════
                    ADMIN-ONLY SECTIONS
                ═══════════════════════════════════════════════════════════ */}
                {isAdmin && (
                    <>
                        {/* ─────────────────────────────────────────────────────
                            Download Sources
                        ───────────────────────────────────────────────────── */}
                        
                        {/* Download Services - Lidarr */}
                        <LidarrSection
                            settings={systemSettings}
                            onUpdate={updateSystemSettings}
                            onTest={handleTestService}
                            isTesting={testingServices.lidarr || false}
                        />

                        {/* P2P Networks - Soulseek */}
                        <SoulseekSection
                            settings={systemSettings}
                            onUpdate={updateSystemSettings}
                            onTest={handleTestService}
                            isTesting={testingServices.soulseek || false}
                        />

                        {/* ─────────────────────────────────────────────────────
                            AI & Enrichment
                        ───────────────────────────────────────────────────── */}
                        
                        {/* AI Services - OpenRouter */}
                        <AIServicesSection
                            settings={systemSettings}
                            onUpdate={updateSystemSettings}
                            onTest={handleTestService}
                            isTesting={testingServices.openrouter || false}
                        />

                        {/* Artwork Sources - Fanart.tv */}
                        <ArtworkSection
                            settings={systemSettings}
                            onUpdate={updateSystemSettings}
                            onTest={handleTestService}
                            isTesting={testingServices.fanart || false}
                        />

                        {/* ─────────────────────────────────────────────────────
                            System
                        ───────────────────────────────────────────────────── */}
                        
                        {/* Storage */}
                        <StoragePathsSection
                            settings={systemSettings}
                            onUpdate={updateSystemSettings}
                            onTest={handleTestService}
                            isTesting={false}
                        />

                        {/* Cache & Automation */}
                        <CacheSection
                            settings={systemSettings}
                            onUpdate={updateSystemSettings}
                        />

                        {/* Library Management */}
                        <LibrarySection />

                        {/* User Management */}
                        <UserManagementSection />
                    </>
                )}

                {/* Save Button - Fixed at bottom */}
                <div className="sticky bottom-0 pt-8 pb-8 bg-[#0a0a0a]">
                    <div className="relative">
                        <button
                            onClick={handleSaveAll}
                            disabled={isSaving}
                            className="w-full bg-white text-black font-semibold py-3 px-4 rounded-full
                                hover:scale-[1.02] active:scale-[0.98] transition-transform
                                disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100"
                        >
                            {isSaving ? "Saving..." : "Save"}
                        </button>
                        {/* Status appears below button, absolutely positioned */}
                        <div className="absolute -bottom-6 left-1/2 -translate-x-1/2">
                            <InlineStatus {...saveStatus.props} />
                        </div>
                    </div>
                </div>
            </SettingsLayout>

            {/* Restart Modal */}
            <RestartModal
                isOpen={showRestartModal}
                onClose={() => setShowRestartModal(false)}
                changedServices={changedServices}
            />
        </>
    );
}
