/** Seeded PRNG (mulberry32) with fork and position-keyed samples. */

import { mulberry32, mulberry32FirstFloat01 } from "../../utils/mulberry32";

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
    return mulberry32FirstFloat01(s);
  }

  fork(salt: number): GeneratorContext {
    return new GeneratorContext(mix32(this.seed, salt, 0x9e3779b9));
  }
}
