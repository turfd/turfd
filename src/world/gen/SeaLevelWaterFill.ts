/**
 * Final world-gen step: flood open-sky air, then turn visited air / plants / shoreline grass
 * at/below sea level into water. Grass below water becomes sand (shore) or dirt (deeper).
 */
import { CHUNK_SIZE } from "../../core/constants";
import { withWaterFlowLevel } from "../water/waterMetadata";
import { getBlock } from "../chunk/Chunk";
import { localIndex } from "../chunk/ChunkCoord";
import type { BlockRegistry } from "../blocks/BlockRegistry";
import type { Chunk } from "../chunk/Chunk";

const CELL_COUNT = CHUNK_SIZE * CHUNK_SIZE;

const DX = [1, -1, 0, 0] as const;
const DY = [0, 0, 1, -1] as const;

export type SeaLevelWaterFillConfig = {
  registry: BlockRegistry;
  airId: number;
  waterId: number;
  grassId: number;
  sandId: number;
  dirtId: number;
  /** World block Y: filled cells must be ≤ this (inclusive). */
  seaLevelWy: number;
  getSurfaceHeight: (wx: number) => number;
  /**
   * When provided, columns where this returns false keep air/plants (no sea fill conversion).
   * Used to suppress standing water in deserts while leaving flood logic unchanged elsewhere.
   */
  shouldPlaceWater?: (wx: number) => boolean;
};

function isReplaceablePlant(registry: BlockRegistry, airId: number, id: number): boolean {
  if (id === airId) {
    return false;
  }
  const def = registry.getById(id);
  return def.replaceable && !def.solid;
}

function hasVisitedNeighbor4(
  lx: number,
  ly: number,
  visited: Uint8Array,
): boolean {
  for (let d = 0; d < 4; d++) {
    const nl = lx + DX[d]!;
    const nly = ly + DY[d]!;
    if (nl < 0 || nl >= CHUNK_SIZE || nly < 0 || nly >= CHUNK_SIZE) {
      continue;
    }
    if (visited[localIndex(nl, nly)]) {
      return true;
    }
  }
  return false;
}

/** Run after terrain fill, before trees and surface decor (per-chunk; no cross-chunk air links). */
export function applySeaLevelFloodWater(
  chunk: Chunk,
  originWx: number,
  originWy: number,
  cfg: SeaLevelWaterFillConfig,
): void {
  const visited = new Uint8Array(CELL_COUNT);
  const qx = new Int16Array(CELL_COUNT);
  const qy = new Int16Array(CELL_COUNT);
  let qt = 0;
  let qh = 0;

  const {
    registry,
    airId,
    waterId,
    grassId,
    sandId,
    dirtId,
    seaLevelWy,
    getSurfaceHeight,
    shouldPlaceWater,
  } = cfg;

  for (let lx = 0; lx < CHUNK_SIZE; lx++) {
    const wx = originWx + lx;
    const surf = getSurfaceHeight(wx);
    for (let ly = 0; ly < CHUNK_SIZE; ly++) {
      const wy = originWy + ly;
      if (getBlock(chunk, lx, ly) !== airId) {
        continue;
      }
      if (wy <= surf) {
        continue;
      }
      const idx = localIndex(lx, ly);
      visited[idx] = 1;
      qx[qt] = lx;
      qy[qt] = ly;
      qt++;
    }
  }

  while (qh < qt) {
    const lx = qx[qh]!;
    const ly = qy[qh]!;
    qh++;
    for (let d = 0; d < 4; d++) {
      const nl = lx + DX[d]!;
      const nly = ly + DY[d]!;
      if (nl < 0 || nl >= CHUNK_SIZE || nly < 0 || nly >= CHUNK_SIZE) {
        continue;
      }
      const nidx = localIndex(nl, nly);
      if (visited[nidx]) {
        continue;
      }
      if (getBlock(chunk, nl, nly) !== airId) {
        continue;
      }
      visited[nidx] = 1;
      qx[qt] = nl;
      qy[qt] = nly;
      qt++;
    }
  }

  let expanded = true;
  while (expanded) {
    expanded = false;
    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      for (let ly = 0; ly < CHUNK_SIZE; ly++) {
        const wy = originWy + ly;
        if (wy > seaLevelWy) {
          continue;
        }
        const idx = localIndex(lx, ly);
        if (visited[idx]) {
          continue;
        }
        const id = chunk.blocks[idx]!;
        if (id === grassId) {
          const belowWaterFromAbove =
            ly < CHUNK_SIZE - 1 && visited[localIndex(lx, ly + 1)];
          if (belowWaterFromAbove || hasVisitedNeighbor4(lx, ly, visited)) {
            visited[idx] = 1;
            expanded = true;
          }
          continue;
        }
        if (id === airId || isReplaceablePlant(registry, airId, id)) {
          if (hasVisitedNeighbor4(lx, ly, visited)) {
            visited[idx] = 1;
            expanded = true;
          }
        }
      }
    }
  }

  for (let lx = 0; lx < CHUNK_SIZE; lx++) {
    const wx = originWx + lx;
    for (let ly = 0; ly < CHUNK_SIZE; ly++) {
      const wy = originWy + ly;
      if (wy > seaLevelWy) {
        continue;
      }
      const idx = localIndex(lx, ly);
      if (!visited[idx]) {
        continue;
      }
      if (shouldPlaceWater !== undefined && !shouldPlaceWater(wx)) {
        continue;
      }
      const id = chunk.blocks[idx]!;
      // Only convert air and plants to water; grass becomes sand via shore pass
      if (id === airId || isReplaceablePlant(registry, airId, id)) {
        chunk.blocks[idx] = waterId;
        // Still/source water (flow 0); matches bucket-placed sources and Minecraft oceans.
        chunk.metadata[idx] = withWaterFlowLevel(0, 0);
      }
    }
  }

  let shoreChanged = true;
  while (shoreChanged) {
    shoreChanged = false;
    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      const wx = originWx + lx;
      const surf = getSurfaceHeight(wx);
      for (let ly = 0; ly < CHUNK_SIZE - 1; ly++) {
        const idx = localIndex(lx, ly);
        if (chunk.blocks[idx] !== grassId) {
          continue;
        }
        const aboveIdx = localIndex(lx, ly + 1);
        if (chunk.blocks[aboveIdx] !== waterId) {
          continue;
        }
        const wy = originWy + ly;
        chunk.blocks[idx] = wy >= surf - 1 ? sandId : dirtId;
        chunk.metadata[idx] = 0;
        shoreChanged = true;
      }
    }
  }

  for (let i = 0; i < CELL_COUNT; i++) {
    if (chunk.blocks[i] === waterId) {
      chunk.background[i] = 0;
    }
  }
}

