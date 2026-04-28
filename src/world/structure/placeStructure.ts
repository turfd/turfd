import type { ItemRegistry } from "../../items/ItemRegistry";
import type { World } from "../World";
import type { FurnaceTileState } from "../furnace/FurnaceTileState";
import type { ChestTileState } from "../chest/ChestTileState";
import {
  normalizeSpawnerTileStateForGeneratedPlacement,
} from "../spawner/SpawnerTileState";
import type { ParsedStructure } from "./structureSchema";

export type PlaceStructureResult = {
  placedForeground: number;
  placedBackground: number;
  placedContainers: number;
  placedFurnaces: number;
  placedSpawners: number;
};

function toItemStack(
  itemRegistry: ItemRegistry,
  slot: { key: string; count: number; damage?: number } | null,
): import("../../core/itemDefinition").ItemStack | null {
  if (slot === null || slot.count <= 0) {
    return null;
  }
  const item = itemRegistry.getByKey(slot.key);
  if (item === undefined) {
    return null;
  }
  return {
    itemId: item.id,
    count: slot.count,
    ...(slot.damage !== undefined && slot.damage > 0 ? { damage: slot.damage } : {}),
  };
}

export function placeStructureAt(
  world: World,
  itemRegistry: ItemRegistry,
  structure: ParsedStructure,
  originWx: number,
  originWy: number,
): PlaceStructureResult {
  const registry = world.getRegistry();
  let placedForeground = 0;
  let placedBackground = 0;
  let placedContainers = 0;
  let placedFurnaces = 0;
  let placedSpawners = 0;
  for (const cell of structure.blocks) {
    const wx = originWx + cell.x;
    const wy = originWy + cell.y;
    const fgId =
      cell.foreground.identifier === "stratum:air"
        ? 0
        : registry.isRegistered(cell.foreground.identifier)
          ? registry.getByIdentifier(cell.foreground.identifier).id
          : 0;
    const bgId =
      cell.background.identifier === "stratum:air"
        ? 0
        : registry.isRegistered(cell.background.identifier)
          ? registry.getByIdentifier(cell.background.identifier).id
          : 0;
    if (world.setBlock(wx, wy, fgId, { cellMetadata: cell.foreground.metadata })) {
      placedForeground++;
    }
    if (world.setBackgroundBlock(wx, wy, bgId)) {
      placedBackground++;
    }
  }

  for (const e of structure.entities) {
    const wx = originWx + e.x;
    const wy = originWy + e.y;
    if (e.type === "furnace") {
      world.setFurnaceTile(wx, wy, e.state as FurnaceTileState);
      placedFurnaces++;
      continue;
    }
    if (e.type === "spawner") {
      world.setSpawnerTile(wx, wy, normalizeSpawnerTileStateForGeneratedPlacement(e.state));
      placedSpawners++;
      continue;
    }
    const storageAnchor = world.getChestStorageAnchorForCell(wx, wy) ?? { ax: wx, ay: wy };
    const rawItems = e.items ?? [];
    const items = rawItems.map((s) => toItemStack(itemRegistry, s));
    if (items.length === 0) {
      items.push(...Array.from({ length: 18 }, () => null));
    }
    const chestState: ChestTileState = {
      slots: items,
      ...(e.lootTable !== undefined ? { lootTableId: e.lootTable, lootRolled: false } : {}),
    };
    world.setChestTileAtAnchor(storageAnchor.ax, storageAnchor.ay, chestState);
    placedContainers++;
  }

  return {
    placedForeground,
    placedBackground,
    placedContainers,
    placedFurnaces,
    placedSpawners,
  };
}
