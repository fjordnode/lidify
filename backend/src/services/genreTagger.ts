import axios, { AxiosInstance } from "axios";
import { config } from "../config";
import { prisma } from "../utils/db";
import { rateLimiter } from "./rateLimiter";
import { normalizeQuotes } from "../utils/stringNormalization";
import { getSystemSettings } from "../utils/systemSettings";

type GenreTaggingStatus = {
    running: boolean;
    total: number;
    processed: number;
    success: number;
    failed: number;
    skipped: number;
    startedAt: string | null;
    finishedAt: string | null;
    currentAlbum: string | null;
    lastError: string | null;
};

type GenreTaggerOptions = {
    force?: boolean;
};

const GENRE_WHITELIST = [
    "Rock",
    "Classic Rock",
    "Hard Rock",
    "Soft Rock",
    "Alternative Rock",
    "Indie Rock",
    "Progressive Rock",
    "Psychedelic Rock",
    "Post-Rock",
    "Art Rock",
    "Arena Rock",
    "Glam Rock",
    "Stoner Rock",
    "Garage Rock",
    "Surf Rock",
    "Folk Rock",
    "Southern Rock",
    "Blues Rock",
    "Space Rock",
    "Acid Rock",
    "Math Rock",
    "Noise Rock",
    "Experimental Rock",
    "Post-Punk",
    "Punk Rock",
    "Pop Punk",
    "Hardcore Punk",
    "Anarcho Punk",
    "Street Punk",
    "Ska Punk",
    "Emo",
    "Screamo",
    "Shoegaze",
    "Grunge",
    "New Wave",
    "Goth Rock",
    "Industrial Rock",
    "Post-Hardcore",
    "Alternative",
    "Indie",
    "Punk",
    "Metal",
    "Heavy Metal",
    "Death Metal",
    "Black Metal",
    "Doom Metal",
    "Thrash Metal",
    "Progressive Metal",
    "Power Metal",
    "Symphonic Metal",
    "Melodic Death Metal",
    "Stoner Metal",
    "Sludge Metal",
    "Folk Metal",
    "Gothic Metal",
    "Metalcore",
    "Deathcore",
    "Groove Metal",
    "Industrial Metal",
    "Nu Metal",
    "Speed Metal",
    "Viking Metal",
    "Post-Metal",
    "Avant-Garde Metal",
    "Atmospheric Black Metal",
    "Technical Death Metal",
    "Brutal Death Metal",
    "Blackened Death Metal",
    "Symphonic Black Metal",
    "Melodic Black Metal",
    "Alternative Metal",
    "Rap Metal",
    "Djent",
    "Electronic",
    "House",
    "Deep House",
    "Tech House",
    "Progressive House",
    "Electro House",
    "Disco House",
    "Techno",
    "Minimal Techno",
    "Detroit Techno",
    "Acid Techno",
    "Ambient",
    "Dark Ambient",
    "Drone",
    "IDM",
    "Drum and Bass",
    "Jungle",
    "Breakbeat",
    "Big Beat",
    "Dubstep",
    "UK Garage",
    "2-Step",
    "Trance",
    "Progressive Trance",
    "Psytrance",
    "Goa Trance",
    "Hard Trance",
    "Synthwave",
    "Retrowave",
    "Vaporwave",
    "Downtempo",
    "Chillout",
    "Trip-Hop",
    "Industrial",
    "EBM",
    "Electro",
    "Electroclash",
    "Glitch",
    "Future Bass",
    "Hardstyle",
    "Hardcore",
    "Gabber",
    "Eurodance",
    "Italo Disco",
    "New Beat",
    "Chiptune",
    "Hip-Hop",
    "Rap",
    "Trap",
    "Boom Bap",
    "Conscious Hip-Hop",
    "Lo-Fi Hip-Hop",
    "Instrumental Hip-Hop",
    "Alternative Hip-Hop",
    "Underground Hip-Hop",
    "Gangsta Rap",
    "East Coast Hip-Hop",
    "West Coast Hip-Hop",
    "Southern Hip-Hop",
    "Midwest Hip-Hop",
    "Jazz Rap",
    "Cloud Rap",
    "Emo Rap",
    "UK Hip-Hop",
    "Drill",
    "Grime",
    "Jazz",
    "Bebop",
    "Hard Bop",
    "Cool Jazz",
    "Modal Jazz",
    "Free Jazz",
    "Jazz Fusion",
    "Smooth Jazz",
    "Vocal Jazz",
    "Swing",
    "Big Band",
    "Latin Jazz",
    "Blues",
    "Delta Blues",
    "Chicago Blues",
    "Country Blues",
    "Electric Blues",
    "Piedmont Blues",
    "Folk",
    "Indie Folk",
    "Singer-Songwriter",
    "Americana",
    "Bluegrass",
    "Celtic",
    "Traditional Folk",
    "Country",
    "Alt Country",
    "Outlaw Country",
    "Country Rock",
    "Country Pop",
    "Honky Tonk",
    "Classical",
    "Baroque",
    "Romantic",
    "Modern Classical",
    "Contemporary Classical",
    "Opera",
    "Choral",
    "Chamber Music",
    "Orchestral",
    "Minimalism",
    "Film Score",
    "Soundtrack",
    "Pop",
    "Synthpop",
    "Dance Pop",
    "Electropop",
    "Indie Pop",
    "Art Pop",
    "K-Pop",
    "J-Pop",
    "Teen Pop",
    "Soul",
    "R&B",
    "Rhythm and Blues",
    "Neo Soul",
    "Funk",
    "Disco",
    "Motown",
    "Gospel",
    "Reggae",
    "Dub",
    "Dancehall",
    "Ska",
    "Rocksteady",
    "Latin",
    "Latin Pop",
    "Reggaeton",
    "Salsa",
    "Bossa Nova",
    "Samba",
    "Flamenco",
    "World",
    "Afrobeat",
    "Afropop",
    "Highlife",
    "New Age",
    "Experimental",
];

