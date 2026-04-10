import {
  BLOCK_SIZE,
  DAWN_LENGTH_MS,
  DAYLIGHT_LENGTH_MS,
  DAY_LENGTH_MS,
  DUSK_LENGTH_MS,
  PLAYER_HEIGHT,
  PLAYER_SPRINT_SPEED_PX,
  PLAYER_WALK_SPEED_PX,
  PLAYER_WIDTH,
  VIEW_DISTANCE_CHUNKS,
} from "../../core/constants";

/**
 * Sprite sheet has ~4px transparent padding below the hooves; nudge Pixi Y so feet align with physics.
 */
export const SHEEP_FEET_SPRITE_NUDGE_Y_PX = 4;

/** One animation cell in `sheep.png` (192×64 atlas: 6 walk frames × 32px, two rows). */
export const SHEEP_FRAME_TEXEL_W = 32;
export const SHEEP_FRAME_TEXEL_H = 32;

/**
 * World-space height target for the trimmed body (texture rows above foot padding). Drives render
 * scale together with {@link SHEEP_RENDER_SCALE_MULT} — not the hitbox size.
 */
export const SHEEP_BODY_TRIM_TARGET_PX = 22;

/** Must match {@link EntityManager} sheep `scaleMult`. */
export const SHEEP_RENDER_SCALE_MULT = 1.5;

const _sheepTrimTexels = Math.max(
  1,
  SHEEP_FRAME_TEXEL_H - SHEEP_FEET_SPRITE_NUDGE_Y_PX,
);
const _sheepWorldScale =
  (SHEEP_BODY_TRIM_TARGET_PX / _sheepTrimTexels) * SHEEP_RENDER_SCALE_MULT;

/** Hitbox (world px) matches on-screen sprite bounds; feet at (x, y). */
export const SHEEP_WIDTH_PX = SHEEP_FRAME_TEXEL_W * _sheepWorldScale;
export const SHEEP_HEIGHT_PX = SHEEP_FRAME_TEXEL_H * _sheepWorldScale;

/** Horizontal drift in water (matches passive mob slowdown). */
export const SHEEP_WATER_SPEED_MULT = 0.42;
/** Weaker gravity while submerged. */
export const SHEEP_WATER_GRAVITY_MULT = 0.22;
/** Upward acceleration so sheep bob toward the surface instead of sinking. */
export const SHEEP_WATER_BUOYANCY_ACCEL_PX = 260;
export const SHEEP_WATER_MAX_SINK_SPEED_PX = 95;
/** Negative = upward in world space (same sign as {@link Player} water swim). */
export const SHEEP_WATER_MAX_UPWARD_SPEED_PX = -78;

export const SHEEP_MAX_HEALTH = 6;
/** Melee damage per hit (1 heart = 2 HP in UI terms; here integer HP). */
export const SHEEP_MELEE_DAMAGE = 1;

export const SHEEP_WALK_FRAMES = 6;
export const SHEEP_IDLE_FRAMES = 4;

/** Sprite sheet: top row = walk, bottom = idle (see `textures/entities/sheep.png`). */
export const SHEEP_SPRITE_REL = "entities/sheep.png";
/** Same frame layout as {@link SHEEP_SPRITE_REL}; wool pixels are black (masked for tint). */
export const SHEEP_MASK_SPRITE_REL = "entities/sheep_mask.png";

export const PIG_FEET_SPRITE_NUDGE_Y_PX = 4;
export const PIG_FRAME_TEXEL_W = 32;
export const PIG_FRAME_TEXEL_H = 32;
export const PIG_BODY_TRIM_TARGET_PX = 22;
export const PIG_RENDER_SCALE_MULT = 1.5;

/** Pig physics hitbox size (world px), centered on feet X with feet at bottom. */
export const PIG_WIDTH_PX = 18;
export const PIG_HEIGHT_PX = 14;
export const PIG_WATER_SPEED_MULT = 0.42;
export const PIG_WATER_GRAVITY_MULT = 0.22;
export const PIG_WATER_BUOYANCY_ACCEL_PX = 260;
export const PIG_WATER_MAX_SINK_SPEED_PX = 95;
export const PIG_WATER_MAX_UPWARD_SPEED_PX = -78;
export const PIG_MAX_HEALTH = 6;
export const PIG_MELEE_DAMAGE = 1;
export const PIG_WALK_FRAMES = 6;
export const PIG_IDLE_FRAMES = 4;
export const PIG_SPRITE_REL = "entities/pig.png";
export const PIG_WALK_SPEED_PX = 52;
export const PIG_PANIC_SPEED_PX = PLAYER_SPRINT_SPEED_PX;
export const PIG_PANIC_DURATION_SEC = 2.8;
export const PIG_WANDER_INTERVAL_SEC_MIN = 1.2;
export const PIG_WANDER_INTERVAL_SEC_MAX = 3.5;
export const PIG_PANIC_FLIP_INTERVAL_SEC = 0.35;
export const PIG_KNOCKBACK_HAND_PX = 52;
export const PIG_KNOCKBACK_SPRINT_MULT = 1.22;
export const PIG_KNOCKBACK_GROUND_VY_PX = 64;
export const PIG_KNOCKBACK_RESISTANCE_PERCENT = 0;
export const PIG_KNOCKBACK_DECAY_PER_SEC = 12;
export const PIG_KNOCKBACK_HORIZONTAL_CAP_PX = 132;
export const PIG_DAMAGE_INVULN_SEC = 0.5;
export const PIG_DEATH_ANIM_SEC = 0.82;
export const PIG_MAX_PER_COLUMN = 2;
export const PIG_SPAWN_MIN_COMBINED_LIGHT = 7;

