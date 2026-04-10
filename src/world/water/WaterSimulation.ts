/**
 * Simplified flowing-water tick (host / single-player).
 * Source blocks (flow 0) spread down as sources and sideways with increasing flow level.
 */
import {
  CHUNK_SIZE,
  WATER_MAX_FLOW,
  WORLD_Y_MAX,
  WORLD_Y_MIN,
} from "../../core/constants";
import type { Chunk } from "../chunk/Chunk";
import { worldToChunk } from "../chunk/ChunkCoord";
import type { World } from "../World";
import { bedHeadPlusXFromMeta } from "../bed/bedMetadata";
import {
  getWaterFlowLevel,
  withWaterFlowLevel,
} from "./waterMetadata";

const CHUNK_COORD_PACK_BIAS = 32768;

function packChunkCoordKey(cx: number, cy: number): number {
  return ((cx + CHUNK_COORD_PACK_BIAS) << 16) | (cy + CHUNK_COORD_PACK_BIAS);
}

function unpackChunkCoordKey(key: number): { cx: number; cy: number } {
  return {
    cx: (key >>> 16) - CHUNK_COORD_PACK_BIAS,
    cy: (key & 0xffff) - CHUNK_COORD_PACK_BIAS,
  };
}

type WaterChunkSnapshot = {
  ox: number;
  oy: number;
  /** Triplets of `lx, ly, flowLevel` captured before the spread pass mutates world state. */
  cells: number[];
};

function compareChunksByWorldPosition(a: Chunk, b: Chunk): number {
  if (a.coord.cy !== b.coord.cy) {
    return a.coord.cy - b.coord.cy;
  }
  return a.coord.cx - b.coord.cx;
}

function chunkLocalIndexForWorldCell(chunk: Chunk, wx: number, wy: number): number {
  const lx = wx - chunk.coord.cx * CHUNK_SIZE;
  const ly = wy - chunk.coord.cy * CHUNK_SIZE;
  return ly * CHUNK_SIZE + lx;
}

function collectWaterSnapshots(
  world: World,
  waterId: number,
  activeChunkKeys?: ReadonlySet<number>,
): WaterChunkSnapshot[] {
  const chunks =
    activeChunkKeys === undefined
      ? [...world.iterLoadedChunks()]
      : [...activeChunkKeys]
          .map((key) => {
            const { cx, cy } = unpackChunkCoordKey(key);
            return world.getChunk(cx, cy);
          })
          .filter((chunk): chunk is Chunk => chunk !== undefined);
  chunks.sort(compareChunksByWorldPosition);
  const out: WaterChunkSnapshot[] = [];
  for (const chunk of chunks) {
    const blocks = chunk.blocks;
    const metadata = chunk.metadata;
    const cells: number[] = [];
    for (let ly = 0, rowStart = 0; ly < CHUNK_SIZE; ly++, rowStart += CHUNK_SIZE) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const idx = rowStart + lx;
        if (blocks[idx] !== waterId) {
          continue;
        }
        cells.push(lx, ly, getWaterFlowLevel(metadata[idx]!));
      }
    }
    if (cells.length > 0) {
      out.push({
        ox: chunk.coord.cx * CHUNK_SIZE,
        oy: chunk.coord.cy * CHUNK_SIZE,
        cells,
      });
    }
  }
  return out;
}

function collectChunksWithWater(world: World, waterId: number): Set<number> {
  const out = new Set<number>();
  for (const chunk of world.iterLoadedChunks()) {
    const blocks = chunk.blocks;
    for (let i = 0; i < blocks.length; i++) {
      if (blocks[i] === waterId) {
        out.add(packChunkCoordKey(chunk.coord.cx, chunk.coord.cy));
        break;
      }
    }
  }
  return out;
}

function markNextActiveAroundWorldCell(
  nextActive: Set<number>,
  wx: number,
  wy: number,
): void {
  const { cx, cy } = worldToChunk(wx, wy);
  nextActive.add(packChunkCoordKey(cx, cy));
  nextActive.add(packChunkCoordKey(cx - 1, cy));
  nextActive.add(packChunkCoordKey(cx + 1, cy));
  nextActive.add(packChunkCoordKey(cx, cy - 1));
  nextActive.add(packChunkCoordKey(cx, cy + 1));
}

