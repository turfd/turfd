/** Zod schemas and types for workshop manifests, directory rows, and IndexedDB cache. */

import { z } from "zod";

declare const modRecordIdBrand: unique symbol;
export type ModRecordId = string & { readonly [modRecordIdBrand]: typeof modRecordIdBrand };

export function asModRecordId(id: string): ModRecordId {
  return id as ModRecordId;
}

/** Stored in Supabase `stratum_mods.mod_type` and workshop directory rows. */
export type WorkshopModTypeRow = "behavior_pack" | "resource_pack" | "world";

/**
 * Values that may appear inside a downloaded ZIP `manifest.json`
 * (new packs use {@link WorkshopModTypeRow} only; legacy + `mixed` still load).
 */
export type WorkshopModTypeManifest =
  | WorkshopModTypeRow
  | "block_pack"
  | "texture_pack"
  | "mixed";

export type ModTypeFilter = "all" | WorkshopModTypeRow;

export type ModSortBy = "newest" | "downloads" | "rating";

export function workshopPackLoadsBlocks(t: WorkshopModTypeManifest): boolean {
  return t === "behavior_pack" || t === "block_pack" || t === "mixed";
}

export function workshopPackLoadsTextures(t: WorkshopModTypeManifest): boolean {
  return t === "resource_pack" || t === "texture_pack" || t === "mixed";
}

const workshopModTypeManifestSchema = z.enum([
  "behavior_pack",
  "resource_pack",
  "block_pack",
  "texture_pack",
  "mixed",
]);

/** Namespaced id: one or more segments `a.b` or `a.b.c` (lowercase, digits, underscores). */
const workshopManifestIdSchema = z
  .string()
  .regex(/^[a-z0-9_]+(?:\.[a-z0-9_]+)+$/, "Use a namespaced id like stratum.my_pack or author.mod_name");

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function versionArrayToSemVer(v: unknown): string {
  if (!Array.isArray(v) || v.length < 3) {
    return "1.0.0";
  }
  const a = v.map((x) => String(Math.max(0, Math.floor(Number(x) || 0))));
  return `${a[0]}.${a[1]}.${a[2]}`;
}

function bedrockModulesToModType(modules: unknown): WorkshopModTypeManifest {
  if (!Array.isArray(modules)) {
    return "behavior_pack";
  }
  let hasResources = false;
  let hasData = false;
  for (const m of modules) {
    if (m === null || typeof m !== "object") {
      continue;
    }
    const t = String((m as { type?: string }).type ?? "").toLowerCase();
    if (t === "resources" || t === "resource") {
      hasResources = true;
    }
    if (t === "data" || t === "script") {
      hasData = true;
    }
  }
  if (hasResources && !hasData) {
    return "resource_pack";
  }
  return "behavior_pack";
}

/** Bedrock `header.version` is often `[1, 0, 0]` but may be a semver string. */
function bedrockHeaderVersionToSemVer(v: unknown): string {
  if (Array.isArray(v) && v.length >= 3) {
    return versionArrayToSemVer(v);
  }
  if (typeof v === "string") {
    const s = v.trim();
    if (/^\d+\.\d+\.\d+$/.test(s)) {
      return s;
    }
  }
  return "1.0.0";
}

function djb2Hex(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(33, h) ^ s.charCodeAt(i)!) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

function bedrockHeaderNameToString(raw: unknown): string {
  if (typeof raw === "string") {
    return raw;
  }
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    const o = raw as Record<string, unknown>;
    const en = o.en_US;
    if (typeof en === "string") {
      return en;
    }
    const first = Object.values(o).find((x) => typeof x === "string");
    if (typeof first === "string") {
      return first;
    }
  }
  return "pack";
}

/** Bedrock JSON sometimes uses a numeric `uuid` or omits it when `name` + `version` exist. */
function bedrockUuidToPackId(
  header: Record<string, unknown>,
  formatVersion: unknown,
  modules: unknown,
): string {
  const raw = header.uuid;
  let uuid = "";
  if (typeof raw === "string") {
    uuid = raw.trim();
  } else if (typeof raw === "number" && Number.isFinite(raw)) {
    uuid = String(Math.floor(raw));
  }
  const hex = uuid.replace(/-/g, "").toLowerCase();
  if (hex.length === 32) {
    return `pack.${hex}`;
  }
  const namePart = bedrockHeaderNameToString(header.name);
  const verPart =
    typeof header.version === "string"
      ? header.version
      : JSON.stringify(header.version ?? "");
  return `pack.bedrock.${djb2Hex(`${namePart}:${verPart}:${String(formatVersion ?? "")}:${JSON.stringify(modules ?? "")}`)}`;
}

