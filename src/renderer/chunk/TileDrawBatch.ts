/** Builds one batched MeshGeometry per chunk from block IDs + atlas UVs (no per-tile Graphics). */
import { Mesh, MeshGeometry, Texture } from "pixi.js";
import { BLOCK_SIZE, CHUNK_SIZE } from "../../core/constants";
import type { BlockRegistry } from "../../world/blocks/BlockRegistry";
import type { Chunk } from "../../world/chunk/Chunk";
import { getBlock } from "../../world/chunk/Chunk";
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

/** Deterministic variant index (different primes from flip so the two are independent). */
function pickTextureVariant(
  wx: number,
  wy: number,
  blockId: number,
  variantCount: number,
): number {
  if (variantCount <= 1) return 0;
  let h = wx * 2654435761 + wy * 2246822519 + blockId * 3266489917;
  h ^= h >>> 15;
  h = Math.imul(h, 2246822519);
  h ^= h >>> 13;
  return (h >>> 0) % variantCount;
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
      const worldX = chunkOrigin.wx + lx;
      const worldY = chunkOrigin.wy + ly;

      const variants = atlas.getTextureVariants(def.textureName);
      const tex =
        variants.length > 1
          ? variants[pickTextureVariant(worldX, worldY, id, variants.length)]!
          : variants[0]!;

      const fr = tex.frame;
      const sw = tex.source.width;
      const sh = tex.source.height;
      const u0 = fr.x / sw;
      const v0 = fr.y / sh;
      const u1 = (fr.x + fr.width) / sw;
      const v1 = (fr.y + fr.height) / sh;
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

/** Four 64×8 gradient strips in one row (top, bottom, left, right). */
let fgShadowTexture: Texture | null = null;

function getFgShadowTexture(): Texture {
  if (fgShadowTexture !== null) {
    return fgShadowTexture;
  }
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 8;
  const ctx = c.getContext("2d");
  if (ctx === null) {
    throw new Error("Fg shadow atlas: no 2d context");
  }
  const patches = [
    (x: number) => {
      const g = ctx.createLinearGradient(x + 32, 0, x + 32, 8);
      g.addColorStop(0, "rgba(0,0,0,0.34)");
      g.addColorStop(0.28, "rgba(0,0,0,0.14)");
      g.addColorStop(0.62, "rgba(0,0,0,0.04)");
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g;
      ctx.fillRect(x, 0, 64, 8);
    },
    (x: number) => {
      const g = ctx.createLinearGradient(x + 32, 0, x + 32, 8);
      g.addColorStop(0, "rgba(0,0,0,0)");
      g.addColorStop(0.38, "rgba(0,0,0,0.05)");
      g.addColorStop(0.72, "rgba(0,0,0,0.16)");
      g.addColorStop(1, "rgba(0,0,0,0.32)");
      ctx.fillStyle = g;
      ctx.fillRect(x, 0, 64, 8);
    },
    (x: number) => {
      const g = ctx.createLinearGradient(x, 4, x + 64, 4);
      g.addColorStop(0, "rgba(0,0,0,0.3)");
      g.addColorStop(0.35, "rgba(0,0,0,0.12)");
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g;
      ctx.fillRect(x, 0, 64, 8);
    },
    (x: number) => {
      const g = ctx.createLinearGradient(x + 64, 4, x, 4);
      g.addColorStop(0, "rgba(0,0,0,0.3)");
      g.addColorStop(0.35, "rgba(0,0,0,0.12)");
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g;
      ctx.fillRect(x, 0, 64, 8);
    },
  ];
  for (let p = 0; p < 4; p++) {
    patches[p]!(p * 64);
  }
  fgShadowTexture = Texture.from(c);
  return fgShadowTexture;
}

/** Samples solid foreground across chunk boundaries (loaded chunks only). */
export type FgShadowSampler = {
  isSolidForegroundAt(wx: number, wy: number): boolean;
};

export function createWorldFgShadowSampler(world: World): FgShadowSampler {
  const reg = world.getRegistry();
  return {
    isSolidForegroundAt(wx: number, wy: number): boolean {
      const chunk = world.getChunkAt(wx, wy);
      if (chunk === undefined) {
        return false;
      }
      const lx = ((wx % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
      const ly = ((wy % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
      return reg.isSolid(getBlock(chunk, lx, ly));
    },
  };
}

const PATCH_U = 1 / 4;

function pushShadowQuad(
  positions: Float32Array,
  uvs: Float32Array,
  indices: Uint32Array,
  pi: number,
  ii: number,
  vertBase: number,
  patch: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): { pi: number; vertBase: number } {
  const ub = patch * PATCH_U;
  const ue = ub + PATCH_U;
  const ul = ub;
  const ur = ue;
  const vt = 0;
  const vb = 1;

  positions[pi] = x0;
  positions[pi + 1] = y0;
  uvs[pi] = ul;
  uvs[pi + 1] = vt;
  pi += 2;
  positions[pi] = x1;
  positions[pi + 1] = y0;
  uvs[pi] = ur;
  uvs[pi + 1] = vt;
  pi += 2;
  positions[pi] = x0;
  positions[pi + 1] = y1;
  uvs[pi] = ul;
  uvs[pi + 1] = vb;
  pi += 2;
  positions[pi] = x1;
  positions[pi + 1] = y1;
  uvs[pi] = ur;
  uvs[pi + 1] = vb;
  pi += 2;

  const b0 = vertBase;
  indices[ii] = b0;
  indices[ii + 1] = b0 + 1;
  indices[ii + 2] = b0 + 2;
  indices[ii + 3] = b0 + 1;
  indices[ii + 4] = b0 + 3;
  indices[ii + 5] = b0 + 2;

  return { pi, vertBase: vertBase + 4 };
}

function buildFgShadowGeometry(
  chunk: Chunk,
  sampler: FgShadowSampler,
): MeshGeometry {
  const backgrounds = chunk.background;
  const depth = Math.max(4, FG_ON_BG_SHADOW_DEPTH_PX);
  const origin = chunkToWorldOrigin(chunk.coord);

  let quadCount = 0;
  for (let ly = 0; ly < CHUNK_SIZE; ly++) {
    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      if (backgrounds[localIndex(lx, ly)]! === AIR_ID) {
        continue;
      }
      const wx = origin.wx + lx;
      const wy = origin.wy + ly;
      if (sampler.isSolidForegroundAt(wx, wy + 1)) quadCount += 1;
      if (sampler.isSolidForegroundAt(wx, wy - 1)) quadCount += 1;
      if (sampler.isSolidForegroundAt(wx - 1, wy)) quadCount += 1;
      if (sampler.isSolidForegroundAt(wx + 1, wy)) quadCount += 1;
    }
  }

  if (quadCount === 0) {
    return new MeshGeometry({
      positions: new Float32Array([0, 0, 0, 0, 0, 0]),
      uvs: new Float32Array([0, 0, 0, 0, 0, 0]),
      indices: new Uint32Array([0, 1, 2]),
    });
  }

  const vCount = quadCount * 4;
  const iCount = quadCount * 6;
  const positions = new Float32Array(vCount * 2);
  const uvs = new Float32Array(vCount * 2);
  const indices = new Uint32Array(iCount);

  let pi = 0;
  let ii = 0;
  let vertBase = 0;

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
        const r = pushShadowQuad(
          positions,
          uvs,
          indices,
          pi,
          ii,
          vertBase,
          0,
          px,
          py,
          px + BLOCK_SIZE,
          py + depth,
        );
        pi = r.pi;
        vertBase = r.vertBase;
        ii += 6;
      }
      if (sampler.isSolidForegroundAt(wx, wy - 1)) {
        const r = pushShadowQuad(
          positions,
          uvs,
          indices,
          pi,
          ii,
          vertBase,
          1,
          px,
          cellBottomY - depth,
          px + BLOCK_SIZE,
          cellBottomY,
        );
        pi = r.pi;
        vertBase = r.vertBase;
        ii += 6;
      }
      if (sampler.isSolidForegroundAt(wx - 1, wy)) {
        const r = pushShadowQuad(
          positions,
          uvs,
          indices,
          pi,
          ii,
          vertBase,
          2,
          px,
          py,
          px + depth,
          py + BLOCK_SIZE,
        );
        pi = r.pi;
        vertBase = r.vertBase;
        ii += 6;
      }
      if (sampler.isSolidForegroundAt(wx + 1, wy)) {
        const r = pushShadowQuad(
          positions,
          uvs,
          indices,
          pi,
          ii,
          vertBase,
          3,
          px + BLOCK_SIZE - depth,
          py,
          px + BLOCK_SIZE,
          py + BLOCK_SIZE,
        );
        pi = r.pi;
        vertBase = r.vertBase;
        ii += 6;
      }
    }
  }

  return new MeshGeometry({ positions, uvs, indices });
}

/**
 * Batched contact shadows on back-wall tiles from orthogonally adjacent solid foreground.
 * One Mesh per chunk (shared gradient atlas). Drawn between bg and fg meshes.
 */
export function buildFgShadowMesh(
  chunk: Chunk,
  sampler: FgShadowSampler,
): Mesh {
  const geometry = buildFgShadowGeometry(chunk, sampler);
  return new Mesh({
    geometry,
    texture: getFgShadowTexture(),
    roundPixels: true,
  });
}

export function updateFgShadowMesh(
  mesh: Mesh,
  chunk: Chunk,
  sampler: FgShadowSampler,
): void {
  const next = buildFgShadowGeometry(chunk, sampler);
  mesh.geometry.destroy();
  mesh.geometry = next;
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
