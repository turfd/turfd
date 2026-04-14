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
const WATER_DOWNWARD_FLOW_LEVEL = 1;

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

function getFlowLevelAt(world: World, waterId: number, wx: number, wy: number): number | null {
  const chunk = world.getChunkAt(wx, wy);
  if (chunk === undefined) {
    return null;
  }
  const idx = chunkLocalIndexForWorldCell(chunk, wx, wy);
  if (chunk.blocks[idx] !== waterId) {
    return null;
  }
  return getWaterFlowLevel(chunk.metadata[idx]!);
}

function hasHorizontalFeeder(
  world: World,
  waterId: number,
  wx: number,
  wy: number,
  level: number,
): boolean {
  if (level <= 0) {
    return true;
  }
  const left = getFlowLevelAt(world, waterId, wx - 1, wy);
  if (left !== null && left < level) {
    return true;
  }
  const right = getFlowLevelAt(world, waterId, wx + 1, wy);
  if (right !== null && right < level) {
    return true;
  }
  return false;
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
 * One pass:
 * 1) remove unfed flowing water (retreat),
 * 2) try down (flowing below),
 * 3) horizontal spread with increasing flow level.
 *
 * Important: downward spread must never create new sources. Only explicit placements
 * (bucket/worldgen) should produce flow level 0 source blocks.
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
        if (level > 0) {
          const fedFromAbove = getFlowLevelAt(world, waterId, wx, wy + 1) !== null;
          const fedFromSide = hasHorizontalFeeder(world, waterId, wx, wy, level);
          if (!fedFromAbove && !fedFromSide) {
            if (world.setBlockWithoutPlantCascadeForWater(wx, wy, airId)) {
              markNextActiveAroundWorldCell(nextActive, wx, wy);
            }
            continue;
          }
        }
        let hasDownwardPath = false;
        const belowY = wy - 1;
        if (belowY >= WORLD_Y_MIN) {
          if (prepareCellForWaterSpread(world, wx, belowY, airId, waterId)) {
            const belowChunk = world.getChunkAt(wx, belowY);
            const belowId =
              belowChunk === undefined
                ? airId
                : belowChunk.blocks[chunkLocalIndexForWorldCell(belowChunk, wx, belowY)]!;
            if (belowId === airId) {
              hasDownwardPath = true;
              if (
                world.setBlock(wx, belowY, waterId, {
                  cellMetadata: withWaterFlowLevel(0, WATER_DOWNWARD_FLOW_LEVEL),
                })
              ) {
                markNextActiveAroundWorldCell(nextActive, wx, belowY);
              }
            } else if (belowId === waterId) {
              hasDownwardPath = true;
              if (belowChunk !== undefined) {
                const m =
                  belowChunk.metadata[chunkLocalIndexForWorldCell(belowChunk, wx, belowY)]!;
                const cur = getWaterFlowLevel(m);
                if (
                  cur !== WATER_DOWNWARD_FLOW_LEVEL &&
                  world.setBlock(wx, belowY, waterId, {
                    cellMetadata: withWaterFlowLevel(m, WATER_DOWNWARD_FLOW_LEVEL),
                  })
                ) {
                  markNextActiveAroundWorldCell(nextActive, wx, belowY);
                }
              }
            }
          }
        }

        // Minecraft-style preference: if water can continue falling, do not fan out sideways
        // from this cell yet. This prevents giant "shelf" flows from hillside placements.
        if (hasDownwardPath) {
          continue;
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

/** After topology changes, reactivate all chunks that still contain water for gradual settle/retreat. */
export function resimulateWaterFromSources(
  world: World,
  waterId: number,
): Set<number> {
  return collectChunksWithWater(world, waterId);
}
