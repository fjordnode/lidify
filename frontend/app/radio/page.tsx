"use client";

import { useState, useEffect, useMemo } from "react";
import { Radio, Play, Loader2, Shuffle, ChevronLeft, ChevronDown, ChevronRight } from "lucide-react";
import Link from "next/link";
import { api, MoodBucketPreset, MoodType } from "@/lib/api";
import { useRemoteAwareAudioControls } from "@/lib/remote-aware-audio-controls-context";
import { Track } from "@/lib/audio-state-context";
import { toast } from "sonner";

interface RadioStation {
    id: string;
    name: string;
    description: string;
    color: string;
    filter: {
        type: "genre" | "decade" | "mood" | "discovery" | "favorites" | "all";
        value?: string;
    };
    minTracks?: number;
}

interface GenreCount {
    genre: string;
    count: number;
}

// ============================================================
// GENRE HIERARCHY SYSTEM
// ============================================================

const GENRE_HIERARCHY: Record<string, string[]> = {
    "Rock": ["rock", "grunge", "britpop", "shoegaze", "post-punk", "new wave", "classic rock", "hard rock", "progressive rock", "psychedelic rock", "blues rock", "garage rock", "stoner rock", "art rock", "glam rock", "southern rock", "surf rock", "noise rock", "math rock", "space rock", "acid rock"],
    "Metal": ["metal", "heavy metal", "death metal", "black metal", "doom metal", "thrash metal", "progressive metal", "power metal", "symphonic metal", "melodic death metal", "stoner metal", "sludge metal", "folk metal", "gothic metal", "metalcore", "deathcore", "groove metal", "industrial metal", "nu metal", "speed metal", "viking metal", "post-metal", "djent", "alternative metal", "brutal death metal", "technical death metal", "melodic black metal", "symphonic black metal", "atmospheric black metal", "blackened death metal", "avant-garde metal", "rap metal", "grindcore", "hardcore"],
    "Electronic": ["electronic", "house", "techno", "ambient", "trance", "drum and bass", "dubstep", "idm", "synthwave", "downtempo", "trip-hop", "industrial", "ebm", "electro", "breakbeat", "hardstyle", "gabber", "chillout", "vaporwave", "future bass", "uk garage", "jungle", "big beat", "minimal techno", "deep house", "tech house", "progressive house", "psytrance"],
    "Hip-Hop": ["hip-hop", "rap", "trap", "boom bap", "gangsta rap", "conscious hip-hop", "lo-fi hip-hop", "instrumental hip-hop", "grime", "drill", "cloud rap", "jazz rap", "underground hip-hop", "east coast hip-hop", "west coast hip-hop", "southern hip-hop"],
    "Jazz": ["jazz", "bebop", "hard bop", "cool jazz", "modal jazz", "free jazz", "jazz fusion", "smooth jazz", "vocal jazz", "swing", "big band", "latin jazz"],
    "Blues": ["blues", "delta blues", "chicago blues", "electric blues", "country blues"],
    "Folk": ["folk", "indie folk", "folk rock", "americana", "bluegrass", "celtic", "traditional folk", "singer-songwriter", "alt country"],
    "Classical": ["classical", "baroque", "romantic", "modern classical", "contemporary classical", "opera", "choral", "chamber music", "orchestral", "minimalism", "film score", "soundtrack"],
    "Pop": ["pop", "synthpop", "dance pop", "electropop", "indie pop", "art pop", "k-pop", "j-pop", "teen pop", "soft rock"],
    "Soul & R&B": ["soul", "r&b", "rhythm and blues", "neo soul", "funk", "disco", "motown", "gospel"],
    "Punk": ["punk", "punk rock", "pop punk", "hardcore punk", "post-hardcore", "emo", "screamo", "ska punk"],
    "Reggae": ["reggae", "dub", "dancehall", "ska", "rocksteady"],
    "Country": ["country", "outlaw country", "country rock", "country pop", "honky tonk"],
    "World": ["world", "latin", "afrobeat", "afropop", "bossa nova", "samba", "flamenco", "reggaeton", "salsa"],
    "Indie": ["indie", "indie rock", "indie pop", "lo-fi"],
    "Alternative": ["alternative", "alternative rock", "grunge", "experimental", "post-rock", "new wave"],
};

