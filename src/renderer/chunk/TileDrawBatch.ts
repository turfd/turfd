/** Builds one batched MeshGeometry per chunk from block IDs + atlas UVs (no per-tile Graphics). */
import { Mesh, MeshGeometry, Texture } from "pixi.js";
import { BLOCK_SIZE, CHUNK_SIZE } from "../../core/constants";
import {
  getWaterFlowLevel,
  waterDepthVInCell,
  waterFlowTopCropPx,
} from "../../world/water/waterMetadata";
import type { BlockDefinition } from "../../world/blocks/BlockDefinition";
import type { BlockRegistry } from "../../world/blocks/BlockRegistry";
import type { Chunk } from "../../world/chunk/Chunk";
import { getBlock } from "../../world/chunk/Chunk";
import { chunkToWorldOrigin, localIndex } from "../../world/chunk/ChunkCoord";
import type { World } from "../../world/World";
import type { AtlasLoader } from "../AtlasLoader";
import { chestVisualRole } from "../../world/chest/chestVisual";

const AIR_ID = 0;

/** World-space block id for mesh UVs (chest pairing across chunk edges). */
export type BlockIdWorldSampler = (wx: number, wy: number) => number;

export type TileMeshBuildOptions = {
  /** When set with {@link sampleBlockId}, paired chests use full `chest_double` per tile (east flipped). */
  chestBlockId: number | null;
  sampleBlockId: BlockIdWorldSampler;
};

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

/** Slow wind oscillation (rad/s); per-tile multiplier spreads desync without hectic motion. */
const WIND_SWAY_BASE_FREQ = 0.95;

/**
 * Rigid strip at the cell bottom (world px): no horizontal wind so the plant reads as rooted.
 * Only used for grounded sway tiles (not {@link BlockDefinition.tallGrass} `"top"`).
 */
const WIND_SWAY_GROUND_DEADBAND_PX = 4;

/** Shared edge between tall-grass bottom and top cells (avoids a kink at the seam). */
const WIND_SWAY_TALL_MID_BLEND = 0.62;

/** Ground edge trails the wave so the crown leads; seam uses 0 offset (tall-grass joint stays aligned). */
const WIND_SWAY_GROUND_PHASE_LAG_RAD = 0.44;

/** Crown edge is slightly ahead of the reference phase so tips move before the base catches up. */
const WIND_SWAY_CROWN_PHASE_LEAD_RAD = 0.38;

type WindWaveTier = "ground" | "seam" | "crown";

function windSin(tArg: number, phase: number, tier: WindWaveTier): number {
  let off = 0;
  if (tier === "ground") {
    off = -WIND_SWAY_GROUND_PHASE_LAG_RAD;
  } else if (tier === "crown") {
    off = WIND_SWAY_CROWN_PHASE_LEAD_RAD;
  }
  return Math.sin(tArg + phase + off);
}

/** Phase for sway (radians), shared by tall-grass bottom + top via {@link windAnchorWorldY}. */
function windPhaseRad(wx: number, wy: number): number {
  let h = wx * 19349663 + wy * 83492791;
  h ^= h >>> 17;
  h = Math.imul(h, 1597334677);
  h >>>= 0;
  return ((h & 0xffffff) / 0xffffff) * Math.PI * 2;
}

/** Per-tile frequency multiplier in ~[0.82, 1.18]. */
function windFreqMul(wx: number, wy: number): number {
  let h = wx * 73856093 + wy * 19349663 + 999331;
  h ^= h >>> 13;
  h = Math.imul(h, 2246822519);
  h >>>= 0;
  return 0.82 + ((h & 0xff) / 0xff) * 0.36;
}

/** World Y used for phase/frequency so tall-grass top matches its bottom cell. */
function windAnchorWorldY(
  worldY: number,
  tallGrass: "none" | "bottom" | "top",
): number {
  return tallGrass === "top" ? worldY - 1 : worldY;
}

