import { BLOCK_SIZE } from "../../core/constants";
import type { World } from "../../world/World";
import { getSolidAABBs } from "../physics/Collision";
import { createAABB, overlaps, sweepAABB, type AABB } from "../physics/AABB";
import type { GeneratorContext } from "../../world/gen/GeneratorContext";
import {
  MOB_GRAVITY_PX,
  MOB_TERMINAL_VY_PX,
  ZOMBIE_ATTACK_EXTRA_REACH_BLOCKS,
  ZOMBIE_CHASE_SPEED_PX,
  ZOMBIE_HEIGHT_PX,
  ZOMBIE_KNOCKBACK_DECAY_PER_SEC,
  ZOMBIE_KNOCKBACK_GROUND_VY_PX,
  ZOMBIE_KNOCKBACK_HORIZONTAL_CAP_PX,
  ZOMBIE_KNOCKBACK_RESISTANCE_PERCENT,
  ZOMBIE_KNOCKBACK_SPRINT_MULT,
  ZOMBIE_PREFERRED_GAP_BLOCKS,
  ZOMBIE_WATER_BUOYANCY_ACCEL_PX,
  ZOMBIE_WATER_GRAVITY_MULT,
  ZOMBIE_WATER_MAX_SINK_SPEED_PX,
  ZOMBIE_WATER_MAX_UPWARD_SPEED_PX,
  ZOMBIE_WATER_SPEED_MULT,
  ZOMBIE_WIDTH_PX,
  mobSwimBobVyDelta,
} from "./mobConstants";
import type { MobZombieState } from "./mobTypes";

function feetToScreenAABB(
  x: number,
  y: number,
  w: number,
  h: number,
): AABB {
  return createAABB(x - w * 0.5, -(y + h), w, h);
}

function screenAABBTofeet(m: AABB, w: number, h: number): { x: number; y: number } {
  return {
    x: m.x + w * 0.5,
    y: -(m.y + h),
  };
}

function groundProbe(mover: AABB): AABB {
  return createAABB(mover.x + 0.25, mover.y + mover.height, mover.width - 0.5, 2);
}

function zombieAabbOverlapsWater(world: World, pos: { x: number; y: number }): boolean {
  if (!world.getRegistry().isRegistered("stratum:water")) {
    return false;
  }
  const waterId = world.getWaterBlockId();
  const region = feetToScreenAABB(pos.x, pos.y, ZOMBIE_WIDTH_PX, ZOMBIE_HEIGHT_PX);
  const worldYBottom = -(region.y + region.height);
  const worldYTop = -region.y;
  const wx0 = Math.floor(region.x / BLOCK_SIZE);
  const wx1 = Math.floor((region.x + region.width - 1) / BLOCK_SIZE);
  const wy0 = Math.floor(worldYBottom / BLOCK_SIZE);
  const wy1 = Math.floor(worldYTop / BLOCK_SIZE);
  for (let wx = wx0; wx <= wx1; wx++) {
    for (let wy = wy0; wy <= wy1; wy++) {
      if (world.getChunkAt(wx, wy) === undefined) {
        continue;
      }
      if (world.getForegroundBlockId(wx, wy) === waterId) {
        return true;
      }
    }
  }
  return false;
}

function isOnGround(mover: AABB, solids: ReadonlyArray<AABB>): boolean {
  const p = groundProbe(mover);
  for (const s of solids) {
    if (overlaps(p, s)) {
      return true;
    }
  }
  return false;
}

const PAD = 4;

