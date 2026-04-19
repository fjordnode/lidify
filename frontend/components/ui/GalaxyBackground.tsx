"use client";

/**
 * GalaxyBackground Component
 *
 * Creates a cosmic background effect that fades up from the bottom of the page.
 * Features:
 * - Subtle gradient fading from bottom (prominent) to top (transparent)
 * - Floating star-like particles
 * - More prominent at the bottom, fading as it goes higher
 * - Customizable colors from Vibrant.js for artist/album pages
 */

// Generate particle positions at module level (stable across renders, no purity issues)
function generateParticleLayer(count: number, bottomMin: number, bottomRange: number, durationBase: number, durationRange: number, delayRange: number) {
    return Array.from({ length: count }, () => ({
        left: Math.random() * 100,
        bottom: bottomMin + Math.random() * bottomRange,
        duration: durationBase + Math.random() * durationRange,
        delay: Math.random() * delayRange,
    }));
}

const PARTICLES = {
    bottom: generateParticleLayer(30, 0, 30, 3, 4, 3),
    mid: generateParticleLayer(20, 30, 30, 4, 3, 2),
    top: generateParticleLayer(12, 60, 40, 5, 3, 2),
    white: generateParticleLayer(18, 0, 50, 2, 3, 2),
    accent: generateParticleLayer(10, 0, 40, 4, 4, 3),
};

function hexToRgb(hex: string) {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result ? {
        r: parseInt(result[1], 16),
        g: parseInt(result[2], 16),
        b: parseInt(result[3], 16)
    } : null;
}

interface GalaxyBackgroundProps {
    /** Primary color extracted from Vibrant.js (e.g., "#8B4789") */
    primaryColor?: string;
    /** Optional secondary color */
    secondaryColor?: string;
}

export function GalaxyBackground({ primaryColor, secondaryColor }: GalaxyBackgroundProps = {}) {
    // Use provided colors or default purple theme
    const baseColor = primaryColor ? hexToRgb(primaryColor) : null;
    const accentColor = secondaryColor ? hexToRgb(secondaryColor) : null;

    return (
        <div className="fixed inset-0 pointer-events-none z-0 overflow-hidden">
            {/* Subtle gradient - fades from bottom to top */}
            {baseColor ? (
                <>
                    <div
                        className="absolute inset-0 bg-gradient-to-t to-transparent"
                        style={{
                            backgroundImage: `linear-gradient(to top, rgba(${baseColor.r}, ${baseColor.g}, ${baseColor.b}, 0.15), rgba(${baseColor.r}, ${baseColor.g}, ${baseColor.b}, 0.05), transparent)`
                        }}
                    />
                    <div className="absolute inset-0 bg-gradient-to-t from-black/40 via-black/10 to-transparent" />
                </>
            ) : (
                <>
                    <div className="absolute inset-0 bg-gradient-to-t from-purple-950/15 via-purple-950/5 to-transparent" />
                    <div className="absolute inset-0 bg-gradient-to-t from-black/40 via-black/10 to-transparent" />
                </>
            )}

            {/* Floating Star Particles - more concentrated at bottom */}
            {/* Bottom layer - most prominent */}
            {PARTICLES.bottom.map((p, i) => (
                <div
                    key={`bottom-purple-${i}`}
                    className={baseColor ? "absolute w-0.5 h-0.5 rounded-full blur-[0.4px]" : "absolute w-0.5 h-0.5 bg-purple-300/35 rounded-full blur-[0.4px]"}
                    style={{
                        left: `${p.left}%`,
                        bottom: `${p.bottom}%`,
                        animation: `galaxyFloat ${p.duration}s ease-in-out infinite`,
                        animationDelay: `${p.delay}s`,
                        ...(baseColor && {
                            backgroundColor: `rgba(${baseColor.r}, ${baseColor.g}, ${baseColor.b}, 0.35)`
                        })
                    }}
                />
            ))}

            {/* Middle layer - medium prominence */}
            {PARTICLES.mid.map((p, i) => (
                <div
                    key={`mid-purple-${i}`}
                    className={baseColor ? "absolute w-0.5 h-0.5 rounded-full blur-[0.4px]" : "absolute w-0.5 h-0.5 bg-indigo-300/25 rounded-full blur-[0.4px]"}
                    style={{
                        left: `${p.left}%`,
                        bottom: `${p.bottom}%`,
                        animation: `galaxyFloat ${p.duration}s ease-in-out infinite`,
                        animationDelay: `${p.delay}s`,
                        ...(baseColor && {
                            backgroundColor: `rgba(${baseColor.r}, ${baseColor.g}, ${baseColor.b}, 0.25)`
                        })
                    }}
                />
            ))}

            {/* Top layer - subtle and sparse */}
            {PARTICLES.top.map((p, i) => (
                <div
                    key={`top-purple-${i}`}
                    className={baseColor ? "absolute w-0.5 h-0.5 rounded-full blur-[0.4px]" : "absolute w-0.5 h-0.5 bg-violet-300/15 rounded-full blur-[0.4px]"}
                    style={{
                        left: `${p.left}%`,
                        bottom: `${p.bottom}%`,
                        animation: `galaxyFloat ${p.duration}s ease-in-out infinite`,
                        animationDelay: `${p.delay}s`,
                        ...(baseColor && {
                            backgroundColor: `rgba(${baseColor.r}, ${baseColor.g}, ${baseColor.b}, 0.15)`
                        })
                    }}
                />
            ))}

            {/* Accent white/blue stars scattered throughout */}
            {PARTICLES.white.map((p, i) => (
                <div
                    key={`white-star-${i}`}
                    className="absolute w-0.5 h-0.5 bg-white/30 rounded-full blur-[0.3px]"
                    style={{
                        left: `${p.left}%`,
                        bottom: `${p.bottom}%`,
                        animation: `galaxyTwinkle ${p.duration}s ease-in-out infinite`,
                        animationDelay: `${p.delay}s`,
                    }}
                />
            ))}

            {/* Very subtle accent particles - use secondary color if available */}
            {PARTICLES.accent.map((p, i) => (
                <div
                    key={`blue-accent-${i}`}
                    className={accentColor ? "absolute w-0.5 h-0.5 rounded-full blur-[0.4px]" : "absolute w-0.5 h-0.5 bg-blue-300/25 rounded-full blur-[0.4px]"}
                    style={{
                        left: `${p.left}%`,
                        bottom: `${p.bottom}%`,
                        animation: `galaxyFloat ${p.duration}s ease-in-out infinite`,
                        animationDelay: `${p.delay}s`,
                        ...(accentColor && {
                            backgroundColor: `rgba(${accentColor.r}, ${accentColor.g}, ${accentColor.b}, 0.25)`
                        })
                    }}
                />
            ))}
        </div>
    );
}
