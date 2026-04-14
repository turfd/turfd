/** Discovers available skins, validates uploads, and resolves skin URLs. */

import {
  BUILTIN_SKINS,
  CUSTOM_SKIN_MAX_BYTES,
  DEFAULT_SKIN_ID,
  PLAYER_BODY_REQUIRED_FRAME_COUNT,
} from "../core/constants";
import { stratumCoreTextureAssetUrl } from "../core/textureManifest";
import type {
  CustomSkinRecord,
  SkinEntry,
  SkinRef,
} from "./skinTypes";

/**
 * Resolve a {@link SkinRef} to a URL loadable by Pixi `Assets.load` or `<img>`.
 *
 * - Built-in skins resolve to the shipped asset URL.
 * - Custom skins must be resolved externally (caller provides the blob).
 */
export function resolveBuiltinSkinUrl(skinId: string): string | null {
  const def = BUILTIN_SKINS.find((s) => s.id === skinId);
  if (def === undefined) {
    return null;
  }
  return stratumCoreTextureAssetUrl(def.file);
}

/** Returns the asset URL for a {@link SkinRef}, or `null` if the ref requires a blob (custom). */
export function resolveSkinUrl(ref: SkinRef): string | null {
  if (ref.kind === "builtin") {
    return resolveBuiltinSkinUrl(ref.skinId);
  }
  return null;
}

/** Create a temporary blob URL for a custom skin's raw PNG data. Caller must `URL.revokeObjectURL` when done. */
export function createBlobSkinUrl(blob: Blob): string {
  return URL.createObjectURL(blob);
}

export function builtinSkinEntries(): SkinEntry[] {
  return BUILTIN_SKINS.map((s) => ({
    ref: { kind: "builtin", skinId: s.id },
    label: s.label,
    previewUrl: stratumCoreTextureAssetUrl(s.file),
  }));
}

export function customSkinEntries(records: readonly CustomSkinRecord[]): SkinEntry[] {
  return records.map((r) => ({
    ref: { kind: "custom", skinId: r.id },
    label: r.label,
    previewUrl: URL.createObjectURL(r.blob),
  }));
}

/** Returns the default {@link SkinRef}. */
export function defaultSkinRef(): SkinRef {
  return { kind: "builtin", skinId: DEFAULT_SKIN_ID };
}

/** Build a {@link SkinRef} from a serialised skin id string (e.g. `"explorer_bob"` or `"custom:abc123"`). */
export function parseSkinId(raw: string): SkinRef {
  if (raw.startsWith("custom:")) {
    return { kind: "custom", skinId: raw.slice("custom:".length) };
  }
  return { kind: "builtin", skinId: raw };
}

/** Serialise a {@link SkinRef} to a compact string for persistence / network. */
export function stringifySkinRef(ref: SkinRef): string {
  if (ref.kind === "custom") {
    return `custom:${ref.skinId}`;
  }
  return ref.skinId;
}

/** True when the ref points to a skin that is built-in to all clients (no data transfer needed). */
export function isBuiltinSkin(ref: SkinRef): boolean {
  if (ref.kind !== "builtin") {
    return false;
  }
  return BUILTIN_SKINS.some((s) => s.id === ref.skinId);
}

export interface SkinValidationResult {
  ok: boolean;
  error?: string;
}

/**
 * Validate that a PNG blob is acceptable as a custom skin.
 * Checks file size and image dimensions (width must be evenly divisible by the required frame count).
 */
export async function validateSkinBlob(blob: Blob): Promise<SkinValidationResult> {
  if (blob.size > CUSTOM_SKIN_MAX_BYTES) {
    return {
      ok: false,
      error: `File is too large (${Math.ceil(blob.size / 1024)} KB). Maximum is ${CUSTOM_SKIN_MAX_BYTES / 1024} KB.`,
    };
  }
  if (blob.type !== "image/png" && blob.type !== "") {
    return { ok: false, error: "Only PNG images are supported." };
  }

  try {
    const bmp = await createImageBitmap(blob);
    const w = bmp.width;
    const h = bmp.height;
    bmp.close();
    if (w <= 0 || h <= 0) {
      return { ok: false, error: "Image has invalid dimensions." };
    }
    if (w % PLAYER_BODY_REQUIRED_FRAME_COUNT !== 0) {
      return {
        ok: false,
        error: `Image width (${w}) must be divisible by ${PLAYER_BODY_REQUIRED_FRAME_COUNT} (one column per frame).`,
      };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: "Could not decode image. Please use a valid PNG file." };
  }
}
