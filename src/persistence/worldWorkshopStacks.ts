/**
 * Resolve ordered behavior / world-resource workshop stacks from world metadata.
 * Migrates legacy `workshopMods` when the split fields are absent.
 */
import type { IModRepository } from "../mods/IModRepository";
import type { WorkshopModRef, WorldMetadata } from "./IndexedDBStore";

export type ResolvedWorldWorkshopStacks = {
  behaviorRefs: WorkshopModRef[];
  resourceRefs: WorkshopModRef[];
  requirePacksBeforeJoin: boolean;
};

function isResourcePackType(modType: string | undefined): boolean {
  return modType === "resource_pack";
}

/**
 * Returns behavior and world-resource pack refs in load order.
 * Uses `workshopBehaviorMods` / `workshopResourceMods` when either is present;
 * otherwise splits `workshopMods` using cached manifest types (defaults to behavior).
 */
export function resolveWorldWorkshopStacks(
  meta: WorldMetadata | undefined,
  repo: IModRepository | null,
): ResolvedWorldWorkshopStacks {
  if (meta === undefined) {
    return {
      behaviorRefs: [],
      resourceRefs: [],
      requirePacksBeforeJoin: false,
    };
  }
  const migrated =
    meta.workshopBehaviorMods !== undefined ||
    meta.workshopResourceMods !== undefined;
  if (migrated) {
    return {
      behaviorRefs: [...(meta.workshopBehaviorMods ?? [])],
      resourceRefs: [...(meta.workshopResourceMods ?? [])],
      requirePacksBeforeJoin: meta.requirePacksBeforeJoin === true,
    };
  }
  const legacy = meta.workshopMods ?? [];
  const behaviorRefs: WorkshopModRef[] = [];
  const resourceRefs: WorkshopModRef[] = [];
  for (const ref of legacy) {
    const cached = repo?.getCached(ref.modId, ref.version);
    const t = cached?.manifest.mod_type;
    if (isResourcePackType(t)) {
      resourceRefs.push(ref);
    } else {
      behaviorRefs.push(ref);
    }
  }
  return {
    behaviorRefs,
    resourceRefs,
    requirePacksBeforeJoin: meta.requirePacksBeforeJoin === true,
  };
}
