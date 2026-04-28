export type SpawnerTileState = {
  delay: number;
  maxCount: number;
  playerRange: number;
  spawnRange: number;
  spawnPotentials: string[];
  nextSpawnAtWorldTimeMs: number;
};

export function spawnerCellKey(wx: number, wy: number): string {
  return `${wx},${wy}`;
}

export function createDefaultSpawnerTileState(): SpawnerTileState {
  return {
    delay: 200,
    maxCount: 6,
    playerRange: 16,
    spawnRange: 4,
    spawnPotentials: ["sheep"],
    nextSpawnAtWorldTimeMs: 0,
  };
}

function sanitizeInt(v: unknown, fallback: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    return fallback;
  }
  return Math.max(0, Math.floor(v));
}

export function normalizeSpawnerTileStateForGeneratedPlacement(raw: unknown): SpawnerTileState {
  const fallback = createDefaultSpawnerTileState();
  if (raw === null || typeof raw !== "object") {
    return fallback;
  }
  const o = raw as Record<string, unknown>;
  const spawnPotentialsRaw = Array.isArray(o.spawnPotentials) ? o.spawnPotentials : [];
  const spawnPotentials = spawnPotentialsRaw
    .filter((v): v is string => typeof v === "string")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return {
    delay: Math.max(1, sanitizeInt(o.delay, fallback.delay)),
    maxCount: sanitizeInt(o.maxCount, fallback.maxCount),
    playerRange: sanitizeInt(o.playerRange, fallback.playerRange),
    spawnRange: sanitizeInt(o.spawnRange, fallback.spawnRange),
    spawnPotentials: spawnPotentials.length > 0 ? spawnPotentials : [...fallback.spawnPotentials],
    // Exported structures can carry stale timeline from old world.
    // Reset on placement so spawner starts in new world.
    nextSpawnAtWorldTimeMs: 0,
  };
}
