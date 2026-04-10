/**
 * Bed orientation in chunk metadata: head half lies east (+X) or west (−X) of the foot half.
 * Uses bit 7 only on bed cells (same bit position as {@link DOOR_HINGE_RIGHT}, disjoint block types).
 */
export const BED_HEAD_PLUS_X = 0x80;

export function bedHeadPlusXFromMeta(cellMetadata: number): boolean {
  return (cellMetadata & BED_HEAD_PLUS_X) !== 0;
}

/** Preserve low bits (worldgen / water); set head-east flag. */
export function packBedMetadata(preserveLow: number, headPlusX: boolean): number {
  const low = preserveLow & ~BED_HEAD_PLUS_X;
  return low | (headPlusX ? BED_HEAD_PLUS_X : 0);
}
