import axios, { AxiosInstance } from "axios";
import { config } from "../config";
import { getSystemSettings } from "../utils/systemSettings";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

interface PlaylistTrack {
    artistName: string;
    albumTitle?: string;
    trackTitle: string;
    reason?: string;
}

interface GeneratePlaylistParams {
    userId: string;
    topArtists: Array<{ name: string; playCount: number; genres: string[] }>;
    recentDiscoveries: string[];
    likedArtists: string[];
    dislikedArtists: string[];
    targetCount: number;
}

export interface SimilarArtistRecommendation {
    artistName: string;
    reason: string;
    startWith?: string;
}

interface GetSimilarArtistsParams {
    artistName: string;
    genres?: string[];
    albums?: Array<{ name: string; year?: number | null }>;
    userLibraryArtists?: string[];
}

export interface ChatMessage {
    role: "user" | "assistant";
    content: string;
}

export interface ArtistChatResponse {
    text: string;
    recommendations: SimilarArtistRecommendation[];
    model: string;
}

interface ArtistChatParams {
    artistName: string;
    genres?: string[];
    albums?: Array<{ name: string; year?: number | null }>;
    userLibraryArtists?: string[];
    messages: ChatMessage[];
    userMessage?: string;
}

export interface OpenRouterModel {
    id: string;
    name: string;
    description?: string;
    pricing: {
        prompt: string;
        completion: string;
    };
    context_length: number;
    top_provider?: {
        max_completion_tokens?: number;
    };
}

class OpenRouterService {
    private client: AxiosInstance;
    private apiKey: string;

    constructor() {
        this.apiKey = config.openrouter.apiKey;
        this.client = axios.create({
            baseURL: OPENROUTER_BASE_URL,
            timeout: 60000,
            headers: {
                Authorization: `Bearer ${this.apiKey}`,
                "Content-Type": "application/json",
                "HTTP-Referer": "https://lidify.app",
                "X-Title": "Lidify Music",
            },
        });
    }

    /**
     * Fetch available models from OpenRouter
     */
    async getModels(): Promise<OpenRouterModel[]> {
        try {
            const response = await axios.get(`${OPENROUTER_BASE_URL}/models`, {
                headers: {
                    Authorization: `Bearer ${this.apiKey}`,
                },
            });

            // Sort by name for easier browsing
            const models = response.data.data || [];
            return models.sort((a: OpenRouterModel, b: OpenRouterModel) =>
                a.name.localeCompare(b.name)
            );
        } catch (error: any) {
            console.error("[OpenRouter] Failed to fetch models:", error.message);
            return [];
        }
    }

