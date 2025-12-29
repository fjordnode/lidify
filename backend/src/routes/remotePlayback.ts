import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { getUserDevices, getDevice, activeDevices } from "../websocket/remotePlayback";

const router = Router();

// GET /remote-playback/devices - Get all active devices for the current user
router.get("/devices", requireAuth, async (req, res) => {
    try {
        const userId = req.user!.id;
        const devices = getUserDevices(userId).map(d => ({
            deviceId: d.deviceId,
            deviceName: d.deviceName,
            isPlaying: d.isPlaying,
            currentTrack: d.currentTrack,
            currentTime: d.currentTime,
            volume: d.volume,
            lastSeen: d.lastSeen,
        }));

        res.json(devices);
    } catch (error) {
        console.error("Get devices error:", error);
        res.status(500).json({ error: "Failed to get devices" });
    }
});

// GET /remote-playback/devices/:deviceId - Get specific device info
router.get("/devices/:deviceId", requireAuth, async (req, res) => {
    try {
        const userId = req.user!.id;
        const { deviceId } = req.params;

        const device = getDevice(deviceId);
        if (!device || device.userId !== userId) {
            return res.status(404).json({ error: "Device not found" });
        }

        res.json({
            deviceId: device.deviceId,
            deviceName: device.deviceName,
            isPlaying: device.isPlaying,
            currentTrack: device.currentTrack,
            currentTime: device.currentTime,
            volume: device.volume,
            lastSeen: device.lastSeen,
        });
    } catch (error) {
        console.error("Get device error:", error);
        res.status(500).json({ error: "Failed to get device" });
    }
});

// GET /remote-playback/status - Check if remote playback is available
router.get("/status", requireAuth, async (req, res) => {
    try {
        const userId = req.user!.id;
        const devices = getUserDevices(userId);

        res.json({
            available: true,
            connectedDevices: devices.length,
            activePlayback: devices.some(d => d.isPlaying),
        });
    } catch (error) {
        console.error("Get status error:", error);
        res.status(500).json({ error: "Failed to get status" });
    }
});

export default router;
