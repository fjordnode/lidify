import { Router } from "express";
import { requireAuth, requireAdmin } from "../middleware/auth";
import { prisma } from "../utils/db";
import { z } from "zod";
import { writeEnvFile } from "../utils/envWriter";
import { invalidateSystemSettingsCache } from "../utils/systemSettings";
import { queueCleaner } from "../jobs/queueCleaner";
import { encrypt, decrypt } from "../utils/encryption";

const router = Router();

/**
 * Safely decrypt a field, returning null if decryption fails
 */
function safeDecrypt(value: string | null): string | null {
    if (!value) return null;
    try {
        return decrypt(value);
    } catch (error) {
        console.warn("[Settings Route] Failed to decrypt field, returning null");
        return null;
    }
}

// GET /system-settings/openrouter-status
// Returns whether OpenRouter is configured (API key is set via environment variable)
// This endpoint is BEFORE auth middleware so the settings page can check availability
router.get("/openrouter-status", async (req, res) => {
    const { openRouterService } = await import("../services/openrouter");
    res.json({
        configured: openRouterService.isConfigured(),
    });
});

// GET /system-settings/openrouter-models
// Fetches available models from OpenRouter API
// This endpoint is BEFORE auth middleware for simplicity
router.get("/openrouter-models", async (req, res) => {
    try {
        const { openRouterService } = await import("../services/openrouter");
        const models = await openRouterService.getModels();
        res.json({ models });
    } catch (error: any) {
        console.error("[OpenRouter] Failed to fetch models:", error.message);
        res.status(500).json({ error: "Failed to fetch models", models: [] });
    }
});

// GET /system-settings/lidarr-quality-profiles
// This endpoint is BEFORE auth middleware because it needs to work with unsaved credentials
// The Lidarr API key in the request provides its own authentication
router.get("/lidarr-quality-profiles", async (req, res) => {
    console.log("[QualityProfiles] Request received");
    try {
        const lidarrUrl = req.query.url as string | undefined;
        const apiKey = req.query.apiKey as string | undefined;
        console.log("[QualityProfiles] Query params - url:", lidarrUrl, "hasApiKey:", !!apiKey);

        if (!lidarrUrl || !apiKey) {
            return res.status(400).json({
                error: "Lidarr URL and API key required",
                profiles: [],
            });
        }

        const axios = require("axios");

        console.log("[QualityProfiles] Fetching from:", lidarrUrl);
        const response = await axios.get(
            `${lidarrUrl}/api/v1/qualityprofile`,
            {
                headers: { "X-Api-Key": apiKey },
                timeout: 10000,
            }
        );

        // Return simplified profile list
        const profiles = response.data.map((p: any) => ({
            id: p.id,
            name: p.name,
        }));

        console.log("[QualityProfiles] Found profiles:", profiles);
        res.json({ profiles });
    } catch (error: any) {
        console.error("Failed to fetch Lidarr quality profiles:", error.message);
        res.status(500).json({
            error: "Failed to fetch quality profiles",
            details: error.message,
            profiles: [],
        });
    }
});

// Only admins can access system settings (remaining routes)
router.use(requireAuth);
router.use(requireAdmin);

