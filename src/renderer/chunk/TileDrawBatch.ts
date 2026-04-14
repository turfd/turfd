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
import { getStairShape } from "../../world/blocks/stairMetadata";
import type { Chunk } from "../../world/chunk/Chunk";
import { getBlock } from "../../world/chunk/Chunk";
import { chunkToWorldOrigin, localIndex } from "../../world/chunk/ChunkCoord";
import type { World } from "../../world/World";
import type { AtlasLoader } from "../AtlasLoader";
import { chestVisualRole } from "../../world/chest/chestVisual";
import { bedHeadPlusXFromMeta } from "../../world/bed/bedMetadata";
import { doorHingeRightFromMeta } from "../../world/door/doorMetadata";
import { DOOR_PANEL_WIDTH_PX } from "../../world/door/doorWorld";
import {
  PAINTING_VARIANTS,
  decodePaintingMeta,
  paintingAtlasKey,
} from "../../world/painting/paintingData";

const AIR_ID = 0;

/** World-space block id for mesh UVs (chest pairing across chunk edges). */
export type BlockIdWorldSampler = (wx: number, wy: number) => number;

export type TileMeshBuildOptions = {
  /** When set with {@link sampleBlockId}, paired chests use full `chest_double` per tile (east flipped). */
  chestBlockId: number | null;
  sampleBlockId: BlockIdWorldSampler;
  /** When set with {@link isFurnaceLit}, smelting furnaces use animated `furnace_on` strip frames. */
  furnaceBlockId?: number | null;
  isFurnaceLit?: (wx: number, wy: number) => boolean;
  /** When set, door tiles use open UVs / walk-through state from live player proximity + latch. */
  isDoorEffectivelyOpen?: (wx: number, wy: number) => boolean;
  /** When set, thin door strip is placed on the hinge side implied by walk (proximity) vs meta. */
  getDoorRenderHingeRight?: (wx: number, wy: number) => boolean;
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

/** Min |vx| (px/s) before a body adds extra horizontal bend to swaying foliage. */
const FOLIAGE_BODY_SWAY_VX_MIN = 22;
/** Horizontal reach (world px) for body influence; 1 at center, 0 at edge. */
const FOLIAGE_BODY_SWAY_REACH_X = BLOCK_SIZE * 1.5;
/** Vertical reach (world px, feet space) from the cell midline. */
const FOLIAGE_BODY_SWAY_REACH_Y = BLOCK_SIZE * 2.6;
/** Scales extra bend vs the tile’s wind `maxPx`. */
const FOLIAGE_BODY_SWAY_GAIN = 1.22;
/** Caps combined wind + body offset (multiples of maxPx). */
const FOLIAGE_BODY_SWAY_COMBINED_CAP = 3.1;

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
  /** World px: horizontal center of this swayed quad (feet space, for body proximity). */
  bodySwayWorldCenterX: number;
  /** World block row index (feet Y up) for vertical proximity. */
  bodySwayWorldBlockY: number;
};

/** Feet position + horizontal speed for extra foliage bend (render-time only). */
export type FoliageWindInfluence = {
  feetX: number;
  feetY: number;
  vx: number;
};

/** Lit furnace: ping-pong UV animation through `furnace_on_*` atlas frames (see {@link applyFurnaceFireToMesh}). */
export type TileFurnaceFire = {
  posIndex: number;
  /** Seconds offset so neighboring furnaces stay out of phase. */
  phase: number;
  frameCount: number;
  flipX: boolean;
};

export type TileWaterSurface = {
  posIndex: number;
  xLeft: number;
  xRight: number;
  yTop: number;
  yBottom: number;
  worldLeftX: number;
  worldRightX: number;
  worldCenterX: number;
  worldSurfaceY: number;
};

export type WaterRippleSample = {
  x: number;
  y: number;
  amplitude: number;
  bornTimeSec: number;
};

