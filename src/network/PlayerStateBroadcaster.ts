/** Broadcasts `PLAYER_STATE` when local state changes; driven from the game fixed timestep (see `tick`). */

import type { INetworkAdapter } from "./INetworkAdapter";
import { MsgType } from "./protocol/messages";

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
  private _active = false;

  constructor(adapter: INetworkAdapter, getState: StateProvider) {
    this._adapter = adapter;
    this._getState = getState;
  }

  /** Enable broadcasting; actual sends happen when {@link tick} is called from the game loop. */
  start(): void {
    this._active = true;
  }

  stop(): void {
    this._active = false;
  }

  /** Next tick sends even if nothing changed (e.g. a peer joined and needs a pose resync). */
  invalidateSnapshot(): void {
    this._hasLast = false;
  }

  /**
   * Call from fixed update (e.g. every 2nd tick at 60 Hz ≈ 30 Hz) while connected.
   */
  tick(): void {
    if (!this._active) {
      return;
    }
    this._tick();
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
