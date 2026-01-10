import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { prisma } from "../utils/db";
import { z } from "zod";

const router = Router();

router.use(requireAuth);

const playSchema = z.object({
    trackId: z.string(),
    playedSeconds: z.number().min(0).optional(),
});

// POST /plays
router.post("/", async (req, res) => {
    try {
        const userId = req.session.userId!;
        const { trackId, playedSeconds } = playSchema.parse(req.body);
        const minPlaySeconds = 30;
        const effectivePlayedSeconds = playedSeconds ?? 0;

        // Verify track exists
        const track = await prisma.track.findUnique({
            where: { id: trackId },
        });

        if (!track) {
            return res.status(404).json({ error: "Track not found" });
        }

        if (effectivePlayedSeconds < minPlaySeconds) {
            return res.json({ skipped: true });
        }

        const recentPlay = await prisma.play.findFirst({
            where: {
                userId,
                trackId,
                playedAt: { gte: new Date(Date.now() - minPlaySeconds * 1000) },
            },
            orderBy: { playedAt: "desc" },
        });

        if (recentPlay) {
            return res.json({ skipped: true });
        }

        const play = await prisma.play.create({
            data: {
                userId,
                trackId,
            },
        });

        res.json(play);
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res
                .status(400)
                .json({ error: "Invalid request", details: error.errors });
        }
        console.error("Create play error:", error);
        res.status(500).json({ error: "Failed to log play" });
    }
});

// GET /plays (recent plays for user)
router.get("/", async (req, res) => {
    try {
        const userId = req.session.userId!;
        const { limit = "50" } = req.query;

        const plays = await prisma.play.findMany({
            where: { userId },
            orderBy: { playedAt: "desc" },
            take: parseInt(limit as string, 10),
            include: {
                track: {
                    include: {
                        album: {
                            include: {
                                artist: {
                                    select: {
                                        id: true,
                                        name: true,
                                        mbid: true,
                                    },
                                },
                            },
                        },
                    },
                },
            },
        });

        res.json(plays);
    } catch (error) {
        console.error("Get plays error:", error);
        res.status(500).json({ error: "Failed to get plays" });
    }
});

export default router;
