import { createNoise2D } from "simplex-noise";
import { WORLD_Y_MIN } from "../../core/constants";
import type { GeneratorContext } from "./GeneratorContext";

export class CaveGenerator {
  private readonly wormNoise: ReturnType<typeof createNoise2D>;
  private readonly wobbleNoise: ReturnType<typeof createNoise2D>;

  constructor(ctx: GeneratorContext) {
    const rng1 = ctx.fork(0xc4_11);
    const rng2 = ctx.fork(0xc4_12);
    this.wormNoise = createNoise2D(() => rng1.nextFloat());
    this.wobbleNoise = createNoise2D(() => rng2.nextFloat());
  }

  isCave(wx: number, wy: number, surfaceY: number): boolean {
    if (wy >= surfaceY - 4) return false;
    if (wy <= WORLD_Y_MIN + 5) return false;

    const worm = this.wormNoise(wx * 0.012, wy * 0.02);
    const wobble = this.wobbleNoise(wx * 0.04, wy * 0.04) * 0.15;
    const tunnelWidth = 0.18 + wobble;
    if (Math.abs(worm) > tunnelWidth) return false;

    return true;
  }
}
