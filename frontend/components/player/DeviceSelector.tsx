"use client";

import { useState, useRef, useEffect } from "react";
import { useRemotePlayback, RemoteDevice } from "@/lib/remote-playback-context";
import {
    Speaker,
    Smartphone,
    Monitor,
    Tv,
    Laptop,
    Check,
    Volume2,
    Wifi,
    WifiOff,
    Play,
    Pause,
    Pencil,
    X,
} from "lucide-react";
import { cn } from "@/utils/cn";

interface DeviceSelectorProps {
    className?: string;
    compact?: boolean;
}

function getDeviceIcon(deviceName: string) {
    const name = deviceName.toLowerCase();
    if (name.includes("tv") || name.includes("smart")) {
        return Tv;
    } else if (name.includes("phone") || name.includes("iphone") || name.includes("android")) {
        return Smartphone;
    } else if (name.includes("laptop") || name.includes("macbook")) {
        return Laptop;
    } else if (name.includes("pc") || name.includes("mac") || name.includes("linux") || name.includes("windows")) {
        return Monitor;
    }
    return Speaker;
}

export function DeviceSelector({ className, compact = false }: DeviceSelectorProps) {
    const {
        isConnected,
        devices,
        currentDeviceId,
        currentDeviceName,
        activePlayerId,
        isActivePlayer,
        sendCommand,
        transferPlayback,
        becomeActivePlayer,
        refreshDevices,
        setDeviceName,
    } = useRemotePlayback();

    const [isOpen, setIsOpen] = useState(false);
    const [isEditing, setIsEditing] = useState(false);
    const [editingName, setEditingName] = useState("");
    const dropdownRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);

    // Close dropdown when clicking outside
    useEffect(() => {
        function handleClickOutside(event: MouseEvent) {
            if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
                setIsOpen(false);
            }
        }

        document.addEventListener("mousedown", handleClickOutside);
        return () => document.removeEventListener("mousedown", handleClickOutside);
    }, []);

    // Refresh devices when dropdown opens
    useEffect(() => {
        if (isOpen) {
            refreshDevices();
        }
    }, [isOpen, refreshDevices]);

    // Focus input when editing starts
    useEffect(() => {
        if (isEditing && inputRef.current) {
            inputRef.current.focus();
            inputRef.current.select();
        }
    }, [isEditing]);

    // Start editing the device name
    const handleStartEdit = (e: React.MouseEvent) => {
        e.stopPropagation();
        setEditingName(currentDeviceName);
        setIsEditing(true);
    };

    // Save the new device name
    const handleSaveName = () => {
        const trimmedName = editingName.trim();
        if (trimmedName && trimmedName !== currentDeviceName) {
            setDeviceName(trimmedName);
        }
        setIsEditing(false);
    };

    // Cancel editing
    const handleCancelEdit = (e?: React.MouseEvent) => {
        e?.stopPropagation();
        setIsEditing(false);
        setEditingName("");
    };

    // Handle key events in the edit input
    const handleEditKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === "Enter") {
            handleSaveName();
        } else if (e.key === "Escape") {
            handleCancelEdit();
        }
    };

    // Find current device and other devices
    const otherDevices = devices.filter(d => d.deviceId !== currentDeviceId);
    const playingDevice = devices.find(d => d.isPlaying && d.deviceId !== currentDeviceId);

    // Handle device click - transfer playback or become active
    const handleDeviceClick = (device: RemoteDevice) => {
        if (device.deviceId === currentDeviceId) {
            // Clicking on this device - become the active player
            if (!isActivePlayer) {
                becomeActivePlayer();
            }
            setIsOpen(false);
            return;
        }

        // Transfer to another device
        transferPlayback(device.deviceId, true);
        setIsOpen(false);
    };

    // Handle play/pause on remote device
    const handleRemotePlayPause = (device: RemoteDevice, e: React.MouseEvent) => {
        e.stopPropagation();
        sendCommand(device.deviceId, device.isPlaying ? "pause" : "play");
    };

    return (
        <div className={cn("relative", className)} ref={dropdownRef}>
            {/* Trigger Button */}
            <button
                onClick={() => setIsOpen(!isOpen)}
                className={cn(
                    "flex items-center gap-1.5 transition-colors rounded p-1.5",
                    isConnected
                        ? playingDevice
                            ? "text-green-500 hover:text-green-400"
                            : "text-gray-400 hover:text-white"
                        : "text-gray-500 hover:text-gray-400",
                    compact && "p-1"
                )}
                title={isConnected
                    ? `Connected devices (${devices.length})`
                    : "Connecting to remote playback..."
                }
            >
                {isConnected ? (
                    <>
                        <Speaker className={cn("w-4 h-4", compact && "w-3.5 h-3.5")} />
                        {!compact && otherDevices.length > 0 && (
                            <span className="text-xs bg-gray-700 rounded-full px-1.5 py-0.5 min-w-[18px] text-center">
                                {devices.length}
                            </span>
                        )}
                    </>
                ) : (
                    <WifiOff className={cn("w-4 h-4", compact && "w-3.5 h-3.5")} />
                )}
            </button>

            {/* Dropdown */}
            {isOpen && (
                <div className="absolute bottom-full right-0 mb-2 w-72 bg-gray-900 border border-gray-700 rounded-lg shadow-xl z-50 overflow-hidden">
                    {/* Header */}
                    <div className="px-4 py-3 border-b border-gray-700">
                        <div className="flex items-center justify-between">
                            <h3 className="text-sm font-semibold text-white">Connect to a device</h3>
                            {isConnected ? (
                                <div className="flex items-center gap-1 text-green-500 text-xs">
                                    <Wifi className="w-3 h-3" />
                                    <span>Connected</span>
                                </div>
                            ) : (
                                <div className="flex items-center gap-1 text-gray-500 text-xs">
                                    <WifiOff className="w-3 h-3" />
                                    <span>Connecting...</span>
                                </div>
                            )}
                        </div>
                    </div>

                    {/* Device List */}
                    <div className="max-h-64 overflow-y-auto">
                        {devices.length === 0 ? (
                            <div className="px-4 py-6 text-center text-gray-500 text-sm">
                                No devices found
                            </div>
                        ) : (
                            <div className="py-1">
                                {/* Current Device */}
                                {devices
                                    .filter(d => d.deviceId === currentDeviceId)
                                    .map(device => {
                                        const Icon = getDeviceIcon(device.deviceName);
                                        const isThisDeviceActive = isActivePlayer;
                                        return (
                                            <div
                                                key={device.deviceId}
                                                className={cn(
                                                    "w-full px-4 py-3 flex items-center gap-3 text-left transition-colors",
                                                    isThisDeviceActive
                                                        ? "bg-gray-800/50"
                                                        : "bg-gray-800/30 hover:bg-gray-800/50"
                                                )}
                                            >
                                                <button
                                                    onClick={() => handleDeviceClick(device)}
                                                    className={cn(
                                                        "w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0",
                                                        isThisDeviceActive
                                                            ? "bg-green-500/20"
                                                            : "bg-gray-700"
                                                    )}
                                                >
                                                    <Icon className={cn(
                                                        "w-4 h-4",
                                                        isThisDeviceActive ? "text-green-500" : "text-gray-400"
                                                    )} />
                                                </button>
                                                <div className="flex-1 min-w-0" onClick={() => !isEditing && handleDeviceClick(device)}>
                                                    <div className="flex items-center gap-2">
                                                        {isEditing ? (
                                                            <div className="flex items-center gap-1 flex-1" onClick={e => e.stopPropagation()}>
                                                                <input
                                                                    ref={inputRef}
                                                                    type="text"
                                                                    value={editingName}
                                                                    onChange={e => setEditingName(e.target.value)}
                                                                    onKeyDown={handleEditKeyDown}
                                                                    onBlur={handleSaveName}
                                                                    className="text-sm font-medium bg-gray-700 text-white px-2 py-0.5 rounded border border-gray-600 focus:border-green-500 focus:outline-none w-full"
                                                                    maxLength={30}
                                                                />
                                                                <button
                                                                    onClick={handleCancelEdit}
                                                                    className="p-1 text-gray-400 hover:text-white"
                                                                >
                                                                    <X className="w-3 h-3" />
                                                                </button>
                                                            </div>
                                                        ) : (
                                                            <>
                                                                <p className={cn(
                                                                    "text-sm font-medium truncate",
                                                                    isThisDeviceActive ? "text-green-500" : "text-white"
                                                                )}>
                                                                    {device.deviceName}
                                                                </p>
                                                                <button
                                                                    onClick={handleStartEdit}
                                                                    className="p-1 text-gray-500 hover:text-white rounded transition-colors"
                                                                    title="Rename this device"
                                                                >
                                                                    <Pencil className="w-3 h-3" />
                                                                </button>
                                                                {isThisDeviceActive && (
                                                                    <Check className="w-4 h-4 text-green-500 flex-shrink-0" />
                                                                )}
                                                            </>
                                                        )}
                                                    </div>
                                                    <p className="text-xs text-gray-500">
                                                        {isThisDeviceActive
                                                            ? "This device • Playing"
                                                            : "This device • Click to play here"
                                                        }
                                                    </p>
                                                </div>
                                                {isThisDeviceActive && device.isPlaying && (
                                                    <Volume2 className="w-4 h-4 text-green-500 animate-pulse" />
                                                )}
                                            </div>
                                        );
                                    })}

                                {/* Other Devices */}
                                {otherDevices.map(device => {
                                    const Icon = getDeviceIcon(device.deviceName);
                                    return (
                                        <button
                                            key={device.deviceId}
                                            onClick={() => handleDeviceClick(device)}
                                            className="w-full px-4 py-3 flex items-center gap-3 hover:bg-gray-800 transition-colors text-left"
                                        >
                                            <div className={cn(
                                                "w-8 h-8 rounded-full flex items-center justify-center",
                                                device.isPlaying
                                                    ? "bg-green-500/20"
                                                    : "bg-gray-700"
                                            )}>
                                                <Icon className={cn(
                                                    "w-4 h-4",
                                                    device.isPlaying ? "text-green-500" : "text-gray-400"
                                                )} />
                                            </div>
                                            <div className="flex-1 min-w-0">
                                                <p className={cn(
                                                    "text-sm font-medium truncate",
                                                    device.isPlaying ? "text-green-500" : "text-white"
                                                )}>
                                                    {device.deviceName}
                                                </p>
                                                {device.currentTrack && (
                                                    <p className="text-xs text-gray-500 truncate">
                                                        {device.currentTrack.title} • {device.currentTrack.artist}
                                                    </p>
                                                )}
                                            </div>
                                            {device.isPlaying && (
                                                <button
                                                    onClick={(e) => handleRemotePlayPause(device, e)}
                                                    className="w-8 h-8 rounded-full bg-white flex items-center justify-center hover:scale-105 transition-transform"
                                                >
                                                    <Pause className="w-4 h-4 text-black" />
                                                </button>
                                            )}
                                        </button>
                                    );
                                })}
                            </div>
                        )}
                    </div>

                    {/* Footer */}
                    <div className="px-4 py-2 border-t border-gray-700 bg-gray-800/50">
                        <p className="text-xs text-gray-500 text-center">
                            Control playback on any device
                        </p>
                    </div>
                </div>
            )}
        </div>
    );
}