const systemSettingsSchema = z.object({
    // Download Services
    lidarrEnabled: z.boolean().optional(),
    lidarrUrl: z.string().optional(),
    lidarrApiKey: z.string().nullable().optional(),
    lidarrQualityProfileId: z.number().nullable().optional(),

    // AI Services (API key set via OPENROUTER_API_KEY environment variable)
    openrouterEnabled: z.boolean().optional(),
    openrouterModel: z.string().optional(),

    fanartEnabled: z.boolean().optional(),
    fanartApiKey: z.string().nullable().optional(),

    // Media Services
    audiobookshelfEnabled: z.boolean().optional(),
    audiobookshelfUrl: z.string().optional(),
    audiobookshelfApiKey: z.string().nullable().optional(),

    // Soulseek (direct connection via slsk-client)
    soulseekUsername: z.string().nullable().optional(),
    soulseekPassword: z.string().nullable().optional(),

    // Spotify (for playlist import)
    spotifyClientId: z.string().nullable().optional(),
    spotifyClientSecret: z.string().nullable().optional(),

    // Storage Paths
    musicPath: z.string().optional(),
    downloadPath: z.string().optional(),

    // Feature Flags
    autoSync: z.boolean().optional(),
    autoEnrichMetadata: z.boolean().optional(),

    // Advanced Settings
    maxConcurrentDownloads: z.number().optional(),
    downloadRetryAttempts: z.number().optional(),
    transcodeCacheMaxGb: z.number().optional(),

    // Download Preferences
    downloadSource: z.enum(["soulseek", "lidarr"]).optional(),
    soulseekFallback: z.enum(["none", "lidarr"]).optional(),
});

// GET /system-settings
router.get("/", async (req, res) => {
    try {
        let settings = await prisma.systemSettings.findUnique({
            where: { id: "default" },
        });

        // Create default settings if they don't exist
        if (!settings) {
            settings = await prisma.systemSettings.create({
                data: {
                    id: "default",
                    lidarrEnabled: true,
                    lidarrUrl: "http://localhost:8686",
                    openrouterEnabled: false,
                    openrouterModel: "openai/gpt-4o-mini",
                    fanartEnabled: false,
                    audiobookshelfEnabled: false,
                    audiobookshelfUrl: "http://localhost:13378",
                    musicPath: "/music",
                    downloadPath: "/downloads",
                    autoSync: true,
                    autoEnrichMetadata: true,
                    maxConcurrentDownloads: 3,
                    downloadRetryAttempts: 3,
                    transcodeCacheMaxGb: 10,
                },
            });
        }

        // Decrypt sensitive fields before sending to client
        // Use safeDecrypt to handle corrupted encrypted values gracefully
        // Note: openrouterApiKey is NOT sent - it's only configured via OPENROUTER_API_KEY env var
        const decryptedSettings = {
            ...settings,
            lidarrApiKey: safeDecrypt(settings.lidarrApiKey),
            fanartApiKey: safeDecrypt(settings.fanartApiKey),
            audiobookshelfApiKey: safeDecrypt(settings.audiobookshelfApiKey),
            soulseekPassword: safeDecrypt(settings.soulseekPassword),
            spotifyClientSecret: safeDecrypt(settings.spotifyClientSecret),
        };

        res.json(decryptedSettings);
    } catch (error) {
        console.error("Get system settings error:", error);
        res.status(500).json({ error: "Failed to get system settings" });
    }
});