function innerLooksLikeManifestPayload(x: Record<string, unknown>): boolean {
  return (
    (x.header !== null && typeof x.header === "object" && !Array.isArray(x.header)) ||
    typeof x.id === "string" ||
    x.pack !== null && typeof x.pack === "object" && !Array.isArray(x.pack) ||
    x.format_version !== undefined ||
    Array.isArray(x.modules) ||
    typeof x.pack_type === "string" ||
    typeof x.mod_type === "string"
  );
}

/** Hosting / export tools sometimes wrap the real manifest one level deep. */
function unwrapManifestRoot(o: Record<string, unknown>): Record<string, unknown> {
  let cur = o;
  for (let depth = 0; depth < 6; depth++) {
    const keyed = [
      "manifest",
      "data",
      "content",
      "stratum",
      "mod_manifest",
      "json",
      "root",
    ] as const;
    let next: Record<string, unknown> | null = null;
    for (const k of keyed) {
      const inner = cur[k];
      if (inner !== null && typeof inner === "object" && !Array.isArray(inner)) {
        const io = inner as Record<string, unknown>;
        if (innerLooksLikeManifestPayload(io)) {
          next = io;
          break;
        }
      }
    }
    if (next === null) {
      const keys = Object.keys(cur);
      if (keys.length === 1) {
        const inner = cur[keys[0]!];
        if (inner !== null && typeof inner === "object" && !Array.isArray(inner)) {
          const io = inner as Record<string, unknown>;
          if (innerLooksLikeManifestPayload(io)) {
            next = io;
          }
        }
      }
    }
    if (next === null) {
      break;
    }
    cur = next;
  }
  return cur;
}

function isProbablyBedrockManifest(o: Record<string, unknown>): boolean {
  const header = o.header;
  if (header === null || typeof header !== "object" || Array.isArray(header)) {
    return false;
  }
  const h = header as Record<string, unknown>;
  // Stratum workshop manifests use top-level namespaced `id` (e.g. stratum.core) — not Bedrock.
  if (typeof o.id === "string") {
    const id = o.id.trim().toLowerCase();
    if (/^[a-z0-9_]+(?:\.[a-z0-9_]+)+$/.test(id) && !id.startsWith("pack.")) {
      return false;
    }
  }

  const hasUuid =
    (typeof h.uuid === "string" && h.uuid.trim().length > 0) ||
    (typeof h.uuid === "number" && Number.isFinite(h.uuid));
  const hasNameAndVersion = h.name !== undefined && h.version !== undefined;
  if (!hasUuid && !hasNameAndVersion) {
    return false;
  }

  const fv = o.format_version;
  if (typeof fv === "number" && Number.isFinite(fv)) {
    return true;
  }
  if (typeof fv === "string") {
    const t = fv.trim();
    if (/^\d+$/.test(t)) {
      return true;
    }
    if (t === "1.0.0" || t === "1.1.0") {
      return true;
    }
  }
  if (Array.isArray(o.modules)) {
    return true;
  }
  if (hasUuid) {
    return fv === undefined || fv === null || fv === "";
  }
  return hasNameAndVersion;
}

/** Maps Bedrock `manifest.json` (format_version 1/2 + header) into Stratum workshop shape. */
function bedrockManifestToWorkshopShape(o: Record<string, unknown>): Record<string, unknown> {
  const header = o.header as Record<string, unknown>;
  const id = bedrockUuidToPackId(header, o.format_version, o.modules);
  const nameRaw = bedrockHeaderNameToString(header.name);
  const descRaw =
    typeof header.description === "string"
      ? header.description
      : typeof header.description === "object" &&
          header.description !== null &&
          !Array.isArray(header.description)
        ? bedrockHeaderNameToString(header.description)
        : "";
  return {
    format_version: "1.1.0",
    id,
    version: bedrockHeaderVersionToSemVer(header.version),
    name: nameRaw.trim().slice(0, 64) || "pack",
    description: descRaw.trim().slice(0, 500),
    mod_type: bedrockModulesToModType(o.modules),
    blocks: [],
    items: [],
    recipes: [],
    loot: [],
    textures: [],
    item_textures: {},
  };
}

