/** World-space physics for a dropped item stack: vertical fall, solid collision, pickup pull. */
import {
  BLOCK_SIZE,
  ITEM_COLLECT_SNAP_PX,
  ITEM_DROP_LANDING_FRICTION,
  ITEM_GRAVITY,
  ITEM_HALF_EXTENT_PX,
  ITEM_MAX_FALL_SPEED,
  ITEM_PULL_RANGE_BLOCKS,
  ITEM_PULL_SPEED_PX,
} from "../core/constants";
import type { WorldCollisionReader } from "../core/worldCollision";
import type { ItemId } from "../core/itemDefinition";
import { createAABB, sweepAABB, type AABB } from "./physics/AABB";

const h = ITEM_HALF_EXTENT_PX;

function itemWorldCenterToScreen(ix: number, iy: number): AABB {
  return createAABB(ix - h, -(iy + h), h * 2, h * 2);
}

function itemScreenToWorldCenter(m: AABB): { x: number; y: number } {
  return {
    x: m.x + h,
    y: -m.y - h,
  };
}

export class DroppedItem {
  readonly id: string;
  readonly itemId: ItemId;
  count: number;
  /** Uses consumed for damageable tools (optional). */
  damage: number;
  x: number;
  y: number;
  /** World horizontal velocity (px/s); +right, matches screen +x. */
  vx: number;
  /** World downward velocity (px/s); +down (same convention as player gravity). */
  vy: number;
  /** While positive, no player pull or pickup (player-throw cooldown). */
  pickupDelayRemainSec: number;
  private _pulling = false;

  constructor(
    id: string,
    itemId: ItemId,
    count: number,
    x: number,
    y: number,
    vx = 0,
    vy = 0,
    damage = 0,
    pickupDelaySec = 0,
  ) {
    this.id = id;
    this.itemId = itemId;
    this.count = count;
    this.damage = damage;
    this.x = x;
    this.y = y;
    this.vx = vx;
    this.vy = vy;
    this.pickupDelayRemainSec = Math.max(0, pickupDelaySec);
  }

  get pulling(): boolean {
    return this._pulling;
  }

  private integrateFreefall(
    dt: number,
    world: WorldCollisionReader,
    solidScratch: AABB[],
  ): void {
    const pad = 4;
    this.vy += ITEM_GRAVITY * BLOCK_SIZE * dt;
    const vmax = ITEM_MAX_FALL_SPEED * BLOCK_SIZE;
    if (this.vy > vmax) {
      this.vy = vmax;
    }
    const screenDx = this.vx * dt;
    const screenDy = this.vy * dt;
    const mover = itemWorldCenterToScreen(this.x, this.y);
    const query = createAABB(
      Math.min(mover.x, mover.x + screenDx) - pad,
      Math.min(mover.y, mover.y + screenDy) - pad,
      Math.abs(screenDx) + mover.width + pad * 2,
      Math.abs(screenDy) + mover.height + pad * 2,
    );
    world.querySolidAABBs(query, solidScratch);
    const { hitX, hitY } = sweepAABB(mover, screenDx, screenDy, solidScratch);
    const c = itemScreenToWorldCenter(mover);
    this.x = c.x;
    this.y = c.y;
    if (hitX) {
      this.vx = 0;
    }
    if (hitY) {
      this.vy = 0;
      if (screenDy > 0) {
        this.vx *= ITEM_DROP_LANDING_FRICTION;
      }
    }
  }

  /**
   * Integrates physics. Returns true when the stack should be collected into inventory.
   */
  update(
    dt: number,
    world: WorldCollisionReader,
    playerPos: { x: number; y: number },
    solidScratch: AABB[],
    canPullTowardPlayer = true,
  ): boolean {
    if (this.pickupDelayRemainSec > 0) {
      this.pickupDelayRemainSec = Math.max(0, this.pickupDelayRemainSec - dt);
      this._pulling = false;
      this.integrateFreefall(dt, world, solidScratch);
      return false;
    }
    if (!canPullTowardPlayer) {
      this._pulling = false;
      this.integrateFreefall(dt, world, solidScratch);
      return false;
    }

    const dxp = playerPos.x - this.x;
    const dyp = playerPos.y - this.y;
    const dist = Math.hypot(dxp, dyp);
    const pullRangePx = ITEM_PULL_RANGE_BLOCKS * BLOCK_SIZE;

    this._pulling = dist <= pullRangePx && dist > 1e-6;

    if (dist < ITEM_COLLECT_SNAP_PX) {
      return true;
    }

    const pad = 4;

    if (this._pulling) {
      const inv = 1 / dist;
      const nx = dxp * inv;
      const ny = dyp * inv;
      this.x += nx * ITEM_PULL_SPEED_PX * dt;
      this.y += ny * ITEM_PULL_SPEED_PX * dt;
      this.vx = 0;
      this.vy = 0;

      let mover = itemWorldCenterToScreen(this.x, this.y);
      const query = createAABB(
        mover.x - pad,
        mover.y - pad,
        mover.width + pad * 2,
        mover.height + pad * 2,
      );
      world.querySolidAABBs(query, solidScratch);
      sweepAABB(mover, 0, 0, solidScratch);
      const c = itemScreenToWorldCenter(mover);
      this.x = c.x;
      this.y = c.y;
    } else {
      this.integrateFreefall(dt, world, solidScratch);
    }

    const d2 = Math.hypot(playerPos.x - this.x, playerPos.y - this.y);
    return d2 < ITEM_COLLECT_SNAP_PX;
  }
}
