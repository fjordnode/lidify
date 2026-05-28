/**
 * Music scanner fileStorage and partial-scan cleanup regression tests.
 *
 * Run with: npx tsx src/tests/musicScannerFileStorage.test.ts
 */

import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";

function setTestEnv() {
    process.env.NODE_ENV = "test";
    process.env.DATABASE_URL =
        process.env.DATABASE_URL || "postgres://user:pass@localhost:5432/db";
    process.env.REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
    process.env.SESSION_SECRET =
        process.env.SESSION_SECRET || "test-secret-32-characters-long!!";
    process.env.IMAGE_CACHE_MAX_GB = process.env.IMAGE_CACHE_MAX_GB || "0";
}

type ArtistRow = {
    id: string;
    name: string;
    normalizedName: string;
    mbid: string;
    enrichmentStatus?: string;
    lastSynced?: Date;
};

type AlbumRow = {
    id: string;
    title: string;
    artistId: string;
    rgMbid: string;
    location: "LIBRARY" | "DISCOVER";
    genres?: string[];
    year?: number | null;
    coverUrl?: string | null;
};

type TrackRow = {
    id: string;
    albumId: string;
    title: string;
    trackNo: number;
    discNo: number;
    duration: number;
    mime?: string;
    filePath: string;
    fileStorage: string;
    fileModified: Date;
    fileSize: number;
};

type OwnedAlbumRow = {
    artistId: string;
    rgMbid: string;
    source: string;
};

const state: {
    downloadPath: string;
    artists: ArtistRow[];
    albums: AlbumRow[];
    tracks: TrackRow[];
    ownedAlbums: OwnedAlbumRow[];
    deletedTrackIds: string[];
    trackFindManyWheres: any[];
} = {
    downloadPath: "",
    artists: [],
    albums: [],
    tracks: [],
    ownedAlbums: [],
    deletedTrackIds: [],
    trackFindManyWheres: [],
};

let idCounter = 0;

function normalizeArtistName(value: string) {
    return value.toLowerCase().trim();
}

function resetState(downloadPath: string) {
    state.downloadPath = downloadPath;
    state.artists = [];
    state.albums = [];
    state.tracks = [];
    state.ownedAlbums = [];
    state.deletedTrackIds = [];
    state.trackFindManyWheres = [];
    idCounter = 0;
}

function nextId(prefix: string) {
    idCounter += 1;
    return `${prefix}-${idCounter}`;
}

function createAudioFile(root: string, relativePath: string) {
    const absolutePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, "scanner test fixture");
    return absolutePath;
}

function seedArtist(name: string): ArtistRow {
    const artist = {
        id: nextId("artist"),
        name,
        normalizedName: normalizeArtistName(name),
        mbid: `temp-${nextId("mbid")}`,
        enrichmentStatus: "pending",
    };
    state.artists.push(artist);
    return artist;
}

function seedAlbum(artistId: string, title: string): AlbumRow {
    const album = {
        id: nextId("album"),
        title,
        artistId,
        rgMbid: `temp-${nextId("rg")}`,
        location: "LIBRARY" as const,
        genres: [],
        year: null,
        coverUrl: null,
    };
    state.albums.push(album);
    return album;
}

function seedTrack(albumId: string, fileStorage: string, filePath: string): TrackRow {
    const track = {
        id: nextId("track"),
        albumId,
        title: path.basename(filePath, path.extname(filePath)),
        trackNo: 1,
        discNo: 1,
        duration: 123,
        mime: "audio/mpeg",
        filePath,
        fileStorage,
        fileModified: new Date(0),
        fileSize: 123,
    };
    state.tracks.push(track);
    return track;
}