/** Zombies use the same feet hitbox as the local player for parity with the player-shaped sprite. */
export const ZOMBIE_WIDTH_PX = PLAYER_WIDTH;
export const ZOMBIE_HEIGHT_PX = PLAYER_HEIGHT;
/** Match {@link PLAYER_WALK_SPEED_PX}. */
export const ZOMBIE_CHASE_SPEED_PX = PLAYER_WALK_SPEED_PX * 0.65;
/**
 * Minecraft-ish melee spacing: zombies try to stop with their hitbox about this far from the
 * player's hitbox (measured as extra gap beyond touching AABBs).
 */
export const ZOMBIE_PREFERRED_GAP_BLOCKS = 0.5;
/**
 * Allow a tiny bit of extra reach beyond the preferred gap so attacks can land without requiring
 * hitbox overlap (feels closer to Minecraft melee).
 */
export const ZOMBIE_ATTACK_EXTRA_REACH_BLOCKS = 0.15;
export const ZOMBIE_WATER_SPEED_MULT = 0.42;
export const ZOMBIE_WATER_GRAVITY_MULT = 0.22;
export const ZOMBIE_WATER_BUOYANCY_ACCEL_PX = 260;
export const ZOMBIE_WATER_MAX_SINK_SPEED_PX = 95;
export const ZOMBIE_WATER_MAX_UPWARD_SPEED_PX = -78;
export const ZOMBIE_MAX_HEALTH = 20;
/** Damage to players per melee hit (integer HP). */
export const ZOMBIE_ATTACK_DAMAGE = 2;
export const ZOMBIE_ATTACK_INTERVAL_SEC = 0.9;
/** Visual-only: how long zombies hold their swing/hit pose after attacking. */
export const ZOMBIE_ATTACK_SWING_VISUAL_SEC = 0.22;
export const ZOMBIE_SUN_BURN_MIN_SKY_LIGHT = 14;
export const ZOMBIE_SUN_BURN_DAMAGE_PER_TICK = 1;
export const ZOMBIE_SUN_BURN_DAMAGE_INTERVAL_SEC = 0.5;
export const ZOMBIE_SUN_BURN_VISUAL_REFRESH_SEC = 0.25;
export const ZOMBIE_KNOCKBACK_DECAY_PER_SEC = 12;
export const ZOMBIE_KNOCKBACK_GROUND_VY_PX = 64;
export const ZOMBIE_KNOCKBACK_RESISTANCE_PERCENT = 0;
export const ZOMBIE_KNOCKBACK_SPRINT_MULT = 1.22;
export const ZOMBIE_KNOCKBACK_HORIZONTAL_CAP_PX = 132;
export const ZOMBIE_DAMAGE_INVULN_SEC = 0.5;
export const ZOMBIE_DEATH_ANIM_SEC = 0.82;
export const ZOMBIE_MAX_PER_COLUMN = 3;
/** Hostile-style cap: natural spawns only when combined light at mob cell is at or below this. */
export const ZOMBIE_SPAWN_MAX_COMBINED_LIGHT = 7;
/** Feet sprite nudge (player atlas has foot padding similar to pig/sheep sheets). */
export const ZOMBIE_FEET_SPRITE_NUDGE_Y_PX = 4;

/**
 * `textures/entities/zombie.png` — same strip layout as the player body atlas
 * (7× 20×40 cells: idle, walk×4, jump, break).
 */
export const ZOMBIE_SPRITE_REL = "entities/zombie.png";

/** Mobs inside this radius never distance-despawn. */
export const MOB_NO_DESPAWN_RADIUS_BLOCKS = 32;
/** Mobs beyond this radius despawn immediately. */
export const MOB_IMMEDIATE_DESPAWN_RADIUS_BLOCKS = 128;
/** Start random despawn checks after spending this long outside the safe radius. */
export const MOB_RANDOM_DESPAWN_DELAY_SEC = 30;
/** Average extra time until a mid-range despawn once eligible. */
export const MOB_RANDOM_DESPAWN_AVG_SEC = 40;

export const MOB_GRAVITY_PX = 640;
export const MOB_TERMINAL_VY_PX = 480;

export const SHEEP_WALK_SPEED_PX = 52;
/** Matches local player ground sprint ({@link PLAYER_SPRINT_SPEED_PX}). */
export const SHEEP_PANIC_SPEED_PX = PLAYER_SPRINT_SPEED_PX;
export const SHEEP_PANIC_DURATION_SEC = 2.8;
export const SHEEP_WANDER_INTERVAL_SEC_MIN = 1.2;
export const SHEEP_WANDER_INTERVAL_SEC_MAX = 3.5;
export const SHEEP_PANIC_FLIP_INTERVAL_SEC = 0.35;

