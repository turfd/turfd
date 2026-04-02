/**
 * Minecraft-style tool mining system.
 *
 * Break-time formulas (hardness h, tool speed s):
 *   - Correct tool + sufficient tier: h × 1.5 / s
 *   - Correct tool + insufficient tier: h × 5 / s
 *   - No matching tool, block requires tool: h × 5
 *   - No matching tool, block has no requirement: h × 1.5
 *
 * Instant-break blocks (hardness ≤ 0) always take one tick (0.05 s).
 */

export type ToolType = "axe" | "pickaxe" | "shovel";

const INSTANT_BREAK_SEC = 0.05;

interface BlockMiningInfo {
  hardness: number;
  harvestToolType?: ToolType;
  requiresToolForDrops: boolean;
  minToolTier: number;
}

interface HeldToolInfo {
  toolType?: ToolType;
  toolTier?: number;
  toolSpeed?: number;
}

export function getBreakTimeSeconds(
  block: BlockMiningInfo,
  heldItem?: HeldToolInfo,
): number {
  if (block.hardness <= 0) return INSTANT_BREAK_SEC;

  const toolMatches =
    heldItem?.toolType != null &&
    block.harvestToolType != null &&
    heldItem.toolType === block.harvestToolType;

  if (toolMatches) {
    const speed = heldItem!.toolSpeed ?? 1;
    const sufficientTier = (heldItem!.toolTier ?? 0) >= block.minToolTier;
    return sufficientTier
      ? (block.hardness * 1.5) / speed
      : (block.hardness * 5) / speed;
  }

  return block.requiresToolForDrops
    ? block.hardness * 5
    : block.hardness * 1.5;
}

export function canHarvestDrops(
  block: BlockMiningInfo,
  heldItem?: HeldToolInfo,
): boolean {
  if (!block.requiresToolForDrops) return true;
  if (heldItem?.toolType == null || block.harvestToolType == null) return false;
  if (heldItem.toolType !== block.harvestToolType) return false;
  return (heldItem.toolTier ?? 0) >= block.minToolTier;
}