// POST /system-settings
router.post("/", async (req, res) => {
    try {
        const data = systemSettingsSchema.parse(req.body);

        console.log("[SYSTEM SETTINGS] Saving settings...");
        console.log(
            "[SYSTEM SETTINGS] transcodeCacheMaxGb:",
            data.transcodeCacheMaxGb
        );

        // Encrypt sensitive fields
        // Note: openrouterApiKey is NOT stored - it's only configured via OPENROUTER_API_KEY env var
        const encryptedData: any = { ...data };

        if (data.lidarrApiKey)
            encryptedData.lidarrApiKey = encrypt(data.lidarrApiKey);
        if (data.fanartApiKey)
            encryptedData.fanartApiKey = encrypt(data.fanartApiKey);
        if (data.audiobookshelfApiKey)
            encryptedData.audiobookshelfApiKey = encrypt(
                data.audiobookshelfApiKey
            );
        if (data.soulseekPassword)
            encryptedData.soulseekPassword = encrypt(data.soulseekPassword);
        if (data.spotifyClientSecret)
            encryptedData.spotifyClientSecret = encrypt(data.spotifyClientSecret);

        const settings = await prisma.systemSettings.upsert({
            where: { id: "default" },
            create: {
                id: "default",
                ...encryptedData,
            },
            update: encryptedData,
        });

        invalidateSystemSettingsCache();

        // If Audiobookshelf was disabled, clear all audiobook-related data
        if (data.audiobookshelfEnabled === false) {
            console.log(
                "[CLEANUP] Audiobookshelf disabled - clearing all audiobook data from database"
            );
            try {
                const deletedProgress =
                    await prisma.audiobookProgress.deleteMany({});
                console.log(
                    `   Deleted ${deletedProgress.count} audiobook progress entries`
                );
            } catch (clearError) {
                console.error("Failed to clear audiobook data:", clearError);
                // Don't fail the request
            }
        }

        // Write to .env file for Docker containers
        // Note: OPENROUTER_API_KEY is NOT written - it must be set externally for security
        try {
            await writeEnvFile({
                LIDARR_ENABLED: data.lidarrEnabled ? "true" : "false",
                LIDARR_URL: data.lidarrUrl || null,
                LIDARR_API_KEY: data.lidarrApiKey || null,
                FANART_API_KEY: data.fanartApiKey || null,
                AUDIOBOOKSHELF_URL: data.audiobookshelfUrl || null,
                AUDIOBOOKSHELF_API_KEY: data.audiobookshelfApiKey || null,
                SOULSEEK_USERNAME: data.soulseekUsername || null,
                SOULSEEK_PASSWORD: data.soulseekPassword || null,
            });
            console.log(".env file synchronized with database settings");
        } catch (envError) {
            console.error("Failed to write .env file:", envError);
            // Don't fail the request if .env write fails
        }

        // Auto-configure Lidarr webhook if Lidarr is enabled
        if (data.lidarrEnabled && data.lidarrUrl && data.lidarrApiKey) {
            try {
                console.log("[LIDARR] Auto-configuring webhook...");

                const axios = (await import("axios")).default;
                const lidarrUrl = data.lidarrUrl;
                const apiKey = data.lidarrApiKey;

                // Determine webhook URL
                // Use LIDIFY_CALLBACK_URL env var if set, otherwise default to host.docker.internal:3030
                // Port 3030 is the external Nginx port that Lidarr can reach
                const callbackHost = process.env.LIDIFY_CALLBACK_URL || "http://host.docker.internal:3030";
                const webhookUrl = `${callbackHost}/api/webhooks/lidarr`;

                console.log(`   Webhook URL: ${webhookUrl}`);

                // Check if webhook already exists - find by name "Lidify" OR by URL containing "lidify" or "webhooks/lidarr"
                const notificationsResponse = await axios.get(
                    `${lidarrUrl}/api/v1/notification`,
                    {
                        headers: { "X-Api-Key": apiKey },
                        timeout: 10000,
                    }
                );

                // Find existing Lidify webhook by name (primary) or URL pattern (fallback)
                const existingWebhook = notificationsResponse.data.find(
                    (n: any) =>
                        n.implementation === "Webhook" &&
                        (
                            // Match by name
                            n.name === "Lidify" ||
                            // Or match by URL pattern (catches old webhooks with different URLs)
                            n.fields?.find(
                                (f: any) =>
                                    f.name === "url" && 
                                    (f.value?.includes("webhooks/lidarr") || f.value?.includes("lidify"))
                            )
                        )
                );
                
                if (existingWebhook) {
                    const currentUrl = existingWebhook.fields?.find((f: any) => f.name === "url")?.value;
                    console.log(`   Found existing webhook: "${existingWebhook.name}" with URL: ${currentUrl}`);
                    if (currentUrl !== webhookUrl) {
                        console.log(`   URL needs updating from: ${currentUrl}`);
                        console.log(`   URL will be updated to: ${webhookUrl}`);
                    }
                }

                const webhookConfig = {
                    onGrab: true,
                    onReleaseImport: true,
                    onAlbumDownload: true,
                    onDownloadFailure: true,
                    onImportFailure: true,
                    onAlbumDelete: true,
                    onRename: true,
                    onHealthIssue: false,
                    onApplicationUpdate: false,
                    supportsOnGrab: true,
                    supportsOnReleaseImport: true,
                    supportsOnAlbumDownload: true,
                    supportsOnDownloadFailure: true,
                    supportsOnImportFailure: true,
                    supportsOnAlbumDelete: true,
                    supportsOnRename: true,
                    supportsOnHealthIssue: true,
                    supportsOnApplicationUpdate: true,
                    includeHealthWarnings: false,
                    name: "Lidify",
                    implementation: "Webhook",
                    implementationName: "Webhook",
                    configContract: "WebhookSettings",
                    infoLink:
                        "https://wiki.servarr.com/lidarr/supported#webhook",
                    tags: [],
                    fields: [
                        { name: "url", value: webhookUrl },
                        { name: "method", value: 1 }, // 1 = POST
                        { name: "username", value: "" },
                        { name: "password", value: "" },
                    ],
                };

                if (existingWebhook) {
                    // Update existing webhook
                    await axios.put(
                        `${lidarrUrl}/api/v1/notification/${existingWebhook.id}?forceSave=true`,
                        { ...existingWebhook, ...webhookConfig },
                        {
                            headers: { "X-Api-Key": apiKey },
                            timeout: 10000,
                        }
                    );
                    console.log("   Webhook updated");
                } else {
                    // Create new webhook (use forceSave to skip test)
                    await axios.post(
                        `${lidarrUrl}/api/v1/notification?forceSave=true`,
                        webhookConfig,
                        {
                            headers: { "X-Api-Key": apiKey },
                            timeout: 10000,
                        }
                    );
                    console.log("   Webhook created");
                }

                console.log("Lidarr webhook configured automatically\n");
            } catch (webhookError: any) {
                console.error(
                    "Failed to auto-configure webhook:",
                    webhookError.message
                );
                if (webhookError.response?.data) {
                    console.error(
                        "   Lidarr error details:",
                        JSON.stringify(webhookError.response.data, null, 2)
                    );
                }
                console.log(
                    " User can configure webhook manually in Lidarr UI\n"
                );
                // Don't fail the request if webhook config fails
            }
        }

        res.json({
            success: true,
            message:
                "Settings saved successfully. Restart Docker containers to apply changes.",
            requiresRestart: true,
        });
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res
                .status(400)
                .json({ error: "Invalid settings", details: error.errors });
        }
        console.error("Update system settings error:", error);
        res.status(500).json({ error: "Failed to update system settings" });
    }
});

