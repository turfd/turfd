/**
 * Per-chunk "bushy leaves" decoration mesh. Purely ADDITIVE — every leaf cell still draws
 * its full 16×16 base tile in {@link TileDrawBatch}, and this batch only layers extra
 * quads on top. We never carve into the cell interior; the only thing this batch changes
 * about the canopy silhouette is by extending it OUTWARD past air-facing edges.
 *
 * Pixel-scale contract (critical — avoids "mixels"):
 *   Every quad renders at strict 1:1 mapping between source atlas texels and world
 *   pixels. A clump of size `N` world-px is ALWAYS sampled from an `N × N` window inside
 *   the leaf atlas frame; we never stretch or squash the source art. Size variation
 *   comes from picking a different native size from the relevant palette, never from
 *   scaling a fixed window.
 *
 * Per leaf cell we emit:
 *
 *   1. **Stacked overlay** — one 16×16 quad at native scale, hashed integer offset
 *      `±LEAF_DECO_OVERLAY_OFFSET_MAX_PX` and independent X-flip. Identical UVs to the
 *      base tile → extra foliage depth + breaks obvious texture repeats.
 *   2. **Outward fringe** — for each cardinal side that is AIR, up to 2 clumps straddling
 *      the shared edge. Inner edge of each clump overlaps the leaf cell by
 *      `size - OUTWARD_BLEED_PX` (anchoring); outer edge bleeds `OUTWARD_BLEED_PX` into
 *      the air cell. This extends the canopy outline past the block boundary with
 *      hashed per-cell variation, producing the noisy rounded outer silhouette.
 *   3. **Exterior corner bumps** — when the diagonal neighbour is air AND at least one
 *      adjacent cardinal is also air, a single clump centred on the shared corner. Fills
 *      the concave corner of the silhouette.
 *   4. **Interior corner fills** — for each corner whose diagonal AND both adjacent
 *      cardinals are all leaves, a small fill clump centred on the shared corner to
 *      close the transparent-pixel X-gap formed where four leaf tiles meet.
 *
 * Everything is deterministic (hashed on world coords + block id + salt) so the look is
 * stable across chunk rebuilds, camera motion and re-generation.
 */
import { Mesh, MeshGeometry, type Texture } from "pixi.js";
import {
  BLOCK_SIZE,
  CHUNK_SIZE,
  LEAF_DECO_CLUMP_SIZES_PX,
  LEAF_DECO_CORNER_FILL_CHANCE,
  LEAF_DECO_OVERLAY_OFFSET_MAX_PX,
} from "../../core/constants";
import type { BlockRegistry } from "../../world/blocks/BlockRegistry";
import type { Chunk } from "../../world/chunk/Chunk";
import { chunkToWorldOrigin, localIndex } from "../../world/chunk/ChunkCoord";
import type { AtlasLoader } from "../AtlasLoader";
import type { BlockIdWorldSampler } from "./TileDrawBatch";

const AIR_ID = 0;

/**
 * How far (world px) an outward fringe clump bleeds past the cell edge into the air
 * neighbour. The clump's inner edge is `size - OUTWARD_BLEED_PX` inside the leaf cell,
 * so there's always enough overlap to anchor the clump visually — it never looks
 * disconnected from the canopy.
 */
const OUTWARD_BLEED_PX = 4;

/** Fringe clumps attempted per air-facing cardinal side. */
const FRINGE_CLUMPS_PER_SIDE = 3;
/** Extra smaller clumps per side for silhouette breakup (deco mesh only). */
const FRINGE_MICRO_CLUMPS_PER_SIDE = 2;

/** Per-clump hashed chance a fringe clump is actually emitted. */
const FRINGE_CLUMP_CHANCE = 0.96;
/** Lower spawn chance for extra micro clumps. */
const FRINGE_MICRO_CLUMP_CHANCE = 0.78;

/** Per-corner hashed chance an exterior corner bump is emitted. */
const CORNER_BUMP_CHANCE = 1.0;

