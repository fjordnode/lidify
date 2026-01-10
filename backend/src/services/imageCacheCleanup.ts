import fs from "fs/promises";
import path from "path";
import { config } from "../config";

type CacheEntry = {
    base: string;
    paths: string[];
    sizeBytes: number;
    mtimeMs: number;
};

export async function cleanupExternalImageCache(
    maxGb: number
): Promise<{
    removedFiles: number;
    removedMb: number;
    remainingMb: number;
    limitMb: number;
}> {
    const limitBytes = Math.max(0, maxGb) * 1024 * 1024 * 1024;
    const cacheDir = path.join(
        config.music.transcodeCachePath,
        "../covers",
        "external"
    );

    let entries: CacheEntry[] = [];

    try {
        const files = await fs.readdir(cacheDir);
        const groups = new Map<string, CacheEntry>();

        for (const file of files) {
            const match = file.match(/\.(bin|json|missing)$/);
            if (!match) continue;

            const base = file.replace(/\.(bin|json|missing)$/, "");
            const filePath = path.join(cacheDir, file);

            let stat;
            try {
                stat = await fs.stat(filePath);
            } catch {
                continue;
            }

            if (!stat.isFile()) continue;

            const existing = groups.get(base);
            if (existing) {
                existing.paths.push(filePath);
                existing.sizeBytes += stat.size;
                existing.mtimeMs = Math.max(existing.mtimeMs, stat.mtimeMs);
            } else {
                groups.set(base, {
                    base,
                    paths: [filePath],
                    sizeBytes: stat.size,
                    mtimeMs: stat.mtimeMs,
                });
            }
        }

        entries = Array.from(groups.values());
    } catch {
        return {
            removedFiles: 0,
            removedMb: 0,
            remainingMb: 0,
            limitMb: Math.round(limitBytes / (1024 * 1024)),
        };
    }

    let totalBytes = entries.reduce((sum, entry) => sum + entry.sizeBytes, 0);
    if (limitBytes <= 0 || totalBytes <= limitBytes) {
        return {
            removedFiles: 0,
            removedMb: 0,
            remainingMb: Math.round(totalBytes / (1024 * 1024)),
            limitMb: Math.round(limitBytes / (1024 * 1024)),
        };
    }

    entries.sort((a, b) => a.mtimeMs - b.mtimeMs);

    let removedBytes = 0;
    let removedFiles = 0;

    for (const entry of entries) {
        if (totalBytes - removedBytes <= limitBytes) break;

        for (const filePath of entry.paths) {
            try {
                await fs.unlink(filePath);
                removedFiles += 1;
            } catch {
                // Ignore delete failures
            }
        }

        removedBytes += entry.sizeBytes;
    }

    const remainingBytes = Math.max(0, totalBytes - removedBytes);
    return {
        removedFiles,
        removedMb: Math.round(removedBytes / (1024 * 1024)),
        remainingMb: Math.round(remainingBytes / (1024 * 1024)),
        limitMb: Math.round(limitBytes / (1024 * 1024)),
    };
}
