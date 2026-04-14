/** Single CHUNK_SIZE×CHUNK_SIZE block storage with lightmap slots (Phase 4). */
import { CHUNK_SIZE } from "../../core/constants";
import { localIndex } from "./ChunkCoord";
import type { ChunkCoord } from "./ChunkCoord";

const CELL_COUNT = CHUNK_SIZE * CHUNK_SIZE;

export type Chunk = {
  readonly coord: ChunkCoord;
  blocks: Uint16Array;
  /** Back-wall tiles (0 = none). Same shape as `blocks`; not solid, not light-occluding. */
  background: Uint16Array;
  metadata: Uint8Array;
  skyLight: Uint8Array;
  blockLight: Uint8Array;
  dirty: boolean;
  /** Separate from `dirty` (renderer). Tracks whether this chunk needs persisting since last save. */
  persistDirty: boolean;
};

export function createChunk(coord: ChunkCoord): Chunk {
  return {
    coord,
    blocks: new Uint16Array(CELL_COUNT),
    background: new Uint16Array(CELL_COUNT),
    metadata: new Uint8Array(CELL_COUNT),
    skyLight: new Uint8Array(CELL_COUNT),
    blockLight: new Uint8Array(CELL_COUNT),
    dirty: false,
    persistDirty: true,
  };
}

export function getBlock(chunk: Chunk, lx: number, ly: number): number {
  return chunk.blocks[localIndex(lx, ly)]!;
}

export function setBlock(chunk: Chunk, lx: number, ly: number, id: number): void {
  chunk.blocks[localIndex(lx, ly)] = id;
  chunk.dirty = true;
  chunk.persistDirty = true;
}

export function getBackground(chunk: Chunk, lx: number, ly: number): number {
  return chunk.background[localIndex(lx, ly)]!;
}

export function setBackground(chunk: Chunk, lx: number, ly: number, id: number): void {
  chunk.background[localIndex(lx, ly)] = id;
  chunk.dirty = true;
  chunk.persistDirty = true;
}
