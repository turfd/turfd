/** Pixel size of one block edge on screen (atlas texel scale). */
export const BLOCK_SIZE = 16;

/** Local player hitbox (world pixels). */
export const PLAYER_WIDTH = 14;
export const PLAYER_HEIGHT = 28;

/**
 * Camera follow: positive values shift the view target upward in world space so the player
 * appears lower on screen (more ground/sky above the character).
 */
export const CAMERA_PLAYER_VERTICAL_OFFSET_PX = 12;

/** Chebyshev reach from player centre block for break/place (blocks). */
export const REACH_BLOCKS = 5;

/** Base seconds per hardness unit for breaking. */
export const BREAK_TIME_BASE = 0.5;

/** Blocks per chunk edge (square chunks). */
export const CHUNK_SIZE = 32;

/** Keep loaded chunks within this Chebyshev distance (chunks) from the view centre. */
export const VIEW_DISTANCE_CHUNKS = 8;

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

/** Minimum interval between footstep SFX while walking (seconds). */
export const STEP_INTERVAL = 0.35;

/** Maximum sky light level (matches Minecraft-style 0–15 scale). */
export const SKY_LIGHT_MAX = 15;

/** Maximum block light level. */
export const BLOCK_LIGHT_MAX = 15;

/** Held torch: radial light radius in world blocks from player centre (screen-space composite). */
export const TORCH_HELD_LIGHT_RADIUS_BLOCKS = 12;

/** Peak brightness multiplier for held torch (before clamp). */
export const TORCH_HELD_LIGHT_INTENSITY = 0.55;

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

/** Dropped item gravity acceleration (blocks per second²). */
export const ITEM_GRAVITY = 20;

/** Dropped item max fall speed (blocks per second). */
export const ITEM_MAX_FALL_SPEED = 15;

/** Half-width of a dropped item hitbox in world pixels (matches 0.5× block sprite). */
export const ITEM_HALF_EXTENT_PX = BLOCK_SIZE * 0.25;

/** Number of inventory slots (4 rows × 9 columns = 36). */
export const INVENTORY_SIZE = 36;

/** Number of hotbar slots. */
export const HOTBAR_SIZE = 9;

/** Account username length (profiles table CHECK aligns). */
export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 20;
