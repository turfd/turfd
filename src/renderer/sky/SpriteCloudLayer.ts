import { Assets, Container, TilingSprite, Texture } from "pixi.js";
import { BLOCK_SIZE, DAY_LENGTH_MS } from "../../core/constants";
import { stratumCoreTextureAssetUrl } from "../../core/textureManifest";
import type { WorldLightingParams } from "../../world/lighting/WorldTime";

type CloudBand = "top" | "mid" | "bottom";

type CloudStripConfig = {
  key: string;
  band: CloudBand;
  speedPxPerSec: number;
  /** Multiplier for drift driven by in-game world clock (higher = nearer / faster). */
  worldScrollMul: number;
  heightRatio: number;
  verticalOffsetRatio: number;
  baseAlpha: number;
  sliceMinRatio: number;
  sliceMaxRatio: number;
};

type RuntimeStrip = {
  readonly config: CloudStripConfig;
  readonly sprite: TilingSprite;
  scrollPixelX: number;
  scrollSubPixelX: number;
  /** Extra tile scroll from wrapped world time (parallax vs wind). */
  worldScrollPx: number;
  worldScrollSubPx: number;
  lightingAlpha: number;
  alphaPhase: number;
};

const DEFAULT = {
  WORLD_HORIZON_COLOUR: 0x42d6d6,
  WORLD_SKY_COLOUR: 0x1469c4,
} as const;

const CLOUD_VISUAL_SCALE = 5;
const CLOUD_ALPHA_DRIFT_AMPLITUDE = 0.055;
const CLOUD_ALPHA_DRIFT_SPEED_HZ = 0.07;
const CLOUD_NIGHT_OPACITY_REDUCTION = 0.68;
/**
 * Clock-driven cloud drift: tuned so a strip with {@link CloudStripConfig.worldScrollMul} of 1
 * scrolls ~64 world blocks (see {@link BLOCK_SIZE} px/block) per 1.5 minutes of world time.
 * That is ~0.71 blocks/s (~2,560 blocks/hour); strips use lower `worldScrollMul` for parallax depth.
 */
const CLOUD_WORLD_SCROLL_PX_PER_MS =
  (64 * BLOCK_SIZE) / (1.5 * 60 * 1000);

const STRIPS: readonly CloudStripConfig[] = [
  {
    key: "topPrimary",
    band: "top",
    speedPxPerSec: 1.65,
    worldScrollMul: 0.26,
    heightRatio: 0.2,
    verticalOffsetRatio: 0,
    baseAlpha: 0.36,
    sliceMinRatio: 0.34,
    sliceMaxRatio: 0.62,
  },
  {
    key: "topSecondary",
    band: "top",
    speedPxPerSec: 2.75,
    worldScrollMul: 0.34,
    heightRatio: 0.17,
    verticalOffsetRatio: 0,
    baseAlpha: 0.24,
    sliceMinRatio: 0.28,
    sliceMaxRatio: 0.54,
  },
  {
    key: "midPrimary",
    band: "mid",
    speedPxPerSec: 5.5,
    worldScrollMul: 0.52,
    heightRatio: 0.15,
    verticalOffsetRatio: -0.01,
    baseAlpha: 0.33,
    sliceMinRatio: 0.28,
    sliceMaxRatio: 0.48,
  },
  {
    key: "bottomPrimary",
    band: "bottom",
    speedPxPerSec: 8.75,
    worldScrollMul: 0.78,
    heightRatio: 0.17,
    verticalOffsetRatio: 0,
    baseAlpha: 0.31,
    sliceMinRatio: 0.3,
    sliceMaxRatio: 0.56,
  },
  {
    key: "bottomSecondary",
    band: "bottom",
    speedPxPerSec: 11.25,
    worldScrollMul: 0.95,
    heightRatio: 0.13,
    verticalOffsetRatio: -0.06,
    baseAlpha: 0.23,
    sliceMinRatio: 0.24,
    sliceMaxRatio: 0.44,
  },
] as const;

const CLOUD_FILE_URLS = import.meta.glob(
  "../../../../public/assets/mods/resource_packs/stratum-core/textures/environment/clouds/**/*.png",
  { eager: true, import: "default", query: "?url" },
) as Record<string, string>;

