/** In-flight / stuck arrow: gravity, block stick, optional mob stick (host resolves strikes). */
import {
  ARROW_GRAVITY_BLOCKS_PER_SEC2,
  ARROW_HALF_EXTENT_PX,
  ARROW_MAX_AGE_SEC,
  ARROW_STUCK_BLOCK_MAX_AGE_SEC,
  ARROW_STUCK_SHAFT_CENTER_TO_TIP_PX,
  ARROW_TERMINAL_FALL_BLOCKS_PER_SEC,
  BLOCK_SIZE,
  ITEM_DROP_LANDING_FRICTION,
} from "../core/constants";
import type { WorldCollisionReader } from "../core/worldCollision";
import { mobStuckArrowWorldFromFeet } from "../world/arrowMobAttach";
import { createAABB, sweepAABB, type AABB } from "./physics/AABB";

const h = ARROW_HALF_EXTENT_PX;

export type ArrowStuckMode = "flying" | "block" | "mob";

/** Host `tryArrowStrike` callback result (client passes no callback). */
export type HostArrowStrikeResult =
  | { kind: "miss" }
  | {
      kind: "stickMob";
      mobId: number;
      offsetX: number;
      offsetY: number;
      rotationRad: number;
      /** Mob horizontal flip at impact; used to mirror stuck offset/angle when facing changes. */
      mobFacingRight: boolean;
    };

function centerToScreenAABB(ix: number, iy: number): AABB {
  return createAABB(ix - h, -(iy + h), h * 2, h * 2);
}

function screenAABBToworldCenter(m: AABB): { x: number; y: number } {
  return {
    x: m.x + h,
    y: -m.y - h,
  };
}

export class ArrowProjectile {
  readonly id: string;
  x: number;
  y: number;
  /** World feet-space position at the start of the last {@link tick} (for render rotation). */
  prevX: number;
  prevY: number;
  /** World horizontal px/s (+right). */
  vx: number;
  /** World vertical px/s (+down, matches dropped items / player fall). */
  vy: number;
  /** Host-side damage when this arrow strikes a mob. */
  readonly damage: number;
  /** Shooter feet X for knockback direction on hit. */
  readonly shooterFeetX: number;
  /** Seconds since spawn (flying) or since sticking (block). */
  ageSec = 0;
  stuckMode: ArrowStuckMode = "flying";
  /**
   * Mob feet–relative **tip** offset in world space at embed (before any facing flip).
   * Each tick: negate X iff {@link stuckMobFacingAtStick} differs from current mob facing.
   */
  stuckMobTipWorldXAtStick = 0;
  stuckMobTipWorldYAtStick = 0;
  stuckMobId = 0;
  /** Mob `facingRight` at embed time; used with XOR to mirror {@link stuckMobTipWorldXAtStick}. */
  stuckMobFacingAtStick = true;
  /**
   * When {@link stuckMode} === `"block"`: `side` = hit a vertical wall (motion clipped on X),
   * `flat` = floor/ceiling (clipped on Y). Used to correct sprite yaw vs block normal.
   */
  stuckBlockFace: "side" | "flat" | null = null;
  /**
   * When stuck, rotation passed to the sprite (`atan2` convention, then minus tip constant in
   * {@link EntityManager}).
   */
  frozenRotationRad: number | null = null;

  constructor(
    id: string,
    x: number,
    y: number,
    vx: number,
    vy: number,
    damage: number,
    shooterFeetX: number,
  ) {
    this.id = id;
    this.x = x;
    this.y = y;
    this.prevX = x;
    this.prevY = y;
    this.vx = vx;
    this.vy = vy;
    this.damage = damage;
    this.shooterFeetX = shooterFeetX;
  }

  isFlying(): boolean {
    return this.stuckMode === "flying";
  }

  /** Ground / wall stick — player may pick up and return to inventory. */
  isStuckInBlock(): boolean {
    return this.stuckMode === "block";
  }

  isStuckInMob(): boolean {
    return this.stuckMode === "mob";
  }

  stickToMob(
    mobId: number,
    offsetX: number,
    offsetY: number,
    rotationRad: number,
    mobFacingRight: boolean,
  ): void {
    this.stuckMode = "mob";
    this.stuckMobId = mobId;
    this.stuckMobFacingAtStick = mobFacingRight;
    const L = ARROW_STUCK_SHAFT_CENTER_TO_TIP_PX;
    const c = Math.cos(rotationRad);
    const s = Math.sin(rotationRad);
    /** Tip = center + L * (cos θ, −sin θ) in world (+y down); same convention as flight `atan2`. */
    this.stuckMobTipWorldXAtStick = offsetX + L * c;
    this.stuckMobTipWorldYAtStick = offsetY - L * s;
    this.stuckBlockFace = null;
    this.vx = 0;
    this.vy = 0;
    this.frozenRotationRad = rotationRad;
    this.prevX = this.x;
    this.prevY = this.y;
  }

