/** Remote networked player: extrapolate from last authority using fixed timestep (matches local physics clock). */

const MAX_EXTRAPOLATION_SEC = 0.35;

/** Matches local `fg` / `bg` break targets without importing `Player` (circular). */
export type RemoteBreakTargetLayer = "fg" | "bg";

export type RemoteBreakMining = {
  wx: number;
  wy: number;
  layer: RemoteBreakTargetLayer;
  /** Normalised crack amount for destroy-stage overlay `[0, 1]`. */
  progress: number;
};

/** Hard snap when authority is this far from our extrapolated pose (teleport / load). */
const SNAP_ERROR_PX = 96;

export class RemotePlayer {
  x: number;
  y: number;
  /** Start of current fixed step / packet blend — use with {@link x},{@link y} and render `alpha`. */
  prevX: number;
  prevY: number;
  facingRight: boolean;

  private authX: number;
  private authY: number;
  private vx: number;
  private vy: number;
  /** Seconds since last `setTarget`, advanced only in {@link stepFixed}. */
  private timeSinceAuth = 0;

  /** Destroy-stage overlay for this peer’s mining; null when idle. */
  private breakMining: RemoteBreakMining | null = null;

  constructor(
    x: number,
    y: number,
    facingRight: boolean,
    vx: number,
    vy: number,
  ) {
    this.authX = x;
    this.authY = y;
    this.vx = vx;
    this.vy = vy;
    this.x = x;
    this.y = y;
    this.prevX = x;
    this.prevY = y;
    this.facingRight = facingRight;
  }

  /** Authoritative sample for host → joiner snapshots and relays. */
  getNetworkSample(): {
    x: number;
    y: number;
    vx: number;
    vy: number;
    facingRight: boolean;
  } {
    return {
      x: this.authX,
      y: this.authY,
      vx: this.vx,
      vy: this.vy,
      facingRight: this.facingRight,
    };
  }

  /** Broadcast horizontal velocity (px/s, world space) — used for walk animation on joiners. */
  get velocityX(): number {
    return this.vx;
  }

  /** Broadcast vertical velocity (px/s, world Y up) — used for jump sprite heuristic on joiners. */
  get velocityY(): number {
    return this.vy;
  }

  getBreakMining(): RemoteBreakMining | null {
    return this.breakMining;
  }

  /**
   * @param crackStageEncoded Wire: `0` = not mining; `1`–`10` = destroy stage `0`–`9` as `stage+1`.
   */
  setBreakMiningFromNetwork(
    crackStageEncoded: number,
    wx: number,
    wy: number,
    layerWire: 0 | 1,
  ): void {
    if (crackStageEncoded === 0) {
      this.breakMining = null;
      return;
    }
    const stage = Math.min(9, Math.max(0, crackStageEncoded - 1));
    const progress = (stage + 0.5) / 10;
    const layer: RemoteBreakTargetLayer = layerWire === 1 ? "bg" : "fg";
    this.breakMining = { wx, wy, layer, progress };
  }

  clearBreakMiningIfCell(
    wx: number,
    wy: number,
    layer: RemoteBreakTargetLayer,
  ): void {
    const b = this.breakMining;
    if (b !== null && b.wx === wx && b.wy === wy && b.layer === layer) {
      this.breakMining = null;
    }
  }

  setTarget(x: number, y: number, vx: number, vy: number, facingRight: boolean): void {
    const err = Math.hypot(x - this.x, y - this.y);
    if (err > SNAP_ERROR_PX) {
      this.authX = x;
      this.authY = y;
      this.vx = vx;
      this.vy = vy;
      this.facingRight = facingRight;
      this.timeSinceAuth = 0;
      this.prevX = x;
      this.prevY = y;
      this.x = x;
      this.y = y;
      return;
    }

    this.prevX = this.x;
    this.prevY = this.y;
    this.authX = x;
    this.authY = y;
    this.vx = vx;
    this.vy = vy;
    this.facingRight = facingRight;
    this.timeSinceAuth = 0;
    this.x = x;
    this.y = y;
  }

  /**
   * Advance pose for one fixed tick. Keeps extrapolation on the same clock as local simulation
   * (unlike wall-clock `performance.now()`, which fights render vsync and packet jitter).
   */
  stepFixed(dtSec: number): void {
    this.prevX = this.x;
    this.prevY = this.y;
    this.timeSinceAuth = Math.min(
      this.timeSinceAuth + dtSec,
      MAX_EXTRAPOLATION_SEC,
    );
    this.x = this.authX + this.vx * this.timeSinceAuth;
    this.y = this.authY + this.vy * this.timeSinceAuth;
  }
}
