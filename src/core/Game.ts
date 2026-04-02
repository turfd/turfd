/**
 * Top-level coordinator: event bus, fixed game loop, persistence, rendering, and networking.
 */
import { AudioEngine } from "../audio/AudioEngine";
import { readVolumeStored, VOL_KEYS } from "../audio/volumeSettings";
import {
  BLOCK_SIZE,
  CAMERA_PLAYER_VERTICAL_OFFSET_PX,
  CRAFTING_TABLE_ACCESS_RADIUS_BLOCKS,
  DAY_LENGTH_MS,
  FIXED_TIMESTEP_MS,
  PLAYER_HEIGHT,
  PLAYER_WIDTH,
  RECIPE_STATION_CRAFTING_TABLE,
  TORCH_HELD_LIGHT_INTENSITY,
  TORCH_HELD_LIGHT_RADIUS_BLOCKS,
  WORLD_Y_MAX,
} from "./constants";
import { EventBus } from "./EventBus";
import { GameLoop } from "./GameLoop";
import type { GameEvent } from "./types";
import { CraftingSystem, type CraftingStationContext } from "../entities/CraftingSystem";
import { EntityManager } from "../entities/EntityManager";
import { InputManager } from "../input/InputManager";
import { ItemRegistry, registerBlockItems } from "../items/ItemRegistry";
import { LootResolver } from "../items/LootResolver";
import lootTablesJson from "../items/lootTables/blocks.loot.json";
import { parseLootTablesJson } from "../mods/parseLootTablesJson";
import type { IndexedDBStore, WorldMetadata } from "../persistence/IndexedDBStore";
import { SaveGame } from "../persistence/SaveGame";
import { parseBlockJson } from "../mods/parseBlockJson";
import { parseItemJson } from "../mods/parseItemJson";
import { parseRecipeJson } from "../mods/parseRecipeJson";
import {
  STRATUM_CORE_BLOCK_FILES,
  STRATUM_CORE_ITEM_FILES,
} from "../mods/stratumCoreManifest";
import { ChunkSyncManager } from "../network/ChunkSyncManager";
import type { HostPeerId } from "../network/hostPeerId";
import type { PeerId } from "../network/INetworkAdapter";
import { PeerJSAdapter } from "../network/PeerJSAdapter";
import type {
  RoomPublishMeta,
  SupabaseSignalAdapter,
} from "../network/SupabaseSignalAdapter";
import { PlayerStateBroadcaster } from "../network/PlayerStateBroadcaster";
import type { RoomCode } from "../network/roomCode";
import { normalizeRoomCode, peerIdToRoomCode, roomCodeToPeerId } from "../network/roomCode";
import {
  BLOCK_TEXTURE_MANIFEST_PATH,
  ITEM_TEXTURE_MANIFEST_PATH,
  fetchTextureManifestJson,
  resolveItemTextureRecord,
} from "./textureManifest";
import { AtlasLoader } from "../renderer/AtlasLoader";
import { BreakOverlay } from "../renderer/BreakOverlay";
import { ChunkRenderer } from "../renderer/chunk/ChunkRenderer";
import { RenderPipeline } from "../renderer/RenderPipeline";
import { ChatHostController } from "../network/ChatHostController";
import {
  migrateModerationMetadata,
  WorldModerationState,
} from "../network/moderation/WorldModerationState";
import { CraftingPanel } from "../ui/CraftingPanel";
import { CursorStackUI } from "../ui/CursorStackUI";
import { ChatOverlay } from "../ui/ChatOverlay";
import { InventoryUI } from "../ui/InventoryUI";
import { NametagOverlay } from "../ui/NametagOverlay";
import { UIShell } from "../ui/UIShell";
import { BlockRegistry } from "../world/blocks/BlockRegistry";
import { RecipeRegistry } from "../world/RecipeRegistry";
import { WorldTime } from "../world/lighting/WorldTime";
import { BlockInteractions } from "../world/BlockInteractions";
import { World } from "../world/World";
import { MsgType } from "../network/protocol/messages";
import type { HeldTorchLighting } from "../renderer/lighting/LightingComposer";
import type { RecipeDefinition } from "./recipe";
import { isNearCraftingTableBlock } from "../world/craftingProximity";

const PEERJS_CLOUD = {
  host: "0.peerjs.com",
  port: 443,
  path: "/",
  secure: true,
} as const;

const WORLD_TIME_BROADCAST_INTERVAL_MS = 5_000;

const HOST_DISABLED_MULTIPLAYER_REASON =
  "The host closed the room. Return to the main menu to continue.";

/** Host flow from main menu: auto-start multiplayer after world load. */
export type MultiplayerHostFromMenuSpec = {
  roomTitle: string;
  motd: string;
  isPrivate: boolean;
  roomPassword?: string;
};

