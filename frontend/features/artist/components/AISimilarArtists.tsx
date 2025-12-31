"use client";

import { useState, useRef, useEffect } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { Sparkles, X, Library, ChevronRight, Music, AlertCircle, Send, User, Bot, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { GradientSpinner } from "@/components/ui/GradientSpinner";
import { api } from "@/lib/api";
import { cn } from "@/utils/cn";

interface AISimilarArtist {
    artistName: string;
    reason: string;
    startWith?: string;
    inLibrary: boolean;
    libraryId: string | null;
    image: string | null;
}

interface ChatMessage {
    role: "user" | "assistant";
    content: string;
    text?: string;
    recommendations?: AISimilarArtist[];
}

interface AISimilarArtistsProps {
    artistId: string;
    artistName: string;
}

// Session storage key for caching conversations
const getStorageKey = (artistId: string) => `ai-chat:${artistId}`;

export function AISimilarArtists({ artistId, artistName }: AISimilarArtistsProps) {
    const router = useRouter();
    const [isOpen, setIsOpen] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [conversationId, setConversationId] = useState<string | null>(null);
    const [input, setInput] = useState("");
    const [modelName, setModelName] = useState<string | null>(null);
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);

    // Restore conversation from sessionStorage on mount
    useEffect(() => {
        try {
            const stored = sessionStorage.getItem(getStorageKey(artistId));
            if (stored) {
                const data = JSON.parse(stored);
                if (data.messages?.length > 0) {
                    setMessages(data.messages);
                    setConversationId(data.conversationId);
                    setModelName(data.model || null);
                }
            }
        } catch (err) {
            // Ignore storage errors
        }
    }, [artistId]);

    // Save conversation to sessionStorage when it changes
    useEffect(() => {
        if (messages.length > 0 && conversationId) {
            try {
                sessionStorage.setItem(getStorageKey(artistId), JSON.stringify({
                    conversationId,
                    messages,
                    model: modelName,
                }));
            } catch (err) {
                // Ignore storage errors
            }
        }
    }, [artistId, conversationId, messages, modelName]);

    // Scroll to bottom when messages change
    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [messages]);

    // Focus input when panel opens (desktop only - avoid keyboard popup on mobile)
    useEffect(() => {
        if (isOpen && messages.length > 0 && window.innerWidth >= 768) {
            inputRef.current?.focus();
        }
    }, [isOpen, messages.length]);

    const initChat = async (forceRefresh = false) => {
        setIsOpen(true);
        if (messages.length > 0 && !forceRefresh) return; // Already have cached messages

        if (forceRefresh) {
            // Clear session storage for this artist
            sessionStorage.removeItem(getStorageKey(artistId));
            setMessages([]);
            setConversationId(null);
            setModelName(null);
        }

        setLoading(true);
        setError(null);

        try {
            const response = await api.chatWithAI(artistId);
            setConversationId(response.conversationId);
            setModelName(response.model || null);
            setMessages([{
                role: "assistant",
                content: response.text,
                text: response.text,
                recommendations: response.recommendations,
            }]);
        } catch (err: any) {
            console.error("[AI Chat] Error:", err);
            setError(err.data?.message || err.message || "Failed to get recommendations");
        } finally {
            setLoading(false);
        }
    };

    const sendMessage = async () => {
        if (!input.trim() || loading) return;

        const userMessage = input.trim();
        setInput("");
        setMessages(prev => [...prev, { role: "user", content: userMessage }]);
        setLoading(true);

        try {
            const response = await api.chatWithAI(artistId, userMessage, conversationId || undefined);
            setConversationId(response.conversationId);
            if (response.model) setModelName(response.model);
            setMessages(prev => [...prev, {
                role: "assistant",
                content: response.text,
                text: response.text,
                recommendations: response.recommendations,
            }]);
        } catch (err: any) {
            console.error("[AI Chat] Error:", err);
            setMessages(prev => [...prev, {
                role: "assistant",
                content: "Sorry, I encountered an error. Please try again.",
            }]);
        } finally {
            setLoading(false);
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    };

    const handleNavigate = (artist: AISimilarArtist) => {
        if (artist.inLibrary && artist.libraryId) {
            router.push(`/artist/${artist.libraryId}`);
        } else {
            router.push(`/search?q=${encodeURIComponent(artist.artistName)}`);
        }
        setIsOpen(false);
    };

    return (
        <>
            {/* Trigger Button */}
            <Button
                variant="ai"
                onClick={() => initChat()}
                className="gap-2"
            >
                <Sparkles className="w-4 h-4" />
                <span className="hidden sm:inline">AI Recommendations</span>
            </Button>

            {/* Slide-over Panel */}
            {isOpen && (
                <div className="fixed inset-0 z-50 overflow-hidden">
                    {/* Backdrop */}
                    <div
                        className="absolute inset-0 bg-black/60 transition-opacity"
                        onClick={() => setIsOpen(false)}
                    />

                    {/* Panel */}
                    <div className="absolute inset-y-0 right-0 max-w-md w-full bg-gradient-to-br from-[#141414] to-[#0a0a0a] border-l border-[#262626] shadow-2xl flex flex-col">
                        {/* Header */}
                        <div className="flex items-center justify-between px-6 py-4 border-b border-[#1c1c1c]">
                            <div className="flex items-center gap-3">
                                <div className="w-8 h-8 rounded-full bg-brand/20 flex items-center justify-center">
                                    <Sparkles className="w-4 h-4 text-brand" />
                                </div>
                                <div>
                                    <h2 className="text-lg font-medium text-white">
                                        AI Recommendations
                                    </h2>
                                    <p className="text-sm text-gray-400">
                                        Based on {artistName}
                                    </p>
                                </div>
                            </div>
                            <div className="flex items-center gap-2">
                                {messages.length > 0 && !loading && (
                                    <button
                                        onClick={() => initChat(true)}
                                        title="Regenerate recommendations"
                                        className="w-8 h-8 flex items-center justify-center text-gray-400 hover:text-white hover:bg-white/10 rounded-full transition-colors"
                                    >
                                        <RefreshCw className="w-4 h-4" />
                                    </button>
                                )}
                                <button
                                    onClick={() => setIsOpen(false)}
                                    className="w-8 h-8 flex items-center justify-center text-gray-400 hover:text-white hover:bg-white/10 rounded-full transition-colors"
                                >
                                    <X className="w-5 h-5" />
                                </button>
                            </div>
                        </div>

                        {/* Model indicator */}
                        {modelName && (
                            <div className="px-6 py-1.5 bg-[#0a0a0a] border-b border-[#1c1c1c]">
                                <p className="text-[10px] text-gray-500 font-mono">
                                    {modelName}
                                </p>
                            </div>
                        )}

                        {/* Messages */}
                        <div className="flex-1 overflow-y-auto p-4 space-y-4">
                            {/* Initial loading state */}
                            {loading && messages.length === 0 && (
                                <div className="flex flex-col items-center justify-center py-12 gap-4">
                                    <GradientSpinner size="lg" />
                                    <p className="text-gray-400 text-sm">
                                        Finding similar artists...
                                    </p>
                                </div>
                            )}

                            {/* Error state */}
                            {error && messages.length === 0 && (
                                <div className="flex flex-col items-center justify-center py-12 gap-4 text-center">
                                    <div className="w-12 h-12 rounded-full bg-red-500/20 flex items-center justify-center">
                                        <AlertCircle className="w-6 h-6 text-red-400" />
                                    </div>
                                    <div>
                                        <p className="text-white font-medium mb-1">
                                            Couldn&apos;t get recommendations
                                        </p>
                                        <p className="text-gray-400 text-sm">
                                            {error}
                                        </p>
                                    </div>
                                    <Button
                                        variant="secondary"
                                        onClick={() => {
                                            setMessages([]);
                                            setError(null);
                                            initChat(true);
                                        }}
                                    >
                                        Try Again
                                    </Button>
                                </div>
                            )}

                            {/* Message history */}
                            {messages.map((msg, index) => (
                                <div key={index} className="space-y-3">
                                    {/* Message bubble */}
                                    <div className={cn(
                                        "flex gap-3",
                                        msg.role === "user" ? "justify-end" : "justify-start"
                                    )}>
                                        {msg.role === "assistant" && (
                                            <div className="w-7 h-7 rounded-full bg-brand/20 flex items-center justify-center flex-shrink-0">
                                                <Bot className="w-4 h-4 text-brand" />
                                            </div>
                                        )}
                                        <div className={cn(
                                            "rounded-2xl px-4 py-2 max-w-[85%]",
                                            msg.role === "user"
                                                ? "bg-brand text-black"
                                                : "bg-white/10 text-white"
                                        )}>
                                            <p className="text-sm">
                                                {msg.text || msg.content}
                                            </p>
                                        </div>
                                        {msg.role === "user" && (
                                            <div className="w-7 h-7 rounded-full bg-white/10 flex items-center justify-center flex-shrink-0">
                                                <User className="w-4 h-4 text-white" />
                                            </div>
                                        )}
                                    </div>

                                    {/* Recommendations for assistant messages */}
                                    {msg.role === "assistant" && msg.recommendations && msg.recommendations.length > 0 && (
                                        <div className="ml-10 space-y-2">
                                            {msg.recommendations.map((artist, i) => (
                                                <ArtistCard
                                                    key={`${artist.artistName}-${i}`}
                                                    artist={artist}
                                                    onNavigate={handleNavigate}
                                                />
                                            ))}
                                        </div>
                                    )}
                                </div>
                            ))}

                            {/* Loading indicator for follow-up messages */}
                            {loading && messages.length > 0 && (
                                <div className="flex gap-3">
                                    <div className="w-7 h-7 rounded-full bg-brand/20 flex items-center justify-center flex-shrink-0">
                                        <Bot className="w-4 h-4 text-brand" />
                                    </div>
                                    <div className="bg-white/10 rounded-2xl px-4 py-3">
                                        <div className="flex gap-1">
                                            <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
                                            <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
                                            <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
                                        </div>
                                    </div>
                                </div>
                            )}

                            {/* Input - inside scrollable area */}
                            {messages.length > 0 && !loading && (
                                <div className="pt-4 mt-2">
                                    <div className="flex gap-2">
                                        <input
                                            ref={inputRef}
                                            type="text"
                                            value={input}
                                            onChange={(e) => setInput(e.target.value)}
                                            onKeyDown={handleKeyDown}
                                            placeholder="Ask for more recommendations..."
                                            disabled={loading}
                                            className="flex-1 bg-white/5 border border-[#262626] rounded-full px-4 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-brand/50 disabled:opacity-50"
                                        />
                                        <button
                                            onClick={sendMessage}
                                            disabled={loading || !input.trim()}
                                            className="w-10 h-10 rounded-full bg-brand hover:bg-brand-hover disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center transition-colors"
                                        >
                                            <Send className="w-4 h-4 text-black" />
                                        </button>
                                    </div>
                                    <p className="text-xs text-gray-500 text-center mt-2">
                                        Try: &quot;more electronic&quot; or &quot;female vocalists&quot;
                                    </p>
                                </div>
                            )}

                            <div ref={messagesEndRef} />
                        </div>
                    </div>
                </div>
            )}
        </>
    );
}