const GENRE_PARENT_LOOKUP = new Map<string, string>(
    Object.entries(GENRE_HIERARCHY).flatMap(([parent, subGenres]) => [
        [parent.toLowerCase(), parent],
        ...subGenres.map((sub) => [sub.toLowerCase(), parent] as [string, string]),
    ])
);

// Keywords that map to parent genres for fuzzy matching
const PARENT_KEYWORDS: [string, string][] = [
    ["rock", "Rock"],
    ["metal", "Metal"],
    ["punk", "Punk"],
    ["jazz", "Jazz"],
    ["blues", "Blues"],
    ["folk", "Folk"],
    ["country", "Country"],
    ["classical", "Classical"],
    ["hip-hop", "Hip-Hop"],
    ["hip hop", "Hip-Hop"],
    ["rap", "Hip-Hop"],
    ["electronic", "Electronic"],
    ["electro", "Electronic"],
    ["house", "Electronic"],
    ["techno", "Electronic"],
    ["ambient", "Electronic"],
    ["trance", "Electronic"],
    ["dubstep", "Electronic"],
    ["drum and bass", "Electronic"],
    ["industrial", "Electronic"],
    ["synth", "Electronic"],
    ["pop", "Pop"],
    ["soul", "Soul & R&B"],
    ["r&b", "Soul & R&B"],
    ["funk", "Soul & R&B"],
    ["disco", "Soul & R&B"],
    ["reggae", "Reggae"],
    ["ska", "Reggae"],
    ["dub", "Reggae"],
    ["latin", "World"],
    ["world", "World"],
    ["indie", "Indie"],
    ["alternative", "Alternative"],
];

function getParentForGenre(genre: string): string {
    const lower = genre.toLowerCase();
    
    // 1. Exact match in lookup table
    const exact = GENRE_PARENT_LOOKUP.get(lower);
    if (exact) return exact;
    
    // 2. Fuzzy match: check if genre contains a parent keyword
    // Sort by keyword length descending to match more specific terms first
    // e.g., "hip-hop" before "hop", "electronic" before "electro"
    for (const [keyword, parent] of PARENT_KEYWORDS) {
        if (lower.includes(keyword)) {
            return parent;
        }
    }
    
    // 3. No match - return as-is (will become its own group)
    return genre;
}

interface GenreGroup {
    parent: string;
    count: number;
    subGenres: GenreCount[];
}

function groupGenresByParent(genres: GenreCount[]): GenreGroup[] {
    const groups = new Map<string, { count: number; subGenres: GenreCount[] }>();
    for (const genre of genres) {
        const parent = getParentForGenre(genre.genre);
        const existing = groups.get(parent) ?? { count: 0, subGenres: [] };
        existing.count += genre.count;
        existing.subGenres.push(genre);
        groups.set(parent, existing);
    }

    return Array.from(groups.entries())
        .map(([parent, data]) => ({
            parent,
            count: data.count,
            subGenres: [...data.subGenres].sort((a, b) => b.count - a.count),
        }))
        .sort((a, b) => b.count - a.count);
}

// ============================================================
// DYNAMIC COLOR GENERATION
// ============================================================

const PARENT_COLORS: Record<string, string> = {
    "Rock": "from-red-500/30 to-orange-600/30",
    "Metal": "from-zinc-600/30 to-neutral-800/30",
    "Electronic": "from-cyan-500/30 to-blue-600/30",
    "Hip-Hop": "from-purple-500/30 to-indigo-600/30",
    "Jazz": "from-amber-500/30 to-yellow-600/30",
    "Blues": "from-blue-600/30 to-indigo-700/30",
    "Folk": "from-green-500/30 to-emerald-600/30",
    "Classical": "from-slate-400/30 to-gray-500/30",
    "Pop": "from-pink-500/30 to-rose-600/30",
    "Soul & R&B": "from-fuchsia-500/30 to-pink-600/30",
    "Punk": "from-lime-500/30 to-green-600/30",
    "Reggae": "from-green-400/30 to-yellow-500/30",
    "Country": "from-orange-400/30 to-amber-500/30",
    "World": "from-teal-500/30 to-cyan-600/30",
    "Indie": "from-violet-500/30 to-purple-600/30",
    "Alternative": "from-indigo-500/30 to-blue-600/30",
};