// ---------------------------------------------------------------------------
// Multi-chunk region (menu / parallax strips): same rules with world-space BFS
// ---------------------------------------------------------------------------

export type SeaLevelRegionBounds = {
  minCx: number;
  maxCx: number;
  minCy: number;
  maxCy: number;
};

function readWorldBlock(
  chunkMap: Map<string, Chunk>,
  wx: number,
  wy: number,
  airId: number,
): number {
  const cx = Math.floor(wx / CHUNK_SIZE);
  const cy = Math.floor(wy / CHUNK_SIZE);
  const ch = chunkMap.get(`${cx},${cy}`);
  if (ch === undefined) {
    return airId;
  }
  const lx = ((wx % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
  const ly = ((wy % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
  return getBlock(ch, lx, ly);
}

function writeWorldBlock(
  chunkMap: Map<string, Chunk>,
  wx: number,
  wy: number,
  id: number,
  meta: number,
): void {
  const cx = Math.floor(wx / CHUNK_SIZE);
  const cy = Math.floor(wy / CHUNK_SIZE);
  const ch = chunkMap.get(`${cx},${cy}`);
  if (ch === undefined) {
    return;
  }
  const lx = ((wx % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
  const ly = ((wy % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
  const idx = localIndex(lx, ly);
  ch.blocks[idx] = id;
  ch.metadata[idx] = meta;
  ch.dirty = true;
  ch.renderDirty = true;
}

function writeWorldBackground(
  chunkMap: Map<string, Chunk>,
  wx: number,
  wy: number,
  bg: number,
): void {
  const cx = Math.floor(wx / CHUNK_SIZE);
  const cy = Math.floor(wy / CHUNK_SIZE);
  const ch = chunkMap.get(`${cx},${cy}`);
  if (ch === undefined) {
    return;
  }
  const lx = ((wx % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
  const ly = ((wy % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
  const idx = localIndex(lx, ly);
  ch.background[idx] = bg;
  ch.dirty = true;
  ch.renderDirty = true;
}

function hasVisitedNeighbor4World(
  wx: number,
  wy: number,
  visited: Uint8Array,
  wx0: number,
  wy0: number,
  w: number,
  h: number,
): boolean {
  for (let d = 0; d < 4; d++) {
    const nx = wx + DX[d]!;
    const ny = wy + DY[d]!;
    if (nx < wx0 || nx > wx0 + w - 1 || ny < wy0 || ny > wy0 + h - 1) {
      continue;
    }
    const i = (ny - wy0) * w + (nx - wx0);
    if (visited[i]) {
      return true;
    }
  }
  return false;
}

/**
 * Sea / lake flood across several chunks at once so open air connects across chunk borders.
 * Use after {@link WorldGenerator.generateChunkTerrainOnly} for all chunks in the region,
 * then decorate each chunk.
 */
export function applySeaLevelFloodWaterRegion(
  chunkMap: Map<string, Chunk>,
  bounds: SeaLevelRegionBounds,
  cfg: SeaLevelWaterFillConfig,
): void {
  const {
    registry,
    airId,
    waterId,
    grassId,
    sandId,
    dirtId,
    seaLevelWy,
    getSurfaceHeight,
    shouldPlaceWater,
  } = cfg;

  const wx0 = bounds.minCx * CHUNK_SIZE;
  const wx1 = (bounds.maxCx + 1) * CHUNK_SIZE - 1;
  const wy0 = bounds.minCy * CHUNK_SIZE;
  const wy1 = (bounds.maxCy + 1) * CHUNK_SIZE - 1;

  const w = wx1 - wx0 + 1;
  const h = wy1 - wy0 + 1;
  const vis = new Uint8Array(w * h);
  const qCap = w * h;
  const qx = new Int32Array(qCap);
  const qy = new Int32Array(qCap);
  let qt = 0;
  let qh = 0;

  const vi = (wx: number, wy: number): number => (wy - wy0) * w + (wx - wx0);

  for (let wx = wx0; wx <= wx1; wx++) {
    const surf = getSurfaceHeight(wx);
    for (let wy = wy0; wy <= wy1; wy++) {
      if (readWorldBlock(chunkMap, wx, wy, airId) !== airId) {
        continue;
      }
      if (wy <= surf) {
        continue;
      }
      const i = vi(wx, wy);
      vis[i] = 1;
      qx[qt] = wx;
      qy[qt] = wy;
      qt++;
    }
  }

  while (qh < qt) {
    const wx = qx[qh]!;
    const wy = qy[qh]!;
    qh++;
    for (let d = 0; d < 4; d++) {
      const nx = wx + DX[d]!;
      const ny = wy + DY[d]!;
      if (nx < wx0 || nx > wx1 || ny < wy0 || ny > wy1) {
        continue;
      }
      const ni = vi(nx, ny);
      if (vis[ni]) {
        continue;
      }
      if (readWorldBlock(chunkMap, nx, ny, airId) !== airId) {
        continue;
      }
      vis[ni] = 1;
      qx[qt] = nx;
      qy[qt] = ny;
      qt++;
    }
  }

  const hasVis = (wx: number, wy: number): boolean => {
    if (wx < wx0 || wx > wx1 || wy < wy0 || wy > wy1) {
      return false;
    }
    return vis[vi(wx, wy)] !== 0;
  };

  let expanded = true;
  while (expanded) {
    expanded = false;
    for (let wx = wx0; wx <= wx1; wx++) {
      for (let wy = wy0; wy <= wy1; wy++) {
        if (wy > seaLevelWy) {
          continue;
        }
        const i = vi(wx, wy);
        if (vis[i]) {
          continue;
        }
        const id = readWorldBlock(chunkMap, wx, wy, airId);
        if (id === grassId) {
          const belowWaterFromAbove = wy < wy1 && hasVis(wx, wy + 1);
          if (
            belowWaterFromAbove ||
            hasVisitedNeighbor4World(wx, wy, vis, wx0, wy0, w, h)
          ) {
            vis[i] = 1;
            expanded = true;
          }
          continue;
        }
        if (id === airId || isReplaceablePlant(registry, airId, id)) {
          if (hasVisitedNeighbor4World(wx, wy, vis, wx0, wy0, w, h)) {
            vis[i] = 1;
            expanded = true;
          }
        }
      }
    }
  }

  for (let wx = wx0; wx <= wx1; wx++) {
    for (let wy = wy0; wy <= wy1; wy++) {
      if (wy > seaLevelWy) {
        continue;
      }
      const i = vi(wx, wy);
      if (!vis[i]) {
        continue;
      }
      if (shouldPlaceWater !== undefined && !shouldPlaceWater(wx)) {
        continue;
      }
      const id = readWorldBlock(chunkMap, wx, wy, airId);
      if (id === airId || id === grassId || isReplaceablePlant(registry, airId, id)) {
        writeWorldBlock(chunkMap, wx, wy, waterId, withWaterFlowLevel(0, 0));
      }
    }
  }

  let shoreChanged = true;
  while (shoreChanged) {
    shoreChanged = false;
    for (let wx = wx0; wx <= wx1; wx++) {
      const surf = getSurfaceHeight(wx);
      for (let wy = wy0; wy < wy1; wy++) {
        if (readWorldBlock(chunkMap, wx, wy, airId) !== grassId) {
          continue;
        }
        if (readWorldBlock(chunkMap, wx, wy + 1, airId) !== waterId) {
          continue;
        }
        const newId = wy >= surf - 1 ? sandId : dirtId;
        writeWorldBlock(chunkMap, wx, wy, newId, 0);
        shoreChanged = true;
      }
    }
  }

  for (let wx = wx0; wx <= wx1; wx++) {
    for (let wy = wy0; wy <= wy1; wy++) {
      if (readWorldBlock(chunkMap, wx, wy, airId) === waterId) {
        writeWorldBackground(chunkMap, wx, wy, 0);
      }
    }
  }
}