export type GameOptions = {
  mount: HTMLElement;
  seed: number;
  worldUuid: string;
  store: IndexedDBStore;
  worldName: string;
  multiplayerJoinRoomCode?: string;
  /** When joining a private room from the directory. */
  multiplayerJoinPassword?: string;
  /** Signed-in host: start as room host immediately after load. */
  multiplayerHostFromMenu?: MultiplayerHostFromMenuSpec;
  /** Optional initial world time; defaults to start-of-dawn when omitted. */
  initialWorldTimeMs?: number;
  /** Optional Supabase room relay for authenticated hosts. */
  signalRelay?: SupabaseSignalAdapter | null;
  /** Shown in chat and nametags; defaults to Player. */
  displayName?: string;
  /** Supabase `auth.users` id when signed in; guests omit. */
  accountId?: string | null;
};

export type PlayerSavedState = {
  x: number;
  y: number;
  hotbarSlot: number;
  inventory?: ({ key: string; count: number } | null)[];
};

export type GameLoadProgress = {
  stage: string;
  detail?: string;
  current?: number;
  total?: number;
};

export class Game {
  readonly bus: EventBus;
  private readonly loop: GameLoop;
  private readonly mount: HTMLElement;
  private _worldSeed: number;
  private readonly worldUuid: string;
  private readonly store: IndexedDBStore;
  private readonly worldName: string;
  private readonly multiplayerJoinRoomCode?: string;
  private readonly multiplayerJoinPassword?: string;
  private readonly multiplayerHostFromMenu?: MultiplayerHostFromMenuSpec;
  private readonly _signalRelay: SupabaseSignalAdapter | null;
  private readonly adapter: PeerJSAdapter;
  private readonly _chunkSync: ChunkSyncManager;
  private readonly _playerStateBroadcaster: PlayerStateBroadcaster;
  private readonly networkUnsubs: (() => void)[] = [];

  private readonly _displayName: string;
  private readonly _accountId: string | null;
  private readonly _moderation = new WorldModerationState();
  private readonly _sessionRoster = new Map<
    string,
    { displayName: string; accountId: string }
  >();
  private readonly _mutedPeerIds = new Set<string>();
  private readonly _opPeerIds = new Set<string>();
  private _chatHost: ChatHostController | null = null;
  private _chatOverlay: ChatOverlay | null = null;
  private _nametagOverlay: NametagOverlay | null = null;
  private _chatOpen = false;
  /** After init, announce joins/leaves in chat (avoids noise from roster replay). */
  private _chatRoomAnnounceEnabled = false;
  private _pingPendingAt: number | null = null;
  private _modPersistTimer: ReturnType<typeof setTimeout> | null = null;
  /** CHUNK_DATA received before `World` exists (multiplayer join); flushed after `world.init`. */
  private readonly _pendingAuthoritativeChunks: Array<{
    cx: number;
    cy: number;
    blocks: Uint16Array;
    background?: Uint16Array;
  }> = [];

  private pipeline: RenderPipeline | null = null;
  private blockAtlasLoader: AtlasLoader | null = null;
  private itemAtlasLoader: AtlasLoader | null = null;
  private world: World | null = null;
  private chunkRenderer: ChunkRenderer | null = null;
  private input: InputManager | null = null;
  private entityManager: EntityManager | null = null;
  private uiShell: UIShell | null = null;
  private breakOverlay: BreakOverlay | null = null;
  private saveGame: SaveGame | null = null;
  private _blockInteractions: BlockInteractions | null = null;
  private audio: AudioEngine | null = null;
  private inventoryUI: InventoryUI | null = null;
  private _craftingPanel: CraftingPanel | null = null;
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
  /** Every 2nd fixed tick (~30 Hz) sample and send `PLAYER_STATE` when changed. */
  private _playerStateBroadcastPhase = 0;
  private readonly _worldTime: WorldTime;

  private _roomRelayHeartbeat: ReturnType<typeof setInterval> | null = null;

  private readonly _heldTorchScratch: HeldTorchLighting = {
    worldBlock: [0, 0],
    radiusBlocks: TORCH_HELD_LIGHT_RADIUS_BLOCKS,
    intensity: TORCH_HELD_LIGHT_INTENSITY,
    color: [1.0, 0.85, 0.55],
  };

  /** Reused by {@link PlayerStateBroadcaster} state callback (avoids object literal per broadcast tick). */
  private readonly _playerStateSnap = {
    playerId: 0,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    facingRight: false,
  };

  private readonly _recipeRegistry = new RecipeRegistry();
  private _craftingSystem: CraftingSystem | null = null;

