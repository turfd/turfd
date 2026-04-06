/** Remote networked player: delayed snapshot interpolation between authority samples (no velocity extrapolation). */

import {
  REMOTE_PLAYER_INTERP_DELAY_MS,
  REMOTE_PLAYER_SNAPSHOT_MAX_AGE_MS,
  REMOTE_PLAYER_SNAPSHOT_MAX_COUNT,
} from "../../core/constants";

/** Matches local `fg` / `bg` break targets without importing `Player` (circular). */
export type RemoteBreakTargetLayer = "fg" | "bg";

export type RemoteBreakMining = {
  wx: number;
  wy: number;
  layer: RemoteBreakTargetLayer;
  /** Normalised crack amount for destroy-stage overlay `[0, 1]`. */
  progress: number;
};

/** Hard snap when authority is this far from prior authority (teleport / load). */
const SNAP_ERROR_PX = 96;

type PoseSample = {
  tMs: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  facingRight: boolean;
};

export type RemoteDisplayPose = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  facingRight: boolean;
};

export class RemotePlayer {
  /**
   * Latest authority feet (world space); same as {@link getAuthorityFeet}.
   * Kept for callers that still read `.x` / `.y`.
   */
  x: number;
  y: number;
  /** Legacy fixed-step blend anchors; kept equal to authority. */
  prevX: number;
  prevY: number;
  facingRight: boolean;
  /** Last hotbar index from network (for parity with local; held sprite uses {@link heldItemId}). */
  hotbarSlot = 0;
  /** Item id shown in hand; `0` = empty. */
  heldItemId = 0;
  /** Mining / use swing flag from last pose packet (combined with crack overlay in renderer). */
  miningVisualFromNetwork = false;

  private authX: number;
  private authY: number;
  private vx: number;
  private vy: number;

  private readonly snapshots: PoseSample[] = [];

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
    this.pushSnapshotSample(performance.now());
  }

  /** Authoritative sample for host → joiner snapshots and relays. */
  getNetworkSample(): {
    x: number;
    y: number;
    vx: number;
    vy: number;
    facingRight: boolean;
    hotbarSlot: number;
    heldItemId: number;
    miningVisual: boolean;
  } {
    return {
      x: this.authX,
      y: this.authY,
      vx: this.vx,
      vy: this.vy,
      facingRight: this.facingRight,
      hotbarSlot: this.hotbarSlot,
      heldItemId: this.heldItemId,
      miningVisual:
        this.miningVisualFromNetwork || this.breakMining !== null,
    };
  }

  /** Broadcast horizontal velocity (px/s, world space) — latest authority. */
  get velocityX(): number {
    return this.vx;
  }

  /** Broadcast vertical velocity (px/s, world Y up) — latest authority. */
  get velocityY(): number {
    return this.vy;
  }

  getBreakMining(): RemoteBreakMining | null {
    return this.breakMining;
  }

  /**
   * Server-truth feet for gameplay (e.g. block placement overlap). Not delayed.
   */
  getAuthorityFeet(): { x: number; y: number } {
    return { x: this.authX, y: this.authY };
  }

  /**
   * Smoothed pose for sprites / nametags / cosmetic effects. Interpolates between buffered samples at
   * `nowMs - {@link REMOTE_PLAYER_INTERP_DELAY_MS}`.
   */
  getDisplayPose(nowMs: number): RemoteDisplayPose {
    const s = this.snapshots;
    if (s.length === 0) {
      return {
        x: this.authX,
        y: this.authY,
        vx: this.vx,
        vy: this.vy,
        facingRight: this.facingRight,
      };
    }

    const tTarget = nowMs - REMOTE_PLAYER_INTERP_DELAY_MS;
    const oldest = s[0]!;
    const newest = s[s.length - 1]!;

    if (s.length === 1 || tTarget <= oldest.tMs) {
      return sampleToPose(newest);
    }
    if (tTarget >= newest.tMs) {
      return sampleToPose(newest);
    }

    let i = 0;
    for (let k = 0; k < s.length - 1; k++) {
      if (s[k + 1]!.tMs >= tTarget) {
        i = k;
        break;
      }
    }
    const a = s[i]!;
    const b = s[i + 1]!;
    const span = b.tMs - a.tMs;
    const u = span > 1e-6 ? (tTarget - a.tMs) / span : 1;
    const clampedU = Math.max(0, Math.min(1, u));
    return {
      x: a.x + (b.x - a.x) * clampedU,
      y: a.y + (b.y - a.y) * clampedU,
      vx: a.vx + (b.vx - a.vx) * clampedU,
      vy: a.vy + (b.vy - a.vy) * clampedU,
      facingRight: clampedU < 0.5 ? a.facingRight : b.facingRight,
    };
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

  setTarget(
    x: number,
    y: number,
    vx: number,
    vy: number,
    facingRight: boolean,
    hotbarSlot: number,
    heldItemId: number,
    miningVisualFromNetwork: boolean,
  ): void {
    const err = Math.hypot(x - this.authX, y - this.authY);
    const now = performance.now();

    if (err > SNAP_ERROR_PX) {
      this.authX = x;
      this.authY = y;
      this.vx = vx;
      this.vy = vy;
      this.facingRight = facingRight;
      this.hotbarSlot = hotbarSlot;
      this.heldItemId = heldItemId;
      this.miningVisualFromNetwork = miningVisualFromNetwork;
      this.prevX = x;
      this.prevY = y;
      this.x = x;
      this.y = y;
      this.snapshots.length = 0;
      this.pushSnapshotSample(now);
      return;
    }

    this.prevX = this.authX;
    this.prevY = this.authY;
    this.authX = x;
    this.authY = y;
    this.vx = vx;
    this.vy = vy;
    this.facingRight = facingRight;
    this.hotbarSlot = hotbarSlot;
    this.heldItemId = heldItemId;
    this.miningVisualFromNetwork = miningVisualFromNetwork;
    this.x = x;
    this.y = y;
    this.pushSnapshotSample(now);
  }

  /** Fixed-step hook; display pose uses snapshot interpolation instead of extrapolation. */
  stepFixed(_dtSec: number): void {}

  private pushSnapshotSample(tMs: number): void {
    this.snapshots.push({
      tMs,
      x: this.authX,
      y: this.authY,
      vx: this.vx,
      vy: this.vy,
      facingRight: this.facingRight,
    });
    this.pruneSnapshots(tMs);
  }

  private pruneSnapshots(newestT: number): void {
    const cutoff = newestT - REMOTE_PLAYER_SNAPSHOT_MAX_AGE_MS;
    while (this.snapshots.length > 0 && this.snapshots[0]!.tMs < cutoff) {
      this.snapshots.shift();
    }
    while (this.snapshots.length > REMOTE_PLAYER_SNAPSHOT_MAX_COUNT) {
      this.snapshots.shift();
    }
  }
}

function sampleToPose(s: PoseSample): RemoteDisplayPose {
  return {
    x: s.x,
    y: s.y,
    vx: s.vx,
    vy: s.vy,
    facingRight: s.facingRight,
  };
}
