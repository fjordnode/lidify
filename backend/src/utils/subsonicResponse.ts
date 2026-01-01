/**
 * Subsonic API Response Utilities
 *
 * Formats responses in Subsonic/OpenSubsonic format.
 * Supports both XML (default) and JSON output.
 */

import { Response } from "express";

// Subsonic API version we're implementing
export const SUBSONIC_API_VERSION = "1.16.1";
export const LIDIFY_SERVER_VERSION = "1.0.0";

// Subsonic error codes
export enum SubsonicErrorCode {
    GENERIC = 0,
    MISSING_PARAMETER = 10,
    CLIENT_VERSION_MISMATCH = 20,
    SERVER_VERSION_MISMATCH = 30,
    WRONG_CREDENTIALS = 40,
    TOKEN_AUTH_NOT_SUPPORTED = 41,
    NOT_AUTHORIZED = 50,
    TRIAL_EXPIRED = 60,
    NOT_FOUND = 70,
}

type ResponseFormat = "xml" | "json" | "jsonp";

interface SubsonicRequest {
    format?: string;
    f?: string;
    callback?: string; // For JSONP
}

/**
 * Determine response format from request query params
 */
export function getResponseFormat(query: SubsonicRequest): ResponseFormat {
    const format = query.format || query.f || "xml";
    if (format === "json") return "json";
    if (format === "jsonp") return "jsonp";
    return "xml";
}

/**
 * Convert a JavaScript object to XML string
 */
function objectToXml(obj: any, rootName?: string): string {
    if (obj === null || obj === undefined) {
        return "";
    }

    if (Array.isArray(obj)) {
        return obj.map(item => objectToXml(item, rootName)).join("");
    }

    if (typeof obj !== "object") {
        return escapeXml(String(obj));
    }

    const entries = Object.entries(obj);
    const attributes: string[] = [];
    const children: string[] = [];

    for (const [key, value] of entries) {
        if (value === null || value === undefined) continue;

        if (Array.isArray(value)) {
            // Arrays become repeated elements
            for (const item of value) {
                if (typeof item === "object" && item !== null) {
                    children.push(objectToXml(item, key));
                } else {
                    children.push(`<${key}>${escapeXml(String(item))}</${key}>`);
                }
            }
        } else if (typeof value === "object") {
            // Nested objects become child elements
            children.push(objectToXml(value, key));
        } else {
            // Primitives become attributes
            attributes.push(`${key}="${escapeXml(String(value))}"`);
        }
    }

    if (!rootName) {
        return children.join("");
    }

    const attrStr = attributes.length > 0 ? " " + attributes.join(" ") : "";

    if (children.length === 0) {
        return `<${rootName}${attrStr}/>`;
    }

    return `<${rootName}${attrStr}>${children.join("")}</${rootName}>`;
}

/**
 * Escape special XML characters
 */
function escapeXml(str: string): string {
    return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}

/**
 * Build the subsonic-response wrapper
 */
function buildResponseWrapper(status: "ok" | "failed", content: object = {}): object {
    return {
        "subsonic-response": {
            status,
            version: SUBSONIC_API_VERSION,
            type: "lidify",
            serverVersion: LIDIFY_SERVER_VERSION,
            openSubsonic: true,
            ...content,
        },
    };
}

/**
 * Send a successful Subsonic response
 */
export function sendSubsonicSuccess(
    res: Response,
    data: object,
    format: ResponseFormat,
    callback?: string
): void {
    const wrapper = buildResponseWrapper("ok", data);

    if (format === "json" || format === "jsonp") {
        const json = JSON.stringify(wrapper);
        if (format === "jsonp" && callback) {
            res.type("application/javascript");
            res.send(`${callback}(${json})`);
        } else {
            res.type("application/json");
            res.send(json);
        }
    } else {
        // XML format
        const xmlContent = objectToXml(wrapper["subsonic-response"], "subsonic-response");
        const xml = `<?xml version="1.0" encoding="UTF-8"?>\n${xmlContent}`;
        res.type("application/xml");
        res.send(xml);
    }
}

/**
 * Send a Subsonic error response
 */
