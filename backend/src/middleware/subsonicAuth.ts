/**
 * Subsonic API Authentication Middleware
 *
 * Supports two authentication methods:
 * 1. Token: ?u=username&t=md5(subsonicPassword+salt)&s=salt (standard Subsonic)
 * 2. Password: ?u=username&p=password (or p=enc:hex_encoded_password)
 *
 * Token auth requires user to set a Subsonic password in Settings > API Keys.
 * Plain password auth verifies against the user's bcrypt password hash.
 *
 * Also validates required Subsonic parameters: v (version), c (client)
 */

import { Request, Response, NextFunction } from "express";
import { createHash, timingSafeEqual } from "crypto";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { prisma } from "../utils/db";
import bcrypt from "bcrypt";
import { decrypt } from "../utils/encryption";
import {
    sendSubsonicError,
    SubsonicErrorCode,
    getResponseFormat,
} from "../utils/subsonicResponse";

// Extend Express Request to include Subsonic-specific data
declare global {
    namespace Express {
        interface Request {
            subsonicClient?: string;
            subsonicVersion?: string;
        }
    }
}

/**
 * Subsonic authentication middleware
 */
export async function requireSubsonicAuth(
    req: Request,
    res: Response,
    next: NextFunction
): Promise<void> {
    const format = getResponseFormat(req.query);
    const callback = req.query.callback as string | undefined;

    // Extract Subsonic parameters
    const username = req.query.u as string;
    const password = req.query.p as string;
    const token = req.query.t as string;
    const salt = req.query.s as string;
    const apiKey = req.query.apiKey as string;
    const version = req.query.v as string;
    const client = req.query.c as string;

    // Validate required parameters
    if (!username) {
        sendSubsonicError(
            res,
            SubsonicErrorCode.MISSING_PARAMETER,
            "Required parameter 'u' (username) is missing",
            format,
            callback
        );
        return;
    }

    if (!version) {
        sendSubsonicError(
            res,
            SubsonicErrorCode.MISSING_PARAMETER,
            "Required parameter 'v' (version) is missing",
            format,
            callback
        );
        return;
    }

    if (!client) {
        sendSubsonicError(
            res,
            SubsonicErrorCode.MISSING_PARAMETER,
            "Required parameter 'c' (client) is missing",
            format,
            callback
        );
        return;
    }

    // Must have either password or token+salt
    if (!password && !apiKey && !(token && salt)) {
        sendSubsonicError(
            res,
            SubsonicErrorCode.MISSING_PARAMETER,
            "Required parameter 'p' (password), 'apiKey', or 't'+'s' (token+salt) is missing",
            format,
            callback
        );
        return;
    }

    let authenticated = false;
    let authUser: { id: string; username: string; role: string } | null = null;

    // Method 1: Token authentication (MD5(password + salt))
    if (!authenticated && token && salt) {
        const user = await prisma.user.findUnique({
            where: { username },
            select: {
                id: true,
                username: true,
                role: true,
                subsonicPassword: true,
            },
        });

        if (user?.subsonicPassword) {
            const decryptedPassword = decrypt(user.subsonicPassword);
            const expectedToken = createHash("md5")
                .update(decryptedPassword + salt)
                .digest("hex");

            if (
                token.length === expectedToken.length &&
                timingSafeEqual(
                    Buffer.from(token.toLowerCase(), "utf8"),
                    Buffer.from(expectedToken.toLowerCase(), "utf8")
                )
            ) {
                authUser = { id: user.id, username: user.username, role: user.role };
                authenticated = true;
            }
        }

        if (!authenticated && user) {
            const apiKeys = await prisma.apiKey.findMany({
                where: { userId: user.id },
                select: { id: true, key: true },
            });

            for (const keyRecord of apiKeys) {
                const expectedToken = createHash("md5")
                    .update(keyRecord.key + salt)
                    .digest("hex");

                if (
                    token.length === expectedToken.length &&
                    timingSafeEqual(
                        Buffer.from(token.toLowerCase(), "utf8"),
                        Buffer.from(expectedToken.toLowerCase(), "utf8")
                    )
                ) {
                    authUser = { id: user.id, username: user.username, role: user.role };
                    authenticated = true;
                    prisma.apiKey.update({
                        where: { id: keyRecord.id },
                        data: { lastUsed: new Date() },
                    }).catch(() => {});
                    break;
                }
            }
        }
    }

    // Method 2: OpenSubsonic API key authentication
    if (!authenticated && apiKey) {
        const keyRecord = await prisma.apiKey.findUnique({
            where: { key: apiKey },
            include: {
                user: {
                    select: {
                        id: true,
                        username: true,
                        role: true,
                    },
                },
            },
        });

        if (keyRecord?.user.username === username) {
            authUser = keyRecord.user;
            authenticated = true;
            prisma.apiKey.update({
                where: { id: keyRecord.id },
                data: { lastUsed: new Date() },
            }).catch(() => {});
        }
    }

    // Method 3: Plain password authentication
    if (!authenticated && password) {
        let plainPassword = password;

        // Handle hex-encoded password (enc:HEXVALUE)
        if (password.startsWith("enc:")) {
            try {
                plainPassword = Buffer.from(password.substring(4), "hex").toString("utf-8");
            } catch {
                sendSubsonicError(
                    res,
                    SubsonicErrorCode.WRONG_CREDENTIALS,
                    "Invalid password encoding",
                    format,
                    callback
                );
                return;
            }
        }

        const user = await prisma.user.findUnique({
            where: { username },
            select: {
                id: true,
                username: true,
                role: true,
                passwordHash: true,
            },
        });

        // Verify against bcrypt hash, even for unknown users, to avoid username timing leaks.
        try {
            const dummyHash =
                "$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy";
            const passwordValid = user
                ? await bcrypt.compare(plainPassword, user.passwordHash)
                : await bcrypt.compare(plainPassword, dummyHash);
            if (passwordValid) {
                authUser = { id: user!.id, username: user!.username, role: user!.role };
                authenticated = true;
            }
        } catch (error) {
            console.error("[SubsonicAuth] Password verification error:", error);
        }
    }

    if (authenticated && authUser) {
        req.user = authUser;
    }

    if (!authenticated) {
        sendSubsonicError(
            res,
            SubsonicErrorCode.WRONG_CREDENTIALS,
            "Wrong username or password",
            format,
            callback
        );
        return;
    }

    // Store Subsonic metadata on request
    req.subsonicClient = client;
    req.subsonicVersion = version;

    next();
}

/**
 * Rate limiting for Subsonic API authentication
 * Limits failed auth attempts to prevent brute force attacks
 */
export const subsonicRateLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 30, // 30 attempts per 15 min (higher than web login - clients retry aggressively)
    skipSuccessfulRequests: true, // Only count failed attempts
    message: {
        "subsonic-response": {
            status: "failed",
            version: "1.16.1",
            error: { code: 41, message: "Too many failed attempts. Try again later." }
        }
    },
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
        // Rate limit by IP + username to prevent distributed attacks on single account.
        // ipKeyGenerator takes an IP string and normalizes IPv6 subnets — passing the
        // Request object bypassed type-checking and would break IPv6 masking.
        const ip = ipKeyGenerator(req.ip || "");
        const username = (req.query.u as string) || "";
        return `subsonic:${ip}:${username}`;
    },
});
