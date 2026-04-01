/**
 * Underground dirt and gravel as localized pockets (grid + jitter + elliptical falloff),
 * similar to ore veins but larger and softer-edged — avoids per-block noise speckle.
 */
import type { BlockRegistry } from "../blocks/BlockRegistry";
import type { GeneratorContext } from "./GeneratorContext";

type PocketConfig = {
  spacing: number;
  peakChance: number;
  baseRadius: number;
  presence1: number;
  presence2: number;
  jitterX: number;
  jitterY: number;
  radiusVar: number;
  squash: number;
  shape: number;
};

const DIRT_CFG: PocketConfig = {
  spacing: 10,
  peakChance: 0.05,
  baseRadius: 2.75,
  presence1: 801_003,
  presence2: 801_701,
  jitterX: 801_811,
  jitterY: 801_919,
  radiusVar: 801_977,
  squash: 802_029,
  shape: 802_083,
};

const GRAVEL_CFG: PocketConfig = {
  spacing: 16,
  peakChance: 0.034,
  baseRadius: 1.85,
  presence1: 803_003,
  presence2: 803_701,
  jitterX: 803_811,
  jitterY: 803_919,
  radiusVar: 803_977,
  squash: 804_029,
  shape: 804_083,
};

/** Rare larger dirt zones (different grid + salts so shapes don’t align with DIRT_CFG). */
const DIRT_MACRO_CFG: PocketConfig = {
  spacing: 24,
  peakChance: 0.022,
  baseRadius: 4.1,
  presence1: 805_101,
  presence2: 805_709,
  jitterX: 805_811,
  jitterY: 805_919,
  radiusVar: 805_977,
  squash: 806_029,
  shape: 806_083,
};

export class SedimentPockets {
  private readonly ctx: GeneratorContext;
  private readonly dirtId: number;
  private readonly gravelId: number;
  private readonly stoneId: number;

  constructor(ctx: GeneratorContext, registry: BlockRegistry) {
    this.ctx = ctx.fork(0x5ed1_6e6e);
    this.dirtId = registry.getByIdentifier("stratum:dirt").id;
    this.gravelId = registry.getByIdentifier("stratum:gravel").id;
    this.stoneId = registry.getByIdentifier("stratum:stone").id;
  }

  /** Stone-layer geology: gravel pockets (rarer), then dirt (macro + local pockets), else stone. */
  getFill(wx: number, wy: number): number {
    if (this.matchPocket(wx, wy, GRAVEL_CFG)) {
      return this.gravelId;
    }
    if (this.matchPocket(wx, wy, DIRT_MACRO_CFG) || this.matchPocket(wx, wy, DIRT_CFG)) {
      return this.dirtId;
    }
    return this.stoneId;
  }

  private matchPocket(wx: number, wy: number, cfg: PocketConfig): boolean {
    const cellX = Math.floor(wx / cfg.spacing);
    const cellY = Math.floor(wy / cfg.spacing);
    const s = cfg;

    for (let gx = cellX - 1; gx <= cellX + 1; gx++) {
      for (let gy = cellY - 1; gy <= cellY + 1; gy++) {
        const spawn = this.ctx.nextFloatAt(gx * s.presence1, gy * s.presence2);
        if (spawn >= cfg.peakChance) {
          continue;
        }

        const jitterHalf = cfg.spacing * 0.5;
        const jx = (this.ctx.nextFloatAt(gx * s.jitterX, gy * s.jitterX) * 2 - 1) * jitterHalf;
        const jy = (this.ctx.nextFloatAt(gx * s.jitterY, gy * s.jitterY) * 2 - 1) * jitterHalf;

        const cx = gx * cfg.spacing + jx;
        const cy = gy * cfg.spacing + jy;

        const dx = wx - cx;
        const dy = wy - cy;

        const rv = this.ctx.nextFloatAt(gx * s.radiusVar, gy * s.radiusVar);
        const radius = cfg.baseRadius * (0.58 + 0.88 * rv);

        const sq = this.ctx.nextFloatAt(gx * s.squash, gy * s.squash);
        const ax = radius * (0.52 + 0.96 * sq);
        const ay = radius * (1.48 - 0.96 * sq);

        const nx = dx / ax;
        const ny = dy / ay;
        const u = nx * nx + ny * ny;
        if (u > 1) {
          continue;
        }

        const organic = this.ctx.nextFloatAt(wx + s.shape, wy + s.shape * 31);
        const limitSq = (0.66 + 0.34 * organic) ** 2;
        if (u > limitSq) {
          continue;
        }

        return true;
      }
    }
    return false;
  }
}
