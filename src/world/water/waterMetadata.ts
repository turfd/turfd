import {
  BLOCK_SIZE,
  WATER_DEPTH_TINT_REFERENCE_WY,
  WATER_FLOW_MASK,
  WATER_FLOW_SHIFT,
  WATER_MAX_FLOW,
  WORLDGEN_NO_COLLIDE,
} from "../../core/constants";

export { WATER_DEPTH_TINT_REFERENCE_WY };

/**
 * Flow level 0..{@link WATER_MAX_FLOW} stored in metadata (non-water cells should use 0).
 * Level 0 = source / still water (Minecraft-style); 1..MAX = flowing from a source.
 */
export function getWaterFlowLevel(cellMetadata: number): number {
  return (cellMetadata & WATER_FLOW_MASK) >> WATER_FLOW_SHIFT;
}

/** True if this water metadata is a source block (full block, can fill a bucket). */
export function isWaterSourceMetadata(cellMetadata: number): boolean {
  return getWaterFlowLevel(cellMetadata) === 0;
}

/** Preserve {@link WORLDGEN_NO_COLLIDE}; set flow level (clamped). */
export function withWaterFlowLevel(cellMetadata: number, flowLevel: number): number {
  const clamped = Math.max(0, Math.min(WATER_MAX_FLOW, Math.floor(flowLevel)));
  return (cellMetadata & WORLDGEN_NO_COLLIDE) | (clamped << WATER_FLOW_SHIFT);
}

/** Pixels cropped from the top of the water sprite for this flow level (full block at 0). */
export function waterFlowTopCropPx(flowLevel: number): number {
  const lv = Math.max(0, Math.min(WATER_MAX_FLOW, flowLevel));
  // Keep near-source/downhill flow visually continuous (avoids striped bands on slopes).
  if (lv <= 1) {
    return 0;
  }
  return Math.round((BLOCK_SIZE * lv) / WATER_MAX_FLOW);
}

/**
 * Atlas V within the visible water column [vMin,vMax] (after flow crop). Deeper world Y → higher V (darker texels).
 */
export function waterDepthVInCell(
  worldPixelY: number,
  vMin: number,
  vMax: number,
): number {
  const depthBlocks = (WATER_DEPTH_TINT_REFERENCE_WY * BLOCK_SIZE - worldPixelY) / BLOCK_SIZE;
  const g = Math.max(0, Math.min(1, depthBlocks / 72));
  const k = 0.22 + 0.78 * g;
  return vMin + (vMax - vMin) * k;
}
