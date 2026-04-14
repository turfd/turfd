import { Application, BlurFilter, Container } from "pixi.js";
import {
  BACKGROUND_PARALLAX_X,
  BACKGROUND_TILE_STRIP_BLUR,
  BACKGROUND_TILE_STRIP_BLUR_QUALITY,
  BACKGROUND_TILE_STRIP_CAMERA_EDGE_MARGIN_BLOCKS,
  BACKGROUND_TILE_STRIP_CY_END,
  BACKGROUND_TILE_STRIP_CY_START,
  BACKGROUND_TILE_STRIP_LIGHT_ATTENUATION,
  BACKGROUND_TILE_STRIP_NIGHT_PARALLAX_AMBIENT_BELOW,
  BACKGROUND_TILE_STRIP_NIGHT_PARALLAX_BRIGHTEN,
  BACKGROUND_TILE_STRIP_NIGHT_PARALLAX_MIN_SCALE,
  BACKGROUND_TILE_STRIP_NIGHT_PARALLAX_TINT_WHITEN,
  BACKGROUND_TILE_STRIP_ORIGIN_BLOCK_X,
  BACKGROUND_TILE_STRIP_VISUAL_SCALE,
  BACKGROUND_TILE_STRIP_WIDTH_SCALE,
  BLOCK_SIZE,
  CHUNK_SIZE,
} from "../core/constants";
import type { WorldLightingParams } from "../world/lighting/WorldTime";
import type { AtlasLoader } from "./AtlasLoader";
import { buildBackgroundMesh, buildMesh, type TileMeshBuildOptions } from "./chunk/TileDrawBatch";
import type { Chunk } from "../world/chunk/Chunk";
import { getBlock } from "../world/chunk/Chunk";
import {
  chunkKey,
  chunkToWorldOrigin,
  type ChunkCoord,
} from "../world/chunk/ChunkCoord";
import type { BlockRegistry } from "../world/blocks/BlockRegistry";
import { WorldGenerator } from "../world/gen/WorldGenerator";

export type ParallaxStripRegenerateOptions = {
  seed: number;
  registry: BlockRegistry;
  atlas: AtlasLoader;
  chestBlockId: number | null;
  /**
   * World X in **blocks** used to place the strip (centered on this column).
   * When omitted (main menu), the strip uses {@link BACKGROUND_TILE_STRIP_ORIGIN_BLOCK_X}.
   */
  anchorWorldBlockX?: number;
  /**
   * When `true` with `anchorWorldBlockX`, recenters chunk columns as the camera moves (can pop).
   * Gameplay uses `false`: one strip for the session, motion is only parallax scroll — no swaps.
   */
  slideWithCamera?: boolean;
  /** Overrides {@link BACKGROUND_TILE_STRIP_WIDTH_SCALE} for chunk column count. */
  stripWidthScale?: number;
};

/**
 * Distant parallax strip: real {@link WorldGenerator} chunks + same mesh path as gameplay
 * ({@link buildMesh} / {@link buildBackgroundMesh}), {@link BlurFilter}-softened and scaled.
 */
type AnchoredRegenOpts = {
  seed: number;
  registry: BlockRegistry;
  atlas: AtlasLoader;
  chestBlockId: number | null;
};

export class ParallaxTileStripRenderer {
  readonly displayRoot: Container;

  private readonly app: Application;
  private readonly getZoom: () => number;
  private readonly stripRoot: Container;
  private lastSeed: number | null = null;
  private stripLayout: {
    startCx: number;
    nChunkCols: number;
    alignBlocks: number;
    surfaceY: number;
  } | null = null;
  /** When true, {@link shouldRegenerateForCamera} / sliding window is active (see `slideWithCamera`). */
  private cameraAnchored = false;
  /** Inclusive chunk-aligned world block X range covered by generated chunk columns. */
  private stripCoverage: { startWx: number; endWx: number } | null = null;
  /** Chunk data for gameplay strips; updated incrementally when sliding (see {@link slideStripTowardCamera}). */
  private readonly parallaxChunkMap = new Map<string, Chunk>();
  private anchoredRegenOpts: AnchoredRegenOpts | null = null;

