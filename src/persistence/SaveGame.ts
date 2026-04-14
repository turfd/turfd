/**
 * Persists loaded chunks + world metadata; optional auto-save interval.
 */
import type { EventBus } from "../core/EventBus";
import type { GameEvent } from "../core/types";
import type { Player } from "../entities/Player";
import type { World } from "../world/World";
import type { WorldModerationPersisted } from "../network/moderation/WorldModerationState";
import { ITEM_ID_LAYOUT_REVISION_CURRENT } from "../items/itemIdLayoutMigration";
import type { WorldMetadata } from "./IndexedDBStore";
import { IndexedDBStore } from "./IndexedDBStore";

export class SaveGame {
  private readonly store: IndexedDBStore;
  private readonly world: World;
  private readonly player: Player;
  private readonly worldUuid: string;
  private readonly worldName: string;
  private readonly bus: EventBus;
  private readonly getWorldTimeMs: () => number;
  /** Returns a small JPEG data URL for the world list, or null if capture fails. */
  private readonly capturePreview: (() => string | null) | null;
  /** When set (host / solo), merged into world metadata on save. */
  private readonly getModerationForSave:
    | (() => WorldModerationPersisted | undefined)
    | null;
  /**
   * When set (host), merges multiplayer guest logout positions into `multiplayerLastPositions`
   * then clears the pending map (see Game).
   */
  private readonly mergeMultiplayerLastPositions:
    | ((into: Record<string, { x: number; y: number }>) => void)
    | null;
  /**
   * When set (host), merges multiplayer guest spawn points into `multiplayerSpawnPoints`
   * then clears the pending map (see Game).
   */
  private readonly mergeMultiplayerSpawnPoints:
    | ((into: Record<string, { x: number; y: number }>) => void)
    | null;
  /** When set (solo/host), persisted as `playerSpawnX/Y`. */
  private readonly getPlayerSpawnFeet:
    | (() => { x: number; y: number } | null)
    | null;
  /**
   * When set: return seconds of rain left to persist. Return `undefined` to keep
   * `existing.rainRemainingSec` (multiplayer clients must not overwrite host value).
   */
  private readonly getRainRemainingSec: (() => number | undefined) | null;
  private readonly getMobsForSave:
    | (() => Array<{
        id: number;
        type: number;
        x: number;
        y: number;
        woolColor?: number;
        persistent?: boolean;
      }>)
    | null;
  private readonly getDropsForSave:
    | (() => Array<{
        itemId: number;
        count: number;
        damage: number;
        x: number;
        y: number;
        vx: number;
        vy: number;
      }>)
    | null;
  private autoSaveId: ReturnType<typeof setInterval> | null = null;
  /** Serializes overlapping `save()` calls (autosave + manual) to avoid torn metadata/chunk batches. */
  private _saveSerial = Promise.resolve();

  constructor(
    store: IndexedDBStore,
    world: World,
    player: Player,
    worldUuid: string,
    worldName: string,
    bus: EventBus,
    getWorldTimeMs: () => number,
    capturePreview?: () => string | null,
    getModerationForSave?: () => WorldModerationPersisted | undefined,
    mergeMultiplayerLastPositions?: (
      into: Record<string, { x: number; y: number }>,
    ) => void,
    mergeMultiplayerSpawnPoints?: (
      into: Record<string, { x: number; y: number }>,
    ) => void,
    getPlayerSpawnFeet?: () => { x: number; y: number } | null,
    getRainRemainingSec?: () => number | undefined,
    getMobsForSave?: () => Array<{
      id: number;
      type: number;
      x: number;
      y: number;
      woolColor?: number;
      persistent?: boolean;
    }>,
    getDropsForSave?: () => Array<{
      itemId: number;
      count: number;
      damage: number;
      x: number;
      y: number;
      vx: number;
      vy: number;
    }>,
  ) {
    this.store = store;
    this.world = world;
    this.player = player;
    this.worldUuid = worldUuid;
    this.worldName = worldName;
    this.bus = bus;
    this.getWorldTimeMs = getWorldTimeMs;
    this.capturePreview = capturePreview ?? null;
    this.getModerationForSave = getModerationForSave ?? null;
    this.mergeMultiplayerLastPositions = mergeMultiplayerLastPositions ?? null;
    this.mergeMultiplayerSpawnPoints = mergeMultiplayerSpawnPoints ?? null;
    this.getPlayerSpawnFeet = getPlayerSpawnFeet ?? null;
    this.getRainRemainingSec = getRainRemainingSec ?? null;
    this.getMobsForSave = getMobsForSave ?? null;
    this.getDropsForSave = getDropsForSave ?? null;
  }

  async init(): Promise<void> {
    await this.store.openDB();
  }

  async save(): Promise<void> {
    const p = this._saveSerial.then(() => this.saveNow());
    this._saveSerial = p.then(
      () => {},
      () => {},
    );
    return p;
  }

