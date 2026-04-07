/**
 * Shelf-packs named PNGs into one GPU texture for batched meshes/sprites.
 * Block terrain uses {@link BLOCK_TEXTURE_MANIFEST_PATH}; item entities use a record
 * resolved from block + item manifests (see {@link resolveItemTextureRecord}).
 *
 * Optional `_alt_N` files beside each base PNG are discovered automatically (HEAD probe `_alt_1`… until miss).
 */
import { Rectangle, Texture, TextureSource } from "pixi.js";
import { BLOCK_SIZE } from "../core/constants";
import type { TextureManifestJson } from "../core/textureManifest";
import { BLOCK_TEXTURE_MANIFEST_PATH } from "../core/textureManifest";
import { resolveTextureMapKey } from "../core/textureKeyResolve";

const MAX_PACK_DIMENSION = 4096;

function publicAssetUrl(relativePath: string): string {
  const base = import.meta.env.BASE_URL;
  const path = relativePath.replace(/^\/+/, "");
  return `${base}${path}`;
}

function loadImageElement(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load image: ${url}`));
    img.src = url;
  });
}

/**
 * For every base manifest key (not already `*_alt_N`): discover optional `name_alt_1.png`, `name_alt_2.png`, …
 * beside the base file. Uses HEAD + image Content-Type check; stops at first miss per base.
 */
async function discoverAltVariants(raw: Record<string, string>): Promise<Record<string, string>> {
  const expanded: Record<string, string> = { ...raw };

  const probes: Promise<void>[] = [];
  for (const [name, path] of Object.entries(raw)) {
    if (/_alt_\d+$/.test(name)) continue;
    const dotIdx = path.lastIndexOf(".");
    const basePath = dotIdx >= 0 ? path.slice(0, dotIdx) : path;
    const ext = dotIdx >= 0 ? path.slice(dotIdx) : ".png";

    probes.push(
      (async () => {
        for (let i = 1; i <= 16; i++) {
          const altName = `${name}_alt_${i}`;
          if (altName in expanded) continue;
          const altPath = `${basePath}_alt_${i}${ext}`;
          try {
            const res = await fetch(publicAssetUrl(altPath), {
              method: "HEAD",
            });
            if (!res.ok) break;
            const ct = (res.headers.get("content-type") ?? "").toLowerCase();
            if (ct.length > 0 && !ct.startsWith("image/")) break;
            expanded[altName] = altPath;
          } catch {
            break;
          }
        }
      })(),
    );
  }

  await Promise.all(probes);
  return expanded;
}

type PackedEntry = {
  readonly name: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
};

/** One packed rect, optionally cropped from a larger spritesheet image. */
type PackSlice = {
  readonly name: string;
  readonly w: number;
  readonly h: number;
  readonly img: HTMLImageElement;
  readonly sx: number;
  readonly sy: number;
};

/**
 * Horizontal or vertical strips of `BLOCK_SIZE` square frames (e.g. `furnace_on.png`).
 */
function expandStripSlicesIfNeeded(
  manifestName: string,
  img: HTMLImageElement,
): PackSlice[] {
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  if (manifestName !== "furnace_on" || w < 1 || h < 1) {
    return [{ name: manifestName, w, h, img, sx: 0, sy: 0 }];
  }
  if (h === BLOCK_SIZE && w > h && w % h === 0) {
    const n = w / h;
    const out: PackSlice[] = [];
    for (let i = 0; i < n; i++) {
      out.push({
        name: `furnace_on_${i}`,
        w: BLOCK_SIZE,
        h: BLOCK_SIZE,
        img,
        sx: i * BLOCK_SIZE,
        sy: 0,
      });
    }
    return out;
  }
  if (w === BLOCK_SIZE && h > w && h % w === 0) {
    const n = h / w;
    const out: PackSlice[] = [];
    for (let i = 0; i < n; i++) {
      out.push({
        name: `furnace_on_${i}`,
        w: BLOCK_SIZE,
        h: BLOCK_SIZE,
        img,
        sx: 0,
        sy: i * BLOCK_SIZE,
      });
    }
    return out;
  }
  return [{ name: manifestName, w, h, img, sx: 0, sy: 0 }];
}

const HSL_SAMPLE_ALPHA_MIN = 10;
const HSL_MIN_SAT_FOR_VECTOR = 0.12;

function rgbToHsl01(r: number, g: number, b: number): { h: number; s: number; l: number } {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) {
    return { h: 0, s: 0, l };
  }
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  switch (max) {
    case r:
      h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
      break;
    case g:
      h = ((b - r) / d + 2) / 6;
      break;
    default:
      h = ((r - g) / d + 4) / 6;
  }
  return { h, s, l };
}

function hueDegreesFromHsl01(h: number): number {
  return ((h % 1) + 1) % 1 * 360;
}

function shelfPack(
  sizes: ReadonlyArray<{ name: string; w: number; h: number }>,
): { width: number; height: number; placements: PackedEntry[] } {
  const sorted = [...sizes].sort((a, b) => b.h - a.h || a.name.localeCompare(b.name));
  let x = 0;
  let y = 0;
  let rowH = 0;
  let packW = 0;
  let packH = 0;
  const placements: PackedEntry[] = [];

  for (const s of sorted) {
    if (x + s.w > MAX_PACK_DIMENSION) {
      x = 0;
      y += rowH;
      rowH = 0;
    }
    if (y + s.h > MAX_PACK_DIMENSION) {
      throw new Error(
        `Texture pack exceeds ${MAX_PACK_DIMENSION}px height; reduce tile count or max size`,
      );
    }
    placements.push({ name: s.name, x, y, w: s.w, h: s.h });
    rowH = Math.max(rowH, s.h);
    packW = Math.max(packW, x + s.w);
    packH = Math.max(packH, y + s.h);
    x += s.w;
  }

  return { width: packW, height: packH, placements };
}

export class AtlasLoader {
  private readonly textureMap = new Map<string, Texture>();
  private readonly variantCache = new Map<string, readonly Texture[]>();
  private atlasTexture: Texture | null = null;
  private packedSource: TextureSource | null = null;
  /** Retained for workshop patches; cleared in {@link destroyPacked}. */
  private atlasCanvas: HTMLCanvasElement | null = null;
  private lastPlacements: PackedEntry[] = [];

  constructor(
    private readonly manifestRelativePath: string = BLOCK_TEXTURE_MANIFEST_PATH,
  ) {}

  /** Load a single manifest JSON (`block_texture_manifest.json` or `item_texture_manifest.json`). */
  async load(): Promise<void> {
    const jsonUrl = publicAssetUrl(this.manifestRelativePath);
    const res = await fetch(jsonUrl);
    if (!res.ok) {
      throw new Error(`Texture manifest failed to load: ${jsonUrl} (${res.status})`);
    }
    const manifest = (await res.json()) as TextureManifestJson;
    const raw = manifest.textures;
    if (raw === null || typeof raw !== "object") {
      throw new Error(`${this.manifestRelativePath}: "textures" must be an object`);
    }
    const expanded = await discoverAltVariants(raw);
    await this.packTextures(expanded, this.manifestRelativePath);
  }

  /**
   * Pack an explicit name → relative PNG map (used for the item atlas after resolving
   * paths from both manifests).
   */
  async loadFromTextureRecord(
    textures: Record<string, string>,
    debugLabel = "item textures",
  ): Promise<void> {
    if (textures === null || typeof textures !== "object") {
      throw new Error(`${debugLabel}: invalid texture record`);
    }
    await this.packTextures(textures, debugLabel);
  }

  private async packTextures(
    raw: Record<string, string>,
    errContext: string,
  ): Promise<void> {
    const names = Object.keys(raw).sort((a, b) => a.localeCompare(b));
    const slices: PackSlice[] = [];
    const images = new Map<string, HTMLImageElement>();

    for (const name of names) {
      const rel = raw[name];
      if (typeof rel !== "string" || rel.length === 0) {
        throw new Error(`${errContext}: invalid path for "${name}"`);
      }
      const url = publicAssetUrl(rel);
      const img = await loadImageElement(url);
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      if (w < 1 || h < 1) {
        throw new Error(`Invalid image dimensions for "${name}" (${url})`);
      }
      images.set(name, img);
      slices.push(...expandStripSlicesIfNeeded(name, img));
    }

    const packSizes = slices.map((s) => ({ name: s.name, w: s.w, h: s.h }));
    const { width, height, placements } = shelfPack(packSizes);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (ctx === null) {
      throw new Error("Canvas 2D context unavailable for texture pack");
    }
    ctx.imageSmoothingEnabled = false;

    const byName = new Map(placements.map((p) => [p.name, p]));
    for (const s of slices) {
      const p = byName.get(s.name);
      if (p === undefined) {
        continue;
      }
      ctx.drawImage(s.img, s.sx, s.sy, s.w, s.h, p.x, p.y, p.w, p.h);
    }

    this.destroyPacked();

    const source = TextureSource.from(canvas);
    source.scaleMode = "nearest";
    this.packedSource = source;

    this.textureMap.clear();
    for (const p of placements) {
      const sub = new Texture({
        source,
        frame: new Rectangle(p.x, p.y, p.w, p.h),
      });
      sub.source.scaleMode = "nearest";
      this.textureMap.set(p.name, sub);
    }

    this.atlasTexture?.destroy(false);
    this.atlasTexture = new Texture({ source });
    this.atlasTexture.source.scaleMode = "nearest";

    this.atlasCanvas = canvas;
    this.lastPlacements = placements.slice();

    this.buildVariantMap();
  }

  /**
   * Adds rectangular regions from a decoded spritesheet PNG (workshop mods). Skips frame names
   * that already exist in the atlas (additive only).
   */
  async appendWorkshopSpritesheet(
    imageBytes: Uint8Array,
    rects: readonly {
      name: string;
      sx: number;
      sy: number;
      sw: number;
      sh: number;
    }[],
  ): Promise<void> {
    if (this.atlasCanvas === null || this.packedSource === null) {
      throw new Error("AtlasLoader.load() must complete before appendWorkshopSpritesheet()");
    }
    const toAdd = rects.filter((r) => !this.textureMap.has(r.name));
    if (toAdd.length === 0) {
      return;
    }
    const blob = new Blob([imageBytes], { type: "image/png" });
    const bmp = await createImageBitmap(blob);
    try {
      const oldCanvas = this.atlasCanvas;
      const oldPlacements = this.lastPlacements;
      const oldW = oldCanvas.width;
      const oldH = oldCanvas.height;
      const sizes = toAdd.map((r) => ({ name: r.name, w: r.sw, h: r.sh }));
      const { width: newRegionW, height: newRegionH, placements: newLocal } = shelfPack(sizes);
      const totalW = Math.max(oldW, newRegionW);
      const totalH = oldH + newRegionH;
      if (totalW > MAX_PACK_DIMENSION || totalH > MAX_PACK_DIMENSION) {
        throw new Error(
          `Workshop atlas append exceeds ${MAX_PACK_DIMENSION}px; reduce texture count or size`,
        );
      }
      const nextCanvas = document.createElement("canvas");
      nextCanvas.width = totalW;
      nextCanvas.height = totalH;
      const ctx = nextCanvas.getContext("2d", { willReadFrequently: true });
      if (ctx === null) {
        throw new Error("Canvas 2D context unavailable for workshop atlas append");
      }
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(oldCanvas, 0, 0);
      const offsetY = oldH;
      const byName = new Map(newLocal.map((p) => [p.name, p]));
      for (const r of toAdd) {
        const p = byName.get(r.name);
        if (p === undefined) {
          continue;
        }
        const dx = p.x;
        const dy = p.y + offsetY;
        ctx.drawImage(bmp, r.sx, r.sy, r.sw, r.sh, dx, dy, p.w, p.h);
      }
      const mergedPlacements: PackedEntry[] = [
        ...oldPlacements,
        ...newLocal.map((p) => ({
          name: p.name,
          x: p.x,
          y: p.y + offsetY,
          w: p.w,
          h: p.h,
        })),
      ];
      this.destroyPackedKeepWorkshopStateForRebuild();
      const source = TextureSource.from(nextCanvas);
      source.scaleMode = "nearest";
      this.packedSource = source;
      this.textureMap.clear();
      for (const p of mergedPlacements) {
        const sub = new Texture({
          source,
          frame: new Rectangle(p.x, p.y, p.w, p.h),
        });
        sub.source.scaleMode = "nearest";
        this.textureMap.set(p.name, sub);
      }
      this.atlasTexture = new Texture({ source });
      this.atlasTexture.source.scaleMode = "nearest";
      this.atlasCanvas = nextCanvas;
      this.lastPlacements = mergedPlacements;
      this.buildVariantMap();
    } finally {
      bmp.close();
    }
  }

  /** Drops GPU textures without clearing workshop canvas/placement bookkeeping (internal). */
  private destroyPackedKeepWorkshopStateForRebuild(): void {
    this.variantCache.clear();
    for (const t of this.textureMap.values()) {
      t.destroy(false);
    }
    this.textureMap.clear();
    if (this.atlasTexture) {
      this.atlasTexture.destroy(false);
      this.atlasTexture = null;
    }
    if (this.packedSource) {
      this.packedSource.destroy();
      this.packedSource = null;
    }
  }

  getAtlasTexture(): Texture {
    if (!this.atlasTexture) {
      throw new Error("AtlasLoader.load() must complete before getAtlasTexture()");
    }
    return this.atlasTexture;
  }

  getTexture(frameName: string): Texture {
    const t = resolveTextureMapKey(this.textureMap, frameName);
    if (!t) {
      throw new Error(`Unknown texture: "${frameName}"`);
    }
    return t;
  }

  /** Like {@link getTexture} but returns null when the frame is not packed in this atlas. */
  getTextureOrNull(frameName: string): Texture | null {
    return resolveTextureMapKey(this.textureMap, frameName) ?? null;
  }

  /**
   * Returns `[base, alt_1, alt_2, …]` for textures with discovered alts,
   * or a single-element array for textures without alts.
   */
  getTextureVariants(frameName: string): readonly Texture[] {
    const variants = resolveTextureMapKey(this.variantCache, frameName);
    if (variants) return variants;
    const tex = resolveTextureMapKey(this.textureMap, frameName);
    if (tex) return [tex];
    throw new Error(`Unknown texture: "${frameName}"`);
  }

  /**
   * Packed RGBA atlas canvas after {@link load}; used for CPU sampling / leaf particle baking.
   */
  getAtlasCanvas(): HTMLCanvasElement | null {
    return this.atlasCanvas;
  }

  /**
   * Dominant hue in degrees [0, 360) from opaque pixels in a frame (saturation-weighted circular mean).
   * Returns null if the frame is missing or unreadable.
   */
  sampleAverageHueDegrees(frameName: string): number | null {
    if (this.atlasCanvas === null) {
      return null;
    }
    const tex = resolveTextureMapKey(this.textureMap, frameName);
    if (!tex) {
      return null;
    }
    const fr = tex.frame;
    const x = Math.floor(fr.x);
    const y = Math.floor(fr.y);
    const w = Math.floor(fr.width);
    const h = Math.floor(fr.height);
    if (w < 1 || h < 1) {
      return null;
    }
    const ctx = this.atlasCanvas.getContext("2d", { willReadFrequently: true });
    if (ctx === null) {
      return null;
    }
    let data: ImageData;
    try {
      data = ctx.getImageData(x, y, w, h);
    } catch {
      return null;
    }
    const px = data.data;
    let sumXw = 0;
    let sumYw = 0;
    let wHue = 0;
    let ar = 0;
    let ag = 0;
    let ab = 0;
    let nGray = 0;
    for (let i = 0; i < px.length; i += 4) {
      const a = px[i + 3]!;
      if (a < HSL_SAMPLE_ALPHA_MIN) {
        continue;
      }
      const r = px[i]! / 255;
      const g = px[i + 1]! / 255;
      const b = px[i + 2]! / 255;
      const hsl = rgbToHsl01(r, g, b);
      if (hsl.s < HSL_MIN_SAT_FOR_VECTOR) {
        ar += r;
        ag += g;
        ab += b;
        nGray += 1;
        continue;
      }
      const rad = hsl.h * Math.PI * 2;
      const wt = hsl.s * (a / 255);
      sumXw += Math.cos(rad) * wt;
      sumYw += Math.sin(rad) * wt;
      wHue += wt;
    }
    if (wHue > 1e-4) {
      const ang = Math.atan2(sumYw, sumXw);
      return ((ang * (180 / Math.PI)) % 360 + 360) % 360;
    }
    if (nGray > 0) {
      ar /= nGray;
      ag /= nGray;
      ab /= nGray;
      const hsl = rgbToHsl01(ar, ag, ab);
      return hueDegreesFromHsl01(hsl.h);
    }
    return null;
  }

  /**
   * Mean RGB of opaque pixels in a frame (components 0–1). Used for leaf particle recoloring.
   */
  sampleAverageRgb01(frameName: string): { r: number; g: number; b: number } | null {
    if (this.atlasCanvas === null) {
      return null;
    }
    const tex = resolveTextureMapKey(this.textureMap, frameName);
    if (!tex) {
      return null;
    }
    const fr = tex.frame;
    const x = Math.floor(fr.x);
    const y = Math.floor(fr.y);
    const w = Math.floor(fr.width);
    const h = Math.floor(fr.height);
    if (w < 1 || h < 1) {
      return null;
    }
    const ctx = this.atlasCanvas.getContext("2d", { willReadFrequently: true });
    if (ctx === null) {
      return null;
    }
    let data: ImageData;
    try {
      data = ctx.getImageData(x, y, w, h);
    } catch {
      return null;
    }
    const px = data.data;
    let sr = 0;
    let sg = 0;
    let sb = 0;
    let n = 0;
    for (let i = 0; i < px.length; i += 4) {
      const a = px[i + 3]!;
      if (a < HSL_SAMPLE_ALPHA_MIN) {
        continue;
      }
      sr += px[i]!;
      sg += px[i + 1]!;
      sb += px[i + 2]!;
      n += 1;
    }
    if (n < 1) {
      return null;
    }
    return {
      r: sr / (255 * n),
      g: sg / (255 * n),
      b: sb / (255 * n),
    };
  }

  private buildVariantMap(): void {
    this.variantCache.clear();
    const furnaceOnFrames: Texture[] = [];
    for (let i = 0; i < 64; i++) {
      const t = this.textureMap.get(`furnace_on_${i}`);
      if (t === undefined) {
        break;
      }
      furnaceOnFrames.push(t);
    }
    if (furnaceOnFrames.length > 0) {
      this.variantCache.set("furnace_on", furnaceOnFrames);
      if (!this.textureMap.has("furnace_on")) {
        this.textureMap.set("furnace_on", furnaceOnFrames[0]!);
      }
    }

    const altGroups = new Map<string, { idx: number; tex: Texture }[]>();

    for (const [key, tex] of this.textureMap) {
      const m = key.match(/^(.+)_alt_(\d+)$/);
      if (m) {
        const base = m[1]!;
        const idx = parseInt(m[2]!, 10);
        let group = altGroups.get(base);
        if (!group) {
          group = [];
          altGroups.set(base, group);
        }
        group.push({ idx, tex });
      }
    }

    for (const [base, alts] of altGroups) {
      const baseTex = this.textureMap.get(base);
      if (!baseTex) continue;
      alts.sort((a, b) => a.idx - b.idx);
      this.variantCache.set(base, [baseTex, ...alts.map((a) => a.tex)]);
    }

    for (const [key, tex] of this.textureMap) {
      if (/_alt_\d+$/.test(key)) continue;
      if (this.variantCache.has(key)) continue;
      this.variantCache.set(key, [tex]);
    }
  }

  private destroyPacked(): void {
    this.variantCache.clear();
    for (const t of this.textureMap.values()) {
      t.destroy(false);
    }
    this.textureMap.clear();
    if (this.atlasTexture) {
      this.atlasTexture.destroy(false);
      this.atlasTexture = null;
    }
    if (this.packedSource) {
      this.packedSource.destroy();
      this.packedSource = null;
    }
    this.atlasCanvas = null;
    this.lastPlacements = [];
  }

  destroy(): void {
    this.destroyPacked();
  }
}
