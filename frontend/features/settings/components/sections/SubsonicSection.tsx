"use client";

import { useState, useEffect } from "react";
import { SettingsSection, SettingsRow, SettingsInput } from "../ui";
import { InlineStatus, StatusType } from "@/components/ui/InlineStatus";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";

interface ApiKey {
    id: string;
    name: string;
    createdAt: string;
    lastUsed: string | null;
}

export function SubsonicSection() {
    const { user } = useAuth();
    const [password, setPassword] = useState("");
    const [hasPassword, setHasPassword] = useState(false);
    const [isEditing, setIsEditing] = useState(false);
    const [passwordStatus, setPasswordStatus] = useState<StatusType>("idle");
    const [passwordMessage, setPasswordMessage] = useState("");
    const [saving, setSaving] = useState(false);
    const [serverUrl, setServerUrl] = useState("");
    const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
    const [loadingApiKeys, setLoadingApiKeys] = useState(false);
    const [deviceName, setDeviceName] = useState("");
    const [generatingToken, setGeneratingToken] = useState(false);
    const [generatedToken, setGeneratedToken] = useState<string | null>(null);
    const [tokenStatus, setTokenStatus] = useState<StatusType>("idle");
    const [tokenMessage, setTokenMessage] = useState("");
    const [revokingId, setRevokingId] = useState<string | null>(null);

    useEffect(() => {
        api.request<{ hasPassword: boolean }>("/auth/subsonic-password")
            .then((data) => setHasPassword(data.hasPassword))
            .catch(() => {});

        if (typeof window !== "undefined") {
            setServerUrl(window.location.origin);
        }

        void loadApiKeys();
    }, []);

    const loadApiKeys = async () => {
        try {
            setLoadingApiKeys(true);
            const response = await api.listApiKeys();
            setApiKeys(response.apiKeys);
        } catch {
            // Non-fatal: token list stays empty.
        } finally {
            setLoadingApiKeys(false);
        }
    };

    const copyToClipboard = async (value: string) => {
        try {
            await navigator.clipboard.writeText(value);
            setTokenStatus("success");
            setTokenMessage("Copied");
        } catch {
            setTokenStatus("error");
            setTokenMessage("Copy failed");
        }
    };

    const formatDate = (value: string) =>
        new Date(value).toLocaleDateString(undefined, {
            year: "numeric",
            month: "short",
            day: "numeric",
        });

    const handleSave = async () => {
        if (!password.trim()) {
            setPasswordStatus("error");
            setPasswordMessage("Password required");
            return;
        }
        if (password.length < 4) {
            setPasswordStatus("error");
            setPasswordMessage("Min 4 characters");
            return;
        }

        setSaving(true);
        setPasswordStatus("loading");
        try {
            await api.request("/auth/subsonic-password", {
                method: "POST",
                body: JSON.stringify({ password }),
            });
            setPasswordStatus("success");
            setPasswordMessage("Saved");
            setHasPassword(true);
            setPassword("");
            setIsEditing(false);
        } catch (err: unknown) {
            setPasswordStatus("error");
            setPasswordMessage(err instanceof Error ? err.message : "Failed");
        }
        setSaving(false);
    };

    const handleClear = async () => {
        setSaving(true);
        try {
            await api.request("/auth/subsonic-password", { method: "DELETE" });
            setHasPassword(false);
            setPassword("");
            setPasswordStatus("success");
            setPasswordMessage("Cleared");
        } catch {
            setPasswordStatus("error");
            setPasswordMessage("Failed");
        }
        setSaving(false);
    };

    const handleGenerateToken = async () => {
        const trimmedName = deviceName.trim() || "Subsonic Client";
        setGeneratingToken(true);
        setGeneratedToken(null);
        setTokenStatus("loading");
        setTokenMessage("");

        try {
            const response = await api.createApiKey(trimmedName);
            setGeneratedToken(response.apiKey);
            setDeviceName("");
            setTokenStatus("success");
            setTokenMessage("Token generated");
            await loadApiKeys();
        } catch (err: unknown) {
            setTokenStatus("error");
            setTokenMessage(err instanceof Error ? err.message : "Failed to generate token");
        } finally {
            setGeneratingToken(false);
        }
    };

    const handleRevokeToken = async (id: string) => {
        setRevokingId(id);
        try {
            await api.revokeApiKey(id);
            setApiKeys((prev) => prev.filter((key) => key.id !== id));
        } catch (err: unknown) {
            setTokenStatus("error");
            setTokenMessage(err instanceof Error ? err.message : "Failed to revoke token");
        } finally {
            setRevokingId(null);
        }
    };

    return (
        <SettingsSection
            id="subsonic"
            title="Subsonic"
            description="Connect Subsonic-compatible apps like Symfonium, DSub, or Ultrasonic. Use your Lidify username with either a Subsonic password or a generated API token."
        >
            <SettingsRow
                label="Server URL"
                description="Use this server URL in your client."
            >
                <div className="flex items-center gap-2 min-w-0">
                    <code className="flex-1 min-w-0 truncate rounded-md bg-[#333] px-3 py-2 text-sm text-white">
                        {serverUrl || "Loading..."}
                    </code>
                    {serverUrl && (
                        <button
                            onClick={() => copyToClipboard(serverUrl)}
                            className="px-3 py-2 text-sm text-gray-400 hover:text-white transition-colors"
                        >
                            Copy
                        </button>
                    )}
                </div>
            </SettingsRow>

            <SettingsRow
                label="Username"
                description="Use your Lidify username in the client."
            >
                <span className="text-sm text-white">{user?.username}</span>
            </SettingsRow>

            <SettingsRow
                label="Subsonic Password"
                description={
                    hasPassword && !isEditing
                        ? "Password is configured. Click to change."
                        : "Set a separate password for Subsonic apps (different from your login)"
                }
                htmlFor="subsonic-password"
            >
                <div className="flex items-center gap-2">
                    {hasPassword && !isEditing ? (
                        <>
                            <input
                                id="subsonic-password"
                                type="text"
                                value="••••••••"
                                disabled
                                className="w-48 bg-[#333] text-white text-sm px-3 py-2 rounded-md border-0 outline-none opacity-50 cursor-not-allowed"
                            />
                            <button
                                onClick={() => setIsEditing(true)}
                                className="px-3 py-2 text-sm text-gray-400 hover:text-white transition-colors"
                            >
                                Change
                            </button>
                            <button
                                onClick={handleClear}
                                disabled={saving}
                                className="px-3 py-2 text-sm text-gray-400 hover:text-white transition-colors"
                            >
                                Clear
                            </button>
                        </>
                    ) : (
                        <>
                            <SettingsInput
                                id="subsonic-password"
                                type="password"
                                value={password}
                                onChange={setPassword}
                                placeholder="Enter password"
                                className="w-48"
                            />
                            <button
                                onClick={handleSave}
                                disabled={!password.trim() || saving}
                                className="px-4 py-2 text-sm bg-white text-black rounded-md font-medium
                                    hover:bg-gray-200 transition-colors
                                    disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                {saving ? "Saving..." : "Save"}
                            </button>
                            {hasPassword && (
                                <button
                                    onClick={() => {
                                        setIsEditing(false);
                                        setPassword("");
                                    }}
                                    className="px-3 py-2 text-sm text-gray-400 hover:text-white transition-colors"
                                >
                                    Cancel
                                </button>
                            )}
                        </>
                    )}
                    <InlineStatus
                        status={passwordStatus}
                        message={passwordMessage}
                        onClear={() => setPasswordStatus("idle")}
                    />
                </div>
            </SettingsRow>

            <SettingsRow
                label="API Token"
                description="Generate a client-specific token to use as the password in your app."
            >
                <div className="w-full space-y-3">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                        <SettingsInput
                            value={deviceName}
                            onChange={setDeviceName}
                            placeholder="Client name (e.g. Symfonium, DSub, Amperfy)"
                            className="sm:w-80"
                        />
                        <button
                            onClick={handleGenerateToken}
                            disabled={generatingToken}
                            className="px-4 py-2 text-sm bg-white text-black rounded-md font-medium
                                hover:bg-gray-200 transition-colors
                                disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            {generatingToken ? "Generating..." : "Generate Token"}
                        </button>
                    </div>
                    <InlineStatus
                        status={tokenStatus}
                        message={tokenMessage}
                        onClear={() => setTokenStatus("idle")}
                    />
                </div>
            </SettingsRow>

            {generatedToken && (
                <div className="py-4 space-y-3 border-t border-b border-white/5">
                    <p className="text-sm text-amber-400">
                        Save this token now. It will not be shown again.
                    </p>
                    <div className="flex items-start gap-2 min-w-0">
                        <code className="flex-1 min-w-0 break-all rounded-md bg-[#333] px-3 py-2 text-sm text-white">
                            {generatedToken}
                        </code>
                        <button
                            onClick={() => copyToClipboard(generatedToken)}
                            className="px-3 py-2 text-sm text-gray-400 hover:text-white transition-colors"
                        >
                            Copy
                        </button>
                    </div>
                    <div className="text-sm text-gray-400 space-y-1">
                        <p>1. Server URL: {serverUrl}</p>
                        <p>2. Username: {user?.username}</p>
                        <p>3. Password/API key: paste the token above</p>
                    </div>
                </div>
            )}

            {(loadingApiKeys || apiKeys.length > 0) && (
                <SettingsRow
                    label="Active Tokens"
                    description="Revoke a token to disconnect a client."
                >
                    <div className="w-full space-y-2">
                        {loadingApiKeys && apiKeys.length === 0 ? (
                            <div className="text-sm text-gray-400">Loading tokens...</div>
                        ) : (
                            apiKeys.map((key) => (
                                <div
                                    key={key.id}
                                    className="flex items-center justify-between gap-4 rounded-md bg-[#333] px-3 py-2"
                                >
                                    <div className="min-w-0">
                                        <p className="truncate text-sm text-white">{key.name}</p>
                                        <p className="text-xs text-gray-400">
                                            Created {formatDate(key.createdAt)}
                                            {key.lastUsed ? ` • Last used ${formatDate(key.lastUsed)}` : ""}
                                        </p>
                                    </div>
                                    <button
                                        onClick={() => handleRevokeToken(key.id)}
                                        disabled={revokingId === key.id}
                                        className="px-3 py-2 text-sm text-red-400 hover:text-red-300 transition-colors
                                            disabled:opacity-50 disabled:cursor-not-allowed"
                                    >
                                        {revokingId === key.id ? "Revoking..." : "Revoke"}
                                    </button>
                                </div>
                            ))
                        )}
                    </div>
                </SettingsRow>
            )}
        </SettingsSection>
    );
}