// POST /system-settings/test-lidarr
router.post("/test-lidarr", async (req, res) => {
    try {
        const { url, apiKey } = req.body;

        console.log("[Lidarr Test] Testing connection to:", url);

        if (!url || !apiKey) {
            return res
                .status(400)
                .json({ error: "URL and API key are required" });
        }

        // Normalize URL - remove trailing slash
        const normalizedUrl = url.replace(/\/+$/, "");

        const axios = require("axios");
        const response = await axios.get(
            `${normalizedUrl}/api/v1/system/status`,
            {
                headers: { "X-Api-Key": apiKey },
                timeout: 10000,
            }
        );

        console.log(
            "[Lidarr Test] Connection successful, version:",
            response.data.version
        );

        res.json({
            success: true,
            message: "Lidarr connection successful",
            version: response.data.version,
        });
    } catch (error: any) {
        console.error("[Lidarr Test] Error:", error.message);
        console.error(
            "[Lidarr Test] Details:",
            error.response?.data || error.code
        );

        let details = error.message;
        if (error.code === "ECONNREFUSED") {
            details =
                "Connection refused - check if Lidarr is running and accessible";
        } else if (error.code === "ENOTFOUND") {
            details = "Host not found - check the URL";
        } else if (error.response?.status === 401) {
            details = "Invalid API key";
        } else if (error.response?.data?.message) {
            details = error.response.data.message;
        }

        res.status(500).json({
            error: "Failed to connect to Lidarr",
            details,
        });
    }
});

