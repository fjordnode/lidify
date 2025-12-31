# Plan: AI-Powered Similar Artist Recommendations

> **Status**: Ready for implementation
> **Start with**: Phase 1 (Basic Recommendations)
> **Existing code**: `backend/src/services/openai.ts` has unused OpenAI service scaffolding

## Overview

Add an AI-powered "Similar Artists" feature to artist pages that recommends artists based on cultural/aesthetic lineage, not just audio features. Clicking an artist name opens their page within Lidify (leveraging existing Last.fm integration) where users can browse albums and download via Lidarr.

## Why AI vs Essentia

| Aspect | Essentia ML | OpenAI/LLM |
|--------|-------------|------------|
| **Understands** | Audio features (tempo, energy, timbre) | Cultural context, influences, scenes |
| **Example** | "This track is dark and slow" | "This has the same Old Testament gothic Americana vibe as Nick Cave's Tupelo" |
| **Discovery** | Limited to your library | Can recommend artists you don't have |

## User Flow

```
1. User views artist page (e.g., Nick Cave and the Bad Seeds)
2. Clicks "AI Recommendations" button
3. Chat panel opens with initial recommendations + input field:

   ┌─────────────────────────────────────────────────┐
   │ AI Recommendations for Nick Cave               │
   │                                                 │
   │ ┌─────────────────────────────────────────────┐ │
   │ │ 🤖 Based on Nick Cave and the Bad Seeds,   │ │
   │ │ here are some artists you might enjoy:     │ │
   │ │                                             │ │
   │ │ 🎵 The Gun Club              [View →]      │ │
   │ │    "Blues-punk murder ballads"             │ │
   │ │                                             │ │
   │ │ 🎵 16 Horsepower             [View →]      │ │
   │ │    "Apocalyptic American gothic"           │ │
   │ │                                             │ │
   │ │ 🎵 Rowland S. Howard  ✓ In Library         │ │
   │ │    "Bad Seeds guitarist's solo work"       │ │
   │ └─────────────────────────────────────────────┘ │
   │                                                 │
   │ ┌─────────────────────────────────────────────┐ │
   │ │ 👤 I prefer the earlier, more aggressive   │ │
   │ │ stuff like From Her to Eternity            │ │
   │ └─────────────────────────────────────────────┘ │
   │                                                 │
   │ ┌─────────────────────────────────────────────┐ │
   │ │ 🤖 For that raw, chaotic Birthday Party    │ │
   │ │ era sound, try:                            │ │
   │ │                                             │ │
   │ │ 🎵 Swans (early)             [View →]      │ │
   │ │    "Filth and Cop era - brutal intensity"  │ │
   │ │                                             │ │
   │ │ 🎵 Einstürzende Neubauten    [View →]      │ │
   │ │    "Industrial chaos, Blixa's main band"   │ │
   │ └─────────────────────────────────────────────┘ │
   │                                                 │
   │ ┌─────────────────────────────────────────────┐ │
   │ │ Ask about this artist...              [➤]  │ │
   │ └─────────────────────────────────────────────┘ │
   └─────────────────────────────────────────────────┘
```

**Key interactions:**
- **Initial load** → AI provides general recommendations for the artist
- **Chat input** → User can refine: "more electronic", "less blues", "similar vocals"
- **[View →]** → Opens unified artist page in Lidify
- **✓ In Library** badge is informational only
- **Conversation context** → AI remembers previous messages for follow-ups

**Example prompts users might ask:**
- "I prefer their earlier, more aggressive stuff"
- "Something similar but more electronic"
- "What about female vocalists with a similar vibe?"
- "Less blues, more post-punk"
- "Who influenced them?"

## Technical Implementation

### Backend

#### 1. New Endpoint: `POST /api/artists/:id/ai-chat`

Conversational endpoint that maintains context across messages.

