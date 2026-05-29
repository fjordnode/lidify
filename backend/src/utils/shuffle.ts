/**
 * Uniform shuffling utilities.
 *
 * Replaces the `array.sort(() => Math.random() - 0.5)` anti-pattern used across
 * the codebase. A `.sort()` comparator that ignores its (a, b) arguments and
 * returns a random value violates sort's ordering contract, so V8 produces a
 * NON-uniform, insertion-order-biased permutation. That breaks the discovery
 * fairness invariant (avoid insertion-order bias in track selection).
 *
 * Fisher-Yates is O(n) and provably uniform.
 */

/**
 * Fisher-Yates shuffle using Math.random.
 * Returns a NEW array; the input is not mutated.
 */
export function shuffle<T>(array: readonly T[]): T[] {
    const out = array.slice();
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
}

/**
 * Hash a string seed into a positive integer.
 * Matches the previous `getSeededRandom` hash so seeded callers keep producing
 * a stable per-seed result (e.g. one consistent daily mix per date string).
 */
function hashSeed(seed: string): number {
    let hash = 0;
    for (let i = 0; i < seed.length; i++) {
        hash = (hash << 5) - hash + seed.charCodeAt(i);
        hash = hash & hash;
    }
    return Math.abs(hash);
}

/**
 * Deterministic PRNG in [0, 1) from a string or numeric seed.
 * ZX-Spectrum LCG — the same generator previously inlined into sort comparators.
 */
export function makeSeededRng(seed: string | number): () => number {
    let state = typeof seed === "number" ? Math.abs(Math.floor(seed)) : hashSeed(seed);
    if (state === 0) state = 1; // avoid zero lock-up
    return () => {
        state = (state * 9301 + 49297) % 233280;
        return state / 233280;
    };
}

/**
 * Fisher-Yates shuffle driven by a deterministic seed.
 * Same seed => same ordering. Returns a NEW array; the input is not mutated.
 */
export function seededShuffle<T>(array: readonly T[], seed: string | number): T[] {
    const rng = makeSeededRng(seed);
    const out = array.slice();
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
}
