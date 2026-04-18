import {
  Application,
  Assets,
  Container,
  Culler,
  RenderTexture,
  TilingSprite,
  type Texture,
} from "pixi.js";
import type { EventBus } from "../core/EventBus";
import {
  BACKGROUND_PARALLAX_X,
  BLOCK_SIZE,
  BLOOM_CAMERA_MOVE_THRESHOLD_TILES,
  DAY_LENGTH_MS,
  MAX_RENDER_DEVICE_PIXEL_RATIO,
} from "../core/constants";
import { chunkPerfLog, chunkPerfNow } from "../debug/chunkPerf";
import { stratumCoreTextureAssetUrl } from "../core/textureManifest";

import type { World } from "../world/World";
import type { WorldLightingParams } from "../world/lighting/WorldTime";
import type { AtlasLoader } from "./AtlasLoader";
import { BackgroundLayerRenderer } from "./BackgroundLayerRenderer";
import { Camera } from "./Camera";
import { LightingComposer } from "./lighting/LightingComposer";
import {
  ScreenSpaceNormalPass,
  type ScreenSpaceNormalParams,
} from "./lighting/ScreenSpaceNormalPass";
import { TonemapFilter } from "./lighting/TonemapFilter";
import { getVideoPrefs } from "../ui/settings/videoPrefs";
import { WeatherRainParticles } from "./WeatherRainParticles";
import { WeatherSnowParticles } from "./WeatherSnowParticles";

/**
 * Named world layers (instances are created by {@link RenderPipeline}).
 * Z-order is back → front: sky → … → particles.
 * {@link layerWaterOverEntities} draws water after mobs so submerged areas occlude sprites.
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

function lerpColor(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 0xff;
  const ag = (a >> 8) & 0xff;
  const ab = a & 0xff;
  const br = (b >> 16) & 0xff;
  const bg = (b >> 8) & 0xff;
  const bb = b & 0xff;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return (r << 16) | (g << 8) | bl;
}

const SKY_WHITE = 0xffffff;
const SKY_PAINT_CLOCK_BUCKET_MS = 100;

function clamp01(t: number): number {
  return Math.min(1, Math.max(0, t));
}

function effectiveDevicePixelRatio(): number {
  const dpr = window.devicePixelRatio >= 1 ? window.devicePixelRatio : 1;
  return Math.min(dpr, MAX_RENDER_DEVICE_PIXEL_RATIO);
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
  s: 2 | 3;
  /** Base opacity before time-of-day curve */
  a: number;
  rgb: [number, number, number];
};

/**
 * Pixi application, camera, and ordered world layers. Drives `app.render()` from the game loop.
 *
 * Sky is drawn on a separate 2D canvas inserted **before** the WebGL canvas in the mount so it
 * sits underneath Pixi while tiles/entities/lighting still composite in the usual Pixi order.
 * This avoids GPU texture-upload flicker from putting the gradient in the Pixi scene graph.
 */
export class RenderPipeline implements RenderPipelineLayers {
  private readonly mount: HTMLElement;
  private app: Application | null = null;
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
  private _screenSpaceNormalPass: ScreenSpaceNormalPass | null = null;
  private _albedoRT: RenderTexture | null = null;
  /** Terrain + water + foreground tiles only (no entities/lightmap/particles/weather) for screen-space normals. */
  /** Screen-space alpha mask of the local player; occludes torch bloom in {@link CompositePass}. */
  private _bloomMaskRT: RenderTexture | null = null;
  private _bloomMaskPlayerRoot: Container | null = null;
  private readonly _emptyMaskClearRoot = new Container();
  private _bgToneFilter: TonemapFilter | null = null;

  /** When false, {@link renderBloomMask} skips GPU work until something marks the mask stale. */
  private _bloomDirty = true;
  private _lastBloomCameraTileX = Number.NaN;
  private _lastBloomCameraTileY = Number.NaN;
  private _lastBloomSkyClockBucket = -1;
  private _lastBloomLightningForBloom = -999;

  private _backgroundLayer: BackgroundLayerRenderer | null = null;
  private _backgroundWorld: World | null = null;
  private readonly _backgroundBusUnsubs: (() => void)[] = [];

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

    // So local player zIndex can sort above mobs (e.g. zIndex -2) and match bloom mask vs albedo.
    this.layerEntities.sortableChildren = true;

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

    this._backgroundBusUnsubs.push(
      bus.on("game:block-changed", (e) => {
        if (this.blockCellOverlapsCameraView(e.wx, e.wy)) {
          this._bloomDirty = true;
        }
      }),
    );

