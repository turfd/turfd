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

/**
 * Pig folder-strip art (`entities/pig/.../sprite-1-{n}.png`) is tightly cropped (about 18x15)
 * with no transparent foot padding, unlike older 32x32 atlas-based mobs.
 */
export const PIG_FEET_SPRITE_NUDGE_Y_PX = 0;
export const PIG_FRAME_TEXEL_W = 18;
export const PIG_FRAME_TEXEL_H = 15;
/** Keep pig texels world-pixel consistent (1 source px -> 1 world px). */
export const PIG_BODY_TRIM_TARGET_PX = 15;
export const PIG_RENDER_SCALE_MULT = 1;
/** Additional display-space Y offset after feet nudge (negative lifts pig up). */
export const PIG_VISUAL_FEET_DROP_PX = -6;

const _pigTrimTexels = Math.max(
  1,
  PIG_FRAME_TEXEL_H - PIG_FEET_SPRITE_NUDGE_Y_PX,
);
const _pigWorldScale =
  (PIG_BODY_TRIM_TARGET_PX / _pigTrimTexels) * PIG_RENDER_SCALE_MULT;

/**
 * Texel→screen scale for pig/sheep in EntityManager: `(trimTarget / (frameH - footPad)) * mult`.
 * Slime uses the same so each source pixel maps to the same screen size as pig/sheep art.
 */
export const PASSIVE_MOB_TEXEL_SCREEN_SCALE = _sheepWorldScale;

