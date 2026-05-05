/** Shared item type definitions for the inventory system. */

import type { CreativeCategory } from "./creativeCategory";

declare const __itemIdBrand: unique symbol;

/** Branded numeric item identifier used on the wire and in save data. */
export type ItemId = number & { [__itemIdBrand]: never };

export interface ItemDefinition {
  /** Numeric ID used on the wire and in save data. */
  readonly id: ItemId;

  /** Namespaced string key e.g. "stratum:stone". */
  readonly key: string;

  /**
   * Texture lookup key: block items use the block `textureName`; mod items set `stratum:texture_key`
   * or default to the id after `:`. Paths resolve from `item_texture_manifest.json` then `block_texture_manifest.json`.
   */
  readonly textureName: string;

  /** @deprecated All textures use the unified manifest; this field is ignored. */
  readonly iconSheet?: "items";

  /** Display name shown in UI. */
  readonly displayName: string;

  /**
   * Maximum stack size.
   * Default 64. Tools/weapons will use 1 in a later step.
   */
  readonly maxStack: number;

  /**
   * If set, placing this item in the world creates this block ID.
   * Undefined for items that are not placeable blocks.
   */
  readonly placesBlockId?: number;

  /** Tool category (axe, pickaxe, shovel, hoe). Undefined for non-tool items. */
  readonly toolType?: "axe" | "pickaxe" | "shovel" | "hoe";
  /** Tool tier: 0=wood, 1=stone, 2=iron, 3=stratite. */
  readonly toolTier?: number;
  /** Mining speed multiplier when this tool matches the block's harvest tool type. */
  readonly toolSpeed?: number;
  /** Crafting tags this item belongs to (e.g. `"stratum:logs"`). */
  readonly tags?: readonly string[];

  /**
   * Furnace fuel: seconds of burn time per item when placed in the fuel slot.
   * Set via `stratum:fuel` on item or block JSON; `furnace_fuel.json` can still add or raise values.
   */
  readonly fuelBurnSeconds?: number;

  /**
   * When set, stacks of this item track `damage` (uses consumed). Item breaks when
   * `damage >= maxDurability` (Minecraft-style).
   */
  readonly maxDurability?: number;

  /**
   * HP restored when the item is consumed (right-click / use in world).
   * Heart icons use 2 HP each (`PLAYER_MAX_HEALTH`); e.g. `1` restores half a heart.
   */
  readonly eatRestoreHealth?: number;

  /**
   * When set, {@link eatRestoreHealth} is applied as **temporary** HP (not permanent max health).
   * Temporary HP is shown as pink/pulsing hearts and expires after this many seconds.
   * Omitted: `eatRestoreHealth` adds permanent HP (cooked food) as before.
   */
  readonly eatTemporaryDurationSec?: number;

  /** Optional second line under the display name in inventory slot tooltips. */
  readonly inventoryTooltip?: string;

  /**
   * When true, inventory/crafting/cursor icons clip the block texture to a stair silhouette
   * (shape 0: missing top-left corner), matching in-world stair geometry.
   */
  readonly stairItemIconClip?: boolean;

  /**
   * Sandbox creative sidebar tab (`stratum:creative_category` on item or block JSON).
   * Omitted: item only appears when the "All" tab is selected.
   */
  readonly creativeCategory?: CreativeCategory;
}

/** A counted quantity of one item type. */
export type ItemStack = {
  itemId: ItemId;
  count: number;
  /** Uses consumed for damageable items; omit or 0 when full / non-damageable. */
  damage?: number;
};

export const MAX_STACK_DEFAULT = 64;

/** Normalize damage for a stack of `def`; non-damageable items always return 0. */
export function clampDamageForDefinition(
  def: ItemDefinition | undefined,
  damage: number | undefined,
): number {
  const max = def?.maxDurability;
  if (max === undefined) {
    return 0;
  }
  const d = damage ?? 0;
  if (!Number.isFinite(d)) {
    return 0;
  }
  return Math.max(0, Math.min(max - 1, Math.floor(d)));
}

/** True if stack is broken (should be removed). */
export function isStackBroken(def: ItemDefinition | undefined, damage: number | undefined): boolean {
  const max = def?.maxDurability;
  if (max === undefined) {
    return false;
  }
  const d = damage ?? 0;
  return d >= max;
}