export type TileWindSway = {
  /** Index in `positions` of the first vertex (x of top-left). */
  posIndex: number;
  xLeft: number;
  xRight: number;
  phase: number;
  freqMul: number;
  maxPx: number;
  /** `sin` amplitude multiplier for bottom edge of this quad (0–1). */
  bottomWaveMul: number;
  /** `sin` amplitude multiplier for top edge of this quad (0–1). */
  topWaveMul: number;
  /** Phase tier for BL/BR (`seam` matches the cell below’s top edge). */
  bottomWaveTier: "ground" | "seam";
  /** Phase tier for TL/TR (`seam` matches the cell above’s bottom edge). */
  topWaveTier: "seam" | "crown";
};

type BuiltTileGeometry = {
  geometry: MeshGeometry;
  windSways: TileWindSway[];
};

/** One or two quads per cell when a ground deadband splits wind geometry. */
function windForegroundQuadsForCell(def: BlockDefinition, ly: number): number {
  const maxWind = def.windSwayMaxPx ?? 0;
  if (maxWind <= 0 || def.tallGrass === "top") {
    return 1;
  }
  const py = -(ly + 1) * BLOCK_SIZE;
  const foot = Math.min(def.plantFootOffsetPx ?? 0, BLOCK_SIZE - 1);
  const yTop = foot > 0 ? py + foot : py;
  const yBottom = py + BLOCK_SIZE;
  const h = yBottom - yTop;
  return h > WIND_SWAY_GROUND_DEADBAND_PX ? 2 : 1;
}