/** Hitbox (world px) matches on-screen pig sprite (full frame at {@link PASSIVE_MOB_TEXEL_SCREEN_SCALE}). */
export const PIG_WIDTH_PX = PIG_FRAME_TEXEL_W * _pigWorldScale;
export const PIG_HEIGHT_PX = PIG_FRAME_TEXEL_H * _pigWorldScale;
export const PIG_WATER_SPEED_MULT = 0.42;
export const PIG_WATER_GRAVITY_MULT = 0.22;
export const PIG_WATER_BUOYANCY_ACCEL_PX = 260;
export const PIG_WATER_MAX_SINK_SPEED_PX = 95;
export const PIG_WATER_MAX_UPWARD_SPEED_PX = -78;
export const PIG_MAX_HEALTH = 6;
export const PIG_MELEE_DAMAGE = 1;
export const PIG_WALK_FRAMES = 6;
export const PIG_IDLE_FRAMES = 4;
export const PIG_SPRITE_IDLE_FOLDER_REL = "entities/pig/idle";
export const PIG_SPRITE_WALK_FOLDER_REL = "entities/pig/walking";
export const PIG_WALK_SPEED_PX = 52;
export const PIG_PANIC_SPEED_PX = PLAYER_SPRINT_SPEED_PX;
export const PIG_PANIC_DURATION_SEC = 2.8;
export const PIG_WANDER_INTERVAL_SEC_MIN = 1.2;
export const PIG_WANDER_INTERVAL_SEC_MAX = 3.5;
export const PIG_PANIC_FLIP_INTERVAL_SEC = 0.35;
export const PIG_KNOCKBACK_HAND_PX = 52;
export const PIG_KNOCKBACK_SPRINT_MULT = 1.22;
export const PIG_KNOCKBACK_GROUND_VY_PX = 70;
export const PIG_KNOCKBACK_RESISTANCE_PERCENT = 0;
export const PIG_KNOCKBACK_DECAY_PER_SEC = 12;
export const PIG_KNOCKBACK_HORIZONTAL_CAP_PX = 142;
export const PIG_DAMAGE_INVULN_SEC = 0.5;
export const PIG_DEATH_ANIM_SEC = 0.82;
export const PIG_MAX_PER_COLUMN = 2;
export const PIG_SPAWN_MIN_COMBINED_LIGHT = 6;
export const DUCK_FRAME_TEXEL_W = 13;
export const DUCK_FRAME_TEXEL_H = 17;
export const DUCK_WIDTH_PX = PIG_WIDTH_PX;
export const DUCK_HEIGHT_PX = PIG_HEIGHT_PX;
export const DUCK_WATER_SPEED_MULT = PIG_WATER_SPEED_MULT;
export const DUCK_WATER_GRAVITY_MULT = PIG_WATER_GRAVITY_MULT;
export const DUCK_WATER_BUOYANCY_ACCEL_PX = PIG_WATER_BUOYANCY_ACCEL_PX;
export const DUCK_WATER_MAX_SINK_SPEED_PX = PIG_WATER_MAX_SINK_SPEED_PX;
export const DUCK_WATER_MAX_UPWARD_SPEED_PX = PIG_WATER_MAX_UPWARD_SPEED_PX;
export const DUCK_MAX_HEALTH = PIG_MAX_HEALTH;
export const DUCK_MELEE_DAMAGE = PIG_MELEE_DAMAGE;
export const DUCK_WALK_FRAMES = PIG_WALK_FRAMES;
export const DUCK_IDLE_FRAMES = PIG_IDLE_FRAMES;
export const DUCK_FEET_SPRITE_NUDGE_Y_PX = 0;
export const DUCK_WALK_SPEED_PX = PIG_WALK_SPEED_PX;
export const DUCK_PANIC_SPEED_PX = PIG_PANIC_SPEED_PX;
export const DUCK_PANIC_DURATION_SEC = PIG_PANIC_DURATION_SEC;
export const DUCK_WANDER_INTERVAL_SEC_MIN = PIG_WANDER_INTERVAL_SEC_MIN;
export const DUCK_WANDER_INTERVAL_SEC_MAX = PIG_WANDER_INTERVAL_SEC_MAX;
export const DUCK_PANIC_FLIP_INTERVAL_SEC = PIG_PANIC_FLIP_INTERVAL_SEC;
export const DUCK_KNOCKBACK_HAND_PX = PIG_KNOCKBACK_HAND_PX;
export const DUCK_KNOCKBACK_SPRINT_MULT = PIG_KNOCKBACK_SPRINT_MULT;
export const DUCK_KNOCKBACK_GROUND_VY_PX = PIG_KNOCKBACK_GROUND_VY_PX;
export const DUCK_KNOCKBACK_RESISTANCE_PERCENT = PIG_KNOCKBACK_RESISTANCE_PERCENT;
export const DUCK_KNOCKBACK_DECAY_PER_SEC = PIG_KNOCKBACK_DECAY_PER_SEC;
export const DUCK_KNOCKBACK_HORIZONTAL_CAP_PX = PIG_KNOCKBACK_HORIZONTAL_CAP_PX;
export const DUCK_DAMAGE_INVULN_SEC = PIG_DAMAGE_INVULN_SEC;
export const DUCK_DEATH_ANIM_SEC = PIG_DEATH_ANIM_SEC;
export const DUCK_MAX_PER_COLUMN = PIG_MAX_PER_COLUMN;
export const DUCK_SPAWN_MIN_COMBINED_LIGHT = PIG_SPAWN_MIN_COMBINED_LIGHT;
export const DUCK_SPRITE_IDLE_FOLDER_REL = "entities/duck/idle";
export const DUCK_SPRITE_WALK_FOLDER_REL = "entities/duck/walking";

/**
 * Slime body art: one PNG per frame under each folder, names `sprite-1-{n}.png` with **1-based** `n`.
 * Frame counts per folder: {@link SLIME_IDLE_FRAMES}, {@link SLIME_JUMP_FRAMES}, {@link SLIME_ATTACK_FRAMES}.
 */
export const SLIME_JUMP_FRAMES = 5;
export const SLIME_IDLE_FRAMES = 3;
export const SLIME_ATTACK_FRAMES = 8;
export const SLIME_SPRITE_IDLE_FOLDER_REL = "entities/slime/idle";
export const SLIME_SPRITE_JUMP_FOLDER_REL = "entities/slime/jump";
export const SLIME_SPRITE_ATTACK_FOLDER_REL = "entities/slime/attack";
/** Logical hitbox / layout texel (world size uses pig-scale path); atlas cells may differ. */
export const SLIME_FRAME_TEXEL = 16;
/**
 * Slime draw scale vs pig/sheep texel scale.
 * `1` keeps slime texels pixel-consistent with world/mob pixel density.
 */
