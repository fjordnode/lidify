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
    openrouterModel: string;
    fanartEnabled: boolean;
    fanartApiKey: string;
    // Audiobookshelf
    audiobookshelfEnabled: boolean;
    audiobookshelfUrl: string;
    audiobookshelfApiKey: string;
    // Soulseek (direct connection via slsk-client)
    soulseekEnabled: boolean;
    soulseekUsername: string;
    soulseekPassword: string;
    // YouTube Music (yt-dlp fallback)
    youtubeEnabled: boolean;
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
