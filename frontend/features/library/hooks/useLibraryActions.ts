import { api } from "@/lib/api";
import { useAudio } from "@/lib/audio-context";
import { Track } from "../types";

// Helper to convert library Track to audio context Track format
const formatTrackForAudio = (track: Track) => ({
    id: track.id,
    title: track.title,
    duration: track.duration,
    artist: {
        id: track.album?.artist?.id,
        name: track.album?.artist?.name || "Unknown Artist",
    },
    album: {
        id: track.album?.id,
        title: track.album?.title || "Unknown Album",
        coverArt: track.album?.coverArt,
    },
});

export function useLibraryActions() {
    const { playTrack, playTracks, addToQueue } = useAudio();

    const playArtist = async (artistId: string) => {
        try {
            const albumsData = await api.getAlbums({ artistId });
            if (!albumsData.albums || albumsData.albums.length === 0) {
                return;
            }

            const firstAlbum = await api.getAlbum(albumsData.albums[0].id);
            if (
                !firstAlbum ||
                !firstAlbum.tracks ||
                firstAlbum.tracks.length === 0
            ) {
                return;
            }

            const tracksWithAlbum = firstAlbum.tracks.map((track: Record<string, unknown>) => ({
                ...track,
                album: {
                    id: firstAlbum.id,
                    title: firstAlbum.title,
                    coverArt: firstAlbum.coverArt || firstAlbum.coverUrl,
                },
                artist: {
                    id: firstAlbum.artist?.id,
                    name: firstAlbum.artist?.name,
                },
            }));

            playTracks(tracksWithAlbum, 0);
        } catch (error) {
            console.error("Error playing artist:", error);
        }
    };

    const playAlbum = async (albumId: string) => {
        try {
            const album = await api.getAlbum(albumId);
            if (!album || !album.tracks || album.tracks.length === 0) {
                return;
            }

            const tracksWithAlbum = album.tracks.map((track: Record<string, unknown>) => ({
                ...track,
                album: {
                    id: album.id,
                    title: album.title,
                    coverArt: album.coverArt || album.coverUrl,
                },
                artist: {
                    id: album.artist?.id,
                    name: album.artist?.name,
                },
            }));

            playTracks(tracksWithAlbum, 0);
        } catch (error) {
            console.error("Error playing album:", error);
        }
    };

    const playTrackAction = (track: Track) => {
        try {
            playTrack(formatTrackForAudio(track));
        } catch (error) {
            console.error("Error playing track:", error);
        }
    };

    const addTrackToQueue = (track: Track) => {
        try {
            addToQueue(formatTrackForAudio(track));
        } catch (error) {
            console.error("Error adding track to queue:", error);
        }
    };

    const addTrackToPlaylist = async (playlistId: string, trackId: string) => {
        try {
            await api.addTrackToPlaylist(playlistId, trackId);
        } catch (error) {
            console.error("Error adding track to playlist:", error);
        }
    };

    const deleteTrack = async (id: string): Promise<void> => {
        try {
            await api.deleteTrack(id);
        } catch (error) {
            console.error("Error deleting track:", error);
            throw error;
        }
    };

    const deleteAlbum = async (id: string): Promise<void> => {
        try {
            await api.deleteAlbum(id);
        } catch (error) {
            console.error("Error deleting album:", error);
            throw error;
        }
    };

    const deleteArtist = async (id: string): Promise<void> => {
        try {
            await api.deleteArtist(id);
        } catch (error) {
            console.error("Error deleting artist:", error);
            throw error;
        }
    };

    return {
        playArtist,
        playAlbum,
        playTrack: playTrackAction,
        addTrackToQueue,
        addTrackToPlaylist,
        deleteTrack,
        deleteAlbum,
        deleteArtist,
    };
}
