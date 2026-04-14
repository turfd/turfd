import {
  AUDIO_ENV_AIR_HALFRADIUS_BLOCKS,
  AUDIO_ENV_CAVE_ENTER_AIR_COUNT,
  AUDIO_ENV_CAVE_EXIT_AIR_COUNT,
  AUDIO_ENV_SHALLOW_LAYER_MIN_BLOCK_Y,
  BLOCK_SIZE,
  PLAYER_WIDTH,
} from "../core/constants";
import type { World } from "../world/World";

export type AudioEnvironment =
  | "surface"
  | "underground"
  | "cave"
  | "enclosed"
  | "none";

export type AudioEnvironmentProbe = {
  env: AudioEnvironment;
  /**
   * For `cave` or `enclosed`: 0 = tight local cavity, 1 = very open (max air in moving 7×7 window).
   */
  openness01: number;
};

function clamp01(v: number): number {
  if (v < 0) {
    return 0;
  }
  if (v > 1) {
    return 1;
  }
  return v;
}

/**
 * Probe from roughly head/ear height, not feet. This avoids floor clutter (stairs, rubble)
 * suppressing cave detection when the surrounding volume is actually open.
 */
const OPENNESS_CENTER_Y_OFFSET_BLOCKS = 2;

/** Extra 7×7 centers so local clutter does not hide a nearby large cavern. */
const OPENNESS_OFFSETS: readonly { ox: number; oy: number }[] = [
  { ox: 0, oy: 0 },
  { ox: 5, oy: 0 },
  { ox: -5, oy: 0 },
  { ox: 0, oy: 5 },
  { ox: 0, oy: -5 },
  { ox: 8, oy: 0 },
  { ox: -8, oy: 0 },
  { ox: 4, oy: 3 },
  { ox: -4, oy: 3 },
  { ox: 4, oy: -3 },
  { ox: -4, oy: -3 },
  { ox: 6, oy: 4 },
  { ox: -6, oy: 4 },
  { ox: 6, oy: -4 },
  { ox: -6, oy: -4 },
];

function countAirInSquare(world: World, centerBx: number, centerBy: number): number {
  let airCount = 0;
  const r = AUDIO_ENV_AIR_HALFRADIUS_BLOCKS;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (!world.getBlock(centerBx + dx, centerBy + dy).solid) {
        airCount++;
      }
    }
  }
  return airCount;
}

function maxAirAcrossOffsets(
  world: World,
  feetBx: number,
  feetBy: number,
): number {
  const probeBy = feetBy + OPENNESS_CENTER_Y_OFFSET_BLOCKS;
  let best = 0;
  for (const { ox, oy } of OPENNESS_OFFSETS) {
    const c = countAirInSquare(world, feetBx + ox, probeBy + oy);
    if (c > best) {
      best = c;
    }
  }
  return best;
}

export class EnvironmentDetector {
  private wasCave = false;

  detect(world: World, feetPx: number, feetPy: number): AudioEnvironmentProbe {
    const columnWx = Math.floor((feetPx + PLAYER_WIDTH * 0.5) / BLOCK_SIZE);
    const feetBx = Math.floor(feetPx / BLOCK_SIZE);
    const feetBy = Math.floor(feetPy / BLOCK_SIZE);

    if (world.canHearOpenSkyRain(columnWx, feetPy)) {
      this.wasCave = false;
      return { env: "surface", openness01: 0 };
    }

    const airMax = maxAirAcrossOffsets(world, feetBx, feetBy);

    if (feetBy >= AUDIO_ENV_SHALLOW_LAYER_MIN_BLOCK_Y) {
      this.wasCave = false;
      if (airMax >= AUDIO_ENV_CAVE_ENTER_AIR_COUNT) {
        const side = AUDIO_ENV_AIR_HALFRADIUS_BLOCKS * 2 + 1;
        const maxAir = side * side;
        const span = maxAir - AUDIO_ENV_CAVE_ENTER_AIR_COUNT;
        const openness01 =
          span > 0
            ? clamp01((airMax - AUDIO_ENV_CAVE_ENTER_AIR_COUNT) / span)
            : 1;
        return { env: "enclosed", openness01 };
      }
      return { env: "underground", openness01: 0 };
    }

    if (this.wasCave) {
      if (airMax <= AUDIO_ENV_CAVE_EXIT_AIR_COUNT) {
        this.wasCave = false;
      }
    } else if (airMax >= AUDIO_ENV_CAVE_ENTER_AIR_COUNT) {
      this.wasCave = true;
    }

    if (!this.wasCave) {
      return { env: "underground", openness01: 0 };
    }

    const side = AUDIO_ENV_AIR_HALFRADIUS_BLOCKS * 2 + 1;
    const maxAir = side * side;
    const span = maxAir - AUDIO_ENV_CAVE_ENTER_AIR_COUNT;
    const openness01 =
      span > 0
        ? clamp01((airMax - AUDIO_ENV_CAVE_ENTER_AIR_COUNT) / span)
        : 1;

    return { env: "cave", openness01 };
  }
}
