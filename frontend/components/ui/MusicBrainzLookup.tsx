"use client";

import { useState, useRef, useEffect } from "react";
import { Search, ExternalLink, Check, Loader2 } from "lucide-react";
import { api } from "@/lib/api";

interface MusicBrainzArtist {
    mbid: string;
    name: string;
    disambiguation: string | null;
    country: string | null;
    type: string | null;
    score: number;
}

interface MusicBrainzReleaseGroup {
    rgMbid: string;
    title: string;
    primaryType: string;
    secondaryTypes: string[];
    firstReleaseDate: string | null;
    artistCredit: string;
    score: number;
}

interface MusicBrainzLookupProps {
    type: "artist" | "album";
    currentValue: string;
    currentName?: string; // Pre-fill search with current name
    artistName?: string; // For album search, to filter by artist
    onSelect: (mbid: string) => void;
}

/**
 * MusicBrainz Lookup Component
 * Provides search functionality to find and select MusicBrainz IDs
 * Features:
 * - Manual search with button click
 * - Manual paste fallback
 * - External link to MusicBrainz
 * - Temp MBID detection
 */
export function MusicBrainzLookup({
    type,
    currentValue,
    currentName,
    artistName,
    onSelect,
}: MusicBrainzLookupProps) {
    const [searchQuery, setSearchQuery] = useState(currentName || "");
    const [isSearching, setIsSearching] = useState(false);
    const [hasSearched, setHasSearched] = useState(false);
    const [artistResults, setArtistResults] = useState<MusicBrainzArtist[]>([]);
    const [albumResults, setAlbumResults] = useState<MusicBrainzReleaseGroup[]>([]);
    const [manualMbid, setManualMbid] = useState(currentValue || "");
    const [showManualInput, setShowManualInput] = useState(false);
    const resultsRef = useRef<HTMLDivElement>(null);

    const isTempMbid = currentValue?.startsWith("temp-");
    const hasValidMbid = currentValue && !isTempMbid;

    // Perform search when button clicked
    const performSearch = async () => {
        if (searchQuery.length < 2) return;

        setIsSearching(true);
        setHasSearched(true);

        try {
            if (type === "artist") {
                const response = await api.searchMusicBrainzArtists(searchQuery);
                setArtistResults(response.artists);
                setAlbumResults([]);
            } else {
                const response = await api.searchMusicBrainzReleaseGroups(searchQuery, artistName);
                setAlbumResults(response.albums);
                setArtistResults([]);
            }
        } catch (error) {
            console.error("MusicBrainz search error:", error);
        } finally {
            setIsSearching(false);
        }
    };

    // Handle Enter key in search input
    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === "Enter") {
            e.preventDefault();
            performSearch();
        }
    };

    const handleSelectArtist = (artist: MusicBrainzArtist) => {
        onSelect(artist.mbid);
        setManualMbid(artist.mbid);
        setArtistResults([]);
        setAlbumResults([]);
        setHasSearched(false);
    };

    const handleSelectAlbum = (album: MusicBrainzReleaseGroup) => {
        onSelect(album.rgMbid);
        setManualMbid(album.rgMbid);
        setArtistResults([]);
        setAlbumResults([]);
        setHasSearched(false);
    };

    const handleManualSubmit = () => {
        // Validate UUID format
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (uuidRegex.test(manualMbid)) {
            onSelect(manualMbid);
            setShowManualInput(false);
        }
    };

    const getMusicBrainzUrl = () => {
        if (type === "artist") {
            return `https://musicbrainz.org/artist/${currentValue}`;
        }
        return `https://musicbrainz.org/release-group/${currentValue}`;
    };

    const hasResults = artistResults.length > 0 || albumResults.length > 0;

    return (
        <div className="space-y-3">
            {/* Current MBID Status */}
            <div className="flex items-center gap-2 text-sm">
                <span className="text-gray-400">Current:</span>
                {isTempMbid ? (
                    <span className="text-yellow-500 font-mono text-xs bg-yellow-500/10 px-2 py-0.5 rounded">
                        Temporary ID (needs matching)
                    </span>
                ) : hasValidMbid ? (
                    <span className="text-green-500 font-mono text-xs bg-green-500/10 px-2 py-0.5 rounded flex items-center gap-1">
                        <Check className="w-3 h-3" />
                        {currentValue.substring(0, 8)}...
                    </span>
                ) : (
                    <span className="text-gray-500 text-xs">None</span>
                )}
                {hasValidMbid && (
                    <a
                        href={getMusicBrainzUrl()}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-400 hover:text-blue-300 transition-colors"
                        title="View in MusicBrainz"
                    >
                        <ExternalLink className="w-4 h-4" />
                    </a>
                )}
            </div>

            {/* Search Section */}
            <div className="space-y-2">
                <div className="flex gap-2">
                    <input
                        type="text"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        onKeyDown={handleKeyDown}
                        placeholder={`Enter ${type} name to search...`}
                        className="flex-1 px-4 py-2 bg-[#181818] border border-white/10 rounded text-white focus:border-white/30 focus:outline-none text-sm"
                    />
                    <button
                        type="button"
                        onClick={performSearch}
                        disabled={isSearching || searchQuery.length < 2}
                        className="px-4 py-2 bg-[#282828] hover:bg-[#333] disabled:bg-[#1a1a1a] disabled:text-gray-600 border border-white/10 rounded text-white text-sm transition-colors flex items-center gap-2"
                    >
                        {isSearching ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                            <Search className="w-4 h-4" />
                        )}
                        Search
                    </button>
                </div>

                {/* Search Results List */}
                {hasSearched && (
                    <div ref={resultsRef} className="bg-[#1a1a1a] border border-white/10 rounded-lg max-h-64 overflow-y-auto">
                        {hasResults ? (
                            type === "artist" ? (
                                artistResults.map((artist) => (
                                    <button
                                        key={artist.mbid}
                                        onClick={() => handleSelectArtist(artist)}
                                        className="w-full px-4 py-3 text-left hover:bg-white/5 transition-colors border-b border-white/5 last:border-b-0"
                                    >
                                        <div className="flex items-start justify-between gap-2">
                                            <div className="min-w-0 flex-1">
                                                <div className="font-medium text-white truncate">
                                                    {artist.name}
                                                </div>
                                                {artist.disambiguation && (
                                                    <div className="text-xs text-gray-400 truncate mt-0.5">
                                                        {artist.disambiguation}
                                                    </div>
                                                )}
                                            </div>
                                            <div className="flex items-center gap-2 flex-shrink-0">
                                                {artist.country && (
                                                    <span className="text-xs text-gray-500 bg-white/5 px-1.5 py-0.5 rounded">
                                                        {artist.country}
                                                    </span>
                                                )}
                                                {artist.type && (
                                                    <span className="text-xs text-gray-500 bg-white/5 px-1.5 py-0.5 rounded">
                                                        {artist.type}
                                                    </span>
                                                )}
                                            </div>
                                        </div>
                                    </button>
                                ))
                            ) : (
                                albumResults.map((album) => (
                                    <button
                                        key={album.rgMbid}
                                        onClick={() => handleSelectAlbum(album)}
                                        className="w-full px-4 py-3 text-left hover:bg-white/5 transition-colors border-b border-white/5 last:border-b-0"
                                    >
                                        <div className="flex items-start justify-between gap-2">
                                            <div className="min-w-0 flex-1">
                                                <div className="font-medium text-white truncate">
                                                    {album.title}
                                                </div>
                                                <div className="text-xs text-gray-400 truncate mt-0.5">
                                                    {album.artistCredit}
                                                </div>
                                            </div>
                                            <div className="flex items-center gap-2 flex-shrink-0">
                                                {album.firstReleaseDate && (
                                                    <span className="text-xs text-gray-500">
                                                        {album.firstReleaseDate.substring(0, 4)}
                                                    </span>
                                                )}
                                                <span className="text-xs text-gray-500 bg-white/5 px-1.5 py-0.5 rounded">
                                                    {album.primaryType}
                                                </span>
                                            </div>
                                        </div>
                                    </button>
                                ))
                            )
                        ) : (
                            <div className="p-4 text-center text-gray-400 text-sm">
                                No results found. Try a different search or paste the MBID directly.
                            </div>
                        )}
                    </div>
                )}
            </div>

            {/* Manual Entry Toggle */}
            <div>
                <button
                    type="button"
                    onClick={() => setShowManualInput(!showManualInput)}
                    className="text-xs text-gray-400 hover:text-white transition-colors"
                >
                    {showManualInput ? "Hide manual entry" : "Or paste MBID directly"}
                </button>

                {showManualInput && (
                    <div className="mt-2 flex gap-2">
                        <input
                            type="text"
                            value={manualMbid}
                            onChange={(e) => setManualMbid(e.target.value)}
                            placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                            className="flex-1 px-4 py-2 bg-[#181818] border border-white/10 rounded text-white focus:border-white/30 focus:outline-none font-mono text-xs"
                        />
                        <button
                            type="button"
                            onClick={handleManualSubmit}
                            disabled={!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(manualMbid)}
                            className="px-3 py-2 bg-[#ecb200] hover:bg-[#d4a000] disabled:bg-gray-600 disabled:cursor-not-allowed text-black rounded font-medium text-sm transition-colors flex items-center gap-1"
                        >
                            <Check className="w-4 h-4" />
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
}