function buildGeometryFromCells(
  chunk: Chunk,
  cells: Uint16Array,
  registry: BlockRegistry,
  atlas: AtlasLoader,
  opts?: TileMeshBuildOptions,
): BuiltTileGeometry {
  const chunkOrigin = chunkToWorldOrigin(chunk.coord);
  let quadCount = 0;
  for (let ly = 0; ly < CHUNK_SIZE; ly++) {
    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      const id = cells[localIndex(lx, ly)]!;
      if (id === AIR_ID) {
        continue;
      }
      quadCount += windForegroundQuadsForCell(registry.getById(id), ly);
    }
  }

  if (quadCount === 0) {
    return {
      geometry: new MeshGeometry({
        positions: new Float32Array([0, 0, 0, 0, 0, 0]),
        uvs: new Float32Array([0, 0, 0, 0, 0, 0]),
        indices: new Uint32Array([0, 1, 2]),
      }),
      windSways: [],
    };
  }

  const vCount = quadCount * 4;
  const iCount = quadCount * 6;
  const positions = new Float32Array(vCount * 2);
  const uvs = new Float32Array(vCount * 2);
  const indices = new Uint32Array(iCount);
  const windSways: TileWindSway[] = [];

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

      let drawableTextureName = def.textureName;
      /** Paired chest: east tile flipped `chest_double`, west unflipped (latches meet at seam). */
      let chestDoubleCell: "west" | "east" | null = null;
      if (
        def.identifier === "stratum:chest" &&
        opts !== undefined &&
        opts.chestBlockId !== null &&
        opts.chestBlockId > 0
      ) {
        const cid = opts.chestBlockId;
        const isChest = (x: number, y: number) => opts.sampleBlockId(x, y) === cid;
        const role = chestVisualRole(worldX, worldY, isChest);
        if (role === "doubleLeft") {
          drawableTextureName = "chest_double";
          chestDoubleCell = "west";
        } else if (role === "doubleRight") {
          drawableTextureName = "chest_double";
          chestDoubleCell = "east";
        } else {
          drawableTextureName = "chest";
        }
      }

      /** Same atlas variant for both cells (east cell borrows west world X for alts). */
      const variantWx = chestDoubleCell === "east" ? worldX - 1 : worldX;
      const variantWy = worldY;
      const variants = atlas.getTextureVariants(drawableTextureName);
      const tex =
        variants.length > 1
          ? variants[pickTextureVariant(variantWx, variantWy, id, variants.length)]!
          : variants[0]!;

      const fr = tex.frame;
      const sw = tex.source.width;
      const sh = tex.source.height;
      const u0 = fr.x / sw;
      const v0 = fr.y / sh;
      const u1 = (fr.x + fr.width) / sw;
      const v1 = (fr.y + fr.height) / sh;
      let leftU: number;
      let rightU: number;
      if (chestDoubleCell === "west") {
        leftU = u0;
        rightU = u1;
      } else if (chestDoubleCell === "east") {
        leftU = u1;
        rightU = u0;
      } else {
        const flipX =
          def.randomFlipX === true && shouldFlipTextureX(worldX, worldY, id);
        leftU = flipX ? u1 : u0;
        rightU = flipX ? u0 : u1;
      }

      const px = lx * BLOCK_SIZE;
      const py = -(ly + 1) * BLOCK_SIZE;
      const b = BLOCK_SIZE;
      let foot = Math.min(def.plantFootOffsetPx ?? 0, b - 1);
      if (def.identifier === "stratum:water") {
        const meta = chunk.metadata[localIndex(lx, ly)]!;
        foot = Math.min(waterFlowTopCropPx(getWaterFlowLevel(meta)), b - 1);
      }
      const vTopBase = foot > 0 ? v0 + ((v1 - v0) * foot) / b : v0;
      const yTopBase = foot > 0 ? py + foot : py;
      let vUvTop = vTopBase;
      let vUvBottom = v1;
      if (def.identifier === "stratum:water") {
        const topPx = (worldY + 1) * BLOCK_SIZE - foot;
        const botPx = worldY * BLOCK_SIZE;
        vUvTop = waterDepthVInCell(topPx, vTopBase, v1);
        vUvBottom = waterDepthVInCell(botPx, vTopBase, v1);
      }

      const plantY =
        def.identifier === "stratum:water"
          ? 0
          : (def.plantRenderOffsetYPx ?? 0);
      const yTop = yTopBase + plantY;
      const yBottom = py + b + plantY;

      const maxWind = def.windSwayMaxPx ?? 0;
      const visibleH = yBottom - yTop;
      const useWindGroundDeadband =
        maxWind > 0 &&
        def.tallGrass !== "top" &&
        visibleH > WIND_SWAY_GROUND_DEADBAND_PX;

      const emitQuad = (
        yT: number,
        yB: number,
        vT: number,
        vB: number,
      ): void => {
        positions[pi] = px;
        positions[pi + 1] = yT;
        uvs[pi] = leftU;
        uvs[pi + 1] = vT;
        pi += 2;

        positions[pi] = px + b;
        positions[pi + 1] = yT;
        uvs[pi] = rightU;
        uvs[pi + 1] = vT;
        pi += 2;

        positions[pi] = px;
        positions[pi + 1] = yB;
        uvs[pi] = leftU;
        uvs[pi + 1] = vB;
        pi += 2;

        positions[pi] = px + b;
        positions[pi + 1] = yB;
        uvs[pi] = rightU;
        uvs[pi + 1] = vB;
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
      };

      if (useWindGroundDeadband) {
        const yBandTop = yBottom - WIND_SWAY_GROUND_DEADBAND_PX;
        const vBandTop =
          vTopBase + ((yBandTop - yTop) / visibleH) * (v1 - vTopBase);
        emitQuad(yBandTop, yBottom, vBandTop, v1);

        const swayPosStart = pi;
        emitQuad(yTop, yBandTop, vTopBase, vBandTop);

        const ay = windAnchorWorldY(worldY, def.tallGrass);
        windSways.push({
          posIndex: swayPosStart,
          xLeft: px,
          xRight: px + b,
          phase: windPhaseRad(worldX, ay),
          freqMul: windFreqMul(worldX, ay),
          maxPx: maxWind,
          bottomWaveMul: 0,
          topWaveMul:
            def.tallGrass === "bottom"
              ? WIND_SWAY_TALL_MID_BLEND
              : 1,
          bottomWaveTier: "seam",
          topWaveTier: def.tallGrass === "bottom" ? "seam" : "crown",
        });
      } else {
        const quadPosStart = pi;
        emitQuad(yTop, yBottom, vUvTop, vUvBottom);

        if (maxWind > 0) {
          const ay = windAnchorWorldY(worldY, def.tallGrass);
          const bottomWaveMul = 0;
          const topWaveMul = 1;
          const bottomWaveTier: "ground" | "seam" =
            def.tallGrass === "top" ? "seam" : "ground";
          const topWaveTier: "seam" | "crown" = "crown";
          windSways.push({
            posIndex: quadPosStart,
            xLeft: px,
            xRight: px + b,
            phase: windPhaseRad(worldX, ay),
            freqMul: windFreqMul(worldX, ay),
            maxPx: maxWind,
            bottomWaveMul,
            topWaveMul,
            bottomWaveTier,
            topWaveTier,
          });
        }
      }
    }
  }

  return {
    geometry: new MeshGeometry({ positions, uvs, indices }),
    windSways,
  };
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

