"use client";

import { useState, useEffect, useRef, useMemo } from "react";
import { SettingsSection, SettingsRow, SettingsInput, SettingsToggle } from "../ui";
import { SystemSettings } from "../../types";
import { InlineStatus, StatusType } from "@/components/ui/InlineStatus";
import { api, OpenRouterModel } from "@/lib/api";
import { Search, ChevronDown, X } from "lucide-react";

interface AIServicesSectionProps {
    settings: SystemSettings;
    onUpdate: (updates: Partial<SystemSettings>) => void;
    onTest: (service: string) => Promise<{ success: boolean; version?: string; error?: string }>;
    isTesting: boolean;
}

export function AIServicesSection({ settings, onUpdate, onTest, isTesting }: AIServicesSectionProps) {
    const [openrouterConfigured, setOpenrouterConfigured] = useState<boolean | null>(null);
    const [openrouterTestStatus, setOpenrouterTestStatus] = useState<StatusType>("idle");
    const [openrouterTestMessage, setOpenrouterTestMessage] = useState("");
    const [fanartTestStatus, setFanartTestStatus] = useState<StatusType>("idle");
    const [fanartTestMessage, setFanartTestMessage] = useState("");

    // Model dropdown state
    const [models, setModels] = useState<OpenRouterModel[]>([]);
    const [modelsLoading, setModelsLoading] = useState(false);
    const [isDropdownOpen, setIsDropdownOpen] = useState(false);
    const [searchQuery, setSearchQuery] = useState("");
    const dropdownRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);

    // Check if OpenRouter API key is configured on mount
    useEffect(() => {
        api.getOpenRouterStatus()
            .then(({ configured }) => setOpenrouterConfigured(configured))
            .catch(() => setOpenrouterConfigured(false));
    }, []);

    // Fetch models when dropdown is opened (lazy load)
    useEffect(() => {
        if (isDropdownOpen && models.length === 0 && !modelsLoading) {
            setModelsLoading(true);
            api.getOpenRouterModels()
                .then(({ models }) => setModels(models))
                .catch((err) => console.error("Failed to fetch models:", err))
                .finally(() => setModelsLoading(false));
        }
    }, [isDropdownOpen, models.length, modelsLoading]);

    // Close dropdown when clicking outside
    useEffect(() => {
        const handleClickOutside = (e: MouseEvent) => {
            if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
                setIsDropdownOpen(false);
            }
        };
        document.addEventListener("mousedown", handleClickOutside);
        return () => document.removeEventListener("mousedown", handleClickOutside);
    }, []);

    // Filter models based on search
    const filteredModels = useMemo(() => {
        if (!searchQuery.trim()) return models;
        const query = searchQuery.toLowerCase();
        return models.filter(
            (m) =>
                m.id.toLowerCase().includes(query) ||
                m.name.toLowerCase().includes(query)
        );
    }, [models, searchQuery]);

    // Get display name for currently selected model
    const selectedModelName = useMemo(() => {
        const model = models.find((m) => m.id === settings.openrouterModel);
        return model?.name || settings.openrouterModel || "Select a model";
    }, [models, settings.openrouterModel]);

    const handleOpenrouterTest = async () => {
        setOpenrouterTestStatus("loading");
        setOpenrouterTestMessage("Testing...");
        const result = await onTest("openrouter");
        if (result.success) {
            setOpenrouterTestStatus("success");
            setOpenrouterTestMessage("Connected");
        } else {
            setOpenrouterTestStatus("error");
            setOpenrouterTestMessage(result.error || "Failed");
        }
    };

    const handleFanartTest = async () => {
        setFanartTestStatus("loading");
        setFanartTestMessage("Testing...");
        const result = await onTest("fanart");
        if (result.success) {
            setFanartTestStatus("success");
            setFanartTestMessage("Connected");
        } else {
            setFanartTestStatus("error");
            setFanartTestMessage(result.error || "Failed");
        }
    };

    const handleSelectModel = (modelId: string) => {
        onUpdate({ openrouterModel: modelId });
        setIsDropdownOpen(false);
        setSearchQuery("");
    };

    return (
        <SettingsSection
            id="ai-services"
            title="AI & Enhancement Services"
            description="Configure AI recommendations and artwork enhancement"
        >
            {/* OpenRouter */}
            <SettingsRow
                label="Enable OpenRouter"
                description={
                    openrouterConfigured === false
                        ? "API key not configured"
                        : "AI-powered artist recommendations via OpenRouter"
                }
                htmlFor="openrouter-enabled"
            >
                <SettingsToggle
                    id="openrouter-enabled"
                    checked={settings.openrouterEnabled}
                    onChange={(checked) => onUpdate({ openrouterEnabled: checked })}
                    disabled={openrouterConfigured === false}
                />
            </SettingsRow>

            {/* Show configuration message if API key is not set */}
            {openrouterConfigured === false && (
                <div className="px-1 py-2 text-sm text-[#888]">
                    <p>
                        OpenRouter API key not configured. Add{" "}
                        <code className="px-1.5 py-0.5 bg-[#262626] rounded text-[#a3a3a3] font-mono text-xs">
                            OPENROUTER_API_KEY
                        </code>{" "}
                        to your environment variables and restart the container.
                    </p>
                </div>
            )}

            {/* Show model selector and test button when enabled and configured */}
            {settings.openrouterEnabled && openrouterConfigured && (
                <>
                    <SettingsRow
                        label="Model"
                        description="Choose from 200+ models (GPT, Claude, Gemini, Llama, etc.)"
                    >
                        <div ref={dropdownRef} className="relative w-80">
                            {/* Dropdown trigger */}
                            <button
                                type="button"
                                onClick={() => {
                                    setIsDropdownOpen(!isDropdownOpen);
                                    if (!isDropdownOpen) {
                                        setTimeout(() => inputRef.current?.focus(), 50);
                                    }
                                }}
                                className="w-full flex items-center justify-between px-3 py-2 bg-[#1a1a1a]
                                    border border-[#333] rounded-lg text-white text-sm
                                    hover:border-[#444] focus:outline-none focus:ring-1 focus:ring-white/20"
                            >
                                <span className="truncate">{selectedModelName}</span>
                                <ChevronDown className={`w-4 h-4 text-[#888] transition-transform ${isDropdownOpen ? 'rotate-180' : ''}`} />
                            </button>

                            {/* Dropdown panel */}
                            {isDropdownOpen && (
                                <div className="absolute z-50 mt-1 w-full bg-[#1a1a1a] border border-[#333]
                                    rounded-lg shadow-xl max-h-80 overflow-hidden">
                                    {/* Search input */}
                                    <div className="p-2 border-b border-[#333]">
                                        <div className="relative">
                                            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-[#666]" />
                                            <input
                                                ref={inputRef}
                                                type="text"
                                                value={searchQuery}
                                                onChange={(e) => setSearchQuery(e.target.value)}
                                                placeholder="Search models..."
                                                className="w-full pl-8 pr-8 py-1.5 bg-[#262626] border border-[#333]
                                                    rounded text-white text-sm placeholder-[#666]
                                                    focus:outline-none focus:ring-1 focus:ring-white/20"
                                            />
                                            {searchQuery && (
                                                <button
                                                    onClick={() => setSearchQuery("")}
                                                    className="absolute right-2 top-1/2 -translate-y-1/2 text-[#666] hover:text-white"
                                                >
                                                    <X className="w-4 h-4" />
                                                </button>
                                            )}
                                        </div>
                                    </div>

                                    {/* Model list */}
                                    <div className="overflow-y-auto max-h-60">
                                        {modelsLoading ? (
                                            <div className="px-3 py-4 text-center text-sm text-[#888]">
                                                Loading models...
                                            </div>
                                        ) : filteredModels.length === 0 ? (
                                            <div className="px-3 py-4 text-center text-sm text-[#888]">
                                                {searchQuery ? "No models found" : "No models available"}
                                            </div>
                                        ) : (
                                            filteredModels.map((model) => (
                                                <button
                                                    key={model.id}
                                                    onClick={() => handleSelectModel(model.id)}
                                                    className={`w-full px-3 py-2 text-left hover:bg-[#262626]
                                                        transition-colors ${
                                                            model.id === settings.openrouterModel
                                                                ? "bg-[#262626] border-l-2 border-white"
                                                                : ""
                                                        }`}
                                                >
                                                    <div className="text-sm text-white truncate">
                                                        {model.name}
                                                    </div>
                                                    <div className="text-xs text-[#666] truncate">
                                                        {model.id}
                                                    </div>
                                                </button>
                                            ))
                                        )}
                                    </div>
                                </div>
                            )}
                        </div>
                    </SettingsRow>

                    <div className="pt-2">
                        <div className="inline-flex items-center gap-3">
                            <button
                                onClick={handleOpenrouterTest}
                                disabled={isTesting}
                                className="px-4 py-1.5 text-sm bg-[#333] text-white rounded-full
                                    hover:bg-[#404040] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                            >
                                {openrouterTestStatus === "loading" ? "Testing..." : "Test Connection"}
                            </button>
                            <InlineStatus
                                status={openrouterTestStatus}
                                message={openrouterTestMessage}
                                onClear={() => setOpenrouterTestStatus("idle")}
                            />
                        </div>
                    </div>
                </>
            )}

            <div className="my-6 border-t border-[#262626]" />

            {/* Fanart.tv */}
            <SettingsRow
                label="Enable Fanart.tv"
                description="Enhanced artist and album artwork"
                htmlFor="fanart-enabled"
            >
                <SettingsToggle
                    id="fanart-enabled"
                    checked={settings.fanartEnabled}
                    onChange={(checked) => onUpdate({ fanartEnabled: checked })}
                />
            </SettingsRow>

            {settings.fanartEnabled && (
                <>
                    <SettingsRow label="API Key">
                        <SettingsInput
                            type="password"
                            value={settings.fanartApiKey}
                            onChange={(v) => onUpdate({ fanartApiKey: v })}
                            placeholder="Enter Fanart.tv API key"
                            className="w-64"
                        />
                    </SettingsRow>

                    <div className="pt-2">
                        <div className="inline-flex items-center gap-3">
                            <button
                                onClick={handleFanartTest}
                                disabled={isTesting || !settings.fanartApiKey}
                                className="px-4 py-1.5 text-sm bg-[#333] text-white rounded-full
                                    hover:bg-[#404040] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                            >
                                {fanartTestStatus === "loading" ? "Testing..." : "Test Connection"}
                            </button>
                            <InlineStatus
                                status={fanartTestStatus}
                                message={fanartTestMessage}
                                onClear={() => setFanartTestStatus("idle")}
                            />
                        </div>
                    </div>
                </>
            )}
        </SettingsSection>
    );
}
