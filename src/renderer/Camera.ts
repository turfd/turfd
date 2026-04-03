import { Container } from "pixi.js";
import { BLOCK_SIZE } from "../core/constants";

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
const MAX_VISIBLE_BLOCKS_X = 20;

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
    // Integer pixel translation + block-aligned zoom avoids 1px seams between tiles
    // (fractional screen coords + nearest-neighbor sampling shows gaps at certain camera positions).
    this.worldRoot.position.set(
      Math.round(this.screenW * 0.5 - this.posX * z),
      Math.round(this.screenH * 0.5 - this.posY * z),
    );
  }

  private getEffectiveZoom(): number {
    const zoomForWidthLimit = this.screenW / (MAX_VISIBLE_BLOCKS_X * BLOCK_SIZE);
    let z = Math.max(this.options.minZoom, this.zoomLevel, zoomForWidthLimit);
    z = Math.min(this.options.maxZoom, z);
    // Snap zoom so each block is an integer number of physical pixels wide; keeps chunk/tile edges on the pixel grid.
    const pixelsPerBlock = BLOCK_SIZE * z;
    const snappedPpb = Math.max(1, Math.round(pixelsPerBlock));
    z = snappedPpb / BLOCK_SIZE;
    return Math.min(this.options.maxZoom, Math.max(this.options.minZoom, z));
  }
}
