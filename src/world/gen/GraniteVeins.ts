/**
 * Rare elongated granite veins: replaces stone fill underground
 * (same depth gate as ores: below shallow topsoil).
 */
import type { BlockRegistry } from "../blocks/BlockRegistry";
import type { GeneratorContext } from "./GeneratorContext";

const SPACING = 22;
const PEAK_CHANCE = 0.02;
/** Semi-axis along the long direction of the vein (world cells, post-rotation). */
const AXIS_LONG = 5.2;
/** Semi-axis across the vein — keeps veins ribbon-like. */
const AXIS_SHORT = 0.95;

const PRESENCE1 = 820_003;
const PRESENCE2 = 820_701;
const JITTER_X = 820_811;
const JITTER_Y = 820_919;
const ANGLE_SALT = 820_977;
const SHAPE = 821_029;

export class GraniteVeins {
  private readonly ctx: GeneratorContext;
  private readonly graniteId: number | null;
  private readonly stoneId: number;

  constructor(ctx: GeneratorContext, registry: BlockRegistry) {
    this.ctx = ctx.fork(0x6a32_4e1e);
    this.stoneId = registry.getByIdentifier("stratum:stone").id;
    this.graniteId = registry.isRegistered("stratum:granite")
      ? registry.getByIdentifier("stratum:granite").id
      : null;
  }

  /** If `fillId` is stone and this cell sits in a vein, returns granite; else `fillId`. */
  applyToStoneFill(wx: number, wy: number, surfaceY: number, fillId: number): number {
    if (this.graniteId === null) {
      return fillId;
    }
    if (wy >= surfaceY - 4) {
      return fillId;
    }
    if (fillId !== this.stoneId) {
      return fillId;
    }
    return this.matchVein(wx, wy) ? this.graniteId : fillId;
  }

  private matchVein(wx: number, wy: number): boolean {
    const cellX = Math.floor(wx / SPACING);
    const cellY = Math.floor(wy / SPACING);

    for (let gx = cellX - 1; gx <= cellX + 1; gx++) {
      for (let gy = cellY - 1; gy <= cellY + 1; gy++) {
        const spawn = this.ctx.nextFloatAt(gx * PRESENCE1, gy * PRESENCE2);
        if (spawn >= PEAK_CHANCE) {
          continue;
        }

        const jitterHalf = SPACING * 0.5;
        const jx =
          (this.ctx.nextFloatAt(gx * JITTER_X, gy * JITTER_X) * 2 - 1) * jitterHalf;
        const jy =
          (this.ctx.nextFloatAt(gx * JITTER_Y, gy * JITTER_Y) * 2 - 1) * jitterHalf;
        const cx = gx * SPACING + jx;
        const cy = gy * SPACING + jy;

        const dx = wx - cx;
        const dy = wy - cy;

        const th =
          this.ctx.nextFloatAt(gx * ANGLE_SALT, gy * ANGLE_SALT * 17) * Math.PI * 2;
        const c = Math.cos(th);
        const s = Math.sin(th);
        const rx = c * dx + s * dy;
        const ry = -s * dx + c * dy;

        const nx = rx / AXIS_LONG;
        const ny = ry / AXIS_SHORT;
        const u = nx * nx + ny * ny;
        if (u > 1) {
          continue;
        }

        const organic = this.ctx.nextFloatAt(wx + SHAPE, wy * 31 + SHAPE);
        const limitSq = (0.68 + 0.32 * organic) ** 2;
        if (u > limitSq) {
          continue;
        }

        return true;
      }
    }
    return false;
  }
}
