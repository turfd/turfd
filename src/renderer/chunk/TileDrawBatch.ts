/** Builds one batched MeshGeometry per chunk from block IDs + atlas UVs (no per-tile Graphics). */
import { FillGradient, Graphics, Mesh, MeshGeometry } from "pixi.js";
import { BLOCK_SIZE, CHUNK_SIZE } from "../../core/constants";
import type { BlockRegistry } from "../../world/blocks/BlockRegistry";
import type { Chunk } from "../../world/chunk/Chunk";
import { chunkToWorldOrigin, localIndex } from "../../world/chunk/ChunkCoord";
import type { World } from "../../world/World";
import type { AtlasLoader } from "../AtlasLoader";

const AIR_ID = 0;

/**
 * Deterministic “random” horizontal flip per cell. Mixes world coords + block id so
 * adjacent tiles don’t form stripes or checkerboards (unlike xor/parity tricks).
 */
function shouldFlipTextureX(wx: number, wy: number, blockId: number): boolean {
  let h = wx * 374761393 + wy * 668265263 + blockId * 1103515245;
  h ^= h >>> 13;
  h = Math.imul(h, 1274126177);
  h ^= h >>> 16;
  return (h & 1) !== 0;
}

function buildGeometryFromCells(
  chunk: Chunk,
  cells: Uint16Array,
  registry: BlockRegistry,
  atlas: AtlasLoader,
): MeshGeometry {
  const chunkOrigin = chunkToWorldOrigin(chunk.coord);
  let tileCount = 0;
  for (let i = 0; i < cells.length; i++) {
    if (cells[i] !== AIR_ID) {
      tileCount += 1;
    }
  }

  if (tileCount === 0) {
    return new MeshGeometry({
      positions: new Float32Array([0, 0, 0, 0, 0, 0]),
      uvs: new Float32Array([0, 0, 0, 0, 0, 0]),
      indices: new Uint32Array([0, 1, 2]),
    });
  }

  const vCount = tileCount * 4;
  const iCount = tileCount * 6;
  const positions = new Float32Array(vCount * 2);
  const uvs = new Float32Array(vCount * 2);
  const indices = new Uint32Array(iCount);

  let pi = 0;
  let ii = 0;
  let vertBase = 0;

  for (let ly = 0; ly < CHUNK_SIZE; ly++) {
    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      const id = cells[localIndex(lx, ly)]!;
      if (id === AIR_ID) {
        continue;
      }

      const def = registry.getById(id);
      const tex = atlas.getTexture(def.textureName);
      const fr = tex.frame;
      const sw = tex.source.width;
      const sh = tex.source.height;
      const u0 = fr.x / sw;
      const v0 = fr.y / sh;
      const u1 = (fr.x + fr.width) / sw;
      const v1 = (fr.y + fr.height) / sh;
      const worldX = chunkOrigin.wx + lx;
      const worldY = chunkOrigin.wy + ly;
      const flipX =
        def.randomFlipX === true && shouldFlipTextureX(worldX, worldY, id);
      const leftU = flipX ? u1 : u0;
      const rightU = flipX ? u0 : u1;

      const px = lx * BLOCK_SIZE;
      const py = -(ly + 1) * BLOCK_SIZE;
      const b = BLOCK_SIZE;
      const foot = Math.min(def.plantFootOffsetPx ?? 0, b - 1);
      const vTop = foot > 0 ? v0 + ((v1 - v0) * foot) / b : v0;
      const yTop = foot > 0 ? py + foot : py;

      positions[pi] = px;
      positions[pi + 1] = yTop;
      uvs[pi] = leftU;
      uvs[pi + 1] = vTop;
      pi += 2;

      positions[pi] = px + b;
      positions[pi + 1] = yTop;
      uvs[pi] = rightU;
      uvs[pi + 1] = vTop;
      pi += 2;

      positions[pi] = px;
      positions[pi + 1] = py + b;
      uvs[pi] = leftU;
      uvs[pi + 1] = v1;
      pi += 2;

      positions[pi] = px + b;
      positions[pi + 1] = py + b;
      uvs[pi] = rightU;
      uvs[pi + 1] = v1;
      pi += 2;

      const b0 = vertBase;
      indices[ii] = b0;
      indices[ii + 1] = b0 + 1;
      indices[ii + 2] = b0 + 2;
      indices[ii + 3] = b0 + 1;
      indices[ii + 4] = b0 + 3;
      indices[ii + 5] = b0 + 2;
      ii += 6;
      vertBase += 4;
    }
  }

  return new MeshGeometry({ positions, uvs, indices });
}

/** Mild dim for back-wall tiles vs foreground (same lighting pass). */
const BACKGROUND_MESH_TINT = 0xd0d0d0;

/** Depth of contact-shadow bands (px) along bg faces adjacent to solid foreground. */
const FG_ON_BG_SHADOW_DEPTH_PX = Math.round(BLOCK_SIZE * 0.44);

const GRAD_OPTS = {
  type: "linear" as const,
  textureSpace: "local" as const,
  textureSize: 64,
};

/** Fg above this bg cell → darken top strip (strong at top edge). */
const GRAD_SHADOW_FROM_TOP = new FillGradient({
  ...GRAD_OPTS,
  start: { x: 0.5, y: 0 },
  end: { x: 0.5, y: 1 },
  colorStops: [
    { offset: 0, color: "rgba(0,0,0,0.34)" },
    { offset: 0.28, color: "rgba(0,0,0,0.14)" },
    { offset: 0.62, color: "rgba(0,0,0,0.04)" },
    { offset: 1, color: "rgba(0,0,0,0)" },
  ],
});