const CLOUD_FALLBACK_URLS: Record<CloudBand, readonly string[]> = {
  top: [
    stratumCoreTextureAssetUrl("environment/clouds/top/top_01.png"),
    stratumCoreTextureAssetUrl("environment/clouds/top/top_02.png"),
  ],
  mid: [stratumCoreTextureAssetUrl("environment/clouds/mid/mid_01.png")],
  bottom: [
    stratumCoreTextureAssetUrl("environment/clouds/bottom/bottom_01.png"),
    stratumCoreTextureAssetUrl("environment/clouds/bottom/bottom_02.png"),
    stratumCoreTextureAssetUrl("environment/clouds/bottom/bottom_03.png"),
    stratumCoreTextureAssetUrl("environment/clouds/bottom/bottom_04.png"),
  ],
} as const;

const DITHER_4X4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
] as const;

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/** Shortest signed delta on a circle of length `period` (handles wrapped world clocks). */
function shortestWrappedDeltaMs(cur: number, prev: number, period: number): number {
  if (!Number.isFinite(cur) || !Number.isFinite(prev) || period <= 0) {
    return 0;
  }
  let d = cur - prev;
  const half = period * 0.5;
  if (d > half) {
    d -= period;
  } else if (d < -half) {
    d += period;
  }
  return d;
}

function hexToRgb01(hex: number): [number, number, number] {
  return [((hex >> 16) & 0xff) / 255, ((hex >> 8) & 0xff) / 255, (hex & 0xff) / 255];
}

function mix3(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  t: number,
): [number, number, number] {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}

function rgb01ToHex(rgb: readonly [number, number, number]): number {
  const r = Math.round(clamp01(rgb[0]) * 255);
  const g = Math.round(clamp01(rgb[1]) * 255);
  const b = Math.round(clamp01(rgb[2]) * 255);
  return (r << 16) | (g << 8) | b;
}

function rgb01ToHsv(
  rgb: readonly [number, number, number],
): [number, number, number] {
  const r = clamp01(rgb[0]);
  const g = clamp01(rgb[1]);
  const b = clamp01(rgb[2]);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) {
      h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    } else if (max === g) {
      h = ((b - r) / d + 2) / 6;
    } else {
      h = ((r - g) / d + 4) / 6;
    }
  }
  const s = max <= 0 ? 0 : d / max;
  const v = max;
  return [h, s, v];
}

function hsvToRgb01(
  hsv: readonly [number, number, number],
): [number, number, number] {
  const h = ((hsv[0] % 1) + 1) % 1;
  const s = clamp01(hsv[1]);
  const v = clamp01(hsv[2]);
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  switch (i % 6) {
    case 0:
      return [v, t, p];
    case 1:
      return [q, v, p];
    case 2:
      return [p, v, t];
    case 3:
      return [p, q, v];
    case 4:
      return [t, p, v];
    default:
      return [v, p, q];
  }
}

function blendHue(a: number, b: number, t: number): number {
  const aa = ((a % 1) + 1) % 1;
  const bb = ((b % 1) + 1) % 1;
  let d = bb - aa;
  if (d > 0.5) d -= 1;
  if (d < -0.5) d += 1;
  return ((aa + d * clamp01(t)) % 1 + 1) % 1;
}

function pickBandTint(
  band: CloudBand,
  skyTop: readonly [number, number, number],
  skyHorizon: readonly [number, number, number],
  skyBottom: readonly [number, number, number],
): [number, number, number] {
  if (band === "top") {
    return mix3(skyTop, skyHorizon, 0.24);
  }
  if (band === "bottom") {
    return mix3(skyHorizon, skyBottom, 0.44);
  }
  return [skyHorizon[0], skyHorizon[1], skyHorizon[2]];
}

/**
 * Screen-space repeating cloud strips with per-band parallax drift.
 * Sits above the CSS sky canvas and below world/parallax layers.
 */
export class SpriteCloudLayer {
  private readonly _root: Container;
  private readonly _strips: RuntimeStrip[] = [];
  private readonly _ownedTextures: Texture[] = [];
  private _destroyed = false;
  private _inited = false;
  private _lastNowMs = 0;
  /** Previous wrapped world ms for clock-driven cloud drift (game only). */
  private _prevWorldMsForCloudScroll: number | null = null;
  private _screenW = 1;
  private _screenH = 1;
  private _visible = true;
  private _alphaDriftTimeSec = 0;

  readonly displayRoot: Container;

  constructor() {
    this._root = new Container({ label: "spriteCloud" });
    this._root.eventMode = "none";
    this.displayRoot = this._root;
  }

  get visible(): boolean {
    return this._visible;
  }

