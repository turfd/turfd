/** Contract for block-break loot resolution (implemented by {@link LootResolver} in `items/`). */

import type { ItemStack } from "./itemDefinition";

/** RNG surface used by loot resolution (matches {@link GeneratorContext}). */
export interface LootRng {
  nextFloat(): number;
}

export interface ILootResolver {
  resolve(blockId: number, rng: LootRng): ItemStack[];
}