export function tickZombiePhysics(
  world: World,
  m: MobZombieState,
  dt: number,
  _rng: GeneratorContext,
  solidScratch: AABB[],
  worldTimeSec: number,
  chaseTarget:
    | { x: number; y: number; halfW: number; height: number }
    | null,
): void {
  const wasOnGround = m.onGround;
  m.hurtRemainSec = Math.max(0, m.hurtRemainSec - dt);
  m.damageInvulnRemainSec = Math.max(0, m.damageInvulnRemainSec - dt);

  if (chaseTarget !== null) {
    const dx = chaseTarget.x - m.x;
    const adx = Math.abs(dx);
    const desiredGapPx = ZOMBIE_PREFERRED_GAP_BLOCKS * BLOCK_SIZE;
    const desiredCenterDx =
      chaseTarget.halfW + ZOMBIE_WIDTH_PX * 0.5 + desiredGapPx;
    if (adx <= desiredCenterDx) {
      m.targetVx = 0;
    } else {
      m.targetVx = (dx > 0 ? 1 : -1) * ZOMBIE_CHASE_SPEED_PX;
      m.facingRight = dx > 0;
    }
  } else {
    m.targetVx = 0;
  }

  const inWater = zombieAabbOverlapsWater(world, m);
  m.hitKnockVx *= Math.exp(-ZOMBIE_KNOCKBACK_DECAY_PER_SEC * dt);
  if (Math.abs(m.hitKnockVx) < 3) {
    m.hitKnockVx = 0;
  }
  const baseWalkVx = m.targetVx * (inWater ? ZOMBIE_WATER_SPEED_MULT : 1);
  m.vx = baseWalkVx + m.hitKnockVx;

  if (inWater) {
    m.vy += MOB_GRAVITY_PX * ZOMBIE_WATER_GRAVITY_MULT * dt;
    m.vy -= ZOMBIE_WATER_BUOYANCY_ACCEL_PX * dt;
    if (m.vy > ZOMBIE_WATER_MAX_SINK_SPEED_PX) {
      m.vy = ZOMBIE_WATER_MAX_SINK_SPEED_PX;
    }
    if (m.vy < ZOMBIE_WATER_MAX_UPWARD_SPEED_PX) {
      m.vy = ZOMBIE_WATER_MAX_UPWARD_SPEED_PX;
    }
    m.vy += mobSwimBobVyDelta(m.id, worldTimeSec, dt);
    if (m.vy > ZOMBIE_WATER_MAX_SINK_SPEED_PX) {
      m.vy = ZOMBIE_WATER_MAX_SINK_SPEED_PX;
    }
    if (m.vy < ZOMBIE_WATER_MAX_UPWARD_SPEED_PX) {
      m.vy = ZOMBIE_WATER_MAX_UPWARD_SPEED_PX;
    }
  } else {
    m.vy += MOB_GRAVITY_PX * dt;
    if (m.vy > MOB_TERMINAL_VY_PX) {
      m.vy = MOB_TERMINAL_VY_PX;
    }
  }

  let mover = feetToScreenAABB(m.x, m.y, ZOMBIE_WIDTH_PX, ZOMBIE_HEIGHT_PX);
  const dx = m.vx * dt;
  const dy = m.vy * dt;
  const stepUpMargin = BLOCK_SIZE;
  const query = createAABB(
    Math.min(mover.x, mover.x + dx) - PAD,
    Math.min(mover.y, mover.y + dy) - PAD - stepUpMargin,
    Math.abs(dx) + mover.width + PAD * 2,
    Math.abs(dy) + mover.height + PAD * 2 + stepUpMargin,
  );
  getSolidAABBs(world, query, solidScratch);

  const startMover = { ...mover };
  let { hitX, hitY } = sweepAABB(mover, dx, dy, solidScratch);

  if (hitX && wasOnGround && !inWater && Math.abs(dx) > 1e-4) {
    const stepHeights = [BLOCK_SIZE * 0.5, BLOCK_SIZE];
    for (const stepUp of stepHeights) {
      const retry = { ...startMover };
      sweepAABB(retry, 0, -stepUp, solidScratch);
      const r2 = sweepAABB(retry, dx, dy, solidScratch);
      if (!r2.hitX) {
        mover = retry;
        hitX = r2.hitX;
        hitY = r2.hitY;
        break;
      }
    }
  }

  const feet = screenAABBTofeet(mover, ZOMBIE_WIDTH_PX, ZOMBIE_HEIGHT_PX);
  m.x = feet.x;
  m.y = feet.y;
  if (hitX) {
    m.vx = 0;
    m.targetVx = 0;
  }
  if (hitY) {
    m.vy = 0;
  }
  m.onGround = isOnGround(mover, solidScratch);
  m.inWater = zombieAabbOverlapsWater(world, m);
  if (Math.abs(m.vx) > 0.5) {
    m.facingRight = m.vx > 0;
  }
}

export function applyZombieKnockback(
  m: MobZombieState,
  fromX: number,
  horizontalBasePx: number,
  opts?: { sprintKnockback?: boolean },
): void {
  const r = ZOMBIE_KNOCKBACK_RESISTANCE_PERCENT / 100;
  let h = horizontalBasePx * (1 - r);
  if (opts?.sprintKnockback === true) {
    h *= ZOMBIE_KNOCKBACK_SPRINT_MULT;
  }
  const away = m.x >= fromX ? 1 : -1;
  m.hitKnockVx += away * h;
  const cap = ZOMBIE_KNOCKBACK_HORIZONTAL_CAP_PX;
  m.hitKnockVx = Math.max(-cap, Math.min(cap, m.hitKnockVx));
  m.facingRight = away > 0;
  if (m.onGround && !m.inWater) {
    m.vy -= ZOMBIE_KNOCKBACK_GROUND_VY_PX;
  }
}

export function zombieFeetOverlapPlayerFeet(
  zx: number,
  zy: number,
  px: number,
  py: number,
  playerHalfW: number,
  playerH: number,
): boolean {
  const zLeft = zx - ZOMBIE_WIDTH_PX * 0.5;
  const zRight = zx + ZOMBIE_WIDTH_PX * 0.5;
  const zTop = zy - ZOMBIE_HEIGHT_PX;
  const zBot = zy;
  const pLeft = px - playerHalfW;
  const pRight = px + playerHalfW;
  const pTop = py - playerH;
  const pBot = py;
  return zLeft < pRight && zRight > pLeft && zTop < pBot && zBot > pTop;
}

/**
 * Melee "in range" check (does not require overlapping hitboxes).
 * Uses vertical overlap, plus horizontal distance between hitboxes ≤ preferred gap + small extra reach.
 */
export function zombieFeetInMeleeRangeOfPlayerFeet(
  zx: number,
  zy: number,
  px: number,
  py: number,
  playerHalfW: number,
  playerH: number,
): boolean {
  const zHalfW = ZOMBIE_WIDTH_PX * 0.5;
  const zTop = zy - ZOMBIE_HEIGHT_PX;
  const zBot = zy;
  const pTop = py - playerH;
  const pBot = py;
  const verticalOverlap = zTop < pBot && zBot > pTop;
  if (!verticalOverlap) {
    return false;
  }
  const desiredGapPx =
    (ZOMBIE_PREFERRED_GAP_BLOCKS + ZOMBIE_ATTACK_EXTRA_REACH_BLOCKS) *
    BLOCK_SIZE;
  const centerDx = Math.abs(zx - px);
  return centerDx <= playerHalfW + zHalfW + desiredGapPx;
}
