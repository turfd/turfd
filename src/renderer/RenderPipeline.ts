import {
  Application,
  Assets,
  Container,
  Culler,
  Rectangle,
  RenderTexture,
  TilingSprite,
  type Texture,
} from "pixi.js";
import {
  createApplicationWithGraphicsPreference,
  type PixiGraphicsBackend,
} from "../ui/settings/pixiGraphicsInit";
import type { EventBus } from "../core/EventBus";
import {
  BACKGROUND_PARALLAX_X,
  DAY_LENGTH_MS,
  MAX_RENDER_BACKBUFFER_PIXELS,
  MAX_RENDER_DEVICE_PIXEL_RATIO,
} from "../core/constants";
import { chunkPerfLog, chunkPerfNow } from "../debug/chunkPerf";
import { withPerfSpan } from "../debug/perfSpans";
import { stratumCoreTextureAssetUrl } from "../core/textureManifest";

import type { World } from "../world/World";
import type { WorldLightingParams } from "../world/lighting/WorldTime";
import type { AtlasLoader } from "./AtlasLoader";
import { BackgroundLayerRenderer } from "./BackgroundLayerRenderer";
import { Camera } from "./Camera";
import { LightingComposer } from "./lighting/LightingComposer";
import { TonemapFilter } from "./lighting/TonemapFilter";
import { WeatherRainParticles } from "./WeatherRainParticles";
import { WeatherSnowParticles } from "./WeatherSnowParticles";
import { SpriteCloudLayer } from "./sky/SpriteCloudLayer";
import { getVideoPrefs, type VideoPrefs } from "../ui/settings/videoPrefs";

/**
 * Named world layers (instances are created by {@link RenderPipeline}).
 * Z-order is back → front: sky → … → particles.
 * {@link layerWaterOverEntities} holds water (lower z) and the local player (higher z) so the body
 * draws in front of fluid while mobs stay in {@link layerEntities} below; torch bloom uses this order.
 */
export interface RenderPipelineLayers {
  readonly layerSky: Container;
  readonly layerTilesBack: Container;
  readonly layerTilesMid: Container;
  readonly layerEntities: Container;
  readonly layerWaterOverEntities: Container;
  readonly layerForeground: Container;
  readonly layerLightmap: Container;
  readonly layerParticles: Container;
}

export type RenderPipelineOptions = {
  mount: HTMLElement;
};

function hexToCss(hex: number): string {
  return `#${((hex & 0xffffff) >>> 0).toString(16).padStart(6, "0")}`;
}

const SKY_PAINT_CLOCK_BUCKET_MS = 100;
const GAMEPLAY_RT_OVERSCAN_PAD_PX = 1;

function clamp01(t: number): number {
  return Math.min(1, Math.max(0, t));
}

/**
 * Pixi `resolution`: integer 1 / 2 / … while logicalW×logicalH×res² ≤ 1080p-class budget, so the
 * canvas backing store stays a **whole-number multiple** of layout pixels (sharp pixel art).
 * Capped by device DPR and {@link MAX_RENDER_DEVICE_PIXEL_RATIO}. If the viewport exceeds the
 * budget even at 1×, returns sqrt(budget / area) below 1 (last resort; slightly soft).
 */
function effectiveRenderResolution(
  logicalWidth: number,
  logicalHeight: number,
): number {
  const dpr = window.devicePixelRatio >= 1 ? window.devicePixelRatio : 1;
  const hwCap = Math.min(dpr, MAX_RENDER_DEVICE_PIXEL_RATIO);
  const maxInteger = Math.max(1, Math.floor(hwCap + 1e-6));
  const lw = Math.max(1, logicalWidth);
  const lh = Math.max(1, logicalHeight);
  const area = lw * lh;
  const budget = MAX_RENDER_BACKBUFFER_PIXELS;

  for (let r = maxInteger; r >= 1; r--) {
    if (area * r * r <= budget) {
      return r;
    }
  }
  return Math.sqrt(budget / area);
}

/** 0 outside [edge0, edge1], smooth Hermite inside. */
function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/** Deterministic 0–1 PRNG for sky star placement (stable across frames until canvas resizes). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type SkyStarPixel = {
  x: number;
  y: number;
  /** Pixel size in screen-space; larger tiers are rarer/brighter. */
  s: 4 | 6;
  /** Base opacity before time-of-day curve */
  a: number;
  rgb: [number, number, number];
};

/**
 * Pixi application, camera, and ordered world layers. Drives `app.render()` from the game loop.
 *
 * Sky is drawn on a separate 2D canvas inserted **before** the Pixi (WebGL/WebGPU) canvas in the mount so it
 * sits underneath Pixi while tiles/entities/lighting still composite in the usual Pixi order.
 * This avoids GPU texture-upload flicker from putting the gradient in the Pixi scene graph.
 */
export class RenderPipeline implements RenderPipelineLayers {
  private readonly mount: HTMLElement;
  private app: Application | null = null;
  private _graphicsBackend: PixiGraphicsBackend | null = null;
  private readonly camera: Camera;
  private _lastSkyLighting: WorldLightingParams | null = null;
  /** Last `worldTimeMs` passed to {@link updateSky}; drives sky CSS invalidation. */
  private _skyClockMs = 0;
  /** Last sky canvas paint fingerprint (avoids redundant 2D gradient work between fixed ticks). */
  private _lastSkyCanvasPaintMs = -1;
  private _lastSkyCanvasPaintCw = -1;
  private _lastSkyCanvasPaintCh = -1;
  private _lastSkyCanvasPaintLightning = -999;
  private _lastCullCameraX = Number.NaN;
  private _lastCullCameraY = Number.NaN;
  private _lastCullScreenW = -1;
  private _lastCullScreenH = -1;
  private readonly _cullScreen = new Rectangle();
  /** Sky flash alpha from {@link updateSky} (0–1). */
  private _skyLightningAlpha = 0;
  /** Last world ms applied to parallax background tint. */
  private _lastBackgroundLightingMs = -1;

  private _rainRoot: Container | null = null;
  private _rainTiling: TilingSprite | null = null;
  private _rainParticles: WeatherRainParticles | null = null;
  private _snowParticles: WeatherSnowParticles | null = null;

  /** Loaded `textures/environment/*.png` for 2D sky canvas (sun / moon). */
  private _skySunImage: HTMLImageElement | null = null;
  private _skyMoonFullImage: HTMLImageElement | null = null;
  private _skyMoonNewImage: HTMLImageElement | null = null;

