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
import { api } from "./api";
import { Track } from "./audio-state-context";
import { getCurrentDeviceId, normalizeActivePlayerId } from "./device-identity";

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

export type RemoteQueueItem = NonNullable<RemoteDevice["currentTrack"]>;

export interface RemoteCommandPayload {
    time?: number;
    relative?: number;
    volume?: number;
    track?: Track;
    tracks?: Track[];
    startIndex?: number;
    isVibeQueue?: boolean;
    currentTrack?: Track;
    currentTime?: number;
    isPlaying?: boolean;
}

export interface RemoteCommand {
    command: "play" | "pause" | "next" | "prev" | "seek" | "volume" | "setQueue" | "playTrack" | "transferPlayback";
    payload?: RemoteCommandPayload;
    fromDeviceId?: string;
}

// Control mode: "local" = control this device, "remote" = control another device
export type ControlMode = "local" | "remote";

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

    // Control mode - "local" or "remote"
    // This is per-device state that determines command routing
    controlMode: ControlMode;
    controlTargetId: string | null; // Which device we're controlling (when in remote mode)
    getControlMode: () => ControlMode;
    getControlTargetId: () => string | null;

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
    sendCommand: (targetDeviceId: string, command: RemoteCommand["command"], payload?: unknown) => void;
    transferPlayback: (toDeviceId: string, withState?: boolean) => void;
    becomeActivePlayer: () => void; // Transfer playback TO this device (will stop remote)
    goLocalMode: () => void; // Switch to local mode WITHOUT stopping remote playback
    controlDevice: (deviceId: string) => void; // Start controlling a remote device
    refreshDevices: () => void;
    setDeviceName: (name: string) => void;

    // Remote command handlers (set by audio controls)
    setOnRemoteCommand: (handler: (command: RemoteCommand) => void) => void;
    setOnBecomeActivePlayer: (handler: () => void) => void;
    setOnStopPlayback: (handler: () => void) => void;
    setOnStateRequest: (handler: () => void) => void;

    // State broadcasting
    broadcastState: (state: {
        isPlaying: boolean;
        currentTrack: RemoteDevice["currentTrack"];
        currentTime: number;
        volume: number;
        queue?: RemoteQueueItem[];
        queueIndex?: number;
    }) => void;
}

const RemotePlaybackContext = createContext<RemotePlaybackContextType | undefined>(undefined);

