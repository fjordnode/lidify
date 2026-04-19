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
    Pencil,
    X,
    Cast,
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
        controlMode,
        controlTargetId,
        goLocalMode,
        controlDevice,
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
    // Is this device currently being controlled (in remote mode)?
    const isControllingRemote = controlMode === "remote" && controlTargetId !== null;
    // Which device are we controlling?
    const controlledDevice = isControllingRemote 
        ? devices.find(d => d.deviceId === controlTargetId) 
        : null;

    // Handle device click
    const handleDeviceClick = (device: RemoteDevice) => {
        if (device.deviceId === currentDeviceId) {
            // Clicking on THIS device
            if (isControllingRemote) {
                // Currently controlling remote - switch to local mode
                // This does NOT transfer playback, just stops remote controlling
                goLocalMode();
            }
            // If already in local mode, do nothing (could add "already local" feedback)
            setIsOpen(false);
            return;
        }

        // Clicking on ANOTHER device - start controlling it
        // This doesn't transfer playback, just sets up remote control mode
        controlDevice(device.deviceId);
        setIsOpen(false);
    };

    return (
        <div className={cn("relative", className)} ref={dropdownRef}>
            {/* Trigger Button */}
            <button
                onClick={() => setIsOpen(!isOpen)}
                className={cn(
                    "flex items-center gap-1.5 transition-colors rounded p-1.5",
                    isConnected
                        ? isControllingRemote
                            ? "text-green-500 hover:text-green-400" // Green when controlling remote (selected)
                            : "text-gray-400 hover:text-white"
                        : "text-gray-500 hover:text-gray-400",
                    compact && "p-1"
                )}
                title={isConnected
                    ? isControllingRemote && controlledDevice
                        ? `Controlling: ${controlledDevice.deviceName}`
                        : `Connected devices (${devices.length})`
                    : "Connecting to remote playback..."
                }
            >
                {isConnected ? (
                    <>
                        <Speaker className={cn("w-4 h-4", compact && "w-3.5 h-3.5")} />
                        {!compact && otherDevices.length > 0 && (
                            <span className={cn(
                                "text-xs rounded-full px-1.5 py-0.5 min-w-[18px] text-center",
                                isControllingRemote ? "bg-green-500/30" : "bg-gray-700"
                            )}>
                                {devices.length}
                            </span>
                        )}
                    </>
                ) : (
                    <WifiOff className={cn("w-4 h-4", compact && "w-3.5 h-3.5")} />
                )}
            </button>

            {/* Controlled device indicator - shows below button when controlling remote */}
            {isControllingRemote && controlledDevice && !compact && (
                <div className="absolute top-full left-1/2 -translate-x-1/2 mt-0.5 flex items-center gap-1 text-green-500 whitespace-nowrap pointer-events-none">
                    <Cast className="w-2.5 h-2.5" />
                    <span className="text-[10px] font-medium max-w-[80px] truncate">
                        {controlledDevice.deviceName}
                    </span>
                </div>
            )}

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
                                        // This device is SELECTED (in local mode = controlling itself)
                                        const isSelected = controlMode === "local";
                                        // This device is actually playing audio
                                        const isThisDevicePlaying = device.isPlaying;
                                        return (
                                            <div
                                                key={device.deviceId}
                                                className={cn(
                                                    "w-full px-4 py-3 flex items-center gap-3 text-left transition-colors cursor-pointer",
                                                    isSelected
                                                        ? "bg-green-500/10 border-l-2 border-green-500"
                                                        : "bg-gray-800/30 hover:bg-gray-800/50"
                                                )}
                                            >
                                                <button
                                                    onClick={() => handleDeviceClick(device)}
                                                    className={cn(
                                                        "w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0",
                                                        isSelected
                                                            ? "bg-green-500/20"
                                                            : "bg-gray-700 hover:bg-gray-600"
                                                    )}
                                                    title={isSelected ? "Selected" : "Switch to local mode"}
                                                >
                                                    <Icon className={cn(
                                                        "w-4 h-4",
                                                        isSelected ? "text-green-500" : "text-gray-400"
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
                                                                    isSelected ? "text-green-500" : "text-white"
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
                                                                {isSelected && (
                                                                    <Check className="w-4 h-4 text-green-500 flex-shrink-0" />
                                                                )}
                                                            </>
                                                        )}
                                                    </div>
                                                    <p className="text-xs text-gray-500">
                                                        This device {isThisDevicePlaying && "• Playing"}
                                                    </p>
                                                </div>
                                                {isThisDevicePlaying && (
                                                    <Volume2 className="w-4 h-4 text-white animate-pulse" />
                                                )}
                                            </div>
                                        );
                                    })}

                                {/* Other Devices */}
                                {otherDevices.map(device => {
                                    const Icon = getDeviceIcon(device.deviceName);
                                    // Is this device SELECTED (being controlled by us)?
                                    const isSelected = controlMode === "remote" && controlTargetId === device.deviceId;
                                    const isDevicePlaying = device.isPlaying;
                                    return (
                                        <button
                                            key={device.deviceId}
                                            onClick={() => handleDeviceClick(device)}
                                            className={cn(
                                                "w-full px-4 py-3 flex items-center gap-3 hover:bg-gray-800 transition-colors text-left cursor-pointer",
                                                isSelected && "bg-green-500/10 border-l-2 border-green-500"
                                            )}
                                        >
                                            <div className={cn(
                                                "w-8 h-8 rounded-full flex items-center justify-center",
                                                isSelected
                                                    ? "bg-green-500/20"
                                                    : "bg-gray-700"
                                            )}>
                                                <Icon className={cn(
                                                    "w-4 h-4",
                                                    isSelected ? "text-green-500" : "text-gray-400"
                                                )} />
                                            </div>
                                            <div className="flex-1 min-w-0">
                                                <div className="flex items-center gap-2">
                                                    <p className={cn(
                                                        "text-sm font-medium truncate",
                                                        isSelected ? "text-green-500" : "text-white"
                                                    )}>
                                                        {device.deviceName}
                                                    </p>
                                                    {isSelected && (
                                                        <Check className="w-4 h-4 text-green-500 flex-shrink-0" />
                                                    )}
                                                </div>
                                                {device.currentTrack ? (
                                                    <p className="text-xs text-gray-500 truncate">
                                                        {device.currentTrack.title} • {device.currentTrack.artist}
                                                    </p>
                                                ) : null}
                                            </div>
                                            {isDevicePlaying && (
                                                <Volume2 className="w-4 h-4 text-white animate-pulse" />
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