export const SLIME_RENDER_SCALE_MULT = 1;
/** Feet sit at the bottom of the 16px cell; negative pulls the sprite up vs physics feet. */
export const SLIME_FEET_SPRITE_NUDGE_Y_PX = 0;
/**
 * Extra Y after {@link SLIME_FEET_SPRITE_NUDGE_Y_PX} (display space, Pixi y down): negative values
 * lift the sprite so feet sit on terrain (16px art uses different padding than pig).
 */
export const SLIME_VISUAL_FEET_DROP_PX = 0;
/**
 * Jelly body opacity (0–1) for {@link createSlimeGelAlphaFilter} (bright texels more transparent;
 * eyes/outline keep full alpha). Applied on the slime body sprite in {@link EntityManager}.
 */
export const SLIME_SPRITE_ALPHA = 0.66;
/** Drawn slime size (world px); also used for physics, combat, and arrow hit tests. */
export const SLIME_WIDTH_PX =
  SLIME_FRAME_TEXEL * PASSIVE_MOB_TEXEL_SCREEN_SCALE * SLIME_RENDER_SCALE_MULT;
export const SLIME_HEIGHT_PX =
  SLIME_FRAME_TEXEL * PASSIVE_MOB_TEXEL_SCREEN_SCALE * SLIME_RENDER_SCALE_MULT;
/** Same pacing as {@link ZOMBIE_CHASE_SPEED_PX} — slimes chase like zombies. */
export const SLIME_CHASE_SPEED_PX = PLAYER_WALK_SPEED_PX * 0.65;
export const SLIME_WATER_SPEED_MULT = 0.42;
export const SLIME_WATER_GRAVITY_MULT = 0.22;
export const SLIME_WATER_BUOYANCY_ACCEL_PX = 260;
export const SLIME_WATER_MAX_SINK_SPEED_PX = 95;
export const SLIME_WATER_MAX_UPWARD_SPEED_PX = -78;
export const SLIME_MAX_HEALTH = 5;
export const SLIME_ATTACK_INTERVAL_SEC = 1.15;
export const SLIME_ATTACK_SWING_VISUAL_SEC = 0.56;
/** Wind-up on the ground before impulse (matches first 3 jump-sheet frames). */
export const SLIME_JUMP_PRIME_SEC = 0.44;
export const SLIME_PANIC_SPEED_PX = PLAYER_SPRINT_SPEED_PX * 0.85;
export const SLIME_PANIC_DURATION_SEC = 2.4;
export const SLIME_WANDER_INTERVAL_SEC_MIN = 1.1;
export const SLIME_WANDER_INTERVAL_SEC_MAX = 3.2;
export const SLIME_PANIC_FLIP_INTERVAL_SEC = 0.35;
export const SLIME_KNOCKBACK_HAND_PX = 48;
export const SLIME_KNOCKBACK_SPRINT_MULT = 1.18;
export const SLIME_KNOCKBACK_GROUND_VY_PX = 62;
export const SLIME_KNOCKBACK_RESISTANCE_PERCENT = 0;
export const SLIME_KNOCKBACK_DECAY_PER_SEC = 12;
export const SLIME_KNOCKBACK_HORIZONTAL_CAP_PX = 130;
export const SLIME_DAMAGE_INVULN_SEC = 0.5;
export const SLIME_DEATH_ANIM_SEC = 0.72;
export const SLIME_MAX_PER_COLUMN = 2;

/** Slime palette on wire / save (`woolColor` field overload): 0 green … 3 red. */
export const SLIME_COLOR_GREEN = 0;
export const SLIME_COLOR_YELLOW = 1;
export const SLIME_COLOR_BLUE = 2;
export const SLIME_COLOR_RED = 3;

export function normalizeSlimeColor(c: number): number {
  if (!Number.isFinite(c)) {
    return SLIME_COLOR_GREEN;
  }
  const n = Math.floor(c);
  if (n <= SLIME_COLOR_GREEN) {
    return SLIME_COLOR_GREEN;
  }
  if (n >= SLIME_COLOR_RED) {
    return SLIME_COLOR_RED;
  }
  return n;
}