function prepareCellForWaterSpread(
  world: World,
  wx: number,
  wy: number,
  airId: number,
  waterId: number,
): boolean {
  if (wy < WORLD_Y_MIN || wy > WORLD_Y_MAX) {
    return false;
  }
  const currentId = world.getForegroundBlockId(wx, wy);
  if (currentId === airId || currentId === waterId) {
    return true;
  }
  const def = world.getBlock(wx, wy);
  if (def.solid && !def.replaceable) {
    return false;
  }
  if (!def.replaceable) {
    return false;
  }

  if (def.tallGrass === "bottom") {
    const top = world.getBlock(wx, wy + 1);
    if (top.tallGrass === "top") {
      world.spawnLootForBrokenBlock(def.id, wx, wy);
      world.setBlockWithoutPlantCascadeForWater(wx, wy + 1, airId);
      world.setBlockWithoutPlantCascadeForWater(wx, wy, airId);
    } else {
      world.spawnLootForBrokenBlock(def.id, wx, wy);
      world.setBlockWithoutPlantCascadeForWater(wx, wy, airId);
    }
    return true;
  }
  if (def.tallGrass === "top") {
    const bottom = world.getBlock(wx, wy - 1);
    if (bottom.tallGrass === "bottom") {
      world.spawnLootForBrokenBlock(bottom.id, wx, wy - 1);
      world.setBlockWithoutPlantCascadeForWater(wx, wy, airId);
      world.setBlockWithoutPlantCascadeForWater(wx, wy - 1, airId);
    } else {
      world.spawnLootForBrokenBlock(def.id, wx, wy);
      world.setBlockWithoutPlantCascadeForWater(wx, wy, airId);
    }
    return true;
  }

  if (def.bedHalf === "foot" || def.bedHalf === "head") {
    const meta = world.getMetadata(wx, wy);
    const headPlusX = bedHeadPlusXFromMeta(meta);
    const footWx = def.bedHalf === "foot" ? wx : headPlusX ? wx - 1 : wx + 1;
    const headWx = def.bedHalf === "head" ? wx : headPlusX ? wx + 1 : wx - 1;
    const footCell = world.getBlock(footWx, wy);
    const headCell = world.getBlock(headWx, wy);
    if (footCell.bedHalf === "foot" && headCell.bedHalf === "head") {
      world.spawnLootForBrokenBlock(footCell.id, footWx, wy);
      world.setBlockWithoutPlantCascadeForWater(headWx, wy, airId);
      world.setBlockWithoutPlantCascadeForWater(footWx, wy, airId);
    } else {
      world.spawnLootForBrokenBlock(def.id, wx, wy);
      world.setBlockWithoutPlantCascadeForWater(wx, wy, airId);
    }
    return true;
  }

  world.spawnLootForBrokenBlock(def.id, wx, wy);
  world.setBlockWithoutPlantCascadeForWater(wx, wy, airId);
  return true;
}

/**
 * One pass: try down (source below), then horizontal spread with increasing flow level.
 */