type BuiltTileGeometry = {
  geometry: MeshGeometry;
  /** Water quads only; rendered above entities (see {@link buildMesh} `waterMesh`). */
  waterOverlayGeometry: MeshGeometry;
  windSways: TileWindSway[];
  furnaceFires: TileFurnaceFire[];
  waterSurfaces: TileWaterSurface[];
};

/** Seconds per step along the ping-pong (slow “fade” through the strip). */
const FURNACE_ON_FRAME_SEC = 0.48;
const FURNACE_PHASE_SCALE = 2.35;

function pingPongFrameIndexFromFloat(t: number, n: number): number {
  if (n <= 1) {
    return 0;
  }
  const period = n * 2 - 2;
  let p = t % period;
  if (p < 0) {
    p += period;
  }
  if (p < n) {
    return Math.floor(p);
  }
  return n * 2 - 2 - Math.floor(p);
}

/** One or two quads per cell when a ground deadband splits wind geometry. */
function windForegroundQuadsForCell(def: BlockDefinition, ly: number): number {
  if (def.isStair === true) {
    return 2;
  }
  if (def.doorHalf !== "none" || def.bedHalf !== "none") {
    return 1;
  }
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
  /** When false, water stays in the main mesh (background layer; no entity overlap). */
  splitWaterOverlay = true,
): BuiltTileGeometry {
  const chunkOrigin = chunkToWorldOrigin(chunk.coord);
  const sampleWorldBlockId = (wx: number, wy: number): number => {
    if (opts !== undefined) {
      return opts.sampleBlockId(wx, wy);
    }
    const lx = wx - chunkOrigin.wx;
    const ly = wy - chunkOrigin.wy;
    if (lx < 0 || lx >= CHUNK_SIZE || ly < 0 || ly >= CHUNK_SIZE) {
      return AIR_ID;
    }
    return cells[localIndex(lx, ly)] ?? AIR_ID;
  };
  const isWaterBlockId = (blockId: number): boolean => {
    if (blockId === AIR_ID) {
      return false;
    }
    return registry.getById(blockId).identifier === "stratum:water";
  };
  const degenerate = (): MeshGeometry =>
    new MeshGeometry({
      positions: new Float32Array([0, 0, 0, 0, 0, 0]),
      uvs: new Float32Array([0, 0, 0, 0, 0, 0]),
      indices: new Uint32Array([0, 1, 2]),
    });

  let mainQuadCount = 0;
  let waterQuadCount = 0;
  for (let ly = 0; ly < CHUNK_SIZE; ly++) {
    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      const id = cells[localIndex(lx, ly)]!;
      if (id === AIR_ID) {
        continue;
      }
      const def = registry.getById(id);
      if (def.identifier === "stratum:water" && splitWaterOverlay) {
        waterQuadCount += 1;
      } else {
        mainQuadCount += windForegroundQuadsForCell(def, ly);
      }
    }
  }

  if (mainQuadCount === 0 && waterQuadCount === 0) {
    const g = degenerate();
    return {
      geometry: g,
      waterOverlayGeometry: degenerate(),
      windSways: [],
      furnaceFires: [],
      waterSurfaces: [],
    };
  }

  const vCount = mainQuadCount * 4;
  const iCount = mainQuadCount * 6;
  const positions =
    mainQuadCount > 0
      ? new Float32Array(vCount * 2)
      : new Float32Array([0, 0, 0, 0, 0, 0]);
  const uvs =
    mainQuadCount > 0
      ? new Float32Array(vCount * 2)
      : new Float32Array([0, 0, 0, 0, 0, 0]);
  const indices =
    mainQuadCount > 0
      ? new Uint32Array(iCount)
      : new Uint32Array([0, 1, 2]);

  const wvCount = waterQuadCount * 4;
  const wiCount = waterQuadCount * 6;
  const wPositions =
    waterQuadCount > 0
      ? new Float32Array(wvCount * 2)
      : new Float32Array([0, 0, 0, 0, 0, 0]);
  const wUvs =
    waterQuadCount > 0
      ? new Float32Array(wvCount * 2)
      : new Float32Array([0, 0, 0, 0, 0, 0]);
  const wIndices =
    waterQuadCount > 0
      ? new Uint32Array(wiCount)
      : new Uint32Array([0, 1, 2]);
  const windSways: TileWindSway[] = [];
  const furnaceFires: TileFurnaceFire[] = [];
  const waterSurfaces: TileWaterSurface[] = [];

  let pi = 0;
  let ii = 0;
  let vertBase = 0;
  let wpi = 0;
  let wii = 0;
  let wvertBase = 0;

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

      let useFurnaceAnim = false;
      if (
        def.identifier === "stratum:furnace" &&
        opts !== undefined &&
        opts.furnaceBlockId !== null &&
        opts.furnaceBlockId === id &&
        opts.isFurnaceLit !== undefined &&
        opts.isFurnaceLit(worldX, worldY)
      ) {
        try {
          const vOn = atlas.getTextureVariants("furnace_on");
          if (vOn.length > 0) {
            drawableTextureName = "furnace_on";
            useFurnaceAnim = true;
          }
        } catch {
          /* missing atlas entry; keep cold furnace */
        }
      }

      /** Same atlas variant for both cells (east cell borrows west world X for alts). */
      const variantWx = chestDoubleCell === "east" ? worldX - 1 : worldX;
      const variantWy = worldY;
      const variants = atlas.getTextureVariants(drawableTextureName);
      const tex = useFurnaceAnim
        ? variants[0]!
        : variants.length > 1
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
      } else if (def.bedHalf === "foot" || def.bedHalf === "head") {
        const meta = chunk.metadata[localIndex(lx, ly)]!;
        const headPlusX = bedHeadPlusXFromMeta(meta);
        const uMid = (u0 + u1) * 0.5;
        if (def.bedHalf === "foot") {
          leftU = headPlusX ? u0 : uMid;
          rightU = headPlusX ? uMid : u1;
        } else {
          leftU = headPlusX ? uMid : u0;
          rightU = headPlusX ? u1 : uMid;
        }
      } else {
        const flipX =
          def.randomFlipX === true && shouldFlipTextureX(worldX, worldY, id);
        leftU = flipX ? u1 : u0;
        rightU = flipX ? u0 : u1;
      }

      const px = lx * BLOCK_SIZE;
      const py = -(ly + 1) * BLOCK_SIZE;
      const b = BLOCK_SIZE;

      if (def.isStair === true) {
        const meta = chunk.metadata[localIndex(lx, ly)]!;
        const shape = getStairShape(meta);
        const uAt = (xOff: number) => leftU + (xOff / b) * (rightU - leftU);
        const vAt = (yOff: number) => v0 + (yOff / b) * (v1 - v0);
        const pushFace = (
          x0: number,
          y0: number,
          x1: number,
          y1: number,
        ): void => {
          const ua = uAt(x0 - px);
          const ub = uAt(x1 - px);
          const va = vAt(y0 - py);
          const vb = vAt(y1 - py);
          positions[pi] = x0;
          positions[pi + 1] = y0;
          uvs[pi] = ua;
          uvs[pi + 1] = va;
          pi += 2;
          positions[pi] = x1;
          positions[pi + 1] = y0;
          uvs[pi] = ub;
          uvs[pi + 1] = va;
          pi += 2;
          positions[pi] = x0;
          positions[pi + 1] = y1;
          uvs[pi] = ua;
          uvs[pi + 1] = vb;
          pi += 2;
          positions[pi] = x1;
          positions[pi + 1] = y1;
          uvs[pi] = ub;
          uvs[pi + 1] = vb;
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
        const h = b * 0.5;
        if (shape === 0) {
          pushFace(px, py + h, px + b, py + b);
          pushFace(px + h, py, px + b, py + h);
        } else if (shape === 1) {
          pushFace(px, py + h, px + b, py + b);
          pushFace(px, py, px + h, py + h);
        } else if (shape === 2) {
          pushFace(px, py, px + b, py + h);
          pushFace(px + h, py + h, px + b, py + b);
        } else {
          pushFace(px, py, px + b, py + h);
          pushFace(px, py + h, px + h, py + b);
        }
        continue;
      }

      if (def.isPainting === true) {
        const pmeta = chunk.metadata[localIndex(lx, ly)]!;
        const decoded = decodePaintingMeta(pmeta);
        const pv = PAINTING_VARIANTS[decoded.variantIndex]!;
        const pKey = paintingAtlasKey(decoded.variantIndex);
        const pVariants = atlas.getTextureVariants(pKey);
        if (pVariants.length > 0) {
          const pTex = pVariants[0]!;
          const pfr = pTex.frame;
          const pLeftU = (pfr.x + decoded.offsetX * pfr.width / pv.width) / sw;
          const pRightU = (pfr.x + (decoded.offsetX + 1) * pfr.width / pv.width) / sw;
          const pTopV = (pfr.y + (pv.height - 1 - decoded.offsetY) * pfr.height / pv.height) / sh;
          const pBotV = (pfr.y + (pv.height - decoded.offsetY) * pfr.height / pv.height) / sh;

          const ppx = lx * BLOCK_SIZE;
          const ppy = -(ly + 1) * BLOCK_SIZE;
          const pb = BLOCK_SIZE;

          positions[pi] = ppx;
          positions[pi + 1] = ppy;
          uvs[pi] = pLeftU;
          uvs[pi + 1] = pTopV;
          pi += 2;
          positions[pi] = ppx + pb;
          positions[pi + 1] = ppy;
          uvs[pi] = pRightU;
          uvs[pi + 1] = pTopV;
          pi += 2;
          positions[pi] = ppx;
          positions[pi + 1] = ppy + pb;
          uvs[pi] = pLeftU;
          uvs[pi + 1] = pBotV;
          pi += 2;
          positions[pi] = ppx + pb;
          positions[pi + 1] = ppy + pb;
          uvs[pi] = pRightU;
          uvs[pi + 1] = pBotV;
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
        continue;
      }

      if (def.doorHalf === "bottom" || def.doorHalf === "top") {
        const meta = chunk.metadata[localIndex(lx, ly)]!;
        const hingeRight =
          opts?.getDoorRenderHingeRight !== undefined
            ? opts.getDoorRenderHingeRight(worldX, worldY)
            : doorHingeRightFromMeta(meta);
        const open =
          opts?.isDoorEffectivelyOpen !== undefined &&
          opts.isDoorEffectivelyOpen(worldX, worldY);

        const vSpan = v1 - v0;
        const vMid = v0 + vSpan * 0.5;
        const vTopUv = def.doorHalf === "bottom" ? vMid : v0;
        const vBotUv = def.doorHalf === "bottom" ? v1 : vMid;

        const px = lx * BLOCK_SIZE;
        const py = -(ly + 1) * BLOCK_SIZE;

        let uLo: number;
        let uHi: number;
        let quadLeft: number;
        let panelW: number;
        if (open) {
          if (hingeRight) {
            uLo = rightU;
            uHi = leftU;
          } else {
            uLo = leftU;
            uHi = rightU;
          }
          quadLeft = px;
          panelW = BLOCK_SIZE;
        } else {
          const stripSourceW = Math.min(DOOR_PANEL_WIDTH_PX, fr.width);
          const srcXStrip = fr.x + fr.width - stripSourceW;
          uLo = srcXStrip / sw;
          uHi = (srcXStrip + stripSourceW) / sw;
          panelW = DOOR_PANEL_WIDTH_PX;
          quadLeft = hingeRight ? px + (BLOCK_SIZE - panelW) : px;
        }
        const yT = py;
        const yB = py + BLOCK_SIZE;

        positions[pi] = quadLeft;
        positions[pi + 1] = yT;
        uvs[pi] = uLo;
        uvs[pi + 1] = vTopUv;
        pi += 2;
        positions[pi] = quadLeft + panelW;
        positions[pi + 1] = yT;
        uvs[pi] = uHi;
        uvs[pi + 1] = vTopUv;
        pi += 2;
        positions[pi] = quadLeft;
        positions[pi + 1] = yB;
        uvs[pi] = uLo;
        uvs[pi + 1] = vBotUv;
        pi += 2;
        positions[pi] = quadLeft + panelW;
        positions[pi + 1] = yB;
        uvs[pi] = uHi;
        uvs[pi + 1] = vBotUv;
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
        continue;
      }

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

      const emitWaterQuad = (
        yT: number,
        yB: number,
        vT: number,
        vB: number,
      ): number => {
        const posStart = wpi;
        wPositions[wpi] = px;
        wPositions[wpi + 1] = yT;
        wUvs[wpi] = leftU;
        wUvs[wpi + 1] = vT;
        wpi += 2;

        wPositions[wpi] = px + b;
        wPositions[wpi + 1] = yT;
        wUvs[wpi] = rightU;
        wUvs[wpi + 1] = vT;
        wpi += 2;

        wPositions[wpi] = px;
        wPositions[wpi + 1] = yB;
        wUvs[wpi] = leftU;
        wUvs[wpi + 1] = vB;
        wpi += 2;

        wPositions[wpi] = px + b;
        wPositions[wpi + 1] = yB;
        wUvs[wpi] = rightU;
        wUvs[wpi + 1] = vB;
        wpi += 2;

        const b0 = wvertBase;
        wIndices[wii] = b0;
        wIndices[wii + 1] = b0 + 1;
        wIndices[wii + 2] = b0 + 2;
        wIndices[wii + 3] = b0 + 1;
        wIndices[wii + 4] = b0 + 3;
        wIndices[wii + 5] = b0 + 2;
        wii += 6;
        wvertBase += 4;
        return posStart;
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
          bodySwayWorldCenterX: chunkOrigin.wx * BLOCK_SIZE + px + b * 0.5,
          bodySwayWorldBlockY: worldY,
        });
      } else {
        if (def.identifier === "stratum:water" && splitWaterOverlay) {
          const quadPosStart = emitWaterQuad(yTop, yBottom, vUvTop, vUvBottom);
          const topNeighborId = sampleWorldBlockId(worldX, worldY + 1);
          const isTopSurface = !isWaterBlockId(topNeighborId);
          if (isTopSurface) {
            waterSurfaces.push({
              posIndex: quadPosStart,
              xLeft: px,
              xRight: px + b,
              yTop,
              yBottom,
              worldLeftX: worldX * BLOCK_SIZE,
              worldRightX: (worldX + 1) * BLOCK_SIZE,
              worldCenterX: chunkOrigin.wx * BLOCK_SIZE + px + b * 0.5,
              worldSurfaceY: (worldY + 1) * BLOCK_SIZE - foot,
            });
          }
          continue;
        }

        const quadPosStart = pi;
        emitQuad(yTop, yBottom, vUvTop, vUvBottom);

        if (def.identifier === "stratum:water") {
          const topNeighborId = sampleWorldBlockId(worldX, worldY + 1);
          const isTopSurface = !isWaterBlockId(topNeighborId);
          if (!isTopSurface) {
            continue;
          }
          waterSurfaces.push({
            posIndex: quadPosStart,
            xLeft: px,
            xRight: px + b,
            yTop,
            yBottom,
            worldLeftX: worldX * BLOCK_SIZE,
            worldRightX: (worldX + 1) * BLOCK_SIZE,
            worldCenterX: chunkOrigin.wx * BLOCK_SIZE + px + b * 0.5,
            worldSurfaceY: (worldY + 1) * BLOCK_SIZE - foot,
          });
        }

        if (useFurnaceAnim) {
          furnaceFires.push({
            posIndex: quadPosStart,
            phase: (windPhaseRad(worldX, worldY) / (Math.PI * 2)) * 3.7,
            frameCount: variants.length,
            flipX:
              def.randomFlipX === true &&
              shouldFlipTextureX(worldX, worldY, id),
          });
        }

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
            bodySwayWorldCenterX: chunkOrigin.wx * BLOCK_SIZE + px + b * 0.5,
            bodySwayWorldBlockY: worldY,
          });
        }
      }
    }
  }

  return {
    geometry: new MeshGeometry({ positions, uvs, indices }),
    waterOverlayGeometry: new MeshGeometry({
      positions: wPositions,
      uvs: wUvs,
      indices: wIndices,
    }),
    windSways,
    furnaceFires,
    waterSurfaces,
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
      const id = getBlock(chunk, lx, ly);
      // Chest is rendered as a non-full visual; excluding it avoids square contact-shadow artifacts.
      if (reg.getById(id).identifier === "stratum:chest") {
        return false;
      }
      return reg.isSolid(id);
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
 * One Mesh per chunk (shared gradient atlas per Pixi app). Drawn between bg and fg meshes.
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
  /** Water-only chunk layer; parent above {@link RenderPipeline.layerEntities} in gameplay. */
  waterMesh: Mesh;
  windSways: TileWindSway[];
  furnaceFires: TileFurnaceFire[];
  waterSurfaces: TileWaterSurface[];
};

