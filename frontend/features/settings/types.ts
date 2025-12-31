/**
 * Settings Types
 * Centralized type definitions for the settings feature
 */

export type Tab = "user" | "account" | "system";

export interface UserSettings {
    playbackQuality: "original" | "high" | "medium" | "low";
    wifiOnly: boolean;
    offlineEnabled: boolean;
    maxCacheSizeMb: number;
}

export interface SystemSettings {
    // Lidarr
    lidarrEnabled: boolean;
    lidarrUrl: string;
    lidarrApiKey: string;
    lidarrQualityProfileId: number | null;
    // AI Services (API key set via OPENROUTER_API_KEY environment variable)
    openrouterEnabled: boolean;
    openrouterModel: string;
    fanartEnabled: boolean;
    fanartApiKey: string;
    // Audiobookshelf
    audiobookshelfEnabled: boolean;
    audiobookshelfUrl: string;
    audiobookshelfApiKey: string;
    // Soulseek (direct connection via slsk-client)
    soulseekUsername: string;
    soulseekPassword: string;
    // Spotify (for playlist import)
    spotifyClientId: string;
    spotifyClientSecret: string;
    // Storage
    musicPath: string;
    downloadPath: string;
    // Advanced
    transcodeCacheMaxGb: number;
    maxCacheSizeMb: number;
    autoSync: boolean;
    autoEnrichMetadata: boolean;
    // Download Preferences
    downloadSource: "soulseek" | "lidarr";
    soulseekFallback: "none" | "lidarr";
}

export interface ApiKey {
    id: string;
    name: string;
    keyPreview?: string;
    createdAt: string;
    lastUsed?: string | null;
    lastUsedAt?: string | null;
}

export interface User {
    id: string;
    username: string;
    role: "user" | "admin";
    createdAt: string;
}

export interface ConfirmModalConfig {
    title: string;
    message: string;
    confirmText: string;
    onConfirm: () => void;
}
