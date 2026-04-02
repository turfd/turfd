/** Shared item type definitions for the inventory system. */

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

  /** Tool category (axe, pickaxe, shovel). Undefined for non-tool items. */
  readonly toolType?: "axe" | "pickaxe" | "shovel";
  /** Tool tier: 0=wood, 1=stone, 2=iron, 3=diamond. */
  readonly toolTier?: number;
  /** Mining speed multiplier when this tool matches the block's harvest tool type. */
  readonly toolSpeed?: number;
  /** Crafting tags this item belongs to (e.g. `"stratum:logs"`). */
  readonly tags?: readonly string[];
}

/** A counted quantity of one item type. */
export type ItemStack = {
  itemId: ItemId;
  count: number;
};

export const MAX_STACK_DEFAULT = 64;