export function buildMesh(
  chunk: Chunk,
  registry: BlockRegistry,
  atlas: AtlasLoader,
  opts?: TileMeshBuildOptions,
): ForegroundTileMeshBundle {
  const {
    geometry,
    waterOverlayGeometry,
    windSways,
    furnaceFires,
    waterSurfaces,
  } = buildGeometryFromCells(chunk, chunk.blocks, registry, atlas, opts);
  const tex = atlas.getAtlasTexture();
  return {
    mesh: new Mesh({
      geometry,
      texture: tex,
      roundPixels: true,
    }),
    waterMesh: new Mesh({
      geometry: waterOverlayGeometry,
      texture: tex,
      roundPixels: true,
    }),
    windSways,
    furnaceFires,
    waterSurfaces,
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
    undefined,
    false,
  );
  return new Mesh({
    geometry,
    texture: atlas.getAtlasTexture(),
    tint: BACKGROUND_MESH_TINT,
  });
}

export function updateMesh(
  mesh: Mesh,
  waterMesh: Mesh,
  chunk: Chunk,
  registry: BlockRegistry,
  atlas: AtlasLoader,
  opts?: TileMeshBuildOptions,
): {
  windSways: TileWindSway[];
  furnaceFires: TileFurnaceFire[];
  waterSurfaces: TileWaterSurface[];
} {
  const {
    geometry,
    waterOverlayGeometry,
    windSways,
    furnaceFires,
    waterSurfaces,
  } = buildGeometryFromCells(chunk, chunk.blocks, registry, atlas, opts);
  mesh.geometry.destroy();
  waterMesh.geometry.destroy();
  mesh.geometry = geometry;
  waterMesh.geometry = waterOverlayGeometry;
  return { windSways, furnaceFires, waterSurfaces };
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
    undefined,
    false,
  );
  mesh.geometry.destroy();
  mesh.geometry = geometry;
}