    async generateWeeklyPlaylist(
        params: GeneratePlaylistParams
    ): Promise<PlaylistTrack[]> {
        const {
            topArtists,
            recentDiscoveries,
            likedArtists,
            dislikedArtists,
            targetCount,
        } = params;

        const settings = await getSystemSettings();
        const model = settings?.openrouterModel || "openai/gpt-4o-mini";

        // Build context for AI
        const topArtistsText = topArtists
            .slice(0, 20)
            .map(
                (a) =>
                    `${a.name} (${a.playCount} plays, genres: ${a.genres.join(
                        ", "
                    )})`
            )
            .join("\n");

        const prompt = `You are a music curator creating a personalized "Discover Weekly" playlist.

USER'S LISTENING PROFILE:
Top Artists (last 90 days):
${topArtistsText}

Recent Discoveries (NEW artists to explore): ${recentDiscoveries.join(", ") || "None yet"}
Liked Artists: ${likedArtists.join(", ") || "None"}
Disliked Artists (NEVER recommend): ${dislikedArtists.join(", ") || "None"}

TASK:
Generate a ${targetCount}-track playlist with this breakdown:
- 25% (${Math.round(
            targetCount * 0.25
        )} tracks): From the user's top artists (1-2 tracks max per artist)
- 75% (${Math.round(
            targetCount * 0.75
        )} tracks): NEW discoveries from the "Recent Discoveries" list above

CRITICAL REQUIREMENTS:
1. PRIORITIZE new artists from the "Recent Discoveries" list - this is the main goal
2. Include only 1-2 well-known tracks from the user's top artists as "familiar anchors"
3. For new discoveries, choose popular, accessible tracks that will hook the listener
4. Maintain genre consistency with user's preferences
5. NEVER include artists from the "Disliked Artists" list
6. Variety of moods and tempos across the playlist

OUTPUT FORMAT (JSON):
{
  "tracks": [
    {
      "artistName": "Artist Name",
      "trackTitle": "Track Title",
      "reason": "Brief reason (e.g., 'Popular track from your favorite artist' or 'Similar to Jamiroquai')"
    }
  ]
}

Return ONLY valid JSON, no markdown formatting.`;

        try {
            const response = await this.createClient().post("/chat/completions", {
                model,
                messages: [
                    {
                        role: "system",
                        content:
                            "You are an expert music curator who creates personalized playlists based on listening history. You always respond with valid JSON only. Ensure all strings are properly escaped.",
                    },
                    {
                        role: "user",
                        content: prompt,
                    },
                ],
                max_tokens: 2000,
                temperature: 0.7,
            });

            const content = response.data.choices[0].message.content.trim();

            // Remove markdown code blocks if present
            let jsonContent = content;
            if (content.startsWith("```json")) {
                jsonContent = content
                    .replace(/```json\n?/g, "")
                    .replace(/```\n?/g, "")
                    .trim();
            } else if (content.startsWith("```")) {
                jsonContent = content.replace(/```\n?/g, "").trim();
            }

            const result = JSON.parse(jsonContent);

            return result.tracks || [];
        } catch (error: any) {
            console.error(
                "[OpenRouter] API error:",
                error.response?.data || error.message
            );

            if (error instanceof SyntaxError) {
                console.error("Failed to parse JSON response");
            }

            throw new Error("Failed to generate playlist with AI");
        }
    }

    async enhanceTrackRecommendation(
        track: { artist: string; title: string },
        userContext: string
    ): Promise<string> {
        const settings = await getSystemSettings();
        const model = settings?.openrouterModel || "openai/gpt-4o-mini";

        const prompt = `Given this track: "${track.title}" by ${track.artist}
User context: ${userContext}

Provide a single-sentence reason why this track would fit in their Discover Weekly playlist.
Be concise and engaging (max 15 words).`;

        try {
            const response = await this.createClient().post("/chat/completions", {
                model,
                messages: [
                    {
                        role: "system",
                        content:
                            "You write brief, engaging music recommendations.",
                    },
                    {
                        role: "user",
                        content: prompt,
                    },
                ],
                temperature: 0.7,
                max_tokens: 50,
            });

            return response.data.choices[0].message.content.trim();
        } catch (error) {
            console.error("[OpenRouter] enhancement error:", error);
            return "Recommended based on your listening history";
        }
    }

    /**
     * Get AI-powered similar artist recommendations
     * Uses cultural/aesthetic knowledge rather than just audio features
     */
    async getSimilarArtists(
        params: GetSimilarArtistsParams
    ): Promise<SimilarArtistRecommendation[]> {
        const { artistName, genres, albums, userLibraryArtists } = params;

        // API key from environment variable only (security best practice)
        const apiKey = config.openrouter.apiKey;
        if (!apiKey) {
            throw new Error("OpenRouter API key not configured. Set OPENROUTER_API_KEY environment variable.");
        }

        // Get model preference from database
        const settings = await getSystemSettings();
        const model = settings?.openrouterModel || "openai/gpt-4o-mini";

        // Build artist context
        const albumList = albums?.length
            ? albums
                  .slice(0, 10)
                  .map((a) => `${a.name}${a.year ? ` (${a.year})` : ""}`)
                  .join(", ")
            : "Unknown discography";

        const genreList = genres?.length ? genres.join(", ") : "Unknown genre";

        const libraryContext = userLibraryArtists?.length
            ? `\n\nUSER'S LIBRARY (${userLibraryArtists.length} artists, mark these as "inLibrary" if recommended):\n${userLibraryArtists.slice(0, 100).join(", ")}${userLibraryArtists.length > 100 ? "..." : ""}`
            : "";

        const prompt = `Recommend 8 artists similar to "${artistName}".

ARTIST CONTEXT:
- Name: ${artistName}
- Genres: ${genreList}
- Key albums: ${albumList}
${libraryContext}

GUIDELINES:
1. Focus on cultural/aesthetic lineage, not just "sounds like"
2. Include deep cuts and cult favorites, not just obvious choices
3. Reference specific albums when explaining why
4. Consider influences, contemporaries, and followers
5. Mix well-known names with lesser-known gems
6. Explain connections briefly but meaningfully

Return ONLY valid JSON in this exact format:
{
  "recommendations": [
    {
      "artistName": "Artist Name",
      "reason": "Brief explanation (1-2 sentences) of why they're similar",
      "startWith": "Best album to start with"
    }
  ]
}`;

        try {
            const client = this.createClient();

            const response = await client.post("/chat/completions", {
                model,
                messages: [
                    {
                        role: "system",
                        content:
                            "You are an expert music curator with deep knowledge of musical lineages, scenes, and cultural connections. You always respond with valid JSON only. No markdown, no explanation, just the JSON object.",
                    },
                    {
                        role: "user",
                        content: prompt,
                    },
                ],
                max_tokens: 1500,
                temperature: 0.7,
            });

            const content = response.data.choices[0].message.content.trim();

            // Parse JSON response
            let jsonContent = content;
            if (content.startsWith("```json")) {
                jsonContent = content
                    .replace(/```json\n?/g, "")
                    .replace(/```\n?/g, "")
                    .trim();
            } else if (content.startsWith("```")) {
                jsonContent = content.replace(/```\n?/g, "").trim();
            }

            const result = JSON.parse(jsonContent);
            return result.recommendations || [];
        } catch (error: any) {
            console.error(
                "[OpenRouter] getSimilarArtists error:",
                error.response?.data || error.message
            );
            throw new Error("Failed to get AI recommendations");
        }
    }

    /**
     * Conversational chat for artist recommendations
     * Maintains context across messages for refinement
     */
    async chatAboutArtist(params: ArtistChatParams): Promise<ArtistChatResponse> {
        const { artistName, genres, albums, userLibraryArtists, messages, userMessage } = params;

        // API key from environment variable only (security best practice)
        const apiKey = config.openrouter.apiKey;
        if (!apiKey) {
            throw new Error("OpenRouter API key not configured. Set OPENROUTER_API_KEY environment variable.");
        }

        // Get model preference from database
        const settings = await getSystemSettings();
        const model = settings?.openrouterModel || "openai/gpt-4o-mini";

        // Build artist context
        const albumList = albums?.length
            ? albums
                  .slice(0, 10)
                  .map((a) => `${a.name}${a.year ? ` (${a.year})` : ""}`)
                  .join(", ")
            : "Unknown discography";

        const genreList = genres?.length ? genres.join(", ") : "Unknown genre";

        const libraryContext = userLibraryArtists?.length
            ? `\n\nUSER'S LIBRARY (${userLibraryArtists.length} artists):\n${userLibraryArtists.slice(0, 50).join(", ")}${userLibraryArtists.length > 50 ? "..." : ""}`
            : "";

        const systemPrompt = `You are an expert music curator helping discover artists similar to ${artistName}.

ARTIST CONTEXT:
- Name: ${artistName}
- Genres: ${genreList}
- Key albums: ${albumList}
${libraryContext}

GUIDELINES:
1. Recommend 6-8 artists per response
2. Focus on cultural/aesthetic lineage, not just "sounds like"
3. Include deep cuts and cult favorites, not just obvious choices
4. Reference specific albums when explaining why
5. Consider influences, contemporaries, and followers
6. Respond to user's specific requests (era, style, mood, gender, etc.)
7. Keep your conversational text brief and engaging (1-3 sentences)

ALWAYS respond with valid JSON in this exact format:
{
  "text": "Your brief conversational response to the user",
  "recommendations": [
    {
      "artistName": "Artist Name",
      "reason": "Brief explanation (1-2 sentences)",
      "startWith": "Recommended album to start with"
    }
  ]
}

Include 6-8 recommendations. If the user's message doesn't warrant new recommendations (like "thanks"), you can return fewer or an empty array.`;

        try {
            const client = this.createClient();

            // Build message history for the API
            const apiMessages: Array<{ role: string; content: string }> = [
                { role: "system", content: systemPrompt },
            ];

            // Add conversation history
            for (const msg of messages) {
                apiMessages.push({
                    role: msg.role,
                    content: msg.content,
                });
            }

            // Add the new user message if provided
            if (userMessage) {
                apiMessages.push({ role: "user", content: userMessage });
            } else if (messages.length === 0) {
                // Initial request - ask for recommendations
                apiMessages.push({
                    role: "user",
                    content: "Recommend similar artists to explore.",
                });
            }

            const response = await client.post("/chat/completions", {
                model,
                messages: apiMessages,
                max_tokens: 1500,
                temperature: 0.7,
            });

            const content = response.data.choices[0].message.content.trim();

            // Parse JSON response
            let jsonContent = content;
            if (content.startsWith("```json")) {
                jsonContent = content.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
            } else if (content.startsWith("```")) {
                jsonContent = content.replace(/```\n?/g, "").trim();
            }

            const result = JSON.parse(jsonContent);
            return {
                text: result.text || "",
                recommendations: result.recommendations || [],
                model,
            };
        } catch (error: any) {
            console.error("[OpenRouter] chatAboutArtist error:", error.response?.data || error.message);
            throw new Error("Failed to get AI response");
        }
    }

    /**
     * Check if OpenRouter is configured and available
     * Returns true if: API key is set in env AND feature is enabled in settings
     */
    async isAvailable(): Promise<boolean> {
        // API key must be set via environment variable
        if (!config.openrouter.apiKey) {
            return false;
        }
        // Feature must be enabled in settings
        const settings = await getSystemSettings();
        return !!settings?.openrouterEnabled;
    }

    /**
     * Check if OpenRouter API key is configured (env var present)
     * Used by frontend to determine if the toggle should be enabled
     */
    isConfigured(): boolean {
        return !!config.openrouter.apiKey;
    }

    /**
     * Create a fresh axios client with current API key
     */
    private createClient(): AxiosInstance {
        return axios.create({
            baseURL: OPENROUTER_BASE_URL,
            timeout: 60000,
            headers: {
                Authorization: `Bearer ${config.openrouter.apiKey}`,
                "Content-Type": "application/json",
                "HTTP-Referer": "https://lidify.app",
                "X-Title": "Lidify Music",
            },
        });
    }
}

export const openRouterService = new OpenRouterService();
