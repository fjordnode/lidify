/**
 * Image proxy safety tests.
 *
 * Run with: npx tsx src/tests/imageProxy.test.ts
 */

import assert from "assert";

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

async function run() {
    setTestEnv();

    const { normalizeExternalImageUrl, fetchExternalImage } = await import(
        "../services/imageProxy"
    );

    // normalizeExternalImageUrl blocks local/private hosts
    assert.equal(normalizeExternalImageUrl("http://127.0.0.1/secret"), null);
    assert.equal(normalizeExternalImageUrl("https://10.0.0.1/foo"), null);
    assert.equal(normalizeExternalImageUrl("ftp://example.com"), null);
    assert.ok(
        normalizeExternalImageUrl("https://example.com/image.jpg") !== null
    );

    // Redirects to private hosts should be blocked.
    let fetchCalls = 0;
    globalThis.fetch = async () => {
        fetchCalls += 1;
        return new Response(null, {
            status: 302,
            headers: { location: "http://127.0.0.1/secret" },
        });
    };

    const blocked = await fetchExternalImage({
        url: "https://example.com/image.jpg",
        cacheKeySuffix: "original",
        timeoutMs: 1000,
    });
    assert.equal(blocked.ok, false);
    if (!blocked.ok) {
        assert.equal(blocked.status, "invalid_url");
    }
    assert.equal(fetchCalls, 1);

    // Redirect loop should error after max redirects.
    let loopCount = 0;
    globalThis.fetch = async () => {
        loopCount += 1;
        return new Response(null, {
            status: 302,
            headers: { location: "https://example.com/next" },
        });
    };

    const looped = await fetchExternalImage({
        url: "https://example.com/start",
        cacheKeySuffix: "original",
        timeoutMs: 1000,
    });
    assert.equal(looped.ok, false);
    if (!looped.ok) {
        assert.equal(looped.status, "fetch_error");
        assert.equal(looped.message, "Too many redirects");
    }
    assert.equal(loopCount, 4);

    // Successful fetch returns buffer when caching is disabled.
    globalThis.fetch = async () =>
        new Response("ok", {
            status: 200,
            headers: { "content-type": "image/jpeg" },
        });

    const success = await fetchExternalImage({
        url: "https://example.com/ok.jpg",
        cacheKeySuffix: "original",
        timeoutMs: 1000,
    });
    assert.equal(success.ok, true);
    if (success.ok) {
        assert.equal(success.contentType, "image/jpeg");
        assert.equal(success.buffer.toString(), "ok");
        assert.equal(success.fromCache, false);
    }

    console.log("imageProxy tests passed");
}

run().catch((error) => {
    console.error("imageProxy tests failed:", error);
    process.exit(1);
});
