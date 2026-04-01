/**
 * Persists loaded chunks + world metadata; optional auto-save interval.
 */
import type { EventBus } from "../core/EventBus";
import type { GameEvent } from "../core/types";
import type { Player } from "../entities/Player";
import type { World } from "../world/World";
import type { WorldModerationPersisted } from "../network/moderation/WorldModerationState";
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
  private autoSaveId: ReturnType<typeof setInterval> | null = null;

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
  }

  async init(): Promise<void> {
    await this.store.openDB();
  }

  async save(): Promise<void> {
    const chunks = [...this.world.getChunkManager().getLoadedChunks()];
    await this.store.saveChunkBatch(this.worldUuid, chunks);

    const existing = await this.store.loadWorld(this.worldUuid);
    const now = Date.now();
    let previewImageDataUrl = existing?.previewImageDataUrl;
    const shot = this.capturePreview?.() ?? null;
    if (shot !== null && shot.length > 0) {
      previewImageDataUrl = shot;
    }
    const moderationPatch = this.getModerationForSave?.();
    const meta: WorldMetadata = {
      uuid: this.worldUuid,
      name: existing?.name ?? this.worldName,
      seed: this.world.getSeed(),
      createdAt: existing?.createdAt ?? now,
      lastPlayedAt: now,
      playerX: this.player.state.position.x,
      playerY: this.player.state.position.y,
      hotbarSlot: this.player.state.hotbarSlot,
      modList: this.world.getRegistry().getModList(),
      worldTimeMs: this.getWorldTimeMs(),
      previewImageDataUrl,
      moderation: moderationPatch ?? existing?.moderation,
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