  constructor(app: Application, getZoom: () => number) {
    this.app = app;
    this.getZoom = getZoom;
    this.displayRoot = new Container({ label: "backgroundParallax" });
    this.stripRoot = new Container({ label: "backgroundTileStrip" });
    this.displayRoot.addChild(this.stripRoot);
  }

  regenerate(opts: ParallaxStripRegenerateOptions): void {
    const { seed, registry, atlas, chestBlockId } = opts;
    const renderer = this.app.renderer;
    const res = renderer.resolution;
    const screenW = renderer.width / res;

    const zoom = this.getZoom();
    const stripZoom = zoom * BACKGROUND_TILE_STRIP_VISUAL_SCALE;
    const viewportBlocksX = screenW / (BLOCK_SIZE * stripZoom);
    const widthScale = opts.stripWidthScale ?? BACKGROUND_TILE_STRIP_WIDTH_SCALE;
    const nChunkCols = Math.max(
      4,
      Math.ceil((viewportBlocksX * widthScale) / CHUNK_SIZE) + 2,
    );

    const useSlidingStrip =
      opts.anchorWorldBlockX !== undefined && opts.slideWithCamera === true;

    let originBx: number;
    if (opts.anchorWorldBlockX !== undefined) {
      this.cameraAnchored = useSlidingStrip;
      originBx = Math.floor(
        opts.anchorWorldBlockX - (nChunkCols * CHUNK_SIZE) / 2,
      );
      if (!useSlidingStrip) {
        this.stripCoverage = null;
      }
    } else {
      this.cameraAnchored = false;
      this.stripCoverage = null;
      originBx = BACKGROUND_TILE_STRIP_ORIGIN_BLOCK_X;
    }
    const startCx = Math.floor(originBx / CHUNK_SIZE);
    const alignBlocks = originBx - startCx * CHUNK_SIZE;

    const airId = registry.getByIdentifier("stratum:air").id;
    const generator = new WorldGenerator(seed, registry);

    let chunkMap: Map<string, Chunk>;
    if (useSlidingStrip) {
      this.anchoredRegenOpts = { seed, registry, atlas, chestBlockId };
      this.parallaxChunkMap.clear();
      chunkMap = this.parallaxChunkMap;
    } else {
      this.anchoredRegenOpts = null;
      this.parallaxChunkMap.clear();
      chunkMap = new Map<string, Chunk>();
    }

    for (let dcx = 0; dcx < nChunkCols; dcx++) {
      const cx = startCx + dcx;
      for (let cy = BACKGROUND_TILE_STRIP_CY_START; cy <= BACKGROUND_TILE_STRIP_CY_END; cy++) {
        const coord: ChunkCoord = { cx, cy };
        const chunk = generator.generateChunkTerrainOnly(coord);
        chunkMap.set(chunkKey(coord), chunk);
      }
    }
    generator.applySeaLevelFloodToChunkRegion(chunkMap, {
      minCx: startCx,
      maxCx: startCx + nChunkCols - 1,
      minCy: BACKGROUND_TILE_STRIP_CY_START,
      maxCy: BACKGROUND_TILE_STRIP_CY_END,
    });
    for (let dcx = 0; dcx < nChunkCols; dcx++) {
      const cx = startCx + dcx;
      for (let cy = BACKGROUND_TILE_STRIP_CY_START; cy <= BACKGROUND_TILE_STRIP_CY_END; cy++) {
        const coord: ChunkCoord = { cx, cy };
        const chunk = chunkMap.get(chunkKey(coord));
        if (chunk === undefined) {
          continue;
        }
        const o = chunkToWorldOrigin(coord);
        generator.decorateChunkSurface(chunk, o.wx, o.wy);
      }
    }

    const sampleBlockId = (wx: number, wy: number): number => {
      const cx = Math.floor(wx / CHUNK_SIZE);
      const cy = Math.floor(wy / CHUNK_SIZE);
      const ch = chunkMap.get(`${cx},${cy}`);
      if (ch === undefined) {
        return airId;
      }
      const lx = ((wx % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
      const ly = ((wy % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
      return getBlock(ch, lx, ly);
    };

    const meshOpts: TileMeshBuildOptions = {
      chestBlockId,
      sampleBlockId,
    };

    this.stripLayout = null;
    this.clearStripMeshes();

    for (let dcx = 0; dcx < nChunkCols; dcx++) {
      const cx = startCx + dcx;
      for (let cy = BACKGROUND_TILE_STRIP_CY_START; cy <= BACKGROUND_TILE_STRIP_CY_END; cy++) {
        const coord: ChunkCoord = { cx, cy };
        const chunk = chunkMap.get(chunkKey(coord));
        if (chunk === undefined) {
          continue;
        }
        const pos = chunkMeshPosition(coord);
        const k = chunkKey(coord);
        const bgMesh = buildBackgroundMesh(chunk, registry, atlas);
        bgMesh.label = `parallaxChunk:${k}:bg`;
        bgMesh.position.set(pos.x, pos.y);
        this.stripRoot.addChild(bgMesh);
        const { mesh: fgMesh, waterMesh: fgWaterMesh } = buildMesh(
          chunk,
          registry,
          atlas,
          meshOpts,
        );
        fgMesh.label = `parallaxChunk:${k}:fg`;
        fgMesh.position.set(pos.x, pos.y);
        this.stripRoot.addChild(fgMesh);
        fgWaterMesh.label = `parallaxChunk:${k}:fgWater`;
        fgWaterMesh.position.set(pos.x, pos.y);
        this.stripRoot.addChild(fgWaterMesh);
      }
    }

    const midWx = Math.floor(originBx + (nChunkCols * CHUNK_SIZE) / 2);
    const surfaceY = generator.getSurfaceHeight(midWx);

    this.stripLayout = { startCx, nChunkCols, alignBlocks, surfaceY };

    if (this.cameraAnchored) {
      this.stripCoverage = {
        startWx: startCx * CHUNK_SIZE,
        endWx: (startCx + nChunkCols) * CHUNK_SIZE,
      };
    }

    const blur = new BlurFilter({
      strength: BACKGROUND_TILE_STRIP_BLUR,
      quality: BACKGROUND_TILE_STRIP_BLUR_QUALITY,
    });
    this.stripRoot.filters = [blur];

    this.applyStripLayout();

    this.lastSeed = seed;
  }

  getLastSeed(): number | null {
    return this.lastSeed;
  }

  /**
   * True when the camera (world X in blocks) is near the horizontal edge of the generated strip.
   * Only used for gameplay strips built with {@link ParallaxStripRegenerateOptions.anchorWorldBlockX}.
   */
  shouldRegenerateForCamera(cameraWorldBlockX: number): boolean {
    if (!this.cameraAnchored || this.stripCoverage === null) {
      return false;
    }
    const marginBlocks = BACKGROUND_TILE_STRIP_CAMERA_EDGE_MARGIN_BLOCKS;
    const b = Math.floor(cameraWorldBlockX);
    const { startWx, endWx } = this.stripCoverage;
    return b < startWx + marginBlocks || b >= endWx - marginBlocks;
  }

  /**
   * When the camera nears the strip edge, shift the chunk window by one column at a time
   * instead of calling {@link regenerate}. New terrain only appears at the entering edge,
   * so the parallax stays continuous.
   * @param cameraBlockX — camera world X in **blocks** (same as {@link ParallaxStripRegenerateOptions.anchorWorldBlockX})
   */
  slideStripTowardCamera(cameraBlockX: number): void {
    if (
      !this.cameraAnchored ||
      this.stripLayout === null ||
      this.stripCoverage === null ||
      this.anchoredRegenOpts === null
    ) {
      return;
    }
    const b = Math.floor(cameraBlockX);
    let guard = 0;
    const maxSteps = 64;
    const edgeM = BACKGROUND_TILE_STRIP_CAMERA_EDGE_MARGIN_BLOCKS;
    while (this.shouldRegenerateForCamera(cameraBlockX) && guard < maxSteps) {
      guard++;
      const { startWx, endWx } = this.stripCoverage;
      if (b >= endWx - edgeM) {
        this.slideStripEastOneColumn(cameraBlockX);
      } else if (b < startWx + edgeM) {
        this.slideStripWestOneColumn(cameraBlockX);
      } else {
        break;
      }
    }
    this.applyStripLayout();
  }

  updateParallax(cameraWorldX: number, parallaxFactor: number = BACKGROUND_PARALLAX_X): void {
    this.displayRoot.x = Math.round(-cameraWorldX * parallaxFactor);
    this.applyStripLayout();
  }

  /** Match blurred backdrop to day/night (world ambient + tint). */
  applyWorldLighting(lighting: WorldLightingParams): void {
    const a = lighting.ambient;
    const att = BACKGROUND_TILE_STRIP_LIGHT_ATTENUATION;
    const thr = BACKGROUND_TILE_STRIP_NIGHT_PARALLAX_AMBIENT_BELOW;
    let scale = a * att;
    let tr = lighting.ambientTint[0];
    let tg = lighting.ambientTint[1];
    let tb = lighting.ambientTint[2];
    if (a < thr) {
      const night = 1 - a / thr;
      scale = Math.min(
        1,
        Math.max(
          BACKGROUND_TILE_STRIP_NIGHT_PARALLAX_MIN_SCALE,
          scale * BACKGROUND_TILE_STRIP_NIGHT_PARALLAX_BRIGHTEN,
        ),
      );
      const w = night * BACKGROUND_TILE_STRIP_NIGHT_PARALLAX_TINT_WHITEN;
      tr = tr + (1 - tr) * w;
      tg = tg + (1 - tg) * w;
      tb = tb + (1 - tb) * w;
    }
    const r = Math.min(255, Math.max(0, Math.round(255 * scale * tr)));
    const g = Math.min(255, Math.max(0, Math.round(255 * scale * tg)));
    const b = Math.min(255, Math.max(0, Math.round(255 * scale * tb)));
    this.displayRoot.tint = (r << 16) | (g << 8) | b;
  }

  dispose(): void {
    this.displayRoot.tint = 0xffffff;
    this.clearStripFilters();
    this.clearStripMeshes();
    this.stripLayout = null;
    this.stripCoverage = null;
    this.cameraAnchored = false;
    this.lastSeed = null;
    this.parallaxChunkMap.clear();
    this.anchoredRegenOpts = null;
  }

  private slideStripEastOneColumn(cameraBlockX: number): void {
    const layout = this.stripLayout;
    const opts = this.anchoredRegenOpts;
    if (layout === null || opts === null) {
      return;
    }
    const { startCx, nChunkCols } = layout;
    this.destroyParallaxColumn(startCx);
    const nextStart = startCx + 1;
    const maxCx = nextStart + nChunkCols - 1;
    const generator = new WorldGenerator(opts.seed, opts.registry);
    this.reseedAndBakeParallaxWindow(generator, nextStart, maxCx);
    for (let cx = nextStart; cx <= maxCx; cx++) {
      this.destroyParallaxColumnMeshesOnly(cx);
    }
    for (let cx = nextStart; cx <= maxCx; cx++) {
      this.appendParallaxColumnMeshes(cx, opts);
    }
    this.stripCoverage = {
      startWx: nextStart * CHUNK_SIZE,
      endWx: (nextStart + nChunkCols) * CHUNK_SIZE,
    };
    this.recomputeAnchoredStripLayoutFromCamera(cameraBlockX, nextStart, nChunkCols);
  }

  private slideStripWestOneColumn(cameraBlockX: number): void {
    const layout = this.stripLayout;
    const opts = this.anchoredRegenOpts;
    if (layout === null || opts === null) {
      return;
    }
    const { startCx, nChunkCols } = layout;
    this.destroyParallaxColumn(startCx + nChunkCols - 1);
    const nextStart = startCx - 1;
    const maxCx = nextStart + nChunkCols - 1;
    const generator = new WorldGenerator(opts.seed, opts.registry);
    this.reseedAndBakeParallaxWindow(generator, nextStart, maxCx);
    for (let cx = nextStart; cx <= maxCx; cx++) {
      this.destroyParallaxColumnMeshesOnly(cx);
    }
    for (let cx = nextStart; cx <= maxCx; cx++) {
      this.appendParallaxColumnMeshes(cx, opts);
    }
    this.stripCoverage = {
      startWx: nextStart * CHUNK_SIZE,
      endWx: (nextStart + nChunkCols) * CHUNK_SIZE,
    };
    this.recomputeAnchoredStripLayoutFromCamera(cameraBlockX, nextStart, nChunkCols);
  }

  /** Same terrain + water + decor pipeline as {@link regenerate} for all columns in range. */
  private reseedAndBakeParallaxWindow(
    generator: WorldGenerator,
    minCx: number,
    maxCx: number,
  ): void {
    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cy = BACKGROUND_TILE_STRIP_CY_START; cy <= BACKGROUND_TILE_STRIP_CY_END; cy++) {
        const coord: ChunkCoord = { cx, cy };
        this.parallaxChunkMap.set(
          chunkKey(coord),
          generator.generateChunkTerrainOnly(coord),
        );
      }
    }
    generator.applySeaLevelFloodToChunkRegion(this.parallaxChunkMap, {
      minCx,
      maxCx,
      minCy: BACKGROUND_TILE_STRIP_CY_START,
      maxCy: BACKGROUND_TILE_STRIP_CY_END,
    });
    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cy = BACKGROUND_TILE_STRIP_CY_START; cy <= BACKGROUND_TILE_STRIP_CY_END; cy++) {
        const coord: ChunkCoord = { cx, cy };
        const chunk = this.parallaxChunkMap.get(chunkKey(coord));
        if (chunk === undefined) {
          continue;
        }
        const o = chunkToWorldOrigin(coord);
        generator.decorateChunkSurface(chunk, o.wx, o.wy);
      }
    }
  }