  /** Dedicated DOM canvas behind the WebGL canvas — never touched by Pixi. */
  private _skyCssCanvas: HTMLCanvasElement | null = null;
  private _skyCssCtx: CanvasRenderingContext2D | null = null;
  private _skyCssW = 0;
  private _skyCssH = 0;

  /** Night sky pixel stars (screen space); rebuilt when the sky canvas size changes. */
  private _skyStars: SkyStarPixel[] = [];
  private _skyStarsCw = 0;
  private _skyStarsCh = 0;

  private lastScreenW = 0;
  private lastScreenH = 0;
  private _lastRendererRes = 0;

  readonly layerSky: Container;
  readonly layerTilesBack: Container;
  readonly layerTilesMid: Container;
  readonly layerEntities: Container;
  readonly layerWaterOverEntities: Container;
  readonly layerForeground: Container;
  readonly layerLightmap: Container;
  readonly layerParticles: Container;

  private _lightingComposer: LightingComposer | null = null;
  private _albedoRT: RenderTexture | null = null;
  /** Screen-space alpha mask of the local player; occludes torch bloom in {@link CompositePass}. */
  private _bloomMaskRT: RenderTexture | null = null;
  private _bloomMaskPlayerRoot: Container | null = null;
  private readonly _emptyMaskClearRoot = new Container();
  /**
   * Bloom mask (player silhouette) is re-rendered every other frame. The RT persists between
   * frames; a ≤16ms stale mask is imperceptible given bloom's soft glow. Cuts one full
   * {@link renderWorldWithOverscanOffset} pass every other frame when bloom is enabled.
   * Starts at 1 so the first `render()` call after enablement always primes the RT.
   */
  private _bloomMaskFrameCounter = 1;
  private _lastBloomMaskCameraX = Number.NaN;
  private _lastBloomMaskCameraY = Number.NaN;
  private _lastBloomMaskBoundsX = Number.NaN;
  private _lastBloomMaskBoundsY = Number.NaN;
  private _lastBloomMaskBoundsW = Number.NaN;
  private _lastBloomMaskBoundsH = Number.NaN;
  private _compositeSyncDirty = true;
  /** Last {@link getVideoPrefs}.renderScale applied to albedo/bloom RT resolution. */
  private _lastVideoRenderScale = Number.NaN;
  private readonly _bloomMaskWorldVisScratch: Array<{ n: Container; v: boolean }> = [];
  private readonly _bloomMaskSiblingVisScratch: Array<{ n: Container; v: boolean }> = [];
  private _bgToneFilter: TonemapFilter | null = null;


  private _backgroundLayer: BackgroundLayerRenderer | null = null;
  private _backgroundWorld: World | null = null;
  private readonly _backgroundBusUnsubs: (() => void)[] = [];
  private _spriteCloud: SpriteCloudLayer | null = null;
  private readonly _overscanPadPx = GAMEPLAY_RT_OVERSCAN_PAD_PX;

  private readonly onWindowResize = (): void => {
    this.syncSizeFromRenderer();
  };

  /** Fullscreen / element resize may not fire `window.resize`; Pixi `resizeTo` can lag one frame. */
  private readonly onFullscreenChange = (): void => {
    this.syncSizeFromRenderer();
  };

  constructor(options: RenderPipelineOptions) {
    this.mount = options.mount;
    this.camera = new Camera();

    this.layerSky = new Container({ label: "layerSky" });
    this.layerTilesBack = new Container({ label: "layerTilesBack" });
    this.layerTilesMid = new Container({ label: "layerTilesMid" });
    this.layerEntities = new Container({ label: "layerEntities" });
    this.layerWaterOverEntities = new Container({
      label: "layerWaterOverEntities",
    });
    this.layerForeground = new Container({ label: "layerForeground" });
    this.layerLightmap = new Container({ label: "layerLightmap" });
    this.layerParticles = new Container({ label: "layerParticles" });

    this.layerLightmap.visible = true;

    // Pixi's EventSystem walks the whole display tree on every pointermove to hit-test
    // interactive children. The game doesn't rely on any pixi-level pointer events —
    // pointer→world translation happens manually via {@link Input.updateMouseWorldPos} —
    // so opting every world-tree container out of event propagation cuts a large chunk
    // of per-move CPU (visible as `_onPointerMove` / `Hit test` in profile captures).
    this.camera.worldRoot.eventMode = "none";
    this.layerSky.eventMode = "none";
    this.layerTilesBack.eventMode = "none";
    this.layerTilesMid.eventMode = "none";
    this.layerEntities.eventMode = "none";
    this.layerWaterOverEntities.eventMode = "none";
    this.layerForeground.eventMode = "none";
    this.layerLightmap.eventMode = "none";
    this.layerParticles.eventMode = "none";
    // Lighting overlay is screen-cover compositing output; no value in per-frame culler descent.
    this.layerLightmap.cullable = false;
    this.layerLightmap.cullableChildren = false;

    // So local player zIndex can sort above mobs (e.g. zIndex -2) and match bloom mask vs albedo.
    this.layerEntities.sortableChildren = true;
    // Local player is mounted here; sort above water quads (z 0) so they draw in front and torch
    // bloom + bloom mask line up with the visible sprite, not the submerged entity layer.
    this.layerWaterOverEntities.sortableChildren = true;

    const world = this.camera.worldRoot;
    world.addChild(this.layerTilesBack);
    world.addChild(this.layerTilesMid);
    world.addChild(this.layerEntities);
    world.addChild(this.layerWaterOverEntities);
    world.addChild(this.layerForeground);
    world.addChild(this.layerLightmap);
    world.addChild(this.layerParticles);
  }

  get pixiApp(): Application {
    if (!this.app) {
      throw new Error("RenderPipeline.init() must complete before accessing pixiApp");
    }
    return this.app;
  }

  getCamera(): Camera {
    return this.camera;
  }

  get lightingComposer(): LightingComposer {
    if (this._lightingComposer === null) {
      throw new Error("RenderPipeline.initLighting() must complete before lightingComposer");
    }
    return this._lightingComposer;
  }