/** Horizontal knockback base (empty hand / fallback); swords use tiered values in Game. */
export const SHEEP_KNOCKBACK_HAND_PX = 52;

/** Extra horizontal knockback when sprinting (Java sprint-knockback attack). */
export const SHEEP_KNOCKBACK_SPRINT_MULT = 1.22;

/** Upward velocity when grounded (Java-style lift); airborne gets horizontal only. */
export const SHEEP_KNOCKBACK_GROUND_VY_PX = 64;

/** Sheep have no knockback resistance attribute in Stratum (MC sheep: none). */
export const SHEEP_KNOCKBACK_RESISTANCE_PERCENT = 0;

/** `hitKnockVx *= exp(-this * dt)` per tick. */
export const SHEEP_KNOCKBACK_DECAY_PER_SEC = 12;

/** Cap on accumulated horizontal knockback impulse (px/s). */
export const SHEEP_KNOCKBACK_HORIZONTAL_CAP_PX = 132;

/** Java Edition post-hit melee invulnerability (~500ms). */
export const SHEEP_DAMAGE_INVULN_SEC = 0.5;

/** Tip-over + fade duration after lethal damage (matches player death pose style). */
export const SHEEP_DEATH_ANIM_SEC = 0.82;

/**
 * Performance: hard cap on living mobs. Keeps Maps, physics, and render sync bounded.
 */
export const MOB_GLOBAL_CAP = 96;

/**
 * Minecraft Java–style **passive** mob spawning: natural spawns happen on a **periodic cycle** in
 * **loaded** chunks near **players**, not at chunk generation time. Terrain is already generated;
 * we only roll spawn positions in chunks that are currently loaded.
 *
 * ~400 game ticks at 20 TPS ≈ 20 seconds between spawn cycles (see wiki / mob spawning).
 */
export const PASSIVE_MOB_SPAWN_INTERVAL_SEC = 20;

/**
 * Random spawn **attempts** per cycle (most fail: wrong block, light, cap, etc.). Similar in spirit
 * to multiple pack spawn tries per cycle in Bedrock/Java.
 */
export const PASSIVE_SPAWN_ATTEMPTS_PER_CYCLE = 4;

/**
 * Night hostile spawn cadence: a bit more aggressive than passive spawns.
 * Uses a separate accumulator so day/night does not cause catch-up bursts at dusk/dawn.
 */
export const HOSTILE_MOB_SPAWN_INTERVAL_SEC = 12;
export const HOSTILE_SPAWN_ATTEMPTS_PER_CYCLE = 6;

/**
 * Only loaded chunks within this **Chebyshev** distance of a player’s chunk (stream centre + remotes
 * on host) are eligible—matches “near player” passive spawning, not “any chunk on disk”.
 */
export const PASSIVE_CHUNK_SPAWN_RADIUS = VIEW_DISTANCE_CHUNKS;

/** Max sheep per world-block column (rough density cap during spawn rolls). */
export const SHEEP_MAX_PER_COLUMN = 2;

/**
 * Minimum combined sky/block light (0–15) at the **mob’s** cell (air above grass).
 * 7 matches common passive-animal thresholds; 9 was too strict under tree canopy.
 */
export const SHEEP_SPAWN_MIN_COMBINED_LIGHT = 7;

/** After dusk ends until the next dawn; matches {@link WorldTime} segment order. */
const NIGHT_SEGMENT_START_MS =
  DAWN_LENGTH_MS + DAYLIGHT_LENGTH_MS + DUSK_LENGTH_MS;

/**
 * True while the world clock is in the **night** segment (post-dusk through pre-dawn).
 * Passive land mobs should not spawn in this window ({@link MobManager.passiveSpawnTick}).
 */
export function isWorldTimeNightForPassiveSpawns(worldTimeMs: number): boolean {
  const t = ((worldTimeMs % DAY_LENGTH_MS) + DAY_LENGTH_MS) % DAY_LENGTH_MS;
  return t >= NIGHT_SEGMENT_START_MS;
}

/**
 * True when the world clock is in the daylight segment and has progressed at least 10% into that
 * segment (prevents immediate burn right at sunrise).
 */
export function isWorldTimeLateEnoughForSunBurn(worldTimeMs: number): boolean {
  const t = ((worldTimeMs % DAY_LENGTH_MS) + DAY_LENGTH_MS) % DAY_LENGTH_MS;
  const daylightStart = DAWN_LENGTH_MS;
  const daylightEnd = DAWN_LENGTH_MS + DAYLIGHT_LENGTH_MS;
  if (t < daylightStart || t >= daylightEnd) {
    return false;
  }
  const intoDaylight = t - daylightStart;
  return intoDaylight >= DAYLIGHT_LENGTH_MS * 0.1;
}

export function combinedLight(
  sky: number,
  block: number,
): number {
  return sky > block ? sky : block;
}

export function feetPxFromSurfaceBlockY(surfaceBlockY: number): number {
  return (surfaceBlockY + 1) * BLOCK_SIZE;
}