  set visible(v: boolean) {
    this._visible = v;
    this._root.visible = v;
  }

  async init(): Promise<void> {
    if (this._inited) {
      return;
    }
    this._lastNowMs = performance.now();

    const texturePools = await this.loadTexturePools();

    for (let i = 0; i < STRIPS.length; i++) {
      const config = STRIPS[i]!;
      const tex = this.buildCompositeCloudStripTexture(texturePools[config.band], config);
      const sprite = new TilingSprite({
        texture: tex,
        width: 1,
        height: 1,
        roundPixels: true,
      });
      // Top-band clouds use a mild screen blend so they melt into the sky gradient.
      sprite.blendMode = config.band === "top" ? "screen" : "normal";
      sprite.eventMode = "none";
      this._root.addChild(sprite);
      this._strips.push({
        config,
        sprite,
        scrollPixelX: 0,
        scrollSubPixelX: 0,
        worldScrollPx: 0,
        worldScrollSubPx: 0,
        lightingAlpha: config.baseAlpha,
        alphaPhase: i * 1.41 + config.speedPxPerSec * 0.17,
      });
    }

    this._inited = true;
    this.resize(this._screenW, this._screenH);
    this.applySunnyDefaultPalette();
  }

  private async loadTexturePools(): Promise<Record<CloudBand, Texture[]>> {
    const discovered: Record<CloudBand, string[]> = {
      top: [],
      mid: [],
      bottom: [],
    };
    for (const [path, url] of Object.entries(CLOUD_FILE_URLS)) {
      const p = path.replaceAll("\\", "/");
      if (p.includes("/top/")) {
        discovered.top.push(url);
      } else if (p.includes("/mid/")) {
        discovered.mid.push(url);
      } else if (p.includes("/bottom/")) {
        discovered.bottom.push(url);
      }
    }
    for (const band of ["top", "mid", "bottom"] as const) {
      if (discovered[band].length === 0) {
        discovered[band].push(...CLOUD_FALLBACK_URLS[band]);
      }
    }
    const out: Record<CloudBand, Texture[]> = { top: [], mid: [], bottom: [] };
    for (const band of ["top", "mid", "bottom"] as const) {
      for (const url of discovered[band]) {
        const tex = (await Assets.load<Texture>(url)) ?? Assets.get<Texture>(url);
        if (tex !== undefined && tex.source !== undefined) {
          tex.source.scaleMode = "nearest";
          out[band].push(tex);
        }
      }
      if (out[band].length === 0) {
        throw new Error(`[SpriteCloudLayer] No cloud textures resolved for '${band}'.`);
      }
    }
    return out;
  }

  private buildCompositeCloudStripTexture(pool: Texture[], config: CloudStripConfig): Texture {
    const ordered = shuffleCopy(pool);
    const pieces: {
      img: CanvasImageSource;
      srcW: number;
      srcH: number;
      startX: number;
      sliceW: number;
    }[] = [];
    let outH = 0;
    let outW = 0;
    for (const t of ordered) {
      const img = this.getTextureImage(t);
      if (!img) {
        continue;
      }
      const srcW = Math.max(1, Math.floor(t.source.width));
      const srcH = Math.max(1, Math.floor(t.source.height));
      const rawRatio = randomBetween(config.sliceMinRatio, config.sliceMaxRatio);
      const sliceW = Math.max(24, Math.min(srcW, Math.round(srcW * rawRatio)));
      const maxStart = Math.max(0, srcW - sliceW);
      const startX = maxStart > 0 ? Math.floor(Math.random() * (maxStart + 1)) : 0;
      pieces.push({ img, srcW, srcH, startX, sliceW });
      outH = Math.max(outH, srcH);
      outW += sliceW;
    }
    if (pieces.length === 0 || outW <= 0 || outH <= 0) {
      return pool[0]!;
    }
    const c = document.createElement("canvas");
    c.width = outW;
    c.height = outH;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    if (!ctx) {
      return pool[0]!;
    }
    ctx.imageSmoothingEnabled = false;
    let x = 0;
    for (const piece of pieces) {
      ctx.drawImage(
        piece.img,
        piece.startX,
        0,
        piece.sliceW,
        piece.srcH,
        x,
        0,
        piece.sliceW,
        outH,
      );
      x += piece.sliceW;
    }
    const d = ctx.getImageData(0, 0, outW, outH);
    this.applyDitheredHorizontalCut(d.data, outW, outH);
    ctx.putImageData(d, 0, 0);
    const tex = Texture.from(c);
    tex.source.scaleMode = "nearest";
    this._ownedTextures.push(tex);
    return tex;
  }

