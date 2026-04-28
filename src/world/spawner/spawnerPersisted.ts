import { CHUNK_SIZE } from "../../core/constants";
import { worldToLocalBlock } from "../chunk/ChunkCoord";
import type { SpawnerTileState } from "./SpawnerTileState";

export type SpawnerPersistedChunk = {
  lx: number;
  ly: number;
  delay: number;
  maxCount: number;
  playerRange: number;
  spawnRange: number;
  spawnPotentials: string[];
  nextSpawnAtWorldTimeMs: number;
};

function clampInt(v: unknown, fallback: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    return fallback;
  }
  return Math.max(0, Math.floor(v));
}

export function normalizeSpawnerPersistedChunk(raw: unknown): SpawnerPersistedChunk | undefined {
  if (raw === null || typeof raw !== "object") {
    return undefined;
  }
  const o = raw as Record<string, unknown>;
  const lx = clampInt(o.lx, -1);
  const ly = clampInt(o.ly, -1);
  if (lx < 0 || lx >= CHUNK_SIZE || ly < 0 || ly >= CHUNK_SIZE) {
    return undefined;
  }
  const spawnPotentialsRaw = Array.isArray(o.spawnPotentials) ? o.spawnPotentials : [];
  const spawnPotentials = spawnPotentialsRaw
    .filter((v): v is string => typeof v === "string")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return {
    lx,
    ly,
    delay: clampInt(o.delay, 200),
    maxCount: clampInt(o.maxCount, 6),
    playerRange: clampInt(o.playerRange, 16),
    spawnRange: clampInt(o.spawnRange, 4),
    spawnPotentials: spawnPotentials.length > 0 ? spawnPotentials : ["sheep"],
    nextSpawnAtWorldTimeMs:
      typeof o.nextSpawnAtWorldTimeMs === "number" && Number.isFinite(o.nextSpawnAtWorldTimeMs)
        ? o.nextSpawnAtWorldTimeMs
        : 0,
  };
}

export function spawnerTileToPersisted(
  wx: number,
  wy: number,
  state: SpawnerTileState,
): SpawnerPersistedChunk {
  const { lx, ly } = worldToLocalBlock(wx, wy);
  return {
    lx,
    ly,
    delay: Math.max(0, Math.floor(state.delay)),
    maxCount: Math.max(0, Math.floor(state.maxCount)),
    playerRange: Math.max(0, Math.floor(state.playerRange)),
    spawnRange: Math.max(0, Math.floor(state.spawnRange)),
    spawnPotentials: [...state.spawnPotentials],
    nextSpawnAtWorldTimeMs: state.nextSpawnAtWorldTimeMs,
  };
}

export function persistedToSpawnerTile(p: SpawnerPersistedChunk): SpawnerTileState {
  return {
    delay: p.delay,
    maxCount: p.maxCount,
    playerRange: p.playerRange,
    spawnRange: p.spawnRange,
    spawnPotentials: [...p.spawnPotentials],
    nextSpawnAtWorldTimeMs: p.nextSpawnAtWorldTimeMs,
  };
}