/** Fg below this bg cell → darken bottom strip (strong at bottom edge). */
const GRAD_SHADOW_FROM_BOTTOM = new FillGradient({
  ...GRAD_OPTS,
  start: { x: 0.5, y: 0 },
  end: { x: 0.5, y: 1 },
  colorStops: [
    { offset: 0, color: "rgba(0,0,0,0)" },
    { offset: 0.38, color: "rgba(0,0,0,0.05)" },
    { offset: 0.72, color: "rgba(0,0,0,0.16)" },
    { offset: 1, color: "rgba(0,0,0,0.32)" },
  ],
});

/** Fg to the west → darken left strip (strong at left edge). */
const GRAD_SHADOW_FROM_LEFT = new FillGradient({
  ...GRAD_OPTS,
  start: { x: 0, y: 0.5 },
  end: { x: 1, y: 0.5 },
  colorStops: [
    { offset: 0, color: "rgba(0,0,0,0.3)" },
    { offset: 0.35, color: "rgba(0,0,0,0.12)" },
    { offset: 1, color: "rgba(0,0,0,0)" },
  ],
});

/** Fg to the east → darken right strip (strong at right edge). */
const GRAD_SHADOW_FROM_RIGHT = new FillGradient({
  ...GRAD_OPTS,
  start: { x: 1, y: 0.5 },
  end: { x: 0, y: 0.5 },
  colorStops: [
    { offset: 0, color: "rgba(0,0,0,0.3)" },
    { offset: 0.35, color: "rgba(0,0,0,0.12)" },
    { offset: 1, color: "rgba(0,0,0,0)" },
  ],
});

/** Samples solid foreground across chunk boundaries (loaded chunks only). */
export type FgShadowSampler = {
  isSolidForegroundAt(wx: number, wy: number): boolean;
};

export function createWorldFgShadowSampler(world: World): FgShadowSampler {
  return {
    isSolidForegroundAt(wx: number, wy: number): boolean {
      return world.getBlock(wx, wy).solid;
    },
  };
}

/**
 * Smooth contact shadows on back-wall tiles from orthogonally adjacent solid foreground.
 * World-space occlusion fixes missing shadows at chunk edges. Drawn between bg and fg meshes.
 */
export function redrawForegroundCastShadowOnBackground(
  g: Graphics,
  chunk: Chunk,
  sampler: FgShadowSampler,
): void {
  g.clear();
  const backgrounds = chunk.background;
  const depth = Math.max(4, FG_ON_BG_SHADOW_DEPTH_PX);
  const origin = chunkToWorldOrigin(chunk.coord);

  for (let ly = 0; ly < CHUNK_SIZE; ly++) {
    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      if (backgrounds[localIndex(lx, ly)]! === AIR_ID) {
        continue;
      }

      const wx = origin.wx + lx;
      const wy = origin.wy + ly;
      const px = lx * BLOCK_SIZE;
      const py = -(ly + 1) * BLOCK_SIZE;
      const cellBottomY = py + BLOCK_SIZE;

      if (sampler.isSolidForegroundAt(wx, wy + 1)) {
        g.rect(px, py, BLOCK_SIZE, depth).fill(GRAD_SHADOW_FROM_TOP);
      }
      if (sampler.isSolidForegroundAt(wx, wy - 1)) {
        g.rect(px, cellBottomY - depth, BLOCK_SIZE, depth).fill(
          GRAD_SHADOW_FROM_BOTTOM,
        );
      }
      if (sampler.isSolidForegroundAt(wx - 1, wy)) {
        g.rect(px, py, depth, BLOCK_SIZE).fill(GRAD_SHADOW_FROM_LEFT);
      }
      if (sampler.isSolidForegroundAt(wx + 1, wy)) {
        g.rect(px + BLOCK_SIZE - depth, py, depth, BLOCK_SIZE).fill(
          GRAD_SHADOW_FROM_RIGHT,
        );
      }
    }
  }
}

export function buildMesh(
  chunk: Chunk,
  registry: BlockRegistry,
  atlas: AtlasLoader,
): Mesh {
  const geometry = buildGeometryFromCells(chunk, chunk.blocks, registry, atlas);
  return new Mesh({
    geometry,
    texture: atlas.getAtlasTexture(),
    roundPixels: true,
  });
}

export function buildBackgroundMesh(
  chunk: Chunk,
  registry: BlockRegistry,
  atlas: AtlasLoader,
): Mesh {
  const geometry = buildGeometryFromCells(
    chunk,
    chunk.background,
    registry,
    atlas,
  );
  return new Mesh({
    geometry,
    texture: atlas.getAtlasTexture(),
    roundPixels: true,
    tint: BACKGROUND_MESH_TINT,
  });
}

export function updateMesh(
  mesh: Mesh,
  chunk: Chunk,
  registry: BlockRegistry,
  atlas: AtlasLoader,
): void {
  const next = buildGeometryFromCells(chunk, chunk.blocks, registry, atlas);
  mesh.geometry.destroy();
  mesh.geometry = next;
}

export function updateBackgroundMesh(
  mesh: Mesh,
  chunk: Chunk,
  registry: BlockRegistry,
  atlas: AtlasLoader,
): void {
  const next = buildGeometryFromCells(
    chunk,
    chunk.background,
    registry,
    atlas,
  );
  mesh.geometry.destroy();
  mesh.geometry = next;
}
