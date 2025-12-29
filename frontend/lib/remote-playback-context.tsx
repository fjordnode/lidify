"use client";

import {
    createContext,
    useContext,
    useState,
    useEffect,
    useCallback,
    useRef,
    ReactNode,
} from "react";
import { io, Socket } from "socket.io-client";
import { useAuth } from "./auth-context";

// Types
export interface RemoteDevice {
    deviceId: string;
    deviceName: string;
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
    isCurrentDevice: boolean;
}

export interface RemoteCommand {
    command: "play" | "pause" | "next" | "prev" | "seek" | "volume" | "setQueue" | "playTrack" | "transferPlayback";
    payload?: any;
    fromDeviceId?: string;
}

interface RemotePlaybackContextType {
    // Connection state
    isConnected: boolean;

    // Device management
    devices: RemoteDevice[];
    currentDeviceId: string | null;
    currentDeviceName: string;

    // Active player - only one device plays at a time
    activePlayerId: string | null;
    isActivePlayer: boolean; // Is THIS device the active player?

    // Getter functions for synchronous access (avoid stale closures)
    getActivePlayerId: () => string | null;
    getIsActivePlayer: () => boolean;

    // Active player's state (for UI display when controlling remotely)
    activePlayerState: {
        isPlaying: boolean;
        currentTrack: RemoteDevice["currentTrack"];
        currentTime: number;
        volume: number;
    } | null;

    // Actions
    sendCommand: (targetDeviceId: string, command: RemoteCommand["command"], payload?: any) => void;
    transferPlayback: (toDeviceId: string, withState?: boolean) => void;
    becomeActivePlayer: () => void; // Take control back to this device
    refreshDevices: () => void;
    setDeviceName: (name: string) => void;

    // Remote command handlers (set by audio controls)
    setOnRemoteCommand: (handler: (command: RemoteCommand) => void) => void;
    setOnBecomeActivePlayer: (handler: () => void) => void;
    setOnStopPlayback: (handler: () => void) => void;

    // State broadcasting
    broadcastState: (state: {
        isPlaying: boolean;
        currentTrack: RemoteDevice["currentTrack"];
        currentTime: number;
        volume: number;
        queue?: any[];
        queueIndex?: number;
    }) => void;
}

const RemotePlaybackContext = createContext<RemotePlaybackContextType | undefined>(undefined);

