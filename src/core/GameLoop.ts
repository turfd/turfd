import {
  FIXED_TIMESTEP_MS,
  FIXED_TIMESTEP_SEC,
  MAX_FIXED_STEPS_PER_FRAME,
  MAX_FRAME_MS,
} from "./constants";
import { chunkPerfLog, chunkPerfNow } from "../debug/chunkPerf";

export type GameLoopHooks = {
  /** Called once per fixed tick (60 Hz). */
  onFixedUpdate: (dtSec: number) => void;
  /** Called every frame with interpolation alpha in [0, 1) for the next physics state. */
  onRender: (interpolationAlpha: number) => void;
};

/**
 * Fixed-timestep update (60 Hz) with uncapped `requestAnimationFrame` render.
 */
export class GameLoop {
  private readonly hooks: GameLoopHooks;
  private rafId: number | null = null;
  private lastFrameTimeMs = 0;
  private accumulatorMs = 0;
  private running = false;
  /** Monotonic count of completed fixed updates (for debugging / sync). */
  private tickIndex = 0;

  constructor(hooks: GameLoopHooks) {
    this.hooks = hooks;
  }

  getTickIndex(): number {
    return this.tickIndex;
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.lastFrameTimeMs = performance.now();
    this.accumulatorMs = 0;
    this.rafId = requestAnimationFrame((t) => this.frame(t));
  }

  stop(): void {
    this.running = false;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  private frame(timeMs: number): void {
    if (!this.running) {
      return;
    }

    const deltaMs = Math.min(timeMs - this.lastFrameTimeMs, MAX_FRAME_MS);
    this.lastFrameTimeMs = timeMs;
    this.accumulatorMs += deltaMs;

    const tFixed = import.meta.env.DEV ? chunkPerfNow() : 0;
    let fixedSteps = 0;
    while (
      this.accumulatorMs >= FIXED_TIMESTEP_MS &&
      fixedSteps < MAX_FIXED_STEPS_PER_FRAME
    ) {
      this.hooks.onFixedUpdate(FIXED_TIMESTEP_SEC);
      this.tickIndex += 1;
      this.accumulatorMs -= FIXED_TIMESTEP_MS;
      fixedSteps += 1;
    }
    if (
      import.meta.env.DEV &&
      (fixedSteps > 1 || this.accumulatorMs >= FIXED_TIMESTEP_MS)
    ) {
      chunkPerfLog("gameLoop:fixedBurst", chunkPerfNow() - tFixed, {
        fixedSteps,
        backlogMs: this.accumulatorMs,
      });
    }

    const alpha = this.accumulatorMs / FIXED_TIMESTEP_MS;
    this.hooks.onRender(alpha);

    this.rafId = requestAnimationFrame((t) => this.frame(t));
  }
}
