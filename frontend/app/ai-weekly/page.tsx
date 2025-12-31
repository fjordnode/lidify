"use client";

import { useState, useRef } from "react";
import Image from "next/image";
import { Sparkles, Play, Pause, RefreshCw, ExternalLink } from "lucide-react";
import { api } from "@/lib/api";
import { GradientSpinner } from "@/components/ui/GradientSpinner";

interface Track {
    artistName: string;
    trackTitle: string;
    reason: string;
    previewUrl: string | null;
    albumCover: string | null;
    deezerArtistId: number | null;
}

export default function AIWeeklyPage() {
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [data, setData] = useState<{ tracks: Track[]; totalPlays: number; topArtists: any[] } | null>(null);
    const [playingIdx, setPlayingIdx] = useState<number | null>(null);
    const audioRef = useRef<HTMLAudioElement | null>(null);

    const handleGenerate = async () => {
        setLoading(true);
        setError(null);
        setPlayingIdx(null);
        if (audioRef.current) audioRef.current.pause();
        try {
            const result = await api.getAIWeeklyTracks(7);
            setData(result);
        } catch (err: any) {
            setError(err.data?.message || err.message || "Failed to generate");
        } finally {
            setLoading(false);
        }
    };

    const togglePreview = (idx: number, url: string) => {
        if (playingIdx === idx) {
            audioRef.current?.pause();
            setPlayingIdx(null);
        } else {
            if (audioRef.current) audioRef.current.pause();
            audioRef.current = new Audio(url);
            audioRef.current.play();
            audioRef.current.onended = () => setPlayingIdx(null);
            setPlayingIdx(idx);
        }
    };

    return (
        <div className="min-h-screen px-4 py-8 max-w-3xl mx-auto">
            <div className="flex items-center gap-3 mb-6">
                <div className="w-12 h-12 rounded-full bg-purple-600/20 flex items-center justify-center">
                    <Sparkles className="w-6 h-6 text-purple-400" />
                </div>
                <div>
                    <h1 className="text-2xl font-bold text-white">AI Weekly</h1>
                    <p className="text-sm text-gray-400">Songs based on your listening</p>
                </div>
            </div>

            {!data && !loading && (
                <div className="text-center py-16">
                    <Sparkles className="w-16 h-16 text-purple-400 mx-auto mb-4" />
                    <p className="text-gray-400 mb-6">
                        Generate personalized song recommendations based on your last 7 days of listening
                    </p>
                    <button
                        onClick={handleGenerate}
                        className="px-6 py-3 bg-purple-600 hover:bg-purple-500 text-white font-semibold rounded-full transition-colors"
                    >
                        Generate Playlist
                    </button>
                    {error && <p className="text-red-400 mt-4">{error}</p>}
                </div>
            )}

            {loading && (
                <div className="text-center py-16">
                    <GradientSpinner size="lg" />
                    <p className="text-gray-400 mt-4">Analyzing your listening history...</p>
                </div>
            )}

            {data && (
                <>
                    <div className="flex items-center justify-between mb-4">
                        <p className="text-sm text-gray-400">
                            Based on {data.totalPlays} plays · Top: {data.topArtists[0]?.name}
                        </p>
                        <button
                            onClick={handleGenerate}
                            disabled={loading}
                            className="flex items-center gap-2 text-sm text-gray-400 hover:text-white"
                        >
                            <RefreshCw className="w-4 h-4" />
                            Regenerate
                        </button>
                    </div>

                    <div className="space-y-2">
                        {data.tracks.map((track, idx) => (
                            <div
                                key={idx}
                                className="flex items-center gap-3 p-3 rounded-lg bg-white/5 hover:bg-white/10 transition-colors"
                            >
                                {track.albumCover ? (
                                    <Image
                                        src={track.albumCover}
                                        alt=""
                                        width={48}
                                        height={48}
                                        className="rounded"
                                    />
                                ) : (
                                    <div className="w-12 h-12 bg-white/10 rounded flex items-center justify-center">
                                        <Sparkles className="w-5 h-5 text-gray-500" />
                                    </div>
                                )}

                                <div className="flex-1 min-w-0">
                                    <p className="text-sm font-medium text-white truncate">
                                        {track.trackTitle}
                                    </p>
                                    <a
                                        href={`https://www.last.fm/music/${encodeURIComponent(track.artistName)}`}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="text-xs text-gray-400 hover:text-purple-400 hover:underline truncate block"
                                    >
                                        {track.artistName}
                                    </a>
                                    <p className="text-[10px] text-gray-500 truncate">{track.reason}</p>
                                </div>

                                {track.previewUrl && (
                                    <button
                                        onClick={() => togglePreview(idx, track.previewUrl!)}
                                        className="w-10 h-10 flex items-center justify-center rounded-full bg-purple-600/20 hover:bg-purple-600/40 transition-colors"
                                    >
                                        {playingIdx === idx ? (
                                            <Pause className="w-4 h-4 text-purple-400" />
                                        ) : (
                                            <Play className="w-4 h-4 text-purple-400 ml-0.5" />
                                        )}
                                    </button>
                                )}
                            </div>
                        ))}
                    </div>
                </>
            )}
        </div>
    );
}
