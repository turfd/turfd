/**
 * Deterministic surface-height noise: mostly flat with mild hills and rare mountains.
 *
 * Three layers:
 *  1. Base roll   – gentle, low-frequency undulation  (±3 blocks)
 *  2. Detail      – small surface bumps               (±1.5 blocks)
 *  3. Mountain    – rare peaks gated by a very-low-frequency selector
 */
import { createNoise2D } from "simplex-noise";
import { WORLD_Y_MAX, WORLD_Y_MIN } from "../../core/constants";
import { mulberry32 } from "./GeneratorContext";

/** Horizontal scale for forest/plains bands (macro noise). ~1 cycle per this many blocks. */
const BIOME_MAX_BLOCKS = 250;

export class TerrainNoise {
  private readonly noise2D: ReturnType<typeof createNoise2D>;
  private readonly seed: number;

  constructor(seed: number) {
    this.seed = seed;
    const rng = mulberry32(seed);
    this.noise2D = createNoise2D(() => rng());
  }

  getSeed(): number {
    return this.seed;
  }

  /**
   * World Y of solid surface (grass sits here). Clamped vertically.
   */
  getSurfaceHeight(wx: number): number {
    const base = this.noise2D(wx * 0.01, 0) * 5;
    const detail = this.noise2D(wx * 0.05, 0) * 2;

    const mountainSelector = this.noise2D(wx * 0.004, 100);
    const mountainFactor = Math.max(0, (mountainSelector - 0.45) / 0.55);
    const mountain = mountainFactor * mountainFactor * 40;

    const h = Math.round(base + detail + mountain);
    const lo = WORLD_Y_MIN + 10;
    const hi = WORLD_Y_MAX - 10;
    return Math.min(hi, Math.max(lo, h));
  }

  /**
   * Forest density field in [0..1].
   * - Macro noise uses ~{@link BIOME_MAX_BLOCKS}-block-scale bands (woods vs open ground).
   * - Mid frequency adds clumping and internal clearings inside woods.
   */
  getForestDensity(wx: number): number {
    const macroFreq = 1 / BIOME_MAX_BLOCKS;
    const macroRaw = this.noise2D(wx * macroFreq, 220);
    const patchRaw = this.noise2D(wx * 0.028, 337);
    const macro01 = macroRaw * 0.5 + 0.5;
    const patch01 = patchRaw * 0.5 + 0.5;

    // Wider smoothstep so woods/plains alternate more often and more columns reach visible density.
    const woodsBand = smoothstep(0.32, 0.72, macro01);
    const patch = 0.55 + patch01 * 0.45;
    return Math.max(0, Math.min(1, woodsBand * patch));
  }
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  if (x <= edge0) {
    return 0;
  }
  if (x >= edge1) {
    return 1;
  }
  const t = (x - edge0) / (edge1 - edge0);
  return t * t * (3 - 2 * t);
}
