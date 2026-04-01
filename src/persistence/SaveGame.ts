/**
 * Persists loaded chunks + world metadata; optional auto-save interval.
 */
import type { EventBus } from "../core/EventBus";
import type { GameEvent } from "../core/types";
import type { Player } from "../entities/Player";
import type { World } from "../world/World";
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
  ) {
    this.store = store;
    this.world = world;
    this.player = player;
    this.worldUuid = worldUuid;
    this.worldName = worldName;
    this.bus = bus;
    this.getWorldTimeMs = getWorldTimeMs;
    this.capturePreview = capturePreview ?? null;
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