/** Native size palette for outward fringe bumps (smaller than `LEAF_DECO_CLUMP_SIZES_PX`). */
const FRINGE_CLUMP_SIZES_PX: readonly number[] = [6, 8, 10];
/** Tiny fringe clumps that only exist on the additive deco mesh. */
const FRINGE_MICRO_CLUMP_SIZES_PX: readonly number[] = [4, 6];
/** Keep micro clumps away from the exact atlas edge to avoid boxy stamps. */
const MICRO_UV_EDGE_INSET_MIN_PX = 1;
/** Extra inward UV slack for micro clumps beyond `EDGE_UV_INSET_MAX_PX`. */
const MICRO_UV_EXTRA_INSET_PX = 2;

/** Native size palette for corner bumps. */
const CORNER_BUMP_SIZES_PX: readonly number[] = [6, 8, 10];

/**
 * Max texel inset from the exact atlas edge when sampling outward fringe/corner UVs.
 * Keeps clumps edge-oriented while restoring per-clump silhouette variation.
 */
const EDGE_UV_INSET_MAX_PX = 4;

/** Side clumps may slide slightly past tile corners (world px) to avoid boxy edges. */
const FRINGE_PARALLEL_OVERHANG_MAX_PX = 3;
/** Small per-slot parallel jitter (world px) on top of stratified placement. */
const FRINGE_SLOT_JITTER_PX = 2;
/** Extra push away from canopy along the outward axis (world px). */
const FRINGE_OUTWARD_JITTER_MAX_PX = 2;
/** Extra outward push for exterior-corner bumps (world px). */
const CORNER_OUTWARD_JITTER_MAX_PX = 1;
/** Signed contour jitter so stacked clumps do not share one line. */
const FRINGE_ANCHOR_JITTER_PX = 2;
/** Additional outward escape so edge clumps don't look block-clamped. */
const FRINGE_EDGE_ESCAPE_MAX_PX = 2;
/** Per-axis UV lane wobble to avoid identical mask contours. */
const FRINGE_UV_LANE_BIAS_MAX_PX = 2;
const TOTAL_FRINGE_CLUMPS_PER_SIDE =
  FRINGE_CLUMPS_PER_SIDE + FRINGE_MICRO_CLUMPS_PER_SIDE;

/**
 * Per-leaf-cell upper quad count for buffer sizing:
 *   1 overlay + 4 × FRINGE_CLUMPS_PER_SIDE fringe + 4 corner bumps + 4 corner fills.
 * Corner bumps and fills are mutually exclusive per corner (diag is either air or leaf),
 * so worst case is 4 corner quads total + fringe + overlay.
 */
const MAX_QUADS_PER_LEAF_CELL =
  1 + 4 * TOTAL_FRINGE_CLUMPS_PER_SIDE + 4;

