/**
 * Standalone PixiJS world renderer for the main menu background.
 *
 * Layers (back to front):
 *  1. CSS canvas — sky gradient (+ sun)
 *  2. PixiJS — procedural cloud filter (under parallax), blurred parallax tile strip, lit terrain + composite
 *  3. DOM overlay (MainMenu)
 *
 * Zoom matches the game's adaptive formula (~20 blocks on the shorter viewport edge).
 * Lighting uses the full composite shader (OcclusionTexture + IndirectLightTexture).
 */
import { Application, Container, RenderTexture } from "pixi.js";
import {
  BACKGROUND_PARALLAX_X,
  BLOCK_SIZE,
  CHUNK_SIZE,
  MAX_VISIBLE_BLOCKS_ON_MIN_AXIS,
  SKY_LIGHT_MAX,
} from "../../core/constants";
import { unixRandom01 } from "../../core/unixRandom";
import { STRATUM_CORE_BEHAVIOR_PACK_PATH } from "../../mods/internalPackManifest";
import {
  fetchBehaviorPackManifest,
  loadBehaviorPackBlocks,
} from "../../mods/loadInternalBehaviorPack";
import { BLOCK_TEXTURE_MANIFEST_PATH } from "../../core/textureManifest";
import { AtlasLoader } from "../../renderer/AtlasLoader";
import { ParallaxTileStripRenderer } from "../../renderer/ParallaxTileStripRenderer";
import { OcclusionTexture } from "../../renderer/lighting/OcclusionTexture";
import { IndirectLightTexture } from "../../renderer/lighting/IndirectLightTexture";
import {
  CompositePass,
  emptyBloomMaskSource,
} from "../../renderer/lighting/CompositePass";
import {
  buildMesh,
  buildBackgroundMesh,
  buildFgShadowMesh,
  createWorldFgShadowSampler,
} from "../../renderer/chunk/TileDrawBatch";
import { buildLeafDecorationMesh } from "../../renderer/chunk/LeafDecorationBatch";
import { BlockRegistry } from "../../world/blocks/BlockRegistry";
import { WorldGenerator } from "../../world/gen/WorldGenerator";
import type { Chunk } from "../../world/chunk/Chunk";
import { chunkKey, chunkToWorldOrigin } from "../../world/chunk/ChunkCoord";
import type { World } from "../../world/World";
import type { WorldLightingParams } from "../../world/lighting/WorldTime";
import {
  MENU_SKY_BOTTOM,
  MENU_SKY_FALLBACK_GRADIENT,
  MENU_SKY_HORIZON,
  MENU_SKY_TOP,
  paintMenuSky,
  paintMenuSkyToFit,
} from "./menuSkyPaint";
import { SpriteCloudLayer } from "../../renderer/sky/SpriteCloudLayer";
import { TonemapFilter } from "../../renderer/lighting/TonemapFilter";
import { getVideoPrefs } from "../settings/videoPrefs";

// ---------------------------------------------------------------------------
// Layout / world constants
// ---------------------------------------------------------------------------

const CHUNKS_X    = 10;  // 320 blocks wide
const CY_START    = -3;  // underground
const CY_END      = 2;   // surface + canopy

/** World +X pan of the menu view (blocks). Safe while center ± {@link PAN_RANGE_X_BLOCKS} stays in [0, CHUNKS_X * CHUNK_SIZE). */
const MENU_VIEW_OFFSET_X_BLOCKS = 100;

/**
 * Adaptive zoom: same idea as {@link Camera.getEffectiveZoom} (floor from shorter edge; menu omits integer snap).
 * Keeps roughly `maxVisibleBlocksOnMinAxis` blocks along the **shorter** viewport side, but never below `minZoom`.
 */
const DEFAULT_MIN_ZOOM = 2;

function tonemapperModeFromPrefs(): 0 | 1 | 2 | 3 {
  const tm = getVideoPrefs().tonemapper;
  return tm === "aces" ? 1 : tm === "agx" ? 2 : tm === "reinhard" ? 3 : 0;
}

function computeZoom(
  screenW: number,
  screenH: number,
  maxVisibleBlocksOnMinAxis: number,
  minZoom: number,
): number {
  const minDim = Math.min(screenW, screenH);
  const rawZoom = Math.max(
    minZoom,
    minDim / (maxVisibleBlocksOnMinAxis * BLOCK_SIZE),
  );
  // Keep block size on an integer pixel grid for stable nearest-neighbor scrolling.
  const snappedPpb = Math.max(1, Math.round(rawZoom * BLOCK_SIZE));
  return snappedPpb / BLOCK_SIZE;
}

