/** Pixel size of one block edge on screen (atlas texel scale). */
export const BLOCK_SIZE = 16;

/**
 * Minimum camera zoom is chosen so at least this many blocks fit along the **shorter** viewport
 * edge (logical px). Keeps tile size consistent *relative to screen* across resolutions and
 * aspect ratios (ultrawide, portrait, etc.). See {@link Camera.getEffectiveZoom}.
 */
export const MAX_VISIBLE_BLOCKS_ON_MIN_AXIS = 20;

/** Horizontal world-pixel offset that maps to full stereo pan for spatial SFX. */
export const AUDIO_SFX_PAN_REF_PX = 420;

/** Within this distance (blocks) spatial SFX stay at full distance gain. */
export const AUDIO_FULL_VOLUME_RADIUS = 5;

/** Beyond this distance (blocks) spatial SFX are silent (no voice created). */
export const AUDIO_SILENCE_RADIUS = 80;

/** Lowpass cutoff (Hz) when the source is at {@link AUDIO_FULL_VOLUME_RADIUS}. */
export const AUDIO_MUFFLE_NEAR_HZ = 18000;

/** Lowpass cutoff (Hz) when the source is at {@link AUDIO_SILENCE_RADIUS}. */
export const AUDIO_MUFFLE_FAR_HZ = 400;

/** Biquad Q for distance lowpass (Web Audio default resonance). */
export const AUDIO_MUFFLE_LOWPASS_Q = 0.707;

/** Reverb wet/dry crossfade when switching audio environment (seconds). */
export const AUDIO_REVERB_ENV_CROSSFADE_SEC = 1.5;

/** Dry mix level for open-air reverb preset [0, 1]. */
export const AUDIO_REVERB_SURFACE_DRY = 0.85;

/** Wet mix level for open-air reverb preset [0, 1]. */
export const AUDIO_REVERB_SURFACE_WET = 0.15;

/** Dry mix for damp underground stone (keep fairly dry to avoid muddy convolution). */
export const AUDIO_REVERB_UNDERGROUND_DRY = 0.84;

/** Wet mix for damp underground stone. */
export const AUDIO_REVERB_UNDERGROUND_WET = 0.16;

/** Dry mix for a tight / small cave (size-aware reverb floor). */
export const AUDIO_REVERB_CAVE_DRY_TIGHT = 0.74;

/** Wet mix for a tight / small cave. */
export const AUDIO_REVERB_CAVE_WET_TIGHT = 0.26;

/** Dry mix for a very open cave (7×7 sample nearly all air). */
export const AUDIO_REVERB_CAVE_DRY_OPEN = 0.38;

/** Wet mix for a very open cave. */
export const AUDIO_REVERB_CAVE_WET_OPEN = 0.62;

/** Half side length (blocks) of the air-count square for cave detection (full width = 2×+1). */
export const AUDIO_ENV_AIR_HALFRADIUS_BLOCKS = 3;

/** Enter “cave” reverb when local air cells exceed this (hysteresis enter). */
export const AUDIO_ENV_CAVE_ENTER_AIR_COUNT = 24;

/** Leave “cave” for “underground” when air cells drop to this or below (hysteresis exit). */
export const AUDIO_ENV_CAVE_EXIT_AIR_COUNT = 17;

/**
 * In shallow layers (near-surface interiors), treat only very open volumes as true caves.
 * This prevents houses/tunnels from grabbing cave IR while still allowing big caverns.
 */
export const AUDIO_ENV_SHALLOW_CAVE_ENTER_AIR_COUNT = 34;

/** Leave shallow-layer “cave” mode once openness falls below this (hysteresis exit). */
export const AUDIO_ENV_SHALLOW_CAVE_EXIT_AIR_COUNT = 28;

/** Short wet/dry ramp when only cave “openness” changes (same IR, seconds). */
export const AUDIO_REVERB_CAVE_OPENNESS_RAMP_SEC = 0.45;

/**
 * Feet block Y must be ≥ this to treat non-sky space as “shallow” (surface buildings, shallow mines).
 * Deeper columns use cave/underground only (avoids barn reverb at Y = -80).
 */
export const AUDIO_ENV_SHALLOW_LAYER_MIN_BLOCK_Y = -14;

/** Dry mix for a tight indoor room (shallow enclosed, uses underground IR). */
export const AUDIO_REVERB_ENCLOSED_DRY_TIGHT = 0.9;

/** Wet mix for a tight indoor room. */
export const AUDIO_REVERB_ENCLOSED_WET_TIGHT = 0.1;

/** Dry mix for a large interior (hall / great room). */
export const AUDIO_REVERB_ENCLOSED_DRY_OPEN = 0.76;

/** Wet mix for a large interior. */
export const AUDIO_REVERB_ENCLOSED_WET_OPEN = 0.24;

/** Per solid non-transparent block along listener→source line, subtract this from gain multiplier. */
export const AUDIO_OCCLUSION_GAIN_PER_WALL = 0.12;

/** Cap how many wall hits contribute to occlusion (avoids silence through long solid runs). */
export const AUDIO_OCCLUSION_MAX_CONTRIBUTING_WALLS = 8;

/** At max occlusion, distance lowpass cutoff is multiplied by this (more muffled through walls). */
export const AUDIO_OCCLUSION_FREQ_MULT_MIN = 0.28;

/** Super-sample factor for occlusion line (≥1; higher catches thin walls). */
export const AUDIO_OCCLUSION_LINE_SAMPLES_MULT = 2.4;

/** Throttle spatial listener updates to every N fixed ticks (see {@link FIXED_HZ}). */
export const AUDIO_SPATIAL_LISTENER_UPDATE_INTERVAL_TICKS = 3;

/** Re-run environment detection every N fixed ticks (~1 s at 60 Hz). */
export const AUDIO_ENV_DETECT_INTERVAL_TICKS = 60;

/**
 * Local player ground sprint horizontal speed (blocks/s). Walk/jump variants stay in {@link Player};
 * this value is shared so passive mob panic can match player run speed.
 */
export const PLAYER_SPRINT_SPEED_BLOCKS_PER_SEC = 5.612;

/** Ground sprint cap in world px/s (`PLAYER_SPRINT_SPEED_BLOCKS_PER_SEC * {@link BLOCK_SIZE}`). */
export const PLAYER_SPRINT_SPEED_PX =
  PLAYER_SPRINT_SPEED_BLOCKS_PER_SEC * BLOCK_SIZE;

/** Ground walk speed (blocks/s); shared for mobs that match walking pace (e.g. zombies). */
export const PLAYER_WALK_SPEED_BLOCKS_PER_SEC = 4.317;

/** Ground walk cap in world px/s. */
export const PLAYER_WALK_SPEED_PX =
  PLAYER_WALK_SPEED_BLOCKS_PER_SEC * BLOCK_SIZE;

/** Local player hitbox (world pixels). */
export const PLAYER_WIDTH = 14;
export const PLAYER_HEIGHT = 28;

/**
 * Single horizontal strip: 7×(20×40) = 140×40 — idle, walk×4, jump, break.
 * 1-based art order: frame 1 idle, 2–5 walk, 6 jump, 7 break → 0-based indices below.
 *
 * Optional sidecar: {@link PLAYER_BODY_ATLAS_JSON_REL} — if present and valid, overrides these rects.
 *
 * @deprecated Use {@link BUILTIN_SKINS} + {@link DEFAULT_SKIN_ID} instead.
 */
export const PLAYER_BODY_ATLAS_IMAGE_REL = "GUI/player/explorer_bob.png";

/** Built-in skin definitions shipped with the game. */
export const BUILTIN_SKINS: readonly Readonly<{
  id: string;
  label: string;
  file: string;
}>[] = [
  { id: "explorer_bob", label: "Explorer Bob", file: "GUI/player/explorer_bob.png" },
  { id: "explorer_dave", label: "Explorer Dave", file: "GUI/player/explorer_dave.png" },
] as const;