    this._lightingComposer = new LightingComposer(world, bus, this.app.stage);
    if (this._bloomMaskRT === null) {
      throw new Error("RenderPipeline.init() must create bloom mask RT before initLighting()");
    }
    this._screenSpaceNormalPass = new ScreenSpaceNormalPass(this.app.renderer);
    this._screenSpaceNormalPass.resize(
      Math.max(1, Math.round(this.app.renderer.width)),
      Math.max(1, Math.round(this.app.renderer.height)),
      this.app.renderer.resolution,
    );
    this._lightingComposer.initComposite(
      this._albedoRT,
      this.camera,
      this._bloomMaskRT.source,
      this._screenSpaceNormalPass.output,
    );
    this._lightingComposer.resize(
      Math.max(1, Math.round(this.app.renderer.width)),
      Math.max(1, Math.round(this.app.renderer.height)),
    );
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

  async init(): Promise<void> {
    if (this.app) {
      return;
    }

    const application = new Application();
    await application.init({
      autoStart: false,
      resizeTo: this.mount,
      antialias: false,
      preference: "webgl",
      powerPreference: "high-performance",
      backgroundAlpha: 0,
      resolution: effectiveDevicePixelRatio(),
      autoDensity: true,
    });

    this.app = application;

    const skyCanvas = document.createElement("canvas");
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
    this._albedoRT = RenderTexture.create({
      width: application.renderer.width,
      height: application.renderer.height,
      resolution: rtRes,
      dynamic: true,
    });
    // Nearest when sampled in {@link CompositePass}: avoids bilinear pulling wrong neighbors at
    // framebuffer edges (looks like a 1px normal shift when a block edge sits on-screen).
    this._albedoRT.source.scaleMode = "nearest";
    this._bloomMaskRT = RenderTexture.create({
      width: application.renderer.width,
      height: application.renderer.height,
      resolution: rtRes,
      dynamic: true,
    });
    this._bloomMaskRT.source.scaleMode = "nearest";

    application.stage.addChild(this.camera.worldRoot);

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
    const clockBucket = Math.floor(worldTimeMs / SKY_PAINT_CLOCK_BUCKET_MS);
    const li = extras?.lightningAlpha ?? 0;
    if (
      clockBucket !== this._lastBloomSkyClockBucket ||
      li !== this._lastBloomLightningForBloom
    ) {
      this._bloomDirty = true;
      this._lastBloomSkyClockBucket = clockBucket;
      this._lastBloomLightningForBloom = li;
    }
    if (worldTimeMs !== this._lastBackgroundLightingMs) {
      this._backgroundLayer?.applyWorldLighting(lighting);
      this._lastBackgroundLightingMs = worldTimeMs;
    }
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
      (await loadNearestTexture("weather/snow.png")) ?? null;
    if (snowParticleTexture !== null) {
      this._snowParticles = new WeatherSnowParticles(
        this.layerParticles,
        snowParticleTexture,
      );
    } else {
      console.warn("[RenderPipeline] Snow particle texture failed to load.");
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
      let s: 2 | 3 = 2;
      if (big && x <= cw - 3 && y <= upperH - 3) {
        s = 3;
      } else {
        x = Math.min(x, cw - 1);
        y = Math.min(y, upperH - 1);
      }
      const a = (s === 3 ? 0.16 : 0.07) + rand() * (s === 3 ? 0.32 : 0.26);
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

    const midHigh = lerpColor(top, horizon, 0.35);
    const midLow = lerpColor(horizon, bottom, 0.45);

    /**
     * Day-only horizon brightening (Minecraft-style). Must stay off while sun/ambient are still
     * low or it lerps dawn/dusk palette stops toward white and reads as muddy, desaturated twilight.
     * (Sky palette keys in WorldTime stay unchanged; this only gates the extra paint pass.)
     */
    const hazeSun = smoothstep(0.34, 0.72, lighting.sunIntensity);
    const hazeAmb = smoothstep(0.44, 0.82, lighting.ambient);
    const haze = hazeSun * hazeAmb;
    const towardWhite = (c: number, amount: number): number =>
      lerpColor(c, SKY_WHITE, amount * haze);

    const grd = ctx.createLinearGradient(0, 0, 0, ch);
    grd.addColorStop(0, hexToCss(top));
    grd.addColorStop(0.14, hexToCss(lerpColor(top, midHigh, 0.55)));
    grd.addColorStop(0.30, hexToCss(midHigh));
    grd.addColorStop(0.44, hexToCss(towardWhite(midHigh, 0.14)));
    grd.addColorStop(0.52, hexToCss(towardWhite(horizon, 0.36)));
    grd.addColorStop(0.58, hexToCss(towardWhite(horizon, 0.58)));
    grd.addColorStop(0.65, hexToCss(towardWhite(horizon, 0.4)));
    grd.addColorStop(0.75, hexToCss(towardWhite(midLow, 0.22)));
    grd.addColorStop(0.88, hexToCss(midLow));
    grd.addColorStop(1, hexToCss(bottom));
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, cw, ch);

    this.ensureSkyStarField(cw, ch);
    this.drawSkyStars(ctx, lighting);

    const { sunDir, moonDir, sunIntensity, moonIntensity } = lighting;
    const spread = cw * 0.38;
    const baseY = ch * 0.16;

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
    const sy = baseY - sunDir[1] * ch * 0.2;
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
    const my = baseY - moonDir[1] * ch * 0.2;
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

  /** World block cell (wx, wy) overlaps the current camera view frustum in world pixel space. */
  private blockCellOverlapsCameraView(wx: number, wy: number): boolean {
    if (this.app === null) {
      return false;
    }
    const w = this.app.renderer.screen.width;
    const h = this.app.renderer.screen.height;
    const tl = this.camera.screenToWorld(0, 0);
    const br = this.camera.screenToWorld(w, h);
    const minVx = Math.min(tl.x, br.x);
    const maxVx = Math.max(tl.x, br.x);
    const minVy = Math.min(tl.y, br.y);
    const maxVy = Math.max(tl.y, br.y);
    const x0 = wx * BLOCK_SIZE;
    const x1 = (wx + 1) * BLOCK_SIZE;
    const y0 = wy * BLOCK_SIZE;
    const y1 = (wy + 1) * BLOCK_SIZE;
    return !(x1 < minVx || x0 > maxVx || y1 < minVy || y0 > maxVy);
  }

  private updateBloomDirtyFromCamera(): void {
    const pos = this.camera.getPosition();
    const tx = pos.x / BLOCK_SIZE;
    const ty = pos.y / BLOCK_SIZE;
    if (
      !Number.isFinite(this._lastBloomCameraTileX) ||
      !Number.isFinite(this._lastBloomCameraTileY) ||
      Math.abs(tx - this._lastBloomCameraTileX) > BLOOM_CAMERA_MOVE_THRESHOLD_TILES ||
      Math.abs(ty - this._lastBloomCameraTileY) > BLOOM_CAMERA_MOVE_THRESHOLD_TILES
    ) {
      this._bloomDirty = true;
    }
    this._lastBloomCameraTileX = tx;
    this._lastBloomCameraTileY = ty;
  }

  /** Renders local player silhouette into {@link _bloomMaskRT} for composite bloom occlusion. */
  private renderBloomMask(): void {
    const vp = getVideoPrefs();
    if (!vp.bloom) {
      return;
    }
    if (!this._bloomDirty) {
      return;
    }
    const app = this.app;
    const maskRt = this._bloomMaskRT;
    const playerRoot = this._bloomMaskPlayerRoot;
    if (app === null || maskRt === null) {
      return;
    }
    const wr = this.camera.worldRoot;
    const le = this.layerEntities;

    if (playerRoot !== null && playerRoot.parent === le) {
      const worldVis: { n: Container; v: boolean }[] = [];
      for (const c of wr.children) {
        worldVis.push({ n: c, v: c.visible });
        c.visible = c === le;
      }
      const entVis: { n: Container; v: boolean }[] = [];
      for (const c of le.children) {
        entVis.push({ n: c, v: c.visible });
        c.visible = c === playerRoot;
      }
      app.renderer.render({
        container: wr,
        target: maskRt,
        clear: true,
        clearColor: "rgba(0,0,0,0)",
      });
      for (const { n, v } of entVis) {
        n.visible = v;
      }
      for (const { n, v } of worldVis) {
        n.visible = v;
      }
    } else {
      app.renderer.render({
        container: this._emptyMaskClearRoot,
        target: maskRt,
        clear: true,
        clearColor: "rgba(0,0,0,0)",
      });
    }
    this._bloomDirty = false;
  }

  /**
   * Called each frame from the game loop (after fixed updates). Renders the Pixi stage.
   */
  render(_alpha: number): void {
    if (!this.app) {
      return;
    }

    this.syncSizeFromRenderer();
    this._backgroundLayer?.updateParallax(
      this.camera.getPosition().x,
      BACKGROUND_PARALLAX_X,
    );
    this.maybePaintSkyCss();

    if (this._bgToneFilter !== null) {
      const vp = getVideoPrefs();
      const tm = vp.tonemapper;
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
        Math.abs(cameraPos.x - this._lastCullCameraX) >= 4 ||
        Math.abs(cameraPos.y - this._lastCullCameraY) >= 4 ||
        screen.width !== this._lastCullScreenW ||
        screen.height !== this._lastCullScreenH;
      if (shouldCull) {
        const tCull = import.meta.env.DEV ? chunkPerfNow() : 0;
        Culler.shared.cull(this.camera.worldRoot, screen, true);
        this._lastCullCameraX = cameraPos.x;
        this._lastCullCameraY = cameraPos.y;
        this._lastCullScreenW = screen.width;
        this._lastCullScreenH = screen.height;
        if (import.meta.env.DEV) {
          chunkPerfLog("renderPipeline:cull", chunkPerfNow() - tCull);
        }
      }
      this.app.renderer.render({
        container: this.camera.worldRoot,
        target: this._albedoRT,
        clear: true,
        clearColor: "rgba(0,0,0,0)",
      });
      const vp = getVideoPrefs();
      const sn = this._screenSpaceNormalPass;
      if (sn !== null && this._albedoRT !== null && vp.screenSpaceNormals) {
        const p: ScreenSpaceNormalParams = {
          bevel: vp.ssnBevel,
          strength: vp.ssnHeightStrength,
          smooth: vp.ssnSmoothness,
          detail: vp.ssnDetailWeight,
          invertX: vp.ssnInvertX,
          invertY: vp.ssnInvertY,
        };
        // Same RT the composite samples — avoids two-pass drift when the camera moves (terrain-only
        // RT was a second render and could diverge slightly from this buffer).
        sn.update(this._albedoRT, p);
      }
      this.updateBloomDirtyFromCamera();
      if (vp.bloom) {
        this.renderBloomMask();
      }
      try {
        this.camera.worldRoot.visible = false;
        this.app.render();
      } finally {
        this.camera.worldRoot.visible = true;
      }
    } else {
      this.app.render();
    }
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
      this._screenSpaceNormalPass?.destroy();
      this._screenSpaceNormalPass = null;
      this._lightingComposer?.destroy();
      this._lightingComposer = null;
      this._bgToneFilter?.destroy();
      this._bgToneFilter = null;
      this._albedoRT?.destroy(true);
      this._albedoRT = null;
      this._bloomMaskRT?.destroy(true);
      this._bloomMaskRT = null;
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

  private syncSizeFromRenderer(): void {
    if (!this.app) {
      return;
    }
    const w = Math.max(1, Math.round(this.app.renderer.width));
    const h = Math.max(1, Math.round(this.app.renderer.height));
    const res = this.app.renderer.resolution;
    if (
      w !== this.lastScreenW ||
      h !== this.lastScreenH ||
      res !== this._lastRendererRes
    ) {
      this.lastScreenW = w;
      this.lastScreenH = h;
      this._lastRendererRes = res;
      if (this._skyCssCanvas !== null && (w !== this._skyCssW || h !== this._skyCssH)) {
        this._skyCssCanvas.width = w;
        this._skyCssCanvas.height = h;
        this._skyCssW = w;
        this._skyCssH = h;
      }
      this.camera.setScreenSize(w, h);
      this._albedoRT?.resize(w, h, res);
      if (this._albedoRT !== null) {
        const aw = Math.max(1, Math.round(this._albedoRT.width));
        const ah = Math.max(1, Math.round(this._albedoRT.height));
        const ar = this._albedoRT.source.resolution;
        this._bloomMaskRT?.resize(aw, ah, ar);
        this._screenSpaceNormalPass?.resize(aw, ah, ar);
      } else {
        this._bloomMaskRT?.resize(w, h, res);
        this._screenSpaceNormalPass?.resize(w, h, res);
      }
    }
    this.syncCompositeSpriteToAlbedoRt();
  }

  /**
   * Keep the lighting composite quad exactly the size of the albedo RT every frame.
   * After fullscreen / DPR changes, renderer-reported size and filter sprite size can briefly
   * diverge, which stretches the albedo vs the normal map (different texture bindings).
   */
  private syncCompositeSpriteToAlbedoRt(): void {
    if (this._albedoRT === null || this._lightingComposer === null) {
      return;
    }
    const rt = this._albedoRT;
    this._lightingComposer.resize(
      Math.max(1, Math.round(rt.width)),
      Math.max(1, Math.round(rt.height)),
    );
  }
}
