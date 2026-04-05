/** Seeded PRNG (mulberry32). */

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return (): number => {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** First float in [0, 1): same as the initial call `mulberry32(seed)()` without allocating a closure. */
export function mulberry32FirstFloat01(seed: number): number {
  let a = seed >>> 0;
  let t = (a += 0x6d2b79f5);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