export const DEFAULT_SKIN_ID = "explorer_bob";

/** Maximum PNG byte size accepted for custom skin uploads. */
export const CUSTOM_SKIN_MAX_BYTES = 256 * 1024;

/**
 * Optional `{ "frames": [{ "x","y","w","h" }, ...] }` next to the PNG (same folder in the resource pack).
 */
export const PLAYER_BODY_ATLAS_JSON_REL = "GUI/player/body_atlas.json";

/**
 * Default rects for `sprite_sheet.png` at 140×40 (uniform 20×40 cells, no gutters).
 */
export const PLAYER_BODY_ATLAS_FRAMES: readonly Readonly<{
  x: number;
  y: number;
  w: number;
  h: number;
}>[] = [
  { x: 0, y: 0, w: 20, h: 40 },
  { x: 20, y: 0, w: 20, h: 40 },
  { x: 40, y: 0, w: 20, h: 40 },
  { x: 60, y: 0, w: 20, h: 40 },
  { x: 80, y: 0, w: 20, h: 40 },
  { x: 100, y: 0, w: 20, h: 40 },
  { x: 120, y: 0, w: 20, h: 40 },
] as const;

/** Minimum slices required for idle / walk / jump / break indices below. */
export const PLAYER_BODY_REQUIRED_FRAME_COUNT = 7;

/** Standing idle — art frame 1. */
export const PLAYER_BODY_IDLE_FRAME_INDEX = 0;

/** Walk loop — art frames 2–5. */
export const PLAYER_BODY_WALK_CYCLE_INDICES: readonly number[] = [1, 2, 3, 4];

/** Jump (ascent and descent use the same cel) — art frame 6. */
export const PLAYER_BODY_JUMP_UP_FRAME_INDEX = 5;
export const PLAYER_BODY_JUMP_DOWN_FRAME_INDEX = 5;

/** Mining / skid pose — art frame 7; alternates with idle while breaking. */
export const PLAYER_BODY_MINING_FRAME_INDEX = 6;

/** AnimatedSprite speed for idle ↔ mining two-frame loop (see {@link PLAYER_WALK_ANIM_SPEED}). */
export const PLAYER_BREAKING_ANIM_SPEED = 0.14;

/**
 * Extra offset for the mining pose frame only (second frame of the mining loop).
 * Set non-zero if that cell’s feet don’t line up with idle in the sheet.
 */
export const PLAYER_BREAKING_MINING_FRAME_OFFSET_X_TEXELS = 0;
export const PLAYER_BREAKING_MINING_FRAME_OFFSET_Y_TEXELS = 0;

/**
 * After a successful place or item use, play the same mining-style body + held-item swing for this long.
 */
export const PLAYER_HAND_SWING_VISUAL_DURATION_SEC = 0.32;

/**
 * Remotes: treat vertical speed above this (px/s) as airborne for jump sprite (no `onGround` on wire).
 */
export const PLAYER_REMOTE_AIR_VY_THRESHOLD = 18;

/**
 * {@link AnimatedSprite.animationSpeed} while walking on the ground (Pixi ticker units; ~0.1–0.2 is typical).
 */
export const PLAYER_WALK_ANIM_SPEED = 0.16;

/** Multiply walk animation speed while sprinting (same frames, faster playback). */
export const PLAYER_SPRINT_ANIM_SPEED_MULT = 1.8;

/** Minimum horizontal speed (px/s) to play the walk cycle instead of idle. */
export const PLAYER_MOVE_ANIM_VEL_THRESHOLD = 12;

/**
 * Remote peers: treat horizontal speed above this as “sprint” for animation timing (between walk and sprint caps).
 */
export const PLAYER_REMOTE_SPRINT_VEL_THRESHOLD = 155;

/**
 * Low-pass net velocity toward animation thresholds (1/e time ≈ 1/this many seconds). Reduces walk/idle flicker from ~30 Hz state updates.
 */
export const PLAYER_REMOTE_ANIM_VEL_SMOOTH_PER_SEC = 12;

/**
 * Remote peers: render pose this many ms behind wall-clock so we can interpolate between network samples
 * (reduces jitter and avoids velocity extrapolation into walls).
 */
export const REMOTE_PLAYER_INTERP_DELAY_MS = 110;

/** Drop snapshot history older than this (ms) to bound memory. */
export const REMOTE_PLAYER_SNAPSHOT_MAX_AGE_MS = 550;

/** Max buffered pose samples per remote peer. */
export const REMOTE_PLAYER_SNAPSHOT_MAX_COUNT = 24;

/**
 * Applied after fitting the walk sheet to the hitbox. Hitbox ({@link PLAYER_WIDTH} × {@link PLAYER_HEIGHT}) is unchanged.
 * `1.5` ≈ ¾ of the prior “2×” display size.
 */
export const PLAYER_SPRITE_SCALE_MULTIPLIER = 1.5;

/**
 * Nudge the walk sprite down (+) or up (−) in world/container pixels (after scale). Fixes a few px of
 * “floating” when the art’s soles sit above the bottom of the frame.
 */
export const PLAYER_SPRITE_FEET_OFFSET_PX = 0;

/**
 * Extra nudge from sheet texels × draw scale (see {@link PLAYER_SPRITE_FEET_OFFSET_PX} for fixed px).
 */
export const PLAYER_SPRITE_FEET_PAD_TEXELS = 0;

/**
 * Selected hotbar item: offset from the body anchor (bottom-center), in body texture pixels.
 * Code multiplies X by `body.scale.x` (signed) so the grip moves to the mirrored side when the
 * character flips; negate this constant if the tool sits on the wrong side for your sheet.
 */
export const PLAYER_HELD_ITEM_HAND_OFFSET_X_TEXELS = 7;
export const PLAYER_HELD_ITEM_HAND_OFFSET_Y_TEXELS = -18;

/**
 * Magnitude of screen-X nudge toward the character’s forward side (`facingRight` → +X, else −X).
 */
export const PLAYER_HELD_ITEM_FACING_SIDE_NUDGE_X_PX = 8;

/**
 * Outward from torso along screen X (signed in code by facing: +X when `facingRight`, −X when facing left).
 */
export const PLAYER_HELD_ITEM_OUTWARD_NUDGE_X_PX = 6;
export const PLAYER_HELD_ITEM_OUTWARD_NUDGE_Y_PX = 7;

/** When airborne, nudge held item up (−Y) for both facings. */
export const PLAYER_HELD_ITEM_AIR_JUMP_NUDGE_Y_PX = -2;

/**e
 * When airborne, extra held-item shift along screen X (px). Multiplied by `facingRight ? 1 : -1`
 * so facing-left moves 1px toward −X and facing-right mirrors (+X).
 */
export const PLAYER_HELD_ITEM_JUMP_NUDGE_X_PX = 2;

/**
 * While breaking blocks, on the mining two-frame loop’s swing cel (`currentFrame === 1`):
 * nudge the held item toward facing (+screen X when `facingRight`) and up (−Y).
 */
export const PLAYER_HELD_BREAK_FRAME_NUDGE_FORWARD_PX = 2;
export const PLAYER_HELD_BREAK_FRAME_NUDGE_UP_PX = 2;

/**
 * On the mining swing frame: extra rotation (radians, + = clockwise in Pixi). Not pixel units—
 * tip motion ≈ angle × distance from the grip anchor. Set to `0` to disable; negate if tilt is wrong.
 */
export const PLAYER_HELD_BREAK_FRAME_ROTATION_RAD = 0.25;

/** Extra scale for the held icon relative to the body uniform scale (1 ≈ same texel size as body art). */
export const PLAYER_HELD_ITEM_SCALE_MULTIPLIER = 1;

/** Placeable block / tile items (`placesBlockId`): in-hand scale vs other items. */
export const PLAYER_HELD_PLACEABLE_BLOCK_REL_SCALE = 0.5;

