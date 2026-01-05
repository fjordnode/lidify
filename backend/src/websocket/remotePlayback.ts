import { Server as SocketIOServer, Socket } from "socket.io";
import { Server as HTTPServer } from "http";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { redisClient } from "../utils/redis";
import { prisma } from "../utils/db";
import { config } from "../config";

// Validation schemas for WebSocket messages
const playbackCommandSchema = z.object({
    targetDeviceId: z.string().min(1).max(100),
    command: z.enum(["play", "pause", "next", "prev", "seek", "volume", "setQueue", "playTrack"]),
    payload: z.record(z.unknown()).optional(),
});

const deviceRegisterSchema = z.object({
    deviceId: z.string().min(1).max(100),
    deviceName: z.string().min(1).max(100),
});

const playbackStateSchema = z.object({
    deviceId: z.string().min(1).max(100),
    isPlaying: z.boolean(),
    currentTrack: z.object({
        id: z.string(),
        title: z.string(),
        artist: z.string(),
        album: z.string(),
        coverArt: z.string().optional(),
        duration: z.number(),
    }).nullable(),
    currentTime: z.number(),
    volume: z.number().min(0).max(1),
    queue: z.array(z.unknown()).optional(),
    queueIndex: z.number().optional(),
});

// JWT secret (same as auth middleware)
const JWT_SECRET = process.env.JWT_SECRET || process.env.SESSION_SECRET;

interface JWTPayload {
    userId: string;
    username: string;
    role: string;
}

// Types for remote playback
interface PlaybackDevice {
    socketId: string;
    deviceId: string;
    deviceName: string;
    userId: string;
    isPlaying: boolean;
    currentTrack: {
        id: string;
        title: string;
        artist: string;
        album: string;
        coverArt?: string;
        duration: number;
    } | null;
    currentTime: number;
    volume: number;
    lastSeen: Date;
}

interface PlaybackCommand {
    targetDeviceId: string;
    command: "play" | "pause" | "next" | "prev" | "seek" | "volume" | "setQueue" | "playTrack";
    payload?: any;
}

interface PlaybackStateUpdate {
    deviceId: string;
    isPlaying: boolean;
    currentTrack: PlaybackDevice["currentTrack"];
    currentTime: number;
    volume: number;
    queue?: any[];
    queueIndex?: number;
}

// In-memory device registry (could be moved to Redis for multi-instance)
const activeDevices = new Map<string, PlaybackDevice>();

// Track active player per user (which device is currently playing)
const userActivePlayer = new Map<string, string | null>();

// Get active player for a user
function getActivePlayer(userId: string): string | null {
    return userActivePlayer.get(userId) ?? null;
}

// Set active player for a user
function setActivePlayer(userId: string, deviceId: string | null): void {
    userActivePlayer.set(userId, deviceId);
}

// Get all devices for a user
function getUserDevices(userId: string): PlaybackDevice[] {
    return Array.from(activeDevices.values()).filter(d => d.userId === userId);
}

// Get device by ID
function getDevice(deviceId: string): PlaybackDevice | undefined {
    return activeDevices.get(deviceId);
}

// Redis channel for user playback events
function getUserChannel(userId: string): string {
    return `playback:user:${userId}`;
}

