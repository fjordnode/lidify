"use client";

import { useState } from "react";
import { useNotifications } from "@/hooks/useNotifications";
import { useActiveDownloads } from "@/hooks/useNotifications";
import { NotificationsTab } from "@/components/activity/NotificationsTab";
import { ActiveDownloadsTab } from "@/components/activity/ActiveDownloadsTab";
import { HistoryTab } from "@/components/activity/HistoryTab";
import {
    Bell,
    Download,
    History,
    ChevronRight,
    X,
} from "lucide-react";
import { cn } from "@/utils/cn";
import { useIsMobile, useIsTablet } from "@/hooks/useMediaQuery";

type ActivityTab = "notifications" | "active" | "history";

const TABS: { id: ActivityTab; label: string; icon: React.ElementType }[] = [
    { id: "notifications", label: "Notifications", icon: Bell },
    { id: "active", label: "Active", icon: Download },
    { id: "history", label: "History", icon: History },
];

interface ActivityPanelProps {
    isOpen: boolean;
    onToggle: () => void;
    activeTab?: ActivityTab;
    onTabChange?: (tab: ActivityTab) => void;
}

export function ActivityPanel({
    isOpen,
    onToggle,
    activeTab,
    onTabChange,
}: ActivityPanelProps) {
    const [internalActiveTab, setInternalActiveTab] =
        useState<ActivityTab>("notifications");
    const resolvedActiveTab = activeTab ?? internalActiveTab;
    const setResolvedActiveTab = onTabChange ?? setInternalActiveTab;
    const { unreadCount } = useNotifications();
    const { downloads: activeDownloads } = useActiveDownloads();
    const isMobile = useIsMobile();
    const isTablet = useIsTablet();
    const isMobileOrTablet = isMobile || isTablet;

    // Badge counts
    const notificationBadge = unreadCount > 0 ? unreadCount : null;
    const activeBadge =
        activeDownloads.length > 0 ? activeDownloads.length : null;

    // Mobile/Tablet: Full-screen overlay
    if (isMobileOrTablet) {
        if (!isOpen) return null;

        return (
            <>
                {/* Backdrop */}
                <div
                    className="fixed inset-0 bg-black/60  z-[100]"
                    onClick={onToggle}
                />

                {/* Panel - slides in from right */}
                <div
                    className="fixed inset-y-0 right-0 w-full max-w-md bg-[#0a0a0a] z-[101] flex flex-col"
                    style={{ paddingTop: "env(safe-area-inset-top)" }}
                >
                    {/* Header */}
                    <div className="flex items-center justify-between px-4 py-4 border-b border-white/10">
                        <h2 className="text-lg font-semibold text-white">
                            Activity
                        </h2>
                        <button
                            onClick={onToggle}
                            className="p-2 hover:bg-white/10 rounded-full transition-colors"
                            title="Close"
                        >
                            <X className="w-5 h-5 text-white/60" />
                        </button>
                    </div>

                    {/* Tabs */}
                    <div className="flex border-b border-white/10">
                        {TABS.map((tab) => {
                            const Icon = tab.icon;
                            const badge =
                                tab.id === "notifications"
                                    ? notificationBadge
                                    : tab.id === "active"
                                    ? activeBadge
                                    : null;

                            return (
                                <button
                                    key={tab.id}
                                    onClick={() => setResolvedActiveTab(tab.id)}
                                    className={cn(
                                        "flex-1 flex items-center justify-center gap-2 py-3 text-sm font-medium transition-colors relative",
                                        resolvedActiveTab === tab.id
                                            ? "text-white border-b-2 border-brand"
                                            : "text-white/50 hover:text-white/70"
                                    )}
                                >
                                    <Icon className="w-4 h-4" />
                                    <span>{tab.label}</span>
                                    {badge && (
                                        <span
                                            className={cn(
                                                "min-w-[18px] h-[18px] px-1 rounded-full text-xs font-bold flex items-center justify-center ml-1",
                                                tab.id === "active"
                                                    ? "bg-blue-500 text-white"
                                                    : "bg-brand text-black"
                                            )}
                                        >
                                            {badge > 99 ? "99+" : badge}
                                        </span>
                                    )}
                                </button>
                            );
                        })}
                    </div>

                    {/* Tab Content */}
                    <div className="flex-1 overflow-hidden">
                        {resolvedActiveTab === "notifications" && (
                            <NotificationsTab />
                        )}
                        {resolvedActiveTab === "active" && (
                            <ActiveDownloadsTab />
                        )}
                        {resolvedActiveTab === "history" && <HistoryTab />}
                    </div>
                </div>
            </>
        );
    }

    // Desktop: Side panel - only render when open
    if (!isOpen) return null;

    return (
        <div
            className="shrink-0 h-full w-[400px] bg-[#0d0d0d] rounded-tl-lg rounded-bl-lg border-l border-white/5 flex flex-col z-10 overflow-hidden relative"
        >
            <div className="flex flex-col h-full">
                {/* Header */}
                <div className="flex items-center justify-between px-5 py-4 border-b border-white/10">
                    <h2 className="text-base font-semibold text-white whitespace-nowrap">
                        Activity
                    </h2>
                    <button
                        onClick={onToggle}
                        className="p-1.5 hover:bg-white/10 rounded transition-colors"
                        title="Close panel"
                    >
                        <ChevronRight className="w-5 h-5 text-white/60" />
                    </button>
                </div>

                {/* Tabs */}
                <div className="flex border-b border-white/10">
                    {TABS.map((tab) => {
                        const Icon = tab.icon;
                        const badge =
                            tab.id === "notifications"
                                ? notificationBadge
                                : tab.id === "active"
                                ? activeBadge
                                : null;

                        return (
                            <button
                                key={tab.id}
                                onClick={() => setResolvedActiveTab(tab.id)}
                                className={cn(
                                    "flex-1 flex items-center justify-center gap-2 py-3 text-sm font-medium transition-colors relative whitespace-nowrap",
                                    resolvedActiveTab === tab.id
                                        ? "text-white border-b-2 border-brand"
                                        : "text-white/50 hover:text-white/70"
                                )}
                            >
                                <Icon className="w-4 h-4" />
                                <span>{tab.label}</span>
                                {badge && (
                                    <span
                                        className={cn(
                                            "absolute -top-0.5 right-1/4 min-w-[18px] h-[18px] px-1 rounded-full text-xs font-bold flex items-center justify-center",
                                            tab.id === "active"
                                                ? "bg-blue-500 text-white"
                                                : "bg-brand text-black"
                                        )}
                                    >
                                        {badge > 99 ? "99+" : badge}
                                    </span>
                                )}
                            </button>
                        );
                    })}
                </div>

                {/* Tab Content */}
                <div className="flex-1 overflow-hidden">
                    {resolvedActiveTab === "notifications" && (
                        <NotificationsTab />
                    )}
                    {resolvedActiveTab === "active" && <ActiveDownloadsTab />}
                    {resolvedActiveTab === "history" && <HistoryTab />}
                </div>
            </div>
        </div>
    );
}

// Toggle button for TopBar
export function ActivityPanelToggle() {
    const { unreadCount } = useNotifications();
    const { downloads: activeDownloads } = useActiveDownloads();
    const isMobile = useIsMobile();
    const isTablet = useIsTablet();

    if (isMobile || isTablet) {
        return null;
    }

    const hasActivity = unreadCount > 0 || activeDownloads.length > 0;

    return (
        <button
            onClick={() =>
                window.dispatchEvent(new CustomEvent("toggle-activity-panel"))
            }
            className={cn(
                "relative p-2 rounded-full transition-all",
                "text-white/60 hover:text-white"
            )}
            title="Toggle activity panel"
        >
            <Bell className="w-5 h-5" />
            {hasActivity && (
                <span className="absolute top-1.5 right-2 w-1 h-1 rounded-full bg-brand" />
            )}
        </button>
    );
}
