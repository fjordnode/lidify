"use client";

import { useState, useEffect } from "react";
import { SettingsSection, SettingsRow, SettingsInput } from "../ui";
import { InlineStatus, StatusType } from "@/components/ui/InlineStatus";
import { api } from "@/lib/api";

export function SubsonicSection() {
    const [password, setPassword] = useState("");
    const [hasPassword, setHasPassword] = useState(false);
    const [isEditing, setIsEditing] = useState(false);
    const [status, setStatus] = useState<StatusType>("idle");
    const [message, setMessage] = useState("");
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        api.request<{ hasPassword: boolean }>("/auth/subsonic-password")
            .then((data) => setHasPassword(data.hasPassword))
            .catch(() => {});
    }, []);

    const handleSave = async () => {
        if (!password.trim()) {
            setStatus("error");
            setMessage("Password required");
            return;
        }
        if (password.length < 4) {
            setStatus("error");
            setMessage("Min 4 characters");
            return;
        }

        setSaving(true);
        setStatus("loading");
        try {
            await api.request("/auth/subsonic-password", {
                method: "POST",
                body: JSON.stringify({ password }),
            });
            setStatus("success");
            setMessage("Saved");
            setHasPassword(true);
            setPassword("");
            setIsEditing(false);
        } catch (err: unknown) {
            setStatus("error");
            setMessage(err instanceof Error ? err.message : "Failed");
        }
        setSaving(false);
    };

    const handleClear = async () => {
        setSaving(true);
        try {
            await api.request("/auth/subsonic-password", { method: "DELETE" });
            setHasPassword(false);
            setPassword("");
            setStatus("success");
            setMessage("Cleared");
        } catch {
            setStatus("error");
            setMessage("Failed");
        }
        setSaving(false);
    };

    return (
        <SettingsSection
            id="subsonic"
            title="Subsonic"
            description="Connect Subsonic-compatible apps like Symfonium, DSub, or Ultrasonic. Use your Lidify username with the password below."
        >
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
                        status={status}
                        message={message}
                        onClear={() => setStatus("idle")}
                    />
                </div>
            </SettingsRow>
        </SettingsSection>
    );
}
