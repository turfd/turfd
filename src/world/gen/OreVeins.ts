/**
 * Height-above-bedrock ore clusters with trapezoidal probability distribution.
 *
 * Each ore has a Y-range expressed in blocks above WORLD_Y_MIN (bedrock).
 * A trapezoidal curve modulates spawn chance so density matches Minecraft-style
 * distribution charts.  Rarest ores are tested first; first match wins.
 */
import type { BlockRegistry } from "../blocks/BlockRegistry";
import { WORLD_Y_MIN } from "../../core/constants";
import type { GeneratorContext } from "./GeneratorContext";

/* ------------------------------------------------------------------ */
/*  Per-ore deterministic salt sets (must not collide across ores)     */
/* ------------------------------------------------------------------ */

type OreSalts = {
  presence1: number;
  presence2: number;
  jitterX: number;
  jitterY: number;
  shape: number;
};

const DIAMOND_SALTS: OreSalts = { presence1: 104_003, presence2: 104_701, jitterX: 104_811, jitterY: 104_919, shape: 104_977 };
const GOLD_SALTS: OreSalts     = { presence1: 903_031, presence2: 903_733, jitterX: 903_811, jitterY: 903_919, shape: 903_977 };
const LAPIS_SALTS: OreSalts    = { presence1: 205_003, presence2: 205_701, jitterX: 205_811, jitterY: 205_919, shape: 205_977 };
const REDSTONE_SALTS: OreSalts = { presence1: 306_003, presence2: 306_701, jitterX: 306_811, jitterY: 306_919, shape: 306_977 };
const IRON_SALTS: OreSalts     = { presence1: 702_017, presence2: 702_719, jitterX: 702_811, jitterY: 702_919, shape: 702_977 };
const COAL_SALTS: OreSalts     = { presence1: 401_003, presence2: 401_701, jitterX: 401_811, jitterY: 401_919, shape: 401_977 };

/* ------------------------------------------------------------------ */
/*  Ore config table                                                  */
/* ------------------------------------------------------------------ */

type OreConfig = {
  oreId: number;
  veinSpacing: number;
  /** Maximum spawn chance (fraction 0–1) at the peak of the trapezoid. */
  peakSpawnChance: number;
  veinRadius: number;
  /** Trapezoidal range in blocks above bedrock (WORLD_Y_MIN). */
  minHAB: number;
  peakStartHAB: number;
  peakEndHAB: number;
  maxHAB: number;
  salts: OreSalts;
};

/**
 * Trapezoidal weight: 0 outside range, ramps linearly to 1 between
 * min→peakStart, holds 1 through peakEnd, ramps back to 0 at max.
 */
function trapezoid(
  hab: number,
  min: number,
  peakStart: number,
  peakEnd: number,
  max: number,
): number {
  if (hab <= min || hab >= max) return 0;
  if (hab < peakStart) return (hab - min) / (peakStart - min);
  if (hab <= peakEnd) return 1;
  return (max - hab) / (max - peakEnd);
}

/* ------------------------------------------------------------------ */
/*  Public API                                                        */
/* ------------------------------------------------------------------ */

export class OreVeins {
  private readonly ctx: GeneratorContext;
  private readonly oreTable: OreConfig[];

  constructor(ctx: GeneratorContext, registry: BlockRegistry) {
    this.ctx = ctx;

    const id = (name: string) => registry.getByIdentifier(name).id;

    this.oreTable = [
      {
        oreId: id("turfd:diamond_ore"),
        veinSpacing: 16, peakSpawnChance: 0.12, veinRadius: 1.2,
        minHAB: 0, peakStartHAB: 15, peakEndHAB: 55, maxHAB: 75,
        salts: DIAMOND_SALTS,
      },
      {
        oreId: id("turfd:gold_ore"),
        veinSpacing: 18, peakSpawnChance: 0.065, veinRadius: 1.5,
        minHAB: 0, peakStartHAB: 20, peakEndHAB: 100, maxHAB: 140,
        salts: GOLD_SALTS,
      },
      {
        oreId: id("turfd:lapis_ore"),
        veinSpacing: 18, peakSpawnChance: 0.065, veinRadius: 1.5,
        minHAB: 25, peakStartHAB: 45, peakEndHAB: 85, maxHAB: 130,
        salts: LAPIS_SALTS,
      },
      {
        oreId: id("turfd:redstone_ore"),
        veinSpacing: 10, peakSpawnChance: 0.09, veinRadius: 2.0,
        minHAB: 0, peakStartHAB: 0, peakEndHAB: 20, maxHAB: 80,
        salts: REDSTONE_SALTS,
      },
      {
        oreId: id("turfd:iron_ore"),
        veinSpacing: 12, peakSpawnChance: 0.10, veinRadius: 2.0,
        minHAB: 0, peakStartHAB: 20, peakEndHAB: 220, maxHAB: 260,
        salts: IRON_SALTS,
      },
      {
        oreId: id("turfd:coal_ore"),
        veinSpacing: 10, peakSpawnChance: 0.07, veinRadius: 2.5,
        minHAB: 15, peakStartHAB: 25, peakEndHAB: 200, maxHAB: 260,
        salts: COAL_SALTS,
      },
    ];
  }

  /**
   * Rarest-first priority: first matching ore wins. Returns null if none.
   * Ores only appear below the dirt layer (wy < surfaceY - 4).
   */
  getOreAt(wx: number, wy: number, surfaceY: number): number | null {
    if (wy >= surfaceY - 4) return null;

    const hab = wy - WORLD_Y_MIN;

    for (const cfg of this.oreTable) {
      const t = trapezoid(hab, cfg.minHAB, cfg.peakStartHAB, cfg.peakEndHAB, cfg.maxHAB);
      if (t <= 0) continue;

      const result = this.matchVein(wx, wy, t, cfg);
      if (result !== null) return result;
    }
    return null;
  }

  private matchVein(
    wx: number,
    wy: number,
    tFactor: number,
    cfg: OreConfig,
  ): number | null {
    const effectiveChance = cfg.peakSpawnChance * tFactor;
    const cellX = Math.floor(wx / cfg.veinSpacing);
    const cellY = Math.floor(wy / cfg.veinSpacing);
    const s = cfg.salts;

    for (let gx = cellX - 1; gx <= cellX + 1; gx++) {
      for (let gy = cellY - 1; gy <= cellY + 1; gy++) {
        const spawn = this.ctx.nextFloatAt(gx * s.presence1, gy * s.presence2);
        if (spawn >= effectiveChance) continue;

        const jitterHalf = cfg.veinSpacing * 0.5;
        const jx = (this.ctx.nextFloatAt(gx * s.jitterX, gy * s.jitterX) * 2 - 1) * jitterHalf;
        const jy = (this.ctx.nextFloatAt(gx * s.jitterY, gy * s.jitterY) * 2 - 1) * jitterHalf;

        const cx = gx * cfg.veinSpacing + jx;
        const cy = gy * cfg.veinSpacing + jy;

        const dx = wx - cx;
        const dy = wy - cy;
        if (dx * dx + dy * dy > cfg.veinRadius * cfg.veinRadius) continue;

        const shape = this.ctx.nextFloatAt(wx + s.shape, wy + s.shape * 31);
        if (shape < 0.3) continue;

        return cfg.oreId;
      }
    }
    return null;
  }
}