  private getTextureImage(base: Texture): CanvasImageSource | null {
    return (
      base.source as unknown as { resource?: { source?: CanvasImageSource } }
    ).resource?.source ?? null;
  }

  private applyDitheredHorizontalCut(
    pixels: Uint8ClampedArray,
    width: number,
    height: number,
  ): void {
    const edgePhase = Math.random() * 1000;
    const featherBase = Math.max(3, Math.round(width * 0.03));
    const featherVar = Math.max(2, Math.round(width * 0.02));
    for (let y = 0; y < height; y++) {
      const wobble = (Math.sin((y + edgePhase) * 0.18) + 1) * 0.5;
      const feather = Math.max(1, featherBase + Math.round(wobble * featherVar));
      for (let x = 0; x < width; x++) {
        const p = (y * width + x) * 4;
        const a = pixels[p + 3];
        if (a === 0) {
          continue;
        }
        const edge = Math.min(x, width - 1 - x);
        if (edge >= feather) {
          continue;
        }
        const t = edge / feather;
        const threshold = (DITHER_4X4[y & 3]![x & 3]! + 0.5) / 16;
        if (t < threshold) {
          pixels[p + 3] = 0;
        }
      }
    }
  }

  resize(w: number, h: number): void {
    if (w <= 0 || h <= 0) {
      return;
    }
    this._screenW = w;
    this._screenH = h;
    for (const strip of this._strips) {
      const targetH = Math.max(
        1,
        Math.round(h * strip.config.heightRatio * CLOUD_VISUAL_SCALE),
      );
      const texW = Math.max(1, strip.sprite.texture.source.width);
      const texH = Math.max(1, strip.sprite.texture.source.height);
      const scale = Math.max(1, Math.round(targetH / texH));
      const snappedH = texH * scale;
      strip.sprite.width = w;
      strip.sprite.height = snappedH;
      strip.sprite.tileScale.set(scale, scale);
      if (strip.config.band === "top") {
        strip.sprite.y = Math.round(h * strip.config.verticalOffsetRatio);
      } else if (strip.config.band === "mid") {
        strip.sprite.y = Math.round((h - snappedH) * 0.5 + h * strip.config.verticalOffsetRatio);
      } else {
        strip.sprite.y = Math.round(
          h - snappedH + h * strip.config.verticalOffsetRatio,
        );
      }
      // Offset each strip to break vertical seam alignment while preserving repeat.
      strip.scrollPixelX = Math.round(
        (texW * 0.37 * (1 + strip.config.speedPxPerSec * 0.05)) % texW,
      );
      strip.scrollSubPixelX = 0;
      strip.sprite.tilePosition.x = strip.scrollPixelX + strip.worldScrollPx;
    }
  }

  /**
   * @param worldTimeMs — Wrapped in-game day clock (same as {@link WorldTime.ms}). When omitted
   *   (e.g. main menu), only wind-driven motion runs.
   */
  updateTime(nowMs: number, worldTimeMs?: number): void {
    if (this._destroyed || !this._inited) {
      return;
    }
    if (this._lastNowMs <= 0) {
      this._lastNowMs = nowMs;
    }
    const dt = Math.max(0, (nowMs - this._lastNowMs) / 1000);
    this._lastNowMs = nowMs;
    this._alphaDriftTimeSec += dt;
    if (!this._root.visible) {
      return;
    }

    let worldDeltaMs = 0;
    if (worldTimeMs !== undefined && Number.isFinite(worldTimeMs)) {
      if (this._prevWorldMsForCloudScroll === null) {
        this._prevWorldMsForCloudScroll = worldTimeMs;
      } else {
        worldDeltaMs = shortestWrappedDeltaMs(
          worldTimeMs,
          this._prevWorldMsForCloudScroll,
          DAY_LENGTH_MS,
        );
        this._prevWorldMsForCloudScroll = worldTimeMs;
      }
    } else {
      this._prevWorldMsForCloudScroll = null;
    }

    for (const strip of this._strips) {
      const advance = strip.scrollSubPixelX + dt * strip.config.speedPxPerSec;
      const stepPx = Math.trunc(advance);
      strip.scrollSubPixelX = advance - stepPx;
      if (stepPx !== 0) {
        strip.scrollPixelX += stepPx;
      }
      if (worldDeltaMs !== 0) {
        const wAdv =
          strip.worldScrollSubPx +
          worldDeltaMs *
            CLOUD_WORLD_SCROLL_PX_PER_MS *
            strip.config.worldScrollMul;
        const wStep = Math.trunc(wAdv);
        strip.worldScrollSubPx = wAdv - wStep;
        strip.worldScrollPx += wStep;
      }
      strip.sprite.tilePosition.x = strip.scrollPixelX + strip.worldScrollPx;
      strip.sprite.alpha = this.composeStripAlpha(strip);
    }
  }