function installPrismaMocks(prisma: any) {
    prisma.systemSettings.findFirst = async () => ({
        downloadPath: state.downloadPath,
    });

    prisma.downloadJob.findMany = async () => [];
    prisma.discoveryAlbum.findFirst = async () => null;

    prisma.artist.findFirst = async (args: any = {}) => {
        const where = args.where || {};
        if (where.normalizedName) {
            if (typeof where.normalizedName === "string") {
                return (
                    state.artists.find(
                        (artist) => artist.normalizedName === where.normalizedName
                    ) || null
                );
            }
            if (where.normalizedName.startsWith) {
                return (
                    state.artists.find((artist) =>
                        artist.normalizedName.startsWith(where.normalizedName.startsWith)
                    ) || null
                );
            }
        }
        if (where.mbid?.startsWith) {
            return (
                state.artists.find((artist) =>
                    artist.mbid.startsWith(where.mbid.startsWith)
                ) || null
            );
        }
        if (where.name?.equals) {
            return (
                state.artists.find(
                    (artist) =>
                        artist.name.toLowerCase() === where.name.equals.toLowerCase()
                ) || null
            );
        }
        return null;
    };

    prisma.artist.findMany = async (args: any = {}) => {
        const startsWith = args.where?.normalizedName?.startsWith;
        if (startsWith) {
            return state.artists.filter((artist) =>
                artist.normalizedName.startsWith(startsWith)
            );
        }
        return [];
    };

    prisma.artist.findUnique = async (args: any) => {
        if (args.where?.id) {
            return state.artists.find((artist) => artist.id === args.where.id) || null;
        }
        if (args.where?.mbid) {
            return (
                state.artists.find((artist) => artist.mbid === args.where.mbid) || null
            );
        }
        return null;
    };

    prisma.artist.create = async (args: any) => {
        const artist = { id: nextId("artist"), ...args.data };
        state.artists.push(artist);
        return artist;
    };

    prisma.artist.update = async (args: any) => {
        const artist = state.artists.find((row) => row.id === args.where.id);
        assert.ok(artist, "Expected artist update target to exist");
        Object.assign(artist, args.data);
        return artist;
    };

    prisma.artist.deleteMany = async () => ({ count: 0 });

    prisma.album.findFirst = async (args: any = {}) => {
        const where = args.where || {};
        if (where.artistId && where.title) {
            return (
                state.albums.find(
                    (album) =>
                        album.artistId === where.artistId && album.title === where.title
                ) || null
            );
        }
        if (where.artist?.name?.equals && where.location) {
            const artist = state.artists.find(
                (row) =>
                    row.name.toLowerCase() === where.artist.name.equals.toLowerCase()
            );
            return artist
                ? state.albums.find(
                      (album) =>
                          album.artistId === artist.id && album.location === where.location
                  ) || null
                : null;
        }
        return null;
    };

    prisma.album.findUnique = async (args: any) => {
        if (args.where?.id) {
            return state.albums.find((album) => album.id === args.where.id) || null;
        }
        if (args.where?.rgMbid) {
            return (
                state.albums.find((album) => album.rgMbid === args.where.rgMbid) ||
                null
            );
        }
        return null;
    };

    prisma.album.findMany = async () => [];

    prisma.album.create = async (args: any) => {
        const album = { id: nextId("album"), coverUrl: null, ...args.data };
        state.albums.push(album);
        return album;
    };

    prisma.album.update = async (args: any) => {
        const album = state.albums.find((row) => row.id === args.where.id);
        assert.ok(album, "Expected album update target to exist");
        Object.assign(album, args.data);
        return album;
    };

    prisma.album.deleteMany = async () => ({ count: 0 });

    prisma.ownedAlbum.updateMany = async () => ({ count: 0 });
    prisma.ownedAlbum.upsert = async (args: any) => {
        const key = args.where.artistId_rgMbid;
        const existing = state.ownedAlbums.find(
            (row) => row.artistId === key.artistId && row.rgMbid === key.rgMbid
        );
        if (existing) {
            Object.assign(existing, args.update);
            return existing;
        }
        state.ownedAlbums.push(args.create);
        return args.create;
    };

    prisma.track.findMany = async (args: any = {}) => {
        state.trackFindManyWheres.push(args.where);
        return state.tracks
            .filter(
                (track) =>
                    !args.where?.fileStorage || track.fileStorage === args.where.fileStorage
            )
            .map((track) => ({
                ...track,
                album: {
                    artistId:
                        state.albums.find((album) => album.id === track.albumId)
                            ?.artistId || "unknown",
                },
            }));
    };

    prisma.track.findFirst = async (args: any = {}) => {
        const where = args.where || {};
        return (
            state.tracks.find(
                (track) =>
                    track.albumId === where.albumId && track.title === where.title
            ) || null
        );
    };

    prisma.track.upsert = async (args: any) => {
        const key = args.where.fileStorage_filePath;
        const existing = state.tracks.find(
            (track) =>
                track.fileStorage === key.fileStorage && track.filePath === key.filePath
        );
        if (existing) {
            Object.assign(existing, args.update);
            return existing;
        }
        const created = { id: nextId("track"), ...args.create };
        state.tracks.push(created);
        return created;
    };

    prisma.track.deleteMany = async (args: any) => {
        const ids = new Set(args.where.id.in as string[]);
        state.deletedTrackIds.push(...ids);
        const before = state.tracks.length;
        state.tracks = state.tracks.filter((track) => !ids.has(track.id));
        return { count: before - state.tracks.length };
    };
}