  /** Call after {@link init} with the game World, bus, and block atlas (same as {@link ChunkRenderer}). */
  initLighting(world: World, bus: EventBus, blockAtlas: AtlasLoader): void {
    if (this.app === null || this._albedoRT === null) {
      throw new Error("RenderPipeline.init() must complete before initLighting()");
    }
    this._backgroundWorld = world;
    const bgRenderer = new BackgroundLayerRenderer(this.app, this.camera);
    bgRenderer.setWorldAndAtlas(world, blockAtlas);
    this._backgroundLayer = bgRenderer;
    const worldRootIndex = this.app.stage.getChildIndex(this.camera.worldRoot);
    this.app.stage.addChildAt(bgRenderer.displayRoot, worldRootIndex);

    const bgTone = new TonemapFilter();
    this._bgToneFilter = bgTone;
    bgRenderer.displayRoot.filters = [bgTone.filter];

    const regenBackground = (): void => {
      if (this._backgroundLayer === null || this._backgroundWorld === null || this.app === null) {
        return;
      }
      this.syncSizeFromRenderer();
      this._backgroundLayer.regenerate();
    };

    this._backgroundBusUnsubs.push(
      bus.on("world:loaded", regenBackground),
      bus.on("window:resized", regenBackground),
    );

    this._lightingComposer = new LightingComposer(world, bus, this.app.stage);
    if (this._bloomMaskRT === null) {
      throw new Error(
        "RenderPipeline.init() must create bloom mask RT before initLighting()",
      );
    }
    this._lightingComposer.initComposite(
      this._albedoRT,
      this.camera,
      this._bloomMaskRT.source,
    );
    this._lightingComposer.resize(
      Math.max(1, Math.round(this.app.renderer.width)),
      Math.max(1, Math.round(this.app.renderer.height)),
    );
    this.updateCompositeViewportMapping();
  }

  /**
   * When set, torch bloom is suppressed where this subtree draws (local player). Call after
   * {@link EntityManager.initVisual} with the player root container.
   */
  setBloomMaskPlayerRoot(root: Container | null): void {
    this._bloomMaskPlayerRoot = root;
  }

  /** Canvas used for pointer ↔ world mapping (resolution-aware). */
  getCanvas(): HTMLCanvasElement {
    if (!this.app) {
      throw new Error("RenderPipeline.init() must complete before getCanvas()");
    }
    return this.app.canvas;
  }

  /**
   * Pixi WebGL context when using the WebGL renderer; `null` for Canvas2D / WebGPU builds.
   * Used by the F3 GPU debug HUD (draw-call hooks + `WEBGL_debug_renderer_info`).
   */
  getWebGLContext(): WebGLRenderingContext | WebGL2RenderingContext | null {
    const app = this.app;
    if (app === null) {
      return null;
    }
    const gl = (app.renderer as unknown as { gl?: WebGLRenderingContext | WebGL2RenderingContext | null })
      .gl;
    return gl ?? null;
  }

  /** `"webgpu"` or `"webgl"` after {@link init}; `null` before init. */
  getGraphicsBackend(): PixiGraphicsBackend | null {
    return this._graphicsBackend;
  }

  async init(): Promise<void> {
    if (this.app) {
      return;
    }

    const mountRect = this.mount.getBoundingClientRect();
    const initW = Math.max(1, Math.round(mountRect.width));
    const initH = Math.max(1, Math.round(mountRect.height));
    const { app: application, backend } = await createApplicationWithGraphicsPreference({
      autoStart: false,
      resizeTo: this.mount,
      antialias: false,
      powerPreference: "high-performance",
      backgroundAlpha: 0,
      resolution: effectiveRenderResolution(initW, initH),
      autoDensity: true,
    });

    this.app = application;
    this._graphicsBackend = backend;

    const skyCanvas = document.createElement("canvas");
    skyCanvas.dataset.stratumCanvas = "game-sky-2d";
    skyCanvas.style.position = "absolute";
    skyCanvas.style.left = "0";
    skyCanvas.style.top = "0";
    skyCanvas.style.width = "100%";
    skyCanvas.style.height = "100%";
    skyCanvas.style.pointerEvents = "none";
    this._skyCssCanvas = skyCanvas;
    this._skyCssCtx = skyCanvas.getContext("2d");
    this.mount.appendChild(skyCanvas);

    const canvas = application.canvas;
    canvas.dataset.stratumCanvas =
      backend === "webgpu" ? "game-pixi-webgpu" : "game-pixi-webgl";
    canvas.style.position = "absolute";
    canvas.style.left = "0";
    canvas.style.top = "0";
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.style.display = "block";
    canvas.style.imageRendering = "pixelated";
    canvas.style.zIndex = "1";

    this.mount.appendChild(canvas);

    const rtRes = application.renderer.resolution;
    const scale0 = getVideoPrefs().renderScale;
    this._lastVideoRenderScale = scale0;
    const initialRtWidth = Math.max(
      1,
      Math.round(application.renderer.width + this._overscanPadPx * 2),
    );
    const initialRtHeight = Math.max(
      1,
      Math.round(application.renderer.height + this._overscanPadPx * 2),
    );
    const initialRtResolution = rtRes * scale0;
    this._albedoRT = RenderTexture.create({
      width: initialRtWidth,
      height: initialRtHeight,
      resolution: initialRtResolution,
      dynamic: true,
    });
    // Nearest when sampled in {@link CompositePass}: avoids bilinear pulling wrong neighbors at
    // framebuffer edges (looks like a 1px normal shift when a block edge sits on-screen).
    this._albedoRT.source.scaleMode = "nearest";
    this._bloomMaskRT = RenderTexture.create({
      width: initialRtWidth,
      height: initialRtHeight,
      resolution: initialRtResolution,
      dynamic: true,
    });
    this._bloomMaskRT.source.scaleMode = "nearest";

    // Entire pixi stage opts out of event propagation — see constructor note.
    application.stage.eventMode = "none";
    application.stage.addChild(this.camera.worldRoot);

    const cloud = new SpriteCloudLayer();
    void cloud.init().then(() => {
      if (this.app === null) {
        cloud.destroy();
        return;
      }
      this._spriteCloud = cloud;
      this._resizeCloudLayer();
      cloud.applySunnyDefaultPalette();
      this.app.stage.addChildAt(cloud.displayRoot, 0);
    });

    window.addEventListener("resize", this.onWindowResize);
    document.addEventListener("fullscreenchange", this.onFullscreenChange);
    document.addEventListener("webkitfullscreenchange", this.onFullscreenChange);
    this.syncSizeFromRenderer();
  }

  /**
   * Sync canvas/backbuffer size into camera, albedo RT, and lighting **before** computing
   * lighting uniforms. Must run before {@link LightingComposer#update}; otherwise
   * `screenSize` / `screenToWorld` can lag a frame behind a resize (e.g. DevTools dock),
   * which makes shadow/lighting appear to drift or "dance".
   */
  prepareFrame(): void {
    this.syncSizeFromRenderer();
    this.syncLocalPlayerBloomUvRect();
  }

