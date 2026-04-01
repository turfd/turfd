/** Seeded PRNG (mulberry32) with fork, position-keyed samples, and no cross-module deps. */

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return (): number => {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mix32(seed: number, a: number, b: number): number {
  let h = seed ^ Math.imul(a | 0, 73856093) ^ Math.imul(b | 0, 19349663);
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return h >>> 0;
}

export class GeneratorContext {
  private readonly rng: () => number;

  constructor(readonly seed: number) {
    this.rng = mulberry32(this.seed);
  }

  nextFloat(): number {
    return this.rng();
  }

  /** Inclusive both ends. */
  nextInt(min: number, max: number): number {
    if (min > max) {
      throw new Error("nextInt: min must be <= max");
    }
    const span = max - min + 1;
    return min + Math.floor(this.nextFloat() * span);
  }

  /**
   * Deterministic per (x, y); does not advance the shared PRNG stream.
   */
  nextFloatAt(x: number, y: number): number {
    const s = mix32(this.seed, x, y);
    return mulberry32(s)();
  }

  fork(salt: number): GeneratorContext {
    return new GeneratorContext(mix32(this.seed, salt, 0x9e3779b9));
  }
}