// Generate a unique device ID (browser ID + tab ID)
function getOrCreateDeviceId(): string {
    if (typeof window === "undefined") return "";
    return getCurrentDeviceId();
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
    const currentDeviceId = getCurrentDeviceId();
    const persisted = localStorage.getItem("lidify_active_player_id");
    const normalized = normalizeActivePlayerId(persisted, currentDeviceId);

    if (normalized !== persisted) {
        if (normalized) {
            localStorage.setItem("lidify_active_player_id", normalized);
        } else {
            localStorage.removeItem("lidify_active_player_id");
        }
    }

    return normalized;
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

// Get persisted control mode
function getPersistedControlMode(): { mode: ControlMode; targetId: string | null } {
    if (typeof window === "undefined") return { mode: "local", targetId: null };
    const stored = localStorage.getItem("lidify_control_mode");
    if (stored) {
        try {
            const parsed = JSON.parse(stored);
            if (parsed.mode === "local" || parsed.mode === "remote") {
                return { mode: parsed.mode, targetId: parsed.targetId || null };
            }
        } catch {
            // Invalid JSON, use default
        }
    }
    return { mode: "local", targetId: null };
}

// Persist control mode
function persistControlMode(mode: ControlMode, targetId: string | null) {
    if (typeof window === "undefined") return;
    localStorage.setItem("lidify_control_mode", JSON.stringify({ mode, targetId }));
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

    // Control mode state - persisted to localStorage
    const [controlMode, setControlModeState] = useState<ControlMode>(() => {
        if (typeof window === "undefined") return "local";
        return getPersistedControlMode().mode;
    });
    const [controlTargetId, setControlTargetIdState] = useState<string | null>(() => {
        if (typeof window === "undefined") return null;
        return getPersistedControlMode().targetId;
    });

    // Refs - defined early so they can be used in callbacks below
    const socketRef = useRef<Socket | null>(null);
    const heartbeatRef = useRef<NodeJS.Timeout | null>(null);
    const onRemoteCommandRef = useRef<((command: RemoteCommand) => void) | null>(null);
    const queuedRemoteCommandsRef = useRef<RemoteCommand[]>([]);
    const onBecomeActivePlayerRef = useRef<(() => void) | null>(null);
    const onStopPlaybackRef = useRef<(() => void) | null>(null);
    const onStateRequestRef = useRef<(() => void) | null>(null);

    // Ref for activePlayerId to avoid stale closures in callbacks
    // This ref is always kept in sync with state and can be read synchronously
    const activePlayerIdRef = useRef<string | null>(activePlayerId);
    // Ref for currentDeviceId as well
    const currentDeviceIdRef = useRef<string | null>(currentDeviceId);
    // Refs for control mode
    const controlModeRef = useRef<ControlMode>(controlMode);
    const controlTargetIdRef = useRef<string | null>(controlTargetId);
    
    // Sync refs with state (required by React Compiler)
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Intentional ref sync
    useEffect(() => {
        activePlayerIdRef.current = activePlayerId;
        currentDeviceIdRef.current = currentDeviceId;
        controlModeRef.current = controlMode;
        controlTargetIdRef.current = controlTargetId;
    });

    // Wrapper to persist controlMode/controlTargetId changes AND update refs immediately
    // This prevents race conditions where a click switches modes and the next action
    // still routes commands using stale controlModeRef/controlTargetIdRef.
    const setControlMode = useCallback((mode: ControlMode, targetId: string | null) => {
        controlModeRef.current = mode;
        controlTargetIdRef.current = targetId;
        setControlModeState(mode);
        setControlTargetIdState(targetId);
        persistControlMode(mode, targetId);
    }, []);

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

        activePlayerIdRef.current = id;
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
    
    // Sync isActivePlayerRef (must be in effect to satisfy React Compiler)
    useEffect(() => {
        isActivePlayerRef.current = isActivePlayer;
    }, [isActivePlayer]);

    // Getter functions that use refs - these can be called inside callbacks to get current values
    const getActivePlayerId = useCallback(() => activePlayerIdRef.current, []);
    const getIsActivePlayer = useCallback(() => isActivePlayerRef.current, []);
    const getControlMode = useCallback(() => controlModeRef.current, []);
    const getControlTargetId = useCallback(() => controlTargetIdRef.current, []);

    // Get the controlled device's state (for UI display when in remote control mode)
    // This uses controlTargetId (who we're controlling) rather than activePlayerId
    const activePlayerState = controlMode === "remote" && controlTargetId
        ? (() => {
            const controlledDevice = devices.find(d => d.deviceId === controlTargetId);
            if (!controlledDevice) return null;
            return {
                isPlaying: controlledDevice.isPlaying,
                currentTrack: controlledDevice.currentTrack,
                currentTime: controlledDevice.currentTime,
                volume: controlledDevice.volume,
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
        // Always use current origin and rely on frontend proxy path (/api/socket.io).
        // This keeps reverse-proxy setups working when only port 3030 is exposed.
        let wsUrl = "";
        if (typeof window !== "undefined") {
            wsUrl = window.location.origin;
        }

        console.log("[RemotePlayback] Connecting to WebSocket...");

        // Get JWT token for authentication
        const token = api.getToken();

        const socket = io(wsUrl, {
            path: "/api/socket.io",
            auth: {
                token: token, // Use JWT token for secure auth
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

            // If we're controlling a device that disappeared, reconcile control target.
            const currentMode = controlModeRef.current;
            const currentTarget = controlTargetIdRef.current;
            if (currentMode === "remote" && currentTarget) {
                const targetOnline = devicesWithCurrent.some(d => d.deviceId === currentTarget);
                if (!targetOnline) {
                    const currentActive = activePlayerIdRef.current;
                    const canControlActive =
                        !!currentActive &&
                        currentActive !== currentDeviceId &&
                        devicesWithCurrent.some(d => d.deviceId === currentActive);

                    if (canControlActive) {
                        setControlMode("remote", currentActive);
                    } else {
                        setControlMode("local", null);
                    }
                }
            }
        });

        // Handle remote commands
        socket.on("playback:remoteCommand", (command: RemoteCommand) => {
            const myControlMode = controlModeRef.current;
            const myActivePlayerId = activePlayerIdRef.current;
            const myDeviceId = currentDeviceIdRef.current;
            console.log("[RemotePlayback] Received remote command:", command.command, {
                fromDeviceId: command.fromDeviceId,
                myDeviceId,
                myControlMode,
                myActivePlayerId,
                isActivePlayer: myActivePlayerId === null || myActivePlayerId === myDeviceId,
                payloadKeys: command.payload ? Object.keys(command.payload) : [],
            });
            console.log("[RemotePlayback] remoteCommand STACK:", new Error().stack?.split('\n').slice(1, 5).join('\n'));
            if (onRemoteCommandRef.current) {
                onRemoteCommandRef.current(command);
                return;
            }

            queuedRemoteCommandsRef.current.push(command);
            if (queuedRemoteCommandsRef.current.length > 20) {
                queuedRemoteCommandsRef.current = queuedRemoteCommandsRef.current.slice(-20);
            }
        });

        // Handle state update broadcasts from other devices
        socket.on("playback:stateUpdate", (state: RemoteDevice) => {
            const myDeviceId = currentDeviceIdRef.current;
            const myControlMode = controlModeRef.current;
            console.log("[RemotePlayback] playback:stateUpdate received:", {
                fromDeviceId: state.deviceId,
                myDeviceId,
                myControlMode,
                isPlaying: state.isPlaying,
                trackTitle: state.currentTrack?.title,
                currentTime: state.currentTime?.toFixed(1),
            });
            // Update the device in our list
            // NOTE: This only updates the devices list for UI display
            // It does NOT trigger any playback actions - that's intentional
            setDevices(prev => prev.map(d =>
                d.deviceId === state.deviceId
                    ? { ...d, ...state, isCurrentDevice: d.deviceId === currentDeviceId }
                    : d
            ));
        });

        // Handle state request (another device wants our current state)
        socket.on("playback:stateRequest", () => {
            console.log("[RemotePlayback] State requested by another device");
            if (onStateRequestRef.current) {
                onStateRequestRef.current();
            }
        });

        // Handle active player changes
        socket.on("playback:activePlayer", (data: { deviceId: string | null }) => {
            // Use refs to get current values (avoid stale closures)
            const myDeviceId = currentDeviceIdRef.current;
            const previousActivePlayer = activePlayerIdRef.current;
            // Only consider ourselves "was active" if we were EXPLICITLY the active player
            // (not just because activePlayerId was null)
            const iWasActivePlayer = previousActivePlayer === myDeviceId;
            const iWillBeActivePlayer = data.deviceId === myDeviceId;

            console.log(`[RemotePlayback] Socket: playback:activePlayer received`);
            console.log(`[RemotePlayback]   Previous activePlayerId: ${previousActivePlayer}`);
            console.log(`[RemotePlayback]   New activePlayerId: ${data.deviceId}`);
            console.log(`[RemotePlayback]   This device: ${myDeviceId}`);
            console.log(`[RemotePlayback]   I was active: ${iWasActivePlayer}, I will be active: ${iWillBeActivePlayer}`);

            if (data.deviceId === null) {
                console.warn(`[RemotePlayback] WARNING: Received null activePlayerId from server!`);
            }

            setActivePlayerId(data.deviceId);

            // If we just became the active player
            if (iWillBeActivePlayer && !iWasActivePlayer) {
                // CRITICAL: When becoming active player, switch to local control mode
                // This ensures our UI controls ourselves, not some stale remote target
                console.log(`[RemotePlayback] This device is now active, switching to local control mode`);
                setControlMode("local", null);
                
                if (onBecomeActivePlayerRef.current) {
                    console.log(`[RemotePlayback] Calling onBecomeActivePlayer callback`);
                    onBecomeActivePlayerRef.current();
                }
            }

            // CRITICAL FIX: Only stop playback if:
            // 1. I WAS the active player (explicitly, not just null)
            // 2. I am being replaced by a DIFFERENT device
            // This prevents stopping when someone else switches to local mode
            if (iWasActivePlayer && !iWillBeActivePlayer && data.deviceId !== null) {
                if (onStopPlaybackRef.current) {
                    console.log(`[RemotePlayback] This device was active player and is being replaced, stopping playback`);
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
    const sendCommand = useCallback(
        (
            targetDeviceId: string,
            command: RemoteCommand["command"],
            payload?: unknown
        ) => {
        if (!socketRef.current?.connected) {
            console.warn("[RemotePlayback] Cannot send command - not connected");
            return;
        }

        console.log(`[RemotePlayback] sendCommand: ${command} -> ${targetDeviceId}`, payload ? { payloadKeys: Object.keys(payload) } : {});
        socketRef.current.emit("playback:command", {
            targetDeviceId,
            command,
            payload,
        });
    }, []);

    // Transfer playback to another device (and start controlling it)
    const transferPlayback = useCallback((toDeviceId: string, withState = true) => {
        if (!socketRef.current?.connected) {
            console.warn("[RemotePlayback] Cannot transfer - not connected");
            return;
        }

        console.log("[RemotePlayback] Transferring playback to:", toDeviceId);

        // Switch to remote control mode - we'll be controlling the target device
        setControlMode("remote", toDeviceId);

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

    // Become the active player (transfer playback TO this device - will stop remote)
    // Use this when you actually want to PLAY on this device
    const becomeActivePlayer = useCallback(() => {
        if (!currentDeviceId) {
            console.warn("[RemotePlayback] Cannot become active - no device ID");
            return;
        }

        console.log("[RemotePlayback] Becoming active player (will transfer playback here)");
        
        // Switch to local mode since we're now playing locally
        setControlMode("local", null);
        
        // Always set local state so playback works even without WebSocket
        setActivePlayerId(currentDeviceId);
        
        // Notify server if connected (non-blocking)
        if (socketRef.current?.connected) {
            socketRef.current.emit("playback:setActivePlayer", { deviceId: currentDeviceId });
        } else {
            console.warn("[RemotePlayback] WebSocket not connected - local state set, server not notified");
        }
    }, [currentDeviceId, setControlMode]);

    // Switch to local mode WITHOUT stopping remote playback
    // Use this when you want to stop remote controlling and just view/control local state
    const goLocalMode = useCallback(() => {
        console.log("[RemotePlayback] Switching to local mode (remote playback continues)");
        setControlMode("local", null);
        // NOTE: We do NOT change activePlayerId or emit anything to the server
        // The remote device continues playing undisturbed
    }, [setControlMode]);

    // Start controlling a remote device
    // This sets up remote control mode AND makes the target the active player
    // so that it broadcasts its state for us to display
    const controlDevice = useCallback((deviceId: string) => {
        console.log("[RemotePlayback] controlDevice() called:", deviceId);
        console.log("[RemotePlayback]   Previous controlMode:", controlModeRef.current);
        console.log("[RemotePlayback]   Previous controlTargetId:", controlTargetIdRef.current);
        console.log("[RemotePlayback]   Previous activePlayerId:", activePlayerIdRef.current);
        
        setControlMode("remote", deviceId);
        
        // CRITICAL: When controlling a device, make it the active player
        // This ensures the target device broadcasts its state continuously
        setActivePlayerId(deviceId);
        
        console.log("[RemotePlayback]   New controlMode: remote");
        console.log("[RemotePlayback]   New controlTargetId:", deviceId);
        console.log("[RemotePlayback]   New activePlayerId:", deviceId);
        
        // Notify server and request current state
        if (socketRef.current?.connected) {
            // Tell server this device is now the active player
            socketRef.current.emit("playback:setActivePlayer", { deviceId });
            // Request current state from the target device
            console.log("[RemotePlayback] Requesting state from target device:", deviceId);
            socketRef.current.emit("playback:requestState", { deviceId });
        }
    }, [setControlMode, setActivePlayerId]);

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
        queue?: RemoteQueueItem[];
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

        if (queuedRemoteCommandsRef.current.length > 0) {
            const queuedCommands = queuedRemoteCommandsRef.current;
            queuedRemoteCommandsRef.current = [];
            for (const command of queuedCommands) {
                handler(command);
            }
        }
    }, []);

    // Callback when this device becomes active player
    const setOnBecomeActivePlayer = useCallback((handler: () => void) => {
        onBecomeActivePlayerRef.current = handler;
    }, []);

    // Callback when this device should stop playback (another device took over)
    const setOnStopPlayback = useCallback((handler: () => void) => {
        onStopPlaybackRef.current = handler;
    }, []);

    // Callback when another device requests our current state
    const setOnStateRequest = useCallback((handler: () => void) => {
        onStateRequestRef.current = handler;
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
                controlMode,
                controlTargetId,
                getControlMode,
                getControlTargetId,
                getActivePlayerId,
                getIsActivePlayer,
                activePlayerState,
                sendCommand,
                transferPlayback,
                becomeActivePlayer,
                goLocalMode,
                controlDevice,
                refreshDevices,
                setDeviceName,
                setOnRemoteCommand,
                setOnBecomeActivePlayer,
                setOnStopPlayback,
                setOnStateRequest,
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
