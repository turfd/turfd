/** Numeric wire ids for {@link MessageType.ENTITY_SPAWN} / ENTITY_STATE. */
export enum MobType {
  None = 0,
  Sheep = 1,
  Pig = 2,
  Zombie = 3,
}

/** Authoritative sheep simulation state (host + offline). */
export type MobSheepState = {
  readonly kind: "sheep";
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  hp: number;
  /** Remaining hurt tint time (seconds); host replicates a short flag to clients. */
  hurtRemainSec: number;
  /** Seconds since last damage was applied (host-only). */
  noDamageSec: number;
  facingRight: boolean;
  targetVx: number;
  panicRemainSec: number;
  panicFlipTimerSec: number;
  wanderTimerSec: number;
  onGround: boolean;
  /** Host sim only: AABB overlaps water (clients may leave false). */
  inWater: boolean;
  /** Dye ordinal 0–15 (Minecraft order); natural spawns use 6 colors only. */
  woolColor: number;
  /** Host sim: horizontal knockback impulse; decays in {@link tickSheepPhysics}. */
  hitKnockVx: number;
  /**
   * Host sim: Java-style post-hit window (~500ms) — further melee hits deal no damage and no knockback.
   */
  damageInvulnRemainSec: number;
  /** Host: seconds left for death tip-over (`0` = alive). Client mirrors replicated remainder. */
  deathAnimRemainSec: number;
  /** False for natural passive spawns so they can distance-despawn like Minecraft. */
  persistent: boolean;
  /** Seconds spent outside the no-despawn radius. */
  despawnFarSec: number;
};

/** Authoritative pig simulation state (host + offline). */
export type MobPigState = {
  readonly kind: "pig";
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  hp: number;
  hurtRemainSec: number;
  /** Seconds since last damage was applied (host-only). */
  noDamageSec: number;
  facingRight: boolean;
  targetVx: number;
  panicRemainSec: number;
  panicFlipTimerSec: number;
  wanderTimerSec: number;
  onGround: boolean;
  inWater: boolean;
  hitKnockVx: number;
  damageInvulnRemainSec: number;
  deathAnimRemainSec: number;
  persistent: boolean;
  despawnFarSec: number;
};

/** Authoritative zombie simulation state (host + offline). */
export type MobZombieState = {
  readonly kind: "zombie";
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  hp: number;
  hurtRemainSec: number;
  noDamageSec: number;
  facingRight: boolean;
  targetVx: number;
  wanderTimerSec: number;
  onGround: boolean;
  inWater: boolean;
  hitKnockVx: number;
  damageInvulnRemainSec: number;
  deathAnimRemainSec: number;
  persistent: boolean;
  despawnFarSec: number;
  /** Seconds until this zombie can damage a player again. */
  attackCooldownRemainSec: number;
  /** Brief swing/hit pose after landing a melee attack (visual only). */
  attackSwingRemainSec: number;
  /** Seconds of fire visual remaining (refreshes while burning in daylight). */
  burnRemainSec: number;
  /** Accumulator for periodic sun-burn damage ticks. */
  burnDamageAccumSec: number;
};