// POST /system-settings/test-openrouter
// Tests the OpenRouter connection using the OPENROUTER_API_KEY environment variable
router.post("/test-openrouter", async (req, res) => {
    try {
        const { config } = await import("../config");
        const { model } = req.body;

        const apiKey = config.openrouter.apiKey;
        if (!apiKey) {
            return res.status(400).json({
                error: "OpenRouter API key not configured",
                details: "Set OPENROUTER_API_KEY environment variable"
            });
        }

        const axios = require("axios");
        const response = await axios.post(
            "https://openrouter.ai/api/v1/chat/completions",
            {
                model: model || "openai/gpt-4o-mini",
                messages: [{ role: "user", content: "Test" }],
                max_tokens: 5,
            },
            {
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    "HTTP-Referer": "https://lidify.app",
                    "X-Title": "Lidify Music",
                },
                timeout: 10000,
            }
        );

        res.json({
            success: true,
            message: "OpenRouter connection successful",
            model: response.data.model,
        });
    } catch (error: any) {
        console.error("OpenRouter test error:", error.message);
        res.status(500).json({
            error: "Failed to connect to OpenRouter",
            details: error.response?.data?.error?.message || error.message,
        });
    }
});

// Test Fanart.tv connection
router.post("/test-fanart", async (req, res) => {
    try {
        const { fanartApiKey } = req.body;

        if (!fanartApiKey) {
            return res.status(400).json({ error: "API key is required" });
        }

        const axios = require("axios");

        // Test with a known artist (The Beatles MBID)
        const testMbid = "b10bbbfc-cf9e-42e0-be17-e2c3e1d2600d";

        const response = await axios.get(
            `https://webservice.fanart.tv/v3/music/${testMbid}`,
            {
                params: { api_key: fanartApiKey },
                timeout: 5000,
            }
        );

        // If we get here, the API key is valid
        res.json({
            success: true,
            message: "Fanart.tv connection successful",
        });
    } catch (error: any) {
        console.error("Fanart.tv test error:", error.message);
        if (error.response?.status === 401) {
            res.status(401).json({
                error: "Invalid Fanart.tv API key",
            });
        } else {
            res.status(500).json({
                error: "Failed to connect to Fanart.tv",
                details: error.response?.data || error.message,
            });
        }
    }
});

// Test Audiobookshelf connection
router.post("/test-audiobookshelf", async (req, res) => {
    try {
        const { url, apiKey } = req.body;

        if (!url || !apiKey) {
            return res
                .status(400)
                .json({ error: "URL and API key are required" });
        }

        const axios = require("axios");

        const response = await axios.get(`${url}/api/libraries`, {
            headers: {
                Authorization: `Bearer ${apiKey}`,
            },
            timeout: 5000,
        });

        res.json({
            success: true,
            message: "Audiobookshelf connection successful",
            libraries: response.data.libraries?.length || 0,
        });
    } catch (error: any) {
        console.error("Audiobookshelf test error:", error.message);
        if (error.response?.status === 401 || error.response?.status === 403) {
            res.status(401).json({
                error: "Invalid Audiobookshelf API key",
            });
        } else {
            res.status(500).json({
                error: "Failed to connect to Audiobookshelf",
                details: error.response?.data || error.message,
            });
        }
    }
});