  /** World shaft angle for sprite (`atan2` display convention) + corpse {@link tiltRad}. */
  stuckMobShaftWorldAngleRad(tiltRad: number, mobFacingRight: boolean): number {
    let a = this.frozenRotationRad ?? 0;
    if (mobFacingRight !== this.stuckMobFacingAtStick) {
      a = Math.atan2(Math.sin(a), -Math.cos(a));
    }
    return a + tiltRad;
  }

  syncStuckMobPosition(
    feetX: number,
    feetY: number,
    tiltRad: number,
    mobFacingRight: boolean,
  ): void {
    this.prevX = this.x;
    this.prevY = this.y;
    const wx =
      mobFacingRight === this.stuckMobFacingAtStick
        ? this.stuckMobTipWorldXAtStick
        : -this.stuckMobTipWorldXAtStick;
    const wy = this.stuckMobTipWorldYAtStick;
    const tip = mobStuckArrowWorldFromFeet(feetX, feetY, wx, wy, tiltRad);
    const ang = this.stuckMobShaftWorldAngleRad(tiltRad, mobFacingRight);
    const L = ARROW_STUCK_SHAFT_CENTER_TO_TIP_PX;
    const c = Math.cos(ang);
    const s = Math.sin(ang);
    this.x = tip.x - L * c;
    this.y = tip.y + L * s;
  }

  private freezeInBlock(
    rotationRad: number,
    face: "side" | "flat",
  ): void {
    this.stuckMode = "block";
    this.stuckBlockFace = face;
    this.vx = 0;
    this.vy = 0;
    this.frozenRotationRad = rotationRad;
    this.ageSec = 0;
    this.prevX = this.x;
    this.prevY = this.y;
  }

  /**
   * Integrates motion for flying arrows. Stuck arrows only age (block) or noop (mob).
   * `"stuck_block"` = just embedded in terrain (caller may play `bowhit`).
   */
  tick(
    dt: number,
    world: WorldCollisionReader,
    solidScratch: AABB[],
  ): "alive" | "dead" | "stuck_block" {
    if (this.stuckMode === "mob") {
      return "alive";
    }
    if (this.stuckMode === "block") {
      this.ageSec += dt;
      if (this.ageSec >= ARROW_STUCK_BLOCK_MAX_AGE_SEC) {
        return "dead";
      }
      return "alive";
    }

    const fromX = this.x;
    const fromY = this.y;

    this.ageSec += dt;
    if (this.ageSec >= ARROW_MAX_AGE_SEC) {
      return "dead";
    }

    const g = ARROW_GRAVITY_BLOCKS_PER_SEC2 * BLOCK_SIZE;
    this.vy += g * dt;
    const vmax = ARROW_TERMINAL_FALL_BLOCKS_PER_SEC * BLOCK_SIZE;
    if (this.vy > vmax) {
      this.vy = vmax;
    }

    const screenDx = this.vx * dt;
    const screenDy = this.vy * dt;
    const pad = 2;
    let mover = centerToScreenAABB(this.x, this.y);
    const query = createAABB(
      Math.min(mover.x, mover.x + screenDx) - pad,
      Math.min(mover.y, mover.y + screenDy) - pad,
      Math.abs(screenDx) + mover.width + pad * 2,
      Math.abs(screenDy) + mover.height + pad * 2,
    );
    world.querySolidAABBs(query, solidScratch);
    const { hitX, hitY, resolvedDx, resolvedDy } = sweepAABB(
      mover,
      screenDx,
      screenDy,
      solidScratch,
    );
    const c = screenAABBToworldCenter(mover);
    this.x = c.x;
    this.y = c.y;

    /** Pre-impact velocity needed when displacement is tiny but `vx`/`vy` are cleared before fallback. */
    const flightAngle = (preVx: number, preVy: number): number => {
      const dx = this.x - fromX;
      const dyDisp = -(this.y - fromY);
      const m2 = dx * dx + dyDisp * dyDisp;
      if (m2 > 0.25) {
        return Math.atan2(dyDisp, dx);
      }
      return Math.atan2(-preVy, preVx);
    };

    /** True when the sweep clipped motion on that axis (impact into a solid face). */
    const horizontalBlocked =
      hitX &&
      Math.abs(screenDx) > 1e-4 &&
      Math.abs(resolvedDx) < Math.abs(screenDx) - 1e-3;
    const verticalBlocked =
      hitY &&
      Math.abs(screenDy) > 1e-4 &&
      Math.abs(resolvedDy) < Math.abs(screenDy) - 1e-3;

    if (horizontalBlocked || verticalBlocked) {
      const preVx = this.vx;
      const preVy = this.vy;
      if (horizontalBlocked) {
        this.vx = 0;
      }
      if (verticalBlocked) {
        this.vy = 0;
      }
      const face: "side" | "flat" = horizontalBlocked ? "side" : "flat";
      this.freezeInBlock(flightAngle(preVx, preVy), face);
      this.prevX = fromX;
      this.prevY = fromY;
      return "stuck_block";
    }

    if (hitX) {
      this.vx *= ITEM_DROP_LANDING_FRICTION;
      if (Math.abs(this.vx) < 12) {
        this.vx = 0;
      }
    }
    if (hitY) {
      this.vy = 0;
    }

    this.prevX = fromX;
    this.prevY = fromY;
    return "alive";
  }
}