/** Extra down (+Y) in container px for held placeable blocks only (both facings). */
export const PLAYER_HELD_PLACEABLE_BLOCK_NUDGE_Y_PX = 2;

/** In-hand rotation for all tools (radians; positive = clockwise in Pixi). */
export const PLAYER_HELD_AXE_ROTATION_RAD = Math.PI / 2;

/**
 * Direction the held bow PNG “fires” when `rotation === 0`, as `Math.atan2(displayDy, displayDx)`
 * (same convention as {@link getReachLineGeometry} and {@link ARROW_SPRITE_TIP_ANGLE_AT_ZERO_ROT_RAD}).
 * Art points toward the texture’s top-left (−x, −y on screen).
 */
export const PLAYER_HELD_BOW_TEXTURE_AIM_AXIS_AT_ZERO_ROT_RAD = (-3 * Math.PI) / 4;

/** Extra screen-X nudge for tools; sign follows facing the same way as outward X. */
export const PLAYER_HELD_AXE_NUDGE_X_PX = 4;
export const PLAYER_HELD_AXE_NUDGE_Y_PX = 0;

/** Grip point on the item texture (normalized 0–1). */
export const PLAYER_HELD_ITEM_ANCHOR_X = 0.35;
export const PLAYER_HELD_ITEM_ANCHOR_Y = 0.55;

/**
 * Camera follow: positive values shift the view target upward in world space so the player
 * appears lower on screen (more ground/sky above the character).
 */
export const CAMERA_PLAYER_VERTICAL_OFFSET_PX = 12;

/** Chebyshev reach from player centre block for break/place (blocks). */
export const REACH_BLOCKS = 5;

/**
 * Terraria-style melee crit roll (host). Affects knockback via ×1.4 after soft caps (wiki.gg/Knockback).
 */
export const PLAYER_MELEE_CRIT_CHANCE = 0.04;

/**
 * Recipe JSON `station` value: extra recipes require the player this close (Chebyshev blocks,
 * same cell metric as {@link REACH_BLOCKS}) to a `stratum:crafting_table` foreground block.
 */
export const RECIPE_STATION_CRAFTING_TABLE = "stratum:crafting_table";

/** Recipe JSON `station` value: smelting recipes require proximity to a `stratum:furnace` block. */
export const RECIPE_STATION_FURNACE = "stratum:furnace";

/** Recipe JSON `station` value: stonecutter recipes require proximity to a `stratum:stonecutter` block. */
export const RECIPE_STATION_STONECUTTER = "stratum:stonecutter";

/** Chebyshev radius from player feet block cell to a crafting table for station recipes. */
export const CRAFTING_TABLE_ACCESS_RADIUS_BLOCKS = 4;

/** Same reach metric as {@link CRAFTING_TABLE_ACCESS_RADIUS_BLOCKS} for furnace crafting tab. */
export const FURNACE_ACCESS_RADIUS_BLOCKS = 4;

/** Same reach metric for stonecutter-gated recipes in the crafting panel. */
export const STONECUTTER_ACCESS_RADIUS_BLOCKS = 4;

/**
 * Upper bound for Pixi resolution (device pixel ratio) after {@link MAX_RENDER_BACKBUFFER_PIXELS}.
 * Cuts cost on high-DPR phones without changing layout (CSS still fills the viewport).
 */
export const MAX_RENDER_DEVICE_PIXEL_RATIO = 2;

/**
 * Soft cap on main canvas pixel count (logicalW × logicalH × resolution²). ~1080p-class budget.
 * Larger viewports may use fractional Pixi `resolution` (below 1) for GPU cost; albedo is then
 * **nearest-snapped** in {@link CompositePass} so upscales stay sharp, not bilinear-soft.
 */
export const MAX_RENDER_BACKBUFFER_PIXELS = 1920 * 1080;

/** Reserved; world/camera use integer pixel snapping at native backbuffer resolution. */
export const PIXEL_SCALE = 1;

/** Base seconds per hardness unit for breaking. */
export const BREAK_TIME_BASE = 0.5;

/** Block-break debris lifetime (seconds). */
export const BLOCK_BREAK_PARTICLE_LIFETIME_SEC = 0.42;

/** Debris pixel count bounds (random in [MIN, MAX] inclusive). */
export const BLOCK_BREAK_PARTICLE_MIN = 5;
export const BLOCK_BREAK_PARTICLE_MAX = 12;

/**
 * Expected debris spawns while mining ≈ this many particles over progress 0→1 (local player only).
 * Applied as fractional accumulator on each progress delta.
 */
export const BLOCK_BREAK_PARTICLES_PER_PROGRESS = 16;

/** Footstep “kick up” debris count per step (random inclusive range). */
export const BLOCK_STEP_KICK_PARTICLE_MIN = 1;
export const BLOCK_STEP_KICK_PARTICLE_MAX = 3;

/** Extra particles when horizontal speed ≥ {@link PLAYER_REMOTE_SPRINT_VEL_THRESHOLD} (local + remote). */
export const BLOCK_STEP_KICK_PARTICLE_SPRINT_EXTRA = 1;

/** Shorter than break debris so kicked dust reads lighter. */
export const BLOCK_STEP_KICK_LIFETIME_SEC = 0.36;

/**
 * Bushy tree rendering: per-leaf-cell "decoration" mesh layered above the base tile mesh
 * (see {@link src/renderer/chunk/LeafDecorationBatch}). All jitter is hashed from world
 * coordinates so the look is stable across chunk rebuilds and camera motion.
 */
/**
 * Max absolute world-px offset for the stacked overlay quad (hashed in `[-max, +max]`).
 * Integer pixel only: values are `Math.round`-ed in the batch so the overlay always snaps
 * to a whole-pixel position (no half-texel smear).
 */
export const LEAF_DECO_OVERLAY_OFFSET_MAX_PX = 2;
/**
 * Native size palette (world px) for interior-corner gap-fill clumps. Each fill picks
 * one size from this list; the rendered quad size is ALWAYS equal to the UV sub-window
 * size in atlas texels, giving strict 1:1 pixel mapping (no mixels). Sizes are
 * intentionally all even and ≤ BLOCK_SIZE so UV windows fit inside the 16² frame.
 */
export const LEAF_DECO_CLUMP_SIZES_PX: readonly number[] = [6, 8, 10, 12];
/**
 * Per-corner chance an interior gap-fill clump is emitted when the diagonal neighbour is
 * also a leaf. Fills the transparent-pixel X-gap formed where four leaf tiles meet.
 */
export const LEAF_DECO_CORNER_FILL_CHANCE = 1.0;
/**
 * Exterior-canopy corner shave (world px, = atlas texels at 1:1). At each exterior
 * corner of a leaf cell (diagonal + both adjacent cardinals all air) the base 16×16
 * tile is emitted as 3 horizontal strips whose top / bottom strips omit a square of
 * this side length at each shaved corner. The outward corner bump quads emitted by
 * {@link src/renderer/chunk/LeafDecorationBatch} sit *on top* of this notch, turning
 * the crisp 90° silhouette corner into a soft rounded clump instead. Keep this
 * strictly below `BLOCK_SIZE / 2` (8) so all three strips stay non-degenerate.
 */
export const LEAF_DECO_CORNER_SHAVE_PX = 5;

/** Ambient canopy leaf fall: max concurrent sprites (Minecraft-like density). */
export const LEAF_FALL_MAX_PARTICLES = 160;
/** Spawn attempts per fixed tick (each samples a random loaded chunk / cell). */
export const LEAF_FALL_SPAWN_TRIES_PER_TICK = 72;
/** When a candidate leaf cell qualifies, probability to actually spawn one particle. */
export const LEAF_FALL_SPAWN_CHANCE = 1;
/**
 * Fraction of spawn rolls that may use any leaf block (not only canopy-edge cells).
 * Matches “ambient around foliage” feel; rest still prefer exposed underside.
 */
