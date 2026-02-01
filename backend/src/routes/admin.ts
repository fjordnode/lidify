import { Router } from "express";
import { requireAuth, requireAdmin } from "../middleware/auth";
import {
    startGenreTagging,
    getGenreTaggingStatus,
} from "../services/genreTagger";

const router = Router();

router.use(requireAuth, requireAdmin);

/**
 * POST /admin/tag-genres
 * Trigger Last.fm genre tagging for albums (admin only)
 */
router.post("/tag-genres", async (req, res) => {
    try {
        const force = Boolean(req.body?.force);
        const status = startGenreTagging({ force });

        res.json({
            message: status.running
                ? "Genre tagging started"
                : "Genre tagging already running",
            status,
        });
    } catch (error: any) {
        console.error("Start genre tagging error:", error);
        res.status(500).json({ error: error.message || "Failed to start" });
    }
});

/**
 * GET /admin/tag-genres/status
 * Get genre tagging progress (admin only)
 */
router.get("/tag-genres/status", async (_req, res) => {
    try {
        res.json(getGenreTaggingStatus());
    } catch (error: any) {
        console.error("Genre tagging status error:", error);
        res.status(500).json({ error: error.message || "Failed to get status" });
    }
});

export default router;
