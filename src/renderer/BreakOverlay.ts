/**
 * Block break progress: semi-transparent fill + border + crack lines on layerEntities.
 */
import { Graphics } from "pixi.js";
import { BLOCK_SIZE } from "../core/constants";
import type { PlayerState } from "../entities/Player";
import type { RenderPipeline } from "./RenderPipeline";

export class BreakOverlay {
  private readonly g: Graphics;

  constructor(pipeline: RenderPipeline) {
    this.g = new Graphics();
    pipeline.layerEntities.addChild(this.g);
  }

  sync(state: PlayerState): void {
    this.g.clear();
    const t = state.breakTarget;
    if (t === null || state.breakProgress <= 0) {
      return;
    }

    const x = t.wx * BLOCK_SIZE;
    const y = -(t.wy + 1) * BLOCK_SIZE;
    const w = BLOCK_SIZE;
    const p = state.breakProgress;

    this.g.rect(x, y, w, w);
    this.g.fill({ color: 0x000000, alpha: p * 0.7 });

    this.g.rect(x, y, w, w);
    this.g.stroke({ width: 2, color: 0xffffff, alpha: 1 });

    const pad = 3;
    const span = (w - pad * 2) * p;
    this.g.moveTo(x + pad, y + pad);
    this.g.lineTo(x + pad + span, y + pad + span);
    this.g.stroke({ width: 1.5, color: 0x888888, alpha: 0.85 });
    this.g.moveTo(x + w - pad, y + pad);
    this.g.lineTo(x + w - pad - span, y + pad + span);
    this.g.stroke({ width: 1.5, color: 0x888888, alpha: 0.85 });
  }

  destroy(): void {
    this.g.parent?.removeChild(this.g);
    this.g.destroy();
  }
}