export const LEAF_FALL_INTERIOR_LEAF_FRACTION = 0.45;
/** Chebyshev chunk distance from player for sampling (see {@link VIEW_DISTANCE_CHUNKS}). */
export const LEAF_FALL_SPAWN_CHUNK_RADIUS = 8;
/** Horizontal sway amplitude in world pixels (feet-up space, applied on top of drift). */
export const LEAF_FALL_SWAY_AMP_PX = 10;
/** Sway angular frequency (rad/s). */
export const LEAF_FALL_SWAY_OMEGA = 1.85;
/**
 * Gravity scale vs break debris ({@link ITEM_GRAVITY} × {@link BLOCK_SIZE} × this).
 */
export const LEAF_FALL_GRAVITY_MUL = 0.085;
/** Per-second velocity retention (raised to the power dt×60 for frame-rate independence). */
export const LEAF_FALL_AIR_DRAG = 0.988;
/** Fade out over this clearance (world px) above non-leaf ground. */
export const LEAF_FALL_GROUND_FADE_PX = 44;
/** Despawn when this many px or less above ground top. */
export const LEAF_FALL_DESPAWN_CLEARANCE_PX = 2;
/** Safety cap on leaf-fall lifetime (seconds). */
export const LEAF_FALL_MAX_LIFETIME_SEC = 48;
/** Particle frames in atlas (`leaf_0` … `leaf_N`). */
export const LEAF_FALL_FRAME_COUNT = 12;

/**
 * Falling-leaf sprites spawned per unit break progress while mining logs or leaves
 * (local player); scaled via fractional carry like {@link BLOCK_BREAK_PARTICLES_PER_PROGRESS}.
 */
export const LEAF_FALL_MINING_PARTICLES_PER_PROGRESS = 11;
/** Random world-cell samples per spawned mining leaf (canopy may be offset from the trunk cell). */
export const LEAF_FALL_MINING_SAMPLE_TRIES = 7;

/** Ambient flower butterflies: max concurrent sprites (client-only VFX). */
export const BUTTERFLY_MAX_PARTICLES = 40;
/** Hard cap on butterflies inside the tight (non-margin) camera rect at once. */
export const BUTTERFLY_MAX_ONSCREEN = 10;
/** Outer spawn attempts per fixed tick (each tries several cells in one chunk). */
export const BUTTERFLY_SPAWN_TRIES_PER_TICK = 10;
/** Random foreground cells sampled per attempt (within one chunk) to find a flower. */
export const BUTTERFLY_FLOWER_LOCATE_SAMPLES = 28;
/** Probability to spawn once a flower cell is found for that attempt. */
export const BUTTERFLY_SPAWN_CHANCE = 0.65;
/** Chebyshev chunk distance from player for which chunks are considered loaded candidates. */
export const BUTTERFLY_SPAWN_CHUNK_RADIUS = 8;
/**
 * Prefer sampling chunks within this Chebyshev distance of the player (surface/flora density);
 * falls back to the full candidate set when none match.
 */
export const BUTTERFLY_SPAWN_POOL_CHEB = 6;
/** Seconds per wing half-cycle (open/closed). */
export const BUTTERFLY_FLAP_SEC = 0.11;
/** Despawn after this many seconds fully outside the inflated view rect. */
export const BUTTERFLY_OFFSCREEN_DESPAWN_SEC = 4;
/** Quantized hue offsets in [0, 1). */
export const BUTTERFLY_HUE_BUCKETS = 28;
/** Max baked (variant × hue) texture pairs; evicts oldest when exceeded. */
export const BUTTERFLY_HUE_CACHE_MAX = 72;
/** Screen-space margin (px) expanded to world for visibility / despawn hysteresis. */
export const BUTTERFLY_VIEW_MARGIN_SCREEN_PX = 100;
/** 1 = one sprite texel maps to one world pixel (same space as tiles). */
export const BUTTERFLY_SCALE = 1;
/** Velocity damping per second (higher = snappier stops). */
export const BUTTERFLY_VEL_DAMP_PER_SEC = 1.05;
/** Random acceleration impulse scale (world px/s²-ish). */
export const BUTTERFLY_WANDER_ACCEL = 55;
/** Max speed magnitude (world px/s). */
export const BUTTERFLY_MAX_SPEED = 38;
/** Sine wander strength (world px/s²). */
export const BUTTERFLY_WANDER_SINE_STRENGTH = 32;
/**
 * Max rise above spawn in block heights (world feet-up / Pixi −Y). Keeps flight near the ground / flower band.
 */
export const BUTTERFLY_MAX_RISE_BLOCKS = 2.4;

/** Ambient fireflies (night-only): max concurrent particles. */
export const FIREFLY_MAX_PARTICLES = 10;
/** Hard cap inside tight camera rect to avoid visual overload. */
export const FIREFLY_MAX_ONSCREEN = 5;
/** Spawn attempts per fixed tick (each samples candidate ground cells). */
export const FIREFLY_SPAWN_TRIES_PER_TICK = 10;
/** Random cells sampled per spawn attempt to locate valid near-water ground. */
export const FIREFLY_GROUND_LOCATE_SAMPLES = 20;
/** Probability to spawn once a valid candidate ground cell is found. */
export const FIREFLY_SPAWN_CHANCE = 0.55;
/** Chebyshev chunk distance from player for loaded candidate chunks. */
export const FIREFLY_SPAWN_CHUNK_RADIUS = 8;
/** Prefer chunks near the player for less pop-in and better density. */
export const FIREFLY_SPAWN_POOL_CHEB = 6;
/** Screen-space margin expanded to world for visibility/despawn hysteresis. */
export const FIREFLY_VIEW_MARGIN_SCREEN_PX = 120;
/** Despawn after this many seconds fully outside the loose view rect. */
export const FIREFLY_OFFSCREEN_DESPAWN_SEC = 6;
/** Max rise above spawn anchor (block heights), keeps fireflies low. */
export const FIREFLY_MAX_RISE_BLOCKS = 1.5;
/** Max speed magnitude (world px/s). */
export const FIREFLY_MAX_SPEED = 28;
/** Random acceleration impulse scale (world px/s²-ish). */
export const FIREFLY_WANDER_ACCEL = 48;
/** Sine wander acceleration scale (world px/s²). */
export const FIREFLY_WANDER_SINE_STRENGTH = 24;
/** Per-second velocity damping for smooth drift. */
export const FIREFLY_VEL_DAMP_PER_SEC = 1.2;
/** Candidate ground must have water this close (Chebyshev blocks). */
export const FIREFLY_NEAR_WATER_RADIUS_BLOCKS = 5;
/** Avoid spawning directly on immediate shoreline edge. */
export const FIREFLY_MIN_WATER_DISTANCE_BLOCKS = 2;
/** Max dynamic firefly lights submitted to composite each frame. */
export const FIREFLY_LIGHT_MAX_EMITTERS = 5;
/** Relative strength for firefly lights in the placed-light path. */
export const FIREFLY_LIGHT_STRENGTH = 0.42;
/** Added to firefly world X (px) before bloom/placed-light worldBlockX; negative = left on screen. */
export const FIREFLY_LIGHT_BLOOM_OFFSET_SCREEN_PX = -2;

/** Blocks per chunk edge (square chunks). */
export const CHUNK_SIZE = 32;

/** Chunks within this Chebyshev distance of the stream centre get rendered (meshes). */
export const VIEW_DISTANCE_CHUNKS = 5;

/**
 * Chunks within this Chebyshev distance of the stream centre stay loaded for simulation
 * (block ticks, persistence reads). Must be >= {@link VIEW_DISTANCE_CHUNKS}.
 */
export const SIMULATION_DISTANCE_CHUNKS = 12;

