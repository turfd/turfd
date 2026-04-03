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

/**
 * Recipe JSON `station` value: extra recipes require the player this close (Chebyshev blocks,
 * same cell metric as {@link REACH_BLOCKS}) to a `stratum:crafting_table` foreground block.
 */
export const RECIPE_STATION_CRAFTING_TABLE = "stratum:crafting_table";

/** Chebyshev radius from player feet block cell to a crafting table for station recipes. */
export const CRAFTING_TABLE_ACCESS_RADIUS_BLOCKS = 4;

/**
 * Upper bound for Pixi resolution and CSS sky canvas backing store. Cuts GPU/CPU cost on
 * high-DPR phones and 4K displays without changing layout (CSS still fills the viewport).
 */
export const MAX_RENDER_DEVICE_PIXEL_RATIO = 2;

/** Base seconds per hardness unit for breaking. */
export const BREAK_TIME_BASE = 0.5;

/** Blocks per chunk edge (square chunks). */
export const CHUNK_SIZE = 32;

/** Chunks within this Chebyshev distance of the stream centre get rendered (meshes). */
export const VIEW_DISTANCE_CHUNKS = 8;

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

/**
 * Held torch: radial cutoff in world blocks from player centre (composite pass).
 * Matches `stratum:torch` light_emission (14): BFS reaches ~14 steps with level > 0.
 */
export const TORCH_HELD_LIGHT_RADIUS_BLOCKS = 14;

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

/** Initial speed (px/s) when pressing Q to throw the selected hotbar stack. */
export const ITEM_THROW_SPEED_PX = 380;

/** Spawn offset from player center along aim (px) so the entity clears the body. */
export const ITEM_THROW_SPAWN_OFFSET_PX = 14;

/** Horizontal velocity multiplier when an item lands (world-down vy, screen-down dy). */
export const ITEM_DROP_LANDING_FRICTION = 0.78;

/** Number of inventory slots (4 rows × 9 columns = 36). */
export const INVENTORY_SIZE = 36;

/** Number of hotbar slots. */
export const HOTBAR_SIZE = 9;

/** Player health (integer HP). Each heart icon represents 2 HP. */
export const PLAYER_MAX_HEALTH = 10;

/** Hearts shown in the HUD (2 HP per heart, spans {@link PLAYER_MAX_HEALTH}). */
export const PLAYER_HEART_COUNT = 5;

/** Shared duration (ms) for inventory panel + crafting sidebar open/close CSS transitions. */
export const INVENTORY_ANIM_MS = 300;

/** Item icon scale inside each slot (px); matches `--inv-slot-icon-px` in inventory.css. */
export const INVENTORY_ITEM_ICON_DISPLAY_PX = 48;

/** Metadata bit: world-generated tree block — no player collision. */
export const WORLDGEN_NO_COLLIDE = 0x01;

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

