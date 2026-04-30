import { Container } from "pixi.js";
import { BLOCK_SIZE, MAX_VISIBLE_BLOCKS_ON_MIN_AXIS } from "../core/constants";

export type CameraOptions = {
  /** Lerp responsiveness (higher = snappier). */
  followLerpSpeed: number;
  minZoom: number;
  maxZoom: number;
  /** Initial zoom level. */
  initialZoom: number;
};

const defaultCameraOptions: CameraOptions = {
  followLerpSpeed: 10,
  minZoom: 0.25,
  maxZoom: 4,
  initialZoom: 2,
};
/**
 * World-space root: all world layers are children of this container.
 * Position/scale implement centered view with lerp follow and zoom.
 */
export class Camera {
  readonly worldRoot: Container;
  readonly options: CameraOptions;

  private screenW = 0;
  private screenH = 0;
  private targetX = 0;
  private targetY = 0;
  private posX = 0;
  private posY = 0;
  private zoomLevel: number;
  /**
   * Backing-buffer resolution multiplier for snap precision (1 = CSS pixel, 2 = retina device pixel, …).
   * Driven by Pixi's `renderer.resolution`; set by {@link RenderPipeline} after init/resize. Snapping
   * to `1 / snapResolution` CSS units keeps the world translation on the device-pixel grid (no
   * seams from nearest sampling) while halving the visible camera-follow jitter on hi-DPI displays.
   */
  private snapResolution = 1;

  constructor(options: Partial<CameraOptions> = {}) {
    this.options = { ...defaultCameraOptions, ...options };
    this.zoomLevel = this.options.initialZoom;
    this.worldRoot = new Container();
    this.worldRoot.label = "cameraWorldRoot";
  }

  setScreenSize(width: number, height: number): void {
    if (width <= 0 || height <= 0) {
      return;
    }
    this.screenW = width;
    this.screenH = height;
    this.applyTransform();
  }

  /**
   * Pass `pixiApp.renderer.resolution` here whenever it changes. Higher resolution → finer snap
   * step (1 / res CSS units = 1 backing-buffer pixel), which produces less visible camera jitter
   * during follow without breaking the integer backing-buffer alignment that prevents tile seams.
   */
  setSnapResolution(resolution: number): void {
    if (!Number.isFinite(resolution) || resolution <= 0) {
      return;
    }
    if (resolution === this.snapResolution) {
      return;
    }
    this.snapResolution = resolution;
    this.applyTransform();
  }

  getTarget(): { x: number; y: number } {
    return { x: this.targetX, y: this.targetY };
  }

  setTarget(x: number, y: number): void {
    this.targetX = x;
    this.targetY = y;
  }

  getPosition(): { x: number; y: number } {
    return { x: this.posX, y: this.posY };
  }

  setPositionImmediate(x: number, y: number): void {
    this.posX = x;
    this.posY = y;
    this.targetX = x;
    this.targetY = y;
    this.applyTransform();
  }

  getZoom(): number {
    return this.getEffectiveZoom();
  }

  setZoom(z: number): void {
    const { minZoom, maxZoom } = this.options;
    this.zoomLevel = Math.min(maxZoom, Math.max(minZoom, z));
    this.applyTransform();
  }

  /** Advance lerp toward target; call once per frame from the render path. */
  update(dtSec: number): void {
    if (dtSec <= 0) {
      return;
    }
    const k = 1 - Math.exp(-this.options.followLerpSpeed * dtSec);
    this.posX += (this.targetX - this.posX) * k;
    this.posY += (this.targetY - this.posY) * k;
    this.applyTransform();
  }

  worldToScreen(worldX: number, worldY: number): { x: number; y: number } {
    const z = this.getEffectiveZoom();
    return {
      x: this.worldRoot.x + worldX * z,
      y: this.worldRoot.y + worldY * z,
    };
  }

  screenToWorld(screenX: number, screenY: number): { x: number; y: number } {
    const z = this.getEffectiveZoom();
    return {
      x: (screenX - this.worldRoot.x) / z,
      y: (screenY - this.worldRoot.y) / z,
    };
  }

  private applyTransform(): void {
    if (this.screenW <= 0 || this.screenH <= 0) {
      return;
    }
    const z = this.getEffectiveZoom();
    this.worldRoot.scale.set(z);
    const rawX = this.screenW * 0.5 - this.posX * z;
    const rawY = this.screenH * 0.5 - this.posY * z;
    // Snap translation to the backing-buffer pixel grid (1 / snapResolution CSS px). At dpr=1 this
    // is identical to the previous Math.round(rawX) behaviour; at dpr=2 it halves the snap step,
    // which materially reduces the visible "staircase" jitter during camera follow at high zoom.
    // The grid is still integer in *device* pixels, so nearest-neighbor sampling still meets at
    // tile edges and the "no seams" property documented previously is preserved.
    const r = this.snapResolution;
    this.worldRoot.position.set(
      Math.round(rawX * r) / r,
      Math.round(rawY * r) / r,
    );
  }

  private getEffectiveZoom(): number {
    const minDim = Math.min(this.screenW, this.screenH);
    const zoomForSizeFloor =
      minDim / (MAX_VISIBLE_BLOCKS_ON_MIN_AXIS * BLOCK_SIZE);
    let z = Math.max(this.options.minZoom, this.zoomLevel, zoomForSizeFloor);
    z = Math.min(this.options.maxZoom, z);
    // Snap zoom so each block is an integer number of physical pixels wide; keeps chunk/tile edges on the pixel grid.
    const pixelsPerBlock = BLOCK_SIZE * z;
    const snappedPpb = Math.max(1, Math.round(pixelsPerBlock));
    z = snappedPpb / BLOCK_SIZE;
    return Math.min(this.options.maxZoom, Math.max(this.options.minZoom, z));
  }
}
