/** BFS block light and column-sweep sky light for a single chunk via WorldBlockReader. */
import {
  CHUNK_SIZE,
  SKY_LIGHT_MAX,
  BLOCK_LIGHT_MAX,
} from "../../core/constants";

/**
 * Minimal read-only interface passed to LightPropagation so it can
 * sample neighbour chunks without importing World directly.
 */
interface WorldBlockReader {
  getBlock(wx: number, wy: number): number;
  isSolid(wx: number, wy: number): boolean;
  getLightAbsorption(wx: number, wy: number): number;
  getLightEmission(wx: number, wy: number): number;
  /** World Y of the highest solid block in column wx (or WORLD_Y_MIN if none). */
  getSkyExposureTop(wx: number): number;
}

const MAX_BLOCK_LIGHT_QUEUE =
  (CHUNK_SIZE + 2) * (CHUNK_SIZE + 2) * BLOCK_LIGHT_MAX;

/** Neighbour deltas for block-light BFS (hoisted — avoid per-queue-step array alloc). */
const BLOCK_LIGHT_NB = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

/**
 * Recompute sky light for one chunk via BFS from sky-exposed air blocks.
 *
 * Seeds: all non-solid blocks above the highest solid in their column
 * (i.e. directly exposed to the sky) within a border of SKY_LIGHT_MAX
 * around the chunk so that horizontal light can enter the chunk from
 * nearby openings.
 *
 * Propagation rules (Minecraft-style):
 *  - Downward (wy-1): no decay (sky light pours straight down)
 *  - Horizontal / upward: decay by 1 per step
 *  - Solid blocks absorb light (absorption field), preventing propagation
 *    through walls / ceilings.
 *
 * Result: sealed rooms get skyLight 0; open air stays at 15.
 */
export function computeSkyLight(
  chunkX: number,
  chunkY: number,
  skyLight: Uint8Array,
  reader: WorldBlockReader,
): void {
  skyLight.fill(0);

  const border = SKY_LIGHT_MAX;
  const padded = CHUNK_SIZE + 2 * border;
  const wxMin = chunkX * CHUNK_SIZE - border;
  const wyMin = chunkY * CHUNK_SIZE - border;

  const best = new Uint8Array(padded * padded);

  const MAX_QUEUE = padded * padded * 2;
  const qx = new Int32Array(MAX_QUEUE);
  const qy = new Int32Array(MAX_QUEUE);
  const ql = new Uint8Array(MAX_QUEUE);
  let head = 0;
  let tail = 0;

  const tryPush = (wx: number, wy: number, level: number): void => {
    const px = wx - wxMin;
    const py = wy - wyMin;
    if (px < 0 || px >= padded || py < 0 || py >= padded) return;
    if (tail >= MAX_QUEUE) return;
    const bi = py * padded + px;
    if (best[bi]! >= level) return;
    best[bi] = level;
    qx[tail] = wx;
    qy[tail] = wy;
    ql[tail] = level;
    tail += 1;
  };

  for (let px = 0; px < padded; px++) {
    const wx = wxMin + px;
    const skyTop = reader.getSkyExposureTop(wx);
    for (let py = padded - 1; py >= 0; py--) {
      const wy = wyMin + py;
      if (wy > skyTop) {
        tryPush(wx, wy, SKY_LIGHT_MAX);
      } else {
        break;
      }
    }
  }

  while (head < tail) {
    const wx = qx[head]!;
    const wy = qy[head]!;
    const level = ql[head]!;
    head += 1;

    const localX = wx - chunkX * CHUNK_SIZE;
    const localY = wy - chunkY * CHUNK_SIZE;
    if (
      localX >= 0 &&
      localX < CHUNK_SIZE &&
      localY >= 0 &&
      localY < CHUNK_SIZE
    ) {
      skyLight[localY * CHUNK_SIZE + localX] = level;
    }

    // Down (wy - 1): no decay — sky light pours straight down
    {
      const ny = wy - 1;
      const absorption = reader.getLightAbsorption(wx, ny);
      const next = level - absorption;
      if (next > 0) tryPush(wx, ny, Math.min(SKY_LIGHT_MAX, next));
    }
    // Up (wy + 1): normal decay
    {
      const ny = wy + 1;
      const absorption = reader.getLightAbsorption(wx, ny);
      const next = level - 1 - absorption;
      if (next > 0) tryPush(wx, ny, Math.min(SKY_LIGHT_MAX, next));
    }
    // Left
    {
      const nx = wx - 1;
      const absorption = reader.getLightAbsorption(nx, wy);
      const next = level - 1 - absorption;
      if (next > 0) tryPush(nx, wy, Math.min(SKY_LIGHT_MAX, next));
    }
    // Right
    {
      const nx = wx + 1;
      const absorption = reader.getLightAbsorption(nx, wy);
      const next = level - 1 - absorption;
      if (next > 0) tryPush(nx, wy, Math.min(SKY_LIGHT_MAX, next));
    }
  }
}

/**
 * Recompute block light for one chunk.
 * Writes into chunk.blockLight (Uint8Array, length CHUNK_SIZE²).
 * Reads neighbour data via `reader`.
 */
export function computeBlockLight(
  chunkX: number,
  chunkY: number,
  blockLight: Uint8Array,
  reader: WorldBlockReader,
): void {
  blockLight.fill(0);

  const qx = new Int32Array(MAX_BLOCK_LIGHT_QUEUE);
  const qy = new Int32Array(MAX_BLOCK_LIGHT_QUEUE);
  const ql = new Uint8Array(MAX_BLOCK_LIGHT_QUEUE);
  let head = 0;
  let tail = 0;

  const push = (wx: number, wy: number, level: number): void => {
    if (tail >= MAX_BLOCK_LIGHT_QUEUE) {
      return;
    }
    qx[tail] = wx;
    qy[tail] = wy;
    ql[tail] = level;
    tail += 1;
  };

  for (let lx = -1; lx <= CHUNK_SIZE; lx++) {
    for (let ly = -1; ly <= CHUNK_SIZE; ly++) {
      const wx = chunkX * CHUNK_SIZE + lx;
      const wy = chunkY * CHUNK_SIZE + ly;
      const emission = reader.getLightEmission(wx, wy);
      if (emission > 0) {
        const seed = Math.min(BLOCK_LIGHT_MAX, emission);
        push(wx, wy, seed);
      }
    }
  }

  while (head < tail) {
    const wx = qx[head]!;
    const wy = qy[head]!;
    const level = ql[head]!;
    head += 1;

    if (level <= 0) {
      continue;
    }

    const localX = wx - chunkX * CHUNK_SIZE;
    const localY = wy - chunkY * CHUNK_SIZE;
    const inBounds =
      localX >= 0 &&
      localX < CHUNK_SIZE &&
      localY >= 0 &&
      localY < CHUNK_SIZE;

    if (inBounds) {
      const idx = localY * CHUNK_SIZE + localX;
      if (blockLight[idx]! >= level) {
        continue;
      }
      blockLight[idx] = level;
    }

    for (let ni = 0; ni < BLOCK_LIGHT_NB.length; ni++) {
      const d = BLOCK_LIGHT_NB[ni]!;
      const nx = wx + d[0];
      const ny = wy + d[1];
      const absorption = reader.getLightAbsorption(nx, ny);
      const nextLevel = level - 1 - absorption;
      if (nextLevel > 0) {
        const clamped = Math.min(BLOCK_LIGHT_MAX, nextLevel);
        push(nx, ny, clamped);
      }
    }
  }
}