/** Melee damage to players by slime color (green weakest, red strongest). */
export function slimeContactDamageForColor(slimeColor: number): number {
  switch (normalizeSlimeColor(slimeColor)) {
    case SLIME_COLOR_GREEN:
      return 1;
    case SLIME_COLOR_YELLOW:
      return 2;
    case SLIME_COLOR_BLUE:
      return 3;
    case SLIME_COLOR_RED:
      return 5;
    default:
      return 1;
  }
}

/** Natural spawn cadence: day (grass) vs night (hostile footing), night is denser. */
export const SLIME_SPAWN_INTERVAL_DAY_SEC = 16;
export const SLIME_SPAWN_INTERVAL_NIGHT_SEC = 6;
export const SLIME_SPAWN_ATTEMPTS_DAY = 2;
export const SLIME_SPAWN_ATTEMPTS_NIGHT = 4;

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
export const ZOMBIE_KNOCKBACK_GROUND_VY_PX = 70;
export const ZOMBIE_KNOCKBACK_RESISTANCE_PERCENT = 0;
export const ZOMBIE_KNOCKBACK_SPRINT_MULT = 1.22;
export const ZOMBIE_KNOCKBACK_HORIZONTAL_CAP_PX = 142;
export const ZOMBIE_DAMAGE_INVULN_SEC = 0.5;
export const ZOMBIE_DEATH_ANIM_SEC = 0.82;
export const ZOMBIE_MAX_PER_COLUMN = 3;
/**
 * Hostile cave / underground: combined sky+block light at the mob’s air cell must be ≤ this.
 */
export const ZOMBIE_SPAWN_CAVE_MAX_COMBINED_LIGHT = 8;
/**
 * Night **surface** rolls pass `nightSkyZero` (sky ignored), so this is effectively a **block-light**
 * cap — higher than caves so moonlit / slightly lit overworld columns still qualify.
 */
export const ZOMBIE_SPAWN_SURFACE_MAX_COMBINED_LIGHT = 12;
/** Maximum distance in blocks at which zombies can detect and chase players. */
export const ZOMBIE_SIGHT_RANGE_BLOCKS = 15;
/** Feet sprite nudge (player atlas has foot padding similar to pig/sheep sheets). */
export const ZOMBIE_FEET_SPRITE_NUDGE_Y_PX = 2;

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

/** Radians per second for {@link mobSwimBobVyDelta} phase advance (shared host + clients via world time). */
export const MOB_SWIM_BOB_RAD_PER_SEC = 3.7;
/** Amplitude for swim bob as extra `vy` acceleration × `dt` (world space; matches mob water axes). */
export const MOB_SWIM_BOB_ACCEL_AMPLITUDE_PX = 92;

/** Small vertical oscillation while submerged; deterministic from id + world time. */
export function mobSwimBobVyDelta(
  mobId: number,
  worldTimeSec: number,
  dt: number,
): number {
  if (dt <= 0 || !Number.isFinite(worldTimeSec)) {
    return 0;
  }
  const phase = worldTimeSec * MOB_SWIM_BOB_RAD_PER_SEC + mobId * 1.917;
  return Math.sin(phase) * MOB_SWIM_BOB_ACCEL_AMPLITUDE_PX * dt;
}

/**
 * Slime hop: cap horizontal travel on flat ground to this many blocks
 * (`range ≈ vx · 2 · vy / {@link MOB_GRAVITY_PX}` with launch `vy = -vyMag`).
 */
export const SLIME_JUMP_MAX_RANGE_BLOCKS = 3;
/**
 * Upward launch at end of prime (world px/s, feet-Y positive down). Apex height is
 * `vy² / (2 · {@link MOB_GRAVITY_PX})`; tuned so peak clearance stays above one 16px block step
 * with margin (otherwise slimes bonk ledges and fail single-block hops).
 */