// Generate a unique device ID (persisted in localStorage)
function getOrCreateDeviceId(): string {
    if (typeof window === "undefined") return "";

    let deviceId = localStorage.getItem("lidify_device_id");
    if (!deviceId) {
        deviceId = `device_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        localStorage.setItem("lidify_device_id", deviceId);
    }
    return deviceId;
}

// Get device name (with fallback detection)
function getDefaultDeviceName(): string {
    if (typeof window === "undefined") return "Unknown Device";

    // Try to get from localStorage first
    const savedName = localStorage.getItem("lidify_device_name");
    if (savedName) return savedName;

    // Try to detect device type
    const ua = navigator.userAgent;

    if (/Android TV|BRAVIA|SmartTV/i.test(ua)) {
        return "Smart TV";
    } else if (/Android/i.test(ua)) {
        return "Android Device";
    } else if (/iPad/i.test(ua)) {
        return "iPad";
    } else if (/iPhone/i.test(ua)) {
        return "iPhone";
    } else if (/Mac/i.test(ua)) {
        return "Mac";
    } else if (/Windows/i.test(ua)) {
        return "Windows PC";
    } else if (/Linux/i.test(ua)) {
        return "Linux PC";
    }

    return "Web Browser";
}

// Get persisted active player ID
function getPersistedActivePlayerId(): string | null {
    if (typeof window === "undefined") return null;
    return localStorage.getItem("lidify_active_player_id");
}

// Persist active player ID
function persistActivePlayerId(id: string | null) {
    if (typeof window === "undefined") return;
    if (id) {
        localStorage.setItem("lidify_active_player_id", id);
    } else {
        localStorage.removeItem("lidify_active_player_id");
    }
}

export function RemotePlaybackProvider({ children }: { children: ReactNode }) {
    const { isAuthenticated, user } = useAuth();
    const [isConnected, setIsConnected] = useState(false);
    const [devices, setDevices] = useState<RemoteDevice[]>([]);

    // CRITICAL: Use lazy initializers to set these synchronously on first render
    // This prevents the race condition where isActivePlayer is incorrectly true
    // during the first render before effects run
    const [currentDeviceId, setCurrentDeviceId] = useState<string | null>(() => {
        if (typeof window === "undefined") return null;
        return getOrCreateDeviceId();
    });
    const [currentDeviceName, setCurrentDeviceName] = useState(() => {
        if (typeof window === "undefined") return "Web Browser";
        return getDefaultDeviceName();
    });
    const [activePlayerId, setActivePlayerIdState] = useState<string | null>(() => {
        if (typeof window === "undefined") return null;
        const persisted = getPersistedActivePlayerId();
        if (persisted) {
            console.log("[RemotePlayback] Initialized activePlayerId from storage:", persisted);
        }
        return persisted;
    });

    // Refs - defined early so they can be used in callbacks below
    const socketRef = useRef<Socket | null>(null);
    const heartbeatRef = useRef<NodeJS.Timeout | null>(null);
    const onRemoteCommandRef = useRef<((command: RemoteCommand) => void) | null>(null);
    const onBecomeActivePlayerRef = useRef<(() => void) | null>(null);
    const onStopPlaybackRef = useRef<(() => void) | null>(null);

    // Ref for activePlayerId to avoid stale closures in callbacks
    // This ref is always kept in sync with state and can be read synchronously
    const activePlayerIdRef = useRef<string | null>(activePlayerId);
    activePlayerIdRef.current = activePlayerId;

    // Ref for currentDeviceId as well
    const currentDeviceIdRef = useRef<string | null>(currentDeviceId);
    currentDeviceIdRef.current = currentDeviceId;

    // Wrapper to persist activePlayerId changes
    // ENHANCED LOGGING: Track all changes with previous value and call source
    const setActivePlayerId = useCallback((id: string | null) => {
        const previousId = activePlayerIdRef.current;
        const stack = new Error().stack?.split('\n').slice(2, 5).join('\n') || 'unknown';
        console.log(`[RemotePlayback] Setting activePlayerId: ${previousId} -> ${id}`);
        console.log(`[RemotePlayback] Call stack:\n${stack}`);

        if (id === null && previousId !== null) {
            console.warn(`[RemotePlayback] WARNING: activePlayerId being reset to null from ${previousId}`);
        }

        setActivePlayerIdState(id);
        persistActivePlayerId(id);
    }, []);

    // Is THIS device the active player?
    // When no activePlayerId is set (null), we default to true ONLY for THIS device
    // to allow initial local playback. Once ANY device becomes active, this changes.
    // But if another device is explicitly set as active, this device is NOT active.
    const isActivePlayer = activePlayerId === null || activePlayerId === currentDeviceId;

    // Ref for isActivePlayer - computed from refs for synchronous access in callbacks
    const isActivePlayerRef = useRef<boolean>(isActivePlayer);
    isActivePlayerRef.current = isActivePlayer;

    // Getter functions that use refs - these can be called inside callbacks to get current values
    const getActivePlayerId = useCallback(() => activePlayerIdRef.current, []);
    const getIsActivePlayer = useCallback(() => isActivePlayerRef.current, []);

    // Get the active player's state (for UI display when controlling remotely)
    const activePlayerState = activePlayerId && activePlayerId !== currentDeviceId
        ? (() => {
            const activeDevice = devices.find(d => d.deviceId === activePlayerId);
            if (!activeDevice) return null;
            return {
                isPlaying: activeDevice.isPlaying,
                currentTrack: activeDevice.currentTrack,
                currentTime: activeDevice.currentTime,
                volume: activeDevice.volume,
            };
        })()
        : null;

    // DEBUG: Log whenever activePlayerId or isActivePlayer changes
    useEffect(() => {
        console.log(`[RemotePlayback] STATE CHANGE: activePlayerId=${activePlayerId}, isActivePlayer=${isActivePlayer}, currentDeviceId=${currentDeviceId}`);
    }, [activePlayerId, isActivePlayer, currentDeviceId]);

    // DEBUG: Log when activePlayerState changes
    useEffect(() => {
        if (activePlayerState) {
            console.log(`[RemotePlayback] ACTIVE PLAYER STATE: time=${activePlayerState.currentTime?.toFixed(1)}, playing=${activePlayerState.isPlaying}, vol=${activePlayerState.volume}`);
        }
    }, [activePlayerState?.currentTime, activePlayerState?.isPlaying, activePlayerState?.volume]);

    // Connect to WebSocket when authenticated
    useEffect(() => {
        if (!isAuthenticated || !user || !currentDeviceId) {
            return;
        }

        // Determine WebSocket URL
        // Backend WebSocket runs on port 3006, frontend on 3030
        // For LAN access (IP:3030), connect to IP:3006
        let wsUrl = "";
        if (typeof window !== "undefined") {
            const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
            const hostname = window.location.hostname;
            const currentPort = window.location.port;

            // If accessing via port 3030 (Next.js), switch to 3006 (Express backend)
            // If accessing via domain (no port or 443), assume reverse proxy handles it
            const wsPort = currentPort === "3030" ? "3006" : currentPort;
            const wsHost = wsPort ? `${hostname}:${wsPort}` : hostname;
            wsUrl = `${protocol}//${wsHost}`;
        }

        console.log("[RemotePlayback] Connecting to WebSocket...");

        const socket = io(wsUrl, {
            path: "/api/socket.io",
            auth: {
                userId: user.id,
            },
            transports: ["websocket", "polling"],
            reconnection: true,
            reconnectionAttempts: 10,
            reconnectionDelay: 1000,
        });

        socketRef.current = socket;

        socket.on("connect", () => {
            console.log("[RemotePlayback] Connected to WebSocket");
            setIsConnected(true);

            // Register this device
            socket.emit("device:register", {
                deviceId: currentDeviceId,
                deviceName: currentDeviceName,
            });

            // Request device list
            socket.emit("devices:list");
        });

        socket.on("disconnect", () => {
            console.log("[RemotePlayback] Disconnected from WebSocket");
            setIsConnected(false);
        });

        socket.on("connect_error", (error) => {
            console.error("[RemotePlayback] Connection error:", error.message);
            setIsConnected(false);
        });

        // Handle device list updates
        socket.on("devices:list", (deviceList: RemoteDevice[]) => {
            // Mark current device
            const devicesWithCurrent = deviceList.map(d => ({
                ...d,
                isCurrentDevice: d.deviceId === currentDeviceId,
            }));
            setDevices(devicesWithCurrent);
        });

        // Handle remote commands
        socket.on("playback:remoteCommand", (command: RemoteCommand) => {
            console.log("[RemotePlayback] Received remote command:", command);
            if (onRemoteCommandRef.current) {
                onRemoteCommandRef.current(command);
            }
        });

        // Handle state update broadcasts from other devices
        socket.on("playback:stateUpdate", (state: any) => {
            console.log("[RemotePlayback] State update received from device:", state.deviceId, {
                currentTime: state.currentTime,
                isPlaying: state.isPlaying,
                volume: state.volume,
            });
            // Update the device in our list
            setDevices(prev => prev.map(d =>
                d.deviceId === state.deviceId
                    ? { ...d, ...state, isCurrentDevice: d.deviceId === currentDeviceId }
                    : d
            ));
        });

        // Handle state request (another device wants our current state)
        socket.on("playback:stateRequest", () => {
            // This will be handled by the audio context which calls broadcastState
            console.log("[RemotePlayback] State requested by another device");
        });

        // Handle active player changes
        socket.on("playback:activePlayer", (data: { deviceId: string | null }) => {
            // Use refs to get current values (avoid stale closures)
            const myDeviceId = currentDeviceIdRef.current;
            const previousActivePlayer = activePlayerIdRef.current;
            const wasActivePlayer = previousActivePlayer === null || previousActivePlayer === myDeviceId;
            const willBeActivePlayer = data.deviceId === null || data.deviceId === myDeviceId;

            console.log(`[RemotePlayback] Socket: playback:activePlayer received`);
            console.log(`[RemotePlayback]   Previous activePlayerId: ${previousActivePlayer}`);
            console.log(`[RemotePlayback]   New activePlayerId: ${data.deviceId}`);
            console.log(`[RemotePlayback]   This device: ${myDeviceId}`);
            console.log(`[RemotePlayback]   Was active: ${wasActivePlayer}, Will be active: ${willBeActivePlayer}`);

            if (data.deviceId === null) {
                console.warn(`[RemotePlayback] WARNING: Received null activePlayerId from server!`);
            }

            setActivePlayerId(data.deviceId);

            // If we just became the active player
            if (data.deviceId === myDeviceId && onBecomeActivePlayerRef.current) {
                console.log(`[RemotePlayback] This device is now active, calling onBecomeActivePlayer`);
                onBecomeActivePlayerRef.current();
            }

            // If we're no longer the active player (and we were before)
            if (data.deviceId !== myDeviceId && data.deviceId !== null) {
                if (onStopPlaybackRef.current) {
                    console.log(`[RemotePlayback] This device is no longer active, calling onStopPlayback`);
                    onStopPlaybackRef.current();
                }
            }
        });

        // Start heartbeat
        heartbeatRef.current = setInterval(() => {
            if (socket.connected && currentDeviceId) {
                socket.emit("device:heartbeat", { deviceId: currentDeviceId });
            }
        }, 30000); // Every 30 seconds

        return () => {
            if (heartbeatRef.current) {
                clearInterval(heartbeatRef.current);
            }
            socket.disconnect();
            socketRef.current = null;
        };
    }, [isAuthenticated, user, currentDeviceId, currentDeviceName]);

    // Send a command to another device
    const sendCommand = useCallback((
        targetDeviceId: string,
        command: RemoteCommand["command"],
        payload?: any
    ) => {
        if (!socketRef.current?.connected) {
            console.warn("[RemotePlayback] Cannot send command - not connected");
            return;
        }

        socketRef.current.emit("playback:command", {
            targetDeviceId,
            command,
            payload,
        });
    }, []);

    // Transfer playback to another device
    const transferPlayback = useCallback((toDeviceId: string, withState = true) => {
        if (!socketRef.current?.connected) {
            console.warn("[RemotePlayback] Cannot transfer - not connected");
            return;
        }

        console.log("[RemotePlayback] Transferring playback to:", toDeviceId);

        // CRITICAL: Set the active player FIRST so isActivePlayer becomes false immediately
        // This prevents any state updates from triggering local playback
        setActivePlayerId(toDeviceId);

        // Stop local playback
        if (onStopPlaybackRef.current) {
            onStopPlaybackRef.current();
        }

        // Small delay to ensure local audio has stopped before remote starts
        // This prevents the brief overlap/"double play" issue
        setTimeout(() => {
            if (!socketRef.current?.connected) return;

            // Emit transfer and active player change
            socketRef.current.emit("playback:transfer", {
                toDeviceId,
                withState,
            });
            socketRef.current.emit("playback:setActivePlayer", { deviceId: toDeviceId });
        }, 50);
    }, []);

    // Become the active player (take control back to this device)
    const becomeActivePlayer = useCallback(() => {
        if (!socketRef.current?.connected || !currentDeviceId) {
            console.warn("[RemotePlayback] Cannot become active - not connected");
            return;
        }

        console.log("[RemotePlayback] Becoming active player");
        setActivePlayerId(currentDeviceId);
        socketRef.current.emit("playback:setActivePlayer", { deviceId: currentDeviceId });
    }, [currentDeviceId]);

    // Refresh device list
    const refreshDevices = useCallback(() => {
        if (socketRef.current?.connected) {
            socketRef.current.emit("devices:list");
        }
    }, []);

    // Set device name (and persist)
    const setDeviceName = useCallback((name: string) => {
        setCurrentDeviceName(name);
        if (typeof window !== "undefined") {
            localStorage.setItem("lidify_device_name", name);
        }

        // Re-register with new name
        if (socketRef.current?.connected && currentDeviceId) {
            socketRef.current.emit("device:register", {
                deviceId: currentDeviceId,
                deviceName: name,
            });
        }
    }, [currentDeviceId]);

    // Broadcast current playback state
    const broadcastState = useCallback((state: {
        isPlaying: boolean;
        currentTrack: RemoteDevice["currentTrack"];
        currentTime: number;
        volume: number;
        queue?: any[];
        queueIndex?: number;
    }) => {
        if (!socketRef.current?.connected || !currentDeviceId) return;

        socketRef.current.emit("playback:state", {
            deviceId: currentDeviceId,
            ...state,
        });
    }, [currentDeviceId]);

    // Wrapper for setOnRemoteCommand - uses ref to avoid re-renders
    const setOnRemoteCommand = useCallback((handler: (command: RemoteCommand) => void) => {
        onRemoteCommandRef.current = handler;
    }, []);

    // Callback when this device becomes active player
    const setOnBecomeActivePlayer = useCallback((handler: () => void) => {
        onBecomeActivePlayerRef.current = handler;
    }, []);

    // Callback when this device should stop playback (another device took over)
    const setOnStopPlayback = useCallback((handler: () => void) => {
        onStopPlaybackRef.current = handler;
    }, []);

    return (
        <RemotePlaybackContext.Provider
            value={{
                isConnected,
                devices,
                currentDeviceId,
                currentDeviceName,
                activePlayerId,
                isActivePlayer,
                getActivePlayerId,
                getIsActivePlayer,
                activePlayerState,
                sendCommand,
                transferPlayback,
                becomeActivePlayer,
                refreshDevices,
                setDeviceName,
                setOnRemoteCommand,
                setOnBecomeActivePlayer,
                setOnStopPlayback,
                broadcastState,
            }}
        >
            {children}
        </RemotePlaybackContext.Provider>
    );
}

export function useRemotePlayback() {
    const context = useContext(RemotePlaybackContext);
    if (context === undefined) {
        throw new Error("useRemotePlayback must be used within a RemotePlaybackProvider");
    }
    return context;
}