const PAN_SPEED_X       = 0.040;  // rad/s
const PAN_RANGE_X_BLOCKS = 16;    // ±blocks
const PAN_SPEED_Y       = 0.022;  // rad/s
const PAN_RANGE_Y_PX    = 24;     // ±screen-pixels (vertical bob)
const MENU_CLOUD_ATTACH_X = 0.035;
const MENU_CLOUD_ATTACH_Y = 0.028;

/** Intro: terrain + parallax start this far down-screen (fraction of viewport height) and ease up. */
const MENU_INTRO_SLIDE_MS = 920;
const MENU_INTRO_SLIDE_FRAC = 0.19;
/** Parallax travels slightly farther than foreground so both slide up with a hint of depth. */
const MENU_INTRO_PARALLAX_DEEPEN = 1.14;

function easeOutCubic(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return 1 - (1 - c) ** 3;
}

// ---------------------------------------------------------------------------
// Sky / background constants (mirror values from WorldTime.ts / RenderPipeline.ts)
// ---------------------------------------------------------------------------

/** Daytime lighting params passed to the composite shader. */
const DAYTIME_LIGHTING = {
  ambient:      1.0,
  ambientTint:  [1.0, 1.0, 1.0]       as [number, number, number],
  skyLightTint: [1.0, 0.98, 0.95]     as [number, number, number],
  sunIntensity: 0.82,
  sunTint:      [1.0, 0.98, 0.92]     as [number, number, number],
  moonIntensity: 0.0,
  moonTint:     [0.6, 0.7, 1.0]       as [number, number, number],
  heldTorch:    null,
  placedTorches: [] as [number, number, number?][],
  placedTorchCount: 0,
} as const;

const MENU_DAYTIME_WORLD_LIGHTING: WorldLightingParams = {
  sunDir: [0.45, 0.89],
  moonDir: [0, 0],
  sunIntensity: DAYTIME_LIGHTING.sunIntensity,
  moonIntensity: 0,
  ambient: DAYTIME_LIGHTING.ambient,
  ambientTint: [1, 1, 1],
  sunTint: [1, 0.98, 0.92],
  sky: {
    top: MENU_SKY_TOP,
    horizon: MENU_SKY_HORIZON,
    bottom: MENU_SKY_BOTTOM,
  },
  skyLightTint: [1, 0.98, 0.95],
};

// ---------------------------------------------------------------------------
// Minimal World adapter
// ---------------------------------------------------------------------------

class ChunkMap {
  private readonly map = new Map<string, Chunk>();

  constructor(
    private readonly registry: BlockRegistry,
    private readonly airId: number,
  ) {}

  add(chunk: Chunk): void {
    this.map.set(`${chunk.coord.cx},${chunk.coord.cy}`, chunk);
  }

  getChunk(cx: number, cy: number): Chunk | undefined {
    return this.map.get(`${cx},${cy}`);
  }

  getChunkAt(wx: number, wy: number): Chunk | undefined {
    const cx = Math.floor(wx / CHUNK_SIZE);
    const cy = Math.floor(wy / CHUNK_SIZE);
    return this.getChunk(cx, cy);
  }

  getRegistry(): BlockRegistry { return this.registry; }
  getAirBlockId(): number      { return this.airId; }