export const SLIME_JUMP_VY_PX = 160;
/** Horizontal arc speed derived so range stays within {@link SLIME_JUMP_MAX_RANGE_BLOCKS}. */
export const SLIME_JUMP_VX_PX = Math.floor(
  (SLIME_JUMP_MAX_RANGE_BLOCKS * BLOCK_SIZE * MOB_GRAVITY_PX) / (2 * SLIME_JUMP_VY_PX),
);
/** Minimum time on the ground between hops (one jump per second max). */
export const SLIME_JUMP_COOLDOWN_SEC = 1;

/**
 * Hard clamp on slime horizontal speed (px/s) before AABB sweep. Real hops + knockback stay well
 * below this; prevents bad state or future bugs from integrating huge `dx` in one tick.
 */
export const SLIME_PHYSICS_CLAMP_VX_PX = Math.ceil(
  SLIME_PANIC_SPEED_PX + SLIME_KNOCKBACK_HORIZONTAL_CAP_PX + 80,
);
/** Vertical clamp (px/s): upward jumps vs terminal fall. */
export const SLIME_PHYSICS_CLAMP_VY_UP_PX = 220;
export const SLIME_PHYSICS_CLAMP_VY_DOWN_PX = MOB_TERMINAL_VY_PX + 120;

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
export const SHEEP_KNOCKBACK_GROUND_VY_PX = 70;

/** Sheep have no knockback resistance attribute in Stratum (MC sheep: none). */
export const SHEEP_KNOCKBACK_RESISTANCE_PERCENT = 0;

/** `hitKnockVx *= exp(-this * dt)` per tick. */
export const SHEEP_KNOCKBACK_DECAY_PER_SEC = 12;

/** Cap on accumulated horizontal knockback impulse (px/s). */
export const SHEEP_KNOCKBACK_HORIZONTAL_CAP_PX = 142;

/** Java Edition post-hit melee invulnerability (~500ms). */
export const SHEEP_DAMAGE_INVULN_SEC = 0.5;

/** Tip-over + fade duration after lethal damage (matches player death pose style). */
export const SHEEP_DEATH_ANIM_SEC = 0.82;

/**
 * Performance: hard cap on living mobs. Keeps Maps, physics, and render sync bounded.
 * Lowered to reduce long-session host degradation when many persistent summons accumulate.
 */
export const MOB_GLOBAL_CAP = 50;

/** Pixels past the screen edge when rejecting natural spawns (so mobs do not pop at the border). */
export const MOB_SPAWN_VIEW_MARGIN_SCREEN_PX = 64;

/**
 * Minecraft Java–style **passive** mob spawning: natural spawns happen on a **periodic cycle** in
 * **loaded** chunks near **players**, not at chunk generation time. Terrain is already generated;
 * we only roll spawn positions in chunks that are currently loaded.
 *
 * Slightly faster than classic Java (~20s) so grass passives stay noticeable vs night hostiles.
 */
export const PASSIVE_MOB_SPAWN_INTERVAL_SEC = 24;

/**
 * Outer spawn **cycles** per passive tick window (each runs {@link PASSIVE_SPAWN_ATTEMPTS_PER_CYCLE}
 * logical attempts).
 */
export const PASSIVE_SPAWN_ATTEMPTS_PER_CYCLE = 6;

/**
 * Within each {@link MobManager.tryOnePassiveMobSpawn} call, how many random surface columns to try
 * before giving up (view/light/cap reject most single rolls).
 */
export const PASSIVE_NATURAL_SPAWN_COLUMN_TRIES = 12;

/**
 * When locating grass for passives, scan this many blocks **above** noise surface (player-built
 * platforms / superflat layers above the procedural surface).
 */
export const PASSIVE_SPAWN_SURFACE_SCAN_UP_BLOCKS = 96;
/**
 * Scan this many blocks **below** noise surface to still find grass after small overhangs / edits.
 */
export const PASSIVE_SPAWN_SURFACE_SCAN_DOWN_BLOCKS = 80;

/**
 * Prefer natural sheep/pig/day-slime spawns at least this many blocks from **any** player (L²).
 * Spawns may still succeed closer when {@link MobManager} allows “off-camera but nearby” columns
 * (small loaded areas).
 */
