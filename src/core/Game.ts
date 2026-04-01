/**
 * Top-level coordinator: event bus, fixed game loop, persistence, rendering, and networking.
 */
import { AudioEngine } from "../audio/AudioEngine";
import { readVolumeStored, VOL_KEYS } from "../audio/volumeSettings";
import {
  BLOCK_SIZE,
  CAMERA_PLAYER_VERTICAL_OFFSET_PX,
  DAY_LENGTH_MS,
  FIXED_TIMESTEP_MS,
  PLAYER_HEIGHT,
  PLAYER_WIDTH,
  TORCH_HELD_LIGHT_INTENSITY,
  TORCH_HELD_LIGHT_RADIUS_BLOCKS,
  WORLD_Y_MAX,
} from "./constants";
import { EventBus } from "./EventBus";
import { GameLoop } from "./GameLoop";
import type { GameEvent } from "./types";
import { EntityManager } from "../entities/EntityManager";
import { InputManager } from "../input/InputManager";
import { ItemRegistry, registerBlockItems } from "../items/ItemRegistry";
import { LootResolver } from "../items/LootResolver";
import lootTablesJson from "../items/lootTables/blocks.loot.json";
import { parseLootTablesJson } from "../mods/parseLootTablesJson";
import type { IndexedDBStore } from "../persistence/IndexedDBStore";
import { SaveGame } from "../persistence/SaveGame";
import { parseBlockJson } from "../mods/parseBlockJson";
import { ChunkSyncManager } from "../network/ChunkSyncManager";
import type { HostPeerId } from "../network/hostPeerId";
import type { PeerId } from "../network/INetworkAdapter";
import { PeerJSAdapter } from "../network/PeerJSAdapter";
import type { SupabaseSignalAdapter } from "../network/SupabaseSignalAdapter";
import { PlayerStateBroadcaster } from "../network/PlayerStateBroadcaster";
import { normalizeRoomCode, peerIdToRoomCode, roomCodeToPeerId } from "../network/roomCode";
import { AtlasLoader } from "../renderer/AtlasLoader";
import { BreakOverlay } from "../renderer/BreakOverlay";
import { ChunkRenderer } from "../renderer/chunk/ChunkRenderer";
import { RenderPipeline } from "../renderer/RenderPipeline";
import { CursorStackUI } from "../ui/CursorStackUI";
import { InventoryUI } from "../ui/InventoryUI";
import { UIShell } from "../ui/UIShell";
import { BlockRegistry } from "../world/blocks/BlockRegistry";
import { WorldTime } from "../world/lighting/WorldTime";
import { World } from "../world/World";
import { MsgType } from "../network/protocol/messages";
import type { HeldTorchLighting } from "../renderer/lighting/LightingComposer";

const PEERJS_CLOUD = {
  host: "0.peerjs.com",
  port: 443,
  path: "/",
  secure: true,
} as const;

const WORLD_TIME_BROADCAST_INTERVAL_MS = 5_000;

const HOST_DISABLED_MULTIPLAYER_REASON =
  "The host turned off multiplayer. Return to the main menu to continue.";

export type GameOptions = {
  mount: HTMLElement;
  seed: number;
  worldUuid: string;
  store: IndexedDBStore;
  worldName: string;
  multiplayerJoinRoomCode?: string;
  /** Optional initial world time; defaults to start-of-dawn when omitted. */
  initialWorldTimeMs?: number;
  /** Optional Supabase room relay for authenticated hosts. */
  signalRelay?: SupabaseSignalAdapter | null;
};

export type PlayerSavedState = {
  x: number;
  y: number;
  hotbarSlot: number;
};

export type GameLoadProgress = {
  stage: string;
  detail?: string;
  current?: number;
  total?: number;
};

const TURFD_CORE_BLOCK_FILES = [
  "air.json",
  "dirt.json",
  "grass.json",
  "short_grass.json",
  "tall_grass_bottom.json",
  "tall_grass_top.json",
  "dandelion.json",
  "poppy.json",
  "stone.json",
  "sand.json",
  "gravel.json",
  "bedrock.json",
  "wood-log.json",
  "leaves.json",
  "wood-log-back.json",
  "leaves-back.json",
  "glass.json",
  "torch.json",
  "water.json",
  "coal_ore.json",
  "iron_ore.json",
  "gold_ore.json",
  "diamond_ore.json",
  "redstone_ore.json",
  "lapis_ore.json",
] as const;

