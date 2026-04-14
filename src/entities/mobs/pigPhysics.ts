import { BLOCK_SIZE } from "../../core/constants";
import type { World } from "../../world/World";
import { getSolidAABBs } from "../physics/Collision";
import { createAABB, overlaps, sweepAABB, type AABB } from "../physics/AABB";
import type { GeneratorContext } from "../../world/gen/GeneratorContext";
import {
  MOB_GRAVITY_PX,
  MOB_TERMINAL_VY_PX,
  PIG_HEIGHT_PX,
  PIG_KNOCKBACK_DECAY_PER_SEC,
  PIG_KNOCKBACK_GROUND_VY_PX,
  PIG_KNOCKBACK_HORIZONTAL_CAP_PX,
  PIG_KNOCKBACK_RESISTANCE_PERCENT,
  PIG_KNOCKBACK_SPRINT_MULT,
  PIG_PANIC_DURATION_SEC,
  PIG_PANIC_FLIP_INTERVAL_SEC,
  PIG_PANIC_SPEED_PX,
  PIG_WALK_SPEED_PX,
  PIG_WANDER_INTERVAL_SEC_MAX,
  PIG_WANDER_INTERVAL_SEC_MIN,
  PIG_WATER_BUOYANCY_ACCEL_PX,
  PIG_WATER_GRAVITY_MULT,
  PIG_WATER_MAX_SINK_SPEED_PX,
  PIG_WATER_MAX_UPWARD_SPEED_PX,
  PIG_WATER_SPEED_MULT,
  PIG_WIDTH_PX,
  mobSwimBobVyDelta,
} from "./mobConstants";
import type { MobPigState } from "./mobTypes";

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

function pigAabbOverlapsWater(world: World, pos: { x: number; y: number }): boolean {
  if (!world.getRegistry().isRegistered("stratum:water")) {
    return false;
  }
  const waterId = world.getWaterBlockId();
  const region = feetToScreenAABB(pos.x, pos.y, PIG_WIDTH_PX, PIG_HEIGHT_PX);
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

export function tickPigPhysics(
  world: World,
  m: MobPigState,
  dt: number,
  rng: GeneratorContext,
  solidScratch: AABB[],
  worldTimeSec: number,
): void {
  const wasOnGround = m.onGround;
  m.hurtRemainSec = Math.max(0, m.hurtRemainSec - dt);
  m.damageInvulnRemainSec = Math.max(0, m.damageInvulnRemainSec - dt);
  m.panicRemainSec = Math.max(0, m.panicRemainSec - dt);
  m.wanderTimerSec -= dt;
  if (m.panicRemainSec > 0) {
    m.panicFlipTimerSec -= dt;
    if (m.panicFlipTimerSec <= 0) {
      m.panicFlipTimerSec = PIG_PANIC_FLIP_INTERVAL_SEC;
      m.facingRight = rng.nextFloat() < 0.5;
    }
    m.targetVx = (m.facingRight ? 1 : -1) * PIG_PANIC_SPEED_PX;
  } else if (m.wanderTimerSec <= 0) {
    m.wanderTimerSec =
      PIG_WANDER_INTERVAL_SEC_MIN +
      rng.nextFloat() * (PIG_WANDER_INTERVAL_SEC_MAX - PIG_WANDER_INTERVAL_SEC_MIN);
    const roll = rng.nextFloat();
    if (roll < 0.35) {
      m.targetVx = 0;
    } else {
      m.targetVx = (rng.nextFloat() < 0.5 ? -1 : 1) * PIG_WALK_SPEED_PX;
      m.facingRight = m.targetVx > 0;
    }
  }

  const inWater = pigAabbOverlapsWater(world, m);
  m.hitKnockVx *= Math.exp(-PIG_KNOCKBACK_DECAY_PER_SEC * dt);
  if (Math.abs(m.hitKnockVx) < 3) {
    m.hitKnockVx = 0;
  }
  const baseWalkVx = m.targetVx * (inWater ? PIG_WATER_SPEED_MULT : 1);
  m.vx = baseWalkVx + m.hitKnockVx;

  if (inWater) {
    m.vy += MOB_GRAVITY_PX * PIG_WATER_GRAVITY_MULT * dt;
    m.vy -= PIG_WATER_BUOYANCY_ACCEL_PX * dt;
    if (m.vy > PIG_WATER_MAX_SINK_SPEED_PX) {
      m.vy = PIG_WATER_MAX_SINK_SPEED_PX;
    }
    if (m.vy < PIG_WATER_MAX_UPWARD_SPEED_PX) {
      m.vy = PIG_WATER_MAX_UPWARD_SPEED_PX;
    }
    m.vy += mobSwimBobVyDelta(m.id, worldTimeSec, dt);
    if (m.vy > PIG_WATER_MAX_SINK_SPEED_PX) {
      m.vy = PIG_WATER_MAX_SINK_SPEED_PX;
    }
    if (m.vy < PIG_WATER_MAX_UPWARD_SPEED_PX) {
      m.vy = PIG_WATER_MAX_UPWARD_SPEED_PX;
    }
  } else {
    m.vy += MOB_GRAVITY_PX * dt;
    if (m.vy > MOB_TERMINAL_VY_PX) {
      m.vy = MOB_TERMINAL_VY_PX;
    }
  }

  let mover = feetToScreenAABB(m.x, m.y, PIG_WIDTH_PX, PIG_HEIGHT_PX);
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

  const feet = screenAABBTofeet(mover, PIG_WIDTH_PX, PIG_HEIGHT_PX);
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
  m.inWater = pigAabbOverlapsWater(world, m);
  if (Math.abs(m.vx) > 0.5) {
    m.facingRight = m.vx > 0;
  }
}

export function applyPigPanic(m: MobPigState, fromX: number): void {
  m.panicRemainSec = PIG_PANIC_DURATION_SEC;
  m.panicFlipTimerSec = 0;
  const away = m.x >= fromX ? 1 : -1;
  m.facingRight = away > 0;
  m.targetVx = away * PIG_PANIC_SPEED_PX;
}

export function applyPigKnockback(
  m: MobPigState,
  fromX: number,
  horizontalBasePx: number,
  opts?: { sprintKnockback?: boolean },
): void {
  const r = PIG_KNOCKBACK_RESISTANCE_PERCENT / 100;
  let h = horizontalBasePx * (1 - r);
  if (opts?.sprintKnockback === true) {
    h *= PIG_KNOCKBACK_SPRINT_MULT;
  }
  const away = m.x >= fromX ? 1 : -1;
  m.hitKnockVx += away * h;
  const cap = PIG_KNOCKBACK_HORIZONTAL_CAP_PX;
  m.hitKnockVx = Math.max(-cap, Math.min(cap, m.hitKnockVx));
  m.facingRight = away > 0;
  if (m.onGround && !m.inWater) {
    m.vy -= PIG_KNOCKBACK_GROUND_VY_PX;
  }
}