/**
 * Wind bend in **integer pixels**, crown slightly **ahead in phase** vs ground so tips lead;
 * tall-grass **seam** edges share the reference phase so the two cells stay aligned.
 */
function extraSwayFromBodies(
  s: TileWindSway,
  influences: readonly FoliageWindInfluence[] | undefined,
): number {
  if (influences === undefined || influences.length === 0) {
    return 0;
  }
  const cx = s.bodySwayWorldCenterX;
  const wy = s.bodySwayWorldBlockY;
  const cellMidYFeet = (wy + 0.5) * BLOCK_SIZE;
  let sum = 0;
  for (const inf of influences) {
    if (Math.abs(inf.vx) < FOLIAGE_BODY_SWAY_VX_MIN) {
      continue;
    }
    const dy = Math.abs(inf.feetY - cellMidYFeet);
    if (dy > FOLIAGE_BODY_SWAY_REACH_Y) {
      continue;
    }
    const dx = Math.abs(inf.feetX - cx);
    if (dx > FOLIAGE_BODY_SWAY_REACH_X) {
      continue;
    }
    const px = Math.max(0, 1 - dx / FOLIAGE_BODY_SWAY_REACH_X);
    const py = Math.max(0, 1 - dy / FOLIAGE_BODY_SWAY_REACH_Y);
    sum += Math.sign(inf.vx) * px * py * s.maxPx * FOLIAGE_BODY_SWAY_GAIN;
  }
  const cap = s.maxPx * (FOLIAGE_BODY_SWAY_COMBINED_CAP - 1);
  return Math.max(-cap, Math.min(cap, sum));
}