  private destroyParallaxColumnMeshesOnly(cx: number): void {
    for (let cy = BACKGROUND_TILE_STRIP_CY_START; cy <= BACKGROUND_TILE_STRIP_CY_END; cy++) {
      const k = chunkKey({ cx, cy });
      for (const child of [...this.stripRoot.children]) {
        const lab = child.label;
        if (lab === `parallaxChunk:${k}:bg` || lab === `parallaxChunk:${k}:fg`) {
          child.destroy({ children: true });
        }
      }
    }
  }

  private destroyParallaxColumn(cx: number): void {
    for (let cy = BACKGROUND_TILE_STRIP_CY_START; cy <= BACKGROUND_TILE_STRIP_CY_END; cy++) {
      const k = chunkKey({ cx, cy });
      for (const child of [...this.stripRoot.children]) {
        const lab = child.label;
        if (lab === `parallaxChunk:${k}:bg` || lab === `parallaxChunk:${k}:fg`) {
          child.destroy({ children: true });
        }
      }
      this.parallaxChunkMap.delete(k);
    }
  }

  private appendParallaxColumnMeshes(cx: number, opts: AnchoredRegenOpts): void {
    const airId = opts.registry.getByIdentifier("stratum:air").id;
    const sampleBlockId = (wx: number, wy: number): number => {
      const icx = Math.floor(wx / CHUNK_SIZE);
      const icy = Math.floor(wy / CHUNK_SIZE);
      const ch = this.parallaxChunkMap.get(`${icx},${icy}`);
      if (ch === undefined) {
        return airId;
      }
      const lx = ((wx % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
      const ly = ((wy % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
      return getBlock(ch, lx, ly);
    };
    const meshOpts: TileMeshBuildOptions = {
      chestBlockId: opts.chestBlockId,
      sampleBlockId,
    };

    for (let cy = BACKGROUND_TILE_STRIP_CY_START; cy <= BACKGROUND_TILE_STRIP_CY_END; cy++) {
      const coord: ChunkCoord = { cx, cy };
      const chunk = this.parallaxChunkMap.get(chunkKey(coord));
      if (chunk === undefined) {
        continue;
      }
      const pos = chunkMeshPosition(coord);
      const k = chunkKey(coord);
      const bgMesh = buildBackgroundMesh(chunk, opts.registry, opts.atlas);
      bgMesh.label = `parallaxChunk:${k}:bg`;
      bgMesh.position.set(pos.x, pos.y);
      this.stripRoot.addChild(bgMesh);
      const { mesh: fgMesh, waterMesh: fgWaterMesh } = buildMesh(
        chunk,
        opts.registry,
        opts.atlas,
        meshOpts,
      );
      fgMesh.label = `parallaxChunk:${k}:fg`;
      fgMesh.position.set(pos.x, pos.y);
      this.stripRoot.addChild(fgMesh);
      fgWaterMesh.label = `parallaxChunk:${k}:fgWater`;
      fgWaterMesh.position.set(pos.x, pos.y);
      this.stripRoot.addChild(fgWaterMesh);
    }
  }

  private recomputeAnchoredStripLayoutFromCamera(
    cameraBlockX: number,
    startCx: number,
    nChunkCols: number,
  ): void {
    const opts = this.anchoredRegenOpts;
    if (opts === null) {
      return;
    }
    const camBx = cameraBlockX;
    const originBx = Math.floor(camBx - (nChunkCols * CHUNK_SIZE) / 2);
    const alignBlocks = originBx - startCx * CHUNK_SIZE;
    const generator = new WorldGenerator(opts.seed, opts.registry);
    const midWx = Math.floor(startCx * CHUNK_SIZE + (nChunkCols * CHUNK_SIZE) / 2);
    const surfaceY = generator.getSurfaceHeight(midWx);
    this.stripLayout = { startCx, nChunkCols, alignBlocks, surfaceY };
  }

  private applyStripLayout(): void {
    if (this.stripLayout === null) {
      return;
    }
    const renderer = this.app.renderer;
    const res = renderer.resolution;
    const screenW = renderer.width / res;
    const screenH = renderer.height / res;
    const zoom = this.getZoom();
    const stripZoom = zoom * BACKGROUND_TILE_STRIP_VISUAL_SCALE;
    const { startCx, nChunkCols, alignBlocks, surfaceY } = this.stripLayout;
    this.stripRoot.scale.set(stripZoom);
    const baseX =
      screenW / 2 -
      (startCx * CHUNK_SIZE + (nChunkCols * CHUNK_SIZE) / 2) * BLOCK_SIZE * stripZoom +
      alignBlocks * BLOCK_SIZE * stripZoom;
    const baseY = screenH * 0.55 + (surfaceY + 1) * BLOCK_SIZE * stripZoom;
    this.stripRoot.position.set(Math.round(baseX), Math.round(baseY));
  }

  private clearStripFilters(): void {
    const list = this.stripRoot.filters;
    if (list != null && list.length > 0) {
      for (const f of list) {
        f.destroy();
      }
    }
    this.stripRoot.filters = undefined;
  }

  private clearStripMeshes(): void {
    this.clearStripFilters();
    for (const child of [...this.stripRoot.children]) {
      child.destroy();
    }
    this.stripRoot.removeChildren();
  }
}

function chunkMeshPosition(coord: ChunkCoord): { x: number; y: number } {
  const origin = chunkToWorldOrigin(coord);
  return {
    x: origin.wx * BLOCK_SIZE,
    y: -origin.wy * BLOCK_SIZE,
  };
}
