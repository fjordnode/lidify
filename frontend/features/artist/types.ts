export type ArtistSource = "library" | "discovery";

export interface Artist {
    id: string;
    name: string;
    source?: ArtistSource;
    coverArt?: string;
    image?: string;
    heroUrl?: string;
    bio?: string;
    summary?: string;
    mbid?: string;
    url?: string;
    listeners?: number;
    genres?: string[];
    tags?: string[];
    albums?: Album[];
    topTracks?: Track[];
    similarArtists?: SimilarArtist[];
}

export interface Album {
    id: string;
    title: string;
    year?: number;
    releaseDate?: string | null;
    coverArt?: string;
    coverUrl?: string;
    trackCount?: number;
    songCount?: number;
    type?: string;
    owned?: boolean;
    mbid?: string;
    rgMbid?: string;
    availability?: string;
    playCount?: number;
    listeners?: number;
    popularityRank?: number;
}

export interface Track {
    id: string;
    title: string;
    duration: number;
    playCount?: number;
    userPlayCount?: number;
    listeners?: number;
    filePath?: string;
    album?: {
        id?: string;
        title?: string;
        coverArt?: string;
    };
}

export interface SimilarArtist {
    id: string;
    mbid?: string;
    name: string;
    coverArt?: string;
    image?: string;
    albumCount?: number;
    ownedAlbumCount?: number;
    weight?: number;
    inLibrary?: boolean;
}