/**
 * Chunk columns with |cx| <= this radius (world spawn at block x=0) are never evicted
 * once loaded, so the origin strip keeps simulating when the player is far away.
 */
export const SPAWN_CHUNK_RADIUS = 5;

/**
 * Hard upper bound on simultaneously loaded chunks. When exceeded after normal distance
 * eviction, the farthest chunks are evicted regardless of spawn-strip status.
 *
 * Sized to comfortably fit the natural simulation ring
 * `(2 * SIMULATION_DISTANCE_CHUNKS + 1)^2 = 625` plus a small spawn-strip
 * allowance, so Pass 2 of {@link ChunkManager.updateLoadedChunks} no longer
 * thrashes by evicting chunks that are still inside the sim ring (which on a
 * new world forces full procedural regen on the next stream pass).
 *
 * Memory: each chunk's typed-array record is ~6 KB raw; mesh state pushes the
 * effective cost to ~30–50 KB per chunk, so 950 chunks ≈ 30–50 MB — well
 * within budget on the observed ~110 MB working set.
 */
export const LOADED_CHUNK_HARD_CAP = 950;

/**
 * When true, {@link World} streaming routes procedural chunk generation
 * (terrain noise + caves + ores + sediment + sea-level flood + surface
 * vegetation + structure features) to a dedicated worker pool
 * (see {@link WorldGenWorkerPool}) instead of running it on the main thread.
 *
 * Falls back to the synchronous main-thread path automatically when:
 *  - the runtime does not support module workers,
 *  - a worker fails to initialize, or
 *  - a worker rejects a `generate` request (the per-call promise is caught and
 *    the sync `_chunkGen` is retried inline).
 *
 * Synchronous edit paths (`setBlock` / `setForegroundBlock` /
 * `setBackgroundBlock` in unloaded chunks) always use the inline `_chunkGen`
 * regardless of this flag — those callers cannot await.
 */
export const WORLDGEN_USE_WORKER = true;

/**
 * Upper bound on the {@link WorldGenWorkerPool} size.
 *
 * The runtime negotiates a smaller value when `navigator.hardwareConcurrency` is
 * low (the floor is 1, the heuristic is `max(1, hc - 2)`); this constant is
 * the *cap* applied on top of that heuristic. Sized to balance:
 *  - **throughput**: chunk gen is embarrassingly parallel and benefits roughly
 *    linearly until the dispatcher (`World.loadChunksAroundCentre`) saturates,
 *  - **memory**: each worker re-imports the WorldGenerator module graph and
 *    holds its own `BlockRegistry` snapshot (~tens of KB),
 *  - **OS contention**: leaving 2 cores free for the main thread, audio thread,
 *    GPU thread, and other browser internals avoids preemption stalls under
 *    load.
 *
 * 6 leaves room for the dispatcher to keep enough chunks in flight on
 * 8-core+ devices while still bounding total worker memory on lower-end
 * hardware (since the `hc - 2` floor still clamps).
 */
export const WORLDGEN_WORKER_POOL_MAX = 6;

/**
 * Maximum number of spawn-strip chunk *columns* (|cx| <= SPAWN_CHUNK_RADIUS) that are
 * exempt from distance eviction. Beyond this column count the spawn-strip exemption is
 * ignored, preventing unbounded accumulation on tall worlds.
 */
export const MAX_SPAWN_STRIP_COLUMNS = 50;

/**
 * Blocks a player must move into a new chunk (per axis) before streaming shifts that axis.
 * Prevents rapid load/unload when feet jitter across a chunk boundary (e.g. near world Y≈0).
 */
export const STREAM_CHUNK_HYSTERESIS_BLOCKS = 8;

/** Inclusive vertical world bounds (block Y). X is unbounded. */
export const WORLD_Y_MIN = -256;
export const WORLD_Y_MAX = 512;

/** Fixed simulation rate (Hz). */
export const FIXED_HZ = 60;

/** Fixed timestep in seconds (1/60). */
export const FIXED_TIMESTEP_SEC = 1 / FIXED_HZ;

/** Fixed timestep in milliseconds. */
export const FIXED_TIMESTEP_MS = 1000 / FIXED_HZ;

/**
 * Cap a single frame's real time so a tab background spike does not explode the accumulator.
 */
export const MAX_FRAME_MS = 250;
/** Prevent one RAF frame from running unbounded fixed-step catch-up work. */
export const MAX_FIXED_STEPS_PER_FRAME = 4;
/**
 * Wall-clock budget (ms) for one synchronous drain of the deferred light queue
 * (`World.flushPendingLightRecomputes` and each slice of streaming settle).
 */
export const LIGHT_RECOMPUTE_BUDGET_MS = 4;
/**
 * For a single-cell block change, light invalidation enqueues at most the home chunk plus
 * immediate cardinal chunk neighbours (edge-crossing), i.e. radius 1 in chunk grid — see
 * {@link World.setBlock} enqueue logic.
 */
export const LIGHT_PROPAGATION_NEIGHBOUR_RADIUS = 1;

/** Max chunk mesh updates (existing meshes) per frame; excess `renderDirty` work rolls to the next frame. */
export const CHUNK_SYNC_MAX_PER_FRAME = 8;
/**
 * When this many dirty chunks are waiting, cap updates per frame lower so uploads spread across
 * frames (reduces single-frame spikes after bulk edits or streaming).
 */
export const CHUNK_SYNC_DEFER_DIRTY_THRESHOLD = 28;
/** Per-frame dirty mesh cap when {@link CHUNK_SYNC_DEFER_DIRTY_THRESHOLD} is exceeded. */
export const CHUNK_SYNC_MAX_PER_FRAME_UNDER_LOAD = 5;
/**
 * Soft per-frame wall-clock budget for chunk mesh rebuilds (ms). Once the
 * dirty loop has consumed this much time it stops scheduling additional
 * rebuilds for this frame, even if the count cap hasn't been hit yet — the
 * remaining items keep their `renderDirty` flag and roll to the next frame.
 *
 * Sized so a single heavy chunk (e.g. a built structure with chests, doors,
 * signs and glass) can still rebuild on a frame where it's first in line, but
 * a burst of dirty chunks (door state changes near a cabin, bulk edits) can't
 * stack into one ~30 ms vsync-locked frame.
 */
export const CHUNK_SYNC_BUDGET_MS = 4;
/**
 * Hard cap on freshly built chunk meshes per frame in {@link ChunkRenderer.syncChunks}.
 * New chunks are always rebuilt nearest-first; chunks beyond this cap are simply
 * skipped this frame and picked up on a subsequent frame's `syncChunks` call
 * (their `meshes` map entry is still missing so they'll be detected again).
 *
 * Sized so a typical "walk into a new chunk row" (≈11 visible new chunks at
 * view distance 5) spreads across ~3 frames instead of stacking into one
 * 80–400 ms hitch.
 */
export const CHUNK_SYNC_NEW_MESH_MAX_PER_FRAME = 4;
/**
 * Soft per-frame wall-clock budget specifically for the new-mesh build pass
 * (ms). Applied in addition to the dirty-rebuild budget — a frame that already
 * exhausted {@link CHUNK_SYNC_BUDGET_MS} on dirty work still gets to build at
 * most one new chunk so the streaming queue can't fully starve.
 */
export const CHUNK_SYNC_NEW_MESH_BUDGET_MS = 4;

/** Min interval between render-path `InputManager.updateMouseWorldPos` calls (~60 Hz). */
export const POINTER_MOVE_THROTTLE_MS = 16;

/** Minimum interval between footstep SFX while walking (seconds). */
export const STEP_INTERVAL = 0.35;

/**
 * Mining “hit” SFX cadence while holding break (Minecraft-style ~4 game ticks at 20 TPS ≈ 0.2s),
 * not tied to crack overlay stage.
 */
export const MINING_DIG_SOUND_INTERVAL_SEC = 0.2;

