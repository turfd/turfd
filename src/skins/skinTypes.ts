/** Shared types for the player skin system. */

import type { Texture } from "pixi.js";

/** A built-in skin shipped with the game assets. */
export interface BuiltinSkinDef {
  readonly id: string;
  readonly label: string;
  /** Path relative to the Stratum Core textures root (e.g. `"GUI/player/explorer_bob.png"`). */
  readonly file: string;
}

/** Reference to a skin by kind + id. */
export type SkinRef =
  | { readonly kind: "builtin"; readonly skinId: string }
  | { readonly kind: "custom"; readonly skinId: string };

/** Entry shown in the skin picker (built-in or custom). */
export interface SkinEntry {
  readonly ref: SkinRef;
  readonly label: string;
  /** A blob URL or asset URL suitable for an `<img>` or Pixi `Assets.load`. */
  readonly previewUrl: string;
}

/** Persisted row for a user-uploaded custom skin in IndexedDB. */
export interface CustomSkinRecord {
  readonly id: string;
  readonly label: string;
  readonly blob: Blob;
  readonly createdAt: number;
}

/** Sliced texture set produced from a player body sprite sheet. */
export interface SkinTextureSet {
  readonly frames: Texture[];
  readonly idle: Texture[];
  readonly walk: Texture[];
  readonly jumpUp: Texture[];
  readonly jumpDown: Texture[];
  readonly skid: Texture[];
  readonly breaking: Texture[];
  readonly scale: number;
}
