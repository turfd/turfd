/** Shared item type definitions for the inventory system. */

declare const __itemIdBrand: unique symbol;

/** Branded numeric item identifier used on the wire and in save data. */
export type ItemId = number & { [__itemIdBrand]: never };

export interface ItemDefinition {
  /** Numeric ID used on the wire and in save data. */
  readonly id: ItemId;

  /** Namespaced string key e.g. "turfd:stone". */
  readonly key: string;

  /**
   * Atlas texture name used to render this item everywhere
   * (inventory, hotbar, dropped entity).
   * For block-items this is the block's own atlas tile name.
   */
  readonly textureName: string;

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
}

/** A counted quantity of one item type. */
export type ItemStack = {
  itemId: ItemId;
  count: number;
};

export const MAX_STACK_DEFAULT = 64;