  /**
   * Feeds a UV AABB into the composite pass so torch bloom (small HDR kernel) is cut inside the
   * local player rectangle even when the bloom-mask RT misses semi-transparent pixels.
   */
  private syncLocalPlayerBloomUvRect(): void {
    const lc = this._lightingComposer;
    const rt = this._albedoRT;
    const app = this.app;
    const root = this._bloomMaskPlayerRoot;
    if (lc === null || rt === null || app === null) {
      return;
    }
    if (root === null || root.parent === null || !root.visible) {
      lc.setLocalPlayerBloomUvBounds(false, 0, 0, 0, 0);
      return;
    }
    const pad = this._overscanPadPx;
    const rw = Math.max(1, Math.round(rt.width));
    const rh = Math.max(1, Math.round(rt.height));
    const vw = this.lastScreenW;
    const vh = this.lastScreenH;
    const b = root.getBounds(true);
    const expand = 10;
    const x0 = Math.max(0, b.x - expand);
    const y0 = Math.max(0, b.y - expand);
    const x1 = Math.min(vw, b.x + b.width + expand);
    const y1 = Math.min(vh, b.y + b.height + expand);
    if (x1 <= x0 + 0.5 || y1 <= y0 + 0.5) {
      lc.setLocalPlayerBloomUvBounds(false, 0, 0, 0, 0);
      return;
    }
    const minU = (x0 + pad) / rw;
    const minV = (y0 + pad) / rh;
    const maxU = (x1 + pad) / rw;
    const maxV = (y1 + pad) / rh;
    lc.setLocalPlayerBloomUvBounds(true, minU, minV, maxU, maxV);
  }

  /**
   * Store latest lighting for {@link render}; sky is painted once per frame there (when clock or
   * canvas size changes). Parallax background tint only updates when `worldTimeMs` changes.
   */
  updateSky(
    lighting: WorldLightingParams,
    worldTimeMs: number,
    extras?: { lightningAlpha?: number },
  ): void {
    this._lastSkyLighting = lighting;
    this._skyClockMs = worldTimeMs;
    this._skyLightningAlpha = extras?.lightningAlpha ?? 0;
    if (worldTimeMs !== this._lastBackgroundLightingMs) {
      this._backgroundLayer?.applyWorldLighting(lighting);
      this._lastBackgroundLightingMs = worldTimeMs;
    }
    this._spriteCloud?.applyWorldLighting(lighting);
  }

  /**
   * World-space rain behind terrain: fills the visible viewport in world pixels so `weather/rain.png`
   * texels align 1:1 with world pixels (same grid as blocks after zoom). Safe before textures load.
   */
  updateWeatherOverlay(showRain: boolean, dtSec: number): void {
    const t = this._rainTiling;
    const root = this._rainRoot;
    if (t === null || root === null || this.app === null) {
      return;
    }
    root.visible = showRain;
    if (!showRain) {
      return;
    }
    const cam = this.camera;
    const z = cam.getZoom();
    const w = Math.max(1, Math.round(this.app.renderer.width));
    const h = Math.max(1, Math.round(this.app.renderer.height));
    const viewW = w / z;
    const viewH = h / z;
    const topLeft = cam.screenToWorld(0, 0);
    root.position.set(topLeft.x, topLeft.y);
    t.width = viewW;
    t.height = viewH;
    t.x = 0;
    t.y = 0;
    // Scroll in texture space (px); rates tuned for the rain sheet.
    t.tilePosition.x += dtSec * 42;
    t.tilePosition.y += dtSec * 400;
    this._rainParticles?.update(dtSec, showRain, viewW, viewH, z);
  }

  updateSnowfallEffect(intensity: number, dtSec: number): void {
    if (this.app === null || this._snowParticles === null) {
      return;
    }
    const cam = this.camera;
    const z = cam.getZoom();
    const w = Math.max(1, Math.round(this.app.renderer.width));
    const h = Math.max(1, Math.round(this.app.renderer.height));
    const viewW = w / z;
    const viewH = h / z;
    const topLeft = cam.screenToWorld(0, 0);
    this._snowParticles.update(
      dtSec,
      intensity,
      viewW,
      viewH,
      topLeft.x,
      topLeft.y,
      z,
    );
  }

  /** Load `textures/weather/rain.png` and attach tiling + streaks as the first world layer (under tiles). */
  async initWeatherOverlay(): Promise<void> {
    if (this.app === null) {
      return;
    }
    const loadNearestTexture = async (relativePath: string): Promise<Texture | null> => {
      const url = stratumCoreTextureAssetUrl(relativePath);
      try {
        const tex = (await Assets.load<Texture>(url)) ?? Assets.get<Texture>(url);
        if (tex === undefined || tex.source === undefined) {
          return null;
        }
        tex.source.scaleMode = "nearest";
        return tex;
      } catch {
        return null;
      }
    };

    const rainTexture = await loadNearestTexture("weather/rain.png");
    if (rainTexture !== null) {
      const z = this.camera.getZoom();
      const w = Math.max(1, Math.round(this.app.renderer.width));
      const h = Math.max(1, Math.round(this.app.renderer.height));
      const tiling = new TilingSprite({
        texture: rainTexture,
        width: w / z,
        height: h / z,
        tileScale: { x: 1, y: 1 },
        roundPixels: true,
      });
      tiling.alpha = 0.38;
      tiling.blendMode = "overlay";
      tiling.visible = false;
      const root = new Container();
      root.label = "weatherRainOverlay";
      root.eventMode = "none";
      root.cullable = false;
      root.cullableChildren = false;
      root.addChild(tiling);
      // Behind all tile/entity layers; still in front of the parallax background (separate stage child).
      this.camera.worldRoot.addChildAt(root, 0);
      this._rainRoot = root;
      this._rainTiling = tiling;
      this._rainParticles = new WeatherRainParticles(root);
    } else {
      console.warn("[RenderPipeline] Rain texture failed to load.");
    }

    const snowParticleTexture =
      (await loadNearestTexture("weather/snow.png")) ?? rainTexture ?? null;
    if (snowParticleTexture !== null) {
      this._snowParticles = new WeatherSnowParticles(
        this.layerParticles,
        snowParticleTexture,
      );
    } else {
      console.warn(
        "[RenderPipeline] Snow particle texture failed to load (no weather/snow.png and no rain texture fallback).",
      );
    }
  }

