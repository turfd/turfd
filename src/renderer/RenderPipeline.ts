import {
  Application,
  Container,
  RenderTexture,
} from "pixi.js";
import type { EventBus } from "../core/EventBus";
import { MAX_RENDER_DEVICE_PIXEL_RATIO } from "../core/constants";
import { stratumCoreTextureAssetUrl } from "../core/textureManifest";

import type { World } from "../world/World";
import type { WorldLightingParams } from "../world/lighting/WorldTime";
import { Camera } from "./Camera";
import { LightingComposer } from "./lighting/LightingComposer";

/**
 * Named world layers (instances are created by {@link RenderPipeline}).
 * Z-order is back → front: sky → … → particles.
 */
export interface RenderPipelineLayers {
  readonly layerSky: Container;
  readonly layerTilesBack: Container;
  readonly layerTilesMid: Container;
  readonly layerEntities: Container;
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
const BG_PARALLAX_X = 0.15;
const BG_PARALLAX_Y = 0.48;
const BG_HEIGHT_FRAC = 0.8;
const BG_BASE_DARKNESS = 0.28;
const BG_NIGHT_DARKNESS_EXTRA = 0.36;
/**
 * Night backdrop dim strength (0 = none, ~0.42 ≈ strong). Applied via per-draw {@link CanvasRenderingContext2D.filter}
 * brightness on the scratch buffer — avoids a rectangular overlay on the sky canvas (hard edge at yOffset).
 */
const BG_TERRAIN_NIGHT_EXTRA = 0.42;
const BG_UNDERGROUND_FADE_START = 64;
const BG_UNDERGROUND_FADE_RANGE = 224;

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

  /** Dedicated DOM canvas behind the WebGL canvas — never touched by Pixi. */
  private _skyCssCanvas: HTMLCanvasElement | null = null;
  private _skyCssCtx: CanvasRenderingContext2D | null = null;
  private _skyCssW = 0;
  private _skyCssH = 0;
  private _bgImage: HTMLImageElement | null = null;
  private _bgImageLoaded = false;
  /** Off-DOM buffer: tiles + night multiply; transparent where `bg.png` is transparent so sky shows through. */
  private _bgScratchCanvas: HTMLCanvasElement | null = null;
  private _bgScratchCtx: CanvasRenderingContext2D | null = null;

  private lastScreenW = 0;
  private lastScreenH = 0;

  readonly layerSky: Container;
  readonly layerTilesBack: Container;
  readonly layerTilesMid: Container;
  readonly layerEntities: Container;
  readonly layerForeground: Container;
  readonly layerLightmap: Container;
  readonly layerParticles: Container;

  private _lightingComposer: LightingComposer | null = null;
  private _albedoRT: RenderTexture | null = null;

  private readonly onWindowResize = (): void => {
    this.syncSizeFromRenderer();
  };

