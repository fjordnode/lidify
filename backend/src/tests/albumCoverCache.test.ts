/**
 * Album cover cache behavior tests.
 *
 * Run with: npx tsx src/tests/albumCoverCache.test.ts
 */

import assert from "assert";
import express from "express";

function setTestEnv() {
    process.env.NODE_ENV = "test";
    process.env.DATABASE_URL =
        process.env.DATABASE_URL || "postgres://user:pass@localhost:5432/db";
    process.env.REDIS_URL =
        process.env.REDIS_URL || "redis://localhost:6379";
    process.env.SESSION_SECRET =
        process.env.SESSION_SECRET || "test-secret-32-characters-long!!";
    process.env.MUSIC_PATH = process.env.MUSIC_PATH || "/tmp";
    process.env.IMAGE_CACHE_MAX_GB =
        process.env.IMAGE_CACHE_MAX_GB || "0";
    process.env.TRANSCODE_CACHE_PATH =
        process.env.TRANSCODE_CACHE_PATH || "/tmp/transcodes";
}

type RedisValue = string;

async function run() {
    setTestEnv();

    const { redisClient } = await import("../utils/redis");
    const { prisma } = await import("../utils/db");
    const { imageProviderService } = await import("../services/imageProvider");
    const { coverArtService } = await import("../services/coverArt");
    const { generateToken } = await import("../middleware/auth");
    const libraryRouter = (await import("../routes/library")).default;

    const redisStore = new Map<string, RedisValue>();
    redisClient.get = async (key: string) => redisStore.get(key) ?? null;
    redisClient.setEx = async (key: string, _ttl: number, value: string) => {
        redisStore.set(key, value);
        return "OK";
    };

    const user = { id: "user-1", username: "test", role: "admin" };
    const token = generateToken(user);
    prisma.user.findUnique = async () => user as any;

    const app = express();
    app.use("/library", libraryRouter);
    const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
        const instance = app.listen(0, () => resolve(instance));
    });
    const address = server.address();
    if (!address || typeof address === "string") {
        throw new Error("Failed to bind test server");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    let providerCalls = 0;
    let coverArtCalls = 0;

    imageProviderService.getAlbumCover = async () => {
        providerCalls += 1;
        return { url: "https://example.com/provider.jpg", source: "test" } as any;
    };
    coverArtService.getCoverArt = async () => {
        coverArtCalls += 1;
        return "https://example.com/caa.jpg";
    };

    let success = false;
    try {
        // Case 1: DB cover overrides negative cache.
        redisStore.set("caa:test-mbid-1", "NOT_FOUND");
        redisStore.set("album-cover-url:test-mbid-1", "NOT_FOUND");
        prisma.album.findFirst = async () =>
            ({ coverUrl: "https://example.com/db.jpg" } as any);
        prisma.album.updateMany = async () => ({ count: 1 } as any);

        const res1 = await fetch(
            `${baseUrl}/library/album-cover/test-mbid-1?json=true&artist=Artist&album=Album&token=${token}`
        );
        const data1 = await res1.json();
        assert.equal(res1.status, 200);
        assert.ok(
            data1.coverUrl.includes("/api/library/cover-art?url="),
            "Expected proxied cover art URL"
        );
        assert.equal(providerCalls, 0);
        assert.equal(coverArtCalls, 0);
        assert.equal(redisStore.get("caa:test-mbid-1"), "https://example.com/db.jpg");
        assert.equal(
            redisStore.get("album-cover-url:test-mbid-1"),
            "https://example.com/db.jpg"
        );

        // Case 2: Negative cache does not block when metadata is provided.
        redisStore.set("caa:test-mbid-2", "NOT_FOUND");
        redisStore.set("album-cover-url:test-mbid-2", "NOT_FOUND");
        prisma.album.findFirst = async () => null as any;
        providerCalls = 0;
        coverArtCalls = 0;

        const res2 = await fetch(
            `${baseUrl}/library/album-cover/test-mbid-2?json=true&artist=Artist&album=Album&token=${token}`
        );
        const data2 = await res2.json();
        assert.equal(res2.status, 200);
        assert.ok(data2.coverUrl.includes("https%3A%2F%2Fexample.com%2Fprovider.jpg"));
        assert.equal(providerCalls, 1);
        assert.equal(coverArtCalls, 0);
        assert.equal(redisStore.get("caa:test-mbid-2"), "https://example.com/provider.jpg");

        // Case 3: Negative cache blocks lookup when metadata is missing.
        redisStore.set("caa:test-mbid-3", "NOT_FOUND");
        redisStore.set("album-cover-url:test-mbid-3", "NOT_FOUND");
        providerCalls = 0;
        coverArtCalls = 0;

        const res3 = await fetch(
            `${baseUrl}/library/album-cover/test-mbid-3?token=${token}`
        );
        assert.equal(res3.status, 204);
        assert.equal(providerCalls, 0);
        assert.equal(coverArtCalls, 0);

        console.log("albumCoverCache tests passed");
        success = true;
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        try {
            redisClient.disconnect();
        } catch {
            // Ignore shutdown errors
        }
        if (success) {
            process.exit(0);
        }
    }
}

run().catch((error) => {
    console.error("albumCoverCache tests failed:", error);
    process.exit(1);
});