```typescript
// backend/src/routes/artists.ts

router.post("/:id/ai-chat", async (req, res) => {
    const { id } = req.params;
    const { message, conversationId } = req.body;

    // Get or create conversation from Redis
    const convKey = conversationId
        ? `ai-conv:${conversationId}`
        : `ai-conv:${crypto.randomUUID()}`;

    const existingConv = await redis.get(convKey);
    const messages = existingConv ? JSON.parse(existingConv) : [];

    // Get artist info for context
    const artist = await prisma.artist.findUnique({
        where: { id },
        include: {
            albums: { select: { name: true, year: true } },
            genres: true
        }
    });

    // Get user's library for "in library" badges
    const userArtists = await prisma.artist.findMany({
        select: { name: true, id: true }
    });

    // Build system prompt with artist context
    const systemPrompt = buildArtistSystemPrompt(artist, userArtists);

    // If first message, generate initial recommendations
    const userMessage = message || "Recommend similar artists";
    messages.push({ role: "user", content: userMessage });

    // Call OpenAI with conversation history
    const response = await openAIService.chat({
        systemPrompt,
        messages,
        responseFormat: "artist_recommendations"
    });

    messages.push({ role: "assistant", content: response.raw });

    // Save conversation (expire after 1 hour of inactivity)
    await redis.setex(convKey, 3600, JSON.stringify(messages));

    // Enrich recommendations with library status
    const enriched = await enrichWithLibraryStatus(response.recommendations);

    return res.json({
        conversationId: convKey.replace('ai-conv:', ''),
        message: response.text,
        recommendations: enriched
    });
});
```

#### 2. New OpenAI Service Method

```typescript
// backend/src/services/openai.ts

function buildArtistSystemPrompt(artist: Artist, userLibrary: string[]): string {
    return `You are an expert music curator helping users discover artists similar to ${artist.name}.

ARTIST CONTEXT:
- Name: ${artist.name}
- Genres: ${artist.genres?.map(g => g.name).join(", ") || "Unknown"}
- Albums in user's library: ${artist.albums?.map(a => `${a.name} (${a.year})`).join(", ") || "None"}

USER'S LIBRARY (${userLibrary.length} artists):
${userLibrary.slice(0, 50).join(", ")}${userLibrary.length > 50 ? '...' : ''}

GUIDELINES:
1. Focus on cultural/aesthetic lineage, not just "sounds like"
2. Include deep cuts and cult favorites, not just obvious choices
3. Reference specific albums when explaining why
4. Consider influences, contemporaries, and followers
5. Respond to user's specific requests (era, style, mood, etc.)

Always include artist recommendations in your response as JSON:
{
  "text": "Your conversational response",
  "recommendations": [
    {
      "artistName": "Artist Name",
      "reason": "Brief explanation (1-2 sentences)",
      "startWith": "Recommended album to start with"
    }
  ]
}`;
}

async chat(params: {
    systemPrompt: string;
    messages: Array<{ role: string; content: string }>;
}): Promise<{ text: string; recommendations: SimilarArtist[]; raw: string }> {

    const response = await this.client.post("/chat/completions", {
        model: config.openai.model || "gpt-3.5-turbo",
        messages: [
            { role: "system", content: params.systemPrompt },
            ...params.messages
        ],
        temperature: 0.7,
        response_format: { type: "json_object" }
    });

    const content = response.data.choices[0].message.content;
    const parsed = JSON.parse(content);

    return {
        text: parsed.text || "",
        recommendations: parsed.recommendations || [],
        raw: content
    };
}
```

#### 3. Library Status Enrichment

```typescript
async function enrichWithLibraryStatus(recommendations: SimilarArtist[]) {
    const artistNames = recommendations.map(r => r.artistName.toLowerCase());

    const inLibrary = await prisma.artist.findMany({
        where: {
            name: { in: artistNames, mode: 'insensitive' }
        },
        select: { id: true, name: true }
    });

    const libraryMap = new Map(inLibrary.map(a => [a.name.toLowerCase(), a.id]));

    return recommendations.map(rec => ({
        ...rec,
        inLibrary: libraryMap.has(rec.artistName.toLowerCase()),
        libraryId: libraryMap.get(rec.artistName.toLowerCase()) || null
    }));
}
```