function createScanner(MusicScannerService: any, playlistOnlyMode = false) {
    const scanner = new MusicScannerService(undefined, undefined, playlistOnlyMode);

    (scanner as any).processAudioFile = async (
        absolutePath: string,
        relativePath: string,
        basePathForDb: string
    ) => {
        const normalizedPath = relativePath.replace(/\\/g, "/");
        const parts = normalizedPath.split("/");
        const isPlaylistPath = parts[0]?.toLowerCase() === "playlists";
        const artistName = isPlaylistPath ? parts[1] : parts[0];
        const albumTitle = isPlaylistPath ? parts[2] : parts[1];
        const title = path.basename(absolutePath, path.extname(absolutePath));
        const normalizedArtistName = normalizeArtistName(artistName);

        let artist = state.artists.find(
            (row) => row.normalizedName === normalizedArtistName
        );
        if (!artist) {
            artist = {
                id: nextId("artist"),
                name: artistName,
                normalizedName: normalizedArtistName,
                mbid: `temp-${nextId("mbid")}`,
                enrichmentStatus: "pending",
            };
            state.artists.push(artist);
        }

        const shouldBeHiddenFromLibrary =
            playlistOnlyMode ||
            isPlaylistPath ||
            normalizedPath.toLowerCase().startsWith("discovery/") ||
            normalizedPath.toLowerCase().startsWith("discover/");

        let album = state.albums.find(
            (row) => row.artistId === artist!.id && row.title === albumTitle
        );
        if (!album) {
            album = {
                id: nextId("album"),
                title: albumTitle,
                artistId: artist.id,
                rgMbid: `temp-${nextId("rg")}`,
                location: shouldBeHiddenFromLibrary ? "DISCOVER" : "LIBRARY",
                genres: [],
                year: null,
                coverUrl: null,
            };
            state.albums.push(album);
        } else if (!shouldBeHiddenFromLibrary && album.location !== "LIBRARY") {
            album.location = "LIBRARY";
        }

        if (!shouldBeHiddenFromLibrary) {
            const existingOwned = state.ownedAlbums.find(
                (row) =>
                    row.artistId === artist!.id && row.rgMbid === album!.rgMbid
            );
            if (!existingOwned) {
                state.ownedAlbums.push({
                    artistId: artist.id,
                    rgMbid: album.rgMbid,
                    source: "native_scan",
                });
            }
        }

        const stats = fs.statSync(absolutePath);
        const fileStorage =
            path.resolve(basePathForDb) === path.resolve(state.downloadPath)
                ? "download"
                : "music";
        const existingTrack = state.tracks.find(
            (track) =>
                track.fileStorage === fileStorage && track.filePath === normalizedPath
        );
        if (existingTrack) {
            Object.assign(existingTrack, {
                albumId: album.id,
                title,
                fileModified: stats.mtime,
                fileSize: stats.size,
            });
        } else {
            state.tracks.push({
                id: nextId("track"),
                albumId: album.id,
                title,
                trackNo: 1,
                discNo: 1,
                duration: 123,
                mime: "audio/mpeg",
                filePath: normalizedPath,
                fileStorage,
                fileModified: stats.mtime,
                fileSize: stats.size,
            });
        }

        return artist.id;
    };

    return scanner;
}