export function tickWaterFlow(
  world: World,
  airId: number,
  waterId: number,
  activeChunkKeys?: ReadonlySet<number>,
): Set<number> {
  world.pushBulkForegroundWrites();
  const snapshots = collectWaterSnapshots(world, waterId, activeChunkKeys);
  const nextActive = new Set<number>();
  try {
    for (const { ox, oy, cells } of snapshots) {
      for (let i = 0; i < cells.length; i += 3) {
        const wx = ox + cells[i]!;
        const wy = oy + cells[i + 1]!;
        const level = cells[i + 2]!;
        const belowY = wy - 1;
        if (belowY >= WORLD_Y_MIN) {
          if (prepareCellForWaterSpread(world, wx, belowY, airId, waterId)) {
            const belowChunk = world.getChunkAt(wx, belowY);
            const belowId =
              belowChunk === undefined
                ? airId
                : belowChunk.blocks[chunkLocalIndexForWorldCell(belowChunk, wx, belowY)]!;
            if (belowId === airId) {
              if (
                world.setBlock(wx, belowY, waterId, {
                  cellMetadata: withWaterFlowLevel(0, 0),
                })
              ) {
                markNextActiveAroundWorldCell(nextActive, wx, belowY);
              }
            } else if (belowId === waterId) {
              if (belowChunk !== undefined) {
                const m =
                  belowChunk.metadata[chunkLocalIndexForWorldCell(belowChunk, wx, belowY)]!;
                const cur = getWaterFlowLevel(m);
                if (
                  cur > 0 &&
                  world.setBlock(wx, belowY, waterId, {
                    cellMetadata: withWaterFlowLevel(m, 0),
                  })
                ) {
                  markNextActiveAroundWorldCell(nextActive, wx, belowY);
                }
              }
            }
          }
        }

        if (level >= WATER_MAX_FLOW) {
          continue;
        }
        const nextLevel = level + 1;
        for (const dx of [-1, 1] as const) {
          const nx = wx + dx;
          const neighborChunk = world.getChunkAt(nx, wy);
          if (neighborChunk === undefined) {
            continue;
          }
          if (!prepareCellForWaterSpread(world, nx, wy, airId, waterId)) {
            continue;
          }
          const neighborIdx = chunkLocalIndexForWorldCell(neighborChunk, nx, wy);
          const nid = neighborChunk.blocks[neighborIdx]!;
          if (nid === airId) {
            if (
              world.setBlock(nx, wy, waterId, {
                cellMetadata: withWaterFlowLevel(0, nextLevel),
              })
            ) {
              markNextActiveAroundWorldCell(nextActive, nx, wy);
            }
          } else if (nid === waterId) {
            const m = neighborChunk.metadata[neighborIdx]!;
            const nl = getWaterFlowLevel(m);
            if (
              nextLevel < nl &&
              world.setBlock(nx, wy, waterId, {
                cellMetadata: withWaterFlowLevel(m, nextLevel),
              })
            ) {
              markNextActiveAroundWorldCell(nextActive, nx, wy);
            }
          }
        }
      }
    }
  } finally {
    world.popBulkForegroundWrites();
  }
  return nextActive;
}

/**
 * After a water cell is removed or replaced (break, bucket, building over water): strip all
 * *flowing* water in loaded chunks, then re-run spread from remaining sources only.
 * Matches Minecraft-style behavior where removing the source drains dependent flowing water.
 */
export function resimulateWaterFromSources(
  world: World,
  airId: number,
  waterId: number,
): void {
  world.pushBulkForegroundWrites();
  try {
    for (const chunk of world.iterLoadedChunks()) {
      const ox = chunk.coord.cx * CHUNK_SIZE;
      const oy = chunk.coord.cy * CHUNK_SIZE;
      const blocks = chunk.blocks;
      const metadata = chunk.metadata;
      for (let ly = 0, rowStart = 0; ly < CHUNK_SIZE; ly++, rowStart += CHUNK_SIZE) {
        for (let lx = 0; lx < CHUNK_SIZE; lx++) {
          const idx = rowStart + lx;
          const id = blocks[idx]!;
          if (id !== waterId) {
            continue;
          }
          const meta = metadata[idx]!;
          if (getWaterFlowLevel(meta) === 0) {
            continue;
          }
          const wx = ox + lx;
          const wy = oy + ly;
          world.setBlockWithoutPlantCascadeForWater(wx, wy, airId);
        }
      }
    }

    let active = collectChunksWithWater(world, waterId);
    const spreadPasses = WATER_MAX_FLOW * 3 + 6;
    for (let i = 0; i < spreadPasses && active.size > 0; i++) {
      active = tickWaterFlow(world, airId, waterId, active);
    }
  } finally {
    world.popBulkForegroundWrites();
  }
}
