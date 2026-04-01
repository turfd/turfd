/** Material category for audio (break / place / step SFX). */
export type BlockMaterial =
  | "stone"
  | "dirt"
  | "wood"
  | "grass"
  | "sand"
  | "glass"
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
  transparent: boolean;
  /** Render-only; no fluid simulation in Phase 1. */
  water: boolean;
  /** Break time multiplier. */
  hardness: number;
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
  /**
   * Pixels cropped from the top of the cell when drawing (0–15). Bottom of the quad stays
   * on the block’s lower edge so short plants don’t visually float above the ground.
   */
  plantFootOffsetPx?: number;
}
