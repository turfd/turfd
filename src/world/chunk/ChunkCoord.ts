/** Pure chunk coordinate math (world blocks ↔ chunk grid ↔ local indices). */
import { CHUNK_SIZE } from "../../core/constants";

export type ChunkCoord = {
  readonly cx: number;
  readonly cy: number;
};

const CHUNK_SIZE_IS_POWER_OF_TWO = (CHUNK_SIZE & (CHUNK_SIZE - 1)) === 0;
const CHUNK_SIZE_MASK = CHUNK_SIZE - 1;

function floorMod(n: number, m: number): number {
  if (m === CHUNK_SIZE && CHUNK_SIZE_IS_POWER_OF_TWO) {
    return n & CHUNK_SIZE_MASK;
  }
  return ((n % m) + m) % m;
}

export function worldToChunk(wx: number, wy: number): ChunkCoord {
  return {
    cx: Math.floor(wx / CHUNK_SIZE),
    cy: Math.floor(wy / CHUNK_SIZE),
  };
}

export function worldToLocalBlock(
  wx: number,
  wy: number,
): { lx: number; ly: number } {
  return {
    lx: floorMod(wx, CHUNK_SIZE),
    ly: floorMod(wy, CHUNK_SIZE),
  };
}

export function chunkToWorldOrigin(coord: ChunkCoord): { wx: number; wy: number } {
  return {
    wx: coord.cx * CHUNK_SIZE,
    wy: coord.cy * CHUNK_SIZE,
  };
}

export function chunkKey(coord: ChunkCoord): string {
  return `${coord.cx},${coord.cy}`;
}

/** Row-major: `ly * CHUNK_SIZE + lx`. */
export function localIndex(lx: number, ly: number): number {
  return ly * CHUNK_SIZE + lx;
}
