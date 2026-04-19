"use client";

import { useCachedImage } from "@/hooks/useCachedImage";
import Image from "next/image";
import { memo, SyntheticEvent } from "react";

interface CachedImageProps {
    src: string | null | undefined;
    alt?: string;
    className?: string;
    loading?: "lazy" | "eager";
    onError?: (e: SyntheticEvent<HTMLImageElement, Event>) => void;
}

/**
 * Image component that uses client-side caching to prevent reloading
 * Uses blob URLs to persist images across re-renders
 */
const CachedImage = memo(function CachedImage({ src, alt = "", className, loading, onError }: CachedImageProps) {
    const cachedSrc = useCachedImage(src || null);

    if (!cachedSrc) {
        return null;
    }

    return (
        <Image
            src={cachedSrc}
            alt={alt}
            fill
            unoptimized
            className={className}
            loading={loading}
            onError={onError}
        />
    );
});

export { CachedImage };