/** Maximum sky light level (matches Minecraft-style 0–15 scale). */
export const SKY_LIGHT_MAX = 15;

/** Maximum block light level. */
export const BLOCK_LIGHT_MAX = 15;

/**
 * Held torch: radial cutoff in world blocks from player centre (composite pass).
 * Matches `stratum:torch` light_emission (14): BFS reaches ~14 steps with level > 0.
 */
export const TORCH_HELD_LIGHT_RADIUS_BLOCKS = 14;

/** Peak brightness multiplier for held torch (before clamp). */
export const TORCH_HELD_LIGHT_INTENSITY = 0.55;

/**
 * Placed emitters (torches, etc.) sent to the composite shader per frame.
 * Each slot is one `vec4` uniform; WebGL typically allows ~224 fragment uniform **vectors**
 * total, so this array plus all other composite uniforms must stay under that cap (256 failed
 * to link: INVALID_OPERATION / program not valid).
 */
export const MAX_PLACED_TORCHES = 128;

/** Ray-march radius (blocks) for placed torch directional lighting — matches BFS emission range. */
export const PLACED_TORCH_RADIUS_BLOCKS = 14;

/**
 * Torch flame in the 16×16 tile: center of the visible ~2×6 flame (pixels from the cell’s
 * top-left). Lighting/bloom use this so effects align with art instead of the block’s corner.
 */
export const TORCH_FLAME_TIP_PX_X = 7.5;
export const TORCH_FLAME_TIP_PX_Y = 2.5;
/** Offset from integer block (wx, wy) to flame center in world block units (composite pass). */
export const TORCH_FLAME_TIP_OFFSET_X_BLOCKS = TORCH_FLAME_TIP_PX_X / BLOCK_SIZE;
/** `wy` increases upward; tip sits near the top of the cell. */
export const TORCH_FLAME_TIP_OFFSET_Y_BLOCKS =
  (BLOCK_SIZE - TORCH_FLAME_TIP_PX_Y) / BLOCK_SIZE;

/**
 * Full day/night cycle in real time (20 minutes).
 * Segments: dawn 1.5m, daylight 10m, dusk 1.5m, night 7m.
 */
export const DAY_LENGTH_MS = 20 * 60 * 1000;

export const DAWN_LENGTH_MS = 90 * 1000;
export const DAYLIGHT_LENGTH_MS = 10 * 60 * 1000;
export const DUSK_LENGTH_MS = 90 * 1000;

/** Within this Chebyshev distance (blocks) the item pulls toward the player and can be collected. */
export const ITEM_PULL_RANGE_BLOCKS = 1.5;

/** World pixels per second when pulling toward the player. */
export const ITEM_PULL_SPEED_PX = 720;

/** Collect when center-to-center distance is below this (world pixels). */
export const ITEM_COLLECT_SNAP_PX = 10;

/**
 * After the local player throws/drops an item (Q, cursor toss), this many seconds pass
 * before it can be magnet-pulled or picked up — avoids instantly re-absorbing the entity
 * (Minecraft-style pickup delay).
 */
export const ITEM_PLAYER_THROW_PICKUP_DELAY_SEC = 0.5;

/**
 * Minimum time between world pickup pops while a stack is merging in over many fixed ticks
 * (avoids ~60 Hz SFX when the player stays inside {@link ITEM_COLLECT_SNAP_PX}).
 */
export const ITEM_PICKUP_SFX_MIN_INTERVAL_MS = 180;

/** Dropped item gravity acceleration (blocks per second²). */
export const ITEM_GRAVITY = 20;

/** Dropped item max fall speed (blocks per second). */
export const ITEM_MAX_FALL_SPEED = 15;

/** Half-width of a dropped item hitbox in world pixels (matches 0.5× block sprite). */
export const ITEM_HALF_EXTENT_PX = BLOCK_SIZE * 0.25;

/**
 * Aim magnitude for Q / inventory cursor toss (px/s), before player-velocity blend and
 * {@link ITEM_THROW_MAX_INITIAL_SPEED_PX}. Tuned with item gravity so typical arcs stay
 * within roughly {@link ITEM_THROW_MAX_RANGE_BLOCKS}.
 */
export const ITEM_THROW_SPEED_PX = 4.6 * BLOCK_SIZE;

/** Soft target for how far a toss should travel (blocks); used to document the speed cap. */
export const ITEM_THROW_MAX_RANGE_BLOCKS = 2.5;

/**
 * Hard cap on initial √(vx²+vy²) (px/s) after aim + horizontal carry — prevents sprint
 * or steep aim from exceeding ~{@link ITEM_THROW_MAX_RANGE_BLOCKS} for normal ground arcs.
 */
export const ITEM_THROW_MAX_INITIAL_SPEED_PX = 6.1 * BLOCK_SIZE;

/** Spawn offset from player center along aim (px) so the entity clears the body. */
export const ITEM_THROW_SPAWN_OFFSET_PX = 14;

/**
 * Thrown items blend cursor aim with facing: horizontal direction must align with
 * facing (dot of unit dirX and ±1) by at least this much so Q/cursor tosses push
 * away from the body instead of into the back.
 */
export const ITEM_THROW_MIN_OUTWARD_VS_FACE = 0.5;

/** Horizontal throw adds this fraction of the player's foot velocity (Minecraft-like carry). */
export const ITEM_THROW_INHERIT_PLAYER_VEL_X = 0.12;

/** Seconds of right-hold to reach full bow draw (charge = 1). */
export const BOW_MAX_DRAW_SEC = 0.78;

/** Ground / air horizontal cap multiplier while drawing the bow (stratum:bow + RMB). */
export const BOW_DRAW_MOVE_SPEED_MULT = 0.58;

/** Item-atlas texture key for bow from draw time (idle + `bow_pulling_0`…`2`). */
export function bowDrawItemTextureName(drawSec: number): string {
  if (drawSec <= 0) {
    return "bow";
  }
  const t = Math.min(1, Math.max(0, drawSec / BOW_MAX_DRAW_SEC));
  if (t < 1 / 3) {
    return "bow_pulling_0";
  }
  if (t < 2 / 3) {
    return "bow_pulling_1";
  }
  return "bow_pulling_2";
}

/** Arrow initial speed at minimum charge (px/s, applied along aim). */
export const ARROW_SPEED_MIN_PX = 155;

/** Arrow initial speed at full draw (px/s). */
export const ARROW_SPEED_MAX_PX = 940;

/** Arrow gravity (blocks/s²); slightly lower than dropped items for a flatter arc. */
export const ARROW_GRAVITY_BLOCKS_PER_SEC2 = 14;

/** Arrow max downward speed (blocks/s). */
export const ARROW_TERMINAL_FALL_BLOCKS_PER_SEC = 52;

/** Hitbox half-extent in world pixels (small line collider). */
export const ARROW_HALF_EXTENT_PX = 2.5;

/**
 * Mob-stuck arrows: distance from hit center to tip along flight (`rotationRad`), world px.
 * Used to pin the **tip** to the body while the corpse tilts (see {@link ArrowProjectile.syncStuckMobPosition}).
 */
export const ARROW_STUCK_SHAFT_CENTER_TO_TIP_PX = 9;

/** Remove **flying** arrows after this many seconds (failsafe). */
export const ARROW_MAX_AGE_SEC = 6;

/** Stuck-in-block arrows despawn if not picked up (keeps worlds from accumulating forever). */
export const ARROW_STUCK_BLOCK_MAX_AGE_SEC = 420;

/**
 * Player torso point (`y + PLAYER_HEIGHT/2`) within this distance can retrieve a ground-stuck arrow.
 */
export const ARROW_STUCK_COLLECT_SNAP_PX = 14;