export class Game {
  readonly bus: EventBus;
  private readonly loop: GameLoop;
  private readonly mount: HTMLElement;
  private _worldSeed: number;
  private readonly worldUuid: string;
  private readonly store: IndexedDBStore;
  private readonly worldName: string;
  private readonly multiplayerJoinRoomCode?: string;
  private readonly _signalRelay: SupabaseSignalAdapter | null;
  private readonly adapter: PeerJSAdapter;
  private readonly _chunkSync: ChunkSyncManager;
  private readonly _playerStateBroadcaster: PlayerStateBroadcaster;
  private readonly networkUnsubs: (() => void)[] = [];
  /** CHUNK_DATA received before `World` exists (multiplayer join); flushed after `world.init`. */
  private readonly _pendingAuthoritativeChunks: Array<{
    cx: number;
    cy: number;
    blocks: Uint16Array;
    background?: Uint16Array;
  }> = [];

  private pipeline: RenderPipeline | null = null;
  private atlasLoader: AtlasLoader | null = null;
  private world: World | null = null;
  private chunkRenderer: ChunkRenderer | null = null;
  private input: InputManager | null = null;
  private entityManager: EntityManager | null = null;
  private uiShell: UIShell | null = null;
  private breakOverlay: BreakOverlay | null = null;
  private saveGame: SaveGame | null = null;
  private audio: AudioEngine | null = null;
  private inventoryUI: InventoryUI | null = null;
  private cursorStackUI: CursorStackUI | null = null;
  private isInventoryOpen = false;
  private paused = false;

  private lastRenderWallMs = 0;
  private started = false;
  private fixedAsyncChain = Promise.resolve();
  private stopResolve: (() => void) | null = null;
  private quitUnsub: (() => void) | null = null;
  private _awaitingWorldData = false;
  private _worldTimeBroadcastAccum = 0;
  private readonly _worldTime: WorldTime;

  private readonly _heldTorchScratch: HeldTorchLighting = {
    worldBlock: [0, 0],
    radiusBlocks: TORCH_HELD_LIGHT_RADIUS_BLOCKS,
    intensity: TORCH_HELD_LIGHT_INTENSITY,
    color: [1.0, 0.85, 0.55],
  };

  /** Reused by {@link PlayerStateBroadcaster} state callback (avoids object literal per 20 Hz tick). */
  private readonly _playerStateSnap = {
    playerId: 0,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    facingRight: false,
  };

  constructor(options: GameOptions) {
    this.mount = options.mount;
    this._worldSeed = options.seed;
    this.worldUuid = options.worldUuid;
    this.store = options.store;
    this.worldName = options.worldName;
    this.multiplayerJoinRoomCode = options.multiplayerJoinRoomCode;
    this._signalRelay = options.signalRelay ?? null;
    this.bus = new EventBus();
    const initialTimeMs =
      options.initialWorldTimeMs ?? DAY_LENGTH_MS * 0.15;
    this._worldTime = new WorldTime(initialTimeMs);
    this.adapter = new PeerJSAdapter(this.bus);
    this._chunkSync = new ChunkSyncManager(this.adapter, this.bus);
    this._playerStateBroadcaster = new PlayerStateBroadcaster(this.adapter, () => {
      const em = this.entityManager;
      if (em === null) {
        return null;
      }
      const local = em.getPlayer().state;
      const s = this._playerStateSnap;
      s.x = local.position.x;
      s.y = local.position.y;
      s.vx = local.velocity.x;
      s.vy = local.velocity.y;
      s.facingRight = local.facingRight;
      return s;
    });
    this.loop = new GameLoop({
      onFixedUpdate: (dtSec) => this.fixedUpdate(dtSec),
      onRender: (alpha) => this.render(alpha),
    });
    this._wireCoreNetworkEvents();
    this.networkUnsubs.push(
      this.bus.on("ui:set-world-time-phase", (e) => {
        const st = this.adapter.state;
        if (st.status === "connected" && st.role === "client") {
          return;
        }
        const p = Math.min(1, Math.max(0, e.phase));
        this._worldTime.setMs(p * DAY_LENGTH_MS);
        if (st.status === "connected" && st.role === "host") {
          this.adapter.broadcast({
            type: MsgType.WORLD_TIME,
            worldTimeMs: this._worldTime.ms,
          });
        }
      }),
    );
  }

