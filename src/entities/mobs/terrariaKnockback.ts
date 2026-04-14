/**
 * Host mob knockback modeled on Terraria `StrikeNPC` (wiki.gg/Knockback, Desktop 1.4.3.6 reference).
 * Knockback stat is dimensionless (tooltip scale ~0–20); we map to px/s via
 * {@link TERRARIA_KNOCKBACK_TO_HORIZONTAL_PX}.
 */
import {
  DUCK_KNOCKBACK_HORIZONTAL_CAP_PX,
  DUCK_KNOCKBACK_RESISTANCE_PERCENT,
  DUCK_MAX_HEALTH,
  PIG_KNOCKBACK_HORIZONTAL_CAP_PX,
  PIG_KNOCKBACK_RESISTANCE_PERCENT,
  PIG_MAX_HEALTH,
  SHEEP_KNOCKBACK_HORIZONTAL_CAP_PX,
  SHEEP_KNOCKBACK_RESISTANCE_PERCENT,
  SHEEP_MAX_HEALTH,
  SLIME_KNOCKBACK_HORIZONTAL_CAP_PX,
  SLIME_KNOCKBACK_RESISTANCE_PERCENT,
  SLIME_MAX_HEALTH,
  ZOMBIE_KNOCKBACK_HORIZONTAL_CAP_PX,
  ZOMBIE_KNOCKBACK_RESISTANCE_PERCENT,
  ZOMBIE_MAX_HEALTH,
} from "./mobConstants";
import type {
  MobDuckState,
  MobPigState,
  MobSheepState,
  MobSlimeState,
  MobZombieState,
} from "./mobTypes";

/** Strong hit when damage dealt > maxHp / divisor (Terraria: 10 normal, 15 Expert). */
export const TERRARIA_STRONG_HIT_MAX_HP_DIVISOR_NORMAL = 10;
export const TERRARIA_STRONG_HIT_MAX_HP_DIVISOR_EXPERT = 15;
/** When `true`, use Expert strong-hit divisor and Expert tuning elsewhere. */
export const TERRARIA_EXPERT_MODE = false;

/** Terraria vertical multiplier for “floating” targets (airborne slimes). */
export const TERRARIA_KB_FLOATING_VERT_MULT = 0.5;
/** Terraria vertical multiplier for grounded / non-floating targets. */
export const TERRARIA_KB_GROUNDED_VERT_MULT = 0.75;

/**
 * Maps processed knockback `k` (after resist, caps, crit) to horizontal px/s scale used in
 * strong/weak velocity formulas.
 */
export const TERRARIA_KNOCKBACK_TO_HORIZONTAL_PX = 52;

/**
 * Extra scale on vertical impulse: `k * horizontalScale * vertMult * this` (subtracted from `vy`).
 */
export const TERRARIA_KNOCKBACK_VERTICAL_SCALE = 0.62;

export type TerrariaMobStrike =
  | {
      style: "melee";
      baseKnockback: number;
    }
  | {
      style: "projectile";
      baseKnockback: number;
      /** World +X sense: direction the strike pushes the mob. */
      knockDir: 1 | -1;
    };

