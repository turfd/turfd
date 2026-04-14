import { BLOCK_SIZE } from "../../core/constants";
import type { World } from "../../world/World";
import { getSolidAABBs } from "../physics/Collision";
import { createAABB, overlaps, sweepAABB, type AABB } from "../physics/AABB";
import type { GeneratorContext } from "../../world/gen/GeneratorContext";
import {
  MOB_GRAVITY_PX,
  MOB_TERMINAL_VY_PX,
  SLIME_HEIGHT_PX,
  SLIME_WIDTH_PX,
  SLIME_JUMP_COOLDOWN_SEC,
  SLIME_JUMP_PRIME_SEC,
  SLIME_JUMP_VX_PX,
  SLIME_JUMP_VY_PX,
  SLIME_KNOCKBACK_DECAY_PER_SEC,
  SLIME_KNOCKBACK_GROUND_VY_PX,
  SLIME_KNOCKBACK_HORIZONTAL_CAP_PX,
  SLIME_KNOCKBACK_RESISTANCE_PERCENT,
  SLIME_KNOCKBACK_SPRINT_MULT,
  SLIME_PANIC_DURATION_SEC,
  SLIME_PANIC_FLIP_INTERVAL_SEC,
  SLIME_PANIC_SPEED_PX,
  SLIME_WATER_BUOYANCY_ACCEL_PX,
  SLIME_WATER_GRAVITY_MULT,
  SLIME_WATER_MAX_SINK_SPEED_PX,
  SLIME_WATER_MAX_UPWARD_SPEED_PX,
  SLIME_WATER_SPEED_MULT,
  SLIME_PHYSICS_CLAMP_VX_PX,
  SLIME_PHYSICS_CLAMP_VY_DOWN_PX,
  SLIME_PHYSICS_CLAMP_VY_UP_PX,
  ZOMBIE_ATTACK_EXTRA_REACH_BLOCKS,
  ZOMBIE_PREFERRED_GAP_BLOCKS,
} from "./mobConstants";
import type { MobSlimeState } from "./mobTypes";

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

