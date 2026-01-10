export type AlbumSource = "library" | "discovery";

export interface Album {
  id: string;
  title: string;
  artist?: {
    id: string;
    mbid?: string;
    name: string;
  };
  year?: number;
  genres?: string[];
  genre?: string;
  coverArt?: string;
  coverUrl?: string;
  duration?: number;
  trackCount?: number;
  playCount?: number;
  type?: string;
  mbid?: string;
  rgMbid?: string;
  owned?: boolean;
  tracks?: Track[];
  similarAlbums?: SimilarAlbum[];
  bio?: string;
}

export interface Track {
  id: string;
  title: string;
  duration: number;
  trackNo?: number;
  discNo?: number;
  playCount?: number;
  artist?: {
    id?: string;
    name?: string;
  };
  album?: {
    id?: string;
    title?: string;
    coverArt?: string;
  };
}

export interface SimilarAlbum {
  id: string;
  title: string;
  artist?: {
    id: string;
    name: string;
  };
  coverArt?: string;
  coverUrl?: string;
  year?: number;
  owned?: boolean;
  mbid?: string;
}
