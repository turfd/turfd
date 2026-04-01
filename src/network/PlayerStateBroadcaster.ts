/** Samples local player state at 20 Hz and broadcasts `PLAYER_STATE` when it changes. */

import type { INetworkAdapter } from "./INetworkAdapter";
import { MsgType } from "./protocol/messages";

const TICK_INTERVAL_MS = 50; // 20 Hz

type PlayerStateSnapshot = {
  playerId: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  facingRight: boolean;
};

/**
 * Called each tick to get the current local player state.
 * Returns null if the local player is not yet initialised.
 */
type StateProvider = () => PlayerStateSnapshot | null;

export class PlayerStateBroadcaster {
  private readonly _adapter: INetworkAdapter;
  private readonly _getState: StateProvider;
  private _hasLast = false;
  private _lastPlayerId = 0;
  private _lastX = 0;
  private _lastY = 0;
  private _lastVx = 0;
  private _lastVy = 0;
  private _lastFacing = false;
  private _intervalId: ReturnType<typeof setInterval> | null = null;

  constructor(adapter: INetworkAdapter, getState: StateProvider) {
    this._adapter = adapter;
    this._getState = getState;
  }

  /** Start the 20 Hz broadcast tick. Safe to call multiple times (no-op if running). */
  start(): void {
    if (this._intervalId !== null) {
      return;
    }
    this._intervalId = setInterval(() => {
      this._tick();
    }, TICK_INTERVAL_MS);
  }

  /** Stop the tick. Safe to call when not running. */
  stop(): void {
    if (this._intervalId === null) {
      return;
    }
    clearInterval(this._intervalId);
    this._intervalId = null;
  }

  private _tick(): void {
    if (this._adapter.state.status !== "connected") {
      return;
    }

    const snap = this._getState();
    if (snap === null) {
      return;
    }

    if (
      this._hasLast &&
      snap.playerId === this._lastPlayerId &&
      snap.x === this._lastX &&
      snap.y === this._lastY &&
      snap.vx === this._lastVx &&
      snap.vy === this._lastVy &&
      snap.facingRight === this._lastFacing
    ) {
      return;
    }

    this._adapter.broadcast({
      type: MsgType.PLAYER_STATE,
      playerId: snap.playerId,
      x: snap.x,
      y: snap.y,
      vx: snap.vx,
      vy: snap.vy,
      facingRight: snap.facingRight,
    });

    this._hasLast = true;
    this._lastPlayerId = snap.playerId;
    this._lastX = snap.x;
    this._lastY = snap.y;
    this._lastVx = snap.vx;
    this._lastVy = snap.vy;
    this._lastFacing = snap.facingRight;
  }
}