function slimeAabbOverlapsWater(world: World, pos: { x: number; y: number }): boolean {
  if (!world.getRegistry().isRegistered("stratum:water")) {
    return false;
  }
  const waterId = world.getWaterBlockId();
  const region = feetToScreenAABB(pos.x, pos.y, SLIME_WIDTH_PX, SLIME_HEIGHT_PX);
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

export function tickSlimePhysics(
  world: World,
  m: MobSlimeState,
  dt: number,
  rng: GeneratorContext,
  solidScratch: AABB[],
  chaseTarget:
    | { x: number; y: number; halfW: number; height: number }
    | null,
): void {
  const wasOnGround = m.onGround;
  m.hurtRemainSec = Math.max(0, m.hurtRemainSec - dt);
  m.damageInvulnRemainSec = Math.max(0, m.damageInvulnRemainSec - dt);
  m.panicRemainSec = Math.max(0, m.panicRemainSec - dt);
  m.slimeJumpCooldownRemainSec = Math.max(0, m.slimeJumpCooldownRemainSec - dt);

  let moveSign = 0;
  if (m.panicRemainSec > 0) {
    m.panicFlipTimerSec -= dt;
    if (m.panicFlipTimerSec <= 0) {
      m.panicFlipTimerSec = SLIME_PANIC_FLIP_INTERVAL_SEC;
      m.facingRight = rng.nextFloat() < 0.5;
    }
    moveSign = m.facingRight ? 1 : -1;
    m.targetVx = moveSign * SLIME_PANIC_SPEED_PX;
  } else if (chaseTarget !== null) {
    const dx = chaseTarget.x - m.x;
    const adx = Math.abs(dx);
    const desiredGapPx = ZOMBIE_PREFERRED_GAP_BLOCKS * BLOCK_SIZE;
    const desiredCenterDx =
      chaseTarget.halfW + SLIME_WIDTH_PX * 0.5 + desiredGapPx;
    if (adx <= desiredCenterDx) {
      m.targetVx = 0;
      moveSign = 0;
    } else {
      moveSign = dx > 0 ? 1 : -1;
      m.targetVx = moveSign * SLIME_JUMP_VX_PX;
      m.facingRight = dx > 0;
    }
  } else {
    m.targetVx = 0;
    moveSign = 0;
  }

  const inWater = slimeAabbOverlapsWater(world, m);

  if (inWater) {
    m.slimeJumpPriming = false;
    m.slimeJumpPrimeElapsedSec = 0;
    m.slimeAirHorizVx = 0;
  } else if (m.onGround) {
    const wantHop =
      m.slimeJumpCooldownRemainSec <= 0 &&
      moveSign !== 0 &&
      Math.abs(m.hitKnockVx) < 40;
    if (wantHop && !m.slimeJumpPriming) {
      m.slimeJumpPriming = true;
      m.slimeJumpPrimeElapsedSec = 0;
      m.slimeJumpDir = moveSign;
    }
    if (m.slimeJumpPriming) {
      if (moveSign === 0 && m.panicRemainSec <= 0) {
        m.slimeJumpPriming = false;
        m.slimeJumpPrimeElapsedSec = 0;
      } else {
        if (m.panicRemainSec > 0) {
          m.slimeJumpDir = moveSign;
        }
        m.slimeJumpPrimeElapsedSec += dt;
        if (m.slimeJumpPrimeElapsedSec >= SLIME_JUMP_PRIME_SEC) {
          m.slimeJumpPriming = false;
          m.slimeJumpPrimeElapsedSec = 0;
          m.vy = -SLIME_JUMP_VY_PX;
          m.slimeAirHorizVx = m.slimeJumpDir * SLIME_JUMP_VX_PX;
          m.facingRight = m.slimeJumpDir > 0;
        }
      }
    }
  }

  m.hitKnockVx *= Math.exp(-SLIME_KNOCKBACK_DECAY_PER_SEC * dt);
  if (Math.abs(m.hitKnockVx) < 3) {
    m.hitKnockVx = 0;
  }

  if (inWater) {
    m.vx = m.targetVx * SLIME_WATER_SPEED_MULT + m.hitKnockVx;
    m.vy += MOB_GRAVITY_PX * SLIME_WATER_GRAVITY_MULT * dt;
    m.vy -= SLIME_WATER_BUOYANCY_ACCEL_PX * dt;
    if (m.vy > SLIME_WATER_MAX_SINK_SPEED_PX) {
      m.vy = SLIME_WATER_MAX_SINK_SPEED_PX;
    }
    if (m.vy < SLIME_WATER_MAX_UPWARD_SPEED_PX) {
      m.vy = SLIME_WATER_MAX_UPWARD_SPEED_PX;
    }
  } else {
    // Wind-up: no horizontal drift.
    if (m.onGround && m.slimeJumpPriming) {
      m.vx = m.hitKnockVx;
    } else if (
      m.onGround &&
      Math.abs(m.slimeAirHorizVx) < 1e-3 &&
      m.vy >= -1e-3
    ) {
      // Idle on floor — clear arc velocity. Do NOT clear `slimeAirHorizVx` on the same tick we
      // just applied jump impulse: feet are still grounded until after the sweep.
      m.vx = m.hitKnockVx;
      m.slimeAirHorizVx = 0;
    } else {
      m.vx = m.slimeAirHorizVx + m.hitKnockVx;
    }
    m.vy += MOB_GRAVITY_PX * dt;
    if (m.vy > MOB_TERMINAL_VY_PX) {
      m.vy = MOB_TERMINAL_VY_PX;
    }
  }

  if (
    !Number.isFinite(m.vx) ||
    !Number.isFinite(m.vy) ||
    !Number.isFinite(m.slimeAirHorizVx) ||
    !Number.isFinite(m.hitKnockVx)
  ) {
    m.vx = 0;
    m.vy = 0;
    m.slimeAirHorizVx = 0;
    m.hitKnockVx = 0;
  } else {
    const capX = SLIME_PHYSICS_CLAMP_VX_PX;
    m.vx = Math.max(-capX, Math.min(capX, m.vx));
    m.slimeAirHorizVx = Math.max(-capX, Math.min(capX, m.slimeAirHorizVx));
    m.hitKnockVx = Math.max(
      -SLIME_KNOCKBACK_HORIZONTAL_CAP_PX,
      Math.min(SLIME_KNOCKBACK_HORIZONTAL_CAP_PX, m.hitKnockVx),
    );
    m.vy = Math.max(
      -SLIME_PHYSICS_CLAMP_VY_UP_PX,
      Math.min(SLIME_PHYSICS_CLAMP_VY_DOWN_PX, m.vy),
    );
  }

  let mover = feetToScreenAABB(m.x, m.y, SLIME_WIDTH_PX, SLIME_HEIGHT_PX);
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

  // Step onto low ledges when blocked horizontally — including mid-jump so hops can clear 1-block
  // steps (same heights as ground approach; `wasOnGround` alone would cancel this while airborne).
  if (hitX && !inWater && Math.abs(dx) > 1e-4) {
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

  const feet = screenAABBTofeet(mover, SLIME_WIDTH_PX, SLIME_HEIGHT_PX);
  m.x = feet.x;
  m.y = feet.y;
  if (hitX) {
    m.vx = 0;
    m.slimeAirHorizVx = 0;
    m.targetVx = 0;
  }
  if (hitY) {
    m.vy = 0;
  }
  m.onGround = isOnGround(mover, solidScratch);
  m.inWater = slimeAabbOverlapsWater(world, m);

  if (!wasOnGround && m.onGround && !inWater) {
    m.slimeAirHorizVx = 0;
    // Kill residual horizontal knock so the slime does not “skate” backward/forward on impact;
    // air arc already ended — small `hitKnockVx` was reading as an odd ground slide.
    m.hitKnockVx = 0;
    m.vx = 0;
    m.slimeJumpCooldownRemainSec = Math.max(
      m.slimeJumpCooldownRemainSec,
      SLIME_JUMP_COOLDOWN_SEC,
    );
    m.slimeJumpPriming = false;
    m.slimeJumpPrimeElapsedSec = 0;
  }

  if (!m.onGround) {
    const h = m.slimeAirHorizVx + m.hitKnockVx;
    if (Math.abs(h) > 0.5) {
      m.facingRight = h > 0;
    }
  }
}

export function applySlimePanic(m: MobSlimeState, fromX: number): void {
  m.panicRemainSec = SLIME_PANIC_DURATION_SEC;
  m.panicFlipTimerSec = 0;
  const away = m.x >= fromX ? 1 : -1;
  m.facingRight = away > 0;
  m.targetVx = away * SLIME_PANIC_SPEED_PX;
  m.slimeJumpPriming = false;
  m.slimeJumpPrimeElapsedSec = 0;
}

export function applySlimeKnockback(
  m: MobSlimeState,
  fromX: number,
  horizontalBasePx: number,
  opts?: { sprintKnockback?: boolean },
): void {
  const r = SLIME_KNOCKBACK_RESISTANCE_PERCENT / 100;
  let h = horizontalBasePx * (1 - r);
  if (opts?.sprintKnockback === true) {
    h *= SLIME_KNOCKBACK_SPRINT_MULT;
  }
  const away = m.x >= fromX ? 1 : -1;
  m.hitKnockVx += away * h;
  const cap = SLIME_KNOCKBACK_HORIZONTAL_CAP_PX;
  m.hitKnockVx = Math.max(-cap, Math.min(cap, m.hitKnockVx));
  m.facingRight = away > 0;
  m.slimeJumpPriming = false;
  m.slimeJumpPrimeElapsedSec = 0;
  if (m.onGround && !m.inWater) {
    m.vy -= SLIME_KNOCKBACK_GROUND_VY_PX;
  }
}

/**
 * Same melee reach model as {@link zombieFeetInMeleeRangeOfPlayerFeet}, using the slime combat
 * hitbox so attacks line up with zombie spacing.
 */
export function slimeFeetInMeleeRangeOfPlayerFeet(
  sx: number,
  sy: number,
  px: number,
  py: number,
  playerHalfW: number,
  playerH: number,
): boolean {
  const sHalfW = SLIME_WIDTH_PX * 0.5;
  const sTop = sy - SLIME_HEIGHT_PX;
  const sBot = sy;
  const pTop = py - playerH;
  const pBot = py;
  const verticalOverlap = sTop < pBot && sBot > pTop;
  if (!verticalOverlap) {
    return false;
  }
  const desiredGapPx =
    (ZOMBIE_PREFERRED_GAP_BLOCKS + ZOMBIE_ATTACK_EXTRA_REACH_BLOCKS) * BLOCK_SIZE;
  const centerDx = Math.abs(sx - px);
  return centerDx <= playerHalfW + sHalfW + desiredGapPx;
}