interface ArtistCardProps {
    artist: AISimilarArtist;
    onNavigate: (artist: AISimilarArtist) => void;
}

function ArtistCard({ artist, onNavigate }: ArtistCardProps) {
    const imageUrl = artist.image ? api.getCoverArtUrl(artist.image, 200) : null;

    return (
        <div
            onClick={() => onNavigate(artist)}
            className={cn(
                "group flex items-start gap-3 p-3 rounded-lg cursor-pointer transition-all",
                "bg-white/5 hover:bg-white/10 border border-transparent hover:border-brand/20"
            )}
        >
            {/* Artist Image */}
            <div className="flex-shrink-0 w-12 h-12 bg-[#282828] rounded-full overflow-hidden relative">
                {imageUrl ? (
                    <Image
                        src={imageUrl}
                        alt={artist.artistName}
                        fill
                        sizes="48px"
                        className="object-cover"
                        unoptimized
                    />
                ) : (
                    <div className="w-full h-full flex items-center justify-center">
                        <Music className="w-5 h-5 text-gray-600" />
                    </div>
                )}
                {artist.inLibrary && (
                    <div
                        className="absolute -bottom-0.5 -right-0.5 bg-brand rounded-full p-0.5 border-2 border-[#141414]"
                        title="In your library"
                    >
                        <Library className="w-2 h-2 text-black" />
                    </div>
                )}
            </div>

            {/* Artist Info */}
            <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-0.5">
                    <h3 className="text-white font-medium text-sm truncate">
                        {artist.artistName}
                    </h3>
                    {artist.inLibrary && (
                        <span className="flex-shrink-0 text-[10px] px-1.5 py-0.5 rounded-full bg-brand/20 text-brand">
                            In Library
                        </span>
                    )}
                </div>
                <p className="text-xs text-gray-400 line-clamp-2">
                    {artist.reason}
                </p>
                {artist.startWith && (
                    <p className="text-[10px] text-gray-500 mt-0.5">
                        Start with: <span className="text-gray-400">{artist.startWith}</span>
                    </p>
                )}
            </div>

            {/* Navigate Arrow */}
            <div className="flex-shrink-0 self-center opacity-0 group-hover:opacity-100 transition-opacity">
                <ChevronRight className="w-4 h-4 text-gray-400" />
            </div>
        </div>
    );
}
