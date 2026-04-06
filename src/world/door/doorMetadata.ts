/**
 * Door state in chunk metadata (high bits). Low bits preserve water flow / worldgen flags.
 */
export const DOOR_LATCH_OPEN = 0x40;
export const DOOR_HINGE_RIGHT = 0x80;
/** Bits 6–7 for door; bits 0–5 for {@link WORLDGEN_NO_COLLIDE} and water flow. */
export const DOOR_META_MASK = DOOR_LATCH_OPEN | DOOR_HINGE_RIGHT;

export function doorHingeRightFromMeta(cellMetadata: number): boolean {
  return (cellMetadata & DOOR_HINGE_RIGHT) !== 0;
}

export function doorLatchedOpenFromMeta(cellMetadata: number): boolean {
  return (cellMetadata & DOOR_LATCH_OPEN) !== 0;
}

/** Preserve low bits; set hinge and latch flags. */
export function packDoorMetadata(
  preserveLow: number,
  hingeRight: boolean,
  latchedOpen: boolean,
): number {
  const low = preserveLow & ~DOOR_META_MASK;
  let hi = 0;
  if (hingeRight) hi |= DOOR_HINGE_RIGHT;
  if (latchedOpen) hi |= DOOR_LATCH_OPEN;
  return low | hi;
}

export function toggleDoorLatchInMeta(cellMetadata: number): number {
  return cellMetadata ^ DOOR_LATCH_OPEN;
}
