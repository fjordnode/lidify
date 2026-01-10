/**
 * String normalization utilities for external API compatibility.
 *
 * MusicBrainz uses typographic/curly quotes (') which many external APIs
 * (Deezer, Last.fm) don't handle well. These utilities normalize strings
 * for API compatibility while preserving original data in the database.
 */

/**
 * Normalize quotes and apostrophes to ASCII equivalents.
 * Use this before calling external APIs that expect standard ASCII.
 *
 * Converts:
 * - ' ' ʼ ʻ (curly single quotes) → ' (straight apostrophe)
 * - " " (curly double quotes) → " (straight double quote)
 */
export function normalizeQuotes(str: string): string {
    return str
        .replace(/[\u2018\u2019\u02BC\u02BB]/g, "'")  // Curly single quotes to straight
        .replace(/[\u201C\u201D]/g, '"');              // Curly double quotes to straight
}

/**
 * Normalize fullwidth Unicode characters to ASCII equivalents.
 * Handles stylized text like ＧＨＯＳＴ → GHOST.
 *
 * Only converts fullwidth characters (U+FF01-U+FF5E), not diacritics
 * (ø, é, ñ) which represent distinct artists.
 */
export function normalizeFullwidth(str: string): string {
    return str
        .replace(/[\uFF01-\uFF5E]/g, (char) =>
            String.fromCharCode(char.charCodeAt(0) - 0xFEE0)
        )
        .replace(/\u3000/g, " ")  // Fullwidth space to regular space
        .trim();
}
