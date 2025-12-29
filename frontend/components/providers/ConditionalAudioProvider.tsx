"use client";

import { usePathname } from "next/navigation";
import { AudioStateProvider } from "@/lib/audio-state-context";
import { AudioPlaybackProvider } from "@/lib/audio-playback-context";
import { AudioControlsProvider } from "@/lib/audio-controls-context";
import { useAuth } from "@/lib/auth-context";
import { HowlerAudioElement } from "@/components/player/HowlerAudioElement";
import { AudioErrorBoundary } from "@/components/providers/AudioErrorBoundary";
import { RemotePlaybackProvider } from "@/lib/remote-playback-context";
import { RemoteAwareAudioControlsProvider } from "@/lib/remote-aware-audio-controls-context";
import { RemotePlaybackIntegration } from "@/components/providers/RemotePlaybackIntegration";
import { RemoteVolumeCapture } from "@/components/player/RemoteVolumeCapture";

export function ConditionalAudioProvider({
    children,
}: {
    children: React.ReactNode;
}) {
    const pathname = usePathname();
    const { isAuthenticated } = useAuth();

    // Don't load audio provider on public pages or when not authenticated
    const publicPages = ["/login", "/register", "/onboarding", "/setup"];
    const isPublicPage = publicPages.includes(pathname);

    if (isPublicPage || !isAuthenticated) {
        return <>{children}</>;
    }

    // Split contexts: State -> Playback -> Controls
    // This prevents re-renders from currentTime updates affecting all consumers
    // Wrapped in error boundary to prevent audio errors from crashing the app
    //
    // Provider hierarchy for remote playback:
    // - RemotePlaybackProvider manages WebSocket connection and device list
    // - HowlerAudioElement MUST be inside RemotePlaybackProvider to check isActivePlayer
    // - RemoteAwareAudioControlsProvider wraps controls with remote routing
    // - When device is NOT active player, HowlerAudioElement stays silent
    return (
        <AudioErrorBoundary>
            <AudioStateProvider>
                <AudioPlaybackProvider>
                    <AudioControlsProvider>
                        {/* Remote playback MUST wrap HowlerAudioElement */}
                        <RemotePlaybackProvider>
                            {/* HowlerAudioElement checks isActivePlayer before playing */}
                            <HowlerAudioElement />
                            {/* Wraps controls with remote routing logic */}
                            <RemoteAwareAudioControlsProvider>
                                <RemotePlaybackIntegration />
                                {/* Captures hardware volume buttons when controlling remote */}
                                <RemoteVolumeCapture />
                                {children}
                            </RemoteAwareAudioControlsProvider>
                        </RemotePlaybackProvider>
                    </AudioControlsProvider>
                </AudioPlaybackProvider>
            </AudioStateProvider>
        </AudioErrorBoundary>
    );
}