export function sendSubsonicError(
    res: Response,
    code: SubsonicErrorCode,
    message: string,
    format: ResponseFormat,
    callback?: string
): void {
    const wrapper = buildResponseWrapper("failed", {
        error: {
            code,
            message,
        },
    });

    // Subsonic API ALWAYS returns HTTP 200, even for errors
    // The error is communicated via the response body status="failed"
    // Some clients (like Symfonium) get confused by non-200 status codes
    res.status(200);

    if (format === "json" || format === "jsonp") {
        const json = JSON.stringify(wrapper);
        if (format === "jsonp" && callback) {
            res.type("application/javascript");
            res.send(`${callback}(${json})`);
        } else {
            res.type("application/json");
            res.send(json);
        }
    } else {
        const xmlContent = objectToXml(wrapper["subsonic-response"], "subsonic-response");
        const xml = `<?xml version="1.0" encoding="UTF-8"?>\n${xmlContent}`;
        res.type("application/xml");
        res.send(xml);
    }
}

/**
 * Helper to format a track for Subsonic response
 */
export function formatTrackForSubsonic(track: {
    id: string;
    title: string;
    trackNo: number;
    duration: number;
    filePath: string;
    fileSize: number;
    album: {
        id: string;
        title: string;
        coverUrl?: string | null;
        year?: number | null;
        artist: {
            id: string;
            name: string;
        };
    };
}, playData?: { played?: Date; playCount?: number }): object {
    const ext = track.filePath.split(".").pop()?.toLowerCase() || "mp3";
    const contentType = getContentType(ext);

    return {
        id: `tr-${track.id}`,
        parent: `al-${track.album.id}`,
        isDir: false,
        title: track.title,
        album: track.album.title,
        artist: track.album.artist.name,
        track: track.trackNo,
        year: track.album.year || undefined,
        coverArt: track.album.coverUrl ? `al-${track.album.id}` : undefined,
        size: track.fileSize,
        contentType,
        suffix: ext,
        duration: track.duration,
        bitRate: 320, // We don't store this, assume high quality
        path: track.filePath,
        albumId: `al-${track.album.id}`,
        artistId: `ar-${track.album.artist.id}`,
        type: "music",
        played: playData?.played?.toISOString(),
        playCount: playData?.playCount ?? 0,
    };
}

/**
 * Helper to format an album for Subsonic response
 */
export function formatAlbumForSubsonic(album: {
    id: string;
    title: string;
    year?: number | null;
    coverUrl?: string | null;
    artist: {
        id: string;
        name: string;
    };
    tracks?: any[];
    _count?: { tracks: number };
}): object {
    return {
        id: `al-${album.id}`,
        parent: `ar-${album.artist.id}`,
        isDir: true,
        title: album.title,
        name: album.title,
        album: album.title,
        artist: album.artist.name,
        year: album.year || undefined,
        coverArt: album.coverUrl ? `al-${album.id}` : undefined,
        songCount: album._count?.tracks || album.tracks?.length || 0,
        duration: album.tracks?.reduce((sum, t) => sum + (t.duration || 0), 0) || 0,
        artistId: `ar-${album.artist.id}`,
    };
}

/**
 * Helper to format an artist for Subsonic response
 */
export function formatArtistForSubsonic(artist: {
    id: string;
    name: string;
    heroUrl?: string | null;
    _count?: { albums: number };
    albums?: any[];
}): object {
    return {
        id: `ar-${artist.id}`,
        name: artist.name,
        coverArt: artist.heroUrl ? `ar-${artist.id}` : undefined,
        albumCount: artist._count?.albums || artist.albums?.length || 0,
        artistImageUrl: artist.heroUrl || undefined,
    };
}

/**
 * Parse a Subsonic ID to get type and internal ID
 */
export function parseSubsonicId(subsonicId: string): { type: "artist" | "album" | "track" | "playlist" | "unknown"; id: string } {
    if (subsonicId.startsWith("ar-")) {
        return { type: "artist", id: subsonicId.substring(3) };
    }
    if (subsonicId.startsWith("al-")) {
        return { type: "album", id: subsonicId.substring(3) };
    }
    if (subsonicId.startsWith("tr-")) {
        return { type: "track", id: subsonicId.substring(3) };
    }
    if (subsonicId.startsWith("pl-")) {
        return { type: "playlist", id: subsonicId.substring(3) };
    }
    // Fallback: assume it's already a raw ID
    return { type: "unknown", id: subsonicId };
}

/**
 * Get content type from file extension
 */
function getContentType(ext: string): string {
    const types: Record<string, string> = {
        mp3: "audio/mpeg",
        flac: "audio/flac",
        m4a: "audio/mp4",
        aac: "audio/aac",
        ogg: "audio/ogg",
        opus: "audio/opus",
        wav: "audio/wav",
        wma: "audio/x-ms-wma",
    };
    return types[ext] || "audio/mpeg";
}
