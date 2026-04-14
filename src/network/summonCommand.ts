/**
 * Parse `/summon` chat arguments (host / OP / offline solo).
 */

import { normalizeSlimeColor } from "../entities/mobs/mobConstants";
import { parseSheepWoolColorName } from "../entities/mobs/sheepWool";

export type SummonParseOk = {
  ok: true;
  /** Normalized id for dispatch. */
  entityKey: "sheep" | "pig" | "duck" | "zombie" | "slime";
  /** When set, spawn at this world block column using surface height; otherwise at issuer's feet. */
  wx?: number;
  /** Sheep: dye ordinal. Slime: color tier 0–3 (green…red). */
  woolColor?: number;
};

function parseSlimeVariantName(p: string): number | null {
  const t = p.toLowerCase();
  if (t === "green") {
    return 0;
  }
  if (t === "yellow") {
    return 1;
  }
  if (t === "blue") {
    return 2;
  }
  if (t === "red") {
    return 3;
  }
  return null;
}

export type SummonParseResult =
  | SummonParseOk
  | { ok: false; error: string };

/**
 * @param rest Text after `/summon` (no leading slash).
 */
export function parseSummonCommandRest(rest: string): SummonParseResult {
  const parts = rest.trim().split(/\s+/).filter((p) => p.length > 0);
  const usage =
    "Usage: /summon <sheep|pig|duck|zombie|slime> [blockX] [sheepWool | slimeColor 0-3|green|yellow|blue|red]";
  if (parts.length === 0) {
    return {
      ok: false,
      error: usage,
    };
  }
  const id = parts[0]!.toLowerCase();
  if (
    id !== "sheep" &&
    id !== "stratum:sheep" &&
    id !== "pig" &&
    id !== "stratum:pig" &&
    id !== "duck" &&
    id !== "stratum:duck" &&
    id !== "zombie" &&
    id !== "stratum:zombie" &&
    id !== "slime" &&
    id !== "stratum:slime"
  ) {
    return { ok: false, error: `Unknown entity: ${parts[0]}` };
  }
  if (id === "pig" || id === "stratum:pig") {
    let wx: number | undefined;
    for (const p of parts.slice(1)) {
      const n = Number(p);
      if (!Number.isFinite(n)) {
        return { ok: false, error: `Unknown argument: ${p}` };
      }
      if (wx !== undefined) {
        return { ok: false, error: "Duplicate block X coordinate." };
      }
      wx = Math.trunc(n);
    }
    return { ok: true, entityKey: "pig", wx };
  }
  if (id === "duck" || id === "stratum:duck") {
    let wx: number | undefined;
    for (const p of parts.slice(1)) {
      const n = Number(p);
      if (!Number.isFinite(n)) {
        return { ok: false, error: `Unknown argument: ${p}` };
      }
      if (wx !== undefined) {
        return { ok: false, error: "Duplicate block X coordinate." };
      }
      wx = Math.trunc(n);
    }
    return { ok: true, entityKey: "duck", wx };
  }
  if (id === "zombie" || id === "stratum:zombie") {
    let wx: number | undefined;
    for (const p of parts.slice(1)) {
      const n = Number(p);
      if (!Number.isFinite(n)) {
        return { ok: false, error: `Unknown argument: ${p}` };
      }
      if (wx !== undefined) {
        return { ok: false, error: "Duplicate block X coordinate." };
      }
      wx = Math.trunc(n);
    }
    return { ok: true, entityKey: "zombie", wx };
  }
  if (id === "slime" || id === "stratum:slime") {
    let wx: number | undefined;
    let woolColor: number | undefined;
    for (const p of parts.slice(1)) {
      const variant = parseSlimeVariantName(p);
      if (variant !== null) {
        if (woolColor !== undefined) {
          return { ok: false, error: "Duplicate slime color." };
        }
        woolColor = variant;
        continue;
      }
      const n = Number(p);
      if (!Number.isFinite(n)) {
        return { ok: false, error: `Unknown argument: ${p}` };
      }
      if (wx === undefined) {
        wx = Math.trunc(n);
        continue;
      }
      if (woolColor === undefined) {
        woolColor = normalizeSlimeColor(n);
        continue;
      }
      return { ok: false, error: "Too many arguments for slime." };
    }
    return { ok: true, entityKey: "slime", wx, woolColor };
  }
  if (parts.length === 1) {
    return { ok: true, entityKey: "sheep" };
  }

  let wx: number | undefined;
  let woolColor: number | undefined;

  for (const p of parts.slice(1)) {
    const parsedColor = parseSheepWoolColorName(p);
    if (parsedColor !== null) {
      if (woolColor !== undefined) {
        return { ok: false, error: "Duplicate wool color." };
      }
      woolColor = parsedColor;
      continue;
    }
    const n = Number(p);
    if (Number.isFinite(n)) {
      if (wx !== undefined) {
        return { ok: false, error: "Duplicate block X coordinate." };
      }
      wx = Math.trunc(n);
      continue;
    }
    return {
      ok: false,
      error: `Unknown argument: ${p}`,
    };
  }

  return { ok: true, entityKey: "sheep", wx, woolColor };
}