export const PASSIVE_SPAWN_MIN_PLAYER_DISTANCE_BLOCKS = 22;

/**
 * Night hostile spawn cadence: a bit more aggressive than passive spawns.
 * Uses a separate accumulator so day/night does not cause catch-up bursts at dusk/dawn.
 */
// Hostile spawns (night): zombies — half as many rolls per cycle vs prior tuning.
export const HOSTILE_MOB_SPAWN_INTERVAL_SEC = 5;
export const HOSTILE_SPAWN_ATTEMPTS_PER_CYCLE = 5;
/**
 * If both a valid surface and cave floor exist in a spawn column, this chance picks the cave floor.
 * Higher value = more cave zombie spawns.
 */
export const HOSTILE_ZOMBIE_CAVE_PREFERENCE_CHANCE = 0.72;

/**
 * Terraria-style natural hostile pressure (NPC spawning–style routing):
 * - Spawn attempts bias to columns around a **chosen player** within a max tile span.
 * - Reject spawns inside a smaller **safe** rectangle around each player (comfort / “town” analogue).
 * - **Local cap** on simultaneous hostiles near players; when the count is low, **extra spawn
 *   attempts** mimic Terraria’s faster spawn-rate tiers (denominator ×0.6–0.9 vs fill % of max).
 */
export const HOSTILE_LOCAL_MAX_SPAWNS = 6;

/** Horizontal span (blocks) from anchor player for hostile column picks (Terraria-scale ≈84 tiles). */
export const HOSTILE_SPAWN_MAX_DIST_BLOCKS_H = 84;
/** Vertical span (blocks) from anchor feet block row (reference: 46 up / 45 down in tiles). */
export const HOSTILE_SPAWN_MAX_DIST_BLOCKS_V = 46;

/**
 * Inner “safe” rectangle half-extents in blocks (reference ≈62×35 tiles from the player hitbox).
 * Natural hostiles may not spawn on a floor inside this box relative to **any** player.
 */
export const HOSTILE_SPAWN_SAFE_ZONE_BLOCKS_H = 62;
export const HOSTILE_SPAWN_SAFE_ZONE_BLOCKS_V = 35;

/**
 * Zombies + slimes within this L² distance (blocks) of any player feet count toward
 * {@link HOSTILE_LOCAL_MAX_SPAWNS}.
 */
export const HOSTILE_ACTIVE_COUNT_RADIUS_BLOCKS = 100;

/** Player-anchored column picks before falling back to legacy random-chunk rolls. */
export const HOSTILE_PLAYER_ANCHORED_COLUMN_TRIES = 32;

/** Legacy random-chunk picks after anchored passes fail. */
export const HOSTILE_LEGACY_RANDOM_COLUMN_TRIES = 10;

/** Hard cap on hostile spawn attempts in one cycle after fill-rate scaling (performance). */
export const HOSTILE_SPAWN_ATTEMPTS_PER_CYCLE_CAP = 20;

/**
 * Terraria spawn-rate tiers: fewer nearby hostiles ⇒ more attempts per cycle (inverse of
 * Terraria denominator multipliers 0.6–0.9).
 */
export function hostileSpawnAttemptMultiplierFromFill(
  effectiveHostileCount: number,
  maxSpawns: number,
): number {
  if (maxSpawns <= 0) {
    return 1;
  }
  const r = effectiveHostileCount / maxSpawns;
  if (r < 0.2) {
    return 1 / 0.6;
  }
  if (r < 0.4) {
    return 1 / 0.7;
  }
  if (r < 0.6) {
    return 1 / 0.8;
  }
  if (r < 0.8) {
    return 1 / 0.9;
  }
  return 1;
}

/**
 * Only loaded chunks within this **Chebyshev** distance of a player’s chunk (stream centre + remotes
 * on host) are eligible—matches “near player” passive spawning, not “any chunk on disk”.
 */
export const PASSIVE_CHUNK_SPAWN_RADIUS = VIEW_DISTANCE_CHUNKS;

/** Max sheep per world-block column (rough density cap during spawn rolls). */
export const SHEEP_MAX_PER_COLUMN = 2;

