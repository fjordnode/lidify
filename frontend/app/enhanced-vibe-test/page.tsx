"use client";

import { EnhancedVibeOverlay } from "../../components/player/VibeOverlayEnhanced";
import { useAudioState } from "@/lib/audio-state-context";
import { useState } from "react";
import { cn } from "@/utils/cn";

/**
 * Test page for enhanced vibe overlay
 */
export default function EnhancedVibeTest() {
    const { vibeMode } = useAudioState();
    const [isTestMode, setIsTestMode] = useState(false);

    // Mock track data for testing
    const mockTrackFeatures = {
        bpm: 128,
        energy: 0.75,
        valence: 0.60,
        arousal: 0.85,
        danceability: 0.90,
        keyScale: "major",
        instrumentalness: 0.15,
        danceabilityMl: 0.92,
        // ML mood predictions
        moodHappy: 0.85,
        moodSad: 0.25,
        moodRelaxed: 0.70,
        moodAggressive: 0.45,
        moodParty: 0.60,
        moodAcoustic: 0.30,
        moodElectronic: 0.80,
        analysisMode: "enhanced"
    };

    const mockSourceFeatures = {
        bpm: 126,
        energy: 0.78,
        valence: 0.65,
        arousal: 0.80,
        danceability: 0.88,
        keyScale: "minor",
        instrumentalness: 0.20,
        danceabilityMl: 0.90,
        moodHappy: 0.90,
        moodSad: 0.20,
        moodRelaxed: 0.75,
        moodAggressive: 0.50,
        moodParty: 0.70,
        moodAcoustic: 0.25,
        moodElectronic: 0.85,
        analysisMode: "enhanced"
    };

    // Simulate vibe mode
    const _testVibeMode = isTestMode ? { 
        isActive: true, 
        sourceFeatures: mockSourceFeatures,
        queue: []
    } : { 
        isActive: false, 
        sourceFeatures: null, 
        queue: []
    };

    return (
        <div className="min-h-screen bg-black flex flex-col items-center justify-center p-4">
            <div className="w-full max-w-4xl space-y-6">
                <div className="text-center space-y-4">
                    <h1 className="text-4xl font-bold text-white mb-2">
                        Enhanced Vibe Overlay Test
                    </h1>
                    <p className="text-gray-400 text-lg">
                        Testing the new 11-point radar visualization with particle effects
                    </p>
                    
                    <div className="flex justify-center gap-4">
                        <button
                            onClick={() => setIsTestMode(!isTestMode)}
                            className={cn(
                                "px-6 py-3 rounded-lg font-semibold transition-all",
                                isTestMode 
                                    ? "bg-brand text-black" 
                                    : "bg-white/10 text-white hover:bg-white/20"
                            )}
                        >
                            {isTestMode ? "Stop Test Mode" : "Start Test Mode"}
                        </button>
                    </div>
                    
                    <div className="text-sm text-gray-500">
                        Vibe Mode: {vibeMode ? "Active" : "Inactive"} | Test Mode: {isTestMode ? "Active" : "Inactive"}
                    </div>
                </div>

                {/* Enhanced Vibe Overlay */}
                {(vibeMode || isTestMode) && (
                    <div className="w-full">
                        <EnhancedVibeOverlay
                            currentTrackFeatures={mockTrackFeatures}
                            variant="inline"
                            onClose={() => setIsTestMode(false)}
                        />
                    </div>
                )}
                
                {/* Feature Data Display */}
                {isTestMode && (
                    <div className="bg-white/5 rounded-lg p-6 border border-white/10">
                        <h2 className="text-xl font-bold text-white mb-4">Mock Track Features</h2>
                        <div className="grid grid-cols-2 gap-4 text-sm">
                            <div>
                                <h3 className="font-semibold text-brand mb-2">Current Track</h3>
                                <div className="space-y-1 text-gray-300">
                                    <div>BPM: {mockTrackFeatures.bpm}</div>
                                    <div>Energy: {mockTrackFeatures.energy}</div>
                                    <div>Valence: {mockTrackFeatures.valence}</div>
                                    <div>Arousal: {mockTrackFeatures.arousal}</div>
                                    <div>Danceability: {mockTrackFeatures.danceability}</div>
                                    <div>Key: {mockTrackFeatures.keyScale}</div>
                                </div>
                            </div>
                            <div>
                                <h3 className="font-semibold text-yellow-400 mb-2">Source Track</h3>
                                <div className="space-y-1 text-gray-300">
                                    <div>BPM: {mockSourceFeatures.bpm}</div>
                                    <div>Energy: {mockSourceFeatures.energy}</div>
                                    <div>Valence: {mockSourceFeatures.valence}</div>
                                    <div>Arousal: {mockSourceFeatures.arousal}</div>
                                    <div>Danceability: {mockSourceFeatures.danceability}</div>
                                    <div>Key: {mockSourceFeatures.keyScale}</div>
                                </div>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}