export function initializeWebSocket(httpServer: HTTPServer): SocketIOServer {
    const io = new SocketIOServer(httpServer, {
        cors: {
            origin: true, // Allow all origins (self-hosted)
            credentials: true,
        },
        path: "/api/socket.io",
        // Increase timeouts to prevent disconnects through reverse proxies (Traefik/nginx)
        pingTimeout: 60000,     // 60 seconds (default: 20s)
        pingInterval: 25000,    // 25 seconds (default: 25s)
    });

    // Authentication middleware
    io.use(async (socket, next) => {
        try {
            // Try API key auth first (for mobile/external clients)
            const apiKey = socket.handshake.auth.apiKey || socket.handshake.headers["x-api-key"];
            if (apiKey) {
                const key = await prisma.apiKey.findUnique({
                    where: { key: apiKey },
                    include: { user: true },
                });
                if (key) {
                    // Update last used
                    await prisma.apiKey.update({
                        where: { id: key.id },
                        data: { lastUsed: new Date() },
                    });
                    (socket as any).user = key.user;
                    return next();
                }
            }

            // Try JWT token auth (for web clients - primary method)
            const jwtToken = socket.handshake.auth.token;
            if (jwtToken && JWT_SECRET) {
                try {
                    const decoded = jwt.verify(jwtToken, JWT_SECRET) as JWTPayload;
                    const user = await prisma.user.findUnique({
                        where: { id: decoded.userId },
                    });
                    if (user) {
                        (socket as any).user = user;
                        return next();
                    }
                } catch (jwtError) {
                    // JWT invalid/expired, continue to other auth methods
                    console.log("[WebSocket] JWT auth failed, trying other methods");
                }
            }

            // Try session auth (for web clients with express-session)
            const sessionId = socket.handshake.auth.sessionId;
            if (sessionId) {
                const sessionData = await redisClient.get(`sess:${sessionId}`);
                if (sessionData) {
                    const session = JSON.parse(sessionData);
                    if (session.userId) {
                        const user = await prisma.user.findUnique({
                            where: { id: session.userId },
                        });
                        if (user) {
                            (socket as any).user = user;
                            return next();
                        }
                    }
                }
            }
            // All WebSocket connections must use one of:
            // 1. API key (for mobile/external clients)
            // 2. JWT token (for web clients - primary method)
            // 3. Session ID (for web clients with express-session)

            next(new Error("Authentication required"));
        } catch (error) {
            console.error("[WebSocket] Auth error:", error);
            next(new Error("Authentication failed"));
        }
    });

    io.on("connection", (socket: Socket) => {
        const user = (socket as any).user;
        if (!user) {
            socket.disconnect();
            return;
        }

        console.log(`[WebSocket] User ${user.username} connected (socket: ${socket.id})`);

        // Join user's room for broadcasts
        socket.join(`user:${user.id}`);

        // Handle device registration
        socket.on("device:register", (rawData: unknown) => {
            const parseResult = deviceRegisterSchema.safeParse(rawData);
            if (!parseResult.success) {
                socket.emit("playback:error", { message: "Invalid device registration data" });
                return;
            }
            const data = parseResult.data;

            const device: PlaybackDevice = {
                socketId: socket.id,
                deviceId: data.deviceId,
                deviceName: data.deviceName,
                userId: user.id,
                isPlaying: false,
                currentTrack: null,
                currentTime: 0,
                volume: 1,
                lastSeen: new Date(),
            };

            activeDevices.set(data.deviceId, device);
            console.log(`[WebSocket] Device registered: ${data.deviceName} (${data.deviceId})`);

            // Notify all user's devices about the new device
            broadcastDeviceList(io, user.id);

            // Send current active player state to the newly registered device
            // This is critical for reconnection - ensures the client knows if it should be playing
            const currentActivePlayer = getActivePlayer(user.id);
            socket.emit("playback:activePlayer", { deviceId: currentActivePlayer });
            console.log(`[WebSocket] Sent active player state to ${data.deviceName}: ${currentActivePlayer}`);
        });

        // Handle playback state updates from a device
        socket.on("playback:state", (rawState: unknown) => {
            const parseResult = playbackStateSchema.safeParse(rawState);
            if (!parseResult.success) {
                // State updates are frequent - just ignore invalid ones silently
                return;
            }
            const state = parseResult.data;

            const device = getDevice(state.deviceId);
            if (device && device.userId === user.id) {
                device.isPlaying = state.isPlaying;
                device.currentTrack = state.currentTrack;
                device.currentTime = state.currentTime;
                device.volume = state.volume;
                device.lastSeen = new Date();

                // Broadcast state to all user's devices
                socket.to(`user:${user.id}`).emit("playback:stateUpdate", {
                    deviceId: state.deviceId,
                    deviceName: device.deviceName,
                    ...state,
                });
            }
        });

        // Handle remote control commands
        socket.on("playback:command", (rawCommand: unknown) => {
            const parseResult = playbackCommandSchema.safeParse(rawCommand);
            if (!parseResult.success) {
                socket.emit("playback:error", { message: "Invalid command format" });
                return;
            }
            const command = parseResult.data;

            const targetDevice = getDevice(command.targetDeviceId);
            if (!targetDevice || targetDevice.userId !== user.id) {
                socket.emit("playback:error", { message: "Device not found or not authorized" });
                return;
            }

            console.log(`[WebSocket] Command ${command.command} -> ${targetDevice.deviceName}`);

            // Send command to target device
            io.to(targetDevice.socketId).emit("playback:remoteCommand", {
                command: command.command,
                payload: command.payload,
                fromDeviceId: getDeviceBySocketId(socket.id)?.deviceId,
            });
        });

        // Request current state from a device
        socket.on("playback:requestState", (data: { deviceId: string }) => {
            const targetDevice = getDevice(data.deviceId);
            if (targetDevice && targetDevice.userId === user.id) {
                io.to(targetDevice.socketId).emit("playback:stateRequest");
            }
        });

        // Get list of active devices
        socket.on("devices:list", () => {
            const devices = getUserDevices(user.id).map(d => ({
                deviceId: d.deviceId,
                deviceName: d.deviceName,
                isPlaying: d.isPlaying,
                currentTrack: d.currentTrack,
                currentTime: d.currentTime,
                volume: d.volume,
                isCurrentDevice: d.socketId === socket.id,
            }));
            socket.emit("devices:list", devices);
        });

        // Transfer playback to another device
        socket.on("playback:transfer", (data: { toDeviceId: string; withState: boolean }) => {
            const fromDevice = getDeviceBySocketId(socket.id);
            const toDevice = getDevice(data.toDeviceId);

            if (!fromDevice || !toDevice || toDevice.userId !== user.id) {
                socket.emit("playback:error", { message: "Transfer failed: device not found" });
                return;
            }

            console.log(`[WebSocket] Transfer playback: ${fromDevice.deviceName} -> ${toDevice.deviceName}`);

            if (data.withState && fromDevice.currentTrack) {
                // Send current state to target device to resume playback
                io.to(toDevice.socketId).emit("playback:remoteCommand", {
                    command: "transferPlayback",
                    payload: {
                        track: fromDevice.currentTrack,
                        currentTime: fromDevice.currentTime,
                        isPlaying: fromDevice.isPlaying,
                        volume: fromDevice.volume,
                    },
                    fromDeviceId: fromDevice.deviceId,
                });

                // Stop playback on source device
                io.to(fromDevice.socketId).emit("playback:remoteCommand", {
                    command: "pause",
                    payload: { reason: "transferred" },
                });
            }
        });

        // Set the active player (which device is currently playing)
        socket.on("playback:setActivePlayer", (data: { deviceId: string | null }) => {
            const previousActivePlayer = getActivePlayer(user.id);
            console.log(`[WebSocket] Active player change requested: ${previousActivePlayer} -> ${data.deviceId}`);

            // Validate: warn if setting to null (this resets all devices to think they're active)
            if (data.deviceId === null) {
                console.warn(`[WebSocket] WARNING: Setting activePlayer to null for user ${user.username}. This may cause playback issues.`);
            }

            // Validate: check if the device exists (if not null)
            if (data.deviceId !== null) {
                const device = getDevice(data.deviceId);
                if (!device) {
                    console.warn(`[WebSocket] WARNING: Setting activePlayer to non-existent device: ${data.deviceId}`);
                } else if (device.userId !== user.id) {
                    console.error(`[WebSocket] ERROR: Attempted to set activePlayer to device owned by another user: ${data.deviceId}`);
                    socket.emit("playback:error", { message: "Device not authorized" });
                    return;
                }
            }

            setActivePlayer(user.id, data.deviceId);
            console.log(`[WebSocket] Active player set to: ${data.deviceId} for user ${user.username}`);

            // Broadcast to all user's devices
            io.to(`user:${user.id}`).emit("playback:activePlayer", { deviceId: data.deviceId });
        });

        // Handle disconnect
        socket.on("disconnect", () => {
            const device = getDeviceBySocketId(socket.id);
            if (device) {
                activeDevices.delete(device.deviceId);
                console.log(`[WebSocket] Device disconnected: ${device.deviceName}`);
                broadcastDeviceList(io, user.id);
            }
            console.log(`[WebSocket] User ${user.username} disconnected`);
        });

        // Handle heartbeat to keep device alive
        socket.on("device:heartbeat", (data: { deviceId: string }) => {
            const device = getDevice(data.deviceId);
            if (device && device.userId === user.id) {
                device.lastSeen = new Date();
            }
        });
    });

    // Cleanup stale devices every minute
    setInterval(() => {
        const staleThreshold = Date.now() - 5 * 60 * 1000; // 5 minutes
        for (const [deviceId, device] of activeDevices) {
            if (device.lastSeen.getTime() < staleThreshold) {
                activeDevices.delete(deviceId);
                console.log(`[WebSocket] Removed stale device: ${device.deviceName}`);

                // If this was the active player for its user, clear it
                // This handles permanently disconnected devices (not brief reconnects)
                const activePlayer = getActivePlayer(device.userId);
                if (activePlayer === deviceId) {
                    setActivePlayer(device.userId, null);
                    io.to(`user:${device.userId}`).emit("playback:activePlayer", { deviceId: null });
                    console.log(`[WebSocket] Cleared stale active player for user: ${device.userId}`);
                }
            }
        }
    }, 60 * 1000);

    console.log("[WebSocket] Remote playback server initialized");
    return io;
}

// Helper to find device by socket ID
function getDeviceBySocketId(socketId: string): PlaybackDevice | undefined {
    for (const device of activeDevices.values()) {
        if (device.socketId === socketId) {
            return device;
        }
    }
    return undefined;
}

// Broadcast updated device list to all user's devices
function broadcastDeviceList(io: SocketIOServer, userId: string) {
    const devices = getUserDevices(userId).map(d => ({
        deviceId: d.deviceId,
        deviceName: d.deviceName,
        isPlaying: d.isPlaying,
        currentTrack: d.currentTrack,
        currentTime: d.currentTime,
        volume: d.volume,
    }));
    io.to(`user:${userId}`).emit("devices:list", devices);
}

// Export for use in REST API if needed
export { activeDevices, getUserDevices, getDevice };
