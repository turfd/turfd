import { CAMERA_PLAYER_VERTICAL_OFFSET_PX } from "../../core/constants";
import type { Camera } from "../../renderer/Camera";

/**
 * Axis-aligned bounds in **Pixi worldRoot** space (same as entity roots: `x` = feet X,
 * `y` = −feetY style vertical). Used to reject natural mob spawns the player could see.
 */
export type MobSpawnViewRect = {
  minX: number;
  maxX: number;
  minPixY: number;
  maxPixY: number;
};

/** Matches {@link Camera.applyTransform} + {@link Camera.screenToWorld} for corners (0,0) and (sw,sh). */
function buildRectForCamPos(
  camPosX: number,
  camPosY: number,
  screenW: number,
  screenH: number,
  zoom: number,
  marginScreenPx: number,
): MobSpawnViewRect {
  const z = zoom;
  const wrx = Math.round(screenW * 0.5 - camPosX * z);
  const wry = Math.round(screenH * 0.5 - camPosY * z);
  const tlX = (-marginScreenPx - wrx) / z;
  const tlY = (-marginScreenPx - wry) / z;
  const brX = (screenW + marginScreenPx - wrx) / z;
  const brY = (screenH + marginScreenPx - wry) / z;
  return {
    minX: Math.min(tlX, brX),
    maxX: Math.max(tlX, brX),
    minPixY: Math.min(tlY, brY),
    maxPixY: Math.max(tlY, brY),
  };
}

/** Local player: use the real follow camera (lerped position). */
export function buildMobSpawnViewRectFromCamera(
  camera: Camera,
  screenW: number,
  screenH: number,
  marginScreenPx: number,
): MobSpawnViewRect {
  const z = camera.getZoom();
  const p = camera.getPosition();
  return buildRectForCamPos(p.x, p.y, screenW, screenH, z, marginScreenPx);
}

/**
 * Remote player on host: no client camera — approximate their view as centered on their feet with
 * the same zoom and screen size as the host window (good enough to avoid obvious pop-ins).
 */
export function buildMobSpawnViewRectCenteredOnFeet(
  feetX: number,
  feetY: number,
  screenW: number,
  screenH: number,
  zoom: number,
  marginScreenPx: number,
): MobSpawnViewRect {
  const camY = -feetY - CAMERA_PLAYER_VERTICAL_OFFSET_PX;
  return buildRectForCamPos(feetX, camY, screenW, screenH, zoom, marginScreenPx);
}

/**
 * True if the vertical segment from feet through the top of the mob (world Y up) intersects any
 * view rect in Pixi space (handles the case where the middle of the mob is on-screen but both
 * endpoints are off-screen).
 */
export function naturalSpawnColumnOverlapsAnyViewRect(
  feetX: number,
  feetBottomY: number,
  bodyHeightPx: number,
  rects: ReadonlyArray<MobSpawnViewRect> | undefined,
): boolean {
  if (rects === undefined || rects.length === 0) {
    return false;
  }
  const yFeetPix = -feetBottomY;
  const yTopPix = -(feetBottomY + Math.max(0, bodyHeightPx));
  const segMinPixY = Math.min(yFeetPix, yTopPix);
  const segMaxPixY = Math.max(yFeetPix, yTopPix);
  for (const r of rects) {
    if (feetX < r.minX || feetX > r.maxX) {
      continue;
    }
    if (segMaxPixY < r.minPixY || segMinPixY > r.maxPixY) {
      continue;
    }
    return true;
  }
  return false;
}
