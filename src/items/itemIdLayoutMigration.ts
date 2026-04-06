import type { ChestPersistedChunk } from "../world/chest/chestPersisted";
import { isKeySlot as isChestKeySlot } from "../world/chest/chestPersisted";
import type {
  FurnacePersistedChunk,
  FurnacePersistedSlot,
} from "../world/furnace/furnacePersisted";
import { isKeySlot as isFurnaceKeySlot } from "../world/furnace/furnacePersisted";

/**
 * Pre–layout-migration standalone item id band (when first non–block-item id was 50).
 * Stairs (50–55) and door halves (56–57) are blocks; door halves do not register block-items, so the
 * first standalone id is 56 (not 58).
 */
export const LEGACY_STANDALONE_ITEM_ID_MIN = 50;
export const LEGACY_STANDALONE_ITEM_ID_MAX = 81;

/** Revision 0 → current: map legacy 50–81 to 56–87 (+6). */
export const ITEM_ID_LAYOUT_LEGACY_TO_CURRENT_BUMP = 6;

/** Historical revision 1 used +8 from legacy (first standalone was wrongly assumed to be 58). */
export const ITEM_ID_LAYOUT_STAIRS_BUMP = 8;

/** After revision 1 migration, standalone ids lived in 58–90; revision 2 shifts them −2 to 56–88. */
export const REVISION1_STANDALONE_MIN = 58;
export const REVISION1_STANDALONE_MAX = 90;

/** First layout bump (stairs); saves at this revision used +8 from legacy. */
export const ITEM_ID_LAYOUT_REVISION_STAIRS = 1;

/** Current: standalone ids 56–88; migration handles rev 0 (+6) and rev 1 (−2). */
export const ITEM_ID_LAYOUT_REVISION_CURRENT = 2;

export function bumpLegacyStandaloneItemId(id: number): number {
  if (
    id >= LEGACY_STANDALONE_ITEM_ID_MIN &&
    id <= LEGACY_STANDALONE_ITEM_ID_MAX
  ) {
    return id + ITEM_ID_LAYOUT_LEGACY_TO_CURRENT_BUMP;
  }
  return id;
}

export function migrateRevision1StandaloneItemId(id: number): number {
  if (id >= REVISION1_STANDALONE_MIN && id <= REVISION1_STANDALONE_MAX) {
    return id - 2;
  }
  return id;
}

export function migrateChestPersistedChunk(
  p: ChestPersistedChunk,
): ChestPersistedChunk {
  return {
    ...p,
    slots: p.slots.map((s) => {
      if (s === null || s.count <= 0) {
        return s;
      }
      if (isChestKeySlot(s)) {
        return s;
      }
      const id = bumpLegacyStandaloneItemId(s.id);
      return id === s.id ? s : { id, count: s.count };
    }),
  };
}

export function migrateChestPersistedChunkFromRevision1(
  p: ChestPersistedChunk,
): ChestPersistedChunk {
  return {
    ...p,
    slots: p.slots.map((s) => {
      if (s === null || s.count <= 0) {
        return s;
      }
      if (isChestKeySlot(s)) {
        return s;
      }
      const id = migrateRevision1StandaloneItemId(s.id);
      return id === s.id ? s : { id, count: s.count };
    }),
  };
}

function bumpFurnaceSlotLegacy(s: FurnacePersistedSlot): FurnacePersistedSlot {
  if (s === null || s.count <= 0) {
    return s;
  }
  if (isFurnaceKeySlot(s)) {
    return s;
  }
  const id = bumpLegacyStandaloneItemId(s.id);
  if (id === s.id) {
    return s;
  }
  const out: FurnacePersistedSlot = { id, count: s.count };
  if (typeof s.damage === "number" && s.damage > 0) {
    out.damage = s.damage;
  }
  return out;
}

function bumpFurnaceSlotRevision1(s: FurnacePersistedSlot): FurnacePersistedSlot {
  if (s === null || s.count <= 0) {
    return s;
  }
  if (isFurnaceKeySlot(s)) {
    return s;
  }
  const id = migrateRevision1StandaloneItemId(s.id);
  if (id === s.id) {
    return s;
  }
  const out: FurnacePersistedSlot = { id, count: s.count };
  if (typeof s.damage === "number" && s.damage > 0) {
    out.damage = s.damage;
  }
  return out;
}

export function migrateFurnacePersistedChunk(
  e: FurnacePersistedChunk,
): FurnacePersistedChunk {
  return {
    ...e,
    fuel: bumpFurnaceSlotLegacy(e.fuel),
    outputSlots: e.outputSlots.map(bumpFurnaceSlotLegacy),
  };
}

export function migrateFurnacePersistedChunkFromRevision1(
  e: FurnacePersistedChunk,
): FurnacePersistedChunk {
  return {
    ...e,
    fuel: bumpFurnaceSlotRevision1(e.fuel),
    outputSlots: e.outputSlots.map(bumpFurnaceSlotRevision1),
  };
}