  /** Write all loaded chunks regardless of dirty state (initial save / manual "save now"). */
  async saveAll(): Promise<void> {
    const p = this._saveSerial.then(() => this.saveNow(true));
    this._saveSerial = p.then(
      () => {},
      () => {},
    );
    return p;
  }

  private async saveNow(forceFull = false): Promise<void> {
    const allChunks = [...this.world.getChunkManager().getLoadedChunks()];
    const chunks = forceFull
      ? allChunks
      : allChunks.filter((c) => c.persistDirty);
    if (import.meta.env.DEV) {
      console.debug(
        `[SaveGame] saving ${chunks.length} dirty / ${allChunks.length} loaded chunks${forceFull ? " (forceFull)" : ""}`,
      );
    }
    await this.store.saveChunkBatch(
      this.worldUuid,
      chunks,
      (cx, cy) => this.world.getFurnaceEntitiesForChunk(cx, cy),
      (cx, cy) => this.world.getChestEntitiesForChunk(cx, cy),
    );
    for (const c of chunks) {
      c.persistDirty = false;
    }

    const existing = await this.store.loadWorld(this.worldUuid);
    const now = Date.now();
    let previewImageDataUrl = existing?.previewImageDataUrl;
    const shot = this.capturePreview?.() ?? null;
    if (shot !== null && shot.length > 0) {
      previewImageDataUrl = shot;
    }
    const moderationPatch = this.getModerationForSave?.();
    const mpMerged: Record<string, { x: number; y: number }> = {
      ...(existing?.multiplayerLastPositions ?? {}),
    };
    this.mergeMultiplayerLastPositions?.(mpMerged);
    const mpSpawnMerged: Record<string, { x: number; y: number }> = {
      ...(existing?.multiplayerSpawnPoints ?? {}),
    };
    this.mergeMultiplayerSpawnPoints?.(mpSpawnMerged);
    const rainFromSave = this.getRainRemainingSec?.();
    const rainRemainingSec =
      rainFromSave === undefined
        ? existing?.rainRemainingSec
        : rainFromSave;
    const mobs = this.getMobsForSave?.() ?? existing?.mobs;
    const drops = this.getDropsForSave?.() ?? existing?.drops;

    const spawnFeet = this.getPlayerSpawnFeet?.() ?? null;

    const meta: WorldMetadata = {
      uuid: this.worldUuid,
      name: existing?.name ?? this.worldName,
      description: existing?.description,
      seed: this.world.getSeed(),
      createdAt: existing?.createdAt ?? now,
      lastPlayedAt: now,
      playerX: this.player.state.position.x,
      playerY: this.player.state.position.y,
      hotbarSlot: this.player.state.hotbarSlot,
      playerHealth: this.player.state.health,
      modList: this.world.getRegistry().getModList(),
      workshopMods: existing?.workshopMods,
      workshopBehaviorMods: existing?.workshopBehaviorMods,
      workshopResourceMods: existing?.workshopResourceMods,
      requirePacksBeforeJoin: existing?.requirePacksBeforeJoin,
      worldTimeMs: this.getWorldTimeMs(),
      ...(rainRemainingSec !== undefined ? { rainRemainingSec } : {}),
      previewImageDataUrl,
      moderation: moderationPatch ?? existing?.moderation,
      playerInventory: this.player.inventory.serialize(),
      playerArmor: this.player.inventory.serializeArmor(),
      blockIdPalette: this.world.getRegistry().buildIdentifierPalette(),
      itemIdLayoutRevision: Math.max(
        existing?.itemIdLayoutRevision ?? 0,
        ITEM_ID_LAYOUT_REVISION_CURRENT,
      ),
      ...(Object.keys(mpMerged).length > 0
        ? { multiplayerLastPositions: mpMerged }
        : {}),
      ...(Object.keys(mpSpawnMerged).length > 0
        ? { multiplayerSpawnPoints: mpSpawnMerged }
        : {}),
      ...(spawnFeet !== null
        ? { playerSpawnX: spawnFeet.x, playerSpawnY: spawnFeet.y }
        : {}),
      ...(mobs !== undefined ? { mobs } : {}),
      ...(drops !== undefined ? { drops } : {}),
    };
    await this.store.saveWorld(meta);
    this.bus.emit({ type: "game:saved" } satisfies GameEvent);
  }

  startAutoSave(intervalMs = 60_000): void {
    this.stopAutoSave();
    this.autoSaveId = setInterval(() => {
      void this.save();
    }, intervalMs);
  }

  stopAutoSave(): void {
    if (this.autoSaveId !== null) {
      clearInterval(this.autoSaveId);
      this.autoSaveId = null;
    }
  }

  destroy(): void {
    this.stopAutoSave();
  }
}
