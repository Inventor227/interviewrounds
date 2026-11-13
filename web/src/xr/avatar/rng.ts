// Small seeded random source so avatar behaviour is reproducible in tests and different per avatar at run time.

export type Rng = () => number;

/** Mulberry32: uniform in [0, 1). */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniform in [lo, hi). */
export const between = (rng: Rng, lo: number, hi: number): number => lo + rng() * (hi - lo);

/** Frame-rate independent exponential approach factor for a time constant tau (seconds). */
export const approach = (dt: number, tau: number): number => (tau <= 0 ? 1 : 1 - Math.exp(-dt / tau));
