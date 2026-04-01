/**
 * Maps block material categories to SFX asset names (loaded in Phase 3).
 */
import type { BlockMaterial } from "../core/blockDefinition";

export function getBreakSound(material: BlockMaterial): string {
  return `break_${material}`;
}

export function getPlaceSound(material: BlockMaterial): string {
  return `place_${material}`;
}

export function getStepSound(material: BlockMaterial): string {
  return `step_${material}`;
}