/**
 * Angle of the arrow texture tip (tail→head) when `rotation === 0`, in the same convention as
 * `Math.atan2(displayDy, displayDx)` / `Math.atan2(vy, vx)` (+y down on screen). Item art points
 * bottom-left (~SW) ≈ 3π/4. World sprite: `rotation = atan2(...) − this` (tuned vs item atlas).
 */
export const ARROW_SPRITE_TIP_ANGLE_AT_ZERO_ROT_RAD = (3 * Math.PI) / 4;

/** Horizontal velocity multiplier when an item lands (world-down vy, screen-down dy). */
export const ITEM_DROP_LANDING_FRICTION = 0.78;

/** Number of inventory slots (4 rows × 9 columns = 36). */
export const INVENTORY_SIZE = 36;

/** Chest storage: single chest (half of player grid). */
export const CHEST_SINGLE_SLOTS = INVENTORY_SIZE / 2;

/** Double chest (full player grid). */
export const CHEST_DOUBLE_SLOTS = INVENTORY_SIZE;

/** Chebyshev radius from feet to a chest for opening / UI (matches crafting table metric). */
export const CHEST_ACCESS_RADIUS_BLOCKS = 4;

/** Number of hotbar slots. */
export const HOTBAR_SIZE = 9;

/** Armor equipment slot count (helmet, chestplate, leggings, boots). */
export const ARMOR_SLOT_COUNT = 4;

/**
 * Inventory UI sentinel for armor rows (`data-slot="${ARMOR_UI_SLOT_BASE + ArmorSlot}"`).
 * Shift-click / pointer routing treats 100–103 as armor, not main inventory indices.
 */
export const ARMOR_UI_SLOT_BASE = 100;

/** Player health (integer HP). Each heart icon represents 2 HP. */
export const PLAYER_MAX_HEALTH = 10;

/** Local player death: tip-over + fade before the respawn / menu prompt. */
export const PLAYER_DEATH_ANIM_DURATION_SEC = 2.25;

/** Full-strength red flash on the local player sprite after taking damage (decays in {@link Player}). */
export const PLAYER_DAMAGE_TINT_DURATION_SEC = 0.28;

/**
 * Blocks fallen (downward feet travel) before fall damage starts. Matches vanilla-style ~3-block safe drop.
 */
export const PLAYER_FALL_SAFE_BLOCKS = 3;

/**
 * Vanilla player max HP used only to scale fall damage when {@link PLAYER_MAX_HEALTH} differs.
 * Damage = max(0, floor((fallBlocks − safe) × maxHealth / this)).
 *
 * Floor after scaling keeps Minecraft-like breakpoints at low max health (e.g. 22 blocks → 9 damage,
 * 23 → 10 at 10 HP). Using ceil((fall − safe) × maxHealth/20) would kill at 22 blocks.
 */
export const PLAYER_FALL_DAMAGE_REFERENCE_MAX_HEALTH = 20;

/** Hearts shown in the HUD (2 HP per heart, spans {@link PLAYER_MAX_HEALTH}). */
export const PLAYER_HEART_COUNT = 5;

/**
 * Temporary HP (e.g. raw food): HUD pink hearts fade in opacity over the last
 * this many seconds before the buff ends.
 */
export const PLAYER_TEMP_HEART_FADE_START_SEC = 2.6;

/**
 * One full pulse (bright→dim) cycle: slow when a lot of time left, short when almost expired.
 * Actual period is lerped from {@link PLAYER_TEMP_PULSE_MAX_SEC} down to
 * {@link PLAYER_TEMP_PULSE_MIN_SEC} using remaining temp duration.
 */
export const PLAYER_TEMP_PULSE_MAX_SEC = 2.0;
export const PLAYER_TEMP_PULSE_MIN_SEC = 0.4;

/**
 * `remain` above this many seconds is treated as “full slow pulse” (avoids unbounded slow wobble on long buffs).
 */
export const PLAYER_TEMP_PULSE_REMAIN_REF_SEC = 40;

/**
 * Beta-style armor: max mitigation per piece before cap (four pieces × 0.2 = 0.8, like
 * four armor points × 4% each toward the classic `/25` cap).
  */
export const PLAYER_ARMOR_BETA_MITIGATION_PER_PIECE = 0.2;

/**
 * Hard cap on armor mitigation (80% — same as 20 armor points ÷ 25 in post-Beta Java).
 */
export const PLAYER_ARMOR_BETA_MITIGATION_CAP = 0.8;

/**
 * When the player takes damage, armor durability loss uses `max(1, floor(rawDamage / this))`
 * total points, spread round-robin across equipped damageable armor (Beta-style).
 */
export const PLAYER_ARMOR_DURABILITY_LOSS_DIVISOR = 4;

/** Fall damage ignores armor mitigation so long falls stay dangerous at 10 max HP. */
export const PLAYER_FALL_DAMAGE_IGNORES_ARMOR = true;

/** Fall damage in HP from accumulated fall distance (blocks), before armor/resistance. */
export function playerFallDamageFromDistance(fallBlocks: number): number {
  const excess = fallBlocks - PLAYER_FALL_SAFE_BLOCKS;
  if (excess <= 0) {
    return 0;
  }
  return Math.floor(
    excess * (PLAYER_MAX_HEALTH / PLAYER_FALL_DAMAGE_REFERENCE_MAX_HEALTH),
  );
}

/** Shared duration (ms) for inventory panel + crafting sidebar open/close CSS transitions. */
export const INVENTORY_ANIM_MS = 300;

/** Item icon scale inside each slot (px); matches `--inv-slot-icon-px` in inventory.css. */
export const INVENTORY_ITEM_ICON_DISPLAY_PX = 48;

/** Metadata bit: world-generated tree block — no player collision. */
export const WORLDGEN_NO_COLLIDE = 0x01;

/**
 * World Y used only for water column depth tint in the renderer (deeper below this → darker).
 * Often aligned with {@link WATER_SEA_LEVEL_WY} for consistent shading.
 */
export const WATER_DEPTH_TINT_REFERENCE_WY = -15;

/**
 * Final chunk flood-fill: open-sky-connected air at this world Y or below becomes water.
 * Tune relative to terrain surface height range so you get coastlines, not all-ocean.
 */
export const WATER_SEA_LEVEL_WY = 2;

/**
 * Dry columns ({@link TerrainNoise} base layer, before lake-biome depth blend): lowest allowed surface Y is
 * `WATER_SEA_LEVEL_WY + this`. Larger ⇒ higher dry valleys; fewer stray ponds where noise alone dipped below sea.
 * Standing water lakes still spawn where {@link LAKE_BIOME_SCALE_BLOCKS} mask carves terrain down.
 */
export const LAND_SURFACE_MIN_CLEARANCE_ABOVE_SEA_BLOCKS = 1;

/**
 * Added to {@link TerrainNoise} base height before lake blending. Fewer shallow seas when land sits higher vs {@link WATER_SEA_LEVEL_WY}.
 */
export const TERRAIN_BASE_SURFACE_BIAS_BLOCKS = 2;

/**
 * Lake biome carve: horizontal noise scale (`wx / this`). Larger ⇒ rarer/smoothed carved basins edge-to-edge.
 */
export const LAKE_BIOME_SCALE_BLOCKS = 1100;

/**
 * Lake mask rarity (macro/micro combine before {@link LAKE_BIOME_INFLUENCE_POW}): raise both smoothstep lows
 * (in 0–1 noise space) to make carved lakes scarcer without changing dry-land stray water (handled by {@link LAND_SURFACE_MIN_CLEARANCE_ABOVE_SEA_BLOCKS}).
 */
/** Narrower lake basins vs sea (fewer large “ocean” columns). */
export const LAKE_BIOME_MACRO_SMOOTH_LOW = 0.962;
export const LAKE_BIOME_MACRO_SMOOTH_HIGH = 0.995;

/**
 * Second noise channel (0..1): multiplied with macro mask for irregular shorelines and extra rarity.
 */
