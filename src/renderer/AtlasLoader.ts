/**
 * Loads block texture atlas (spritesheet JSON + PNG) via Pixi Assets; frame lookup by name.
 *
 * Pixi v8's `Assets` resolver only treats URLs like `name.png.json` as spritesheets. Loading
 * `atlas.json` alone resolves as plain JSON and breaks the asset cache. We fetch JSON and build
 * {@link Spritesheet} explicitly so `atlas.json` + `atlas.png` keep their normal names.
 */
import { Assets, Spritesheet, Texture, type SpritesheetData } from "pixi.js";

export class AtlasLoader {
  private sheet: Spritesheet | null = null;
  private readonly textureMap = new Map<string, Texture>();
  private atlasTexture: Texture | null = null;

  /**
   * Loads `atlas.json` + `atlas.png` from `public/assets/textures/` (respects Vite `base`).
   */
  async load(): Promise<void> {
    const base = import.meta.env.BASE_URL;
    const jsonUrl = `${base}assets/textures/atlas.json`;
    const res = await fetch(jsonUrl);
    if (!res.ok) {
      throw new Error(`Atlas JSON failed to load: ${jsonUrl} (${res.status})`);
    }
    const data = (await res.json()) as SpritesheetData;
    const imageName = data.meta.image;
    if (typeof imageName !== "string" || imageName.length === 0) {
      throw new Error("atlas.json: meta.image is missing or invalid");
    }
    const imageUrl = new URL(imageName, new URL(jsonUrl, window.location.href)).href;
    const imageTexture = await Assets.load<Texture>(imageUrl);
    const sheet = new Spritesheet({
      texture: imageTexture,
      data,
    });
    await sheet.parse();
    sheet.textureSource.scaleMode = "nearest";
    this.sheet = sheet;
    this.textureMap.clear();
    this.atlasTexture?.destroy(false);
    this.atlasTexture = new Texture({ source: sheet.textureSource });
    this.atlasTexture.source.scaleMode = "nearest";
    for (const key of Object.keys(sheet.textures)) {
      const tex = sheet.textures[key as keyof typeof sheet.textures];
      if (tex) {
        tex.source.scaleMode = "nearest";
        this.textureMap.set(key, tex);
      }
    }
  }

  /** Full-atlas texture for batched mesh rendering (custom UVs per vertex). */
  getAtlasTexture(): Texture {
    if (!this.atlasTexture) {
      throw new Error("AtlasLoader.load() must complete before getAtlasTexture()");
    }
    return this.atlasTexture;
  }

  getTexture(frameName: string): Texture {
    const t = this.textureMap.get(frameName);
    if (!t) {
      throw new Error(`Unknown atlas frame: "${frameName}"`);
    }
    return t;
  }

  destroy(): void {
    this.textureMap.clear();
    if (this.atlasTexture) {
      this.atlasTexture.destroy(false);
      this.atlasTexture = null;
    }
    if (this.sheet) {
      // The spritesheet comes from Pixi Assets; do not destroy its source here.
      // Destroying with `true` breaks subsequent reloads when creating a new world.
      this.sheet.destroy(false);
      this.sheet = null;
    }
  }
}