  constructor(options: GameOptions) {
    this.mount = options.mount;
    this._worldSeed = options.seed;
    this.worldUuid = options.worldUuid;
    this.store = options.store;
    this.worldName = options.worldName;
    this.multiplayerJoinRoomCode = options.multiplayerJoinRoomCode;
    this.multiplayerJoinPassword = options.multiplayerJoinPassword;
    this.multiplayerHostFromMenu = options.multiplayerHostFromMenu;
    this._signalRelay = options.signalRelay ?? null;
    const dn = options.displayName?.trim();
    this._displayName = dn !== undefined && dn !== "" ? dn : "Player";
    this._accountId = options.accountId ?? null;
    this.bus = new EventBus();
    const initialTimeMs =
      options.initialWorldTimeMs ?? DAY_LENGTH_MS * 0.15;
    this._worldTime = new WorldTime(initialTimeMs);
    this.adapter = new PeerJSAdapter(this.bus);
    this.adapter.setHandshakeProfile(this._displayName, this._accountId);
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
        ? "Joining room..."
        : "Preparing local world session...",
    });
    await this._initEntryNetworking();

    const metaLoaded = await this.store.loadWorld(this.worldUuid);
    this._moderation.loadFromPersisted(
      migrateModerationMetadata(metaLoaded?.moderation),
    );

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
      total: STRATUM_CORE_BLOCK_FILES.length,
    });
    await this.loadStratumCoreBlocks(registry, (loaded, total, file) => {
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
    progressCallback?.({
      stage: "Loading items",
      detail: "Reading core item definitions...",
      current: 0,
      total: STRATUM_CORE_ITEM_FILES.length,
    });
    await this.loadStratumCoreItems(
      registry,
      itemRegistry,
      (loaded, total, file) => {
        progressCallback?.({
          stage: "Loading items",
          detail: `Loaded ${file}`,
          current: loaded,
          total,
        });
      },
    );

    progressCallback?.({
      stage: "Loading recipes",
      detail: "Reading base recipe definitions...",
    });
    await this.loadStratumBaseRecipes(itemRegistry);
    this._craftingSystem = new CraftingSystem(itemRegistry, this._recipeRegistry);

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

    progressCallback?.({
      stage: "Loading textures",
      detail: "Loading block textures...",
    });
    const blockAtlas = new AtlasLoader(BLOCK_TEXTURE_MANIFEST_PATH);
    await blockAtlas.load();
    this.blockAtlasLoader = blockAtlas;

    progressCallback?.({
      stage: "Loading textures",
      detail: "Loading item textures...",
    });
    const [blockTexDoc, itemTexDoc] = await Promise.all([
      fetchTextureManifestJson(BLOCK_TEXTURE_MANIFEST_PATH),
      fetchTextureManifestJson(ITEM_TEXTURE_MANIFEST_PATH),
    ]);
    const itemResolved = resolveItemTextureRecord(
      itemRegistry,
      blockTexDoc.textures,
      itemTexDoc.textures,
    );
    const itemAtlas = new AtlasLoader(ITEM_TEXTURE_MANIFEST_PATH);
    await itemAtlas.loadFromTextureRecord(itemResolved);
    this.itemAtlasLoader = itemAtlas;

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

    const initCentreBx = playerSavedState !== undefined
      ? Math.floor(playerSavedState.x / BLOCK_SIZE)
      : undefined;
    const initCentreBy = playerSavedState !== undefined
      ? Math.floor(playerSavedState.y / BLOCK_SIZE)
      : undefined;
    progressCallback?.({
      stage: "Preparing world",
      detail: "Loading nearby chunks...",
      current: 0,
      total: 1,
    });
    await world.init(
      (chunkProgress) => {
        progressCallback?.({
          stage: "Preparing world",
          detail:
            chunkProgress.source === "db"
              ? "Loading saved terrain chunks..."
              : "Generating terrain chunks...",
          current: chunkProgress.loaded,
          total: chunkProgress.total,
        });
      },
      initCentreBx,
      initCentreBy,
    );
    for (const [cx, cy] of world.loadedChunkCoords()) {
      world.recomputeChunkLight(cx, cy);
    }
    this._flushPendingAuthoritativeChunks();

    this._blockInteractions = new BlockInteractions(world, registry, this.bus);

    this.chunkRenderer = new ChunkRenderer(pipeline, registry, blockAtlas, world);

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
      itemAtlas,
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
      () =>
        this._shouldPersistModeration()
          ? this._moderation.toPersisted()
          : undefined,
    );
    progressCallback?.({
      stage: "Finalizing",
      detail: "Preparing save data and UI...",
    });
    await saveGame.init();
    saveGame.startAutoSave(60_000);
    this.saveGame = saveGame;

    this.uiShell = new UIShell(this.bus, this.mount, saveGame, audio);

    const chatOverlay = new ChatOverlay();
    chatOverlay.init(this.mount, this.bus);
    chatOverlay.setLocalDisplayName(this._displayName);
    this._chatOverlay = chatOverlay;
    for (const [peerId, entry] of this._sessionRoster) {
      this.bus.emit({
        type: "net:session-player",
        peerId,
        displayName: entry.displayName,
        accountId: entry.accountId,
      } satisfies GameEvent);
    }

    const nametagOverlay = new NametagOverlay();
    nametagOverlay.init(this.mount);
    this._nametagOverlay = nametagOverlay;

    this.networkUnsubs.push(
      this.bus.on("game:chat-submit", (e) => {
        this._onChatSubmit(e.text);
      }),
    );
    this.networkUnsubs.push(
      this.bus.on("game:chat-closed", () => {
        this._onChatClosed();
      }),
    );

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
    await inventoryUI.loadTextureIcons();
    this.inventoryUI = inventoryUI;

    this._craftingPanel = new CraftingPanel(
      inventoryUI.getCraftingMount(),
      this.bus,
      itemRegistry,
      {
        getItemIconUrlLookup: () =>
          this.inventoryUI?.getItemIconUrlLookup() ?? null,
        getRecipes: () => this._visibleRecipesForCrafting(),
        getCategories: () => this._visibleCraftingCategories(),
        getNearCraftingTable: () => this._getCraftingStationContext().nearCraftingTable,
        canCraftOneBatch: (recipe, inv) =>
          this._craftingSystem?.canCraft(recipe, inv, 1, this._getCraftingStationContext()) ??
          false,
        maxCraftableBatches: (recipe, inv) =>
          this._craftingSystem?.maxCraftableBatches(
            recipe,
            inv,
            this._getCraftingStationContext(),
          ) ?? 0,
        getInventory: () => this.entityManager!.getPlayer().inventory,
      },
    );

    this.networkUnsubs.push(
      this.bus.on("ui:chat-compose", (e) => {
        this.inventoryUI?.setHotbarStackVisible(!e.open);
      }),
    );

    this.cursorStackUI = new CursorStackUI(
      this.mount,
      itemRegistry,
      () => this.entityManager!.getPlayer().inventory.getCursorStack(),
      () => this.inventoryUI!.getItemIconUrlLookup(),
    );

    this.networkUnsubs.push(
      this.bus.on("craft:request", (e) => {
        this._handleCraftRequest(e.recipeId, e.batches);
      }),
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
        playerSavedState.inventory,
      );
    } else {
      const airId = world.getRegistry().getByIdentifier("stratum:air").id;
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

    const spawnBx = Math.floor(player.state.position.x / BLOCK_SIZE);
    const spawnBy = Math.floor(player.state.position.y / BLOCK_SIZE);
    world.resetStreamCentre(spawnBx, spawnBy);

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
    await this._maybeAutoHostFromMenu();
    this._chatRoomAnnounceEnabled = true;
  }

  private _defaultRoomListingMeta(): RoomPublishMeta {
    return {
      roomTitle: "Room",
      motd: "",
      worldName: this.worldName,
      isPrivate: false,
    };
  }

  private _stopRoomRelayHeartbeat(): void {
    if (this._roomRelayHeartbeat !== null) {
      clearInterval(this._roomRelayHeartbeat);
      this._roomRelayHeartbeat = null;
    }
  }

  private _startRoomRelayHeartbeat(roomCode: RoomCode): void {
    this._stopRoomRelayHeartbeat();
    if (this._signalRelay === null) {
      return;
    }
    const relay = this._signalRelay;
    this._roomRelayHeartbeat = setInterval(() => {
      void relay.touchRoomSession(roomCode);
    }, 60_000);
  }

  private async _maybeAutoHostFromMenu(): Promise<void> {
    const spec = this.multiplayerHostFromMenu;
    if (spec === undefined) {
      return;
    }
    if (this._accountId === null || this._signalRelay === null) {
      return;
    }
    const state = this.adapter.state;
    if (state.status === "connected") {
      return;
    }
    try {
      const hostPeerId = await this.adapter.host(PEERJS_CLOUD);
      this._registerHostMultiplayerSetup();
      this._emitNetworkRoleForUi();
      const roomCode = peerIdToRoomCode(hostPeerId);
      if (roomCode !== null) {
        const listed = await this._signalRelay.publishRoom(roomCode, hostPeerId, {
          roomTitle: spec.roomTitle,
          motd: spec.motd,
          worldName: this.worldName,
          isPrivate: spec.isPrivate,
          passwordPlain: spec.isPrivate ? spec.roomPassword : undefined,
        });
        if (!listed) {
          this.bus.emit({
            type: "net:error",
            message:
              "Your room is open for friends with a code, but it was not added to the online list. Sign in on Profile, check the browser console, and ensure the latest supabase/schema.sql is applied in your project.",
          } satisfies GameEvent);
        }
        this._startRoomRelayHeartbeat(roomCode);
        this.bus.emit({ type: "net:room-code", roomCode } satisfies GameEvent);
      }
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Failed to start hosting";
      this.bus.emit({ type: "net:error", message } satisfies GameEvent);
    }
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
    this._stopRoomRelayHeartbeat();
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
    if (this._modPersistTimer !== null) {
      clearTimeout(this._modPersistTimer);
      this._modPersistTimer = null;
    }
    this.adapter.setClientAdmissionGate(null);
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
    this._craftingPanel?.destroy();
    this._craftingPanel = null;
    this.inventoryUI?.destroy();
    this.inventoryUI = null;
    this._craftingSystem = null;
    this.isInventoryOpen = false;
    this.paused = false;
    this._chatOverlay?.destroy();
    this._chatOverlay = null;
    this._nametagOverlay?.destroy();
    this._nametagOverlay = null;
    this._chatHost = null;
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
    this.blockAtlasLoader?.destroy();
    this.blockAtlasLoader = null;
    this.itemAtlasLoader?.destroy();
    this.itemAtlasLoader = null;
    this._blockInteractions = null;
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
      const fromRelay = await this._signalRelay.lookupHostPeerId(
        normalized,
        this.multiplayerJoinPassword,
      );
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
        const stNet = this.adapter.state;

        if (msg.type === MsgType.PING) {
          if (stNet.status === "connected" && stNet.role === "host") {
            this.adapter.send(e.peerId as PeerId, msg);
          } else if (stNet.status === "connected" && stNet.role === "client") {
            if (this._pingPendingAt !== null) {
              const rtt = performance.now() - this._pingPendingAt;
              this._pingPendingAt = null;
              this.bus.emit({
                type: "ui:chat-line",
                kind: "system",
                text: `Ping: ${rtt.toFixed(0)} ms`,
              } satisfies GameEvent);
            }
          }
          return;
        }

        if (msg.type === MsgType.SYSTEM_MESSAGE) {
          this.bus.emit({
            type: "ui:chat-line",
            kind: "system",
            text: msg.text,
          } satisfies GameEvent);
          return;
        }

        if (msg.type === MsgType.CHAT) {
          if (stNet.status === "connected" && stNet.role === "host") {
            this._ensureChatHost();
            this._chatHost?.handleInboundLine(e.peerId, msg.text);
          } else if (stNet.status === "connected" && stNet.role === "client") {
            const r = this._sessionRoster.get(msg.fromPeerId);
            const label = r?.displayName ?? msg.fromPeerId;
            this.bus.emit({
              type: "ui:chat-line",
              kind: "player",
              text: msg.text,
              senderLabel: label,
            } satisfies GameEvent);
          }
          return;
        }

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
        if (msg.type === MsgType.PLAYER_STATE_RELAY && this.world !== null) {
          if (stNet.status === "connected" && stNet.role === "client") {
            this.world.updateRemotePlayer(
              msg.subjectPeerId,
              msg.x,
              msg.y,
              msg.vx,
              msg.vy,
              msg.facingRight,
            );
          }
          return;
        }
        if (msg.type === MsgType.PLAYER_STATE && this.world !== null) {
          this.world.updateRemotePlayer(
            e.peerId,
            msg.x,
            msg.y,
            msg.vx,
            msg.vy,
            msg.facingRight,
          );
          if (stNet.status === "connected" && stNet.role === "host") {
            const localId = this.adapter.getLocalPeerId();
            if (localId !== null && e.peerId !== localId) {
              this.adapter.broadcastExcept(e.peerId as PeerId, {
                type: MsgType.PLAYER_STATE_RELAY,
                subjectPeerId: e.peerId,
                x: msg.x,
                y: msg.y,
                vx: msg.vx,
                vy: msg.vy,
                facingRight: msg.facingRight,
              });
            }
          }
          return;
        }
      }),
    );
    this.networkUnsubs.push(
      this.bus.on("net:session-player", (e) => {
        this._sessionRoster.set(e.peerId, {
          displayName: e.displayName,
          accountId: e.accountId,
        });
        const st = this.adapter.state;
        if (st.status === "connected" && st.role === "host") {
          if (this._moderation.isMuted(e.displayName, e.accountId)) {
            this._mutedPeerIds.add(e.peerId);
          }
          if (this._moderation.isOp(e.displayName, e.accountId)) {
            this._opPeerIds.add(e.peerId);
          }
          const localId = this.adapter.getLocalPeerId();
          if (
            this._chatRoomAnnounceEnabled &&
            localId !== null &&
            e.peerId !== localId
          ) {
            const line = `${e.displayName} joined the room.`;
            this.bus.emit({
              type: "ui:chat-line",
              kind: "system",
              text: line,
            } satisfies GameEvent);
            this.adapter.broadcast({
              type: MsgType.SYSTEM_MESSAGE,
              text: line,
            });
          }
        }
      }),
    );
    this.networkUnsubs.push(
      this.bus.on("net:peer-left", (e) => {
        const left = this._sessionRoster.get(e.peerId);
        const st = this.adapter.state;
        if (
          left !== undefined &&
          this._chatRoomAnnounceEnabled &&
          st.status === "connected" &&
          st.role === "host"
        ) {
          const line = `${left.displayName} left the room.`;
          this.bus.emit({
            type: "ui:chat-line",
            kind: "system",
            text: line,
          } satisfies GameEvent);
          this.adapter.broadcast({
            type: MsgType.SYSTEM_MESSAGE,
            text: line,
          });
        }
        this.world?.removeRemotePlayer(e.peerId);
        this._sessionRoster.delete(e.peerId);
        this._mutedPeerIds.delete(e.peerId);
        this._opPeerIds.delete(e.peerId);
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
          const newPeer = e.peerId as PeerId;
          if (world !== null) {
            this._chunkSync.sendAllChunksTo(newPeer, (fn) => {
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
          this._playerStateBroadcaster.invalidateSnapshot();
          const localId = this.adapter.getLocalPeerId();
          const em = this.entityManager;
          if (world !== null && em !== null && localId !== null) {
            const st = em.getPlayer().state;
            this.adapter.send(newPeer, {
              type: MsgType.PLAYER_STATE,
              playerId: 0,
              x: st.position.x,
              y: st.position.y,
              vx: st.velocity.x,
              vy: st.velocity.y,
              facingRight: st.facingRight,
            });
            for (const [pid, rp] of world.getRemotePlayers()) {
              if (pid === newPeer) {
                continue;
              }
              const snap = rp.getNetworkSample();
              this.adapter.send(newPeer, {
                type: MsgType.PLAYER_STATE_RELAY,
                subjectPeerId: pid,
                ...snap,
              });
            }
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
                  this._stopRoomRelayHeartbeat();
                  void this._signalRelay.clearRoom(rc);
                }
              }
            }
            this.adapter.disconnect();
            this.world?.clearRemotePlayers();
            this._sessionRoster.clear();
            this._mutedPeerIds.clear();
            this._opPeerIds.clear();
            this._chatHost = null;
            this.adapter.setClientAdmissionGate(null);
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
          .then(async (hostPeerId) => {
            this._registerHostMultiplayerSetup();
            this._emitNetworkRoleForUi();
            const roomCode = peerIdToRoomCode(hostPeerId);
            if (roomCode !== null) {
              if (this._signalRelay !== null) {
                const listed = await this._signalRelay.publishRoom(
                  roomCode,
                  hostPeerId,
                  this._defaultRoomListingMeta(),
                );
                if (!listed) {
                  this.bus.emit({
                    type: "net:error",
                    message:
                      "Room is live with a code, but the online list did not update. Sign in on Profile and confirm supabase/schema.sql (including upsert_stratum_room_session) is deployed.",
                  } satisfies GameEvent);
                }
                this._startRoomRelayHeartbeat(roomCode);
              }
              this.bus.emit({ type: "net:room-code", roomCode } satisfies GameEvent);
            }
          })
          .catch((err: unknown) => {
            const message =
              err instanceof Error ? err.message : "Failed to open room";
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

  private _registerHostMultiplayerSetup(): void {
    const localId = this.adapter.getLocalPeerId();
    if (localId !== null) {
      this._sessionRoster.set(localId, {
        displayName: this._displayName,
        accountId: this._accountId ?? "",
      });
    }
    this.adapter.setClientAdmissionGate((peerId, displayName, accountId) => {
      void peerId;
      return !this._moderation.isBanned(displayName, accountId);
    });
  }

  private _shouldPersistModeration(): boolean {
    const st = this.adapter.state;
    return st.status !== "connected" || st.role !== "client";
  }

  private _ensureChatHost(): void {
    if (this._chatHost !== null) {
      return;
    }
    const st = this.adapter.state;
    if (st.status !== "connected" || st.role !== "host") {
      return;
    }
    this._chatHost = new ChatHostController({
      adapter: this.adapter,
      moderation: this._moderation,
      roster: this._sessionRoster,
      mutedPeerIds: this._mutedPeerIds,
      opPeerIds: this._opPeerIds,
      getLocalPeerId: () => this.adapter.getLocalPeerId(),
      getLocalDisplayName: () => this._displayName,
      schedulePersistModeration: () => this._schedulePersistModeration(),
      emitHostChatLine: (senderLabel, text) => {
        this.bus.emit({
          type: "ui:chat-line",
          kind: "player",
          text,
          senderLabel,
        } satisfies GameEvent);
      },
      emitHostSystemLine: (text) => {
        this.bus.emit({
          type: "ui:chat-line",
          kind: "system",
          text,
        } satisfies GameEvent);
      },
      sendSystemTo: (peerId, text) => {
        this._sendSystemToPeer(peerId, text);
      },
    });
  }

  private _sendSystemToPeer(peerId: PeerId, text: string): void {
    const local = this.adapter.getLocalPeerId();
    if (local !== null && peerId === local) {
      this.bus.emit({
        type: "ui:chat-line",
        kind: "system",
        text,
      } satisfies GameEvent);
      return;
    }
    this.adapter.send(peerId, {
      type: MsgType.SYSTEM_MESSAGE,
      text,
    });
  }

  private _schedulePersistModeration(): void {
    if (!this._shouldPersistModeration()) {
      return;
    }
    if (this._modPersistTimer !== null) {
      clearTimeout(this._modPersistTimer);
    }
    this._modPersistTimer = setTimeout(() => {
      this._modPersistTimer = null;
      void this._persistModerationNow();
    }, 420);
  }

  private async _persistModerationNow(): Promise<void> {
    if (!this._shouldPersistModeration()) {
      return;
    }
    const now = Date.now();
    const mod = this._moderation.toPersisted();
    const em = this.entityManager;
    const w = this.world;
    try {
      await this.store.patchWorldMetadata(this.worldUuid, (prev) => {
        if (prev === undefined) {
          const row: WorldMetadata = {
            uuid: this.worldUuid,
            name: this.worldName,
            seed: this._worldSeed,
            createdAt: now,
            lastPlayedAt: now,
            playerX: em?.getPlayer().state.position.x ?? 0,
            playerY: em?.getPlayer().state.position.y ?? 0,
            hotbarSlot: em?.getPlayer().state.hotbarSlot ?? 0,
            modList: w?.getRegistry().getModList() ?? [],
            worldTimeMs: this._worldTime.ms,
            moderation: mod,
          };
          return row;
        }
        return { ...prev, moderation: mod, lastPlayedAt: now };
      });
    } catch (err) {
      console.error(err);
    }
  }

  private _onChatSubmit(text: string): void {
    const trimmed = text.trim();
    const st = this.adapter.state;
    if (trimmed === "/ping") {
      if (st.status === "connected" && st.role === "client") {
        this._pingPendingAt = performance.now();
        this.adapter.broadcast({
          type: MsgType.PING,
          timestamp: this._pingPendingAt,
        });
      } else if (st.status === "connected" && st.role === "host") {
        this.bus.emit({
          type: "ui:chat-line",
          kind: "system",
          text: "0 ms (you are the host)",
        } satisfies GameEvent);
      } else {
        this.bus.emit({
          type: "ui:chat-line",
          kind: "system",
          text: "Not connected to a room.",
        } satisfies GameEvent);
      }
      return;
    }
    if (st.status !== "connected") {
      this.bus.emit({
        type: "ui:chat-line",
        kind: "system",
        text: "Not connected to a room.",
      } satisfies GameEvent);
      return;
    }
    const localId = this.adapter.getLocalPeerId();
    if (localId === null) {
      return;
    }
    if (st.role === "host") {
      this._ensureChatHost();
      this._chatHost?.handleInboundLine(localId, trimmed);
      return;
    }
    this.adapter.broadcast({
      type: MsgType.CHAT,
      fromPeerId: localId,
      text: trimmed,
    });
  }

  private _onChatClosed(): void {
    this._chatOpen = false;
    this.input?.setChatOpen(false);
    this.input?.setWorldInputBlocked(this.paused || this.isInventoryOpen);
  }

  /** Crafting recipes loaded after {@link ItemRegistry} is populated (item keys validated). */
  get recipeRegistry(): RecipeRegistry {
    return this._recipeRegistry;
  }

  /** Non-null after base recipes load in {@link Game.initWorld}. */
  get craftingSystem(): CraftingSystem | null {
    return this._craftingSystem;
  }

  private _applyInventoryPanelsOpen(open: boolean): void {
    this.inventoryUI?.setOpen(open);
    this._craftingPanel?.setOpen(open);
  }

  private _getCraftingStationContext(): CraftingStationContext {
    const w = this.world;
    const em = this.entityManager;
    if (w === null || em === null) {
      return { nearCraftingTable: false };
    }
    const reg = w.getRegistry();
    if (!reg.isRegistered("stratum:crafting_table")) {
      return { nearCraftingTable: false };
    }
    const tableId = reg.getByIdentifier("stratum:crafting_table").id;
    const feet = em.getPlayer().state.position;
    return {
      nearCraftingTable: isNearCraftingTableBlock(
        w,
        tableId,
        feet,
        CRAFTING_TABLE_ACCESS_RADIUS_BLOCKS,
      ),
    };
  }

  /** Recipes shown in the crafting UI (station-gated by proximity to a crafting table). */
  private _visibleRecipesForCrafting(): readonly RecipeDefinition[] {
    const near = this._getCraftingStationContext().nearCraftingTable;
    return this._recipeRegistry.all().filter(
      (r) =>
        r.station === null ||
        (r.station === RECIPE_STATION_CRAFTING_TABLE && near),
    );
  }

  private _visibleCraftingCategories(): readonly string[] {
    const set = new Set<string>();
    for (const r of this._visibleRecipesForCrafting()) {
      set.add(r.category);
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  }

  private _handleCraftRequest(recipeId: string, batches: number): void {
    const net = this.adapter.state;
    if (net.status === "connected" && net.role === "client") {
      this.bus.emit({
        type: "craft:result",
        ok: false,
        reason: "Crafting as a client will be enabled with host confirmation.",
      } satisfies GameEvent);
      return;
    }

    const crafting = this._craftingSystem;
    const em = this.entityManager;
    if (crafting === null || em === null) {
      this.bus.emit({
        type: "craft:result",
        ok: false,
        reason: "Game is not ready.",
      } satisfies GameEvent);
      return;
    }

    const recipe = crafting.getRecipeById(recipeId);
    if (recipe === undefined) {
      this.bus.emit({
        type: "craft:result",
        ok: false,
        reason: "Unknown recipe.",
      } satisfies GameEvent);
      return;
    }

    const inv = em.getPlayer().inventory;
    const result = crafting.craft(recipe, inv, batches, this._getCraftingStationContext());
    if (result.ok) {
      this.bus.emit({
        type: "craft:result",
        ok: true,
        crafted: result.crafted,
      } satisfies GameEvent);
    } else {
      this.bus.emit({
        type: "craft:result",
        ok: false,
        reason: result.reason,
      } satisfies GameEvent);
    }
  }

  private async loadStratumBaseRecipes(itemRegistry: ItemRegistry): Promise<void> {
    const base = import.meta.env.BASE_URL;
    const url = `${base}assets/mods/base/recipes.json`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Failed to load ${url}: ${res.status} ${res.statusText}`);
    }
    const raw: unknown = await res.json();
    const recipes = parseRecipeJson(raw);
    for (const recipe of recipes) {
      if (recipe.output.itemId !== undefined && itemRegistry.getByKey(recipe.output.itemId) === undefined) {
        throw new Error(
          `Recipe '${recipe.id}' references unknown output item '${recipe.output.itemId}' (load recipes after items are registered).`,
        );
      }
      for (const ing of recipe.ingredients) {
        if (ing.itemId !== undefined && itemRegistry.getByKey(ing.itemId) === undefined) {
          throw new Error(
            `Recipe '${recipe.id}' references unknown item key '${ing.itemId}' (load recipes after items are registered).`,
          );
        }
        if (ing.tag !== undefined && itemRegistry.getByTag(ing.tag).length === 0) {
          throw new Error(
            `Recipe '${recipe.id}' references tag '${ing.tag}' with no matching items.`,
          );
        }
      }
    }
    this._recipeRegistry.registerAll(recipes);
  }

  private async loadStratumCoreBlocks(
    registry: BlockRegistry,
    progressCallback?: (loaded: number, total: number, file: string) => void,
  ): Promise<void> {
    const base = import.meta.env.BASE_URL;
    const total = STRATUM_CORE_BLOCK_FILES.length;
    let loaded = 0;
    for (const file of STRATUM_CORE_BLOCK_FILES) {
      const url = `${base}assets/mods/stratum-core/blocks/${file}`;
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

  /** Loads `assets/mods/stratum-core/items/*.json` and registers items. */
  private async loadStratumCoreItems(
    registry: BlockRegistry,
    itemRegistry: ItemRegistry,
    progressCallback?: (loaded: number, total: number, file: string) => void,
  ): Promise<void> {
    const base = import.meta.env.BASE_URL;
    const total = STRATUM_CORE_ITEM_FILES.length;
    let loaded = 0;
    for (const file of STRATUM_CORE_ITEM_FILES) {
      const url = `${base}assets/mods/stratum-core/items/${file}`;
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`Failed to load ${url}: ${res.status} ${res.statusText}`);
      }
      const raw: unknown = await res.json();
      const def = parseItemJson(raw);
      let placesBlockId: number | undefined;
      if (def.placesBlockIdentifier !== undefined) {
        const b = registry.getByIdentifier(def.placesBlockIdentifier);
        if (b === undefined) {
          throw new Error(
            `Item ${def.identifier}: unknown places_block "${def.placesBlockIdentifier}"`,
          );
        }
        placesBlockId = b.id;
      }
      itemRegistry.register({
        key: def.identifier,
        textureName: def.textureKey,
        displayName: def.displayName,
        maxStack: def.maxStack,
        placesBlockId,
        toolType: def.toolType,
        toolTier: def.toolTier,
        toolSpeed: def.toolSpeed,
      });
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
        if (this._chatOpen) {
          this.bus.emit({ type: "ui:chat-set-open", open: false } satisfies GameEvent);
        } else if (this.isInventoryOpen) {
          this.isInventoryOpen = false;
          this._applyInventoryPanelsOpen(false);
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

      if (input.isJustPressed("chat") && !this._chatOpen) {
        this._chatOpen = true;
        input.setWorldInputBlocked(true);
        input.setChatOpen(true);
        this.bus.emit({ type: "ui:chat-set-open", open: true } satisfies GameEvent);
      }

      if (input.isJustPressed("inventory")) {
        this.isInventoryOpen = !this.isInventoryOpen;
        input.setWorldInputBlocked(this.isInventoryOpen);
        this._applyInventoryPanelsOpen(this.isInventoryOpen);
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
      this._playerStateBroadcastPhase += 1;
      if (this._playerStateBroadcastPhase >= 2) {
        this._playerStateBroadcastPhase = 0;
        this._playerStateBroadcaster.tick();
      }
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

      if (this._blockInteractions !== null && role !== "client") {
        const pbx = Math.floor(pl.x / BLOCK_SIZE);
        const pby = Math.floor(pl.y / BLOCK_SIZE);
        this._blockInteractions.tick(dtSec, pbx, pby);
      }

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

    if (
      this._nametagOverlay !== null &&
      this.pipeline !== null &&
      this.entityManager !== null &&
      this.world !== null
    ) {
      const s = this.entityManager.getPlayer().state;
      this._nametagOverlay.update(
        this.mount,
        this.pipeline.getCanvas(),
        this.pipeline.getCamera(),
        alpha,
        {
          prevX: s.prevPosition.x,
          prevY: s.prevPosition.y,
          x: s.position.x,
          y: s.position.y,
          displayName: this._displayName,
        },
        this.world.getRemotePlayers(),
        this._sessionRoster,
        this.adapter.getLocalPeerId(),
      );
    }

    if (this.entityManager !== null && this.inventoryUI !== null) {
      const pl = this.entityManager.getPlayer();
      this.inventoryUI.update(pl.inventory, pl.state.hotbarSlot);
      this._craftingPanel?.update(pl.inventory);
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
          .getByIdentifier("stratum:torch").id;
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
