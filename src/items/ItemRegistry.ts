/** Runtime registry mapping numeric ItemId and string key to ItemDefinition. */

import type { BlockDefinitionBase } from '../core/blockDefinition';
import type { ItemDefinition, ItemId } from '../core/itemDefinition';
import { MAX_STACK_DEFAULT } from '../core/itemDefinition';

export class ItemRegistry {
  private readonly _byId = new Map<ItemId, ItemDefinition>();
  private readonly _byKey = new Map<string, ItemDefinition>();
  private readonly _byTag = new Map<string, ItemDefinition[]>();
  private _nextId: ItemId = 1 as ItemId;

  /**
   * Register an item. Throws if key or id is already registered.
   * If def.id is 0 (unset) or omitted, auto-assigns the next available id.
   */
  register(def: Omit<ItemDefinition, 'id'> & { id?: ItemId }): ItemDefinition {
    const id: ItemId = def.id ?? this._nextId;

    if (this._byId.has(id)) {
      throw new Error(`ItemRegistry: id ${id} already registered`);
    }
    if (this._byKey.has(def.key)) {
      throw new Error(`ItemRegistry: key '${def.key}' already registered`);
    }

    const full: ItemDefinition = {
      id,
      key: def.key,
      textureName: def.textureName,
      displayName: def.displayName,
      maxStack: def.maxStack,
      placesBlockId: def.placesBlockId,
      iconSheet: def.iconSheet,
      toolType: def.toolType,
      toolTier: def.toolTier,
      toolSpeed: def.toolSpeed,
      tags: def.tags,
      maxDurability: def.maxDurability,
      fuelBurnSeconds: def.fuelBurnSeconds,
      eatRestoreHealth: def.eatRestoreHealth,
      inventoryTooltip: def.inventoryTooltip,
      stairItemIconClip: def.stairItemIconClip,
    };

    this._byId.set(id, full);
    this._byKey.set(full.key, full);

    if (full.tags) {
      for (const tag of full.tags) {
        let list = this._byTag.get(tag);
        if (!list) {
          list = [];
          this._byTag.set(tag, list);
        }
        list.push(full);
      }
    }

    if (id >= this._nextId) {
      this._nextId = (id + 1) as ItemId;
    }

    return full;
  }

  getById(id: ItemId): ItemDefinition | undefined {
    return this._byId.get(id);
  }

  getByKey(key: string): ItemDefinition | undefined {
    return this._byKey.get(key);
  }

  /** All items with a given tag (empty array if none). */
  getByTag(tag: string): readonly ItemDefinition[] {
    return this._byTag.get(tag) ?? [];
  }

  /** Iterate all registered items. */
  all(): IterableIterator<ItemDefinition> {
    return this._byId.values();
  }

  /** Largest numeric item id in use (0 if none). */
  maxRegisteredNumericId(): number {
    let m = 0;
    for (const d of this._byId.values()) {
      m = Math.max(m, d.id as number);
    }
    return m;
  }
}

/**
 * For every block definition that has a textureName and is not air,
 * register a corresponding block-item in the ItemRegistry.
 * The item key matches the block identifier. placesBlockId is set.
 *
 * Call this after all blocks are registered, before world init.
 */
export function registerBlockItems(
  blocks: Iterable<BlockDefinitionBase & { readonly id: number }>,
  items: ItemRegistry,
): void {
  for (const block of blocks) {
    if (block.id === 0) continue;
    if (block.doorHalf === "bottom" || block.doorHalf === "top") continue;
    if (items.getByKey(block.identifier) !== undefined) continue;

    const textureName = block.textureName ?? block.identifier.split(':')[1] ?? block.identifier;

    items.register({
      key: block.identifier,
      id: block.id as ItemId,
      textureName,
      displayName: block.displayName ?? block.identifier,
      maxStack: MAX_STACK_DEFAULT,
      placesBlockId: block.id,
      // Stairs can burn as fuel (fuelBurnSeconds) but should not count as crafting materials.
      tags: block.isStair === true ? undefined : block.tags,
      fuelBurnSeconds: block.fuelBurnSeconds,
      ...(block.isStair === true ? { stairItemIconClip: true as const } : {}),
    });
  }
}