function getParentColor(parent: string): string {
    return PARENT_COLORS[parent] ?? "from-slate-500/30 to-gray-600/30";
}

// Static radio stations
const STATIC_STATIONS: RadioStation[] = [
    {
        id: "all",
        name: "Shuffle All",
        description: "Your entire library",
        color: "from-brand/40 to-amber-600/30",
        filter: { type: "all" },
        minTracks: 10,
    },
    {
        id: "discovery",
        name: "Discovery",
        description: "Lesser-played gems",
        color: "from-emerald-500/30 to-teal-600/30",
        filter: { type: "discovery" },
        minTracks: 20,
    },
    {
        id: "favorites",
        name: "Favorites",
        description: "Most played",
        color: "from-rose-500/30 to-pink-600/30",
        filter: { type: "favorites" },
        minTracks: 10,
    },
];

interface DecadeCount {
    decade: number;
    count: number;
}

// Decade color mapping - covers from 1700s (classical) to 2020s
const DECADE_COLORS: Record<number, string> = {
    1700: "from-amber-800/30 to-yellow-900/30",
    1710: "from-amber-700/30 to-yellow-800/30",
    1720: "from-amber-700/30 to-yellow-800/30",
    1730: "from-amber-700/30 to-yellow-800/30",
    1740: "from-amber-700/30 to-yellow-800/30",
    1750: "from-amber-600/30 to-yellow-700/30",
    1760: "from-amber-600/30 to-yellow-700/30",
    1770: "from-amber-600/30 to-yellow-700/30",
    1780: "from-amber-600/30 to-yellow-700/30",
    1790: "from-amber-600/30 to-yellow-700/30",
    1800: "from-slate-600/30 to-gray-700/30",
    1810: "from-slate-600/30 to-gray-700/30",
    1820: "from-slate-500/30 to-gray-600/30",
    1830: "from-slate-500/30 to-gray-600/30",
    1840: "from-slate-500/30 to-gray-600/30",
    1850: "from-slate-400/30 to-gray-500/30",
    1860: "from-slate-400/30 to-gray-500/30",
    1870: "from-slate-400/30 to-gray-500/30",
    1880: "from-slate-400/30 to-gray-500/30",
    1890: "from-slate-400/30 to-gray-500/30",
    1900: "from-sepia-400/30 to-amber-500/30",
    1910: "from-amber-400/30 to-yellow-500/30",
    1920: "from-yellow-500/30 to-amber-600/30",
    1930: "from-orange-400/30 to-amber-500/30",
    1940: "from-red-400/30 to-orange-500/30",
    1950: "from-pink-400/30 to-red-500/30",
    1960: "from-amber-500/30 to-orange-600/30",
    1970: "from-orange-500/30 to-red-600/30",
    1980: "from-fuchsia-500/30 to-purple-600/30",
    1990: "from-purple-500/30 to-violet-600/30",
    2000: "from-blue-500/30 to-cyan-600/30",
    2010: "from-teal-500/30 to-emerald-600/30",
    2020: "from-orange-500/30 to-amber-600/30",
};

const getDecadeColor = (decade: number): string => {
    return DECADE_COLORS[decade] || "from-gray-500/30 to-slate-600/30";
};

const getDecadeName = (decade: number): string => {
    if (decade < 1900) return `${decade}s`;
    if (decade < 2000) return `${decade.toString().slice(2)}s`;
    return `${decade}s`;
};

const getDecadeDescription = (decade: number, count: number): string => {
    return `${decade}-${decade + 9} • ${count} tracks`;
};

