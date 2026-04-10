/**
 * Parse `/summon` chat arguments (host / OP / offline solo).
 */

import { parseSheepWoolColorName } from "../entities/mobs/sheepWool";

export type SummonParseOk = {
  ok: true;
  /** Normalized id for dispatch. */
  entityKey: "sheep" | "pig" | "zombie";
  /** When set, spawn at this world block column using surface height; otherwise at issuer's feet. */
  wx?: number;
  /** When set, force this wool color instead of a random summon color. */
  woolColor?: number;
};

export type SummonParseResult =
  | SummonParseOk
  | { ok: false; error: string };

/**
 * @param rest Text after `/summon` (no leading slash).
 */
export function parseSummonCommandRest(rest: string): SummonParseResult {
  const parts = rest.trim().split(/\s+/).filter((p) => p.length > 0);
  const usage =
    "Usage: /summon <sheep|stratum:sheep|pig|stratum:pig|zombie|stratum:zombie> [blockX] [woolColor]";
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
    id !== "zombie" &&
    id !== "stratum:zombie"
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