/** Minecraft Java `pack.mcmeta` (sometimes renamed to manifest.json for zips). */
function javaPackFormatNumber(pack: Record<string, unknown>): number | undefined {
  const pf = pack.pack_format;
  if (typeof pf === "number" && Number.isFinite(pf)) {
    return pf;
  }
  if (typeof pf === "string" && /^\d+$/.test(pf.trim())) {
    return parseInt(pf.trim(), 10);
  }
  return undefined;
}

function isProbablyJavaPackMcmetaRoot(o: Record<string, unknown>): boolean {
  const p = o.pack;
  if (p === null || typeof p !== "object" || Array.isArray(p)) {
    return false;
  }
  return javaPackFormatNumber(p as Record<string, unknown>) !== undefined;
}

function javaPackMcmetaToWorkshopShape(o: Record<string, unknown>): Record<string, unknown> {
  const pack = o.pack as Record<string, unknown>;
  const rawDesc = pack.description;
  const desc =
    typeof rawDesc === "string"
      ? rawDesc.replace(/^§[0-9a-fk-or]/gim, "").trim()
      : "";
  const name = (desc.split("\n")[0] ?? "resource_pack").trim().slice(0, 64) || "resource_pack";
  const idSeed = `${name}:${String(javaPackFormatNumber(pack) ?? 0)}`;
  return {
    format_version: "1.1.0",
    id: `pack.import.${djb2Hex(idSeed)}`,
    version: "1.0.0",
    name,
    description: desc.slice(0, 500),
    mod_type: "resource_pack",
    blocks: [],
    items: [],
    recipes: [],
    loot: [],
    textures: [],
    item_textures: {},
  };
}

/** Stratum lists must be arrays; Bedrock / mistaken JSON often uses objects (e.g. texture maps). */
function coerceStratumManifestListFields(o: Record<string, unknown>): void {
  const keys = ["textures", "blocks", "items", "recipes", "loot"] as const;
  for (const k of keys) {
    const v = o[k];
    if (v !== undefined && !Array.isArray(v)) {
      o[k] = [];
    }
  }
  const it = o.item_textures;
  if (it !== undefined && (it === null || typeof it !== "object" || Array.isArray(it))) {
    o.item_textures = {};
  }
}

function preprocessWorkshopManifestRoot(raw: unknown): unknown {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return raw;
  }
  let o: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  o = unwrapManifestRoot(o);

  if (isProbablyBedrockManifest(o)) {
    return bedrockManifestToWorkshopShape(o);
  }

  if (isProbablyJavaPackMcmetaRoot(o)) {
    return javaPackMcmetaToWorkshopShape(o);
  }

  coerceStratumManifestListFields(o);

  if (typeof o.id === "string") {
    const idTrim = o.id.trim();
    if (UUID_RE.test(idTrim)) {
      o.id = `pack.${idTrim.replace(/-/g, "").toLowerCase()}`;
    } else {
      o.id = idTrim.toLowerCase();
    }
  }

  /** Built-in / zips from `public/assets/mods` use `pack_type`; workshop schema uses `mod_type`. */
  const modTypeMissing =
    o.mod_type === undefined || o.mod_type === null || o.mod_type === "";
  if (modTypeMissing && typeof o.pack_type === "string") {
    const pt = o.pack_type.trim().toLowerCase();
    if (pt === "resource_pack" || pt === "texture_pack") {
      o.mod_type = "resource_pack";
    } else if (pt === "behavior_pack" || pt === "block_pack") {
      o.mod_type = "behavior_pack";
    } else if (pt === "mixed") {
      o.mod_type = "mixed";
    }
  }

  /**
   * If both fields are present but disagree, trust `pack_type` (Stratum / built-in convention).
   * Prevents mistaken `mod_type` copies from overriding a correct `pack_type`.
   */
  if (typeof o.pack_type === "string") {
    const pt = o.pack_type.trim().toLowerCase();
    const mt = o.mod_type;
    if (pt === "resource_pack" || pt === "texture_pack") {
      if (mt === "behavior_pack" || mt === "block_pack") {
        o.mod_type = "resource_pack";
      }
    } else if (pt === "behavior_pack" || pt === "block_pack") {
      if (mt === "resource_pack" || mt === "texture_pack") {
        o.mod_type = "behavior_pack";
      }
    }
  }

  if (o.mod_type === undefined || o.mod_type === null || o.mod_type === "") {
    o.mod_type = "behavior_pack";
  }

  const fv = o.format_version;
  if (typeof fv === "number") {
    o.format_version = fv >= 2 ? "1.1.0" : "1.0.0";
  } else if (fv === "2") {
    o.format_version = "1.1.0";
  } else if (fv === "1") {
    o.format_version = "1.0.0";
  }

  if (
    (o.format_version === undefined || o.format_version === null || o.format_version === "") &&
    typeof o.id === "string" &&
    o.id.trim().length > 0 &&
    typeof o.version === "string" &&
    /^\d+\.\d+\.\d+$/.test(o.version.trim()) &&
    typeof o.name === "string" &&
    o.name.trim().length > 0
  ) {
    o.format_version = "1.1.0";
  }

  return o;
}