/**
 * Minimum combined sky/block light (0–15) at the **mob’s** cell (air above grass).
 * 6 allows more spawns under tree canopy / short-grass shade; 9 was too strict.
 */
export const SHEEP_SPAWN_MIN_COMBINED_LIGHT = 6;

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

export type MobHitboxKind = "sheep" | "pig" | "duck" | "slime" | "zombie";

/**
 * World-space AABB width/height (feet at bottom center) aligned with rendered mob sprites
 * ({@link EntityManager} pig/sheep scaling, slime draw scale, zombie = player body size).
 */
export function mobHitboxSizePx(kind: MobHitboxKind): { w: number; h: number } {
  switch (kind) {
    case "sheep":
      return { w: SHEEP_WIDTH_PX, h: SHEEP_HEIGHT_PX };
    case "pig":
      return { w: PIG_WIDTH_PX, h: PIG_HEIGHT_PX };
    case "duck":
      return { w: DUCK_WIDTH_PX, h: DUCK_HEIGHT_PX };
    case "slime":
      return { w: SLIME_WIDTH_PX, h: SLIME_HEIGHT_PX };
    case "zombie":
      return { w: ZOMBIE_WIDTH_PX, h: ZOMBIE_HEIGHT_PX };
  }
}

/**
 * Sheep/pig atlas frames include transparent padding; physics hitbox matches the full frame.
 * Arrow **strike + stick** use a tighter AABB so tips embed in visible wool, not empty margin.
 */
export const SHEEP_PIG_ARROW_STRIKE_INSET_X_PX = 6;
export const SHEEP_PIG_ARROW_STRIKE_INSET_TOP_PX = 6;
export const SHEEP_PIG_ARROW_STRIKE_INSET_BOTTOM_PX = 2;

export type MobWorldAabb = {
  left: number;
  right: number;
  bottom: number;
  top: number;
};

/** World-space AABB for arrow segment tests (may be inset vs {@link mobHitboxSizePx}). */
export function mobArrowStrikeAabbWorld(
  kind: MobHitboxKind,
  feetX: number,
  feetY: number,
): MobWorldAabb {
  const { w, h } = mobHitboxSizePx(kind);
  const half = w * 0.5;
  let left = feetX - half;
  let right = feetX + half;
  let bottom = feetY;
  let top = feetY + h;
  if (kind === "sheep" || kind === "pig") {
    left += SHEEP_PIG_ARROW_STRIKE_INSET_X_PX;
    right -= SHEEP_PIG_ARROW_STRIKE_INSET_X_PX;
    bottom += SHEEP_PIG_ARROW_STRIKE_INSET_BOTTOM_PX;
    top -= SHEEP_PIG_ARROW_STRIKE_INSET_TOP_PX;
  }
  const minSpan = 12;
  if (right - left < minSpan) {
    const c = (left + right) * 0.5;
    left = c - minSpan * 0.5;
    right = c + minSpan * 0.5;
  }
  if (top - bottom < minSpan) {
    const c = (top + bottom) * 0.5;
    bottom = c - minSpan * 0.5;
    top = c + minSpan * 0.5;
  }
  return { left, right, bottom, top };
}

/**
 * Death tip-over angle (radians) used on mob sprite roots; same value for stuck-arrow offset rotation.
 */
export function mobDeathTipOverTiltRad(
  kind: "sheep" | "pig" | "duck" | "zombie" | "slime",
  facingRight: boolean,
  deathAnimRemainSec: number,
): number {
  if (deathAnimRemainSec <= 0) {
    return 0;
  }
  const sign = facingRight ? 1 : -1;
  const dur =
    kind === "sheep"
      ? SHEEP_DEATH_ANIM_SEC
      : kind === "pig"
        ? PIG_DEATH_ANIM_SEC
        : kind === "duck"
          ? DUCK_DEATH_ANIM_SEC
        : kind === "slime"
          ? SLIME_DEATH_ANIM_SEC
          : ZOMBIE_DEATH_ANIM_SEC;
  const t = Math.min(1, Math.max(0, 1 - deathAnimRemainSec / dur));
  return sign * t * (Math.PI * 0.5);
}
