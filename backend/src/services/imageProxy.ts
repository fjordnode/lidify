import crypto from "crypto";
import fs from "fs";
import path from "path";
import { config } from "../config";

const NOT_FOUND_TTL = 60 * 60; // 1 hour

export const normalizeExternalImageUrl = (rawUrl: string): string | null => {
    try {
        const parsedUrl = new URL(rawUrl);
        const hostname = parsedUrl.hostname.toLowerCase();

        if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
            return null;
        }

        if (
            hostname === "localhost" ||
            hostname === "127.0.0.1" ||
            hostname === "::1" ||
            hostname === "0.0.0.0" ||
            hostname.startsWith("10.") ||
            hostname.startsWith("192.168.") ||
            hostname.startsWith("169.254.") ||
            hostname.match(/^172\.(1[6-9]|2[0-9]|3[0-1])\./) ||
            hostname.endsWith(".local") ||
            hostname.endsWith(".internal")
        ) {
            return null;
        }

        return parsedUrl.toString();
    } catch {
        return null;
    }
};

type CachedImageMeta = {
    etag: string;
    contentType: string | null;
};

export type ExternalImageResult =
    | {
          ok: true;
          url: string;
          buffer: Buffer;
          contentType: string | null;
          etag: string;
          fromCache: boolean;
      }
    | {
          ok: false;
          url: string;
          status: "invalid_url" | "not_found" | "fetch_error";
          message?: string;
      };

export async function fetchExternalImage(options: {
    url: string;
    cacheKeySuffix: string;
    timeoutMs?: number;
}): Promise<ExternalImageResult> {
    const { url, cacheKeySuffix, timeoutMs = 20000 } = options;
    const safeUrl = normalizeExternalImageUrl(url);
    if (!safeUrl) {
        return {
            ok: false,
            url,
            status: "invalid_url",
            message: "Invalid or private URL",
        };
    }

    const cacheKey = crypto
        .createHash("md5")
        .update(`${safeUrl}-${cacheKeySuffix}`)
        .digest("hex");
    const cacheDir = path.join(
        config.music.transcodeCachePath,
        "../covers",
        "external"
    );
    const imagePath = path.join(cacheDir, `${cacheKey}.bin`);
    const metaPath = path.join(cacheDir, `${cacheKey}.json`);
    const missingPath = path.join(cacheDir, `${cacheKey}.missing`);

    try {
        fs.mkdirSync(cacheDir, { recursive: true });
    } catch {
        // Directory creation errors are non-fatal here
    }

    try {
        if (fs.existsSync(missingPath)) {
            const stats = fs.statSync(missingPath);
            const ageSeconds = (Date.now() - stats.mtimeMs) / 1000;
            if (ageSeconds < NOT_FOUND_TTL) {
                return { ok: false, url: safeUrl, status: "not_found" };
            }
        }
    } catch {
        // Missing cache errors are non-critical
    }

    if (fs.existsSync(imagePath)) {
        let meta: CachedImageMeta | null = null;
        if (fs.existsSync(metaPath)) {
            try {
                meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
            } catch {
                meta = null;
            }
        }

        try {
            const buffer = fs.readFileSync(imagePath);
            const etag =
                meta?.etag ||
                crypto.createHash("md5").update(buffer).digest("hex");
            const contentType = meta?.contentType || null;
            return {
                ok: true,
                url: safeUrl,
                buffer,
                contentType,
                etag,
                fromCache: true,
            };
        } catch {
            // Fall through to fetch
        }
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const imageResponse = await fetch(safeUrl, {
            headers: {
                "User-Agent": "Lidify/1.0",
            },
            signal: controller.signal,
        });

        if (!imageResponse.ok) {
            if (imageResponse.status === 404) {
                try {
                    fs.writeFileSync(missingPath, "404");
                } catch {}
                return { ok: false, url: safeUrl, status: "not_found" };
            }
            return {
                ok: false,
                url: safeUrl,
                status: "fetch_error",
                message: `${imageResponse.status} ${imageResponse.statusText}`,
            };
        }

        const buffer = Buffer.from(await imageResponse.arrayBuffer());
        const etag = crypto.createHash("md5").update(buffer).digest("hex");
        const contentType = imageResponse.headers.get("content-type");

        try {
            fs.writeFileSync(imagePath, buffer);
            fs.writeFileSync(
                metaPath,
                JSON.stringify({ etag, contentType } satisfies CachedImageMeta)
            );
            if (fs.existsSync(missingPath)) {
                fs.unlinkSync(missingPath);
            }
        } catch {}

        return {
            ok: true,
            url: safeUrl,
            buffer,
            contentType,
            etag,
            fromCache: false,
        };
    } catch (error) {
        return {
            ok: false,
            url: safeUrl,
            status: "fetch_error",
            message: error instanceof Error ? error.message : "Unknown error",
        };
    } finally {
        clearTimeout(timeoutId);
    }
}
