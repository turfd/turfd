/**
 * Top-level coordinator: event bus, fixed game loop, persistence, rendering, and networking.
 */
import { AudioEngine } from "../audio/AudioEngine";
import { readVolumeStored, VOL_KEYS } from "../audio/volumeSettings";
import {
  BACKGROUND_RESIZE_DEBOUNCE_MS,
  BLOCK_SIZE,
  CAMERA_PLAYER_VERTICAL_OFFSET_PX,
  CHEST_ACCESS_RADIUS_BLOCKS,
  CRAFTING_TABLE_ACCESS_RADIUS_BLOCKS,
  FURNACE_ACCESS_RADIUS_BLOCKS,
  DAY_LENGTH_MS,
  FIXED_TIMESTEP_MS,
  FIXED_TIMESTEP_SEC,
  PLAYER_HEIGHT,
  PLAYER_WIDTH,
  RECIPE_STATION_CRAFTING_TABLE,
  RECIPE_STATION_FURNACE,
  TORCH_HELD_LIGHT_INTENSITY,
  TORCH_HELD_LIGHT_RADIUS_BLOCKS,
  VIEW_DISTANCE_CHUNKS,
  WORLD_Y_MAX,
} from "./constants";
import { EventBus } from "./EventBus";
import { GameLoop } from "./GameLoop";
import type { GameEvent } from "./types";
import {
  CraftingSystem,
  type CraftingStationContext,
  type RecipeIngredientAvailability,
} from "../entities/CraftingSystem";
import { EntityManager } from "../entities/EntityManager";
import type { PlayerState } from "../entities/Player";
import { InputManager } from "../input/InputManager";
import { ItemRegistry, registerBlockItems } from "../items/ItemRegistry";
import { LootResolver } from "../items/LootResolver";
import type { IModRepository } from "../mods/IModRepository";
import { STRATUM_CORE_BEHAVIOR_PACK_PATH } from "../mods/internalPackManifest";
import {
  fetchBehaviorPackManifest,
  loadBehaviorPackBlocks,
  loadBehaviorPackItems,
  loadBehaviorPackLoot,
  loadBehaviorPackRecipes,
  loadBehaviorPackSmelting,
} from "../mods/loadInternalBehaviorPack";
import {
  applyWorkshopTexturesToBlockAtlas,
  collectWorkshopCachedMods,
  loadWorkshopBlocksIntoRegistry,
  loadWorkshopItemsIntoRegistry,
  loadWorkshopLootIntoResolver,
  loadWorkshopRecipesIntoRegistry,
} from "../mods/loadWorkshopContent";
import type { CachedMod } from "../mods/workshopTypes";
import type { IndexedDBStore, WorldMetadata, WorkshopModRef } from "../persistence/IndexedDBStore";
import { SaveGame } from "../persistence/SaveGame";
import { resolveWorldWorkshopStacks } from "../persistence/worldWorkshopStacks";
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
import { BlockBreakParticles } from "../renderer/BlockBreakParticles";
import { LeafFallParticles } from "../renderer/LeafFallParticles";
import { BreakOverlay } from "../renderer/BreakOverlay";
import { ChunkRenderer } from "../renderer/chunk/ChunkRenderer";
import { RenderPipeline } from "../renderer/RenderPipeline";
import { ChatHostController } from "../network/ChatHostController";
import { parseGiveCommandRest, resolveGiveItemKey } from "../network/giveCommand";
import {
  migrateModerationMetadata,
  WorldModerationState,
} from "../network/moderation/WorldModerationState";
import { ChestPanel } from "../ui/ChestPanel";
import { CraftingPanel, type FurnaceUiChromeModel } from "../ui/CraftingPanel";
import { CursorStackUI } from "../ui/CursorStackUI";
import { ChatOverlay } from "../ui/ChatOverlay";
import { InventoryUI } from "../ui/InventoryUI";
import { playShiftSlotFlyAnimation } from "../ui/shiftSlotFlyAnimation";
import { NametagOverlay } from "../ui/NametagOverlay";
import { UIShell } from "../ui/UIShell";
import { BlockRegistry } from "../world/blocks/BlockRegistry";
import { RecipeRegistry } from "../world/RecipeRegistry";
import { WorldTime } from "../world/lighting/WorldTime";
import { BlockInteractions } from "../world/BlockInteractions";
import { World } from "../world/World";
import {
  applyFurnaceFuelSlotMouse,
  applyFurnaceOutputSlotMouse,
} from "../world/furnace/furnaceBufferSlotClick";
import {
  furnaceTileToPersisted,
  type FurnacePersistedChunk,
} from "../world/furnace/furnacePersisted";
import { chestTileToPersisted, type ChestPersistedChunk } from "../world/chest/chestPersisted";
import { quickMoveStackIntoChest } from "../world/chest/chestQuickMove";
import {
  applyChestSlotMouse,
  placeOneFromCursorIntoChestSlot,
} from "../world/chest/chestSlotClick";
import {
  tryEnqueueFurnaceSmelt,
  validateFurnaceEnqueue,
} from "../world/furnace/furnaceEnqueue";
import { createEmptyFurnaceTileState } from "../world/furnace/FurnaceTileState";
import { SmeltingRegistry } from "../world/SmeltingRegistry";
import { registerSmeltingRecipesInRegistry } from "../world/smeltingAsCraftingRecipes";
import { MsgType } from "../network/protocol/messages";
import type { HeldTorchLighting } from "../renderer/lighting/LightingComposer";
import type { ItemId } from "./itemDefinition";
import type { RecipeDefinition } from "./recipe";
import type { PlayerInventory } from "../items/PlayerInventory";
import { isNearBlockOfId, isNearCraftingTableBlock } from "../world/craftingProximity";

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
  /** Optional workshop cache + download; omitted when Supabase is not configured. */
  modRepository?: IModRepository | null;
};

