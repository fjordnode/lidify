"use client";

import { useRemotePlaybackIntegration } from "@/hooks/useRemotePlaybackIntegration";

/**
 * Component that activates remote playback integration.
 * Must be rendered inside AudioControlsProvider and RemotePlaybackProvider.
 */
export function RemotePlaybackIntegration() {
    useRemotePlaybackIntegration();
    return null; // This component just runs the hook, renders nothing
}