  private composeStripAlpha(strip: RuntimeStrip): number {
    const wave = Math.sin(
      strip.alphaPhase + this._alphaDriftTimeSec * Math.PI * 2 * CLOUD_ALPHA_DRIFT_SPEED_HZ,
    );
    const drift = 1 + CLOUD_ALPHA_DRIFT_AMPLITUDE * wave;
    return clamp01(strip.lightingAlpha * drift);
  }

  applySunnyDefaultPalette(): void {
    this.applyWorldLighting(this.defaultSunnyAsLighting());
  }

  private defaultSunnyAsLighting(): WorldLightingParams {
    return {
      sunDir: [0, -1],
      moonDir: [0, 0],
      sunIntensity: 0.82,
      moonIntensity: 0,
      ambient: 1,
      ambientTint: [1, 1, 1],
      sunTint: [1, 0.98, 0.9],
      sky: {
        top: DEFAULT.WORLD_SKY_COLOUR,
        horizon: DEFAULT.WORLD_HORIZON_COLOUR,
        bottom: 0x1469b0,
      },
      skyLightTint: [1, 1, 1],
    };
  }

  applyWorldLighting(p: WorldLightingParams): void {
    const skyTop = hexToRgb01(p.sky.top);
    const skyHorizon = hexToRgb01(p.sky.horizon);
    const skyBottom = hexToRgb01(p.sky.bottom);
    const skyMid = mix3(skyTop, skyBottom, 0.5);
    const skyMidHsv = rgb01ToHsv(skyMid);
    const litDay = clamp01(0.42 + 0.35 * p.ambient + 0.23 * p.sunIntensity);
    const litNight = 0.5 + 0.5 * clamp01(p.moonIntensity / 0.22);
    const visibility = 0.62 * litDay + 0.38 * litNight;
    const daylight = clamp01(0.55 * p.ambient + 0.45 * p.sunIntensity);
    const nightBlend = 1 - daylight;
    const nightOpacityScale =
      1 - CLOUD_NIGHT_OPACITY_REDUCTION * clamp01(nightBlend);
    const brightenStrength = 0.3 + 0.1 * daylight;
    for (const strip of this._strips) {
      const sampled = pickBandTint(strip.config.band, skyTop, skyHorizon, skyBottom);
      const sampledHsv = rgb01ToHsv(sampled);
      const bandHuePull =
        strip.config.band === "top" ? 0.22 : strip.config.band === "mid" ? 0.34 : 0.46;
      const hue = blendHue(sampledHsv[0], skyMidHsv[0], bandHuePull);
      const sat = clamp01(sampledHsv[1] * (0.9 + 0.25 * skyMidHsv[1]) + 0.06 * skyMidHsv[1]);
      const val = clamp01(sampledHsv[2] * (0.88 + 0.2 * visibility) + 0.08);
      const hueAdjusted = hsvToRgb01([hue, sat, val]);
      // Keep clouds airy, but retain more sky-driven hue response than before.
      const brightened = mix3(hueAdjusted, [1, 1, 1], brightenStrength);
      strip.sprite.tint = rgb01ToHex(brightened);
      strip.lightingAlpha = clamp01(
        strip.config.baseAlpha * (0.68 + 0.76 * visibility) * nightOpacityScale,
      );
      strip.sprite.alpha = this.composeStripAlpha(strip);
    }
  }

  destroy(): void {
    if (this._destroyed) {
      return;
    }
    this._destroyed = true;
    for (const strip of this._strips) {
      strip.sprite.destroy();
    }
    this._strips.length = 0;
    for (const t of this._ownedTextures) {
      t.destroy(true);
    }
    this._ownedTextures.length = 0;
    this._root.destroy({ children: true });
  }
}

function randomBetween(a: number, b: number): number {
  return a + (b - a) * Math.random();
}

function shuffleCopy<T>(arr: readonly T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}
