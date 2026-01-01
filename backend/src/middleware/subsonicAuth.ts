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
import { createHash } from "crypto";
import rateLimit from "express-rate-limit";
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
    if (!password && !(token && salt)) {
        sendSubsonicError(
            res,
            SubsonicErrorCode.MISSING_PARAMETER,
            "Required parameter 'p' (password) or 't'+'s' (token+salt) is missing",
            format,
            callback
        );
        return;
    }

    // Look up the user
    const user = await prisma.user.findUnique({
        where: { username },
        select: {
            id: true,
            username: true,
            role: true,
            passwordHash: true,
            subsonicPassword: true,
        },
    });

    if (!user) {
        sendSubsonicError(
            res,
            SubsonicErrorCode.WRONG_CREDENTIALS,
            "Wrong username or password",
            format,
            callback
        );
        return;
    }

    let authenticated = false;

    // Method 1: Token authentication (MD5(password + salt))
    if (!authenticated && token && salt) {
        // First, check against subsonicPassword if set
        // This is the standard Subsonic auth flow: t=md5(password+salt)&s=salt
        if (user.subsonicPassword) {
            const decryptedPassword = decrypt(user.subsonicPassword);
            const expectedToken = createHash("md5")
                .update(decryptedPassword + salt)
                .digest("hex");

            if (token.toLowerCase() === expectedToken.toLowerCase()) {
                req.user = { id: user.id, username: user.username, role: user.role };
                authenticated = true;
            }
        }
    }

    // Method 2: Plain password authentication
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

        // Verify against bcrypt hash
        try {
            const passwordValid = await bcrypt.compare(plainPassword, user.passwordHash);
            if (passwordValid) {
                req.user = { id: user.id, username: user.username, role: user.role };
                authenticated = true;
            }
        } catch (error) {
            console.error("[SubsonicAuth] Password verification error:", error);
        }
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
        // Rate limit by IP + username to prevent distributed attacks on single account
        const ip = req.ip || 'unknown';
        const username = (req.query.u as string) || '';
        return `subsonic:${ip}:${username}`;
    },
});
