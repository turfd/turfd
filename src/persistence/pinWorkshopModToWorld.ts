/** Merge a workshop listing into saved world metadata so loads call {@link IModRepository.ensureInstalled}. */

import type { IModRepository } from "../mods/IModRepository";
import type { ModListEntry } from "../mods/workshopTypes";
import type { IndexedDBStore } from "./IndexedDBStore";
import { resolveWorldWorkshopStacks } from "./worldWorkshopStacks";

export async function pinWorkshopModToWorld(
  store: IndexedDBStore,
  worldUuid: string,
  entry: ModListEntry,
  repo: IModRepository | null,
): Promise<void> {
  await store.patchWorldMetadata(worldUuid, (prev) => {
    if (prev === undefined) {
      throw new Error(`Cannot pin mod: world not found (${worldUuid})`);
    }
    const resolved = resolveWorldWorkshopStacks(prev, repo);
    const ref = {
      recordId: entry.id,
      modId: entry.modId,
      version: entry.version,
    };
    const isResource = entry.modType === "resource_pack";
    let behaviorRefs = [...resolved.behaviorRefs];
    let resourceRefs = [...resolved.resourceRefs];
    const target = isResource ? resourceRefs : behaviorRefs;
    const idx = target.findIndex((x) => x.modId === ref.modId);
    if (idx >= 0) {
      target[idx] = ref;
    } else {
      target.push(ref);
    }
    if (isResource) {
      resourceRefs = target;
    } else {
      behaviorRefs = target;
    }
    return {
      ...prev,
      workshopBehaviorMods: behaviorRefs,
      workshopResourceMods: resourceRefs,
      workshopMods: undefined,
    };
  });
}
