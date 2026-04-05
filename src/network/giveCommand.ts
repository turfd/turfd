/**
 * Parse `/give` chat arguments (host / OP / offline solo).
 */

import type { ItemRegistry } from "../items/ItemRegistry";
import { resolveRosterPeer, type SessionRosterEntry } from "./ChatHostController";

const SELF_TOKENS = new Set(["@s", "@p", "me", "self"]);

export type GiveTargetResolved =
  | { kind: "local" }
  | { kind: "peer"; peerId: string };

export type GiveParseResult =
  | { ok: true; target: GiveTargetResolved; itemKey: string; count: number }
  | { ok: false; error: string };

/** Resolve `stratum:id` or short id (tries `stratum:` + tail). */
export function resolveGiveItemKey(
  registry: ItemRegistry,
  raw: string,
): string | undefined {
  const t = raw.trim();
  if (t === "") {
    return undefined;
  }
  if (registry.getByKey(t) !== undefined) {
    return t;
  }
  if (!t.includes(":")) {
    const withNs = `stratum:${t}`;
    if (registry.getByKey(withNs) !== undefined) {
      return withNs;
    }
  }
  return undefined;
}

function resolveGiveTarget(
  firstToken: string,
  issuerPeerId: string | null,
  roster: ReadonlyMap<string, SessionRosterEntry>,
): GiveTargetResolved | { error: string } {
  const low = firstToken.toLowerCase();
  if (SELF_TOKENS.has(low)) {
    if (issuerPeerId !== null && issuerPeerId !== "") {
      return { kind: "peer", peerId: issuerPeerId };
    }
    return { kind: "local" };
  }
  const hit = resolveRosterPeer(roster, firstToken);
  if (hit === null) {
    return { error: "Player not found." };
  }
  return { kind: "peer", peerId: hit.peerId };
}

/**
 * @param rest Text after `/give` (no leading slash).
 * @param issuerPeerId Host/client peer id, or `null` in offline solo (only @s / me targets).
 */
export function parseGiveCommandRest(
  rest: string,
  issuerPeerId: string | null,
  roster: ReadonlyMap<string, SessionRosterEntry>,
): GiveParseResult {
  const tokens = rest.trim().split(/\s+/).filter((s) => s !== "");
  if (tokens.length < 2) {
    return {
      ok: false,
      error:
        "Usage: /give @s <item> [count]  or  /give <player> <item> [count]",
    };
  }

  let count = 1;
  let itemEnd = tokens.length;
  const last = tokens[tokens.length - 1]!;
  if (/^\d+$/.test(last)) {
    count = Number.parseInt(last, 10);
    itemEnd = tokens.length - 1;
    if (!Number.isFinite(count) || count < 1) {
      return { ok: false, error: "Count must be a positive number." };
    }
    if (count > 10_000) {
      count = 10_000;
    }
  }

  if (itemEnd < 2) {
    return { ok: false, error: "Missing item id." };
  }

  const targetTok = tokens[0]!;
  const itemKeyRaw = tokens.slice(1, itemEnd).join(" ");
  const target = resolveGiveTarget(targetTok, issuerPeerId, roster);
  if ("error" in target) {
    return { ok: false, error: target.error };
  }

  return { ok: true, target, itemKey: itemKeyRaw, count };
}
