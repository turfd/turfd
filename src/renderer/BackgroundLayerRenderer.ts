import { Application, Container } from "pixi.js";
import {
  BACKGROUND_PARALLAX_X,
  BACKGROUND_TILE_STRIP_WIDTH_SCALE_GAMEPLAY,
  BLOCK_SIZE,
} from "../core/constants";
import type { WorldLightingParams } from "../world/lighting/WorldTime";
import type { AtlasLoader } from "./AtlasLoader";
import { Camera } from "./Camera";
import { ParallaxTileStripRenderer } from "./ParallaxTileStripRenderer";
import type { World } from "../world/World";

/**
 * Distant parallax strip wired to live {@link World} + {@link Camera} zoom.
 * Uses a **session-fixed** world X anchor (set on first {@link regenerate}) so the backdrop
 * never swaps chunk columns while walking — only {@link ParallaxTileStripRenderer#updateParallax}
 * scrolls it (no pops). Resize / world reload rebuilds the mesh.
 */
export class BackgroundLayerRenderer {
  readonly displayRoot: Container;

  private readonly strip: ParallaxTileStripRenderer;
  private readonly camera: Camera;
  private world: World | null = null;
  private atlas: AtlasLoader | null = null;
  /** World block X where parallax terrain is centered; frozen after first in-game rebuild. */
  private parallaxAnchorBlockX: number | null = null;

  constructor(app: Application, camera: Camera) {
    this.camera = camera;
    this.strip = new ParallaxTileStripRenderer(app, () => this.camera.getZoom());
    this.displayRoot = this.strip.displayRoot;
  }

  setWorldAndAtlas(world: World, atlas: AtlasLoader): void {
    this.world = world;
    this.atlas = atlas;
  }

  regenerate(): void {
    const world = this.world;
    const atlas = this.atlas;
    if (world === null || atlas === null) {
      return;
    }
    if (this.parallaxAnchorBlockX === null) {
      this.parallaxAnchorBlockX = this.camera.getPosition().x / BLOCK_SIZE;
    }
    const reg = world.getRegistry();
    const chestBlockId = world.getChestBlockId();
    this.strip.regenerate({
      seed: world.getSeed(),
      registry: reg,
      atlas,
      chestBlockId,
      anchorWorldBlockX: this.parallaxAnchorBlockX,
      slideWithCamera: false,
      stripWidthScale: BACKGROUND_TILE_STRIP_WIDTH_SCALE_GAMEPLAY,
    });
  }

  getLastSeed(): number | null {
    return this.strip.getLastSeed();
  }

  updateParallax(cameraWorldX: number, parallaxFactor: number = BACKGROUND_PARALLAX_X): void {
    this.strip.updateParallax(cameraWorldX, parallaxFactor);
  }

  applyWorldLighting(lighting: WorldLightingParams): void {
    this.strip.applyWorldLighting(lighting);
  }

  dispose(): void {
    this.strip.dispose();
    this.world = null;
    this.atlas = null;
    this.parallaxAnchorBlockX = null;
  }
}