// Test Soulseek connection (direct via slsk-client)
router.post("/test-soulseek", async (req, res) => {
    try {
        const { username, password } = req.body;

        if (!username || !password) {
            return res.status(400).json({
                error: "Soulseek username and password are required",
            });
        }

        console.log(`[SOULSEEK-TEST] Testing connection as "${username}"...`);

        // Import soulseek service
        const { soulseekService } = await import("../services/soulseek");

        // Temporarily set credentials for test
        // The service will use the provided credentials
        try {
            // Try to connect with the provided credentials
            const slsk = require("slsk-client");

            await new Promise<void>((resolve, reject) => {
                slsk.connect(
                    { user: username, pass: password },
                    (err: Error | null, client: any) => {
                        if (err) {
                            console.log(`[SOULSEEK-TEST] Connection failed: ${err.message}`);
                            return reject(err);
                        }
                        console.log(`[SOULSEEK-TEST] Connected successfully`);
                        // We don't need to keep the connection open for the test
                        resolve();
                    }
                );
            });

            res.json({
                success: true,
                message: `Connected to Soulseek as "${username}"`,
                soulseekUsername: username,
                isConnected: true,
            });
        } catch (connectError: any) {
            console.error(`[SOULSEEK-TEST] Error: ${connectError.message}`);
            res.status(401).json({
                error: "Invalid Soulseek credentials or connection failed",
                details: connectError.message,
            });
        }
    } catch (error: any) {
        console.error("[SOULSEEK-TEST] Error:", error.message);
        res.status(500).json({
            error: "Failed to test Soulseek connection",
            details: error.message,
        });
    }
});

// Test Spotify credentials
router.post("/test-spotify", async (req, res) => {
    try {
        const { clientId, clientSecret } = req.body;

        if (!clientId || !clientSecret) {
            return res.status(400).json({ 
                error: "Client ID and Client Secret are required" 
            });
        }

        // Import spotifyService to test credentials
        const { spotifyService } = await import("../services/spotify");
        const result = await spotifyService.testCredentials(clientId, clientSecret);

        if (result.success) {
            res.json({
                success: true,
                message: "Spotify credentials are valid",
            });
        } else {
            res.status(401).json({
                error: result.error || "Invalid Spotify credentials",
            });
        }
    } catch (error: any) {
        console.error("Spotify test error:", error.message);
        res.status(500).json({
            error: "Failed to test Spotify credentials",
            details: error.message,
        });
    }
});

// Get queue cleaner status
router.get("/queue-cleaner-status", (req, res) => {
    res.json(queueCleaner.getStatus());
});

// Start queue cleaner manually
router.post("/queue-cleaner/start", async (req, res) => {
    try {
        await queueCleaner.start();
        res.json({
            success: true,
            message: "Queue cleaner started",
            status: queueCleaner.getStatus(),
        });
    } catch (error: any) {
        res.status(500).json({
            error: "Failed to start queue cleaner",
            details: error.message,
        });
    }
});

// Stop queue cleaner manually
router.post("/queue-cleaner/stop", (req, res) => {
    queueCleaner.stop();
    res.json({
        success: true,
        message: "Queue cleaner stopped",
        status: queueCleaner.getStatus(),
    });
});

// Clear all Redis caches
router.post("/clear-caches", async (req, res) => {
    try {
        const { redisClient } = require("../utils/redis");
        const { notificationService } = await import("../services/notificationService");

        // Get all keys but exclude session keys
        const allKeys = await redisClient.keys("*");
        const keysToDelete = allKeys.filter(
            (key: string) => !key.startsWith("sess:")
        );

        if (keysToDelete.length > 0) {
            console.log(
                `[CACHE] Clearing ${
                    keysToDelete.length
                } cache entries (excluding ${
                    allKeys.length - keysToDelete.length
                } session keys)...`
            );
            for (const key of keysToDelete) {
                await redisClient.del(key);
            }
            console.log(
                `[CACHE] Successfully cleared ${keysToDelete.length} cache entries`
            );

            // Send notification to user
            await notificationService.notifySystem(
                req.user!.id,
                "Caches Cleared",
                `Successfully cleared ${keysToDelete.length} cache entries`
            );

            res.json({
                success: true,
                message: `Cleared ${keysToDelete.length} cache entries`,
                clearedKeys: keysToDelete.length,
            });
        } else {
            await notificationService.notifySystem(
                req.user!.id,
                "Caches Cleared",
                "No cache entries to clear"
            );

            res.json({
                success: true,
                message: "No cache entries to clear",
                clearedKeys: 0,
            });
        }
    } catch (error: any) {
        console.error("Clear caches error:", error);
        res.status(500).json({
            error: "Failed to clear caches",
            details: error.message,
        });
    }
});

export default router;