export type ForegroundTileMeshBundle = {
  mesh: Mesh;
  windSways: TileWindSway[];
};

export function buildMesh(
  chunk: Chunk,
  registry: BlockRegistry,
  atlas: AtlasLoader,
  opts?: TileMeshBuildOptions,
): ForegroundTileMeshBundle {
  const { geometry, windSways } = buildGeometryFromCells(
    chunk,
    chunk.blocks,
    registry,
    atlas,
    opts,
  );
  return {
    mesh: new Mesh({
      geometry,
      texture: atlas.getAtlasTexture(),
      roundPixels: true,
    }),
    windSways,
  };
}

export function buildBackgroundMesh(
  chunk: Chunk,
  registry: BlockRegistry,
  atlas: AtlasLoader,
): Mesh {
  const { geometry } = buildGeometryFromCells(
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
  opts?: TileMeshBuildOptions,
): TileWindSway[] {
  const { geometry, windSways } = buildGeometryFromCells(
    chunk,
    chunk.blocks,
    registry,
    atlas,
    opts,
  );
  mesh.geometry.destroy();
  mesh.geometry = geometry;
  return windSways;
}

export function updateBackgroundMesh(
  mesh: Mesh,
  chunk: Chunk,
  registry: BlockRegistry,
  atlas: AtlasLoader,
): void {
  const { geometry } = buildGeometryFromCells(
    chunk,
    chunk.background,
    registry,
    atlas,
  );
  mesh.geometry.destroy();
  mesh.geometry = geometry;
}

/**
 * Wind bend in **integer pixels**, crown slightly **ahead in phase** vs ground so tips lead;
 * tall-grass **seam** edges share the reference phase so the two cells stay aligned.
 */
export function applyWindSwayToMesh(
  mesh: Mesh,
  sways: TileWindSway[],
  timeSec: number,
): void {
  if (sways.length === 0) {
    return;
  }
  const geom = mesh.geometry as MeshGeometry;
  const pos = geom.positions;
  for (const s of sways) {
    const tArg = timeSec * WIND_SWAY_BASE_FREQ * s.freqMul;
    const wTop = windSin(tArg, s.phase, s.topWaveTier);
    const dxTop = Math.max(
      -s.maxPx,
      Math.min(s.maxPx, Math.round(wTop * s.maxPx * s.topWaveMul)),
    );
    const dxBottom =
      s.bottomWaveMul <= 0
        ? 0
        : Math.max(
            -s.maxPx,
            Math.min(
              s.maxPx,
              Math.round(
                windSin(tArg, s.phase, s.bottomWaveTier) *
                  s.maxPx *
                  s.bottomWaveMul,
              ),
            ),
          );
    // Interleaved float32: x,y per vertex; quad order TL, TR, BL, BR (see build loop above).
    const i = s.posIndex;
    pos[i] = s.xLeft + dxTop;
    pos[i + 2] = s.xRight + dxTop;
    pos[i + 4] = s.xLeft + dxBottom;
    pos[i + 6] = s.xRight + dxBottom;
  }
  const posAttr = geom.attributes.aPosition;
  if (posAttr !== undefined) {
    posAttr.buffer.update();
  }
}