const WHITELIST_KEY_MAP = new Map<string, string>();

function normalizeTagKey(tag: string): string {
    return tag
        .toLowerCase()
        .replace(/&/g, "and")
        .replace(/\+/g, "and")
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
}

for (const genre of GENRE_WHITELIST) {
    const key = normalizeTagKey(genre);
    if (!WHITELIST_KEY_MAP.has(key)) {
        WHITELIST_KEY_MAP.set(key, genre);
    }
}

const TAG_ALIASES: Record<string, string> = {
    "hip hop": "Hip-Hop",
    "hiphop": "Hip-Hop",
    "r and b": "R&B",
    "rnb": "R&B",
    "rhythm and blues": "Rhythm and Blues",
    "drum n bass": "Drum and Bass",
    "drum and bass": "Drum and Bass",
    "dnb": "Drum and Bass",
    "lofi hip hop": "Lo-Fi Hip-Hop",
    "lo fi hip hop": "Lo-Fi Hip-Hop",
    "trip hop": "Trip-Hop",
    "electronica": "Electronic",
    "synth pop": "Synthpop",
    "post punk": "Post-Punk",
    "post hardcore": "Post-Hardcore",
    "alt country": "Alt Country",
    "indie pop": "Indie Pop",
    "indie rock": "Indie Rock",
    "alternative rock": "Alternative Rock",
};

const client: AxiosInstance = axios.create({
    baseURL: "https://ws.audioscrobbler.com/2.0/",
    timeout: 10000,
});

let lastRequestAt = 0;

const progress: GenreTaggingStatus = {
    running: false,
    total: 0,
    processed: 0,
    success: 0,
    failed: 0,
    skipped: 0,
    startedAt: null,
    finishedAt: null,
    currentAlbum: null,
    lastError: null,
};

function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function ensureRateLimit() {
    const now = Date.now();
    const waitMs = Math.max(0, 200 - (now - lastRequestAt));
    if (waitMs > 0) {
        await sleep(waitMs);
    }
    lastRequestAt = Date.now();
}

async function resolveApiKey(): Promise<string | null> {
    let apiKey = config.lastfm.apiKey;

    try {
        const settings = await getSystemSettings();
        if (settings?.lastfmApiKey) {
            apiKey = settings.lastfmApiKey;
        }
    } catch {
        // Ignore settings lookup errors
    }

    if (!apiKey) {
        console.warn("Last.fm API key not configured");
        return null;
    }

    return apiKey;
}

async function lastFmRequest(params: Record<string, string>, apiKey: string) {
    await ensureRateLimit();
    const response = await rateLimiter.execute("lastfm", () =>
        client.get("/", {
            params: {
                ...params,
                api_key: apiKey,
                format: "json",
            },
        })
    );

    return response.data as any;
}