/** Mixing constants reused across hash calls; mirrors TileDrawBatch's `shouldFlipTextureX` style. */
function hash32(wx: number, wy: number, blockId: number, salt: number): number {
  let h = wx * 374761393 + wy * 668265263 + blockId * 1103515245 + salt * 2654435761;
  h ^= h >>> 13;
  h = Math.imul(h, 1274126177);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Hashed `[0, 1)` float for (wx, wy, id, salt). Different `salt` values are independent. */
function hashUnit(wx: number, wy: number, blockId: number, salt: number): number {
  return hash32(wx, wy, blockId, salt) / 0x1_0000_0000;
}

/** Hashed boolean (50/50). */
function hashBool(wx: number, wy: number, blockId: number, salt: number): boolean {
  return (hash32(wx, wy, blockId, salt) & 1) !== 0;
}

/** Hashed pick from a readonly array — never allocates. */
function hashPick<T>(
  wx: number,
  wy: number,
  blockId: number,
  salt: number,
  arr: readonly T[],
): T {
  return arr[hash32(wx, wy, blockId, salt) % arr.length]!;
}

function clamp01(v: number): number {
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

function clampInt(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export type LeafDecorationBuildOptions = {
  /** Cross-chunk foreground sampler (matches {@link TileMeshBuildOptions.sampleBlockId}). */
  sampleBlockId: BlockIdWorldSampler;
};

type BuiltLeafDecorationGeometry = {
  geometry: MeshGeometry;
  /** Quads emitted; 0 means the chunk has no decorated leaves (caller can skip scene add). */
  quadCount: number;
};

function degenerateGeometry(): MeshGeometry {
  return new MeshGeometry({
    positions: new Float32Array([0, 0, 0, 0, 0, 0]),
    uvs: new Float32Array([0, 0, 0, 0, 0, 0]),
    indices: new Uint32Array([0, 1, 2]),
  });
}

type LeafFrame = {
  u0: number;
  v0: number;
  uSpan: number;
  vSpan: number;
};

/**
 * Builds a UV rect for a native-size N×N window starting at texel `(offX, offY)` inside
 * the leaf frame. Render size must equal `windowPx` for 1:1 pixel mapping.
 */
function windowUV(
  frame: LeafFrame,
  offX: number,
  offY: number,
  windowPx: number,
  flipX: boolean,
  flipY = false,
): { uLeft: number; uRight: number; vTop: number; vBottom: number } {
  const uStart = frame.u0 + (offX / BLOCK_SIZE) * frame.uSpan;
  const uEnd = frame.u0 + ((offX + windowPx) / BLOCK_SIZE) * frame.uSpan;
  const vStart = frame.v0 + (offY / BLOCK_SIZE) * frame.vSpan;
  const vEnd = frame.v0 + ((offY + windowPx) / BLOCK_SIZE) * frame.vSpan;
  return {
    uLeft: flipX ? uEnd : uStart,
    uRight: flipX ? uStart : uEnd,
    vTop: flipY ? vEnd : vStart,
    vBottom: flipY ? vStart : vEnd,
  };
}

function buildLeafDecorationGeometry(
  chunk: Chunk,
  registry: BlockRegistry,
  atlas: AtlasLoader,
  opts: LeafDecorationBuildOptions,
): BuiltLeafDecorationGeometry {
  const chunkOrigin = chunkToWorldOrigin(chunk.coord);
  const cells = chunk.blocks;

  let leafCellCount = 0;
  for (let ly = 0; ly < CHUNK_SIZE; ly++) {
    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      const id = cells[localIndex(lx, ly)]!;
      if (id === AIR_ID) continue;
      if (registry.getById(id).decorationLeaves === true) {
        leafCellCount += 1;
      }
    }
  }

  if (leafCellCount === 0) {
    return { geometry: degenerateGeometry(), quadCount: 0 };
  }

  const maxQuads = leafCellCount * MAX_QUADS_PER_LEAF_CELL;
  const positions = new Float32Array(maxQuads * 4 * 2);
  const uvs = new Float32Array(maxQuads * 4 * 2);
  const indices = new Uint32Array(maxQuads * 6);

  let pi = 0;
  let ii = 0;
  let vertBase = 0;
  let quadCount = 0;

  const pushQuad = (
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    uLeft: number,
    uRight: number,
    vTop: number,
    vBottom: number,
  ): void => {
    positions[pi] = x0;
    positions[pi + 1] = y0;
    uvs[pi] = uLeft;
    uvs[pi + 1] = vTop;
    pi += 2;
    positions[pi] = x1;
    positions[pi + 1] = y0;
    uvs[pi] = uRight;
    uvs[pi + 1] = vTop;
    pi += 2;
    positions[pi] = x0;
    positions[pi + 1] = y1;
    uvs[pi] = uLeft;
    uvs[pi + 1] = vBottom;
    pi += 2;
    positions[pi] = x1;
    positions[pi + 1] = y1;
    uvs[pi] = uRight;
    uvs[pi + 1] = vBottom;
    pi += 2;
    indices[ii] = vertBase;
    indices[ii + 1] = vertBase + 1;
    indices[ii + 2] = vertBase + 2;
    indices[ii + 3] = vertBase + 1;
    indices[ii + 4] = vertBase + 3;
    indices[ii + 5] = vertBase + 2;
    ii += 6;
    vertBase += 4;
    quadCount += 1;
  };

  /** Emits a 1:1 clump with explicit UV-window placement/orientation. */
  const emitAnchoredClump = (
    frame: LeafFrame,
    x0: number,
    y0: number,
    size: number,
    offX: number,
    offY: number,
    flipX: boolean,
    flipY: boolean,
  ): void => {
    const uv = windowUV(frame, offX, offY, size, flipX, flipY);
    pushQuad(x0, y0, x0 + size, y0 + size, uv.uLeft, uv.uRight, uv.vTop, uv.vBottom);
  };

  const overlayMax = LEAF_DECO_OVERLAY_OFFSET_MAX_PX;
  const overlaySpan = overlayMax * 2;

  for (let ly = 0; ly < CHUNK_SIZE; ly++) {
    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      const id = cells[localIndex(lx, ly)]!;
      if (id === AIR_ID) continue;
      const def = registry.getById(id);
      if (def.decorationLeaves !== true) continue;

      const worldX = chunkOrigin.wx + lx;
      const worldY = chunkOrigin.wy + ly;

      /** Cached cardinal + diagonal neighbour ids. */
      const nE = opts.sampleBlockId(worldX + 1, worldY);
      const nW = opts.sampleBlockId(worldX - 1, worldY);
      const nN = opts.sampleBlockId(worldX, worldY + 1);
      const nS = opts.sampleBlockId(worldX, worldY - 1);
      const nNE = opts.sampleBlockId(worldX + 1, worldY + 1);
      const nNW = opts.sampleBlockId(worldX - 1, worldY + 1);
      const nSE = opts.sampleBlockId(worldX + 1, worldY - 1);
      const nSW = opts.sampleBlockId(worldX - 1, worldY - 1);

      const isAir = (nid: number): boolean => nid === AIR_ID;
      const isDecoLeaf = (nid: number): boolean =>
        nid !== AIR_ID && registry.getById(nid).decorationLeaves === true;

      const variants = atlas.getTextureVariants(def.textureName);
      if (variants.length === 0) continue;
      const variantIndex =
        variants.length > 1
          ? hash32(worldX, worldY, id, 0x11) % variants.length
          : 0;
      const tex: Texture = variants[variantIndex]!;
      const fr = tex.frame;
      const sw = tex.source.width;
      const sh = tex.source.height;
      const u0 = fr.x / sw;
      const v0 = fr.y / sh;
      const u1 = (fr.x + fr.width) / sw;
      const v1 = (fr.y + fr.height) / sh;
      const frame: LeafFrame = {
        u0,
        v0,
        uSpan: u1 - u0,
        vSpan: v1 - v0,
      };

      /** Local mesh-space rect for this cell (same convention as TileDrawBatch). */
      const px = lx * BLOCK_SIZE;
      const py = -(ly + 1) * BLOCK_SIZE;
      const b = BLOCK_SIZE;

      // ---- Stacked 16×16 overlay (native scale) -----------------------------------------
      // Same 1:1 mapping as the base tile (full frame UVs, BLOCK_SIZE render rect). Only
      // the position is offset + the quad may be X-flipped. Bleeds up to overlayMax px
      // into adjacent cells, which softens the grid seams inside the canopy.
      const dx = Math.round(
        (hashUnit(worldX, worldY, id, 0x21) - 0.5) * overlaySpan,
      );
      const dy = Math.round(
        (hashUnit(worldX, worldY, id, 0x22) - 0.5) * overlaySpan,
      );
      const overlayFlip = hashBool(worldX, worldY, id, 0x23);
      pushQuad(
        px + dx,
        py + dy,
        px + dx + b,
        py + dy + b,
        overlayFlip ? u1 : u0,
        overlayFlip ? u0 : u1,
        v0,
        v1,
      );

      // ---- Outward fringe at air-facing cardinal sides ----------------------------------
      // Clumps straddle the shared edge: inner edge of the clump overlaps the leaf cell
      // by `size - OUTWARD_BLEED_PX` (anchoring), outer edge sits `OUTWARD_BLEED_PX`
      // beyond the cell into the air neighbour. Two clumps per side with independently
      // hashed position jitter along the edge spreads them apart without being too dense.
      //
      // Side index: 0 = +x world, 1 = -x world, 2 = +y world (mesh-up), 3 = -y world (mesh-down).
      for (let side = 0; side < 4; side++) {
        let neighbourId: number;
        if (side === 0) neighbourId = nE;
        else if (side === 1) neighbourId = nW;
        else if (side === 2) neighbourId = nN;
        else neighbourId = nS;
        if (!isAir(neighbourId)) continue;

        for (let k = 0; k < TOTAL_FRINGE_CLUMPS_PER_SIDE; k++) {
          const isMicro = k >= FRINGE_CLUMPS_PER_SIDE;
          const clumpSalt = side * 0x20 + k * 0x400;
          const chance = isMicro ? FRINGE_MICRO_CLUMP_CHANCE : FRINGE_CLUMP_CHANCE;
          if (
            hashUnit(worldX, worldY, id, 0x31 + clumpSalt) >= chance
          ) {
            continue;
          }

          const size = hashPick(
            worldX,
            worldY,
            id,
            0x41 + clumpSalt,
            isMicro ? FRINGE_MICRO_CLUMP_SIZES_PX : FRINGE_CLUMP_SIZES_PX,
          );

          /**
           * Position along the parallel axis. Range `[0, b - size]` so the clump stays
           * fully alongside its own cell on the parallel axis (doesn't stick out past
           * the cell's perpendicular corners — those get dedicated corner bumps).
           */
          const tMax = b - size;
          const tMinJitter = -FRINGE_PARALLEL_OVERHANG_MAX_PX;
          const tMaxJitter = tMax + FRINGE_PARALLEL_OVERHANG_MAX_PX;
          // Stratified side slots keep edge bleed smoother than fully-random t placement.
          const slot = (k + 0.5) / TOTAL_FRINGE_CLUMPS_PER_SIDE;
          const tBase = tMinJitter + slot * (tMaxJitter - tMinJitter);
          const tJitter =
            Math.round(
              (hashUnit(worldX, worldY, id, 0x51 + clumpSalt) - 0.5) *
                2 *
                FRINGE_SLOT_JITTER_PX,
            );
          const t = Math.round(tBase + tJitter);
          const outwardJitter =
            hash32(worldX, worldY, id, 0x59 + clumpSalt) %
            (FRINGE_OUTWARD_JITTER_MAX_PX + 1);
          const edgeEscape =
            hash32(worldX, worldY, id, 0x5d + clumpSalt) %
            (FRINGE_EDGE_ESCAPE_MAX_PX + 1);
          const anchorJitter =
            (hash32(worldX, worldY, id, 0x5b + clumpSalt) %
              (FRINGE_ANCHOR_JITTER_PX * 2 + 1)) -
            FRINGE_ANCHOR_JITTER_PX;
          // Taper side push near corners; corner bumps then read as a smooth radius.
          const centerWeight = 1 - Math.abs(slot * 2 - 1); // 0 at ends, 1 at side center
          const outwardScale = 0.72 + 0.28 * clamp01(centerWeight);
          const smoothOutward = Math.round((outwardJitter + edgeEscape) * outwardScale);
          // Micro clumps stay subtle to avoid sawtooth/jagged silhouettes.
          const microPush = isMicro && centerWeight > 0.35 ? 1 : 0;

          let clumpX0: number;
          let clumpY0: number;
          if (side === 0) {
            // +x edge at mesh-x = px + b. Inner edge at px + b - (size - BLEED).
            clumpX0 =
              px + b - (size - OUTWARD_BLEED_PX) + smoothOutward + microPush + anchorJitter;
            clumpY0 = py + t;
          } else if (side === 1) {
            // -x edge at mesh-x = px. Outer edge at px - BLEED.
            clumpX0 =
              px - OUTWARD_BLEED_PX - smoothOutward - microPush - anchorJitter;
            clumpY0 = py + t;
          } else if (side === 2) {
            // +y world (mesh-up). Edge at mesh-y = py (smaller). Outer edge at py - BLEED.
            clumpX0 = px + t;
            clumpY0 =
              py - OUTWARD_BLEED_PX - smoothOutward - microPush - anchorJitter;
          } else {
            // -y world (mesh-down). Edge at mesh-y = py + b. Inner edge at py + b - (size - BLEED).
            clumpX0 = px + t;
            clumpY0 =
              py + b - (size - OUTWARD_BLEED_PX) + smoothOutward + microPush + anchorJitter;
          }

          const uvRange = Math.max(0, b - size);
          const laneBiasMax = Math.min(FRINGE_UV_LANE_BIAS_MAX_PX, uvRange);
          const uvLaneBias =
            (hash32(worldX, worldY, id, 0x63 + clumpSalt) %
              (laneBiasMax * 2 + 1)) -
            laneBiasMax;
          const uvNormalBias =
            (hash32(worldX, worldY, id, 0x65 + clumpSalt) %
              (laneBiasMax * 2 + 1)) -
            laneBiasMax;
          const uvT = clampInt(
            Math.round(hashUnit(worldX, worldY, id, 0x61 + clumpSalt) * uvRange) +
              uvLaneBias,
            0,
            uvRange,
          );
          const insetMaxBase = Math.min(EDGE_UV_INSET_MAX_PX, uvRange);
          const insetMax = isMicro
            ? Math.min(uvRange, insetMaxBase + MICRO_UV_EXTRA_INSET_PX)
            : insetMaxBase;
          const insetMin = isMicro
            ? Math.min(MICRO_UV_EDGE_INSET_MIN_PX, insetMax)
            : 0;
          const insetRange = insetMax - insetMin;
          const inset =
            insetMin +
            (insetRange > 0
              ? hash32(worldX, worldY, id, 0x69 + clumpSalt) % (insetRange + 1)
              : 0);
          // Keep outward-facing alpha oriented correctly per side.
          let offX: number;
          let offY: number;
          if (side === 0) {
            offX = clampInt(b - size - inset + uvNormalBias, 0, uvRange);
            offY = uvT;
          } else if (side === 1) {
            offX = clampInt(inset + uvNormalBias, 0, uvRange);
            offY = uvT;
          } else if (side === 2) {
            offX = uvT;
            offY = clampInt(inset + uvNormalBias, 0, uvRange);
          } else {
            offX = uvT;
            offY = clampInt(b - size - inset + uvNormalBias, 0, uvRange);
          }
          const allowFlipX = isMicro ? true : side >= 2;
          const flipX = allowFlipX && hashBool(worldX, worldY, id, 0x71 + clumpSalt);
          const flipY = isMicro && hashBool(worldX, worldY, id, 0x79 + clumpSalt);
          emitAnchoredClump(frame, clumpX0, clumpY0, size, offX, offY, flipX, flipY);
        }
      }

      // ---- Exterior corner bumps + interior corner fills --------------------------------
      // Corner layout (mesh-space, py points "up" i.e. toward negative screen-Y):
      //   corner 0 = (+x, +y world)   corner 1 = (-x, +y world)
      //   corner 2 = (+x, -y world)   corner 3 = (-x, -y world)
      for (let corner = 0; corner < 4; corner++) {
        const dxDir = (corner & 1) === 0 ? +1 : -1;
        const dyDirWorld = (corner & 2) === 0 ? +1 : -1;
        const cardXId = dxDir > 0 ? nE : nW;
        const cardYId = dyDirWorld > 0 ? nN : nS;
        const diagId =
          corner === 0 ? nNE : corner === 1 ? nNW : corner === 2 ? nSE : nSW;

        /** Shared-corner mesh coordinates for this cell + its diagonal neighbour. */
        const cornerMeshX = dxDir > 0 ? px + b : px;
        const cornerMeshY = dyDirWorld > 0 ? py : py + b;

        if (isAir(diagId)) {
          // Exterior corner — bump only when at least one cardinal is also air. This
          // avoids random "floating" bumps wedged between two leaf cells that just happen
          // to have an air diagonal pocket.
          if (!isAir(cardXId) && !isAir(cardYId)) continue;
          if (
            hashUnit(worldX, worldY, id, 0x91 + corner) >= CORNER_BUMP_CHANCE
          ) {
            continue;
          }

          const size = hashPick(
            worldX,
            worldY,
            id,
            0xa1 + corner,
            CORNER_BUMP_SIZES_PX,
          );
          const half = size >> 1;
          /** Centre the bump exactly on the shared corner (half inside, half in air). */
          const outwardJitterX =
            hash32(worldX, worldY, id, 0xa9 + corner) %
            (CORNER_OUTWARD_JITTER_MAX_PX + 1);
          const outwardJitterY =
            hash32(worldX, worldY, id, 0xab + corner) %
            (CORNER_OUTWARD_JITTER_MAX_PX + 1);
          const cornerX0 = cornerMeshX - half + (dxDir > 0 ? outwardJitterX : -outwardJitterX);
          const cornerY0 =
            cornerMeshY -
            half +
            (dyDirWorld > 0 ? -outwardJitterY : outwardJitterY);
          const uvRange = Math.max(0, b - size);
          const insetMax = Math.min(EDGE_UV_INSET_MAX_PX, uvRange);
          const insetX = hash32(worldX, worldY, id, 0xb9 + corner) % (insetMax + 1);
          const insetY = hash32(worldX, worldY, id, 0xc9 + corner) % (insetMax + 1);
          const offX = dxDir > 0 ? b - size - insetX : insetX;
          const offY = dyDirWorld > 0 ? insetY : b - size - insetY;
          emitAnchoredClump(
            frame,
            cornerX0,
            cornerY0,
            size,
            offX,
            offY,
            false,
            false,
          );
        } else if (isDecoLeaf(diagId)) {
          // Interior corner — fill the transparent-pixel X-gap only when both adjacent
          // cardinals are also leaves (otherwise an air side already exists adjacent to
          // this corner and its fringe handles coverage).
          if (!isDecoLeaf(cardXId) || !isDecoLeaf(cardYId)) continue;
          if (
            hashUnit(worldX, worldY, id, 0xe1 + corner) >=
            LEAF_DECO_CORNER_FILL_CHANCE
          ) {
            continue;
          }

          const size = hashPick(
            worldX,
            worldY,
            id,
            0xf1 + corner,
            LEAF_DECO_CLUMP_SIZES_PX,
          );
          const half = size >> 1;
          const offCenter = Math.max(0, Math.floor((b - size) * 0.5));
          emitAnchoredClump(
            frame,
            cornerMeshX - half,
            cornerMeshY - half,
            size,
            offCenter,
            offCenter,
            hashBool(worldX, worldY, id, 0x101 + corner),
            false,
          );
        }
      }
    }
  }

  if (quadCount === 0) {
    return { geometry: degenerateGeometry(), quadCount: 0 };
  }

  const vCount = quadCount * 4;
  const iCount = quadCount * 6;
  const tightPositions = positions.slice(0, vCount * 2);
  const tightUvs = uvs.slice(0, vCount * 2);
  const tightIndices = indices.slice(0, iCount);

  const geometry = new MeshGeometry({
    positions: tightPositions,
    uvs: tightUvs,
    indices: tightIndices,
  });
  return { geometry, quadCount };
}

export function buildLeafDecorationMesh(
  chunk: Chunk,
  registry: BlockRegistry,
  atlas: AtlasLoader,
  opts: LeafDecorationBuildOptions,
): Mesh {
  const { geometry } = buildLeafDecorationGeometry(chunk, registry, atlas, opts);
  return new Mesh({
    geometry,
    texture: atlas.getAtlasTexture(),
    roundPixels: true,
  }) as unknown as Mesh;
}

export function updateLeafDecorationMesh(
  mesh: Mesh,
  chunk: Chunk,
  registry: BlockRegistry,
  atlas: AtlasLoader,
  opts: LeafDecorationBuildOptions,
): void {
  const { geometry } = buildLeafDecorationGeometry(chunk, registry, atlas, opts);
  mesh.geometry.destroy();
  mesh.geometry = geometry as unknown as typeof mesh.geometry;
}
