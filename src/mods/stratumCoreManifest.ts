/**
 * Authoritative list of block JSON files shipped with stratum-core.
 *
 * Both the main game (`Game.ts`) and the menu background use this list
 * so that new blocks automatically appear everywhere.
 *
 * **Order matters:** `air.json` must be first (block-id 0).
 */
export const STRATUM_CORE_BLOCK_FILES: readonly string[] = [
  "air.json",
  "dirt.json",
  "grass.json",
  "short_grass.json",
  "tall_grass_bottom.json",
  "tall_grass_top.json",
  "dandelion.json",
  "poppy.json",
  "stone.json",
  "sand.json",
  "gravel.json",
  "bedrock.json",
  "oak-log.json",
  "oak_leaves.json",
  "spruce-log.json",
  "glass.json",
  "torch.json",
  "water.json",
  "coal_ore.json",
  "iron_ore.json",
  "gold_ore.json",
  "diamond_ore.json",
  "redstone_ore.json",
  "lapis_ore.json",
  "oak-planks.json",
  "spruce-planks.json",
  "crafting-table.json",
  "oak-sapling.json",
  "spruce-sapling.json",
];

export const STRATUM_CORE_ITEM_FILES: readonly string[] = [
  "stick.json",
  "tall_grass.json",
  "wooden_axe.json",
  "wooden_pickaxe.json",
  "wooden_shovel.json",
];