export function applyWindSwayToMesh(
  mesh: Mesh,
  sways: TileWindSway[],
  timeSec: number,
  influences?: readonly FoliageWindInfluence[],
): void {
  if (sways.length === 0) {
    return;
  }
  const geom = mesh.geometry as MeshGeometry;
  const pos = geom.positions;
  for (const s of sways) {
    const tArg = timeSec * WIND_SWAY_BASE_FREQ * s.freqMul;
    const wTop = windSin(tArg, s.phase, s.topWaveTier);
    const dxTopWind = Math.max(
      -s.maxPx,
      Math.min(s.maxPx, Math.round(wTop * s.maxPx * s.topWaveMul)),
    );
    const dxBottomWind =
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
    const extra = Math.round(extraSwayFromBodies(s, influences));
    const lim = Math.round(s.maxPx * FOLIAGE_BODY_SWAY_COMBINED_CAP);
    const dxTop = Math.max(-lim, Math.min(lim, dxTopWind + extra));
    const dxBottom = Math.max(-lim, Math.min(lim, dxBottomWind + extra));
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

/**
 * Ping-pong UV animation for lit furnaces (`furnace_on` strip). Call each frame after {@link applyWindSwayToMesh}.
 */
export function applyFurnaceFireToMesh(
  mesh: Mesh,
  atlas: AtlasLoader,
  fires: TileFurnaceFire[],
  timeSec: number,
): void {
  if (fires.length === 0) {
    return;
  }
  let variants: readonly Texture[];
  try {
    variants = atlas.getTextureVariants("furnace_on");
  } catch {
    return;
  }
  if (variants.length === 0) {
    return;
  }
  const geom = mesh.geometry as MeshGeometry;
  const uv = geom.uvs;
  const sw = variants[0]!.source.width;
  const sh = variants[0]!.source.height;
  for (const f of fires) {
    const n = Math.min(f.frameCount, variants.length);
    if (n < 1) {
      continue;
    }
    const tFrames = timeSec / FURNACE_ON_FRAME_SEC + f.phase * FURNACE_PHASE_SCALE;
    const fi = pingPongFrameIndexFromFloat(tFrames, n);
    const tex = variants[fi]!;
    const fr = tex.frame;
    const u0 = fr.x / sw;
    const v0 = fr.y / sh;
    const u1 = (fr.x + fr.width) / sw;
    const v1 = (fr.y + fr.height) / sh;
    const leftU = f.flipX ? u1 : u0;
    const rightU = f.flipX ? u0 : u1;
    const i = f.posIndex;
    uv[i] = leftU;
    uv[i + 1] = v0;
    uv[i + 2] = rightU;
    uv[i + 3] = v0;
    uv[i + 4] = leftU;
    uv[i + 5] = v1;
    uv[i + 6] = rightU;
    uv[i + 7] = v1;
  }
  const uvAttr = geom.attributes.aUV;
  if (uvAttr !== undefined) {
    uvAttr.buffer.update();
  }
}

const WATER_RIPPLE_RADIUS_PX = BLOCK_SIZE * 10;
const WATER_RIPPLE_WAVELENGTH_PX = BLOCK_SIZE * 3.8;
const WATER_RIPPLE_PROPAGATION_SPEED = 18;
const WATER_RIPPLE_RING_WIDTH_PX = BLOCK_SIZE * 0.95;
const WATER_RIPPLE_LIFETIME_SEC = 1.8;
const WATER_RIPPLE_EVENT_GAIN = 0.72;
const WATER_RIPPLE_TOP_GAIN = 1.45;
const WATER_RIPPLE_BOTTOM_GAIN = 0.2;
const WATER_SWELL_SPEED = 0.42;
const WATER_SWELL_SPATIAL_FREQ = 0.004;
const WATER_SWELL_AMPLITUDE = 0.14;

function clamp01(v: number): number {
  if (v <= 0) return 0;
  if (v >= 1) return 1;
  return v;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

export function applyWaterRipplesToMesh(
  mesh: Mesh,
  surfaces: readonly TileWaterSurface[],
  timeSec: number,
  samples: readonly WaterRippleSample[],
): void {
  if (surfaces.length === 0) {
    return;
  }
  const geom = mesh.geometry as MeshGeometry;
  const pos = geom.positions;
  const invRadius = 1 / WATER_RIPPLE_RADIUS_PX;
  const ringSigma2 = WATER_RIPPLE_RING_WIDTH_PX * WATER_RIPPLE_RING_WIDTH_PX;
  const maxDisp = 3.4;
  const sampleDispAtWorld = (worldX: number, worldY: number): number => {
    let disp =
      Math.sin(timeSec * WATER_SWELL_SPEED + worldX * WATER_SWELL_SPATIAL_FREQ) *
      WATER_SWELL_AMPLITUDE;
    for (const sample of samples) {
      const age = timeSec - sample.bornTimeSec;
      if (age < 0 || age > WATER_RIPPLE_LIFETIME_SEC) {
        continue;
      }
      const dx = worldX - sample.x;
      const dy = worldY - sample.y;
      const dist = Math.hypot(dx, dy);
      if (dist > WATER_RIPPLE_RADIUS_PX) {
        continue;
      }
      const radialEnv = 1 - dist * invRadius;
      const front = age * WATER_RIPPLE_PROPAGATION_SPEED;
      const ringDist = dist - front;
      const ringEnv = Math.exp(-(ringDist * ringDist) / (2 * ringSigma2));
      const carrier =
        Math.cos((ringDist / WATER_RIPPLE_WAVELENGTH_PX) * Math.PI * 2) * 0.5 +
        0.5;
      const lifeT = age / WATER_RIPPLE_LIFETIME_SEC;
      const attack = smoothstep(0, 0.12, age);
      const decay = 1 - smoothstep(0.45, 1, lifeT);
      disp +=
        ringEnv *
        carrier *
        radialEnv *
        attack *
        decay *
        sample.amplitude *
        WATER_RIPPLE_EVENT_GAIN;
    }
    return Math.max(-maxDisp, Math.min(maxDisp, disp));
  };
  for (const s of surfaces) {
    const topLeftRaw = sampleDispAtWorld(s.worldLeftX, s.worldSurfaceY);
    const topRightRaw = sampleDispAtWorld(s.worldRightX, s.worldSurfaceY);
    const topCenterRaw = sampleDispAtWorld(s.worldCenterX, s.worldSurfaceY);
    const topLeftDisp = topLeftRaw * 0.65 + topCenterRaw * 0.35;
    const topRightDisp = topRightRaw * 0.65 + topCenterRaw * 0.35;
    const bottomLeftDisp = topLeftDisp * WATER_RIPPLE_BOTTOM_GAIN;
    const bottomRightDisp = topRightDisp * WATER_RIPPLE_BOTTOM_GAIN;
    const i = s.posIndex;
    pos[i] = s.xLeft;
    pos[i + 1] = s.yTop + topLeftDisp * WATER_RIPPLE_TOP_GAIN;
    pos[i + 2] = s.xRight;
    pos[i + 3] = s.yTop + topRightDisp * WATER_RIPPLE_TOP_GAIN;
    pos[i + 4] = s.xLeft;
    pos[i + 5] = s.yBottom + bottomLeftDisp;
    pos[i + 6] = s.xRight;
    pos[i + 7] = s.yBottom + bottomRightDisp;
  }
  const posAttr = geom.attributes.aPosition;
  if (posAttr !== undefined) {
    posAttr.buffer.update();
  }
}