export function mobMaxHpForStrike(kind: "sheep" | "pig" | "duck" | "zombie" | "slime"): number {
  switch (kind) {
    case "sheep":
      return SHEEP_MAX_HEALTH;
    case "pig":
      return PIG_MAX_HEALTH;
    case "duck":
      return DUCK_MAX_HEALTH;
    case "zombie":
      return ZOMBIE_MAX_HEALTH;
    case "slime":
      return SLIME_MAX_HEALTH;
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

function mobKnockbackResist(kind: "sheep" | "pig" | "duck" | "zombie" | "slime"): number {
  switch (kind) {
    case "sheep":
      return SHEEP_KNOCKBACK_RESISTANCE_PERCENT / 100;
    case "pig":
      return PIG_KNOCKBACK_RESISTANCE_PERCENT / 100;
    case "duck":
      return DUCK_KNOCKBACK_RESISTANCE_PERCENT / 100;
    case "zombie":
      return ZOMBIE_KNOCKBACK_RESISTANCE_PERCENT / 100;
    case "slime":
      return SLIME_KNOCKBACK_RESISTANCE_PERCENT / 100;
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

function mobHitKnockCapPx(kind: "sheep" | "pig" | "duck" | "zombie" | "slime"): number {
  switch (kind) {
    case "sheep":
      return SHEEP_KNOCKBACK_HORIZONTAL_CAP_PX;
    case "pig":
      return PIG_KNOCKBACK_HORIZONTAL_CAP_PX;
    case "duck":
      return DUCK_KNOCKBACK_HORIZONTAL_CAP_PX;
    case "zombie":
      return ZOMBIE_KNOCKBACK_HORIZONTAL_CAP_PX;
    case "slime":
      return SLIME_KNOCKBACK_HORIZONTAL_CAP_PX;
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

/**
 * Terraria wiki order: resist → Cursed Inferno → soft caps → hard 16 → crit ×1.4.
 */
export function terrariaProcessKnockbackStat(
  baseKnockback: number,
  knockbackResist: number,
  cursedInferno: boolean,
  isCrit: boolean,
): number {
  let knockBack = baseKnockback * (1 - knockbackResist);
  if (cursedInferno) {
    knockBack *= 1.1;
  }
  if (knockBack > 8.0) {
    knockBack = 8 + (knockBack - 8.0) * 0.9;
  }
  if (knockBack > 10.0) {
    knockBack = 10 + (knockBack - 10.0) * 0.8;
  }
  if (knockBack > 12.0) {
    knockBack = 12 + (knockBack - 12.0) * 0.7;
  }
  if (knockBack > 14.0) {
    knockBack = 14 + (knockBack - 14.0) * 0.6;
  }
  if (knockBack > 16.0) {
    knockBack = 16;
  }
  if (isCrit) {
    knockBack *= 1.4;
  }
  return knockBack;
}

function terrariaStrikeHorizontalVelocity(
  currentHitKnockVx: number,
  knockDir: 1 | -1,
  k: number,
  resist: number,
  strongHit: boolean,
  scale: number,
): number {
  if (strongHit) {
    let vx = currentHitKnockVx + knockDir * (2 * k * scale);
    const cap = k * scale;
    if (knockDir > 0) {
      if (vx > cap) {
        vx = cap;
      }
    } else if (vx < -cap) {
      vx = -cap;
    }
    return vx;
  }
  return knockDir * (k * scale * (1 - resist));
}

export function applyTerrariaKnockbackToHostMob(
  m: MobSheepState | MobPigState | MobDuckState | MobZombieState | MobSlimeState,
  strike: TerrariaMobStrike,
  damageDealt: number,
  isCrit: boolean,
  attackerFeetX: number,
): void {
  const kind = m.kind;
  const resist = mobKnockbackResist(kind);
  const maxHp = mobMaxHpForStrike(kind);
  /** Push away from the attacker (same sense as legacy `applySheepKnockback` / Java melee). */
  const knockDir: 1 | -1 =
    strike.style === "melee"
      ? m.x >= attackerFeetX
        ? 1
        : -1
      : strike.knockDir;

  const k = terrariaProcessKnockbackStat(
    strike.baseKnockback,
    resist,
    false,
    isCrit,
  );
  const strongHitDivisor = TERRARIA_EXPERT_MODE
    ? TERRARIA_STRONG_HIT_MAX_HP_DIVISOR_EXPERT
    : TERRARIA_STRONG_HIT_MAX_HP_DIVISOR_NORMAL;
  const strong = damageDealt > maxHp / strongHitDivisor;
  const H = TERRARIA_KNOCKBACK_TO_HORIZONTAL_PX;
  const floatingEnemy = kind === "slime" && !m.onGround;
  const vertMult = floatingEnemy ? TERRARIA_KB_FLOATING_VERT_MULT : TERRARIA_KB_GROUNDED_VERT_MULT;

  m.hitKnockVx = terrariaStrikeHorizontalVelocity(
    m.hitKnockVx,
    knockDir,
    k,
    resist,
    strong,
    H,
  );
  const cap = mobHitKnockCapPx(kind);
  m.hitKnockVx = Math.max(-cap, Math.min(cap, m.hitKnockVx));
  m.facingRight = knockDir > 0;

  if (kind === "slime") {
    m.slimeJumpPriming = false;
    m.slimeJumpPrimeElapsedSec = 0;
  }

  const grounded = m.onGround && !m.inWater;
  if (grounded) {
    const vertImpulse = k * H * vertMult * TERRARIA_KNOCKBACK_VERTICAL_SCALE;
    if (strong) {
      let add = 2 * vertImpulse;
      if (add > vertImpulse) {
        add = vertImpulse;
      }
      m.vy -= add;
    } else {
      m.vy -= vertImpulse * (1 - resist);
    }
  }
}

/** Map legacy high arrow kb numbers into the Terraria knockback stat range before `StrikeNPC` math. */
export function terrariaArrowBaseKnockbackFromLegacyPx(legacyKbPx: number): number {
  const t = legacyKbPx / 70;
  return Math.max(0, Math.min(16, t));
}