const workshopManifestObjectSchema = z
  .object({
    format_version: z.enum(["1.0.0", "1.1.0"]),
    id: workshopManifestIdSchema,
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    name: z.string().min(1).max(64),
    description: z.string().max(500).default(""),
    mod_type: workshopModTypeManifestSchema.default("behavior_pack"),
    game_version_min: z.string().regex(/^\d+\.\d+\.\d+$/).optional(),
    /** Optional legacy explicit file lists; modern packs are discovered from folder layout. */
    blocks: z.array(z.string()).default([]),
    items: z.array(z.string()).default([]),
    recipes: z.array(z.string()).default([]),
    /** Optional legacy explicit loot paths inside the ZIP. */
    loot: z.array(z.string()).default([]),
    /** Optional legacy explicit structure paths inside the ZIP. */
    structures: z.array(z.string()).default([]),
    /** Optional legacy explicit feature paths inside the ZIP. */
    features: z.array(z.string()).default([]),
    textures: z.array(z.string()).default([]),
    texture_atlas_patch: z.string().optional(),
    /** Maps item `textureName` → PNG path inside the ZIP (for the item atlas). */
    item_textures: z.record(z.string()).default({}),
  })
  .strip();

export const WorkshopManifestSchema = z.preprocess(
  preprocessWorkshopManifestRoot,
  workshopManifestObjectSchema,
);

export type WorkshopManifest = z.infer<typeof workshopManifestObjectSchema>;

/** New uploads must declare one of these in `manifest.json`. */
export function assertPublishableWorkshopManifest(m: WorkshopManifest): void {
  if (m.mod_type !== "behavior_pack" && m.mod_type !== "resource_pack") {
    throw new Error(
      'manifest.mod_type must be "behavior_pack" or "resource_pack" for new uploads (legacy block_pack / texture_pack / mixed are load-only).',
    );
  }
}

/** Normalizes API/DB rows (including pre-migration values) to directory row types. */
export function normalizeWorkshopRowModType(raw: string): WorkshopModTypeRow {
  if (raw === "behavior_pack" || raw === "resource_pack" || raw === "world") {
    return raw;
  }
  if (raw === "block_pack" || raw === "mixed") {
    return "behavior_pack";
  }
  if (raw === "texture_pack") {
    return "resource_pack";
  }
  return "behavior_pack";
}

export interface ModListEntry {
  readonly id: ModRecordId;
  readonly name: string;
  readonly description: string;
  readonly modId: string;
  readonly version: string;
  readonly modType: WorkshopModTypeRow;
  readonly filePath: string;
  readonly coverPath: string;
  readonly fileSize: number;
  readonly downloadCount: number;
  readonly createdAt: string;
  readonly authorName: string;
  readonly avgRating: number;
  readonly ratingCount: number;
  readonly commentCount: number;
  /** Present for owner directory rows from `stratum_mods`. */
  readonly isPublished?: boolean;
}

export interface ModDetailEntry {
  readonly id: ModRecordId;
  readonly name: string;
  readonly description: string;
  readonly modId: string;
  readonly version: string;
  readonly modType: WorkshopModTypeRow;
  readonly filePath: string;
  readonly coverPath: string;
  readonly fileSize: number;
  readonly downloadCount: number;
  readonly createdAt: string;
  readonly authorName: string;
  readonly avgRating: number;
  readonly ratingCount: number;
}

export interface ModComment {
  readonly id: string;
  readonly modUuid: ModRecordId;
  readonly authorId: string;
  readonly authorName: string;
  readonly body: string;
  readonly createdAt: string;
}

export interface CachedMod {
  readonly recordId: ModRecordId;
  readonly modId: string;
  readonly version: string;
  readonly fetchedAt: number;
  readonly files: Record<string, Uint8Array>;
  readonly manifest: WorkshopManifest;
}