  getSkyLight(wx: number, wy: number): number {
    const cx = Math.floor(wx / CHUNK_SIZE);
    const cy = Math.floor(wy / CHUNK_SIZE);
    const chunk = this.map.get(`${cx},${cy}`);
    if (!chunk) return SKY_LIGHT_MAX;
    const lx = ((wx % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
    const ly = ((wy % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
    return chunk.skyLight[ly * CHUNK_SIZE + lx] ?? 0;
  }

  getBlock(wx: number, wy: number): number {
    const cx = Math.floor(wx / CHUNK_SIZE);
    const cy = Math.floor(wy / CHUNK_SIZE);
    const chunk = this.map.get(`${cx},${cy}`);
    if (!chunk) return this.airId;
    const lx = ((wx % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
    const ly = ((wy % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
    return chunk.blocks[ly * CHUNK_SIZE + lx] ?? this.airId;
  }

  getLightAbsorption(wx: number, wy: number): number {
    const id = this.getBlock(wx, wy);
    return this.registry.getById(id).lightAbsorption;
  }

  getBlockLight(_wx: number, _wy: number): number { return 0; }

  asWorld(): World { return this as unknown as World; }
}

// ---------------------------------------------------------------------------
// Sky-light propagation (BFS matching the real lighting engine)
// ---------------------------------------------------------------------------

function propagateSkyLight(chunkMap: ChunkMap, _registry: BlockRegistry): void {
  const wxMin = 0;
  const wyMin = CY_START * CHUNK_SIZE;
  const wxMax = CHUNKS_X * CHUNK_SIZE;
  const wyMax = (CY_END + 1) * CHUNK_SIZE;
  const width  = wxMax - wxMin;
  const height = wyMax - wyMin;

  const best = new Uint8Array(width * height);

  const maxQueue = width * height * 2;
  const qx = new Int32Array(maxQueue);
  const qy = new Int32Array(maxQueue);
  const ql = new Uint8Array(maxQueue);
  let head = 0;
  let tail = 0;

  const tryPush = (wx: number, wy: number, level: number): void => {
    const px = wx - wxMin;
    const py = wy - wyMin;
    if (px < 0 || px >= width || py < 0 || py >= height) return;
    if (tail >= maxQueue) return;
    const bi = py * width + px;
    if (best[bi]! >= level) return;
    best[bi] = level;
    qx[tail] = wx;
    qy[tail] = wy;
    ql[tail] = level;
    tail += 1;
  };

  for (let wx = wxMin; wx < wxMax; wx++) {
    for (let wy = wyMax - 1; wy >= wyMin; wy--) {
      if (chunkMap.getLightAbsorption(wx, wy) > 0) break;
      tryPush(wx, wy, SKY_LIGHT_MAX);
    }
  }

  while (head < tail) {
    const wx    = qx[head]!;
    const wy    = qy[head]!;
    const level = ql[head]!;
    head += 1;

    // Down: no decay (sky light pours straight down)
    {
      const ny = wy - 1;
      const abs = chunkMap.getLightAbsorption(wx, ny);
      const next = level - abs;
      if (next > 0) tryPush(wx, ny, Math.min(SKY_LIGHT_MAX, next));
    }
    // Up: decay by 1
    {
      const ny = wy + 1;
      const abs = chunkMap.getLightAbsorption(wx, ny);
      const next = level - 1 - abs;
      if (next > 0) tryPush(wx, ny, Math.min(SKY_LIGHT_MAX, next));
    }
    // Left: decay by 1
    {
      const nx = wx - 1;
      const abs = chunkMap.getLightAbsorption(nx, wy);
      const next = level - 1 - abs;
      if (next > 0) tryPush(nx, wy, Math.min(SKY_LIGHT_MAX, next));
    }
    // Right: decay by 1
    {
      const nx = wx + 1;
      const abs = chunkMap.getLightAbsorption(nx, wy);
      const next = level - 1 - abs;
      if (next > 0) tryPush(nx, wy, Math.min(SKY_LIGHT_MAX, next));
    }
  }

  for (let cx = 0; cx < CHUNKS_X; cx++) {
    for (let cy = CY_START; cy <= CY_END; cy++) {
      const chunk = chunkMap.getChunk(cx, cy);
      if (!chunk) continue;
      for (let ly = 0; ly < CHUNK_SIZE; ly++) {
        for (let lx = 0; lx < CHUNK_SIZE; lx++) {
          const wx = cx * CHUNK_SIZE + lx;
          const wy = cy * CHUNK_SIZE + ly;
          const px = wx - wxMin;
          const py = wy - wyMin;
          chunk.skyLight[ly * CHUNK_SIZE + lx] = best[py * width + px] ?? 0;
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// MenuBackground
// ---------------------------------------------------------------------------

export class MenuBackground {
  /** Fulfills when {@link init} finishes (success, early exit, or throw). */
  readonly initFinished: Promise<void>;
  private resolveInitFinished!: () => void;

  private app: Application | null = null;
  private rafId: number | null = null;
  private startTime = 0;
  private destroyed = false;
  private disableMotion = false;
  private disableIntroSlide = false;
  private deferHeavyInitMs = 0;

  constructor(
    opts: {
      maxVisibleBlocksX?: number;
      minZoom?: number;
      disableMotion?: boolean;
      disableIntroSlide?: boolean;
      deferHeavyInitMs?: number;
    } = {},
  ) {
    this.maxVisibleBlocksX =
      opts.maxVisibleBlocksX ?? MAX_VISIBLE_BLOCKS_ON_MIN_AXIS;
    this.minZoom = opts.minZoom ?? DEFAULT_MIN_ZOOM;
    this.disableMotion = opts.disableMotion ?? false;
    this.disableIntroSlide = opts.disableIntroSlide ?? false;
    this.deferHeavyInitMs = Math.max(0, Math.floor(opts.deferHeavyInitMs ?? 0));
    this.initFinished = new Promise<void>((resolve) => {
      this.resolveInitFinished = resolve;
    });
    this.zoom = this.getMinZoom();
  }

  // World rendering
  private worldContainer: Container | null = null;
  private albedoRT: RenderTexture | null = null;
  private occlusion: OcclusionTexture | null = null;
  private indirect: IndirectLightTexture | null = null;
  private composite: CompositePass | null = null;
  private chunkMap: ChunkMap | null = null;

  /** Wraps sky + Pixi canvases so loading-screen CSS can keep this visible behind the overlay. */
  private backdropRoot: HTMLDivElement | null = null;

  // Sky canvas
  private skyCanvas: HTMLCanvasElement | null = null;
  private skyCtx: CanvasRenderingContext2D | null = null;

  private parallaxStrip: ParallaxTileStripRenderer | null = null;
  private parallaxTonemap: TonemapFilter | null = null;
  private spriteCloud: SpriteCloudLayer | null = null;
  private atlasLoader: AtlasLoader | null = null;
  private menuSeed = 0;

  private baseX = 0;
  private baseY = 0;
  private panRangeXPx = 0;
  private zoom = DEFAULT_MIN_ZOOM;
  private maxVisibleBlocksX = MAX_VISIBLE_BLOCKS_ON_MIN_AXIS;
  private minZoom = DEFAULT_MIN_ZOOM;
  private userPanXPx = 0;
  private userPanYPx = 0;

  /** Surface block Y at menu mid-X; needed to recompute layout on window resize. */
  private surfaceYForLayout = 0;

  /** Physical backbuffer size; when it changes, albedo RT + zoom must update. */
  private lastRendererW = 0;
  private lastRendererH = 0;
  private lastRendererRes = 0;

  private lastCenterCX = -9999;
  private lastCenterCY = -9999;

  /** `performance.now()` when the intro slide-up begins (same epoch as {@link startTime}). */
  private slideRevealStartMs = 0;
  /** Pixels to slide at intro start; updated on resize. */
  private introSlideMaxPx = 0;

  /** Remove sky/backdrop and destroy Pixi when bailing out of {@link init} mid-flight. */
  private tearDownPartialInit(app: Application | null): void {
    if (app !== null) {
      app.destroy();
    }
    this.app = null;
    if (this.backdropRoot !== null) {
      this.backdropRoot.remove();
      this.backdropRoot = null;
    }
    this.skyCanvas = null;
    this.skyCtx = null;
  }

  async init(mount: HTMLElement): Promise<void> {
    try {
      await this.initImpl(mount);
    } finally {
      this.resolveInitFinished();
    }
  }

  private getMaxVisibleBlocksX(): number {
    return this.maxVisibleBlocksX;
  }

  private getMinZoom(): number {
    return this.minZoom;
  }

  setZoomConfig(next: { maxVisibleBlocksX?: number; minZoom?: number }): void {
    if (typeof next.maxVisibleBlocksX === "number" && Number.isFinite(next.maxVisibleBlocksX)) {
      this.maxVisibleBlocksX = Math.max(4, next.maxVisibleBlocksX);
    }
    if (typeof next.minZoom === "number" && Number.isFinite(next.minZoom)) {
      this.minZoom = Math.max(0.25, next.minZoom);
    }
    // Force a layout recompute next frame.
    this.lastRendererW = 0;
    this.lastRendererH = 0;
    this.lastRendererRes = 0;
    this.syncLayoutFromRenderer();
  }

  getZoomConfig(): { maxVisibleBlocksX: number; minZoom: number } {
    return { maxVisibleBlocksX: this.maxVisibleBlocksX, minZoom: this.minZoom };
  }

  panBy(dxPx: number, dyPx: number): void {
    if (!Number.isFinite(dxPx) || !Number.isFinite(dyPx)) {
      return;
    }
    this.userPanXPx += dxPx;
    this.userPanYPx += dyPx;
  }

  setPan(px: { x?: number; y?: number }): void {
    if (typeof px.x === "number" && Number.isFinite(px.x)) {
      this.userPanXPx = px.x;
    }
    if (typeof px.y === "number" && Number.isFinite(px.y)) {
      this.userPanYPx = px.y;
    }
  }

  getPan(): { x: number; y: number } {
    return { x: this.userPanXPx, y: this.userPanYPx };
  }

  private async initImpl(mount: HTMLElement): Promise<void> {
    performance.mark("menu-bg:init-start");
    const existingBackdrop = mount.querySelector(
      ":scope > .stratum-menu-backdrop",
    ) as HTMLDivElement | null;
    const existingCanvas = existingBackdrop?.querySelector(
      "canvas",
    ) as HTMLCanvasElement | null;

    let backdropRoot: HTMLDivElement;
    let skyCanvas: HTMLCanvasElement;

    if (existingBackdrop !== null && existingCanvas !== null) {
      backdropRoot = existingBackdrop;
      skyCanvas = existingCanvas;
    } else {
      backdropRoot = document.createElement("div");
      backdropRoot.className = "stratum-menu-backdrop";
      backdropRoot.style.cssText =
        "position:absolute;inset:0;z-index:0;pointer-events:none;overflow:hidden;" +
        `background:${MENU_SKY_FALLBACK_GRADIENT};`;
      if (mount.firstChild) {
        mount.insertBefore(backdropRoot, mount.firstChild);
      } else {
        mount.appendChild(backdropRoot);
      }

      skyCanvas = document.createElement("canvas");
      skyCanvas.style.cssText =
        "position:absolute;inset:0;width:100%;height:100%;z-index:0;pointer-events:none;";
      backdropRoot.appendChild(skyCanvas);
    }

    this.backdropRoot = backdropRoot;
    this.skyCanvas = skyCanvas;
    this.skyCtx = skyCanvas.getContext("2d");
    paintMenuSkyToFit(skyCanvas, mount);

    // -- PixiJS init --------------------------------------------------------
    const app = new Application();
    await app.init({
      autoStart: false,
      resizeTo: mount,
      antialias: false,
      preference: "webgl",
      backgroundAlpha: 0,  // transparent — sky canvas shows through air pixels
      resolution: window.devicePixelRatio >= 1 ? window.devicePixelRatio : 1,
      autoDensity: true,
    });

    if (this.destroyed) {
      this.tearDownPartialInit(app);
      return;
    }

    const pixiCanvas = app.canvas;
    pixiCanvas.style.cssText =
      "position:absolute;inset:0;width:100%;height:100%;" +
      "image-rendering:pixelated;z-index:1;pointer-events:none;";
    backdropRoot.appendChild(pixiCanvas);
    this.app = app;

    // -- Atlas + registry ---------------------------------------------------
    if (this.deferHeavyInitMs > 0) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, this.deferHeavyInitMs);
      });
    }
    performance.mark("menu-bg:heavy-start");
    const atlas = new AtlasLoader(BLOCK_TEXTURE_MANIFEST_PATH);
    const registry = new BlockRegistry();
    const base = import.meta.env.BASE_URL;
    const behBase = `${base}${STRATUM_CORE_BEHAVIOR_PACK_PATH}`;
    const [, behManifest] = await Promise.all([
      atlas.load(),
      fetchBehaviorPackManifest(behBase),
    ]);
    if (this.destroyed) {
      this.tearDownPartialInit(app);
      return;
    }

    this.atlasLoader = atlas;

    await loadBehaviorPackBlocks(registry, behBase, behManifest);
    if (this.destroyed) {
      this.tearDownPartialInit(app);
      return;
    }

    // -- World generation ---------------------------------------------------
    const seed       = Math.floor(unixRandom01() * 2_147_483_647);
    this.menuSeed = seed;
    const generator  = new WorldGenerator(seed, registry);
    const chunkMap   = new ChunkMap(
      registry,
      registry.getByIdentifier("stratum:air").id,
    );
    this.chunkMap = chunkMap;
    const fgShadowSampler = createWorldFgShadowSampler(chunkMap.asWorld());

    const dpr     = app.renderer.resolution;
    const screenW = app.renderer.width  / dpr;
    const screenH = app.renderer.height / dpr;
    const zoom    = computeZoom(
      screenW,
      screenH,
      this.getMaxVisibleBlocksX(),
      this.getMinZoom(),
    );
    this.zoom     = zoom;

    const worldContainer = new Container();
    worldContainer.scale.set(zoom);
    this.worldContainer = worldContainer;

    const chestBlockId = registry.isRegistered("stratum:chest")
      ? registry.getByIdentifier("stratum:chest").id
      : null;
    const parallaxStrip = new ParallaxTileStripRenderer(app, () => this.zoom);
    parallaxStrip.regenerate({
      seed,
      registry,
      atlas,
      chestBlockId,
    });
    const parallaxTonemap = new TonemapFilter();
    this.parallaxTonemap = parallaxTonemap;
    parallaxStrip.displayRoot.filters = [parallaxTonemap.filter];
    this.parallaxStrip = parallaxStrip;

    const menuGenMap = new Map<string, Chunk>();
    let buildWorkUnits = 0;
    const maybeYield = async (): Promise<void> => {
      buildWorkUnits += 1;
      if (buildWorkUnits % 3 !== 0) {
        return;
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
    };
    for (let cy = CY_START; cy <= CY_END; cy++) {
      for (let cx = 0; cx < CHUNKS_X; cx++) {
        const coord = { cx, cy };
        const chunk = generator.generateChunkTerrainOnly(coord);
        menuGenMap.set(chunkKey(coord), chunk);
      }
      await maybeYield();
    }
    generator.applySeaLevelFloodToChunkRegion(menuGenMap, {
      minCx: 0,
      maxCx: CHUNKS_X - 1,
      minCy: CY_START,
      maxCy: CY_END,
    });
    for (let cy = CY_START; cy <= CY_END; cy++) {
      for (let cx = 0; cx < CHUNKS_X; cx++) {
        const coord = { cx, cy };
        const chunk = menuGenMap.get(chunkKey(coord))!;
        const o = chunkToWorldOrigin(coord);
        generator.decorateChunkSurface(chunk, o.wx, o.wy);
        chunkMap.add(chunk);
      }
      await maybeYield();
    }

    propagateSkyLight(chunkMap, registry);
    await maybeYield();

    // -- Lighting pipeline --------------------------------------------------
    const albedoRT = RenderTexture.create({
      width: app.renderer.width,
      height: app.renderer.height,
      resolution: app.renderer.resolution,
      dynamic: true,
    });
    this.albedoRT = albedoRT;

    const occlusion = new OcclusionTexture();
    const indirect  = new IndirectLightTexture();
    const composite = new CompositePass(
      albedoRT,
      occlusion,
      indirect,
      emptyBloomMaskSource(),
    );
    composite.resize(screenW, screenH);
    this.occlusion = occlusion;
    this.indirect  = indirect;
    this.composite = composite;

    const spriteCloud = new SpriteCloudLayer();
    await spriteCloud.init();
    spriteCloud.resize(screenW, screenH);
    spriteCloud.applyWorldLighting(MENU_DAYTIME_WORLD_LIGHTING);
    this.spriteCloud = spriteCloud;
    parallaxStrip.applyWorldLighting(MENU_DAYTIME_WORLD_LIGHTING);

    app.stage.addChild(spriteCloud.displayRoot);
    app.stage.addChild(parallaxStrip.displayRoot);
    app.stage.addChild(worldContainer);
    app.stage.addChild(composite.displayObject);

    // -- Camera baseline (surface at 55% down screen) -----------------------
    const stripWBlocks = CHUNKS_X * CHUNK_SIZE;
    const midWX = Math.max(
      0,
      Math.min(
        stripWBlocks - 1,
        Math.floor(stripWBlocks / 2) + MENU_VIEW_OFFSET_X_BLOCKS,
      ),
    );
    const surfaceY = generator.getSurfaceHeight(midWX);
    this.surfaceYForLayout = surfaceY;

    this.baseX =
      screenW / 2 -
      (CHUNKS_X * CHUNK_SIZE * BLOCK_SIZE * zoom) / 2 -
      MENU_VIEW_OFFSET_X_BLOCKS * BLOCK_SIZE * zoom;
    this.baseY = screenH * 0.55 + (surfaceY + 1) * BLOCK_SIZE * zoom;
    this.panRangeXPx = PAN_RANGE_X_BLOCKS * BLOCK_SIZE * zoom;

    this.introSlideMaxPx = screenH * MENU_INTRO_SLIDE_FRAC;
    void MENU_INTRO_PARALLAX_DEEPEN;

    worldContainer.position.set(this.baseX, this.baseY);

    this.lastRendererW = app.renderer.width;
    this.lastRendererH = app.renderer.height;
    this.lastRendererRes = app.renderer.resolution;

    const revealStart = performance.now();
    this.slideRevealStartMs = revealStart;
    this.startTime = revealStart;

    if (this.rafId === null) {
      this.rafId = requestAnimationFrame((t) => this.animate(t));
    }

    for (let cy = CY_START; cy <= CY_END; cy++) {
      for (let cx = 0; cx < CHUNKS_X; cx++) {
        if (this.destroyed) {
          return;
        }
        const coord = { cx, cy };
        const chunk = menuGenMap.get(chunkKey(coord))!;
        const pos = {
          x: cx * CHUNK_SIZE * BLOCK_SIZE,
          y: -cy * CHUNK_SIZE * BLOCK_SIZE,
        };
        const bgMesh = buildBackgroundMesh(chunk, registry, atlas);
        bgMesh.position.set(pos.x, pos.y);
        worldContainer.addChild(bgMesh);
        const fgShadowMesh = buildFgShadowMesh(chunk, fgShadowSampler);
        fgShadowMesh.position.set(pos.x, pos.y);
        worldContainer.addChild(fgShadowMesh);
        const { mesh, waterMesh } = buildMesh(chunk, registry, atlas);
        mesh.position.set(pos.x, pos.y);
        worldContainer.addChild(mesh);
        const leafDeco = buildLeafDecorationMesh(chunk, registry, atlas, {
          sampleBlockId: (wx: number, wy: number) => chunkMap.getBlock(wx, wy),
        });
        leafDeco.position.set(pos.x, pos.y);
        worldContainer.addChild(leafDeco);
        waterMesh.position.set(pos.x, pos.y);
        worldContainer.addChild(waterMesh);
      }
      await maybeYield();
    }
    performance.mark("menu-bg:heavy-finished");
    performance.measure("menu-bg-heavy-init", "menu-bg:heavy-start", "menu-bg:heavy-finished");
    performance.mark("menu-bg:init-end");
    performance.measure("menu-bg-total-init", "menu-bg:init-start", "menu-bg:init-end");
  }

  /**
   * Pixi `resizeTo: mount` updates the canvas, but our offscreen albedo target and
   * adaptive zoom stay stale unless we sync (same idea as RenderPipeline#syncSizeFromRenderer).
   */
  private syncLayoutFromRenderer(): void {
    const app = this.app;
    const worldContainer = this.worldContainer;
    const albedoRT = this.albedoRT;
    const composite = this.composite;
    if (!app || !worldContainer || !albedoRT || !composite) return;

    const rw = app.renderer.width;
    const rh = app.renderer.height;
    const rRes = app.renderer.resolution;
    if (
      rw === this.lastRendererW &&
      rh === this.lastRendererH &&
      rRes === this.lastRendererRes
    ) {
      return;
    }

    this.lastRendererW = rw;
    this.lastRendererH = rh;
    this.lastRendererRes = rRes;

    const rwR = Math.max(1, Math.round(rw));
    const rhR = Math.max(1, Math.round(rh));
    albedoRT.resize(rwR, rhR, rRes);

    const dpr     = app.renderer.resolution;
    const screenW = rw / dpr;
    const screenH = rh / dpr;
    composite.resize(screenW, screenH);
    this.spriteCloud?.resize(screenW, screenH);

    const zoom = computeZoom(
      screenW,
      screenH,
      this.getMaxVisibleBlocksX(),
      this.getMinZoom(),
    );
    this.zoom = zoom;
    worldContainer.scale.set(zoom);

    if (this.parallaxStrip !== null && this.atlasLoader !== null && this.chunkMap !== null) {
      const reg = this.chunkMap.getRegistry();
      const cid = reg.isRegistered("stratum:chest")
        ? reg.getByIdentifier("stratum:chest").id
        : null;
      this.parallaxStrip.regenerate({
        seed: this.menuSeed,
        registry: reg,
        atlas: this.atlasLoader,
        chestBlockId: cid,
      });
    }

    this.baseX =
      screenW / 2 -
      (CHUNKS_X * CHUNK_SIZE * BLOCK_SIZE * zoom) / 2 -
      MENU_VIEW_OFFSET_X_BLOCKS * BLOCK_SIZE * zoom;
    this.baseY =
      screenH * 0.55 +
      (this.surfaceYForLayout + 1) * BLOCK_SIZE * zoom;
    this.panRangeXPx = PAN_RANGE_X_BLOCKS * BLOCK_SIZE * zoom;

    this.introSlideMaxPx = screenH * MENU_INTRO_SLIDE_FRAC;
    void MENU_INTRO_PARALLAX_DEEPEN;

    this.lastCenterCX = -9999;
    this.lastCenterCY = -9999;
  }

  // ---------------------------------------------------------------------------
  // Sky canvas rendering
  // ---------------------------------------------------------------------------

  /**
   * Draw sky once as soon as the canvas exists (before atlas / WebGL init).
   * Avoids a long white flash on slow networks where `animate` starts late.
   */
  private paintSky(worldContainerX: number, worldContainerY: number): void {
    void worldContainerX;
    void worldContainerY;
    const cvs = this.skyCanvas;
    const ctx = this.skyCtx;
    if (!cvs || !ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const cw = Math.max(1, Math.round(cvs.clientWidth * dpr));
    const ch = Math.max(1, Math.round(cvs.clientHeight * dpr));
    if (cvs.width !== cw || cvs.height !== ch) {
      cvs.width = cw;
      cvs.height = ch;
    }

    paintMenuSky(ctx, cw, ch, dpr);
  }

  // ---------------------------------------------------------------------------
  // Animate loop
  // ---------------------------------------------------------------------------

  private animate(now: number): void {
    if (this.destroyed || !this.app || !this.worldContainer) return;

    this.syncLayoutFromRenderer();
    this.spriteCloud?.updateTime(now);

    const app            = this.app;
    const worldContainer = this.worldContainer;
    const occlusion      = this.occlusion;
    const indirect       = this.indirect;
    const composite      = this.composite;
    const chunkMap       = this.chunkMap;

    // -- Camera pan + intro slide-up --------------------------------------
    const t = this.disableMotion ? 0 : (now - this.startTime) / 1000;
    const introDy = (this.disableMotion || this.disableIntroSlide)
      ? 0
      : (() => {
        const introT = Math.min(
          1,
          (now - this.slideRevealStartMs) / MENU_INTRO_SLIDE_MS,
        );
        const eased = easeOutCubic(introT);
        return (1 - eased) * this.introSlideMaxPx;
      })();
    const parallaxDy = (this.disableMotion || this.disableIntroSlide)
      ? 0
      : (introDy * MENU_INTRO_PARALLAX_DEEPEN);

    const worldX =
      this.baseX +
      this.userPanXPx +
      (this.disableMotion ? 0 : Math.sin(t * PAN_SPEED_X) * this.panRangeXPx);
    const worldY =
      this.baseY +
      this.userPanYPx +
      (this.disableMotion ? 0 : Math.sin(t * PAN_SPEED_Y) * PAN_RANGE_Y_PX) +
      introDy;
    worldContainer.x = Math.round(worldX);
    worldContainer.y = Math.round(worldY);
    if (this.spriteCloud !== null) {
      const cloudDx = worldContainer.x - this.baseX;
      const cloudDy = worldContainer.y - this.baseY;
      this.spriteCloud.displayRoot.position.set(
        Math.round(cloudDx * MENU_CLOUD_ATTACH_X),
        Math.round(cloudDy * MENU_CLOUD_ATTACH_Y),
      );
    }

    // -- Sky (CSS canvas) ---------------------------------------------------
    this.paintSky(worldContainer.x, worldContainer.y);

    const dpr = app.renderer.resolution;
    const sw = app.renderer.width / dpr;
    const sh = app.renderer.height / dpr;
    const localCX = (sw / 2 - worldContainer.x) / this.zoom;
    const strip = this.parallaxStrip;
    if (strip !== null) {
      strip.updateParallax(localCX, BACKGROUND_PARALLAX_X);
      strip.displayRoot.y = Math.round(parallaxDy);
    }

    // -- Lighting uniforms --------------------------------------------------
    if (occlusion && indirect && composite && chunkMap) {
      const tm = tonemapperModeFromPrefs();
      this.parallaxTonemap?.setTonemapper(tm);
      const localCY = (sh / 2 - worldContainer.y) / this.zoom;
      const centerChunkX = Math.floor(localCX / (BLOCK_SIZE * CHUNK_SIZE));
      const centerChunkY = Math.floor(-localCY / (BLOCK_SIZE * CHUNK_SIZE));

      if (centerChunkX !== this.lastCenterCX || centerChunkY !== this.lastCenterCY) {
        if (occlusion.rebuild(centerChunkX, centerChunkY, chunkMap.asWorld())) {
          occlusion.upload();
        }
        if (indirect.rebuild(centerChunkX, centerChunkY, chunkMap.asWorld())) {
          indirect.upload();
        }
        this.lastCenterCX = centerChunkX;
        this.lastCenterCY = centerChunkY;
      }

      const tlX        = (0 - worldContainer.x) / this.zoom;
      const tlY        = (0 - worldContainer.y) / this.zoom;
      composite.updateUniforms({
        ...DAYTIME_LIGHTING,
        cameraWorld:     [tlX / BLOCK_SIZE, -tlY / BLOCK_SIZE],
        blockPixels:     BLOCK_SIZE * this.zoom,
        occlusionOrigin: [occlusion.originX, occlusion.originY],
        occlusionSize:   OcclusionTexture.REGION_BLOCKS,
        tonemapper:      tm,
        bloomEnabled:    true,
        bloomMaskActive: false,
        playerBloomUvBoundsActive: false,
        playerBloomUvMin: [0, 0],
        playerBloomUvMax: [0, 0],
        uvBaseOffset:    [0, 0],
        uvScale:         [1, 1],
        uvSubpixelOffset:[0, 0],
      });
    }

    // -- Two-pass render ----------------------------------------------------
    if (this.albedoRT && composite) {
      // Opaque clear would leave alpha=1 everywhere; composite would hide the parallax strip.
      app.renderer.render({
        container: worldContainer,
        target: this.albedoRT,
        clear: true,
        clearColor: "rgba(0,0,0,0)",
      });
      worldContainer.visible = false;
      app.render();
      worldContainer.visible = true;
    } else {
      app.render();
    }

    this.rafId = requestAnimationFrame((t) => this.animate(t));
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * True when Pixi init finished successfully and {@link destroy} has not run.
   * Lets the app keep the same animated backdrop when transitioning to the world loading overlay.
   */
  isLive(): boolean {
    return !this.destroyed && this.app !== null;
  }

  destroy(): void {
    this.destroyed = true;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.occlusion?.destroy();
    this.indirect?.destroy();
    this.composite?.destroy();
    this.albedoRT?.destroy(true);
    this.occlusion     = null;
    this.indirect      = null;
    this.composite     = null;
    this.albedoRT      = null;
    this.worldContainer = null;
    this.chunkMap      = null;
    this.parallaxStrip?.dispose();
    this.parallaxStrip = null;
    this.parallaxTonemap?.destroy();
    this.parallaxTonemap = null;
    this.spriteCloud?.destroy();
    this.spriteCloud = null;
    this.atlasLoader = null;

    if (this.app) {
      this.app.destroy();
      this.app = null;
    }
    if (this.backdropRoot) {
      this.backdropRoot.remove();
      this.backdropRoot = null;
    }
    this.skyCanvas = null;
    this.skyCtx = null;
  }
}