  waitForStop(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.stopResolve = resolve;
    });
  }

  async init(
    playerSavedState?: PlayerSavedState,
    progressCallback?: (progress: GameLoadProgress) => void,
  ): Promise<void> {
    if (this.pipeline !== null) {
      return;
    }

    progressCallback?.({
      stage: this.multiplayerJoinRoomCode ? "Connecting to host" : "Starting session",
      detail: this.multiplayerJoinRoomCode
        ? "Joining multiplayer room..."
        : "Preparing local world session...",
    });
    await this._initEntryNetworking();

    this.quitUnsub = this.bus.on("ui:quit", () => {
      this.stop();
      if (this.stopResolve !== null) {
        const resolve = this.stopResolve;
        this.stopResolve = null;
        resolve();
      }
    });

    const registry = new BlockRegistry();
    progressCallback?.({
      stage: "Loading block data",
      detail: "Reading core block definitions...",
      current: 0,
      total: TURFD_CORE_BLOCK_FILES.length,
    });
    await this.loadTurfdCoreBlocks(registry, (loaded, total, file) => {
      progressCallback?.({
        stage: "Loading block data",
        detail: `Loaded ${file}`,
        current: loaded,
        total,
      });
    });

    const itemRegistry = new ItemRegistry();
    registerBlockItems(
      Array.from({ length: registry.size }, (_, i) => registry.getById(i)),
      itemRegistry,
    );

    const lootResolver = new LootResolver(itemRegistry);
    const lootData = parseLootTablesJson(lootTablesJson);
    for (let i = 0; i < registry.size; i++) {
      const block = registry.getById(i);
      const key = block.lootTable;
      if (key === undefined) {
        continue;
      }
      const table = lootData.loot_tables[key];
      if (table === undefined) {
        continue;
      }
      lootResolver.registerTable(block.id, table);
    }

    const atlas = new AtlasLoader();
    progressCallback?.({
      stage: "Loading textures",
      detail: "Loading atlas spritesheet...",
    });
    await atlas.load();
    this.atlasLoader = atlas;

    const world = new World(
      registry,
      this._worldSeed,
      this.store,
      this.worldUuid,
      lootResolver,
      this.bus,
    );
    this.world = world;

    const pipeline = new RenderPipeline({ mount: this.mount });
    progressCallback?.({
      stage: "Initializing renderer",
      detail: "Setting up GPU pipeline...",
    });
    await pipeline.init();
    pipeline.initLighting(world, this.bus);
    this.pipeline = pipeline;

    progressCallback?.({
      stage: "Preparing world",
      detail: "Loading nearby chunks...",
      current: 0,
      total: 1,
    });
    await world.init((chunkProgress) => {
      progressCallback?.({
        stage: "Preparing world",
        detail:
          chunkProgress.source === "db"
            ? "Loading saved terrain chunks..."
            : "Generating terrain chunks...",
        current: chunkProgress.loaded,
        total: chunkProgress.total,
      });
    });
    for (const [cx, cy] of world.loadedChunkCoords()) {
      world.recomputeChunkLight(cx, cy);
    }
    this._flushPendingAuthoritativeChunks();

    this.chunkRenderer = new ChunkRenderer(pipeline, registry, atlas, world);

    const input = new InputManager(pipeline.getCanvas());
    this.input = input;

    const audio = new AudioEngine();
    audio.setMasterVolume(readVolumeStored(VOL_KEYS.master, 80) / 100);
    audio.setMusicVolume(readVolumeStored(VOL_KEYS.music, 60) / 100);
    audio.setSfxVolume(readVolumeStored(VOL_KEYS.sfx, 100) / 100);
    this.audio = audio;

    const entityManager = new EntityManager(
      world,
      input,
      registry,
      this.bus,
      audio,
      itemRegistry,
      atlas,
    );
    entityManager.initVisual(pipeline);
    this.entityManager = entityManager;

    const saveGame = new SaveGame(
      this.store,
      world,
      entityManager.getPlayer(),
      this.worldUuid,
      this.worldName,
      this.bus,
      () => this._worldTime.ms,
      () => this.pipeline?.captureWorldPreviewDataUrl() ?? null,
    );
    progressCallback?.({
      stage: "Finalizing",
      detail: "Preparing save data and UI...",
    });
    await saveGame.init();
    saveGame.startAutoSave(60_000);
    this.saveGame = saveGame;

    this.uiShell = new UIShell(this.bus, this.mount, saveGame, audio);

    this.bus.on("ui:close-pause", () => {
      if (!this.paused) {
        return;
      }
      this.paused = false;
      this.input?.setWorldInputBlocked(false);
      this.uiShell?.setPauseOverlayOpen(false);
    });

    this.bus.on("ui:screenshot", () => {
      this.pipeline?.takeScreenshot();
    });

    const inventoryUI = new InventoryUI(this.mount, itemRegistry, () =>
      this.entityManager!.getPlayer().inventory,
    );
    await inventoryUI.loadAtlasLayout();
    this.inventoryUI = inventoryUI;

    this.cursorStackUI = new CursorStackUI(
      this.mount,
      itemRegistry,
      () => this.entityManager!.getPlayer().inventory.getCursorStack(),
      () => this.inventoryUI!.getAtlasLayout(),
    );

    this._wirePauseNetworkHandlers();
    this._emitNetworkRoleForUi();
    this.breakOverlay = new BreakOverlay(pipeline);

    this.bus.on("game:block-changed", (e) => {
      const state = this.adapter.state;
      if (state.status !== "connected") {
        return;
      }
      this.adapter.broadcast({
        type: MsgType.BLOCK_UPDATE,
        x: e.wx,
        y: e.wy,
        blockId: e.blockId,
        layer: e.layer === "bg" ? 1 : 0,
      });
    });

    const player = entityManager.getPlayer();
    if (playerSavedState !== undefined) {
      player.applySavedState(
        playerSavedState.x,
        playerSavedState.y,
        playerSavedState.hotbarSlot,
      );
    } else {
      const airId = world.getRegistry().getByIdentifier("turfd:air").id;
      let surfaceY: number | null = null;
      for (let wy = 0; wy < WORLD_Y_MAX; wy++) {
        const solid = world.getBlock(0, wy);
        const above = world.getBlock(0, wy + 1);
        if (solid.solid && (above.id === airId || above.replaceable)) {
          surfaceY = wy;
          break;
        }
      }
      player.spawnAt(0, ((surfaceY ?? 1) + 1) * BLOCK_SIZE);
    }

    if (!player.inventory.hasAnyItems()) {
      player.seedStarterInventory();
    }

    pipeline.getCamera().setPositionImmediate(
      player.state.position.x,
      -player.state.position.y - CAMERA_PLAYER_VERTICAL_OFFSET_PX,
    );
    progressCallback?.({
      stage: "Entering world",
      detail: "Almost ready...",
      current: 1,
      total: 1,
    });
    this.bus.emit({ type: "game:worldLoaded", name: this.worldName } satisfies GameEvent);
  }

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.bus.emit({ type: "game:started" } satisfies GameEvent);
    this._playerStateBroadcaster.start();
    this.loop.start();
  }

  stop(): void {
    if (!this.started) {
      return;
    }
    this.started = false;
    this._playerStateBroadcaster.stop();
    this.loop.stop();
    this.bus.emit({ type: "game:stopped" } satisfies GameEvent);
  }

  async destroy(): Promise<void> {
    this.stop();
    const stEnd = this.adapter.state;
    if (stEnd.status === "connected" && stEnd.role === "host") {
      const hid = stEnd.lanHostPeerId;
      if (hid !== null) {
        const rc = peerIdToRoomCode(hid);
        if (rc !== null && this._signalRelay !== null) {
          void this._signalRelay.clearRoom(rc);
        }
      }
    }
    this.adapter.disconnect();
    this.quitUnsub?.();
    this.quitUnsub = null;
    this.stopResolve = null;
    for (const unsub of this.networkUnsubs) {
      unsub();
    }
    this.networkUnsubs.length = 0;

    const sg = this.saveGame;
    this.saveGame = null;
    sg?.stopAutoSave();
    if (sg !== null) {
      await sg.save();
      sg.destroy();
    }

    this.cursorStackUI?.destroy();
    this.cursorStackUI = null;
    this.inventoryUI?.destroy();
    this.inventoryUI = null;
    this.isInventoryOpen = false;
    this.paused = false;
    this.uiShell?.destroy();
    this.uiShell = null;
    this.audio?.destroy();
    this.audio = null;
    this.breakOverlay?.destroy();
    this.breakOverlay = null;
    this.entityManager?.destroy();
    this.entityManager = null;
    this.input?.destroy();
    this.input = null;
    this.chunkRenderer?.destroy();
    this.chunkRenderer = null;
    this.lastRenderWallMs = 0;
    this.pipeline?.destroy();
    this.pipeline = null;
    this.atlasLoader?.destroy();
    this.atlasLoader = null;
    this.world = null;
    this.bus.clear();
  }

  private async _initEntryNetworking(): Promise<void> {
    const code = this.multiplayerJoinRoomCode;
    if (code === undefined) {
      return;
    }
    const normalized = normalizeRoomCode(code);
    if (normalized === null) {
      throw new Error("Invalid room code");
    }
    this._awaitingWorldData = true;
    let hostPeerId: HostPeerId = roomCodeToPeerId(normalized);
    if (this._signalRelay !== null) {
      const fromRelay = await this._signalRelay.lookupHostPeerId(normalized);
      if (fromRelay !== null) {
        hostPeerId = fromRelay;
      }
    }
    await this.adapter.join(PEERJS_CLOUD, hostPeerId);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        unsub();
        reject(new Error("Timed out waiting for host world sync"));
      }, 10_000);
      const unsub = this.bus.on("net:message", (e) => {
        if (e.message.type === MsgType.WORLD_SYNC) {
          clearTimeout(timeout);
          unsub();
          resolve();
        }
      });
    });
  }

  private _wireCoreNetworkEvents(): void {
    this.networkUnsubs.push(
      this.bus.on("net:message", (e) => {
        const msg = e.message;
        if (msg.type === MsgType.SESSION_ENDED) {
          const st = this.adapter.state;
          if (st.status === "connected" && st.role === "client") {
            const text =
              msg.reason.trim() !== ""
                ? msg.reason
                : "The session has ended.";
            this.bus.emit({
              type: "ui:session-ended",
              message: text,
            } satisfies GameEvent);
          }
          return;
        }
        if (msg.type === MsgType.CHUNK_DATA) {
          const blocks = msg.blocks.slice();
          const background = msg.background?.slice();
          const w = this.world;
          if (w === null) {
            this._pendingAuthoritativeChunks.push({
              cx: msg.cx,
              cy: msg.cy,
              blocks,
              background,
            });
          } else {
            w.applyAuthoritativeChunk(msg.cx, msg.cy, blocks, background);
          }
          return;
        }
        if (this._awaitingWorldData && msg.type === MsgType.WORLD_SYNC) {
          this._worldSeed = msg.seed;
          this._worldTime.sync(msg.worldTimeMs);
          this._awaitingWorldData = false;
          return;
        }
        if (msg.type === MsgType.WORLD_TIME) {
          this._worldTime.sync(msg.worldTimeMs);
          return;
        }
        if (msg.type === MsgType.BLOCK_UPDATE && this.world !== null) {
          if (msg.layer === 1) {
            this.world.setBackgroundBlock(msg.x, msg.y, msg.blockId);
          } else {
            this.world.setBlock(msg.x, msg.y, msg.blockId);
          }
          return;
        }
        if (msg.type === MsgType.PLAYER_STATE && this.world !== null) {
          this.world.updateRemotePlayer(
            e.peerId,
            msg.x,
            msg.y,
            msg.facingRight,
          );
        }
      }),
    );
    this.networkUnsubs.push(
      this.bus.on("net:peer-left", (e) => {
        this.world?.removeRemotePlayer(e.peerId);
      }),
    );
    this.networkUnsubs.push(
      this.bus.on("net:peer-joined", (e) => {
        const state = this.adapter.state;
        if (state.status === "connected" && state.role === "host") {
          this.adapter.broadcast({
            type: MsgType.WORLD_SYNC,
            seed: this._worldSeed,
            worldTimeMs: this._worldTime.ms,
          });
          this.adapter.broadcast({
            type: MsgType.WORLD_TIME,
            worldTimeMs: this._worldTime.ms,
          });
          const world = this.world;
          if (world !== null) {
            const peerId = e.peerId as PeerId;
            this._chunkSync.sendAllChunksTo(peerId, (fn) => {
              for (const chunk of world.getChunkManager().getLoadedChunks()) {
                fn({
                  chunkX: chunk.coord.cx,
                  chunkY: chunk.coord.cy,
                  blocks: chunk.blocks,
                  background: chunk.background,
                });
              }
            });
          }
          const roomCode = state.lanHostPeerId
            ? peerIdToRoomCode(state.lanHostPeerId)
            : null;
          if (roomCode !== null) {
            this.bus.emit({ type: "net:room-code", roomCode } satisfies GameEvent);
          }
        }
      }),
    );
  }

  private _flushPendingAuthoritativeChunks(): void {
    const w = this.world;
    if (w === null || this._pendingAuthoritativeChunks.length === 0) {
      return;
    }
    w.applyAuthoritativeChunkBatch(this._pendingAuthoritativeChunks);
    this._pendingAuthoritativeChunks.length = 0;
  }

  private _wirePauseNetworkHandlers(): void {
    this.networkUnsubs.push(
      this.bus.on("ui:toggle-multiplayer", () => {
        const state = this.adapter.state;
        if (state.status === "connected" && state.role === "host") {
          this.adapter.broadcast({
            type: MsgType.SESSION_ENDED,
            reason: HOST_DISABLED_MULTIPLAYER_REASON,
          });
          queueMicrotask(() => {
            const stOff = this.adapter.state;
            if (stOff.status === "connected" && stOff.role === "host") {
              const hidOff = stOff.lanHostPeerId;
              if (hidOff !== null) {
                const rc = peerIdToRoomCode(hidOff);
                if (rc !== null && this._signalRelay !== null) {
                  void this._signalRelay.clearRoom(rc);
                }
              }
            }
            this.adapter.disconnect();
            this.world?.clearRemotePlayers();
            this._emitNetworkRoleForUi();
            this.bus.emit({
              type: "net:room-code",
              roomCode: null,
            } satisfies GameEvent);
          });
          return;
        }
        if (state.status === "connected" && state.role === "client") {
          return;
        }
        if (state.status === "connecting") {
          return;
        }
        void this.adapter
          .host(PEERJS_CLOUD)
          .then((hostPeerId) => {
            this._emitNetworkRoleForUi();
            const roomCode = peerIdToRoomCode(hostPeerId);
            if (roomCode !== null) {
              if (this._signalRelay !== null) {
                void this._signalRelay.publishRoom(roomCode, hostPeerId);
              }
              this.bus.emit({ type: "net:room-code", roomCode } satisfies GameEvent);
            }
          })
          .catch((err: unknown) => {
            const message =
              err instanceof Error ? err.message : "Failed to enable multiplayer";
            this.bus.emit({ type: "net:error", message } satisfies GameEvent);
          });
      }),
    );
  }

  private _emitNetworkRoleForUi(): void {
    const state = this.adapter.state;
    const role =
      state.status === "connected" ? state.role : "offline";
    this.bus.emit({ type: "game:network-role", role } satisfies GameEvent);
  }

  private async loadTurfdCoreBlocks(
    registry: BlockRegistry,
    progressCallback?: (loaded: number, total: number, file: string) => void,
  ): Promise<void> {
    const base = import.meta.env.BASE_URL;
    const total = TURFD_CORE_BLOCK_FILES.length;
    let loaded = 0;
    for (const file of TURFD_CORE_BLOCK_FILES) {
      const url = `${base}assets/mods/turfd-core/blocks/${file}`;
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`Failed to load ${url}: ${res.status} ${res.statusText}`);
      }
      const raw: unknown = await res.json();
      const def = parseBlockJson(raw);
      registry.register(def);
      loaded++;
      progressCallback?.(loaded, total, file);
    }
  }

  private fixedUpdate(dtSec: number): void {
    const tickIndex = this.loop.getTickIndex();

    const pipeline = this.pipeline;
    const world = this.world;
    const input = this.input;
    const entityManager = this.entityManager;

    if (
      pipeline !== null &&
      world !== null &&
      input !== null &&
      entityManager !== null
    ) {
      input.updateMouseWorldPos(pipeline.getCamera());

      if (input.isJustPressed("pause")) {
        if (this.isInventoryOpen) {
          this.isInventoryOpen = false;
          this.inventoryUI?.setOpen(false);
          input.setWorldInputBlocked(false);
        } else {
          this.paused = !this.paused;
          input.setWorldInputBlocked(this.paused);
          this.uiShell?.setPauseOverlayOpen(this.paused);
        }
      }

      if (this.paused) {
        input.postUpdate();
        return;
      }

      if (input.isJustPressed("inventory")) {
        this.isInventoryOpen = !this.isInventoryOpen;
        input.setWorldInputBlocked(this.isInventoryOpen);
        this.inventoryUI?.setOpen(this.isInventoryOpen);
      }

      this._worldTime.tick(FIXED_TIMESTEP_MS);
      const netStateForTime = this.adapter.state;
      const role =
        netStateForTime.status === "connected"
          ? netStateForTime.role
          : "offline";
      if (role === "host") {
        this._worldTimeBroadcastAccum += FIXED_TIMESTEP_MS;
        if (this._worldTimeBroadcastAccum >= WORLD_TIME_BROADCAST_INTERVAL_MS) {
          this._worldTimeBroadcastAccum = 0;
          this.adapter.broadcast({
            type: MsgType.WORLD_TIME,
            worldTimeMs: this._worldTime.ms,
          });
        }
      }

      entityManager.update(dtSec);
      world.updateRemotePlayers(dtSec);
      const pl = entityManager.getPlayer().state.position;
      world.updateDroppedItems(
        dtSec,
        {
          x: pl.x,
          y: pl.y + PLAYER_HEIGHT * 0.5,
        },
        entityManager.getPlayer().inventory,
      );

      input.postUpdate();

      const p = entityManager.getPlayer().state.position;
      const bx = Math.floor(p.x / BLOCK_SIZE);
      const by = Math.floor(p.y / BLOCK_SIZE);
      this.fixedAsyncChain = this.fixedAsyncChain.then(() =>
        world.streamChunksAroundPlayer(bx, by),
      );
    }

    this.bus.emit({
      type: "game:tick",
      tickIndex,
      dtSec,
      worldTimeMs: this._worldTime.ms,
    } satisfies GameEvent);
  }

  private render(alpha: number): void {
    const now = performance.now();
    const dtSec =
      this.lastRenderWallMs > 0
        ? Math.min((now - this.lastRenderWallMs) / 1000, 0.1)
        : 0;
    this.lastRenderWallMs = now;

    if (this.chunkRenderer !== null && this.world !== null) {
      this.chunkRenderer.syncChunks(this.world.getChunkManager().getLoadedChunks());
    }

    if (this.entityManager !== null && this.pipeline !== null) {
      const s = this.entityManager.getPlayer().state;
      const ix = s.prevPosition.x + (s.position.x - s.prevPosition.x) * alpha;
      const iy = s.prevPosition.y + (s.position.y - s.prevPosition.y) * alpha;
      this.pipeline
        .getCamera()
        .setTarget(ix, -iy - CAMERA_PLAYER_VERTICAL_OFFSET_PX);
    }

    this.pipeline?.getCamera().update(dtSec);

    if (this.input !== null && this.pipeline !== null) {
      this.input.updateMouseWorldPos(this.pipeline.getCamera());
    }

    this.entityManager?.syncPlayerGraphic(alpha, dtSec);
    if (this.entityManager !== null && this.inventoryUI !== null) {
      const pl = this.entityManager.getPlayer();
      this.inventoryUI.update(pl.inventory, pl.state.hotbarSlot);
    }
    this.cursorStackUI?.sync();
    if (this.entityManager !== null && this.breakOverlay !== null) {
      this.breakOverlay.sync(this.entityManager.getPlayer().state);
    }
    if (this.entityManager !== null) {
      this.uiShell?.setBackgroundEditMode(
        this.entityManager.getPlayer().state.backgroundEditMode,
      );
    }
    this.pipeline?.prepareFrame();
    if (this.pipeline !== null) {
      const lightingParams = this._worldTime.getLightingParams();
      this.pipeline.updateSky(lightingParams);
      if (this.world !== null && this.entityManager !== null) {
        const cam = this.pipeline.getCamera();
        const pos = cam.getPosition();
        const player = this.entityManager.getPlayer();
        const torchId = this.world
          .getRegistry()
          .getByIdentifier("turfd:torch").id;
        let heldTorch: HeldTorchLighting | null = null;
        if (player.getSelectedHotbarBlockId() === torchId) {
          const st = player.state;
          const wx = (st.position.x + PLAYER_WIDTH * 0.5) / BLOCK_SIZE;
          const wy = (st.position.y + PLAYER_HEIGHT * 0.5) / BLOCK_SIZE;
          const ht = this._heldTorchScratch;
          ht.worldBlock[0] = wx;
          ht.worldBlock[1] = wy;
          heldTorch = ht;
        }
        this.pipeline.lightingComposer.update(
          lightingParams,
          pos.x,
          pos.y,
          heldTorch,
        );
      }
    }
    this.pipeline?.render(alpha);
    this.bus.emit({ type: "game:render", alpha } satisfies GameEvent);
  }
}
