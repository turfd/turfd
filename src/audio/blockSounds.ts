/**
 * Maps block material categories to SFX buffer names (loaded via sound_manifest.json).
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

export function getJumpSound(material: BlockMaterial): string {
  return `jump_${material}`;
}

/** Mining crack-stage hits; buffer may be absent if manifest omits `dig` for this material. */
export function getDigSound(material: BlockMaterial): string {
  return `dig_${material}`;
}

/** Door/chest open or furnace UI open; requires manifest `open` on that set. */
export function getOpenSound(material: BlockMaterial): string {
  return `open_${material}`;
}

/** Door/chest close; requires manifest `close` on that set. */
export function getCloseSound(material: BlockMaterial): string {
  return `close_${material}`;
}