### Frontend

#### 1. AIChatPanel Component

```typescript
// frontend/components/artist/AIChatPanel.tsx

interface Message {
    role: "user" | "assistant";
    content: string;
    recommendations?: SimilarArtist[];
}

export function AIChatPanel({ artistId, artistName }: Props) {
    const [messages, setMessages] = useState<Message[]>([]);
    const [input, setInput] = useState("");
    const [loading, setLoading] = useState(false);
    const [conversationId, setConversationId] = useState<string | null>(null);
    const [isOpen, setIsOpen] = useState(false);

    // Fetch initial recommendations when panel opens
    const initChat = async () => {
        setIsOpen(true);
        if (messages.length > 0) return; // Already initialized

        setLoading(true);
        try {
            const res = await api.post(`/artists/${artistId}/ai-chat`, {});
            setConversationId(res.data.conversationId);
            setMessages([{
                role: "assistant",
                content: res.data.message,
                recommendations: res.data.recommendations
            }]);
        } catch (err) {
            toast.error("Failed to get recommendations");
        } finally {
            setLoading(false);
        }
    };

    // Send follow-up message
    const sendMessage = async () => {
        if (!input.trim() || loading) return;

        const userMessage = input.trim();
        setInput("");
        setMessages(prev => [...prev, { role: "user", content: userMessage }]);
        setLoading(true);

        try {
            const res = await api.post(`/artists/${artistId}/ai-chat`, {
                message: userMessage,
                conversationId
            });
            setMessages(prev => [...prev, {
                role: "assistant",
                content: res.data.message,
                recommendations: res.data.recommendations
            }]);
        } catch (err) {
            toast.error("Failed to send message");
        } finally {
            setLoading(false);
        }
    };

    return (
        <>
            <Button onClick={initChat}>🤖 AI Recommendations</Button>

            {isOpen && (
                <div className="ai-chat-panel">
                    <div className="chat-header">
                        <h3>AI Recommendations for {artistName}</h3>
                        <button onClick={() => setIsOpen(false)}>✕</button>
                    </div>

                    <div className="chat-messages">
                        {messages.map((msg, i) => (
                            <ChatMessage key={i} message={msg} />
                        ))}
                        {loading && <LoadingIndicator />}
                    </div>

                    <div className="chat-input">
                        <input
                            value={input}
                            onChange={(e) => setInput(e.target.value)}
                            onKeyDown={(e) => e.key === "Enter" && sendMessage()}
                            placeholder="Ask about this artist..."
                        />
                        <button onClick={sendMessage} disabled={loading}>➤</button>
                    </div>
                </div>
            )}
        </>
    );
}
```

#### 2. ChatMessage Component

```typescript
// frontend/components/artist/ChatMessage.tsx

export function ChatMessage({ message }: { message: Message }) {
    return (
        <div className={`chat-message ${message.role}`}>
            <div className="message-content">
                {message.role === "assistant" && <span className="avatar">🤖</span>}
                {message.role === "user" && <span className="avatar">👤</span>}
                <p>{message.content}</p>
            </div>

            {message.recommendations?.length > 0 && (
                <div className="recommendations">
                    {message.recommendations.map(rec => (
                        <SimilarArtistCard key={rec.artistName} artist={rec} />
                    ))}
                </div>
            )}
        </div>
    );
}
```

#### 3. SimilarArtistCard Component

```typescript
// frontend/components/artist/SimilarArtistCard.tsx

export function SimilarArtistCard({ artist }: { artist: SimilarArtist }) {
    const href = artist.inLibrary
        ? `/artist/${artist.libraryId}`
        : `/artist/search/${encodeURIComponent(artist.artistName)}`;

    return (
        <div className="similar-artist-card">
            <div className="artist-info">
                <span className="artist-name">{artist.artistName}</span>
                {artist.inLibrary && <span className="badge">✓ In Library</span>}
                <p className="reason">{artist.reason}</p>
                {artist.startWith && (
                    <p className="start-with">Start with: {artist.startWith}</p>
                )}
            </div>
            <Link href={href}>
                <Button size="sm">View →</Button>
            </Link>
        </div>
    );
}
```