async function run() {
    setTestEnv();

    const root = path.join(
        os.tmpdir(),
        `lidify-scanner-file-storage-${process.pid}-${Date.now()}`
    );
    const musicRoot = path.join(root, "music");
    const downloadRoot = path.join(root, "downloads");
    fs.mkdirSync(musicRoot, { recursive: true });
    fs.mkdirSync(downloadRoot, { recursive: true });
    process.env.MUSIC_PATH = musicRoot;
    process.env.TRANSCODE_CACHE_PATH = path.join(root, "transcodes");

    const { prisma } = await import("../utils/db");
    const { MusicScannerService } = await import("../services/musicScanner");

    installPrismaMocks(prisma as any);

    // Full music-root scans can remove missing music tracks, but only in music storage.
    resetState(downloadRoot);
    const artist = seedArtist("Existing Artist");
    const album = seedAlbum(artist.id, "Existing Album");
    createAudioFile(musicRoot, "Existing Artist/Existing Album/Present.mp3");
    seedTrack(
        album.id,
        "music",
        "Existing Artist/Existing Album/Present.mp3"
    );
    const missingMusicTrack = seedTrack(
        album.id,
        "music",
        "Existing Artist/Existing Album/Missing.mp3"
    );
    const matchingDownloadTrack = seedTrack(
        album.id,
        "download",
        "Existing Artist/Existing Album/Missing.mp3"
    );

    const fullScan = await createScanner(MusicScannerService).scanLibrary(
        musicRoot,
        musicRoot
    );
    assert.equal(fullScan.tracksRemoved, 1);
    assert.deepEqual(state.deletedTrackIds, [missingMusicTrack.id]);
    assert.ok(
        state.tracks.some((track) => track.id === matchingDownloadTrack.id),
        "Download-storage track with the same relative path should be preserved"
    );
    assert.deepEqual(state.trackFindManyWheres[0], { fileStorage: "music" });

    // Sparse full-root scans with existing tracks look like a down or partially
    // mounted network library and must not mass-delete the library.
    const sparseMusicRoot = path.join(root, "sparse-music-mount");
    fs.mkdirSync(sparseMusicRoot, { recursive: true });
    resetState(downloadRoot);
    const mountArtist = seedArtist("Mounted Artist");
    const mountAlbum = seedAlbum(mountArtist.id, "Mounted Album");
    createAudioFile(sparseMusicRoot, "Mounted Artist/Mounted Album/Track 1.mp3");
    const mountedTracks = Array.from({ length: 10 }, (_, index) =>
        seedTrack(
            mountAlbum.id,
            "music",
            `Mounted Artist/Mounted Album/Track ${index + 1}.mp3`
        )
    );

    const sparseMountScan = await createScanner(MusicScannerService).scanLibrary(
        sparseMusicRoot,
        sparseMusicRoot
    );
    assert.equal(sparseMountScan.tracksRemoved, 0);
    assert.deepEqual(state.deletedTrackIds, []);
    assert.ok(
        mountedTracks.every((mountedTrack) =>
            state.tracks.some((track) => track.id === mountedTrack.id)
        ),
        "Sparse full-root scan should preserve existing tracks"
    );
    assert.ok(
        sparseMountScan.errors.some((error: { error: string }) =>
            error.error.includes("skipping orphan cleanup")
        ),
        "Sparse full-root scan should report skipped cleanup warning"
    );

    // Partial music scans must not remove unrelated music tracks.
    resetState(downloadRoot);
    const partialArtist = seedArtist("Other Artist");
    const partialAlbum = seedAlbum(partialArtist.id, "Other Album");
    seedTrack(partialAlbum.id, "music", "Other Artist/Other Album/Other.mp3");
    createAudioFile(musicRoot, "New Artist/New Album/New Song.mp3");

    const partialMusicScan = await createScanner(MusicScannerService).scanLibrary(
        path.join(musicRoot, "New Artist", "New Album"),
        musicRoot
    );
    assert.equal(partialMusicScan.tracksRemoved, 0);
    assert.deepEqual(state.deletedTrackIds, []);

    // Partial direct-download scans add download-storage tracks as owned library content
    // without deleting unrelated download-storage tracks.
    resetState(downloadRoot);
    const downloadArtist = seedArtist("Download Artist");
    const downloadAlbum = seedAlbum(downloadArtist.id, "Old Album");
    seedTrack(downloadAlbum.id, "download", "Download Artist/Old Album/Old.mp3");
    createAudioFile(downloadRoot, "Download Artist/New Album/New.mp3");

    const directDownloadScan = await createScanner(
        MusicScannerService,
        false
    ).scanLibrary(path.join(downloadRoot, "Download Artist", "New Album"), downloadRoot);
    assert.equal(directDownloadScan.tracksRemoved, 0);
    assert.deepEqual(state.deletedTrackIds, []);
    assert.ok(
        state.tracks.some(
            (track) =>
                track.fileStorage === "download" &&
                track.filePath === "Download Artist/New Album/New.mp3"
        ),
        "Direct download scan should store new track in download storage"
    );
    const newDownloadAlbum = state.albums.find(
        (row) => row.title === "New Album"
    );
    assert.equal(newDownloadAlbum?.location, "LIBRARY");
    assert.equal(state.ownedAlbums.length, 1);

    // Playlist-only scans keep imported tracks hidden from owned library views.
    resetState(downloadRoot);
    createAudioFile(downloadRoot, "Playlists/Playlist Artist/Playlist Album/Track.mp3");

    const playlistScan = await createScanner(
        MusicScannerService,
        true
    ).scanLibrary(path.join(downloadRoot, "Playlists"), downloadRoot);
    assert.equal(playlistScan.tracksRemoved, 0);
    const playlistAlbum = state.albums.find(
        (row) => row.title === "Playlist Album"
    );
    assert.equal(playlistAlbum?.location, "DISCOVER");
    assert.equal(state.ownedAlbums.length, 0);

    console.log("musicScannerFileStorage tests passed");
    process.exit(0);
}

run().catch((error) => {
    console.error("musicScannerFileStorage tests failed:", error);
    process.exit(1);
});