function extractTagNames(data: any): string[] {
    const rawTags =
        data?.toptags?.tag ||
        data?.tags?.tag ||
        data?.album?.toptags?.tag ||
        data?.artist?.tags?.tag ||
        [];

    if (!Array.isArray(rawTags)) {
        return [];
    }

    return rawTags
        .map((tag: any) => (typeof tag?.name === "string" ? tag.name : ""))
        .map(tag => tag.trim())
        .filter(Boolean);
}

function filterTags(tags: string[]): string[] {
    const seen = new Set<string>();
    const filtered: string[] = [];

    for (const tag of tags) {
        const normalized = normalizeTagKey(tag);
        const alias = TAG_ALIASES[normalized];
        const canonical = alias || WHITELIST_KEY_MAP.get(normalized);
        if (!canonical) continue;
        if (seen.has(canonical)) continue;
        seen.add(canonical);
        filtered.push(canonical);
    }

    return filtered;
}

async function getAlbumTopTags(
    apiKey: string,
    artistName: string,
    albumTitle: string
): Promise<string[]> {
    const data = await lastFmRequest(
        {
            method: "album.getTopTags",
            artist: normalizeQuotes(artistName),
            album: normalizeQuotes(albumTitle),
        },
        apiKey
    );

    return extractTagNames(data);
}

async function getArtistTopTags(
    apiKey: string,
    artistName: string
): Promise<string[]> {
    const data = await lastFmRequest(
        {
            method: "artist.getTopTags",
            artist: normalizeQuotes(artistName),
        },
        apiKey
    );

    return extractTagNames(data);
}

async function runGenreTagging(options: GenreTaggerOptions = {}) {
    const apiKey = await resolveApiKey();
    if (!apiKey) {
        progress.running = false;
        progress.lastError = "Last.fm API key not configured";
        return;
    }

    const albums = await prisma.album.findMany({
        select: {
            id: true,
            title: true,
            genres: true,
            artist: {
                select: {
                    name: true,
                },
            },
        },
    });

    progress.total = albums.length;
    progress.processed = 0;
    progress.success = 0;
    progress.failed = 0;
    progress.skipped = 0;
    progress.lastError = null;

    console.log(`[GENRE TAGGER] Starting tagging for ${albums.length} albums...`);

    for (const album of albums) {
        if (
            !options.force &&
            Array.isArray(album.genres) &&
            album.genres.length > 0
        ) {
            progress.skipped++;
            progress.processed++;
            continue;
        }

        const label = `${album.artist.name} - ${album.title}`;
        progress.currentAlbum = label;

        try {
            let tags = await getAlbumTopTags(
                apiKey,
                album.artist.name,
                album.title
            );
            let filtered = filterTags(tags);

            if (filtered.length === 0) {
                tags = await getArtistTopTags(apiKey, album.artist.name);
                filtered = filterTags(tags);
            }

            await prisma.album.update({
                where: { id: album.id },
                data: { genres: filtered },
            });

            progress.success++;
            if (filtered.length > 0) {
                console.log(
                    `[GENRE TAGGER] ✓ ${label} → ${filtered.join(", ")}`
                );
            } else {
                console.log(`[GENRE TAGGER] · ${label} → (no matches)`);
            }
        } catch (error: any) {
            progress.failed++;
            const message = error?.message || String(error);
            progress.lastError = message;
            console.error(`[GENRE TAGGER] ✗ ${label}:`, message);
        }

        progress.processed++;

        if (progress.processed % 25 === 0) {
            console.log(
                `[GENRE TAGGER] Progress: ${progress.processed}/${progress.total} processed`
            );
        }
    }

    progress.running = false;
    progress.currentAlbum = null;
    progress.finishedAt = new Date().toISOString();

    console.log(
        `[GENRE TAGGER] Complete: ${progress.success} updated, ${progress.skipped} skipped, ${progress.failed} failed`
    );
}

export function startGenreTagging(options: GenreTaggerOptions = {}) {
    if (progress.running) {
        return progress;
    }

    progress.running = true;
    progress.startedAt = new Date().toISOString();
    progress.finishedAt = null;
    progress.currentAlbum = null;
    progress.lastError = null;

    runGenreTagging(options).catch(error => {
        progress.running = false;
        progress.lastError = error?.message || String(error);
        progress.finishedAt = new Date().toISOString();
        console.error("[GENRE TAGGER] Background job failed:", error);
    });

    return progress;
}

export function getGenreTaggingStatus() {
    return progress;
}
