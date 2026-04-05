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
import { getBlock } from "../chunk/Chunk";
import { localIndex, worldToLocalBlock } from "../chunk/ChunkCoord";
import type { World } from "../World";
import {
  getWaterFlowLevel,
  withWaterFlowLevel,
} from "./waterMetadata";

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
  const def = world.getBlock(wx, wy);
  if (def.id === airId || def.id === waterId) {
    return true;
  }
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

  world.spawnLootForBrokenBlock(def.id, wx, wy);
  world.setBlockWithoutPlantCascadeForWater(wx, wy, airId);
  return true;
}

/**
 * One pass: try down (source below), then horizontal spread with increasing flow level.
 */
export function tickWaterFlow(world: World, airId: number, waterId: number): void {
  world.pushBulkForegroundWrites();
  const cells: { wx: number; wy: number; level: number }[] = [];
  try {
    for (const chunk of world.iterLoadedChunks()) {
      const ox = chunk.coord.cx * CHUNK_SIZE;
      const oy = chunk.coord.cy * CHUNK_SIZE;
      for (let ly = 0; ly < CHUNK_SIZE; ly++) {
        for (let lx = 0; lx < CHUNK_SIZE; lx++) {
          const id = getBlock(chunk, lx, ly);
          if (id !== waterId) {
            continue;
          }
          const wx = ox + lx;
          const wy = oy + ly;
          const meta = chunk.metadata[localIndex(lx, ly)]!;
          cells.push({ wx, wy, level: getWaterFlowLevel(meta) });
        }
      }
    }

    cells.sort((a, b) => {
      if (a.wy !== b.wy) {
        return a.wy - b.wy;
      }
      return a.wx - b.wx;
    });

    for (const { wx, wy, level } of cells) {
      const belowY = wy - 1;
      if (belowY >= WORLD_Y_MIN) {
        if (prepareCellForWaterSpread(world, wx, belowY, airId, waterId)) {
          const belowId = world.getForegroundBlockId(wx, belowY);
          if (belowId === airId) {
            world.setBlock(wx, belowY, waterId, {
              cellMetadata: withWaterFlowLevel(0, 0),
            });
          } else if (belowId === waterId) {
            const chunk = world.getChunkAt(wx, belowY);
            if (chunk !== undefined) {
              const { lx, ly } = worldToLocalBlock(wx, belowY);
              const m = chunk.metadata[localIndex(lx, ly)]!;
              const cur = getWaterFlowLevel(m);
              if (cur > 0) {
                world.setBlock(wx, belowY, waterId, {
                  cellMetadata: withWaterFlowLevel(m, 0),
                });
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
        if (world.getChunkAt(nx, wy) === undefined) {
          continue;
        }
        if (!prepareCellForWaterSpread(world, nx, wy, airId, waterId)) {
          continue;
        }
        const nid = world.getForegroundBlockId(nx, wy);
        if (nid === airId) {
          world.setBlock(nx, wy, waterId, {
            cellMetadata: withWaterFlowLevel(0, nextLevel),
          });
        } else if (nid === waterId) {
          const chunk = world.getChunkAt(nx, wy)!;
          const { lx, ly } = worldToLocalBlock(nx, wy);
          const m = chunk.metadata[localIndex(lx, ly)]!;
          const nl = getWaterFlowLevel(m);
          if (nextLevel < nl) {
            world.setBlock(nx, wy, waterId, {
              cellMetadata: withWaterFlowLevel(m, nextLevel),
            });
          }
        }
      }
    }
  } finally {
    world.popBulkForegroundWrites();
  }
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
      for (let ly = 0; ly < CHUNK_SIZE; ly++) {
        for (let lx = 0; lx < CHUNK_SIZE; lx++) {
          const id = getBlock(chunk, lx, ly);
          if (id !== waterId) {
            continue;
          }
          const meta = chunk.metadata[localIndex(lx, ly)]!;
          if (getWaterFlowLevel(meta) === 0) {
            continue;
          }
          const wx = ox + lx;
          const wy = oy + ly;
          world.setBlockWithoutPlantCascadeForWater(wx, wy, airId);
        }
      }
    }

    const spreadPasses = WATER_MAX_FLOW * 3 + 6;
    for (let i = 0; i < spreadPasses; i++) {
      tickWaterFlow(world, airId, waterId);
    }
  } finally {
    world.popBulkForegroundWrites();
  }
}
