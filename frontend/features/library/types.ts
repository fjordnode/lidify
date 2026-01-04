export type Tab = "artists" | "albums" | "tracks";

export interface Artist {
  id: string;
  mbid?: string;
  name: string;
  coverArt?: string;
  albumCount?: number;
  trackCount?: number;
  lastSynced?: string;
}

export interface Album {
  id: string;
  title: string;
  coverArt?: string;
  year?: number;
  lastSynced?: string;
  artist?: {
    id: string;
    mbid?: string;
    name: string;
  };
}

export interface Track {
  id: string;
  title: string;
  duration: number;
  trackNo?: number;
  discNo?: number;
  album?: {
    id: string;
    title: string;
    coverArt?: string;
    artist?: {
      id: string;
      name: string;
    };
  };
}

export interface DeleteDialogState {
  isOpen: boolean;
  type: "track" | "album" | "artist";
  id: string;
  title: string;
}