  /** Loads sun/moon PNGs from the built-in pack for {@link paintSkyCss}. */
  async initSkyCelestialTextures(): Promise<void> {
    const load = (url: string): Promise<HTMLImageElement | null> =>
      new Promise((resolve) => {
        const im = new Image();
        im.crossOrigin = "anonymous";
        im.onload = () => resolve(im);
        im.onerror = () => {
          console.warn("[RenderPipeline] Sky texture failed to load:", url);
          resolve(null);
        };
        im.src = url;
      });
    const [sun, full, neu] = await Promise.all([
      load(stratumCoreTextureAssetUrl("environment/sun.png")),
      load(stratumCoreTextureAssetUrl("environment/full_moon.png")),
      load(stratumCoreTextureAssetUrl("environment/new_moon.png")),
    ]);
    this._skySunImage = sun;
    this._skyMoonFullImage = full;
    this._skyMoonNewImage = neu;
    this._lastSkyCanvasPaintMs = -1;
  }

  private ensureSkyStarField(cw: number, ch: number): void {
    if (cw === this._skyStarsCw && ch === this._skyStarsCh && this._skyStars.length > 0) {
      return;
    }
    this._skyStarsCw = cw;
    this._skyStarsCh = ch;
    const upperH = Math.max(1, Math.floor(ch * 0.68));
    const seed = ((cw * 0x9e3779b9) ^ (ch * 0x85ebca6b) ^ 0xf1357aef) >>> 0;
    const rand = mulberry32(seed);
    const area = cw * upperH;
    const n = Math.min(300, Math.max(64, Math.round(area / 12000)));
    const stars: SkyStarPixel[] = [];
    for (let i = 0; i < n; i++) {
      const big = rand() < 0.085;
      let x = Math.floor(rand() * cw);
      let y = Math.floor(rand() * upperH);
      let s: 4 | 6 = 4;
      if (big && x <= cw - 6 && y <= upperH - 6) {
        s = 6;
      } else {
        x = Math.min(x, Math.max(0, cw - 4));
        y = Math.min(y, Math.max(0, upperH - 4));
      }
      const a = (s === 6 ? 0.16 : 0.07) + rand() * (s === 6 ? 0.32 : 0.26);
      const cool = rand();
      const r = Math.round(198 + cool * 58);
      const g = Math.round(208 + cool * 48);
      const b = 255;
      stars.push({
        x,
        y,
        s,
        a: Math.min(0.5, a),
        rgb: [r, g, b],
      });
    }
    this._skyStars = stars;
  }

  private drawSkyStars(
    ctx: CanvasRenderingContext2D,
    lighting: WorldLightingParams,
  ): void {
    const visAmb = 1 - smoothstep(0.06, 0.2, lighting.ambient);
    const visSun = 1 - smoothstep(0.03, 0.3, lighting.sunIntensity);
    const vis = visAmb * visSun;
    if (vis < 0.015) {
      return;
    }
    const flash = this._skyLightningAlpha;
    const storm = 1 - flash * 0.78;

    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.globalCompositeOperation = "lighter";
    for (const st of this._skyStars) {
      const alpha = st.a * vis * storm;
      if (alpha < 0.016) {
        continue;
      }
      ctx.fillStyle = `rgba(${st.rgb[0]},${st.rgb[1]},${st.rgb[2]},${alpha})`;
      ctx.fillRect(st.x, st.y, st.s, st.s);
    }
    ctx.restore();
  }

  /**
   * Paint the sky gradient + celestial bodies on the 2D canvas under Pixi.
   */
  private paintSkyCss(lighting: WorldLightingParams): void {
    const ctx = this._skyCssCtx;
    const cvs = this._skyCssCanvas;
    if (ctx === null || cvs === null) {
      return;
    }
    const cw = Math.max(1, this._skyCssW);
    const ch = Math.max(1, this._skyCssH);

    const { top, horizon, bottom } = lighting.sky;

    /**
     * Clean two-stop vertical gradient from palette `top` → `bottom`, with `horizon` anchored at
     * the midpoint so weather/rain tints still influence the middle band. No horizon-brightening
     * "haze toward white" pass — the per-phase palette already carries all the intended colour.
     */
    const grd = ctx.createLinearGradient(0, 0, 0, ch);
    grd.addColorStop(0, hexToCss(top));
    grd.addColorStop(0.5, hexToCss(horizon));
    grd.addColorStop(1, hexToCss(bottom));
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, cw, ch);

    this.ensureSkyStarField(cw, ch);
    this.drawSkyStars(ctx, lighting);

    const { sunDir, moonDir, sunIntensity, moonIntensity } = lighting;
    /** Horizontal half-axis of the celestial arc (screen space). */
    const spread = cw * 0.38;
    /**
     * Vertical orbit: center near mid-gradient and a large Y radius so the disc follows a tall
     * ellipse (sunrise → zenith → set → nadir under the “horizon”) instead of hugging the top band.
     */
    const celestialOrbitCy = ch * 0.5;
    const celestialOrbitRy = ch * 0.5;

    let sunAlpha = Math.min(1, sunIntensity / 0.65);
    let moonAlpha = Math.min(1, moonIntensity / 0.22);
    /** Only one celestial disc on the sky canvas (matches opposite-orbit day/night handoff). */
    if (sunAlpha >= moonAlpha) {
      moonAlpha = 0;
    } else {
      sunAlpha = 0;
    }

    const sunImg = this._skySunImage;
    const sunTexW = sunImg !== null && sunImg.naturalWidth > 0 ? sunImg.naturalWidth : 16;
    const celestialDim = Math.max(20, sunTexW * 1.25) * 4;

    const sx = cw * 0.5 + sunDir[0] * spread;
    const sy = celestialOrbitCy - sunDir[1] * celestialOrbitRy;
    if (sunAlpha > 0.04) {
      if (sunImg !== null && sunImg.naturalWidth > 0) {
        ctx.save();
        ctx.globalCompositeOperation = "screen";
        ctx.globalAlpha = sunAlpha;
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(sunImg, sx - celestialDim * 0.5, sy - celestialDim * 0.5, celestialDim, celestialDim);
        ctx.restore();
      } else {
        ctx.save();
        ctx.globalCompositeOperation = "screen";
        ctx.globalAlpha = sunAlpha;
        ctx.beginPath();
        ctx.arc(sx, sy, celestialDim * 0.5, 0, Math.PI * 2);
        ctx.fillStyle = "rgb(255,243,176)";
        ctx.fill();
        ctx.restore();
      }
    }