### Lidarr Integration

No new Lidarr code needed - the existing artist browse/discovery pages already have Lidarr integration for downloading albums. The AI recommendations just link to those existing pages.

## Cost Analysis

| Model | Input Cost | Output Cost | Per Request | Monthly (100 requests) |
|-------|------------|-------------|-------------|------------------------|
| GPT-4-turbo | $10/1M | $30/1M | ~$0.05 | $5 |
| GPT-3.5-turbo | $0.50/1M | $1.50/1M | ~$0.003 | $0.30 |

**Recommendation**: Start with GPT-3.5-turbo. It's good enough for artist recommendations and 15x cheaper. Upgrade to GPT-4 if quality is insufficient.

## Caching Strategy

- Cache key: `ai-similar:{artistId}:{styleHint}`
- TTL: 7 days (artist similarities don't change often)
- Invalidation: Manual only (no automatic invalidation needed)
- Storage: Redis (already in use)

## Files to Create/Modify

### New Files
- `frontend/components/artist/AIChatPanel.tsx` - Main chat panel component
- `frontend/components/artist/ChatMessage.tsx` - Individual message display
- `frontend/components/artist/SimilarArtistCard.tsx` - Artist recommendation card

### Modified Files
- `backend/src/routes/artists.ts` - Add `/ai-chat` endpoint
- `backend/src/services/openai.ts` - Add `chat` method and system prompt builder
- `frontend/app/artist/[id]/page.tsx` - Add AIChatPanel component

## Implementation Order

### Phase 1: Basic Recommendations (MVP)

Simple button → get recommendations → display cards

1. **Backend**
   - [ ] Add `getSimilarArtists` method to openai.ts (single request, no conversation)
   - [ ] Add `GET /artists/:id/ai-similar` endpoint
   - [ ] Add library status enrichment
   - [ ] Add Redis caching (7 day TTL)

2. **Frontend**
   - [ ] Create SimilarArtistCard component
   - [ ] Create AISimilarArtists component (button + results panel)
   - [ ] Add to artist page
   - [ ] Style the results

3. **Testing**
   - [ ] Test with various artists
   - [ ] Test View links navigate correctly
   - [ ] Verify "In Library" badge works
   - [ ] Test caching

### Phase 2: Chat Interface (Enhancement)

Add conversational refinement on top of Phase 1

1. **Backend**
   - [ ] Add `chat` method to openai.ts
   - [ ] Add `POST /artists/:id/ai-chat` endpoint
   - [ ] Add Redis conversation storage (1hr TTL)

2. **Frontend**
   - [ ] Create ChatMessage component
   - [ ] Upgrade to AIChatPanel component
   - [ ] Add input field and conversation UI

3. **Testing**
   - [ ] Test conversation context maintained
   - [ ] Test follow-up refinements work

## Future Enhancements

1. **Style selector**: "Similar to early Nick Cave" vs "Similar to recent Nick Cave"
2. **Chat interface**: Natural language queries on /discover page
3. **Playlist AI**: "Make me a playlist for a rainy Sunday afternoon"
4. **Why recommended**: Show AI reasoning in more detail
5. **Feedback loop**: "Not similar" button to improve recommendations

## Settings UI

Add to Settings > Integrations:

```
┌─ AI Recommendations ────────────────────────────┐
│                                                 │
│ OpenAI API Key: [••••••••••••••••] [Test]      │
│                                                 │
│ Model: [GPT-3.5-turbo ▾]                       │
│   ○ GPT-3.5-turbo (faster, cheaper)            │
│   ○ GPT-4-turbo (better quality)               │
│                                                 │
│ ☑ Enable AI Similar Artists                    │
│                                                 │
└─────────────────────────────────────────────────┘
```
