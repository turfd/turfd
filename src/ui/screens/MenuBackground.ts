/**
 * Standalone PixiJS world renderer for the main menu background.
 *
 * Layers (back to front):
 *  1. CSS canvas — sky gradient (+ sun)
 *  2. PixiJS — blurred procedural parallax tile strip, then lit foreground terrain + composite
 *  3. DOM overlay (MainMenu)
 *
 * Zoom matches the game's adaptive formula (max 20 blocks visible horizontally).
 * Lighting uses the full composite shader (OcclusionTexture + IndirectLightTexture).
 */
import { Application, Container, RenderTexture } from "pixi.js";
import {
  BACKGROUND_PARALLAX_X,
  BLOCK_SIZE,
  CHUNK_SIZE,
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
import { CompositePass } from "../../renderer/lighting/CompositePass";
import { buildMesh, buildBackgroundMesh } from "../../renderer/chunk/TileDrawBatch";
import { BlockRegistry } from "../../world/blocks/BlockRegistry";
import { WorldGenerator } from "../../world/gen/WorldGenerator";
import type { Chunk } from "../../world/chunk/Chunk";
import { chunkKey, chunkToWorldOrigin } from "../../world/chunk/ChunkCoord";
import type { World } from "../../world/World";
import {
  MENU_SKY_FALLBACK_GRADIENT,
  paintMenuSky,
} from "./menuSkyPaint";

// ---------------------------------------------------------------------------
// Layout / world constants
// ---------------------------------------------------------------------------

const CHUNKS_X    = 10;  // 320 blocks wide
const CY_START    = -3;  // underground
const CY_END      = 2;   // surface + canopy

/** World +X pan of the menu view (blocks). Safe while center ± {@link PAN_RANGE_X_BLOCKS} stays in [0, CHUNKS_X * CHUNK_SIZE). */
const MENU_VIEW_OFFSET_X_BLOCKS = 100;

/**
 * Adaptive zoom: same formula as Camera.getEffectiveZoom().
 * Keeps at most MAX_VISIBLE_BLOCKS_X blocks visible across the screen width,
 * but never drops below MIN_ZOOM.
 */
const MAX_VISIBLE_BLOCKS_X = 20;
const MIN_ZOOM             = 2;

function computeZoom(screenW: number): number {
  return Math.max(MIN_ZOOM, screenW / (MAX_VISIBLE_BLOCKS_X * BLOCK_SIZE));
}

const PAN_SPEED_X       = 0.040;  // rad/s
const PAN_RANGE_X_BLOCKS = 16;    // ±blocks
const PAN_SPEED_Y       = 0.022;  // rad/s
const PAN_RANGE_Y_PX    = 24;     // ±screen-pixels (vertical bob)

// ---------------------------------------------------------------------------
// Sky / background constants (mirror values from WorldTime.ts / RenderPipeline.ts)
// ---------------------------------------------------------------------------

/** Daytime lighting params passed to the composite shader. */
const DAYTIME_LIGHTING = {
  sunDir:       [0.45,  0.89]          as [number, number],
  ambient:      1.0,
  ambientTint:  [1.0, 1.0, 1.0]       as [number, number, number],
  skyLightTint: [1.0, 0.98, 0.95]     as [number, number, number],
  sunIntensity: 0.82,
  sunTint:      [1.0, 0.98, 0.92]     as [number, number, number],
  moonDir:      [-0.45, -0.89]        as [number, number],
  moonIntensity: 0.0,
  moonTint:     [0.6, 0.7, 1.0]       as [number, number, number],
  heldTorch:    null,
} as const;

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

  constructor() {
    this.initFinished = new Promise<void>((resolve) => {
      this.resolveInitFinished = resolve;
    });
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
  private atlasLoader: AtlasLoader | null = null;
  private menuSeed = 0;

  private baseX = 0;
  private baseY = 0;
  private panRangeXPx = 0;
  private zoom = MIN_ZOOM;

  /** Surface block Y at menu mid-X; needed to recompute layout on window resize. */
  private surfaceYForLayout = 0;

  /** Physical backbuffer size; when it changes, albedo RT + zoom must update. */
  private lastRendererW = 0;
  private lastRendererH = 0;

  private lastCenterCX = -9999;
  private lastCenterCY = -9999;

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

  private async initImpl(mount: HTMLElement): Promise<void> {
    const backdropRoot = document.createElement("div");
    backdropRoot.className = "stratum-menu-backdrop";
    backdropRoot.style.cssText =
      "position:absolute;inset:0;z-index:0;pointer-events:none;overflow:hidden;" +
      `background:${MENU_SKY_FALLBACK_GRADIENT};`;
    this.backdropRoot = backdropRoot;
    if (mount.firstChild) {
      mount.insertBefore(backdropRoot, mount.firstChild);
    } else {
      mount.appendChild(backdropRoot);
    }

    // -- Sky Canvas (inserted first = lowest z-order) -----------------------
    const skyCanvas = document.createElement("canvas");
    skyCanvas.style.cssText =
      "position:absolute;inset:0;width:100%;height:100%;z-index:0;pointer-events:none;";
    backdropRoot.appendChild(skyCanvas);
    this.skyCanvas = skyCanvas;
    this.skyCtx = skyCanvas.getContext("2d");
    this.paintSkyBootstrap(mount);

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
    const atlas = new AtlasLoader(BLOCK_TEXTURE_MANIFEST_PATH);
    await atlas.load();
    if (this.destroyed) { app.destroy(); return; }

    this.atlasLoader = atlas;

    const registry = new BlockRegistry();
    const base = import.meta.env.BASE_URL;
    const behBase = `${base}${STRATUM_CORE_BEHAVIOR_PACK_PATH}`;
    const behManifest = await fetchBehaviorPackManifest(behBase);
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

    const dpr     = app.renderer.resolution;
    const screenW = app.renderer.width  / dpr;
    const screenH = app.renderer.height / dpr;
    const zoom    = computeZoom(screenW);
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
    this.parallaxStrip = parallaxStrip;

    const menuGenMap = new Map<string, Chunk>();
    for (let cy = CY_START; cy <= CY_END; cy++) {
      for (let cx = 0; cx < CHUNKS_X; cx++) {
        const coord = { cx, cy };
        const chunk = generator.generateChunkTerrainOnly(coord);
        menuGenMap.set(chunkKey(coord), chunk);
      }
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
        const pos = {
          x: cx * CHUNK_SIZE * BLOCK_SIZE,
          y: -cy * CHUNK_SIZE * BLOCK_SIZE,
        };
        const bgMesh = buildBackgroundMesh(chunk, registry, atlas);
        bgMesh.position.set(pos.x, pos.y);
        worldContainer.addChild(bgMesh);
        const { mesh } = buildMesh(chunk, registry, atlas);
        mesh.position.set(pos.x, pos.y);
        worldContainer.addChild(mesh);
      }
    }

    propagateSkyLight(chunkMap, registry);

    // -- Lighting pipeline --------------------------------------------------
    const albedoRT = RenderTexture.create({
      width:  app.renderer.width,
      height: app.renderer.height,
      dynamic: true,
    });
    this.albedoRT = albedoRT;

    const occlusion = new OcclusionTexture();
    const indirect  = new IndirectLightTexture();
    const composite = new CompositePass(albedoRT, occlusion, indirect);
    composite.resize(screenW, screenH);
    this.occlusion = occlusion;
    this.indirect  = indirect;
    this.composite = composite;

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

    worldContainer.position.set(this.baseX, this.baseY);

    this.lastRendererW = app.renderer.width;
    this.lastRendererH = app.renderer.height;

    this.startTime = performance.now();
    this.rafId = requestAnimationFrame((t) => this.animate(t));
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
    if (rw === this.lastRendererW && rh === this.lastRendererH) return;

    this.lastRendererW = rw;
    this.lastRendererH = rh;

    const rwR = Math.max(1, Math.round(rw));
    const rhR = Math.max(1, Math.round(rh));
    albedoRT.resize(rwR, rhR);

    const dpr     = app.renderer.resolution;
    const screenW = rw / dpr;
    const screenH = rh / dpr;
    composite.resize(screenW, screenH);

    const zoom = computeZoom(screenW);
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
  private paintSkyBootstrap(mount: HTMLElement): void {
    const cvs = this.skyCanvas;
    const ctx = this.skyCtx;
    if (!cvs || !ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const mw = mount.clientWidth || window.innerWidth || 1;
    const mh = mount.clientHeight || window.innerHeight || 1;
    const cw = Math.max(1, Math.round(mw * dpr));
    const ch = Math.max(1, Math.round(mh * dpr));
    cvs.width = cw;
    cvs.height = ch;
    paintMenuSky(ctx, cw, ch, dpr);
  }

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

    const app            = this.app;
    const worldContainer = this.worldContainer;
    const occlusion      = this.occlusion;
    const indirect       = this.indirect;
    const composite      = this.composite;
    const chunkMap       = this.chunkMap;

    // -- Camera pan ---------------------------------------------------------
    const t = (now - this.startTime) / 1000;
    worldContainer.x = this.baseX + Math.sin(t * PAN_SPEED_X) * this.panRangeXPx;
    worldContainer.y = this.baseY + Math.sin(t * PAN_SPEED_Y) * PAN_RANGE_Y_PX;

    // -- Sky (CSS canvas) ---------------------------------------------------
    this.paintSky(worldContainer.x, worldContainer.y);

    const dpr = app.renderer.resolution;
    const sw = app.renderer.width / dpr;
    const sh = app.renderer.height / dpr;
    const localCX = (sw / 2 - worldContainer.x) / this.zoom;
    this.parallaxStrip?.updateParallax(localCX, BACKGROUND_PARALLAX_X);

    // -- Lighting uniforms --------------------------------------------------
    if (occlusion && indirect && composite && chunkMap) {
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
      });
    }

    // -- Two-pass render ----------------------------------------------------
    if (this.albedoRT && composite) {
      app.renderer.render({ container: worldContainer, target: this.albedoRT });
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
   * Lets the app keep the same procedural backdrop when transitioning to the world loading overlay.
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