const formatCount = (count: number): string => {
    return count >= 1000 ? `${(count / 1000).toFixed(1)}k` : count.toString();
};

const MOOD_ORDER: MoodType[] = [
    "happy",
    "energetic",
    "party",
    "chill",
    "focus",
    "acoustic",
    "melancholy",
    "sad",
    "aggressive",
];

const MOOD_LABELS: Record<MoodType, string> = {
    happy: "Happy & Upbeat",
    energetic: "High Energy",
    party: "Dance Party",
    chill: "Chill & Relaxed",
    focus: "Focus Mode",
    acoustic: "Acoustic Vibes",
    melancholy: "Deep Feels",
    sad: "Melancholic",
    aggressive: "Intense",
};

const MOOD_COLORS: Record<MoodType, string> = {
    happy: "from-yellow-500/30 to-orange-500/30",
    energetic: "from-orange-500/30 to-red-500/30",
    party: "from-pink-500/30 to-purple-600/30",
    chill: "from-teal-500/30 to-cyan-600/30",
    focus: "from-emerald-500/30 to-green-600/30",
    acoustic: "from-amber-600/30 to-yellow-600/30",
    melancholy: "from-slate-600/30 to-gray-700/30",
    sad: "from-blue-600/30 to-indigo-700/30",
    aggressive: "from-red-600/30 to-rose-700/30",
};



// Radio Station Card Component
function RadioStationCard({ 
    station, 
    onPlay, 
    isLoading,
    size = "normal",
}: { 
    station: RadioStation; 
    onPlay: () => void; 
    isLoading: boolean;
    size?: "normal" | "large" | "small";
}) {
    const sizeClasses = {
        large: "aspect-[3/2] md:col-span-2 md:row-span-1",
        normal: "aspect-[4/3]",
        small: "aspect-[16/9]",
    };
    
    const textSizes = {
        large: { title: "text-base md:text-lg", desc: "text-sm" },
        normal: { title: "text-sm", desc: "text-xs" },
        small: { title: "text-base", desc: "text-xs" },
    };
    
    return (
        <button
            onClick={onPlay}
            disabled={isLoading}
            className={`
                relative group w-full
                ${sizeClasses[size]} rounded-xl overflow-hidden
                bg-gradient-to-br ${station.color}
                border border-white/10 hover:border-white/20
                transition-all duration-300 ease-out
                hover:scale-[1.02] hover:shadow-lg hover:shadow-black/30
                active:scale-[0.98]
                disabled:opacity-50 disabled:cursor-not-allowed
            `}
        >
            {/* Subtle noise texture overlay */}
            <div className="absolute inset-0 opacity-30 mix-blend-overlay bg-[url('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIzMDAiIGhlaWdodD0iMzAwIj48ZmlsdGVyIGlkPSJhIiB4PSIwIiB5PSIwIj48ZmVUdXJidWxlbmNlIGJhc2VGcmVxdWVuY3k9Ii43NSIgc3RpdGNoVGlsZXM9InN0aXRjaCIgdHlwZT0iZnJhY3RhbE5vaXNlIi8+PGZlQ29sb3JNYXRyaXggdHlwZT0ic2F0dXJhdGUiIHZhbHVlcz0iMCIvPjwvZmlsdGVyPjxyZWN0IHdpZHRoPSIxMDAlIiBoZWlnaHQ9IjEwMCUiIGZpbHRlcj0idXJsKCNhKSIvPjwvc3ZnPg==')]" />
            
            {/* Content */}
            <div className="absolute inset-0 p-3 md:p-4 flex flex-col justify-between">
                <div className="flex items-center gap-1.5">
                    <Radio className="w-4 h-4 text-white/60" />
                    <span className="text-[10px] text-white/60 font-medium uppercase tracking-wider">
                        Radio
                    </span>
                </div>
                <div>
                    <h3 className={`${textSizes[size].title} font-bold text-white truncate leading-tight`}>
                        {station.name}
                    </h3>
                    <p className={`${textSizes[size].desc} text-white/50 truncate`}>
                        {station.description}
                    </p>
                </div>
            </div>

            {/* Play overlay on hover */}
            <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity duration-200 flex items-center justify-center">
                {isLoading ? (
                    <Loader2 className="w-8 h-8 text-white animate-spin" />
                ) : (
                    <div className="w-12 h-12 rounded-full bg-brand flex items-center justify-center shadow-lg shadow-brand/30 transition-transform group-hover:scale-110">
                        <Play className="w-5 h-5 text-black ml-0.5" fill="currentColor" />
                    </div>
                )}
            </div>
        </button>
    );
}