export const LAKE_BIOME_MICRO_SMOOTH_LOW = 0.7;
export const LAKE_BIOME_MICRO_SMOOTH_HIGH = 0.94;

/**
 * Applied to (macro × micro) so mid-strength shores shrink — fewer large lake footprints.
 */
export const LAKE_BIOME_INFLUENCE_POW = 2.28;

/** Approximate lake bed depth below {@link WATER_SEA_LEVEL_WY} at full lake influence (before jitter). */
export const LAKE_BIOME_DEPTH_BLOCKS = 7;

/** Lake bed vertical jitter amplitude (blocks), from high-frequency noise. */
export const LAKE_BIOME_DEPTH_JITTER_SCALE = 2;

/** Do not spawn trees when lake shore blend exceeds this (0..1). */
export const LAKE_BIOME_TREE_SUPPRESS_INFLUENCE = 0.12;

/** Max horizontal flow distance from a source / fall reset (Minecraft-style “9 more blocks”). */
export const WATER_MAX_FLOW = 9;

/**
 * Water flow level packed in chunk metadata (bits 1–5, after {@link WORLDGEN_NO_COLLIDE}).
 * 0 = source / full block; 1..{@link WATER_MAX_FLOW} = flowing (farther = more top crop).
 */
export const WATER_FLOW_SHIFT = 1;
export const WATER_FLOW_MASK = 0x3e;

/** Run water flow spread every N fixed ticks (slightly slower, closer to Minecraft feel). */
export const WATER_FLOW_EVERY_N_TICKS = 3;

/** Horizontal move multiplier while the player overlaps water blocks. */
export const PLAYER_WATER_SPEED_MULT = 0.35;

/** Fraction of normal gravity applied while submerged (slow sink). */
export const PLAYER_WATER_GRAVITY_MULT = 0.14;

/** Max downward speed in water (px/s, world Y up). */
export const PLAYER_WATER_MAX_SINK_SPEED_PX = 110;

/** Upward acceleration while holding jump in water (world Y up, applied as −vy per second). */
export const PLAYER_WATER_SWIM_HOLD_UP_ACCEL = 520;

/** Most negative vy (fastest upward swim) while holding jump in water. */
export const PLAYER_WATER_SWIM_HOLD_MAX_UP_SPEED = -118;

/** Constant upward speed while climbing a ladder (hold jump / W / up; world Y up). */
export const PLAYER_LADDER_CLIMB_VY = -115;

/** Max downward speed on a ladder when not holding climb (slow slide). */
export const PLAYER_LADDER_MAX_DESCEND_VY = 90;

/** Fall damage multiplier when landing with exactly one block of water above solid support. */
export const PLAYER_FALL_SHALLOW_WATER_DAMAGE_MULT = 0.45;

/**
 * Walk-cycle playback multiplier while feet overlap water (player + mobs). Minecraft-style
 * slower limb motion than on land; physics are unchanged.
 */
export const PLAYER_WATER_WALK_ANIM_SPEED_MULT = 0.42;

/** Account username length (profiles table CHECK aligns). */
export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 20;

/** IndexedDB object store for cached workshop ZIP contents (see {@link IndexedDBStore}). */
export const MOD_CACHE_STORE = "mod-cache" as const;

/** Max workshop .zip upload / install size (bytes). */
export const MOD_MAX_ZIP_SIZE = 2 * 1024 * 1024;

/** Max workshop cover image size (bytes). */
export const MOD_MAX_COVER_SIZE = 512 * 1024;

/** Workshop directory page size (list RPC). */
export const MOD_PAGE_SIZE = 20;

/** Horizontal parallax factor for distant terrain (screen-space, matches legacy bg.png). */
export const BACKGROUND_PARALLAX_X = 0.15;

/** Debounce before rebuilding backdrop after window resize. */
export const BACKGROUND_RESIZE_DEBOUNCE_MS = 300;

/**
 * Leftmost world block column (X) where the parallax tile strip starts — same terrain as the
 * main world at those coordinates (1:1 with {@link WorldGenerator}).
 */
export const BACKGROUND_TILE_STRIP_ORIGIN_BLOCK_X = 50;

/** Chunk columns = ceil(viewportWidth×scale / chunk) + margin; menu / non-gameplay parallax. */
export const BACKGROUND_TILE_STRIP_WIDTH_SCALE = 2;

/**
 * In-game parallax uses a **fixed** world anchor (no sliding), so the strip is made wider than
 * {@link BACKGROUND_TILE_STRIP_WIDTH_SCALE} so long walks stay inside generated columns longer.
 */
export const BACKGROUND_TILE_STRIP_WIDTH_SCALE_GAMEPLAY = 4;

/**
 * Multiplier on camera zoom for the parallax tile strip only; values below 1 read as farther /
 * smaller than the playable layer.
 */
export const BACKGROUND_TILE_STRIP_VISUAL_SCALE = 0.52;

/** Gaussian blur on the strip (both axes); applied via Pixi {@link BlurFilter} on the strip container. */
export const BACKGROUND_TILE_STRIP_BLUR = 6;

/** Blur quality (Pixi passes); higher = smoother, costlier. */
export const BACKGROUND_TILE_STRIP_BLUR_QUALITY = 3;

/**
 * Extra multiplier on world ambient for the blurred parallax strip tint.
 * `1` = peak daylight uses full texture lightness; below `1` dims the strip even at noon.
 */
export const BACKGROUND_TILE_STRIP_LIGHT_ATTENUATION = 1;

/**
 * When {@link WorldLightingParams.ambient} is below this, night parallax boosts apply
 * ({@link BACKGROUND_TILE_STRIP_NIGHT_PARALLAX_MIN_SCALE}, {@link BACKGROUND_TILE_STRIP_NIGHT_PARALLAX_TINT_WHITEN}, etc.).
 */
export const BACKGROUND_TILE_STRIP_NIGHT_PARALLAX_AMBIENT_BELOW = 0.5;

/**
 * Floor on parallax tint brightness at night (before ambientTint). Stops the horizon going
 * nearly black when `ambient` is tiny; proportional `× BRIGHTEN` alone barely moves it.
 */
export const BACKGROUND_TILE_STRIP_NIGHT_PARALLAX_MIN_SCALE = 0.22;

/** Extra multiplier on scale when ambient is below {@link BACKGROUND_TILE_STRIP_NIGHT_PARALLAX_AMBIENT_BELOW}. */
export const BACKGROUND_TILE_STRIP_NIGHT_PARALLAX_BRIGHTEN = 1.02;

/**
 * At full night (ambient → 0), blend this much of ambientTint toward white so cool night
 * colors do not crush the distant strip.
 */
export const BACKGROUND_TILE_STRIP_NIGHT_PARALLAX_TINT_WHITEN = 0.38;

/**
 * Distance-fog strength for the parallax terrain strip: how strongly the multiplicative
 * tint is pulled toward the sky's lower-gradient colour. 0 = no fog (raw texture tint),
 * 1 = tint is fully the sky colour (terrain reads as a silhouette in the sky's hue).
 *
 * Matches the "atmospheric perspective" in the reference screenshot where distant trees
 * desaturate toward the sunset sky.
 */
export const BACKGROUND_TILE_STRIP_SKY_FOG_BLEND = 0.55;

/**
 * Slide parallax chunk window when the camera is within this many **blocks** of strip edge.
 * ~1.5 chunks: earlier than one chunk, but not so wide that a minimal strip (4 cols) has no interior.
 */
export const BACKGROUND_TILE_STRIP_CAMERA_EDGE_MARGIN_BLOCKS =
  CHUNK_SIZE + Math.floor(CHUNK_SIZE / 2);

/** Vertical chunk span (inclusive) for the strip; mirrors main-menu background depth. */
export const BACKGROUND_TILE_STRIP_CY_START = -3;
export const BACKGROUND_TILE_STRIP_CY_END = 2;