  constructor(options: RenderPipelineOptions) {
    this.mount = options.mount;
    this.camera = new Camera();

    this.layerSky = new Container({ label: "layerSky" });
    this.layerTilesBack = new Container({ label: "layerTilesBack" });
    this.layerTilesMid = new Container({ label: "layerTilesMid" });
    this.layerEntities = new Container({ label: "layerEntities" });
    this.layerForeground = new Container({ label: "layerForeground" });
    this.layerLightmap = new Container({ label: "layerLightmap" });
    this.layerParticles = new Container({ label: "layerParticles" });

    this.layerLightmap.visible = true;

    const world = this.camera.worldRoot;
    world.addChild(this.layerTilesBack);
    world.addChild(this.layerTilesMid);
    world.addChild(this.layerEntities);
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

  /** Call after {@link init} with the game World and bus so light events can be handled. */
  initLighting(world: World, bus: EventBus): void {
    if (this.app === null || this._albedoRT === null) {
      throw new Error("RenderPipeline.init() must complete before initLighting()");
    }
    this._lightingComposer = new LightingComposer(world, bus, this.app.stage);
    this._lightingComposer.initComposite(this._albedoRT, this.camera);
    this._lightingComposer.resize(
      Math.max(1, Math.round(this.app.renderer.width)),
      Math.max(1, Math.round(this.app.renderer.height)),
    );
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
    await this.tryLoadBackgroundImage();

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

    this._albedoRT = RenderTexture.create({
      width: application.renderer.width,
      height: application.renderer.height,
      dynamic: true,
    });

    application.stage.addChild(this.camera.worldRoot);

    window.addEventListener("resize", this.onWindowResize);
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
   * Store latest lighting for {@link render}; sky is painted once per frame there.
   */
  updateSky(lighting: WorldLightingParams): void {
    this._lastSkyLighting = lighting;
  }

  /**
   * Paint the sky gradient + celestial bodies on the 2D canvas under Pixi.
   *
   * PERF: Full redraw each rAF; parallax needs camera. Skipping sun/moon when only world time
   * changes would need a camera/lighting hash (not implemented).
   */
  private paintSkyCss(lighting: WorldLightingParams): void {
    const ctx = this._skyCssCtx;
    const cvs = this._skyCssCanvas;
    if (ctx === null || cvs === null) {
      return;
    }
    const dpr = effectiveDevicePixelRatio();
    const cw = Math.max(1, Math.round(this.mount.clientWidth * dpr));
    const ch = Math.max(1, Math.round(this.mount.clientHeight * dpr));
    if (cw !== this._skyCssW || ch !== this._skyCssH) {
      cvs.width = cw;
      cvs.height = ch;
      this._skyCssW = cw;
      this._skyCssH = ch;
    }

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

    this.paintBackgroundTiled(cw, ch, lighting);

    const { sunDir, moonDir, sunIntensity, moonIntensity } = lighting;
    const spread = cw * 0.38;
    const baseY = ch * 0.16;

    let sunAlpha = Math.min(1, sunIntensity / 0.65);
    if (sunAlpha > 0.04) {
      const sx = cw * 0.5 + sunDir[0] * spread;
      const sy = baseY - sunDir[1] * ch * 0.2;
      ctx.beginPath();
      ctx.arc(sx, sy, 16 * dpr, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255,243,176,${sunAlpha})`;
      ctx.fill();
    }

    let moonAlpha = Math.min(1, moonIntensity / 0.22);
    // Avoid both bodies being strongly visible at the same time; fade one out when the other dominates.
    if (sunAlpha > 0.15) {
      moonAlpha *= Math.max(0, 0.6 - sunAlpha);
    }
    if (moonAlpha > 0.15) {
      sunAlpha *= Math.max(0, 0.6 - moonAlpha);
    }
    if (moonAlpha > 0.04) {
      const mx = cw * 0.5 + moonDir[0] * spread;
      const my = baseY - moonDir[1] * ch * 0.2;
      ctx.beginPath();
      ctx.arc(mx, my, 12 * dpr, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(216,220,255,${moonAlpha})`;
      ctx.fill();
    }
  }

  private paintBackgroundTiled(cw: number, ch: number, lighting: WorldLightingParams): void {
    const ctx = this._skyCssCtx;
    const img = this._bgImage;
    if (ctx === null || img === null || !this._bgImageLoaded || img.height <= 0) {
      return;
    }

    const camX = this.camera.getPosition().x;
    const worldRootY = this.camera.worldRoot.y;
    const drawH = Math.max(1, Math.round(ch * BG_HEIGHT_FRAC));
    const drawW = Math.max(1, Math.round((img.width / img.height) * drawH));
    if (drawW <= 0) {
      return;
    }

    // Pixel-snap parallax offset to prevent sub-pixel filtering seams between tiles.
    const offsetX = Math.round(camX * BG_PARALLAX_X);
    const startTile = Math.floor(offsetX / drawW) - 1;
    const endTile = Math.floor((offsetX + cw) / drawW) + 1;
    const prevSmoothing = ctx.imageSmoothingEnabled;
    const zoomY = this.camera.worldRoot.scale.y;
    const worldCenterY = zoomY !== 0 ? (ch * 0.5 - worldRootY) / zoomY : 0;
    // Backdrop is centred at world y=0; follows the player underground but locks in place above.
    const clampedCenterY = Math.max(0, worldCenterY);
    const yOffset = Math.round(
      (ch - drawH) * 0.5 - clampedCenterY * zoomY * BG_PARALLAX_Y,
    );
    const undergroundDepth = Math.max(0, worldCenterY - BG_UNDERGROUND_FADE_START);
    const undergroundFade = clamp01(undergroundDepth / BG_UNDERGROUND_FADE_RANGE);
    const bgAlpha = 1 - undergroundFade;
    if (bgAlpha <= 0.001) {
      return;
    }

    let sctx = this._bgScratchCtx;
    let scvs = this._bgScratchCanvas;
    if (scvs === null || sctx === null) {
      const c = document.createElement("canvas");
      const x = c.getContext("2d", { alpha: true });
      if (x === null) {
        return;
      }
      this._bgScratchCanvas = c;
      this._bgScratchCtx = x;
      scvs = c;
      sctx = x;
    }
    if (scvs.width !== cw || scvs.height !== ch) {
      scvs.width = cw;
      scvs.height = ch;
    }

    const dayFactor = clamp01(lighting.sunIntensity / 0.65);
    const nightTerrainT = smoothstep(0.12, 0.88, 1 - dayFactor);
    const terrainNightStrength = nightTerrainT * BG_TERRAIN_NIGHT_EXTRA;

    sctx.setTransform(1, 0, 0, 1, 0, 0);
    sctx.globalAlpha = 1;
    sctx.globalCompositeOperation = "source-over";
    sctx.clearRect(0, 0, cw, ch);
    sctx.imageSmoothingEnabled = false;
    sctx.globalAlpha = bgAlpha;

    const useCanvasFilter = typeof sctx.filter === "string";
    if (terrainNightStrength > 0.001 && useCanvasFilter) {
      const b = Math.max(
        0.34,
        Math.min(1, 1 - terrainNightStrength * 1.02),
      );
      sctx.filter = `brightness(${b})`;
    }

    for (let tile = startTile; tile <= endTile; tile++) {
      const screenX = tile * drawW - offsetX;
      if ((tile & 1) === 0) {
        sctx.drawImage(img, screenX, yOffset, drawW, drawH);
        continue;
      }
      sctx.save();
      sctx.translate(screenX + drawW, yOffset);
      sctx.scale(-1, 1);
      sctx.drawImage(img, 0, 0, drawW, drawH);
      sctx.restore();
    }

    sctx.filter = "none";
    sctx.globalAlpha = 1;

    if (terrainNightStrength > 0.001 && !useCanvasFilter) {
      const m = Math.round(255 * (1 - terrainNightStrength));
      if (m < 255) {
        sctx.globalCompositeOperation = "multiply";
        sctx.fillStyle = `rgb(${m},${m},${m})`;
        sctx.fillRect(0, 0, cw, ch);
        sctx.globalCompositeOperation = "source-over";
      }
    }

    ctx.globalAlpha = 1;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(scvs, 0, 0);

    // Time-of-day tint: always a bit darker, with stronger darkening at night.
    const moonLift = clamp01(lighting.moonIntensity / 0.22) * 0.15;
    const darkness = clamp01(
      BG_BASE_DARKNESS + (1 - dayFactor) * BG_NIGHT_DARKNESS_EXTRA - moonLift,
    );
    if (darkness > 0.001) {
      ctx.fillStyle = `rgba(0,0,0,${darkness})`;
      ctx.fillRect(0, 0, cw, ch);
    }

    ctx.imageSmoothingEnabled = prevSmoothing;
  }

  private async tryLoadBackgroundImage(): Promise<void> {
    const imageUrl = stratumCoreTextureAssetUrl("bg.png");
    const image = new Image();
    image.decoding = "async";
    image.src = imageUrl;
    try {
      await image.decode();
      this._bgImage = image;
      this._bgImageLoaded = true;
    } catch {
      this._bgImage = null;
      this._bgImageLoaded = false;
    }
  }

  /**
   * Called each frame from the game loop (after fixed updates). Renders the Pixi stage.
   */
  render(_alpha: number): void {
    if (!this.app) {
      return;
    }

    this.syncSizeFromRenderer();
    if (this._lastSkyLighting !== null) {
      this.paintSkyCss(this._lastSkyLighting);
    }

    if (this._albedoRT !== null && this._lightingComposer !== null) {
      this.app.renderer.render({
        container: this.camera.worldRoot,
        target: this._albedoRT,
      });
      this.camera.worldRoot.visible = false;
      this.app.render();
      this.camera.worldRoot.visible = true;
    } else {
      this.app.render();
    }
  }

  /**
   * Capture a wide strip around the camera (multiple viewports stitched horizontally)
   * including sky + background + lit world, and trigger a PNG download.
   *
   * Lighting is recomputed per tile using the last known world lighting parameters so shadows
   * stay consistent with what the game was rendering.
   */
  takeScreenshot(): void {
    if (!this.app) {
      return;
    }

    const skyCanvas = this._skyCssCanvas;
    const renderer = this.app.renderer;
    const cam = this.camera;

    if (this._lastSkyLighting === null) {
      // No lighting params yet (e.g. very early in boot); fall back to a single-frame capture.
      this.app.render();
      const sceneCanvas = this.app.canvas;
      if (!sceneCanvas) {
        return;
      }
      const width = sceneCanvas.width;
      const height = sceneCanvas.height;
      if (width === 0 || height === 0) {
        return;
      }
      const outSingle = document.createElement("canvas");
      outSingle.width = width;
      outSingle.height = height;
      const ctxSingle = outSingle.getContext("2d");
      if (!ctxSingle) {
        return;
      }
      if (skyCanvas && skyCanvas.width > 0 && skyCanvas.height > 0) {
        ctxSingle.drawImage(skyCanvas, 0, 0, width, height);
      }
      ctxSingle.drawImage(sceneCanvas, 0, 0, width, height);
      const nowSingle = new Date();
      const tsSingle = `${nowSingle.getFullYear()}-${String(
        nowSingle.getMonth() + 1,
      ).padStart(2, "0")}-${String(nowSingle.getDate()).padStart(2, "0")}_${String(
        nowSingle.getHours(),
      ).padStart(2, "0")}-${String(nowSingle.getMinutes()).padStart(
        2,
        "0",
      )}-${String(nowSingle.getSeconds()).padStart(2, "0")}`;
      outSingle.toBlob((blob) => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `stratum_${tsSingle}.png`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, "image/png");
      return;
    }

    // Read current camera state so we can restore it after stitching.
    const origPos = cam.getPosition();
    const origTarget = cam.getTarget();

    // Ensure renderer dimensions are up to date.
    this.syncSizeFromRenderer();
    const baseCanvas = this.app.canvas;
    if (!baseCanvas) {
      return;
    }
    const baseWidth = baseCanvas.width;
    const baseHeight = baseCanvas.height;
    if (baseWidth === 0 || baseHeight === 0) {
      return;
    }

    // How many viewports to stitch horizontally. 4x gives a wide world slice without huge textures.
    const tilesX = 4;
    const tilesY = 1;

    const out = document.createElement("canvas");
    out.width = baseWidth * tilesX;
    out.height = baseHeight * tilesY;
    const ctx = out.getContext("2d");
    if (!ctx) {
      return;
    }

    const zoom = cam.getZoom();
    const viewWorldW = baseWidth / zoom;
    const viewWorldH = baseHeight / zoom;

    const centerX = origPos.x;
    const centerY = origPos.y;
    const xStart = -((tilesX - 1) / 2);
    const yStart = -((tilesY - 1) / 2);

    for (let ty = 0; ty < tilesY; ty++) {
      for (let tx = 0; tx < tilesX; tx++) {
        const offsetX = (xStart + tx) * viewWorldW;
        const offsetY = (yStart + ty) * viewWorldH;

        cam.setPositionImmediate(centerX + offsetX, centerY + offsetY);

        if (this._albedoRT !== null && this._lightingComposer !== null) {
          // Recompute lighting for this camera position so shadows line up with terrain.
          const pos = cam.getPosition();
          this._lightingComposer.update(
            this._lastSkyLighting,
            pos.x,
            pos.y,
            null,
          );
          renderer.render({
            container: cam.worldRoot,
            target: this._albedoRT,
          });
          cam.worldRoot.visible = false;
          this.app.render();
          cam.worldRoot.visible = true;
        } else {
          this.app.render();
        }

        const sceneCanvas = this.app.canvas;
        if (!sceneCanvas) {
          continue;
        }

        const dstX = tx * baseWidth;
        const dstY = ty * baseHeight;

        // Draw CSS sky/background first (if available), then the lit scene on top.
        if (skyCanvas && skyCanvas.width > 0 && skyCanvas.height > 0) {
          ctx.drawImage(skyCanvas, 0, 0, skyCanvas.width, skyCanvas.height, dstX, dstY, baseWidth, baseHeight);
        }
        ctx.drawImage(sceneCanvas, 0, 0, baseWidth, baseHeight, dstX, dstY, baseWidth, baseHeight);
      }
    }

    // Restore original camera state.
    cam.setPositionImmediate(origPos.x, origPos.y);
    cam.setTarget(origTarget.x, origTarget.y);

    const now = new Date();
    const ts = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}_${String(now.getHours()).padStart(2, "0")}-${String(now.getMinutes()).padStart(2, "0")}-${String(now.getSeconds()).padStart(2, "0")}`;

    out.toBlob((blob) => {
      if (!blob) {
        return;
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `stratum_${ts}.png`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, "image/png");
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
    if (this.app) {
      this._lightingComposer?.destroy();
      this._lightingComposer = null;
      this._albedoRT?.destroy(true);
      this._albedoRT = null;
      this._skyCssCanvas?.remove();
      this._skyCssCanvas = null;
      this._skyCssCtx = null;
      this._bgScratchCanvas = null;
      this._bgScratchCtx = null;
      this._bgImage = null;
      this._bgImageLoaded = false;
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
    if (w !== this.lastScreenW || h !== this.lastScreenH) {
      this.lastScreenW = w;
      this.lastScreenH = h;
      this.camera.setScreenSize(w, h);
      this._albedoRT?.resize(w, h);
      this._lightingComposer?.resize(w, h);
    }
  }
}
