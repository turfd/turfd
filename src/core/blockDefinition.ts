/** Material category for audio (break / place / step SFX). */
export type BlockMaterial =
  | "stone"
  | "dirt"
  | "wood"
  | "grass"
  | "sand"
  | "gravel"
  | "glass"
  | "door"
  | "chest"
  | "furnace"
  | "generic";

/** Shared block fields (no registry id) — used by JSON parsing and {@link BlockDefinition}. */
export interface BlockDefinitionBase {
  identifier: string;
  displayName: string;
  /** Footstep / break / place SFX category; default `generic` if omitted in JSON. */
  material: BlockMaterial;
  /** Atlas frame name (e.g. `"stone"`). */
  textureName: string;
  /** If true, texture can be horizontally mirrored based on world position. */
  randomFlipX?: boolean;
  solid: boolean;
  /**
   * When false, entities do not collide with this block’s cell (player, dropped items).
   * Defaults to {@link solid} when omitted from JSON (`stratum:collision`).
   * Use with `solid: true` for furniture that still occludes light and supports placement.
   */
  collides: boolean;
  transparent: boolean;
  /** Render-only; no fluid simulation in Phase 1. */
  water: boolean;
  /** Minecraft-style hardness. Break time derived via {@link getBreakTimeSeconds}. */
  hardness: number;
  /** Tool type that speeds up mining (axe for wood, pickaxe for stone, shovel for soil). */
  harvestToolType?: "axe" | "pickaxe" | "shovel";
  /** When true, mining without the correct tool+tier drops nothing. */
  requiresToolForDrops: boolean;
  /** Minimum tool tier needed for drops (0=wood, 1=stone, 2=iron, 3=diamond). */
  minToolTier: number;
  /** 0–15 */
  lightEmission: number;
  /** 0–15 */
  lightAbsorption: number;
  /** Dropped item identifiers (Phase 3). */
  drops: string[];
  /**
   * Namespaced loot table key, e.g. "stratum:stone".
   * Resolved by LootResolver at block-break time.
   * Undefined means the block drops nothing.
   */
  readonly lootTable?: string;
  /**
   * Non-solid blocks that can be replaced by placing another block in the same cell
   * (the plant is removed).
   */
  replaceable: boolean;
  /** Tall-grass pair: bottom removes top when broken; top is the upper half. */
  tallGrass: "none" | "bottom" | "top";
  /** Two-tall door halves; paired like tall grass (`stratum:door_half`). */
  doorHalf: "none" | "bottom" | "top";
  /** Two-wide bed halves; foot is the placed-from-item cell (`stratum:bed_half`). */
  bedHalf: "none" | "foot" | "head";
  /**
   * Pixels cropped from the top of the cell when drawing (0–15). Bottom of the quad stays
   * on the block’s lower edge so short plants don’t visually float above the ground.
   */
  plantFootOffsetPx?: number;
  /**
   * Whole-pixel shift applied to the plant tile quad on Y after {@link plantFootOffsetPx} UV crop.
   * Positive moves the sprite down on screen (e.g. align crops with lowered farmland art).
   */
  plantRenderOffsetYPx?: number;
  /**
   * Foreground tile wind: oscillates the whole sprite horizontally by up to this many **whole
   * pixels** (pixel-snapped, not skew). Omit or 0 to disable.
   */
  windSwayMaxPx?: number;
  /** Crafting tags (e.g. `"stratum:logs"`, `"stratum:planks"`). */
  tags?: readonly string[];
  /** Corner-cut stair; orientation in chunk metadata bits 6–7 (`getStairShape`). */
  isStair?: boolean;
  /**
   * Copied to the auto-registered block item: furnace burn seconds per item (`stratum:fuel` in block JSON).
   */
  fuelBurnSeconds?: number;
  /**
   * When true, `registerBlockItems` skips auto-creating a block-item for this block.
   * A standalone item with an explicit `stratum:numeric_id` must be provided instead.
   */
  noBlockItem?: true;
  /** Painting block: multi-cell decoration placed on background walls. */
  isPainting?: true;
}