    const mx = cw * 0.5 + moonDir[0] * spread;
    const my = celestialOrbitCy - moonDir[1] * celestialOrbitRy;
    if (moonAlpha > 0.04) {
      const phase8 =
        Math.floor((this._skyClockMs / DAY_LENGTH_MS) * 8) % 8;
      const moonImg =
        phase8 >= 2 && phase8 <= 5
          ? this._skyMoonFullImage
          : this._skyMoonNewImage;
      if (moonImg !== null && moonImg.naturalWidth > 0) {
        ctx.save();
        ctx.globalCompositeOperation = "screen";
        ctx.globalAlpha = moonAlpha;
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(moonImg, mx - celestialDim * 0.5, my - celestialDim * 0.5, celestialDim, celestialDim);
        ctx.restore();
      } else {
        ctx.save();
        ctx.globalCompositeOperation = "screen";
        ctx.globalAlpha = moonAlpha;
        ctx.beginPath();
        ctx.arc(mx, my, celestialDim * 0.5, 0, Math.PI * 2);
        ctx.fillStyle = "rgb(216,220,255)";
        ctx.fill();
        ctx.restore();
      }
    }

    const flash = this._skyLightningAlpha;
    if (flash > 0.002) {
      ctx.fillStyle = `rgba(255,255,255,${flash * 0.58})`;
      ctx.fillRect(0, 0, cw, ch);
    }
  }

  /** Skip {@link paintSkyCss} when world time and backing size match the last paint. */
  private maybePaintSkyCss(): void {
    const lighting = this._lastSkyLighting;
    if (lighting === null) {
      return;
    }
    const cw = Math.max(1, this._skyCssW);
    const ch = Math.max(1, this._skyCssH);
    const li = this._skyLightningAlpha;
    const clockBucket = Math.floor(this._skyClockMs / SKY_PAINT_CLOCK_BUCKET_MS);
    if (
      clockBucket === this._lastSkyCanvasPaintMs &&
      cw === this._lastSkyCanvasPaintCw &&
      ch === this._lastSkyCanvasPaintCh &&
      li === this._lastSkyCanvasPaintLightning
    ) {
      return;
    }
    this.paintSkyCss(lighting);
    this._lastSkyCanvasPaintMs = clockBucket;
    this._lastSkyCanvasPaintCw = cw;
    this._lastSkyCanvasPaintCh = ch;
    this._lastSkyCanvasPaintLightning = li;
  }

  private shouldRenderBloomMaskSibling(
    sibling: unknown,
    localRoot: unknown,
  ): boolean {
    if (sibling === localRoot) {
      return true;
    }
    // Remote player roots share the local player's parent and are Containers.
    // Water quads/meshes are not Containers and should not suppress bloom.
    return sibling instanceof Container;
  }

  private shouldRefreshBloomMaskForPlayerMotion(): boolean {
    const root = this._bloomMaskPlayerRoot;
    if (root === null || root.parent === null || !root.visible) {
      return false;
    }
    const b = root.getBounds(true);
    const x = b.x;
    const y = b.y;
    const w = b.width;
    const h = b.height;
    const dx = Number.isFinite(this._lastBloomMaskBoundsX) ? Math.abs(x - this._lastBloomMaskBoundsX) : Infinity;
    const dy = Number.isFinite(this._lastBloomMaskBoundsY) ? Math.abs(y - this._lastBloomMaskBoundsY) : Infinity;
    const dw = Number.isFinite(this._lastBloomMaskBoundsW) ? Math.abs(w - this._lastBloomMaskBoundsW) : Infinity;
    const dh = Number.isFinite(this._lastBloomMaskBoundsH) ? Math.abs(h - this._lastBloomMaskBoundsH) : Infinity;
    const movedEnough = dx >= 1.25 || dy >= 1.25 || dw >= 0.9 || dh >= 0.9;
    if (movedEnough) {
      this._lastBloomMaskBoundsX = x;
      this._lastBloomMaskBoundsY = y;
      this._lastBloomMaskBoundsW = w;
      this._lastBloomMaskBoundsH = h;
    }
    return movedEnough;
  }

  /** Renders player silhouettes into {@link _bloomMaskRT} for composite bloom occlusion. */
  private renderBloomMask(): void {
    const app = this.app;
    const maskRt = this._bloomMaskRT;
    const playerRoot = this._bloomMaskPlayerRoot;
    if (app === null || maskRt === null) {
      return;
    }
    const wr = this.camera.worldRoot;
    const le = this.layerEntities;
    const lwo = this.layerWaterOverEntities;

    if (playerRoot !== null) {
      const p = playerRoot;
      const par = p.parent;
      if (par === le || par === lwo) {
        const worldVis = this._bloomMaskWorldVisScratch;
        worldVis.length = 0;
        for (const c of wr.children) {
          worldVis.push({ n: c, v: c.visible });
          c.visible = c === par;
        }
        const sibVis = this._bloomMaskSiblingVisScratch;
        sibVis.length = 0;
        for (const c of par.children) {
          sibVis.push({ n: c, v: c.visible });
          c.visible = this.shouldRenderBloomMaskSibling(c, p);
        }
        withPerfSpan("RenderPipeline.renderBloomMask.world", () => {
          this.renderWorldWithOverscanOffset(maskRt);
        });
        for (const { n, v } of sibVis) {
          n.visible = v;
        }
        for (const { n, v } of worldVis) {
          n.visible = v;
        }
        return;
      }
    }
    app.renderer.render({
      container: this._emptyMaskClearRoot,
      target: maskRt,
      clear: true,
      clearColor: "rgba(0,0,0,0)",
    });
  }

  private _resizeCloudLayer(): void {
    if (this.app === null || this._spriteCloud === null) {
      return;
    }
    /** Match {@link Camera#setScreenSize} / sky canvas: Pixi stage + backbuffer use full renderer pixels. */
    const w = Math.max(1, Math.round(this.app.renderer.width));
    const h = Math.max(1, Math.round(this.app.renderer.height));
    this._spriteCloud.resize(w, h);
  }

  /**
   * Called each frame from the game loop (after fixed updates). Renders the Pixi stage.
   */
  render(_alpha: number): void {
    if (!this.app) {
      return;
    }

    const videoPrefs = getVideoPrefs();
    this.syncSizeFromRenderer(videoPrefs);
    this._spriteCloud?.updateTime(performance.now(), this._skyClockMs);
    this._backgroundLayer?.updateParallax(
      this.camera.getPosition().x,
      BACKGROUND_PARALLAX_X,
    );
    this.maybePaintSkyCss();

    if (this._bgToneFilter !== null) {
      const tm = videoPrefs.tonemapper;
      this._bgToneFilter.setTonemapper(
        tm === "aces" ? 1 : tm === "agx" ? 2 : tm === "reinhard" ? 3 : 0,
      );
    }

    if (this._albedoRT !== null && this._lightingComposer !== null) {
      // If a prior frame threw during composite (e.g. WebGL shader error), this can stay false
      // and nothing draws into the albedo RT — terrain/entities look gone until refresh.
      this.camera.worldRoot.visible = true;
      const cameraPos = this.camera.getPosition();
      const screen = this.app.renderer.screen;
      const shouldCull =
        !Number.isFinite(this._lastCullCameraX) ||
        Math.abs(cameraPos.x - this._lastCullCameraX) >= 6 ||
        Math.abs(cameraPos.y - this._lastCullCameraY) >= 6 ||
        screen.width !== this._lastCullScreenW ||
        screen.height !== this._lastCullScreenH;
      if (shouldCull) {
        const tCull = import.meta.env.DEV ? chunkPerfNow() : 0;
        this._cullScreen.x = -this._overscanPadPx;
        this._cullScreen.y = -this._overscanPadPx;
        this._cullScreen.width = screen.width + this._overscanPadPx * 2;
        this._cullScreen.height = screen.height + this._overscanPadPx * 2;
        Culler.shared.cull(this.camera.worldRoot, this._cullScreen, true);
        this._lastCullCameraX = cameraPos.x;
        this._lastCullCameraY = cameraPos.y;
        this._lastCullScreenW = screen.width;
        this._lastCullScreenH = screen.height;
        if (import.meta.env.DEV) {
          chunkPerfLog("renderPipeline:cull", chunkPerfNow() - tCull);
        }
      }
      withPerfSpan("RenderPipeline.renderWorldToAlbedo", () => {
        this.renderWorldWithOverscanOffset(this._albedoRT!);
      });
      // Render the bloom mask every other frame — the RT persists in between, and
      // bloom occlusion tolerates a single-frame stale silhouette far better than it
      // tolerates the duplicated world render this path implies at 60 FPS.
      this._bloomMaskFrameCounter = (this._bloomMaskFrameCounter + 1) | 0;
      const bloomCameraStill =
        Number.isFinite(this._lastBloomMaskCameraX) &&
        Math.abs(cameraPos.x - this._lastBloomMaskCameraX) < 1 &&
        Math.abs(cameraPos.y - this._lastBloomMaskCameraY) < 1;
      const bloomModulo = bloomCameraStill ? 3 : 2;
      const bloomPlayerChanged = this.shouldRefreshBloomMaskForPlayerMotion();
      if (
        videoPrefs.bloomEnabled &&
        (this._skyLightningAlpha > 0.001 ||
          bloomPlayerChanged ||
          this._bloomMaskFrameCounter % bloomModulo === 0)
      ) {
        withPerfSpan("RenderPipeline.renderBloomMask", () => {
          this.renderBloomMask();
        });
        this._lastBloomMaskCameraX = cameraPos.x;
        this._lastBloomMaskCameraY = cameraPos.y;
      }
      try {
        this.camera.worldRoot.visible = false;
        withPerfSpan("RenderPipeline.compositeRender", () => {
          withPerfSpan("RenderPipeline.compositeRender.appRender", () => {
            this.renderAppWithNullChildRecovery();
          });
        });
      } finally {
        this.camera.worldRoot.visible = true;
      }
    } else {
      this.renderAppWithNullChildRecovery();
    }
  }

  /**
   * Guards against rare Pixi v8 crashes where a container's internal `children` array
   * contains `null` and `validateRenderables` reads `renderPipeId` from it.
   * If a frame throws this exact error, scrub null children and retry once.
   */
  private renderAppWithNullChildRecovery(): void {
    const app = this.app;
    if (app === null) {
      return;
    }
    try {
      app.render();
    } catch (error) {
      if (!this.isNullRenderPipeCrash(error)) {
        throw error;
      }
      const removed =
        this.pruneNullChildrenDeep(app.stage) +
        this.pruneNullChildrenDeep(this.camera.worldRoot);
      if (removed > 0) {
        console.warn(
          `[RenderPipeline] Recovered from null renderable crash by pruning ${removed} null scene children.`,
        );
      }
      app.render();
    }
  }

  private isNullRenderPipeCrash(error: unknown): boolean {
    if (!(error instanceof TypeError) || typeof error.message !== "string") {
      return false;
    }
    return error.message.includes("renderPipeId");
  }

  private pruneNullChildrenDeep(root: Container): number {
    const children = (root as unknown as { children?: unknown[] }).children;
    if (!Array.isArray(children) || children.length === 0) {
      return 0;
    }
    let removed = 0;
    for (let i = children.length - 1; i >= 0; i--) {
      if (children[i] == null) {
        children.splice(i, 1);
        removed += 1;
      }
    }
    for (const child of children) {
      if (child instanceof Container) {
        removed += this.pruneNullChildrenDeep(child);
      }
    }
    return removed;
  }

  /**
   * Single-frame sky + lit scene composite, scaled for menu thumbnails.
   * Safe to call during save / quit while the pipeline is still mounted.
   */
  captureWorldPreviewDataUrl(maxWidth = 360): string | null {
    if (!this.app) {
      return null;
    }
    this.syncSizeFromRenderer();
    this.render(0);

    const sceneCanvas = this.app.canvas;
    const skyCanvas = this._skyCssCanvas;
    if (!sceneCanvas || sceneCanvas.width === 0 || sceneCanvas.height === 0) {
      return null;
    }

    const w = sceneCanvas.width;
    const h = sceneCanvas.height;
    const full = document.createElement("canvas");
    full.width = w;
    full.height = h;
    const fctx = full.getContext("2d");
    if (!fctx) {
      return null;
    }
    if (
      skyCanvas !== null &&
      skyCanvas.width > 0 &&
      skyCanvas.height > 0
    ) {
      fctx.drawImage(
        skyCanvas,
        0,
        0,
        skyCanvas.width,
        skyCanvas.height,
        0,
        0,
        w,
        h,
      );
    }
    fctx.drawImage(sceneCanvas, 0, 0);

    const scale = Math.min(1, maxWidth / w);
    const tw = Math.max(1, Math.round(w * scale));
    const th = Math.max(1, Math.round(h * scale));
    const thumb = document.createElement("canvas");
    thumb.width = tw;
    thumb.height = th;
    const tctx = thumb.getContext("2d");
    if (!tctx) {
      return null;
    }
    tctx.imageSmoothingEnabled = true;
    tctx.imageSmoothingQuality = "high";
    tctx.drawImage(full, 0, 0, tw, th);
    try {
      return thumb.toDataURL("image/jpeg", 0.82);
    } catch {
      return null;
    }
  }

  destroy(): void {
    window.removeEventListener("resize", this.onWindowResize);
    document.removeEventListener("fullscreenchange", this.onFullscreenChange);
    document.removeEventListener("webkitfullscreenchange", this.onFullscreenChange);
    if (this.app) {
      this._snowParticles?.destroy();
      this._snowParticles = null;
      this._rainParticles?.destroy();
      this._rainParticles = null;
      this._rainTiling?.destroy();
      this._rainTiling = null;
      this._rainRoot?.destroy({ children: true });
      this._rainRoot = null;
      this._lightingComposer?.destroy();
      this._lightingComposer = null;
      this._bgToneFilter?.destroy();
      this._bgToneFilter = null;
      this._albedoRT?.destroy(true);
      this._albedoRT = null;
      this._bloomMaskRT?.destroy(true);
      this._bloomMaskRT = null;
      this._lastBloomMaskBoundsX = Number.NaN;
      this._lastBloomMaskBoundsY = Number.NaN;
      this._lastBloomMaskBoundsW = Number.NaN;
      this._lastBloomMaskBoundsH = Number.NaN;
      this._skyCssCanvas?.remove();
      this._skyCssCanvas = null;
      this._skyCssCtx = null;
      this._skyStars.length = 0;
      this._skyStarsCw = 0;
      this._skyStarsCh = 0;
      for (const u of this._backgroundBusUnsubs) {
        u();
      }
      this._backgroundBusUnsubs.length = 0;
      this._spriteCloud?.displayRoot.removeFromParent();
      this._spriteCloud?.destroy();
      this._spriteCloud = null;
      this._backgroundLayer?.displayRoot.removeFromParent();
      this._backgroundLayer?.dispose();
      this._backgroundLayer = null;
      this._backgroundWorld = null;
      this.layerSky.removeChildren();
      this.app.stage.removeChildren();
      this.camera.worldRoot.removeChildren();
      this.app.destroy(true);
      this.app = null;
    }
  }

  private syncSizeFromRenderer(videoPrefs?: VideoPrefs): void {
    if (!this.app) {
      return;
    }
    const w = Math.max(1, Math.round(this.app.renderer.width));
    const h = Math.max(1, Math.round(this.app.renderer.height));
    const desiredRes = effectiveRenderResolution(w, h);
    if (Math.abs(this.app.renderer.resolution - desiredRes) > 0.0005) {
      this.app.renderer.resize(w, h, desiredRes);
    }
    const res = this.app.renderer.resolution;
    const videoRenderScale = (videoPrefs ?? getVideoPrefs()).renderScale;
    const rtResolution = res * videoRenderScale;
    const videoScaleChanged = videoRenderScale !== this._lastVideoRenderScale;
    if (videoScaleChanged) {
      this._compositeSyncDirty = true;
    }
    let sizeChanged = false;
    if (
      w !== this.lastScreenW ||
      h !== this.lastScreenH ||
      res !== this._lastRendererRes ||
      videoScaleChanged
    ) {
      sizeChanged = true;
      this.lastScreenW = w;
      this.lastScreenH = h;
      this._lastRendererRes = res;
      this._lastVideoRenderScale = videoRenderScale;
      if (this._skyCssCanvas !== null && (w !== this._skyCssW || h !== this._skyCssH)) {
        this._skyCssCanvas.width = w;
        this._skyCssCanvas.height = h;
        this._skyCssW = w;
        this._skyCssH = h;
      }
      this.camera.setScreenSize(w, h);
      const rtW = Math.max(1, Math.round(w + this._overscanPadPx * 2));
      const rtH = Math.max(1, Math.round(h + this._overscanPadPx * 2));
      this._albedoRT?.resize(rtW, rtH, rtResolution);
      if (this._albedoRT !== null) {
        const aw = Math.max(1, Math.round(this._albedoRT.width));
        const ah = Math.max(1, Math.round(this._albedoRT.height));
        const ar = this._albedoRT.source.resolution;
        this._bloomMaskRT?.resize(aw, ah, ar);
      } else {
        this._bloomMaskRT?.resize(rtW, rtH, rtResolution);
      }
      this._compositeSyncDirty = true;
    }
    this._resizeCloudLayer();
    if (sizeChanged || this._compositeSyncDirty) {
      this.syncCompositeSpriteToAlbedoRt();
      this._compositeSyncDirty = false;
    }
  }

  /**
   * Keep the composite pass sized to the visible viewport while sampling from overscanned RTs.
   */
  private syncCompositeSpriteToAlbedoRt(): void {
    if (this._albedoRT === null || this._lightingComposer === null) {
      return;
    }
    this._lightingComposer.resize(
      Math.max(1, this.lastScreenW),
      Math.max(1, this.lastScreenH),
    );
    this.updateCompositeViewportMapping();
  }

  private renderWorldWithOverscanOffset(target: RenderTexture): void {
    if (this.app === null) {
      return;
    }
    const root = this.camera.worldRoot;
    const baseX = root.x;
    const baseY = root.y;
    root.position.set(baseX + this._overscanPadPx, baseY + this._overscanPadPx);
    try {
      this.app.renderer.render({
        container: root,
        target,
        clear: true,
        clearColor: "rgba(0,0,0,0)",
      });
    } finally {
      root.position.set(baseX, baseY);
    }
  }

  private updateCompositeViewportMapping(): void {
    if (this._lightingComposer === null || this._albedoRT === null) {
      return;
    }
    this._lightingComposer.setCompositeViewportMapping({
      viewWidth: Math.max(1, this.lastScreenW),
      viewHeight: Math.max(1, this.lastScreenH),
      renderWidth: Math.max(1, Math.round(this._albedoRT.width)),
      renderHeight: Math.max(1, Math.round(this._albedoRT.height)),
      overscanPadPx: this._overscanPadPx,
    });
  }

}