// ============================================================
// GENRE GROUP CARD - Expandable parent genre with sub-genres
// ============================================================

interface GenreGroupCardProps {
    group: GenreGroup;
    onPlayGenre: (genre: string, count: number) => void;
    loadingGenre: string | null;
    isLarge?: boolean;
}

function GenreGroupCard({ group, onPlayGenre, loadingGenre, isLarge = false }: GenreGroupCardProps) {
    const [isExpanded, setIsExpanded] = useState(false);
    const color = getParentColor(group.parent);
    const hasSubGenres = group.subGenres.length > 1 || group.subGenres[0]?.genre.toLowerCase() !== group.parent.toLowerCase();
    
    // Format track count
    const formatCount = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : n.toString();
    
    return (
        <div className={`${isLarge ? "md:col-span-2" : ""}`}>
            {/* Main parent card */}
            <div
                className={`
                    relative group rounded-xl overflow-hidden
                    bg-gradient-to-br ${color}
                    border border-white/10 
                    transition-all duration-300 ease-out
                    ${isExpanded ? "rounded-b-none border-b-0" : "hover:border-white/20 hover:shadow-lg hover:shadow-black/30"}
                `}
                role="button"
                tabIndex={0}
                onClick={() => onPlayGenre(group.parent, group.count)}
                onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onPlayGenre(group.parent, group.count);
                    }
                }}
            >
                {/* Noise texture */}
                <div className="absolute inset-0 opacity-30 mix-blend-overlay bg-[url('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIzMDAiIGhlaWdodD0iMzAwIj48ZmlsdGVyIGlkPSJhIiB4PSIwIiB5PSIwIj48ZmVUdXJidWxlbmNlIGJhc2VGcmVxdWVuY3k9Ii43NSIgc3RpdGNoVGlsZXM9InN0aXRjaCIgdHlwZT0iZnJhY3RhbE5vaXNlIi8+PGZlQ29sb3JNYXRyaXggdHlwZT0ic2F0dXJhdGUiIHZhbHVlcz0iMCIvPjwvZmlsdGVyPjxyZWN0IHdpZHRoPSIxMDAlIiBoZWlnaHQ9IjEwMCUiIGZpbHRlcj0idXJsKCNhKSIvPjwvc3ZnPg==')]" />
                
                <div className={`relative ${isLarge ? "p-5" : "p-4"} flex items-center justify-between gap-3`}>
                    {/* Left: Genre info */}
                    <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                            <Radio className="w-4 h-4 text-white/60 flex-shrink-0" />
                            <span className="text-[10px] text-white/60 font-medium uppercase tracking-wider">
                                {hasSubGenres ? `${group.subGenres.length} styles` : "Radio"}
                            </span>
                        </div>
                        <h3 className={`${isLarge ? "text-xl" : "text-base"} font-bold text-white truncate`}>
                            {group.parent}
                        </h3>
                        <p className="text-xs text-white/50">
                            {formatCount(group.count)} tracks
                        </p>
                    </div>
                    
                    {/* Right: Actions */}
                    <div className="flex items-center gap-2 flex-shrink-0">
                        {/* Play button */}
                        <button
                            onClick={(event) => {
                                event.stopPropagation();
                                onPlayGenre(group.parent, group.count);
                            }}
                            disabled={loadingGenre !== null}
                            className={`
                                ${isLarge ? "w-12 h-12" : "w-10 h-10"} rounded-full 
                                bg-white/20 hover:bg-brand 
                                flex items-center justify-center 
                                transition-all duration-200
                                hover:scale-105 active:scale-95
                                disabled:opacity-50
                                group/play
                            `}
                        >
                            {loadingGenre === group.parent ? (
                                <Loader2 className="w-5 h-5 text-white animate-spin" />
                            ) : (
                                <Play className="w-5 h-5 text-white group-hover/play:text-black ml-0.5" fill="currentColor" />
                            )}
                        </button>
                        
                        {/* Expand button (only if has sub-genres) */}
                        {hasSubGenres && (
                            <button
                                onClick={(event) => {
                                    event.stopPropagation();
                                    setIsExpanded(!isExpanded);
                                }}
                                className="w-8 h-8 rounded-full bg-white/10 hover:bg-white/20 flex items-center justify-center transition-all duration-200"
                            >
                                <ChevronDown 
                                    className={`w-4 h-4 text-white/70 transition-transform duration-200 ${isExpanded ? "rotate-180" : ""}`} 
                                />
                            </button>
                        )}
                    </div>
                </div>
            </div>
            
            {/* Expanded sub-genres panel */}
            {hasSubGenres && (
                <div 
                    className={`
                        overflow-hidden transition-all duration-300 ease-out
                        ${isExpanded ? "max-h-[500px] opacity-100" : "max-h-0 opacity-0"}
                    `}
                >
                    <div className={`
                        bg-gradient-to-b ${color} 
                        border border-t-0 border-white/10 rounded-b-xl
                        p-3 space-y-1
                    `}>
                        {group.subGenres.map((sub) => (
                            <button
                                key={sub.genre}
                                onClick={(event) => {
                                    event.stopPropagation();
                                    onPlayGenre(sub.genre, sub.count);
                                }}
                                disabled={loadingGenre !== null}
                                className="
                                    w-full flex items-center justify-between gap-3
                                    px-3 py-2 rounded-lg
                                    bg-black/20 hover:bg-black/40
                                    transition-all duration-150
                                    group/sub
                                    disabled:opacity-50
                                "
                            >
                                <div className="flex items-center gap-2 min-w-0">
                                    <ChevronRight className="w-3 h-3 text-white/40 flex-shrink-0" />
                                    <span className="text-sm text-white/90 truncate">{sub.genre}</span>
                                </div>
                                <div className="flex items-center gap-2 flex-shrink-0">
                                    <span className="text-xs text-white/40">{sub.count}</span>
                                    {loadingGenre === sub.genre ? (
                                        <Loader2 className="w-4 h-4 text-white/60 animate-spin" />
                                    ) : (
                                        <Play className="w-4 h-4 text-white/40 group-hover/sub:text-white transition-colors" fill="currentColor" />
                                    )}
                                </div>
                            </button>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}

// Section Header Component
function SectionHeader({ title, description }: { title: string; description?: string }) {
    return (
        <div className="mb-4">
            <h2 className="text-xl font-bold text-white">{title}</h2>
            {description && <p className="text-sm text-white/50 mt-1">{description}</p>}
        </div>
    );
}

export default function RadioPage() {
    const { playTracks } = useRemoteAwareAudioControls();
    const [loadingStation, setLoadingStation] = useState<string | null>(null);
    const [genres, setGenres] = useState<GenreCount[]>([]);
    const [decades, setDecades] = useState<DecadeCount[]>([]);
    const [moodPresets, setMoodPresets] = useState<MoodBucketPreset[]>([]);
    const [isLoading, setIsLoading] = useState(true);

    // Fetch available genres and decades from library
    useEffect(() => {
        const fetchData = async () => {
            try {
                const [genresRes, decadesRes, moodRes] = await Promise.allSettled([
                    api.get<{ genres: GenreCount[] }>("/library/genres"),
                    api.get<{ decades: DecadeCount[] }>("/library/decades"),
                    api.getMoodBucketPresets(),
                ]);
                
                if (genresRes.status === "fulfilled") {
                    // Filter to genres with enough tracks (at least 15)
                    const validGenres = (genresRes.value.genres || []).filter((g) => g.count >= 15);
                    setGenres(validGenres);
                } else {
                    console.error("Failed to fetch genres:", genresRes.reason);
                }

                if (decadesRes.status === "fulfilled") {
                    // Decades already filtered by backend (15+ tracks)
                    setDecades(decadesRes.value.decades || []);
                } else {
                    console.error("Failed to fetch decades:", decadesRes.reason);
                }

                if (moodRes.status === "fulfilled") {
                    setMoodPresets(moodRes.value || []);
                } else {
                    console.error("Failed to fetch mood presets:", moodRes.reason);
                }
            } catch (error) {
                console.error("Failed to fetch radio data:", error);
            } finally {
                setIsLoading(false);
            }
        };

        fetchData();
    }, []);

    const startRadio = async (station: RadioStation) => {
        setLoadingStation(station.id);

        try {
            const params = new URLSearchParams();
            params.set("type", station.filter.type);
            if (station.filter.value) {
                params.set("value", station.filter.value);
            }
            params.set("limit", "100");

            const response = await api.get<{ tracks: Track[] }>(`/library/radio?${params.toString()}`);

            if (!response.tracks || response.tracks.length === 0) {
                toast.error(`No tracks found for ${station.name}`);
                return;
            }

            if (response.tracks.length < (station.minTracks || 10)) {
                toast.error(`Not enough tracks for ${station.name} radio`, {
                    description: `Found ${response.tracks.length}, need at least ${station.minTracks || 10}`,
                });
                return;
            }

            // Shuffle the tracks
            const shuffled = [...response.tracks].sort(() => Math.random() - 0.5);

            // Start playing
            playTracks(shuffled, 0);
            toast.success(`${station.name} Radio`, {
                description: `Shuffling ${shuffled.length} tracks`,
                icon: <Shuffle className="w-4 h-4" />,
            });
        } catch (error) {
            console.error("Failed to start radio:", error);
            toast.error("Failed to start radio station");
        } finally {
            setLoadingStation(null);
        }
    };

    // Group genres by parent - show all in unified grid
    const groupedGenres = useMemo(() => groupGenresByParent(genres), [genres]);
    
    // Handler for playing a specific genre
    const handlePlayGenre = async (genre: string, count: number) => {
        const station: RadioStation = {
            id: `genre-${genre}`,
            name: genre,
            description: `${count} tracks`,
            color: getParentColor(getParentForGenre(genre)),
            filter: { type: "genre", value: genre },
            minTracks: 15,
        };
        await startRadio(station);
    };

    // Create decade stations from library (dynamically based on what's available)
    const decadeStations: RadioStation[] = decades.map((d) => ({
        id: `decade-${d.decade}`,
        name: getDecadeName(d.decade),
        description: getDecadeDescription(d.decade, d.count),
        color: getDecadeColor(d.decade),
        filter: { type: "decade" as const, value: d.decade.toString() },
        minTracks: 15,
    }));

    const moodCounts = useMemo(() => {
        return new Map(moodPresets.map((preset) => [preset.id, preset.trackCount]));
    }, [moodPresets]);

    const moodStations: RadioStation[] = useMemo(() => {
        return MOOD_ORDER.map((mood) => {
            const count = moodCounts.get(mood) ?? 0;
            return {
                id: `mood-${mood}`,
                name: MOOD_LABELS[mood],
                description: count > 0 ? `${formatCount(count)} tracks` : "Mood mix",
                color: MOOD_COLORS[mood],
                filter: { type: "mood" as const, value: mood },
                minTracks: 8,
            };
        });
    }, [moodCounts]);

    return (
        <div className="min-h-screen relative">
            {/* Hero gradient */}
            <div 
                className="absolute top-0 left-0 right-0 pointer-events-none"
                style={{
                    background: "linear-gradient(to bottom, rgba(236, 178, 0, 0.15) 0%, rgba(139, 92, 246, 0.08) 40%, transparent 100%)",
                    height: "35vh"
                }}
            />
            <div 
                className="absolute top-0 left-0 right-0 pointer-events-none"
                style={{
                    background: "radial-gradient(ellipse at top, rgba(236, 178, 0, 0.1) 0%, transparent 70%)",
                    height: "25vh"
                }}
            />

            {/* Content */}
            <div className="relative px-4 md:px-8 py-6">
                {/* Back link */}
                <Link 
                    href="/" 
                    className="inline-flex items-center gap-1 text-sm text-white/60 hover:text-white transition-colors mb-6"
                >
                    <ChevronLeft className="w-4 h-4" />
                    Back to Home
                </Link>

                {/* Header */}
                <div className="mb-8">
                    <div className="flex items-center gap-3 mb-2">
                        <div className="w-12 h-12 rounded-lg bg-gradient-to-br from-brand to-amber-600 flex items-center justify-center">
                            <Radio className="w-6 h-6 text-black" />
                        </div>
                        <div>
                            <h1 className="text-3xl font-bold text-white">Radio Stations</h1>
                            <p className="text-white/60">Continuous shuffle from your library</p>
                        </div>
                    </div>
                </div>

                {/* Quick Start Section */}
                <section className="mb-10">
                    <SectionHeader 
                        title="Quick Start" 
                        description="Jump into your music instantly" 
                    />
                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
                        {STATIC_STATIONS.map((station) => (
                            <RadioStationCard
                                key={station.id}
                                station={station}
                                onPlay={() => startRadio(station)}
                                isLoading={loadingStation === station.id}
                                size="small"
                            />
                        ))}
                    </div>
                </section>

                {/* Mood Section */}
                <section className="mb-10">
                    <SectionHeader
                        title="By Mood"
                        description="Music for every feeling"
                    />
                    {isLoading && moodPresets.length === 0 ? (
                        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
                            {Array.from({ length: 6 }).map((_, i) => (
                                <div key={i} className="aspect-[16/9] rounded-lg bg-white/5 animate-pulse" />
                            ))}
                        </div>
                    ) : (
                        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
                            {moodStations.map((station) => (
                                <RadioStationCard
                                    key={station.id}
                                    station={station}
                                    onPlay={() => startRadio(station)}
                                    isLoading={loadingStation === station.id}
                                    size="small"
                                />
                            ))}
                        </div>
                    )}
                </section>

                {/* Genres Section - Redesigned with hierarchy */}
                {(isLoading || groupedGenres.length > 0) && (
                    <section className="mb-10">
                        <SectionHeader 
                            title="By Genre" 
                            description="Explore your library by musical style" 
                        />
                        {isLoading ? (
                            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                                {Array.from({ length: 8 }).map((_, i) => (
                                    <div key={i} className={`${i < 2 ? "md:col-span-2" : ""} h-24 rounded-xl bg-white/5 animate-pulse`} />
                                ))}
                            </div>
                        ) : (
                            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                                {groupedGenres.map((group) => (
                                    <GenreGroupCard
                                        key={group.parent}
                                        group={group}
                                        onPlayGenre={handlePlayGenre}
                                        loadingGenre={loadingStation?.startsWith("genre-") ? loadingStation.slice(6) : null}
                                    />
                                ))}
                            </div>
                        )}
                    </section>
                )}

                {/* Decades Section - Only show if there are decade stations */}
                {(isLoading || decadeStations.length > 0) && (
                    <section className="mb-10">
                        <SectionHeader 
                            title="By Decade" 
                            description="Travel through time with your music" 
                        />
                        {isLoading ? (
                            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
                                {Array.from({ length: 6 }).map((_, i) => (
                                    <div key={i} className="aspect-[16/9] rounded-lg bg-white/5 animate-pulse" />
                                ))}
                            </div>
                        ) : (
                            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
                                {decadeStations.map((station) => (
                                    <RadioStationCard
                                        key={station.id}
                                        station={station}
                                        onPlay={() => startRadio(station)}
                                        isLoading={loadingStation === station.id}
                                        size="small"
                                    />
                                ))}
                            </div>
                        )}
                    </section>
                )}


            </div>
        </div>
    );
}