export type PlayerSavedState = {
  x: number;
  y: number;
  hotbarSlot: number;
  inventory?: import("../items/PlayerInventory").SerializedInventorySlot[];
  /** Omitted in older saves; defaults to full health. */
  health?: number;
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
    furnaces?: FurnacePersistedChunk[];
    chests?: ChestPersistedChunk[];
    metadata?: Uint8Array;
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
  private blockBreakParticles: BlockBreakParticles | null = null;
  private leafFallParticles: LeafFallParticles | null = null;
  private saveGame: SaveGame | null = null;
  private _blockInteractions: BlockInteractions | null = null;
  private audio: AudioEngine | null = null;
  private inventoryUI: InventoryUI | null = null;
  private _craftingPanel: CraftingPanel | null = null;
  private _itemRegistry: ItemRegistry | null = null;
  private readonly _smeltingRegistry = new SmeltingRegistry();
  private readonly _furnaceNetSentAt = new Map<string, number>();
  private readonly _chestNetSentAt = new Map<string, number>();
  private _chestPanel: ChestPanel | null = null;
  /** Storage anchor while chest UI is active. */
  private _activeChestAnchor: { ax: number; ay: number } | null = null;
  private cursorStackUI: CursorStackUI | null = null;
  private isInventoryOpen = false;
  private paused = false;

  private lastRenderWallMs = 0;
  private started = false;
  private _windowResizeDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly scheduleWindowResizedEvent = (): void => {
    if (this._windowResizeDebounceTimer !== null) {
      clearTimeout(this._windowResizeDebounceTimer);
    }
    this._windowResizeDebounceTimer = setTimeout(() => {
      this._windowResizeDebounceTimer = null;
      this.bus.emit({ type: "window:resized" } satisfies GameEvent);
    }, BACKGROUND_RESIZE_DEBOUNCE_MS);
  };
  private fixedAsyncChain = Promise.resolve();
  private stopResolve: (() => void) | null = null;
  private quitUnsub: (() => void) | null = null;
  private keyBindingsUnsub: (() => void) | null = null;
  private _awaitingWorldData = false;
  /** Joining client: host-authored pack stacks (from PACK_STACK), applied during init. */
  private _joinHostBehaviorRefs: WorkshopModRef[] | null = null;
  private _joinHostResourceRefs: WorkshopModRef[] | null = null;
  private _worldTimeBroadcastAccum = 0;
  /** Every 2nd fixed tick (~30 Hz) sample and send `PLAYER_STATE` when changed. */
  private _playerStateBroadcastPhase = 0;
  /** Last mined crack sent on the wire (destroy-stage band); null after a clear packet. */
  private _lastBreakBroadcast: {
    wx: number;
    wy: number;
    layer: 0 | 1;
    crack: number;
  } | null = null;
  private readonly _worldTime: WorldTime;

  private _roomRelayHeartbeat: ReturnType<typeof setInterval> | null = null;

  /** Delist relay row when the document unloads (skipped for bfcache restores). */
  private readonly _pageHideClearListedRoom = (ev: PageTransitionEvent): void => {
    if (ev.persisted) {
      return;
    }
    this._stopRoomRelayHeartbeat();
    const relay = this._signalRelay;
    if (relay === null) {
      return;
    }
    const st = this.adapter.state;
    if (st.status !== "connected" || st.role !== "host") {
      return;
    }
    const hid = st.lanHostPeerId;
    if (hid === null) {
      return;
    }
    const rc = peerIdToRoomCode(hid);
    if (rc === null) {
      return;
    }
    void relay.clearRoom(rc);
  };

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

  private readonly _modRepository: IModRepository | null;

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
    this._modRepository = options.modRepository ?? null;
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
    const baseUrl = import.meta.env.BASE_URL;
    const stratumBehBase = `${baseUrl}${STRATUM_CORE_BEHAVIOR_PACK_PATH}`;
    const stratumBehManifest = await fetchBehaviorPackManifest(stratumBehBase);
    progressCallback?.({
      stage: "Loading block data",
      detail: "Reading core block definitions...",
      current: 0,
      total: stratumBehManifest.blocks.length,
    });
    await loadBehaviorPackBlocks(registry, stratumBehBase, stratumBehManifest, (loaded, total, file) => {
      progressCallback?.({
        stage: "Loading block data",
        detail: `Loaded ${file}`,
        current: loaded,
        total,
      });
    });

    const playerSettings = await this.store.loadPlayerSettings();
    const resolvedStacks = resolveWorldWorkshopStacks(metaLoaded, this._modRepository);
    let behaviorRefs = resolvedStacks.behaviorRefs;
    let worldResourceRefs = resolvedStacks.resourceRefs;
    if (
      this.multiplayerJoinRoomCode !== undefined &&
      this._joinHostBehaviorRefs !== null
    ) {
      behaviorRefs = this._joinHostBehaviorRefs;
      worldResourceRefs = this._joinHostResourceRefs ?? [];
    }
    const globalResourceRefs = playerSettings.globalResourcePackRefs;

    const behaviorCached: CachedMod[] = [];
    if (this._modRepository !== null && behaviorRefs.length > 0) {
      progressCallback?.({
        stage: "Workshop mods",
        detail: "Verifying behavior packages...",
      });
      behaviorCached.push(
        ...(await collectWorkshopCachedMods(behaviorRefs, this._modRepository)),
      );
      await loadWorkshopBlocksIntoRegistry(registry, behaviorCached, (loaded, total, file) => {
        progressCallback?.({
          stage: "Workshop mods",
          detail: file,
          current: loaded,
          total,
        });
      });
    }

    const worldResourceCached: CachedMod[] =
      this._modRepository !== null && worldResourceRefs.length > 0
        ? await collectWorkshopCachedMods(worldResourceRefs, this._modRepository)
        : [];
    const globalResourceCached: CachedMod[] =
      this._modRepository !== null && globalResourceRefs.length > 0
        ? await collectWorkshopCachedMods(globalResourceRefs, this._modRepository)
        : [];

    const itemRegistry = new ItemRegistry();
    registerBlockItems(
      Array.from({ length: registry.size }, (_, i) => registry.getById(i)),
      itemRegistry,
    );
    progressCallback?.({
      stage: "Loading items",
      detail: "Reading core item definitions...",
      current: 0,
      total: stratumBehManifest.items.length,
    });
    await loadBehaviorPackItems(
      registry,
      itemRegistry,
      stratumBehBase,
      stratumBehManifest,
      (loaded, total, file) => {
        progressCallback?.({
          stage: "Loading items",
          detail: `Loaded ${file}`,
          current: loaded,
          total,
        });
      },
    );

    if (behaviorCached.length > 0) {
      loadWorkshopItemsIntoRegistry(registry, itemRegistry, behaviorCached);
    }

    progressCallback?.({
      stage: "Loading recipes",
      detail: "Reading core recipe definitions...",
    });
    await loadBehaviorPackRecipes(
      itemRegistry,
      this._recipeRegistry,
      stratumBehBase,
      stratumBehManifest,
    );
    if (behaviorCached.length > 0) {
      loadWorkshopRecipesIntoRegistry(itemRegistry, this._recipeRegistry, behaviorCached);
    }
    this._craftingSystem = new CraftingSystem(itemRegistry, this._recipeRegistry);

    const lootResolver = new LootResolver(itemRegistry);
    await loadBehaviorPackLoot(registry, lootResolver, stratumBehBase, stratumBehManifest);
    if (behaviorCached.length > 0) {
      loadWorkshopLootIntoResolver(registry, lootResolver, behaviorCached);
    }

    await loadBehaviorPackSmelting(
      itemRegistry,
      this._smeltingRegistry,
      stratumBehBase,
      stratumBehManifest,
    );
    registerSmeltingRecipesInRegistry(this._smeltingRegistry, this._recipeRegistry);

    progressCallback?.({
      stage: "Loading textures",
      detail: "Loading block textures...",
    });
    const blockAtlas = new AtlasLoader(BLOCK_TEXTURE_MANIFEST_PATH);
    await blockAtlas.load();
    this.blockAtlasLoader = blockAtlas;
    for (const c of worldResourceCached) {
      await applyWorkshopTexturesToBlockAtlas(blockAtlas, [c]);
    }
    for (const c of globalResourceCached) {
      await applyWorkshopTexturesToBlockAtlas(blockAtlas, [c]);
    }

    progressCallback?.({
      stage: "Loading textures",
      detail: "Loading item textures...",
    });
    const [blockTexDoc, itemTexDoc] = await Promise.all([
      fetchTextureManifestJson(BLOCK_TEXTURE_MANIFEST_PATH),
      fetchTextureManifestJson(ITEM_TEXTURE_MANIFEST_PATH),
    ]);
    const workshopItemTextureUrls: Record<string, string> = {};
    for (const c of [...behaviorCached, ...worldResourceCached, ...globalResourceCached]) {
      for (const [texName, rel] of Object.entries(c.manifest.item_textures)) {
        const u = c.files[rel];
        if (u !== undefined && u.length > 0) {
          workshopItemTextureUrls[texName] = URL.createObjectURL(
            new Blob([u], { type: "image/png" }),
          );
        }
      }
    }
    const itemResolved = resolveItemTextureRecord(itemRegistry, blockTexDoc.textures, {
      ...itemTexDoc.textures,
      ...workshopItemTextureUrls,
    });
    const itemAtlas = new AtlasLoader(ITEM_TEXTURE_MANIFEST_PATH);
    await itemAtlas.loadFromTextureRecord(itemResolved);
    this.itemAtlasLoader = itemAtlas;
    for (const c of worldResourceCached) {
      await applyWorkshopTexturesToBlockAtlas(itemAtlas, [c]);
    }
    for (const c of globalResourceCached) {
      await applyWorkshopTexturesToBlockAtlas(itemAtlas, [c]);
    }

    const world = new World(
      registry,
      this._worldSeed,
      this.store,
      this.worldUuid,
      lootResolver,
      this.bus,
      metaLoaded?.blockIdPalette,
    );
    this.world = world;
    this._itemRegistry = itemRegistry;
    if (registry.isRegistered("stratum:furnace")) {
      world.setFurnaceBlockId(registry.getByIdentifier("stratum:furnace").id);
    }
    if (registry.isRegistered("stratum:chest")) {
      world.setChestBlockId(registry.getByIdentifier("stratum:chest").id);
    }

    const pipeline = new RenderPipeline({ mount: this.mount });
    progressCallback?.({
      stage: "Initializing renderer",
      detail: "Setting up GPU pipeline...",
    });
    await pipeline.init();
    pipeline.initLighting(world, this.bus, blockAtlas);
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
    this._blockInteractions.hydrateWheatSchedulesInLoadedWorld();

    this.chunkRenderer = new ChunkRenderer(pipeline, registry, blockAtlas, world);

    const input = new InputManager(
      pipeline.getCanvas(),
      playerSettings.keyBindings,
    );
    this.input = input;

    this.keyBindingsUnsub = this.bus.on(
      "settings:apply-key-bindings",
      (e) => {
        this.input?.setKeyBindings(e.bindings);
      },
    );

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

    this.uiShell = new UIShell(this.bus, this.mount, saveGame, audio, {
      store: this.store,
      getInstalled: () => this._modRepository?.getInstalled() ?? [],
    });

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

    const inventoryUI = new InventoryUI(
      this.mount,
      itemRegistry,
      () => this.entityManager!.getPlayer().inventory,
      (slotIndex, slotEl) => {
        this._handleInventoryShiftQuickMove(slotIndex, slotEl);
      },
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
        getNearFurnace: () => this._getCraftingStationContext().nearFurnace,
        canCraftOneBatch: (recipe, inv) => this._canCraftOneBatchForPanel(recipe, inv),
        maxCraftableBatches: (recipe, inv) => this._maxCraftableBatchesForPanel(recipe, inv),
        recipeTouchesInventory: (recipe, inv) =>
          this._recipeTouchesInventoryForPanel(recipe, inv),
        getRecipeIngredientAvailability: (recipe, inv) =>
          this._recipeIngredientAvailabilityForPanel(recipe, inv),
        getInventory: () => this.entityManager!.getPlayer().inventory,
        getFurnaceUiModel: () => this._getFurnaceUiModel(),
      },
    );

    this._chestPanel = new ChestPanel(inventoryUI.getChestMount(), itemRegistry, {
      getItemIconUrlLookup: () => this.inventoryUI?.getItemIconUrlLookup() ?? null,
      getChestSlotCount: () => {
        if (this._activeChestAnchor === null || this.world === null) {
          return 0;
        }
        const { ax, ay } = this._activeChestAnchor;
        const st = this.world.getChestTileAtAnchor(ax, ay);
        return st?.slots.length ?? 0;
      },
      getChestStack: (i) => {
        if (this._activeChestAnchor === null || this.world === null) {
          return null;
        }
        const st = this.world.getChestTileAtAnchor(
          this._activeChestAnchor.ax,
          this._activeChestAnchor.ay,
        );
        return st?.slots[i] ?? null;
      },
      onChestSlotMouseDown: (slotIndex, button, shift) => {
        void shift;
        return this._handleChestSlotMouseDown(slotIndex, button);
      },
      onChestSlotMouseUp: (slotIndex, button, shift, dragOccurred, slotElement) => {
        this._handleChestSlotMouseUp(
          slotIndex,
          button,
          shift,
          dragOccurred,
          slotElement,
        );
      },
      onChestSlotMouseEnter: (slotIndex, buttons) => {
        this._handleChestSlotMouseEnter(slotIndex, buttons);
      },
    });

    this.networkUnsubs.push(
      this.bus.on("chest:open-request", (e) => {
        this._handleChestOpenRequest(e.wx, e.wy);
      }),
    );

    this.networkUnsubs.push(
      this.bus.on("crafting-table:open-request", (e) => {
        this._handleCraftingTableOpenRequest(e.wx, e.wy);
      }),
    );

    this.networkUnsubs.push(
      this.bus.on("furnace:open-request", (e) => {
        this._handleFurnaceOpenRequest(e.wx, e.wy);
      }),
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
        this._handleCraftRequest(e.recipeId, e.batches, e.shiftKey ?? false);
      }),
    );

    this.networkUnsubs.push(
      this.bus.on("furnace:fuel-slot-click", (e) => {
        this._handleFurnaceFuelSlotClick(e.button);
      }),
    );
    this.networkUnsubs.push(
      this.bus.on("furnace:output-slot-click", (e) => {
        this._handleFurnaceOutputSlotClick(e.slotIndex, e.button);
      }),
    );

    this._wirePauseNetworkHandlers();
    this._emitNetworkRoleForUi();
    this.breakOverlay = new BreakOverlay(pipeline);
    await this.breakOverlay.loadDestroyStageTextures();

    this.blockBreakParticles = new BlockBreakParticles(
      this.bus,
      this._worldSeed,
      world.getAirBlockId(),
      blockAtlas,
      registry,
      pipeline,
    );

    this.leafFallParticles = new LeafFallParticles(
      this._worldSeed,
      world,
      registry,
      blockAtlas,
      world.getAirBlockId(),
      pipeline,
    );
    this.leafFallParticles.init();

    this.bus.on("game:block-changed", (e) => {
      const state = this.adapter.state;
      if (state.status !== "connected" || state.role !== "host") {
        return;
      }
      this.adapter.broadcast({
        type: MsgType.BLOCK_UPDATE,
        x: e.wx,
        y: e.wy,
        blockId: e.blockId,
        layer: e.layer === "bg" ? 1 : 0,
        previousBlockId: e.previousBlockId,
        cellMetadata:
          e.layer === "bg" ? 0 : (e.cellMetadata ?? 0),
      });
    });

    this.bus.on("game:chunks-fg-bulk-updated", (e) => {
      const state = this.adapter.state;
      if (state.status !== "connected" || state.role !== "host") {
        return;
      }
      const world = this.world;
      if (world === null) {
        return;
      }
      for (const { cx, cy } of e.chunkCoords) {
        const chunk = world.getChunk(cx, cy);
        if (chunk === undefined) {
          continue;
        }
        this.adapter.broadcast({
          type: MsgType.CHUNK_DATA,
          cx,
          cy,
          blocks: chunk.blocks.slice(),
          background: chunk.background.slice(),
          metadata: chunk.metadata.slice(),
          furnaces: world.getFurnaceEntitiesForChunk(cx, cy),
          chests: world.getChestEntitiesForChunk(cx, cy),
        });
      }
    });

    const player = entityManager.getPlayer();
    if (playerSavedState !== undefined) {
      player.applySavedState(
        playerSavedState.x,
        playerSavedState.y,
        playerSavedState.hotbarSlot,
        playerSavedState.inventory,
        playerSavedState.health,
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
    this.bus.emit({ type: "world:loaded" } satisfies GameEvent);
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
    window.addEventListener("resize", this.scheduleWindowResizedEvent);
    window.addEventListener("pagehide", this._pageHideClearListedRoom);
    this._playerStateBroadcaster.start();
    this.loop.start();
  }

  stop(): void {
    if (!this.started) {
      return;
    }
    this.started = false;
    window.removeEventListener("resize", this.scheduleWindowResizedEvent);
    window.removeEventListener("pagehide", this._pageHideClearListedRoom);
    if (this._windowResizeDebounceTimer !== null) {
      clearTimeout(this._windowResizeDebounceTimer);
      this._windowResizeDebounceTimer = null;
    }
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
          await this._signalRelay.clearRoom(rc);
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
    this.keyBindingsUnsub?.();
    this.keyBindingsUnsub = null;
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
    this.blockBreakParticles?.destroy();
    this.blockBreakParticles = null;
    this.leafFallParticles?.destroy();
    this.leafFallParticles = null;
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
      let gotSync = false;
      let gotPack = false;
      const tryDone = (): void => {
        if (!gotSync || !gotPack) {
          return;
        }
        clearTimeout(timeout);
        unsub();
        resolve();
      };
      const unsub = this.bus.on("net:message", (e) => {
        const m = e.message;
        if (m.type === MsgType.WORLD_SYNC) {
          gotSync = true;
          tryDone();
        } else if (m.type === MsgType.PACK_STACK) {
          this._joinHostBehaviorRefs = m.behaviorRefs.map((r) => ({
            recordId: r.recordId,
            modId: r.modId,
            version: r.version,
          }));
          this._joinHostResourceRefs = m.resourceRefs.map((r) => ({
            recordId: r.recordId,
            modId: r.modId,
            version: r.version,
          }));
          gotPack = true;
          tryDone();
        }
      });
    });
  }

  private _wireCoreNetworkEvents(): void {
    this.networkUnsubs.push(
      this.bus.on("net:message", (e) => {
        const msg = e.message;
        const stNet = this.adapter.state;

        if (msg.type === MsgType.PACK_STACK) {
          return;
        }

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

        if (msg.type === MsgType.GIVE_ITEM_STACK) {
          if (stNet.status === "connected" && stNet.role === "client") {
            this._applyGiveItemStackFromHost(msg.itemId, msg.count);
          }
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
          const furnaces = msg.furnaces?.map((f) => ({ ...f }));
          const chests = msg.chests?.map((c) => ({ ...c }));
          const metadata = msg.metadata?.slice();
          const w = this.world;
          if (w === null) {
            this._pendingAuthoritativeChunks.push({
              cx: msg.cx,
              cy: msg.cy,
              blocks,
              background,
              furnaces,
              chests,
              metadata,
            });
          } else {
            w.applyAuthoritativeChunk(
              msg.cx,
              msg.cy,
              blocks,
              background,
              furnaces,
              chests,
              metadata,
            );
          }
          return;
        }
        if (msg.type === MsgType.FURNACE_SNAPSHOT && this.world !== null) {
          this.world.applyFurnaceSnapshotWorld(msg.wx, msg.wy, msg.data);
          return;
        }
        if (msg.type === MsgType.CHEST_SNAPSHOT && this.world !== null) {
          this.world.applyChestSnapshotWorld(msg.wx, msg.wy, msg.data);
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
            this.world.clearRemoteBreakMiningAtWorldCell(msg.x, msg.y, "bg");
          } else {
            const meta = msg.cellMetadata ?? 0;
            this.world.setBlock(msg.x, msg.y, msg.blockId, {
              cellMetadata: meta,
            });
            this.world.clearRemoteBreakMiningAtWorldCell(msg.x, msg.y, "fg");
          }
          return;
        }
        if (msg.type === MsgType.BLOCK_BREAK_PROGRESS && this.world !== null) {
          if (msg.mode === "implicit") {
            if (stNet.status === "connected" && stNet.role === "host") {
              this.world.updateRemotePlayerBreakFromNetwork(
                e.peerId,
                msg.crackStageEncoded,
                msg.wx,
                msg.wy,
                msg.layer,
              );
              this.adapter.broadcastExcept(e.peerId as PeerId, {
                type: MsgType.BLOCK_BREAK_PROGRESS,
                mode: "relay",
                subjectPeerId: e.peerId,
                wx: msg.wx,
                wy: msg.wy,
                layer: msg.layer,
                crackStageEncoded: msg.crackStageEncoded,
              });
            }
            return;
          }
          if (stNet.status === "connected" && stNet.role === "client") {
            this.world.updateRemotePlayerBreakFromNetwork(
              msg.subjectPeerId,
              msg.crackStageEncoded,
              msg.wx,
              msg.wy,
              msg.layer,
            );
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
          const newPeer = e.peerId as PeerId;
          this.adapter.broadcast({
            type: MsgType.WORLD_SYNC,
            seed: this._worldSeed,
            worldTimeMs: this._worldTime.ms,
          });
          this.adapter.broadcast({
            type: MsgType.WORLD_TIME,
            worldTimeMs: this._worldTime.ms,
          });
          void (async () => {
            try {
              const meta = await this.store.loadWorld(this.worldUuid);
              const r = resolveWorldWorkshopStacks(meta, this._modRepository);
              this.adapter.send(newPeer, {
                type: MsgType.PACK_STACK,
                behaviorRefs: r.behaviorRefs,
                resourceRefs: r.resourceRefs,
                requirePacksBeforeJoin: r.requirePacksBeforeJoin,
              });
            } catch (err) {
              console.error(err);
              this.adapter.send(newPeer, {
                type: MsgType.PACK_STACK,
                behaviorRefs: [],
                resourceRefs: [],
                requirePacksBeforeJoin: false,
              });
            }
          })();
          const world = this.world;
          if (world !== null) {
            this._chunkSync.sendAllChunksTo(newPeer, (fn) => {
              for (const chunk of world.getChunkManager().getLoadedChunks()) {
                fn({
                  chunkX: chunk.coord.cx,
                  chunkY: chunk.coord.cy,
                  blocks: chunk.blocks,
                  background: chunk.background,
                  metadata: chunk.metadata,
                  furnaces: world.getFurnaceEntitiesForChunk(
                    chunk.coord.cx,
                    chunk.coord.cy,
                  ),
                  chests: world.getChestEntitiesForChunk(chunk.coord.cx, chunk.coord.cy),
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
      executeGive: (issuerPeerId, rest) => {
        this._runGiveCore(issuerPeerId, rest);
      },
    });
  }

  private _giveFeedbackToIssuer(issuerPeerId: string | null, text: string): void {
    if (issuerPeerId !== null) {
      this._sendSystemToPeer(issuerPeerId as PeerId, text);
      return;
    }
    this.bus.emit({
      type: "ui:chat-line",
      kind: "system",
      text,
    } satisfies GameEvent);
  }

  /**
   * Host / offline solo: `/give` implementation. `issuerPeerId` is null when offline (solo).
   */
  private _runGiveCore(issuerPeerId: string | null, rest: string): void {
    const ir = this._itemRegistry;
    const em = this.entityManager;
    if (ir === null || em === null) {
      this._giveFeedbackToIssuer(issuerPeerId, "World not ready.");
      return;
    }
    const parsed = parseGiveCommandRest(rest, issuerPeerId, this._sessionRoster);
    if (!parsed.ok) {
      this._giveFeedbackToIssuer(issuerPeerId, parsed.error);
      return;
    }
    const itemKey = resolveGiveItemKey(ir, parsed.itemKey);
    if (itemKey === undefined) {
      this._giveFeedbackToIssuer(
        issuerPeerId,
        `Unknown item: ${parsed.itemKey}`,
      );
      return;
    }
    const def = ir.getByKey(itemKey);
    if (def === undefined) {
      this._giveFeedbackToIssuer(issuerPeerId, `Unknown item: ${parsed.itemKey}`);
      return;
    }
    const itemId = def.id;
    const target = parsed.target;
    const inv = em.getPlayer().inventory;

    if (target.kind === "local") {
      const overflow = inv.add(itemId, parsed.count);
      const got = parsed.count - overflow;
      const msg =
        overflow <= 0
          ? `Gave yourself ${got}× ${def.displayName}.`
          : `Gave yourself ${got}× ${def.displayName} (${overflow} could not fit).`;
      this._giveFeedbackToIssuer(issuerPeerId, msg);
      return;
    }

    const localId = this.adapter.getLocalPeerId();
    const st = this.adapter.state;
    if (localId === null || st.status !== "connected" || st.role !== "host") {
      this._giveFeedbackToIssuer(
        issuerPeerId,
        "Giving to other players requires hosting a session.",
      );
      return;
    }

    if (target.peerId === localId) {
      const overflow = inv.add(itemId, parsed.count);
      const got = parsed.count - overflow;
      const msg =
        overflow <= 0
          ? `Gave yourself ${got}× ${def.displayName}.`
          : `Gave yourself ${got}× ${def.displayName} (${overflow} could not fit).`;
      this._giveFeedbackToIssuer(issuerPeerId, msg);
      return;
    }

    this.adapter.send(target.peerId as PeerId, {
      type: MsgType.GIVE_ITEM_STACK,
      itemId,
      count: parsed.count,
    });
    const targetEntry = this._sessionRoster.get(target.peerId);
    const label = targetEntry?.displayName ?? target.peerId;
    this._giveFeedbackToIssuer(
      issuerPeerId,
      `Granted ${parsed.count}× ${def.displayName} to ${label}.`,
    );
    this._sendSystemToPeer(
      target.peerId as PeerId,
      `You received ${parsed.count}× ${def.displayName}.`,
    );
  }

  private _applyGiveItemStackFromHost(itemId: number, count: number): void {
    const ir = this._itemRegistry;
    const em = this.entityManager;
    if (ir === null || em === null) {
      return;
    }
    const id = itemId as ItemId;
    const def = ir.getById(id);
    if (def === undefined) {
      return;
    }
    const overflow = em.getPlayer().inventory.add(id, count);
    const got = count - overflow;
    let text = `Received ${got}× ${def.displayName}.`;
    if (overflow > 0) {
      text += ` (${overflow} could not fit.)`;
    }
    this.bus.emit({
      type: "ui:chat-line",
      kind: "system",
      text,
    } satisfies GameEvent);
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
            workshopBehaviorMods: [],
            workshopResourceMods: [],
            requirePacksBeforeJoin: false,
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
    const giveMatch = /^\/give(\s+.*)?$/i.exec(trimmed);
    if (giveMatch !== null && st.status !== "connected") {
      const rest = (giveMatch[1] ?? "").trim();
      if (rest === "") {
        this.bus.emit({
          type: "ui:chat-line",
          kind: "system",
          text:
            "Usage: /give @s <item> [count]  or  /give <player> <item> [count] (solo / offline)",
        } satisfies GameEvent);
        return;
      }
      this._runGiveCore(null, rest);
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
    if (!open) {
      this._activeChestAnchor = null;
    }
    const chestActive = open && this._activeChestAnchor !== null;

    this.inventoryUI?.setOpen(open);
    this.inventoryUI?.setChestMountCollapsed(!chestActive);

    this._chestPanel?.setOpen(open);
    this._chestPanel?.setChestVisible(chestActive);

    /* Chest UI and recipe sidebar are mutually exclusive (no empty chest gap, no recipes on chest). */
    this._craftingPanel?.setOpen(open && !chestActive);
  }

  private _broadcastFurnaceSnapshotNow(wx: number, wy: number): void {
    const w = this.world;
    const st = w?.getFurnaceTile(wx, wy);
    if (w === null || st === undefined) {
      return;
    }
    const data = furnaceTileToPersisted(wx, wy, st);
    if (this.adapter.state.status === "connected") {
      this.adapter.broadcast({
        type: MsgType.FURNACE_SNAPSHOT,
        wx,
        wy,
        data,
      });
    }
    this._furnaceNetSentAt.set(`${wx},${wy}`, performance.now());
  }

  private _maybeBroadcastFurnaceSnapshotThrottled(wx: number, wy: number, nowMs: number): void {
    const key = `${wx},${wy}`;
    const last = this._furnaceNetSentAt.get(key) ?? 0;
    if (nowMs - last < 280) {
      return;
    }
    this._broadcastFurnaceSnapshotNow(wx, wy);
  }

  private _getCraftingStationContext(): CraftingStationContext {
    const w = this.world;
    const em = this.entityManager;
    if (w === null || em === null) {
      return { nearCraftingTable: false, nearFurnace: false };
    }
    const reg = w.getRegistry();
    const feet = em.getPlayer().state.position;
    let nearCraftingTable = false;
    if (reg.isRegistered("stratum:crafting_table")) {
      const tableId = reg.getByIdentifier("stratum:crafting_table").id;
      nearCraftingTable = isNearCraftingTableBlock(
        w,
        tableId,
        feet,
        CRAFTING_TABLE_ACCESS_RADIUS_BLOCKS,
      );
    }
    let nearFurnace = false;
    if (reg.isRegistered("stratum:furnace")) {
      const furnaceId = reg.getByIdentifier("stratum:furnace").id;
      nearFurnace = isNearBlockOfId(w, furnaceId, feet, FURNACE_ACCESS_RADIUS_BLOCKS);
    }
    return { nearCraftingTable, nearFurnace };
  }

  /** Recipes shown in the crafting UI (station-gated by proximity). */
  private _visibleRecipesForCrafting(): readonly RecipeDefinition[] {
    const ctx = this._getCraftingStationContext();
    return this._recipeRegistry.all().filter((r) => {
      if (r.station === null) {
        return true;
      }
      if (r.station === RECIPE_STATION_CRAFTING_TABLE) {
        return ctx.nearCraftingTable;
      }
      if (r.station === RECIPE_STATION_FURNACE) {
        return ctx.nearFurnace;
      }
      return false;
    });
  }

  private _visibleCraftingCategories(): readonly string[] {
    const set = new Set<string>();
    for (const r of this._visibleRecipesForCrafting()) {
      set.add(r.category);
    }
    const rest = [...set].filter((c) => c !== "Furnace").sort((a, b) => a.localeCompare(b));
    if (set.has("Furnace")) {
      return [...rest, "Furnace"];
    }
    return rest;
  }

  private _nearestFurnaceCell(): { wx: number; wy: number } | null {
    const w = this.world;
    const em = this.entityManager;
    if (w === null || em === null) {
      return null;
    }
    const reg = w.getRegistry();
    if (!reg.isRegistered("stratum:furnace")) {
      return null;
    }
    const fid = reg.getByIdentifier("stratum:furnace").id;
    const feet = em.getPlayer().state.position;
    const pcx = Math.floor(feet.x / BLOCK_SIZE);
    const pcy = Math.floor(feet.y / BLOCK_SIZE);
    const R = FURNACE_ACCESS_RADIUS_BLOCKS;
    let best: { wx: number; wy: number } | null = null;
    let bestD = R + 1;
    for (let dy = -R; dy <= R; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        if (d > R) {
          continue;
        }
        const wx = pcx + dx;
        const wy = pcy + dy;
        if (w.getBlock(wx, wy).id !== fid) {
          continue;
        }
        if (d < bestD) {
          bestD = d;
          best = { wx, wy };
        }
      }
    }
    return best;
  }

  private _getFurnaceUiModel(): FurnaceUiChromeModel | null {
    const cell = this._nearestFurnaceCell();
    const w = this.world;
    if (cell === null || w === null) {
      return null;
    }
    const raw = w.getFurnaceTile(cell.wx, cell.wy);
    const tile = raw ?? createEmptyFurnaceTileState(this._worldTime.ms);
    const head = tile.queue[0];
    const cookTimeSecForActive =
      head !== undefined
        ? this._smeltingRegistry.findRecipeByJsonId(head.smeltingRecipeId)?.cookTimeSec ?? 0
        : 0;
    return {
      outputSlots: tile.outputSlots,
      fuel: tile.fuel,
      fuelRemainingSec: tile.fuelRemainingSec,
      cookProgressSec: tile.cookProgressSec,
      activeSmeltingRecipeId: head?.smeltingRecipeId ?? null,
      cookTimeSecForActive,
    };
  }

  private _maxStackForItem(id: ItemId): number {
    return this._itemRegistry?.getById(id)?.maxStack ?? 1;
  }

  private _canCraftOneBatchForPanel(
    recipe: RecipeDefinition,
    inv: PlayerInventory,
  ): boolean {
    const crafting = this._craftingSystem;
    const items = this._itemRegistry;
    const w = this.world;
    if (crafting === null || items === null || w === null) {
      return false;
    }
    const ctx = this._getCraftingStationContext();
    if (recipe.station === RECIPE_STATION_FURNACE && recipe.smeltingSourceId !== undefined) {
      const cell = this._nearestFurnaceCell();
      if (cell === null) {
        return false;
      }
      const tile =
        w.getFurnaceTile(cell.wx, cell.wy) ??
        createEmptyFurnaceTileState(this._worldTime.ms);
      return (
        validateFurnaceEnqueue(
          tile,
          recipe,
          1,
          inv,
          crafting,
          this._smeltingRegistry,
          items,
          ctx,
        ) === null
      );
    }
    return crafting.canCraft(recipe, inv, 1, ctx);
  }

  private _maxCraftableBatchesForPanel(
    recipe: RecipeDefinition,
    inv: PlayerInventory,
  ): number {
    const crafting = this._craftingSystem;
    const items = this._itemRegistry;
    const w = this.world;
    if (crafting === null || items === null || w === null) {
      return 0;
    }
    const ctx = this._getCraftingStationContext();
    if (recipe.station === RECIPE_STATION_FURNACE && recipe.smeltingSourceId !== undefined) {
      const cell = this._nearestFurnaceCell();
      if (cell === null) {
        return 0;
      }
      let m = crafting.maxCraftableIngredientBatchesFurnace(recipe, inv, ctx);
      const tileBase =
        w.getFurnaceTile(cell.wx, cell.wy) ??
        createEmptyFurnaceTileState(this._worldTime.ms);
      while (m > 0) {
        const err = validateFurnaceEnqueue(
          tileBase,
          recipe,
          m,
          inv,
          crafting,
          this._smeltingRegistry,
          items,
          ctx,
        );
        if (err === null) {
          return m;
        }
        m -= 1;
      }
      return 0;
    }
    return crafting.maxCraftableBatches(recipe, inv, ctx);
  }

  private _recipeTouchesInventoryForPanel(
    recipe: RecipeDefinition,
    inv: PlayerInventory,
  ): boolean {
    const crafting = this._craftingSystem;
    if (crafting === null) {
      return false;
    }
    return crafting.recipeTouchesInventory(recipe, inv);
  }

  private _recipeIngredientAvailabilityForPanel(
    recipe: RecipeDefinition,
    inv: PlayerInventory,
  ): RecipeIngredientAvailability[] {
    const crafting = this._craftingSystem;
    if (crafting === null) {
      return [];
    }
    return crafting.recipeIngredientAvailability(recipe, inv);
  }

  private _handleFurnaceFuelSlotClick(button: number): void {
    const net = this.adapter.state;
    if (net.status === "connected" && net.role === "client") {
      return;
    }
    const w = this.world;
    const em = this.entityManager;
    const ir = this._itemRegistry;
    if (w === null || em === null || ir === null) {
      return;
    }
    const cell = this._nearestFurnaceCell();
    if (cell === null) {
      return;
    }
    const inv = em.getPlayer().inventory;
    const tile =
      w.getFurnaceTile(cell.wx, cell.wy) ??
      createEmptyFurnaceTileState(this._worldTime.ms);
    const maxStack = (id: ItemId) => this._maxStackForItem(id);
    const { tile: next, cursor } = applyFurnaceFuelSlotMouse(
      tile,
      button,
      inv.getCursorStack(),
      maxStack,
    );
    w.setFurnaceTile(cell.wx, cell.wy, next);
    inv.replaceCursorStack(cursor);
    this._broadcastFurnaceSnapshotNow(cell.wx, cell.wy);
  }

  private _handleFurnaceOutputSlotClick(slotIndex: number, button: number): void {
    const net = this.adapter.state;
    if (net.status === "connected" && net.role === "client") {
      return;
    }
    const w = this.world;
    const em = this.entityManager;
    const ir = this._itemRegistry;
    if (w === null || em === null || ir === null) {
      return;
    }
    const cell = this._nearestFurnaceCell();
    if (cell === null) {
      return;
    }
    const inv = em.getPlayer().inventory;
    const tile =
      w.getFurnaceTile(cell.wx, cell.wy) ??
      createEmptyFurnaceTileState(this._worldTime.ms);
    const maxStack = (id: ItemId) => this._maxStackForItem(id);
    const { tile: next, cursor } = applyFurnaceOutputSlotMouse(
      tile,
      slotIndex,
      button,
      inv.getCursorStack(),
      maxStack,
    );
    w.setFurnaceTile(cell.wx, cell.wy, next);
    inv.replaceCursorStack(cursor);
    this._broadcastFurnaceSnapshotNow(cell.wx, cell.wy);
  }

  private _chestWithinReach(anchor: { ax: number; ay: number }): boolean {
    const w = this.world;
    const em = this.entityManager;
    if (w === null || em === null || w.getChestBlockId() === null) {
      return false;
    }
    const cid = w.getChestBlockId()!;
    const feet = em.getPlayer().state.position;
    const pcx = Math.floor(feet.x / BLOCK_SIZE);
    const pcy = Math.floor(feet.y / BLOCK_SIZE);
    const R = CHEST_ACCESS_RADIUS_BLOCKS;
    const cheb = (bx: number, by: number): boolean =>
      Math.max(Math.abs(pcx - bx), Math.abs(pcy - by)) <= R;
    if (cheb(anchor.ax, anchor.ay)) {
      return true;
    }
    if (
      w.getForegroundBlockId(anchor.ax + 1, anchor.ay) === cid &&
      cheb(anchor.ax + 1, anchor.ay)
    ) {
      return true;
    }
    return false;
  }

  private _handleChestOpenRequest(wx: number, wy: number): void {
    const w = this.world;
    const input = this.input;
    if (w === null || input === null) {
      return;
    }
    const anchor = w.getChestStorageAnchorForCell(wx, wy);
    if (anchor === null) {
      return;
    }
    if (!this._chestWithinReach(anchor)) {
      return;
    }
    this._activeChestAnchor = anchor;
    w.syncChestStorageToLayout(wx, wy);
    if (!this.isInventoryOpen) {
      this.isInventoryOpen = true;
      input.setWorldInputBlocked(true);
    }
    this._applyInventoryPanelsOpen(true);
    this._chestPanel?.update();
  }

  private _craftingTableCellWithinReach(wx: number, wy: number): boolean {
    const w = this.world;
    const em = this.entityManager;
    if (w === null || em === null) {
      return false;
    }
    const feet = em.getPlayer().state.position;
    const pcx = Math.floor(feet.x / BLOCK_SIZE);
    const pcy = Math.floor(feet.y / BLOCK_SIZE);
    const R = CRAFTING_TABLE_ACCESS_RADIUS_BLOCKS;
    return Math.max(Math.abs(pcx - wx), Math.abs(pcy - wy)) <= R;
  }

  /** RMB crafting table: open inventory + recipe UI (leave inventory open if already up). */
  private _handleCraftingTableOpenRequest(wx: number, wy: number): void {
    const w = this.world;
    const input = this.input;
    const em = this.entityManager;
    if (w === null || input === null || em === null) {
      return;
    }
    const reg = w.getRegistry();
    if (!reg.isRegistered("stratum:crafting_table")) {
      return;
    }
    const tableId = reg.getByIdentifier("stratum:crafting_table").id;
    if (w.getBlock(wx, wy).id !== tableId) {
      return;
    }
    if (!this._craftingTableCellWithinReach(wx, wy)) {
      return;
    }
    this._activeChestAnchor = null;
    if (!this.isInventoryOpen) {
      this.isInventoryOpen = true;
      input.setWorldInputBlocked(true);
    }
    this._applyInventoryPanelsOpen(true);
    this._craftingPanel?.update(em.getPlayer().inventory);
  }

  private _furnaceCellWithinReach(wx: number, wy: number): boolean {
    const w = this.world;
    const em = this.entityManager;
    if (w === null || em === null) {
      return false;
    }
    const feet = em.getPlayer().state.position;
    const pcx = Math.floor(feet.x / BLOCK_SIZE);
    const pcy = Math.floor(feet.y / BLOCK_SIZE);
    const R = FURNACE_ACCESS_RADIUS_BLOCKS;
    return Math.max(Math.abs(pcx - wx), Math.abs(pcy - wy)) <= R;
  }

  /** RMB furnace: open inventory + crafting sidebar on Furnace tab (same reach as smelting). */
  private _handleFurnaceOpenRequest(wx: number, wy: number): void {
    const w = this.world;
    const input = this.input;
    const em = this.entityManager;
    if (w === null || input === null || em === null) {
      return;
    }
    const reg = w.getRegistry();
    if (!reg.isRegistered("stratum:furnace")) {
      return;
    }
    const furnaceId = reg.getByIdentifier("stratum:furnace").id;
    if (w.getBlock(wx, wy).id !== furnaceId) {
      return;
    }
    if (!this._furnaceCellWithinReach(wx, wy)) {
      return;
    }
    this._activeChestAnchor = null;
    if (!this.isInventoryOpen) {
      this.isInventoryOpen = true;
      input.setWorldInputBlocked(true);
    }
    this._applyInventoryPanelsOpen(true);
    this._craftingPanel?.selectCategoryIfAvailable("Furnace");
    this._craftingPanel?.update(em.getPlayer().inventory);
  }

  private _broadcastChestSnapshotNow(ax: number, ay: number): void {
    const w = this.world;
    const st = w?.getChestTileAtAnchor(ax, ay);
    if (w === null || st === undefined) {
      return;
    }
    const data = chestTileToPersisted(ax, ay, st);
    if (this.adapter.state.status === "connected") {
      this.adapter.broadcast({
        type: MsgType.CHEST_SNAPSHOT,
        wx: ax,
        wy: ay,
        data,
      });
    }
    this._chestNetSentAt.set(`${ax},${ay}`, performance.now());
  }

  private _maybeBroadcastChestSnapshotThrottled(ax: number, ay: number, nowMs: number): void {
    const key = `${ax},${ay}`;
    const last = this._chestNetSentAt.get(key) ?? 0;
    if (nowMs - last < 280) {
      return;
    }
    this._broadcastChestSnapshotNow(ax, ay);
  }

  private _handleChestSlotMouseDown(slotIndex: number, button: number): boolean {
    const net = this.adapter.state;
    if (net.status === "connected" && net.role === "client") {
      return false;
    }
    const anchor = this._activeChestAnchor;
    const w = this.world;
    const em = this.entityManager;
    const ir = this._itemRegistry;
    if (anchor === null || w === null || em === null || ir === null) {
      return false;
    }
    if (!this._chestWithinReach(anchor)) {
      return false;
    }
    if (button !== 2) {
      return false;
    }
    const inv = em.getPlayer().inventory;
    const cur = inv.getCursorStack();
    if (cur === null) {
      return false;
    }
    let tile = w.getChestTileAtAnchor(anchor.ax, anchor.ay);
    if (tile === undefined) {
      return false;
    }
    const maxStack = (id: ItemId) => this._maxStackForItem(id);
    const { state: next, cursor } = applyChestSlotMouse(tile, slotIndex, 2, cur, maxStack);
    w.setChestTileAtAnchor(anchor.ax, anchor.ay, next);
    inv.replaceCursorStack(cursor);
    this._broadcastChestSnapshotNow(anchor.ax, anchor.ay);
    return true;
  }

  private _handleInventoryShiftQuickMove(
    slotIndex: number,
    fromEl: HTMLElement,
  ): void {
    const net = this.adapter.state;
    if (net.status === "connected" && net.role === "client") {
      return;
    }
    const em = this.entityManager;
    const w = this.world;
    if (em === null || w === null) {
      return;
    }
    const inv = em.getPlayer().inventory;
    if (inv.getCursorStack() !== null) {
      return;
    }

    const anchor = this._activeChestAnchor;
    if (anchor !== null && this._chestWithinReach(anchor)) {
      const chestIdx = this._quickMovePlayerSlotToChest(slotIndex);
      if (chestIdx !== null) {
        this._chestPanel?.scrollChestSlotIntoView(chestIdx);
        const toEl = this._chestSlotDomElement(chestIdx);
        playShiftSlotFlyAnimation(fromEl, toEl);
        return;
      }
    }

    const invDest = inv.quickMoveFromSlot(slotIndex);
    if (invDest !== null) {
      const toEl = this.inventoryUI?.getOverlaySlotElement(invDest) ?? null;
      playShiftSlotFlyAnimation(fromEl, toEl);
    }
  }

  private _chestSlotDomElement(chestSlotIndex: number): HTMLElement | null {
    return document.querySelector(
      `#inventory-ui-root .inv-chest-slot[data-chest-slot="${chestSlotIndex}"]`,
    );
  }

  private _handleChestSlotMouseUp(
    slotIndex: number,
    button: number,
    shift: boolean,
    dragOccurred: boolean,
    slotEl: HTMLElement,
  ): void {
    void dragOccurred;
    const net = this.adapter.state;
    if (net.status === "connected" && net.role === "client") {
      return;
    }
    const anchor = this._activeChestAnchor;
    const w = this.world;
    const em = this.entityManager;
    const ir = this._itemRegistry;
    if (anchor === null || w === null || em === null || ir === null) {
      return;
    }
    if (!this._chestWithinReach(anchor)) {
      return;
    }
    const inv = em.getPlayer().inventory;
    if (button === 0 && shift) {
      const firstInv = this._quickMoveChestSlotToPlayer(slotIndex);
      if (firstInv !== null) {
        const toEl = this.inventoryUI?.getOverlaySlotElement(firstInv) ?? null;
        playShiftSlotFlyAnimation(slotEl, toEl);
      }
      return;
    }
    let tile = w.getChestTileAtAnchor(anchor.ax, anchor.ay);
    if (tile === undefined) {
      return;
    }
    const maxStack = (id: ItemId) => this._maxStackForItem(id);
    const { state: next, cursor } = applyChestSlotMouse(
      tile,
      slotIndex,
      button,
      inv.getCursorStack(),
      maxStack,
    );
    w.setChestTileAtAnchor(anchor.ax, anchor.ay, next);
    inv.replaceCursorStack(cursor);
    this._broadcastChestSnapshotNow(anchor.ax, anchor.ay);
  }

  private _quickMovePlayerSlotToChest(playerSlot: number): number | null {
    const anchor = this._activeChestAnchor;
    const w = this.world;
    const em = this.entityManager;
    const ir = this._itemRegistry;
    if (anchor === null || w === null || em === null || ir === null) {
      return null;
    }
    if (!this._chestWithinReach(anchor)) {
      return null;
    }
    const inv = em.getPlayer().inventory;
    if (inv.getCursorStack() !== null) {
      return null;
    }
    const src = inv.getStack(playerSlot);
    if (src === null || src.count <= 0) {
      return null;
    }
    const tile = w.getChestTileAtAnchor(anchor.ax, anchor.ay);
    if (tile === undefined) {
      return null;
    }
    const maxStack = (id: ItemId) => this._maxStackForItem(id);
    const { state: nextChest, remainder, firstChestIndex } =
      quickMoveStackIntoChest(tile, src, maxStack);
    if (firstChestIndex === null) {
      return null;
    }
    inv.setStack(playerSlot, remainder);
    w.setChestTileAtAnchor(anchor.ax, anchor.ay, nextChest);
    this._broadcastChestSnapshotNow(anchor.ax, anchor.ay);
    return firstChestIndex;
  }

  private _quickMoveChestSlotToPlayer(slotIndex: number): number | null {
    const anchor = this._activeChestAnchor;
    const w = this.world;
    const em = this.entityManager;
    if (anchor === null || w === null || em === null) {
      return null;
    }
    const inv = em.getPlayer().inventory;
    if (inv.getCursorStack() !== null) {
      return null;
    }
    const tile = w.getChestTileAtAnchor(anchor.ax, anchor.ay);
    if (tile === undefined) {
      return null;
    }
    const stack = tile.slots[slotIndex];
    if (stack === undefined || stack === null || stack.count <= 0) {
      return null;
    }
    const { rest, firstSlot } = inv.addItemStackWithFirstSlot({
      itemId: stack.itemId,
      count: stack.count,
    });
    if (firstSlot === null) {
      return null;
    }
    const slots = tile.slots.map((s) => (s === null ? null : { ...s }));
    slots[slotIndex] =
      rest !== null && rest.count > 0
        ? { itemId: stack.itemId, count: rest.count }
        : null;
    w.setChestTileAtAnchor(anchor.ax, anchor.ay, { slots });
    this._broadcastChestSnapshotNow(anchor.ax, anchor.ay);
    return firstSlot;
  }

  private _handleChestSlotMouseEnter(slotIndex: number, buttons: number): void {
    const net = this.adapter.state;
    if (net.status === "connected" && net.role === "client") {
      return;
    }
    const anchor = this._activeChestAnchor;
    const w = this.world;
    const em = this.entityManager;
    const ir = this._itemRegistry;
    if (anchor === null || w === null || em === null || ir === null) {
      return;
    }
    if (!this._chestWithinReach(anchor)) {
      return;
    }
    const inv = em.getPlayer().inventory;
    const cur = inv.getCursorStack();
    if (cur === null) {
      return;
    }
    let tile = w.getChestTileAtAnchor(anchor.ax, anchor.ay);
    if (tile === undefined) {
      return;
    }
    const maxStack = (id: ItemId) => this._maxStackForItem(id);
    if ((buttons & 1) !== 0) {
      const { state: next, cursor } = placeOneFromCursorIntoChestSlot(
        tile,
        slotIndex,
        cur,
        maxStack,
      );
      w.setChestTileAtAnchor(anchor.ax, anchor.ay, next);
      inv.replaceCursorStack(cursor);
      this._maybeBroadcastChestSnapshotThrottled(anchor.ax, anchor.ay, performance.now());
    }
    if ((buttons & 2) !== 0) {
      const { state: next, cursor } = placeOneFromCursorIntoChestSlot(
        tile,
        slotIndex,
        cur,
        maxStack,
      );
      w.setChestTileAtAnchor(anchor.ax, anchor.ay, next);
      inv.replaceCursorStack(cursor);
      this._maybeBroadcastChestSnapshotThrottled(anchor.ax, anchor.ay, performance.now());
    }
  }

  private _handleCraftRequest(recipeId: string, batches: number, shiftKey: boolean): void {
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
    const ctx = this._getCraftingStationContext();

    if (
      recipe.station === RECIPE_STATION_FURNACE &&
      recipe.smeltingSourceId !== undefined
    ) {
      const w = this.world;
      const items = this._itemRegistry;
      if (w === null) {
        this.bus.emit({
          type: "craft:result",
          ok: false,
          reason: "World is not ready.",
        } satisfies GameEvent);
        return;
      }
      if (items === null) {
        this.bus.emit({
          type: "craft:result",
          ok: false,
          reason: "Items are not ready.",
        } satisfies GameEvent);
        return;
      }
      const cell = this._nearestFurnaceCell();
      if (cell === null) {
        this.bus.emit({
          type: "craft:result",
          ok: false,
          reason: "Stand next to a furnace.",
        } satisfies GameEvent);
        return;
      }
      const tile =
        w.getFurnaceTile(cell.wx, cell.wy) ??
        createEmptyFurnaceTileState(this._worldTime.ms);
      const enq = tryEnqueueFurnaceSmelt(
        tile,
        recipe,
        batches,
        inv,
        crafting,
        this._smeltingRegistry,
        items,
        ctx,
      );
      if (!enq.ok) {
        this.bus.emit({
          type: "craft:result",
          ok: false,
          reason: enq.reason,
        } satisfies GameEvent);
        return;
      }
      w.setFurnaceTile(cell.wx, cell.wy, enq.nextTile);
      this._broadcastFurnaceSnapshotNow(cell.wx, cell.wy);
      this.bus.emit({
        type: "craft:result",
        ok: true,
        crafted: batches,
        recipeId: recipe.id,
        shiftKey,
      } satisfies GameEvent);
      return;
    }

    const result = crafting.craft(recipe, inv, batches, ctx);
    if (result.ok) {
      this.bus.emit({
        type: "craft:result",
        ok: true,
        crafted: result.crafted,
        recipeId: recipe.id,
        shiftKey,
      } satisfies GameEvent);
    } else {
      this.bus.emit({
        type: "craft:result",
        ok: false,
        reason: result.reason,
      } satisfies GameEvent);
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

      const plState = entityManager.getPlayer().state;
      const brk = plState.breakTarget;
      if (
        brk !== null &&
        plState.breakProgress > 0 &&
        plState.breakProgress < 1
      ) {
        const bid =
          brk.layer === "bg"
            ? world.getBackgroundId(brk.wx, brk.wy)
            : world.getBlock(brk.wx, brk.wy).id;
        if (bid !== world.getAirBlockId()) {
          this.blockBreakParticles?.syncLocalMiningBreak({
            wx: brk.wx,
            wy: brk.wy,
            layer: brk.layer,
            blockId: bid,
            progress: plState.breakProgress,
          });
        } else {
          this.blockBreakParticles?.syncLocalMiningBreak(null);
        }
      } else {
        this.blockBreakParticles?.syncLocalMiningBreak(null);
      }

      this._maybeBroadcastBlockBreakProgress(world, plState);

      this.blockBreakParticles?.update(dtSec);
      const pl = entityManager.getPlayer().state.position;
      this.leafFallParticles?.update(dtSec, pl.x, pl.y);
      this._playerStateBroadcastPhase += 1;
      if (this._playerStateBroadcastPhase >= 2) {
        this._playerStateBroadcastPhase = 0;
        this._playerStateBroadcaster.tick();
      }
      world.updateRemotePlayers(dtSec);
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

      if (role !== "client" && this._itemRegistry !== null) {
        world.tickWaterSystems();
        const changed = world.tickFurnaces(
          FIXED_TIMESTEP_SEC,
          this._worldTime.ms,
          this._itemRegistry,
          this._smeltingRegistry,
        );
        const nowMs = performance.now();
        for (const key of changed) {
          const comma = key.indexOf(",");
          if (comma <= 0) {
            continue;
          }
          const fwx = Number.parseInt(key.slice(0, comma), 10);
          const fwy = Number.parseInt(key.slice(comma + 1), 10);
          if (Number.isFinite(fwx) && Number.isFinite(fwy)) {
            this._maybeBroadcastFurnaceSnapshotThrottled(fwx, fwy, nowMs);
          }
        }
      }

      input.postUpdate();

      const p = entityManager.getPlayer().state.position;
      const bx = Math.floor(p.x / BLOCK_SIZE);
      const by = Math.floor(p.y / BLOCK_SIZE);
      this.fixedAsyncChain = this.fixedAsyncChain.then(() =>
        world.streamChunksAroundPlayer(bx, by).then(() => {
          const st = this.adapter.state;
          const authority =
            st.status !== "connected" || st.role !== "client";
          if (authority && this._blockInteractions !== null) {
            this._blockInteractions.hydrateWheatSchedulesInLoadedWorld();
          }
        }),
      );
    }

    this.bus.emit({
      type: "game:tick",
      tickIndex,
      dtSec,
      worldTimeMs: this._worldTime.ms,
    } satisfies GameEvent);
  }

  private _maybeBroadcastBlockBreakProgress(
    world: World,
    plState: PlayerState,
  ): void {
    const st = this.adapter.state;
    if (st.status !== "connected") {
      this._lastBreakBroadcast = null;
      return;
    }

    const send = (
      wx: number,
      wy: number,
      layerU8: 0 | 1,
      crack: number,
    ): void => {
      if (st.role === "host") {
        const lid = this.adapter.getLocalPeerId();
        if (lid === null) {
          return;
        }
        this.adapter.broadcast({
          type: MsgType.BLOCK_BREAK_PROGRESS,
          mode: "relay",
          subjectPeerId: lid,
          wx,
          wy,
          layer: layerU8,
          crackStageEncoded: crack,
        });
      } else {
        this.adapter.broadcast({
          type: MsgType.BLOCK_BREAK_PROGRESS,
          mode: "implicit",
          wx,
          wy,
          layer: layerU8,
          crackStageEncoded: crack,
        });
      }
    };

    const brk = plState.breakTarget;
    const mining =
      brk !== null &&
      plState.breakProgress > 0 &&
      plState.breakProgress < 1;

    if (!mining) {
      if (this._lastBreakBroadcast !== null) {
        send(0, 0, 0, 0);
        this._lastBreakBroadcast = null;
      }
      return;
    }

    const bid =
      brk.layer === "bg"
        ? world.getBackgroundId(brk.wx, brk.wy)
        : world.getBlock(brk.wx, brk.wy).id;
    if (bid === world.getAirBlockId()) {
      if (this._lastBreakBroadcast !== null) {
        send(0, 0, 0, 0);
        this._lastBreakBroadcast = null;
      }
      return;
    }

    const layerU8: 0 | 1 = brk.layer === "bg" ? 1 : 0;
    const crack = Math.min(9, Math.floor(plState.breakProgress * 10)) + 1;
    const prev = this._lastBreakBroadcast;
    if (
      prev !== null &&
      prev.wx === brk.wx &&
      prev.wy === brk.wy &&
      prev.layer === layerU8 &&
      prev.crack === crack
    ) {
      return;
    }

    this._lastBreakBroadcast = {
      wx: brk.wx,
      wy: brk.wy,
      layer: layerU8,
      crack,
    };
    send(brk.wx, brk.wy, layerU8, crack);
  }

  private render(alpha: number): void {
    const now = performance.now();
    const dtSec =
      this.lastRenderWallMs > 0
        ? Math.min((now - this.lastRenderWallMs) / 1000, 0.1)
        : 0;
    this.lastRenderWallMs = now;

    if (this.chunkRenderer !== null && this.world !== null) {
      const cm = this.world.getChunkManager();
      const centre = this.world.getStreamCentre();
      const visible =
        centre === null
          ? cm.getLoadedChunks()
          : cm.getChunksWithinDistance(centre, VIEW_DISTANCE_CHUNKS);
      this.chunkRenderer.syncChunks(visible);
      this.chunkRenderer.updateFoliageWind(now * 0.001);
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
      this.inventoryUI.update(
        pl.inventory,
        pl.state.hotbarSlot,
        pl.state.health,
      );
      this._craftingPanel?.update(pl.inventory);
      this._chestPanel?.update();
    }
    this.cursorStackUI?.sync();
    if (
      this.entityManager !== null &&
      this.breakOverlay !== null &&
      this.world !== null
    ) {
      this.breakOverlay.sync(this.entityManager.getPlayer().state);
      this.breakOverlay.syncRemotes(this.world.getRemotePlayers());
    }
    if (this.entityManager !== null) {
      this.uiShell?.setBackgroundEditMode(
        this.entityManager.getPlayer().state.backgroundEditMode,
      );
    }
    this.pipeline?.prepareFrame();
    if (this.pipeline !== null) {
      const lightingParams = this._worldTime.getLightingParams();
      this.pipeline.updateSky(lightingParams, this._worldTime.ms);
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
