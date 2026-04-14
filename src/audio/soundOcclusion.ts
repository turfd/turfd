import {
  AUDIO_OCCLUSION_FREQ_MULT_MIN,
  AUDIO_OCCLUSION_GAIN_PER_WALL,
  AUDIO_OCCLUSION_LINE_SAMPLES_MULT,
  AUDIO_OCCLUSION_MAX_CONTRIBUTING_WALLS,
  BLOCK_SIZE,
} from "../core/constants";
import type { World } from "../world/World";

/**
 * Counts solid, non-transparent blocks along an open segment between two world-pixel points
 * (used to muffle sounds that have to pass through walls).
 */
export function countOccludingBlocksOnSegment(
  world: World,
  axPx: number,
  ayPx: number,
  bxPx: number,
  byPx: number,
): number {
  const x0 = Math.floor(axPx / BLOCK_SIZE);
  const y0 = Math.floor(ayPx / BLOCK_SIZE);
  const x1 = Math.floor(bxPx / BLOCK_SIZE);
  const y1 = Math.floor(byPx / BLOCK_SIZE);
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.ceil(Math.hypot(dx, dy) * AUDIO_OCCLUSION_LINE_SAMPLES_MULT);
  const maxSteps = Math.max(len, 1);
  const seen = new Set<string>();
  let walls = 0;
  for (let s = 1; s < maxSteps; s++) {
    const t = s / maxSteps;
    const bx = Math.floor(x0 + dx * t);
    const by = Math.floor(y0 + dy * t);
    const key = `${bx},${by}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const b = world.getBlock(bx, by);
    if (b.solid && !b.transparent) {
      walls++;
    }
  }
  return walls;
}

export function occlusionAttenuation(wallCount: number): {
  gainMult: number;
  frequencyMult: number;
} {
  const w = Math.min(
    AUDIO_OCCLUSION_MAX_CONTRIBUTING_WALLS,
    Math.max(0, wallCount),
  );
  const pen = w / Math.max(1, AUDIO_OCCLUSION_MAX_CONTRIBUTING_WALLS);
  const gainMult = Math.max(
    0.08,
    1 - AUDIO_OCCLUSION_GAIN_PER_WALL * w,
  );
  const frequencyMult = 1 - (1 - AUDIO_OCCLUSION_FREQ_MULT_MIN) * pen;
  return { gainMult, frequencyMult };
}
