/**
 * Top-level coordinator: event bus, fixed game loop, persistence, rendering, and networking.
 */
import { AudioEngine, type SfxOptions } from "../audio/AudioEngine";
import { getBreakSound, getCloseSound, getOpenSound } from "../audio/blockSounds";
import { fetchAndLoadSoundManifest } from "../audio/loadSoundManifest";
import { RemotePlayerMovementSfx } from "../audio/remotePlayerSfx";
import { readVolumeStored, VOL_KEYS } from "../audio/volumeSettings";
import {
  BACKGROUND_RESIZE_DEBOUNCE_MS,
  BLOCK_SIZE,
  CAMERA_PLAYER_VERTICAL_OFFSET_PX,
  CHEST_ACCESS_RADIUS_BLOCKS,
  CHUNK_SIZE,
  CRAFTING_TABLE_ACCESS_RADIUS_BLOCKS,
  SIMULATION_DISTANCE_CHUNKS,
  FURNACE_ACCESS_RADIUS_BLOCKS,
  STONECUTTER_ACCESS_RADIUS_BLOCKS,
  DAWN_LENGTH_MS,
  DAY_LENGTH_MS,
  DAYLIGHT_LENGTH_MS,
  DUSK_LENGTH_MS,
  AUDIO_ENV_DETECT_INTERVAL_TICKS,
  AUDIO_SPATIAL_LISTENER_UPDATE_INTERVAL_TICKS,
  FIXED_TIMESTEP_MS,
  FIXED_TIMESTEP_SEC,
  HOTBAR_SIZE,
  ARMOR_SLOT_COUNT,
  ARMOR_UI_SLOT_BASE,
  ITEM_PICKUP_SFX_MIN_INTERVAL_MS,
  ITEM_PLAYER_THROW_PICKUP_DELAY_SEC,
  ITEM_THROW_INHERIT_PLAYER_VEL_X,
  ITEM_THROW_SPAWN_OFFSET_PX,
  ITEM_THROW_SPEED_PX,
  PLAYER_DEATH_ANIM_DURATION_SEC,
  PLAYER_HEIGHT,
  PLAYER_WIDTH,
  POINTER_MOVE_THROTTLE_MS,
  REACH_BLOCKS,
  RECIPE_STATION_CRAFTING_TABLE,
  RECIPE_STATION_FURNACE,
  RECIPE_STATION_STONECUTTER,
  TORCH_HELD_LIGHT_INTENSITY,
  TORCH_HELD_LIGHT_RADIUS_BLOCKS,
  WORLD_Y_MAX,
} from "./constants";
import { EventBus } from "./EventBus";
import { GameLoop } from "./GameLoop";
import {
  normalizeWorldGameMode,
  normalizeWorldGenType,
  type DynamicLightEmitter,
  type GameEvent,
  type WorldGameMode,
  type WorldGenType,
} from "./types";
import { chunkPerfLog, chunkPerfNow } from "../debug/chunkPerf";
import {
  captureAndSavePerformanceReport,
  type PerfWorldSnapshot,
} from "../debug/perfCapture";
import { GpuDebugHud } from "../debug/GpuDebugHud";
import { withPerfSpan } from "../debug/perfSpans";
import { getEffectiveViewDistanceChunks } from "../ui/settings/videoPrefs";
import {
  CraftingSystem,
  type CraftingStationContext,
  type RecipeIngredientAvailability,
} from "../entities/CraftingSystem";
import { EntityManager } from "../entities/EntityManager";
import {
  feetPxFromSurfaceBlockY,
  mobDeathTipOverTiltRad,
  mobHitboxSizePx,
  MOB_SPAWN_VIEW_MARGIN_SCREEN_PX,
} from "../entities/mobs/mobConstants";
import {
  buildMobSpawnViewRectCenteredOnFeet,
  buildMobSpawnViewRectFromCamera,
  type MobSpawnViewRect,
} from "../entities/mobs/spawnViewRect";
import { MobManager } from "../entities/mobs/MobManager";
import { MobType } from "../entities/mobs/mobTypes";
import {
  feetToScreenAABB,
  type PlayerState,
} from "../entities/Player";
import {
  clampItemThrowVelocity,
  getItemThrowUnitVectorFromFeet,
  getReachCrosshairDisplayPos,
} from "../input/aimDirection";
import { InputManager } from "../input/InputManager";
import { ItemRegistry, registerBlockItems } from "../items/ItemRegistry";
import { LootResolver } from "../items/LootResolver";
import { worldToChunk } from "../world/chunk/ChunkCoord";
import { GeneratorContext } from "../world/gen/GeneratorContext";
import type { IModRepository } from "../mods/IModRepository";
import {
  ResourcePackManifestSchema,
  STRATUM_CORE_BEHAVIOR_PACK_PATH,
  STRATUM_CORE_RESOURCE_PACK_PATH,
} from "../mods/internalPackManifest";
import {
  fetchBehaviorPackManifest,
  loadBehaviorPackBlocks,
  loadBehaviorPackFeatures,
  loadBehaviorPackItems,
  loadBehaviorPackLoot,
  loadBehaviorPackRecipes,
  loadBehaviorPackStructures,
  loadBehaviorPackSmelting,
} from "../mods/loadInternalBehaviorPack";
import {
  applyWorkshopTexturesToBlockAtlas,
  collectWorkshopCachedMods,
  loadWorkshopBlocksIntoRegistry,
  loadWorkshopFeatures,
  loadWorkshopItemsIntoRegistry,
  loadWorkshopLootIntoResolver,
  loadWorkshopRecipesIntoRegistry,
  loadWorkshopStructures,
} from "../mods/loadWorkshopContent";
import type { CachedMod } from "../mods/workshopTypes";
import {
  IndexedDBStore,
  sanitizePersistedFeetPosition,
} from "../persistence/IndexedDBStore";
import type { WorldMetadata, WorkshopModRef } from "../persistence/IndexedDBStore";
import { SaveGame } from "../persistence/SaveGame";
import { resolveWorldWorkshopStacks } from "../persistence/worldWorkshopStacks";
import { formatStratumBuildLine } from "../versionInfo";
import { ChunkSyncManager } from "../network/ChunkSyncManager";
import type { HostPeerId } from "../network/hostPeerId";
import type { PeerId } from "../network/INetworkAdapter";
import { PeerJSAdapter } from "../network/PeerJSAdapter";
import type {
  RoomPublishMeta,
  SupabaseSignalAdapter,
} from "../network/SupabaseSignalAdapter";
import { multiplayerPersistKey } from "../network/multiplayerPersist";
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
import { ButterflyAmbientParticles } from "../renderer/ButterflyAmbientParticles";
import { FireflyAmbientParticles } from "../renderer/FireflyAmbientParticles";
import { LeafFallParticles } from "../renderer/LeafFallParticles";
import { BreakOverlay } from "../renderer/BreakOverlay";
import { ChunkRenderer } from "../renderer/chunk/ChunkRenderer";
import type { FoliageWindInfluence } from "../renderer/chunk/TileDrawBatch";
import { RenderPipeline } from "../renderer/RenderPipeline";
import { ChatHostController, resolveRosterPeer } from "../network/ChatHostController";
import { parseGiveCommandRest, resolveGiveItemKey } from "../network/giveCommand";
import { parseSummonCommandRest } from "../network/summonCommand";
import {
  migrateModerationMetadata,
  WorldModerationState,
} from "../network/moderation/WorldModerationState";
import { ChestPanel } from "../ui/ChestPanel";
import { CreativePanel } from "../ui/CreativePanel";
import { CraftingPanel, type FurnaceUiChromeModel } from "../ui/CraftingPanel";
import { CursorStackUI } from "../ui/CursorStackUI";
import { ChatOverlay } from "../ui/ChatOverlay";
import { InventoryUI } from "../ui/InventoryUI";
import { playShiftSlotFlyAnimation } from "../ui/shiftSlotFlyAnimation";
import { DamageNumbersOverlay } from "../ui/DamageNumbersOverlay";
import { NametagOverlay } from "../ui/NametagOverlay";
import { SignHoverOverlay } from "../ui/SignHoverOverlay";
import { UIShell } from "../ui/UIShell";
import {
  sanitizeSignMarkup,
  signMarkupToHtml,
  signMarkupToPlainText,
} from "../ui/signFormatting";
import { runSleepTransition } from "../ui/screens/sleepTransition";
import { bedHeadPlusXFromMeta } from "../world/bed/bedMetadata";
import { BlockRegistry } from "../world/blocks/BlockRegistry";
import { RecipeRegistry } from "../world/RecipeRegistry";
import { WorldTime } from "../world/lighting/WorldTime";
import { applyRainLightingTint } from "../world/weather/rainLighting";
import { WeatherController } from "../world/weather/WeatherController";
import { BlockInteractions } from "../world/BlockInteractions";
import { World } from "../world/World";
import { StructureRegistry } from "../world/structure/StructureRegistry";
import {
  loadBuiltinStructureFeatures,
  loadBuiltinStructures,
} from "../world/structure/loadBuiltinStructures";
import { placeStructureAt } from "../world/structure/placeStructure";
import { applyCommittedBreakOnWorld } from "../world/terrain/applyCommittedBreak";
import { applyCommittedDoorToggle } from "../world/terrain/applyDoorToggle";
import {
  ACK_BUCKET_FILL_RESULT,
  ACK_CONSUME_ONE,
  ACK_TOOL_USE,
  ACK_WATER_BUCKET_SPENT,
  tryHostTerrainPlace,
} from "../world/terrain/terrainHostPlace";
import {
  applyFurnaceFuelSlotMouse,
  applyFurnaceOutputSlotMouse,
} from "../world/furnace/furnaceBufferSlotClick";
import {
  furnaceTileToPersisted,
  type FurnacePersistedChunk,
} from "../world/furnace/furnacePersisted";
import { chestTileToPersisted, type ChestPersistedChunk } from "../world/chest/chestPersisted";
import type { SpawnerPersistedChunk } from "../world/spawner/spawnerPersisted";
import { createDefaultSpawnerTileState } from "../world/spawner/SpawnerTileState";
import type { SignPersistedChunk } from "../world/sign/signPersisted";
import { createDefaultSignTileState } from "../world/sign/SignTileState";
import { quickMoveStackIntoChest } from "../world/chest/chestQuickMove";
import {
  applyChestSlotMouse,
  placeOneFromCursorIntoChestSlot,
} from "../world/chest/chestSlotClick";
import {
  tryEnqueueFurnaceSmelt,
  validateFurnaceEnqueue,
} from "../world/furnace/furnaceEnqueue";
import { removeFurnaceQueueEntriesForRecipe } from "../world/furnace/furnaceCancelQueuedRecipe";
import { createEmptyFurnaceTileState } from "../world/furnace/FurnaceTileState";
import { SmeltingRegistry } from "../world/SmeltingRegistry";
import { registerSmeltingRecipesInRegistry } from "../world/smeltingAsCraftingRecipes";
import {
  ENTITY_STATE_FLAG_SLIME_JUMP_PRIMING,
  ENTITY_STATE_FLAG_SLIME_ON_GROUND,
  MsgType,
  PLAYER_SKIN_DATA_MAX_BYTES,
  type PlayerStateMsg,
  type PlayerStateRelayMsg,
} from "../network/protocol/messages";
import type { HeldTorchLighting } from "../renderer/lighting/LightingComposer";
import type { ItemId } from "./itemDefinition";
import {
  meleeBaseKnockbackFromHeldItemId,
  meleeDamageFromHeldItemId,
} from "./meleeWeaponStats";
import type { RecipeDefinition } from "./recipe";
import type { ArmorSlot, PlayerInventory } from "../items/PlayerInventory";
import { isNearBlockOfId, isNearCraftingTableBlock } from "../world/craftingProximity";

const PEERJS_CLOUD = {
  host: "0.peerjs.com",
  port: 443,
  path: "/",
  secure: true,
} as const;

const WORLD_TIME_BROADCAST_INTERVAL_MS = 5_000;
const RAIN_GROWTH_MUL = 1.35;
const TOOL_SWING_SFX_VOLUME = 0.72;
const TOOL_SWING_SFX_PITCH_VARIANCE_CENTS = 210;
const STRUCTURE_EXPORT_FORMAT = "stratum-structure-v1";

const HOST_DISABLED_MULTIPLAYER_REASON =
  "The host closed the room. Return to the main menu to continue.";

function safeStructureExportBasename(worldName: string): string {
  const trimmed = worldName.trim().slice(0, 64) || "world";
  const safe = trimmed.replace(/[^\w.\- ]+/g, "_").replace(/\s+/g, "_");
  return `${safe}.structure.json`;
}

function triggerJsonDownload(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

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
  gameMode?: WorldGameMode;
  /** World generation preset; defaults to `"normal"` when omitted (e.g. legacy saves). */
  worldGenType?: WorldGenType;
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
  /** Persisted local anonymous UUID when not signed in; omit when signed in. */
  localGuestUuid?: string | null;
  /** Selected player skin id (e.g. `"explorer_bob"` or `"custom:uuid"`). */
  skinId?: string;
  /** Optional workshop cache + download; omitted when Supabase is not configured. */
  modRepository?: IModRepository | null;
  /**
   * When set (e.g. from `main.ts` for menu OST), SFX/music share this engine and it is not destroyed with the game.
   */
  sharedAudio?: AudioEngine;
  /** Optional block atlas prepared by menu background to avoid duplicate startup load. */
  preloadedBlockAtlas?: AtlasLoader | null;
};

export type PlayerSavedState = {
  x: number;
  y: number;
  hotbarSlot: number;
  inventory?: import("../items/PlayerInventory").SerializedInventorySlot[];
  /** Omitted in older saves; defaults to full health. */
  health?: number;
  /** Armor slots (helmet, chestplate, leggings, boots); absent in older saves. */
  armor?: import("../items/PlayerInventory").SerializedInventorySlot[];
};

export type GameLoadProgress = {
  stage: string;
  detail?: string;
  current?: number;
  total?: number;
};

type PendingRemotePlayerPacket =
  | { kind: "direct"; senderPeerId: string; msg: PlayerStateMsg }
  | { kind: "relay"; msg: PlayerStateRelayMsg };

export class Game {
  readonly bus: EventBus;
  private readonly loop: GameLoop;
  private readonly mount: HTMLElement;
  private _worldSeed: number;
  private readonly worldUuid: string;
  private readonly store: IndexedDBStore;
  private readonly worldName: string;
  private _worldGameMode: WorldGameMode;
  private _worldGenType: WorldGenType;
  private _cheatsEnabled = false;
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
  private readonly _localGuestUuid: string | null;
  private _localSkinId: string | null = null;
  private readonly _moderation = new WorldModerationState();
  private readonly _sessionRoster = new Map<
    string,
    { displayName: string; accountId: string; skinId: string; localGuestUuid: string }
  >();
  private readonly _mutedPeerIds = new Set<string>();
  private readonly _opPeerIds = new Set<string>();
  private _chatHost: ChatHostController | null = null;
  private _chatOverlay: ChatOverlay | null = null;
  private _nametagOverlay: NametagOverlay | null = null;
  private _signHoverOverlay: SignHoverOverlay | null = null;
  private _damageNumbersOverlay: DamageNumbersOverlay | null = null;
  private _gpuDebugHud: GpuDebugHud | null = null;
  private _chatOpen = false;
  private _wandEnabled = true;
  private _wandStart: { wx: number; wy: number } | null = null;
  private _wandEnd: { wx: number; wy: number } | null = null;
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
    spawners?: SpawnerPersistedChunk[];
    signs?: SignPersistedChunk[];
    metadata?: Uint8Array;
  }> = [];
  /** Joining client: pose packets received before `World` exists (see `_flushPendingRemotePlayerPackets`). */
  private readonly _pendingRemotePlayerPackets: PendingRemotePlayerPacket[] = [];
  /** Client: host spawn assignment before local player is fully spawned. */
  private _pendingAssignedSpawn: { x: number; y: number } | null = null;
  /** Host: merge into world metadata on next save (logout positions). */
  private readonly _multiplayerLogoutSpawns = new Map<
    string,
    { x: number; y: number }
  >();
  /** Host: merge into world metadata on next save (bed spawn points). */
  private readonly _multiplayerSpawnPoints = new Map<
    string,
    { x: number; y: number }
  >();
  /** Local (solo/host/client): respawn spawnpoint (bed). */
  private _localSpawnFeet: { x: number; y: number } | null = null;

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
  private butterflyParticles: ButterflyAmbientParticles | null = null;
  private fireflyParticles: FireflyAmbientParticles | null = null;
  private readonly _fireflyLightingScratch: DynamicLightEmitter[] = [];
  private readonly _remotePlayerMovementSfx = new RemotePlayerMovementSfx();
  private saveGame: SaveGame | null = null;
  private _perfCaptureActive = false;
  private _blockInteractions: BlockInteractions | null = null;
  private readonly _pendingBlockUpdates: { x: number; y: number; blockId: number; layer: number; cellMetadata: number }[] = [];
  private audio: AudioEngine | null = null;
  /** When false, {@link destroy} leaves {@link audio} running (shared with main-menu OST). */
  private _ownsAudioEngine = true;
  private inventoryUI: InventoryUI | null = null;
  private _craftingPanel: CraftingPanel | null = null;
  private _creativePanel: CreativePanel | null = null;
  private _itemRegistry: ItemRegistry | null = null;
  private _mobManager: MobManager | null = null;
  private _lootResolver: LootResolver | null = null;
  private readonly _structureRegistry = new StructureRegistry();
  private readonly _smeltingRegistry = new SmeltingRegistry();
  private readonly _furnaceNetSentAt = new Map<string, number>();
  private readonly _chestNetSentAt = new Map<string, number>();
  private _chestPanel: ChestPanel | null = null;
  /** Storage anchor while chest UI is active. */
  private _activeChestAnchor: { ax: number; ay: number } | null = null;
  private _spawnerModalEl: HTMLDivElement | null = null;
  private _signModalEl: HTMLDivElement | null = null;
  private readonly _pendingSpawnerFxByMobId = new Map<number, { wx: number; wy: number }>();
  /** Avoid repeating furnace crackle when re-triggering the same cell without closing inventory. */
  private _lastFurnaceOpenSfxKey: string | null = null;
  /** Throttle active furnace smelt crackle (~1 Hz per world furnace with a queue). */
  private _furnaceSmeltSfxAccumSec = 0;
  /** {@link ITEM_PICKUP_SFX_MIN_INTERVAL_MS}: avoid pickup spam while overlapping collect radius. */
  private _lastItemPickupSfxMs = -Infinity;
  /** Bleat / footstep cadence per sheep id (local listener; host + clients). */
  private readonly _sheepAmbientSfxById = new Map<
    number,
    { bleatIn: number; stepPx: number }
  >();
  private readonly _pigAmbientSfxById = new Map<
    number,
    { gruntIn: number; stepPx: number; deathPlayed: boolean }
  >();
  private readonly _duckAmbientSfxById = new Map<
    number,
    { quackIn: number; stepPx: number; deathPlayed: boolean }
  >();
  /** Throttle per-mob "hurt vocal" so rapid hits don't spam. */
  private readonly _mobHurtSfxAtMs = new Map<number, number>();
  private cursorStackUI: CursorStackUI | null = null;
  private isInventoryOpen = false;
  private paused = false;
  /** Full-screen death prompt (after death anim finishes). */
  private _deathModalOpen = false;
  /** One-shot chat + UI cleanup when local death starts. */
  private _localDeathNotified = false;

  private lastRenderWallMs = 0;
  /** Last non-zero walk sign for foliage body-bend while overlapping plants (−1/0/+1). */
  private _foliageBendLatchLocal = 0;
  private readonly _foliageBendLatchRemote = new Map<string, number>();
  private _lastMouseWorldPosUpdateTime = 0;
  private _lastInvalidCameraTargetWarnMs = 0;
  private _lastPerfSpikeLogMs = 0;
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
  /**
   * Chunk streaming is slow (IndexedDB + lighting). Queueing one `streamChunksAroundPlayer`
   * per fixed tick would backlog stale player coords and leave meshes unloaded near the camera.
   */
  private _chunkStreamInflight = false;
  private _chunkStreamDirty = false;
  private _chunkStreamBx = 0;
  private _chunkStreamBy = 0;
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
  private readonly _weather = new WeatherController();
  /** Client mirror of host `rainRemainingSec` (updated from {@link MsgType.WEATHER_SYNC}). */
  private _clientRainRemainingSec = 0;
  /**
   * Multiplayer client: waiters for {@link World.setAuthoritativeChunkFetcher} until CHUNK_DATA
   * arrives for the same chunk key.
   */
  private readonly _chunkFetchWaitLists = new Map<string, Array<() => void>>();
  /** Client: `performance.now()` when {@link MsgType.CHUNK_REQUEST} was sent (dev RTT logging). */
  private readonly _chunkRequestSentAtMs = new Map<string, number>();
  /** `performance.now()` until which lightning sky flash decays. */
  private _lightningAnimEndMs = 0;
  /** Tracks dual-loop rain ambience ({@link AudioEngine.startSfxRainDualAmbient}). */
  private _rainAmbientActive = false;
  /** Fixed-update accumulator for cycling random rain loops. */
  private _rainAmbientRefreshAccum = 0;
  private static readonly RAIN_AMBIENT_REFRESH_SEC = 7;
  /** Smoothed 0–1 for rain bus (open sky + weather); drives {@link AudioEngine.setSfxRainExposure}. */
  private _rainAudioExposure = 0;
  private static readonly RAIN_AUDIO_FADE_SEC = 2.75;

  /** Prevent overlapping bed sleep transitions (local visuals). */
  private _sleepTransitionPromise: Promise<void> | null = null;
  /** Client: where to stand after the next host sleep transition. */
  private _pendingLocalSleepStandFeet: { x: number; y: number } | null = null;
  /** Multiplayer host: peers currently "in bed" for majority vote (includes "__host" when host sleeps). */
  private readonly _sleepVotePeerIds = new Set<string>();
  /** Host: prevent repeated triggers while already transitioning. */
  private _sleepSkipInProgress = false;

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
    hotbarSlot: 0,
    heldItemId: 0,
    miningVisual: false,
    armorHelmetId: 0,
    armorChestId: 0,
    armorLeggingsId: 0,
    armorBootsId: 0,
    bowDrawQuantized: 0,
    aimDisplayX: 0,
    aimDisplayY: 0,
  };

  private readonly _recipeRegistry = new RecipeRegistry();
  private _craftingSystem: CraftingSystem | null = null;

  private readonly _modRepository: IModRepository | null;
  private readonly _sharedAudio: AudioEngine | undefined;
  private readonly _preloadedBlockAtlas: AtlasLoader | null;

  constructor(options: GameOptions) {
    this.mount = options.mount;
    this._worldSeed = options.seed;
    this.worldUuid = options.worldUuid;
    this.store = options.store;
    this.worldName = options.worldName;
    this._worldGameMode = normalizeWorldGameMode(options.gameMode);
    this._worldGenType = normalizeWorldGenType(options.worldGenType);
    this.multiplayerJoinRoomCode = options.multiplayerJoinRoomCode;
    this.multiplayerJoinPassword = options.multiplayerJoinPassword;
    this.multiplayerHostFromMenu = options.multiplayerHostFromMenu;
    this._signalRelay = options.signalRelay ?? null;
    const dn = options.displayName?.trim();
    this._displayName = dn !== undefined && dn !== "" ? dn : "Player";
    this._accountId = options.accountId ?? null;
    const lg = options.localGuestUuid?.trim();
    this._localGuestUuid =
      lg !== undefined && lg !== "" ? lg : null;
    this._localSkinId = options.skinId ?? null;
    this._modRepository = options.modRepository ?? null;
    this._sharedAudio = options.sharedAudio;
    this._preloadedBlockAtlas = options.preloadedBlockAtlas ?? null;
    this.bus = new EventBus();
    const initialTimeMs =
      options.initialWorldTimeMs ?? DAY_LENGTH_MS * 0.15;
    this._worldTime = new WorldTime(initialTimeMs);
    this.adapter = new PeerJSAdapter(this.bus);
    this.adapter.setHandshakeProfile(
      this._displayName,
      this._accountId,
      this._localSkinId ?? undefined,
      this._localGuestUuid,
    );
    this._chunkSync = new ChunkSyncManager(this.adapter);
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
      const pose = em.getLocalPlayerNetworkPoseExtras();
      s.hotbarSlot = pose.hotbarSlot;
      s.heldItemId = pose.heldItemId;
      s.miningVisual = pose.miningVisual;
      s.armorHelmetId = pose.armorHelmetId;
      s.armorChestId = pose.armorChestId;
      s.armorLeggingsId = pose.armorLeggingsId;
      s.armorBootsId = pose.armorBootsId;
      s.bowDrawQuantized = pose.bowDrawQuantized;
      s.aimDisplayX = pose.aimDisplayX;
      s.aimDisplayY = pose.aimDisplayY;
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
    this.networkUnsubs.push(
      this.bus.on("ui:perf-capture-start", (e) => {
        if (this._perfCaptureActive) {
          this.bus.emit({
            type: "ui:perf-capture-status",
            status: "capturing",
            message: "Capture already running.",
          } satisfies GameEvent);
          return;
        }
        this._perfCaptureActive = true;
        const durationMs = e.durationMs ?? 30_000;
        this.bus.emit({
          type: "ui:perf-capture-status",
          status: "capturing",
          message: `Capturing for ${Math.round(durationMs / 1000)} seconds...`,
        } satisfies GameEvent);
        void captureAndSavePerformanceReport({
          durationMs: e.durationMs,
          topBottomUpEntries: e.topBottomUpEntries,
          hotStackCount: e.hotStackCount,
          maxProfilerBufferSize: e.maxProfilerBufferSize,
          worldName: this.worldName,
          worldUuid: this.worldUuid,
          networkRole: this.adapter.state.status === "connected" ? this.adapter.state.role : "offline",
          worldSnapshot: this._buildPerfWorldSnapshot(),
        })
          .then((result) => {
            const mode = result.bottomUpAvailable ? "Bottom-up included." : "Metrics-only fallback.";
            this.bus.emit({
              type: "ui:perf-capture-status",
              status: "saved",
              message: `Saved ${result.filename}. ${mode}`,
              outputPath: result.outputPath,
            } satisfies GameEvent);
          })
          .catch((err: unknown) => {
            const message = err instanceof Error ? err.message : "Could not save performance report.";
            this.bus.emit({
              type: "ui:perf-capture-status",
              status: "failed",
              message,
            } satisfies GameEvent);
          })
          .finally(() => {
            this._perfCaptureActive = false;
          });
      }),
    );
  }

  private _isSandboxWorld(): boolean {
    return this._worldGameMode === "sandbox";
  }

  private _buildPerfWorldSnapshot(): PerfWorldSnapshot | undefined {
    const world = this.world;
    if (world === null) {
      return undefined;
    }
    let loadedChunkCount = 0;
    for (const _ of world.getChunkManager().getLoadedChunks()) {
      loadedChunkCount += 1;
    }
    let activeMobCount = 0;
    const mm = this._mobManager;
    if (mm !== null) {
      for (const _ of mm.getAll()) {
        activeMobCount += 1;
      }
    }
    return {
      loadedChunkCount,
      activeMobCount,
      worldTimeMs: this._worldTime.ms,
      viewDistanceChunks: getEffectiveViewDistanceChunks(),
      streamCentreChunk: world.getStreamCentre(),
    };
  }

  private _areCheatsEnabled(): boolean {
    return this._cheatsEnabled;
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
    if (this.multiplayerJoinRoomCode === undefined) {
      this._worldGameMode = normalizeWorldGameMode(
        metaLoaded?.gameMode ?? this._worldGameMode,
      );
      this._worldGenType = normalizeWorldGenType(
        metaLoaded?.worldGenType ?? this._worldGenType,
      );
      // New sandbox worlds default to cheats enabled unless metadata explicitly sets otherwise.
      this._cheatsEnabled =
        metaLoaded?.enableCheats ?? (metaLoaded === undefined && this._worldGameMode === "sandbox");
    }
    this._moderation.loadFromPersisted(
      migrateModerationMetadata(metaLoaded?.moderation),
    );
    if (this.multiplayerJoinRoomCode === undefined) {
      const rs = metaLoaded?.rainRemainingSec;
      if (rs !== undefined) {
        this._weather.restoreFromSave(rs);
      }
    }
    const persistedSpawn = sanitizePersistedFeetPosition(
      metaLoaded?.playerSpawnX,
      metaLoaded?.playerSpawnY,
    );
    if (persistedSpawn !== null) {
      this._localSpawnFeet = persistedSpawn;
    }

    this.quitUnsub = this.bus.on("ui:quit", () => {
      this.stop();
      if (this.stopResolve !== null) {
        const resolve = this.stopResolve;
        this.stopResolve = null;
        resolve();
      }
    });

    this.networkUnsubs.push(
      this.bus.on("ui:death-respawn", () => {
        this._respawnLocalPlayerAfterDeath();
      }),
    );

    const registry = new BlockRegistry();
    const baseUrl = import.meta.env.BASE_URL;
    const stratumBehBase = `${baseUrl}${STRATUM_CORE_BEHAVIOR_PACK_PATH}`;
    const stratumBehManifest = await fetchBehaviorPackManifest(stratumBehBase);
    progressCallback?.({
      stage: "Loading block data",
      detail: "Reading core block definitions...",
      current: 0,
      total: stratumBehManifest.blocks?.length ?? 0,
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

    const builtinStructures = await loadBuiltinStructures();
    for (const [id, s] of builtinStructures) {
      this._structureRegistry.registerStructure(id, s);
    }
    const coreStructures = await loadBehaviorPackStructures(
      stratumBehBase,
      stratumBehManifest,
    );
    for (const [id, s] of coreStructures) {
      this._structureRegistry.registerStructure(id, s);
    }
    const workshopStructures =
      behaviorCached.length > 0 ? loadWorkshopStructures(behaviorCached) : new Map();
    for (const [id, s] of workshopStructures) {
      this._structureRegistry.registerStructure(id, s);
    }

    const builtinFeatures = await loadBuiltinStructureFeatures();
    for (const f of builtinFeatures) {
      this._structureRegistry.registerFeature(f);
    }
    const coreFeatures = await loadBehaviorPackFeatures(
      stratumBehBase,
      stratumBehManifest,
    );
    for (const f of coreFeatures) {
      this._structureRegistry.registerFeature(f);
    }
    const workshopFeatures =
      behaviorCached.length > 0 ? loadWorkshopFeatures(behaviorCached) : [];
    for (const f of workshopFeatures) {
      this._structureRegistry.registerFeature(f);
    }

    const itemRegistry = new ItemRegistry();
    registerBlockItems(
      Array.from({ length: registry.size }, (_, i) => registry.getById(i)),
      itemRegistry,
    );
    progressCallback?.({
      stage: "Loading items",
      detail: "Reading core item definitions...",
      current: 0,
      total: stratumBehManifest.items?.length ?? 0,
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
    this._lootResolver = lootResolver;
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
    const blockAtlas = this._preloadedBlockAtlas ?? new AtlasLoader(BLOCK_TEXTURE_MANIFEST_PATH);
    if (this._preloadedBlockAtlas === null) {
      await blockAtlas.load();
    }
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
          // Ensure ArrayBuffer-backed bytes for Blob; some sources may use SharedArrayBuffer.
          const bytes = new Uint8Array(u.length);
          bytes.set(u);
          workshopItemTextureUrls[texName] = URL.createObjectURL(
            new Blob([bytes], { type: "image/png" }),
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
      metaLoaded?.itemIdLayoutRevision,
      this._worldGenType,
    );
    this.world = world;
    this._itemRegistry = itemRegistry;
    world.setItemRegistry(itemRegistry);
    world.setSmeltingRegistryForQueueRefund(this._smeltingRegistry);
    const configuredFeatures = this._structureRegistry
      .listFeatures()
      .map((f) => {
        const structures = f.structureIds
          .map((id) => this._structureRegistry.getStructure(id))
          .filter((s): s is NonNullable<typeof s> => s !== undefined);
        return structures.length === 0 ? null : { ...f, structures };
      })
      .filter((v): v is NonNullable<typeof v> => v !== null);
    world.setStructureFeatures(configuredFeatures);
    if (registry.isRegistered("stratum:furnace")) {
      world.setFurnaceBlockId(registry.getByIdentifier("stratum:furnace").id);
    }
    if (registry.isRegistered("stratum:chest")) {
      world.setChestBlockId(registry.getByIdentifier("stratum:chest").id);
    }
    if (registry.isRegistered("stratum:barrel")) {
      world.setBarrelBlockId(registry.getByIdentifier("stratum:barrel").id);
    }
    if (registry.isRegistered("stratum:spawner")) {
      world.setSpawnerBlockId(registry.getByIdentifier("stratum:spawner").id);
    }
    const signIds: number[] = [];
    for (const signKey of ["stratum:oak_sign", "stratum:spruce_sign", "stratum:birch_sign"]) {
      if (registry.isRegistered(signKey)) {
        signIds.push(registry.getByIdentifier(signKey).id);
      }
    }
    world.setSignBlockIds(signIds);

    if (
      this.adapter.state.status === "connected" &&
      this.adapter.state.role === "client"
    ) {
      world.setAuthoritativeChunkFetcher((cx, cy) =>
        this._awaitChunkFromHost(cx, cy),
      );
    }

    const pipeline = new RenderPipeline({ mount: this.mount });
    progressCallback?.({
      stage: "Initializing renderer",
      detail: "Setting up GPU pipeline...",
    });
    await pipeline.init();
    pipeline.initLighting(world, this.bus, blockAtlas);
    await pipeline.initWeatherOverlay();
    await pipeline.initSkyCelestialTextures();
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
    this._flushPendingAuthoritativeChunks();
    this._flushPendingRemotePlayerPackets();

    if (
      this.adapter.state.status === "connected" &&
      this.adapter.state.role === "host"
    ) {
      world.setNetDropReplicationHook((p) => {
        if (this.adapter.state.status === "connected") {
          this.adapter.broadcast({
            type: MsgType.DROP_SPAWN,
            netId: p.netId,
            itemId: p.itemId,
            count: p.count,
            x: p.x,
            y: p.y,
            vx: p.vx,
            vy: p.vy,
            damage: p.damage,
            pickupDelayMs: p.pickupDelayMs,
          });
        }
      });
      world.setNetArrowReplicationHook((p) => {
        if (this.adapter.state.status === "connected") {
          this.adapter.broadcast({
            type: MsgType.ARROW_SPAWN,
            netArrowId: p.netArrowId,
            x: p.x,
            y: p.y,
            vx: p.vx,
            vy: p.vy,
            damage: p.damage,
            shooterFeetX: p.shooterFeetX,
          });
        }
      });
      world.setNetDropDespawnReplicationHook((p) => {
        if (this.adapter.state.status === "connected") {
          this.adapter.broadcast({
            type: MsgType.DROP_DESPAWN,
            netId: p.netId,
          });
        }
      });
    }

    this._blockInteractions = new BlockInteractions(world, registry, this.bus);
    this._blockInteractions.hydrateWheatSchedulesInLoadedWorld();
    this._blockInteractions.hydrateSugarCaneSchedulesInLoadedWorld();
    this._blockInteractions.hydrateSaplingSchedulesInLoadedWorld();

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

    const audio = this._sharedAudio ?? new AudioEngine();
    this._ownsAudioEngine = this._sharedAudio === undefined;
    audio.setMasterVolume(readVolumeStored(VOL_KEYS.master, 80) / 100);
    audio.setMusicVolume(readVolumeStored(VOL_KEYS.music, 60) / 100);
    audio.setSfxVolume(readVolumeStored(VOL_KEYS.sfx, 100) / 100);
    this.audio = audio;

    const stratumResBase = `${baseUrl}${STRATUM_CORE_RESOURCE_PACK_PATH}`;
    const stratumResManifestRes = await fetch(`${stratumResBase}manifest.json`);
    if (stratumResManifestRes.ok) {
      const stratumResManifest = ResourcePackManifestSchema.parse(
        await stratumResManifestRes.json(),
      );
      for (const rel of stratumResManifest.sounds) {
        await fetchAndLoadSoundManifest(audio, stratumResBase, rel);
      }
    }

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
    pipeline.setBloomMaskPlayerRoot(entityManager.getPlayerGraphic());
    await entityManager.initializeLocalPlayerSkin(this._localSkinId, {
      resolveCustomSkinBlobUrl: async (uuid) => {
        const row = await this.store.getCustomSkin(uuid);
        if (row === undefined) {
          return null;
        }
        return URL.createObjectURL(row.blob);
      },
    });
    this.entityManager = entityManager;
    entityManager.getPlayer().setGameMode(this._worldGameMode);
    this._mobManager = new MobManager(world, lootResolver, this.bus);
    entityManager.setMobManager(this._mobManager);
    {
      const st = this.adapter.state;
      entityManager.setMultiplayerTerrainClient(
        st.status === "connected" && st.role === "client",
      );
    }

    // Host/solo: restore persisted entity positions (mobs + drops) after terrain is loaded.
    {
      const st = this.adapter.state;
      const isClient = st.status === "connected" && st.role === "client";
      if (!isClient) {
        const mobs = metaLoaded?.mobs;
        if (mobs !== undefined && mobs.length > 0) {
          this._mobManager.restoreFromSave(mobs);
        }
        const drops = metaLoaded?.drops;
        if (drops !== undefined && drops.length > 0) {
          for (const d of drops) {
            world.spawnItem(d.itemId as ItemId, d.count, d.x, d.y, d.vx, d.vy, d.damage);
          }
        }
      }
    }

    const saveGame = new SaveGame(
      this.store,
      world,
      entityManager.getPlayer(),
      this.worldUuid,
      this.worldName,
      this.bus,
      () => this._worldTime.ms,
      () => this._worldGameMode,
      () => this._cheatsEnabled,
      () => this.pipeline?.captureWorldPreviewDataUrl() ?? null,
      () =>
        this._shouldPersistModeration()
          ? this._moderation.toPersisted()
          : undefined,
      (into) => {
        for (const [k, v] of this._multiplayerLogoutSpawns) {
          into[k] = v;
        }
        this._multiplayerLogoutSpawns.clear();
      },
      (into) => {
        for (const [k, v] of this._multiplayerSpawnPoints) {
          into[k] = v;
        }
        this._multiplayerSpawnPoints.clear();
      },
      () => this._localSpawnFeet,
      () => {
        const st = this.adapter.state;
        if (st.status === "connected" && st.role === "client") {
          return undefined;
        }
        return this._weather.getRainRemainingSec();
      },
      () => {
        const st = this.adapter.state;
        if (st.status === "connected" && st.role === "client") {
          return [];
        }
        const mm = this._mobManager;
        if (mm === null) {
          return [];
        }
        return [...mm.getAll()].map((m) => ({
          id: m.id,
          type:
            m.kind === "sheep"
              ? MobType.Sheep
              : m.kind === "pig"
                ? MobType.Pig
                : m.kind === "duck"
                  ? MobType.Duck
                : m.kind === "slime"
                  ? MobType.Slime
                  : MobType.Zombie,
          x: m.x,
          y: m.y,
          ...(m.kind === "sheep"
            ? { woolColor: m.woolColor }
            : m.kind === "slime"
              ? { woolColor: m.slimeColor }
              : {}),
          persistent: m.persistent,
        }));
      },
      () => {
        const st = this.adapter.state;
        if (st.status === "connected" && st.role === "client") {
          return [];
        }
        const out: Array<{
          itemId: number;
          count: number;
          damage: number;
          x: number;
          y: number;
          vx: number;
          vy: number;
        }> = [];
        for (const item of world.getDroppedItems().values()) {
          out.push({
            itemId: item.itemId as unknown as number,
            count: item.count,
            damage: item.damage,
            x: item.x,
            y: item.y,
            vx: item.vx,
            vy: item.vy,
          });
        }
        return out;
      },
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
        skinId: entry.skinId,
        localGuestUuid: entry.localGuestUuid,
      } satisfies GameEvent);
    }

    const nametagOverlay = new NametagOverlay();
    nametagOverlay.init(this.mount);
    this._nametagOverlay = nametagOverlay;
    const signHoverOverlay = new SignHoverOverlay();
    signHoverOverlay.init(this.mount);
    this._signHoverOverlay = signHoverOverlay;

    const damageNumbersOverlay = new DamageNumbersOverlay(this.bus);
    damageNumbersOverlay.init(this.mount);
    this._damageNumbersOverlay = damageNumbersOverlay;

    const gpuDebugHud = new GpuDebugHud();
    gpuDebugHud.init(this.mount);
    this._gpuDebugHud = gpuDebugHud;

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

    this.networkUnsubs.push(
      this.bus.on("terrain:net-break-commit", (ev) => {
        const st = this.adapter.state;
        if (st.status !== "connected" || st.role !== "client") {
          return;
        }
        const hid = st.lanHostPeerId;
        if (hid === null) {
          return;
        }
        this.adapter.send(hid as PeerId, {
          type: MsgType.TERRAIN_BREAK_COMMIT,
          wx: ev.wx,
          wy: ev.wy,
          layer: ev.layer === "bg" ? 1 : 0,
          expectedBlockId: ev.expectedBlockId,
          expectedBlockKey: ev.expectedBlockKey,
          hotbarSlot: ev.hotbarSlot,
          heldItemId: ev.heldItemId,
          heldItemKey: ev.heldItemKey,
        });
      }),
    );
    this.networkUnsubs.push(
      this.bus.on("terrain:net-door-toggle", (ev) => {
        const st = this.adapter.state;
        if (st.status !== "connected" || st.role !== "client") {
          return;
        }
        const hid = st.lanHostPeerId;
        if (hid === null) {
          return;
        }
        this.adapter.send(hid as PeerId, {
          type: MsgType.TERRAIN_DOOR_TOGGLE,
          wx: ev.wx,
          wy: ev.wy,
        });
      }),
    );
    this.networkUnsubs.push(
      this.bus.on("terrain:net-place", (ev) => {
        const st = this.adapter.state;
        if (st.status !== "connected" || st.role !== "client") {
          return;
        }
        const hid = st.lanHostPeerId;
        if (hid === null) {
          return;
        }
        this.adapter.send(hid as PeerId, {
          type: MsgType.TERRAIN_PLACE,
          subtype: ev.subtype,
          wx: ev.wx,
          wy: ev.wy,
          hotbarSlot: ev.hotbarSlot,
          placesBlockId: ev.placesBlockId,
          placesBlockKey: ev.placesBlockKey,
          aux: ev.aux,
        });
      }),
    );

    this.networkUnsubs.push(
      this.bus.on("bow:fire-request", (ev) => {
        if (ev.type !== "bow:fire-request") {
          return;
        }
        const st = this.adapter.state;
        if (st.status === "connected" && st.role === "client") {
          return;
        }
        const w = this.world;
        const em = this.entityManager;
        if (w === null || em === null) {
          return;
        }
        const pl = em.getPlayer().state.position;
        const spawnY = pl.y + PLAYER_HEIGHT * 0.5;
        const off = ITEM_THROW_SPAWN_OFFSET_PX + 4;
        const sx = pl.x + ev.dirX * off;
        const sy = spawnY - ev.dirY * off;
        const dmg = Math.max(1, Math.floor(1 + ev.chargeNorm * 8));
        w.spawnArrow(
          sx,
          sy,
          ev.dirX * ev.speedPx,
          ev.dirY * ev.speedPx,
          dmg,
          ev.shooterFeetX,
        );
      }),
    );

    this.networkUnsubs.push(
      this.bus.on("bow:net-fire-request", (ev) => {
        if (ev.type !== "bow:net-fire-request") {
          return;
        }
        const st = this.adapter.state;
        if (st.status !== "connected" || st.role !== "client") {
          return;
        }
        const hid = st.lanHostPeerId;
        if (hid === null) {
          return;
        }
        this.adapter.send(hid as PeerId, {
          type: MsgType.BOW_FIRE_REQUEST,
          dirX: ev.dirX,
          dirY: ev.dirY,
          speedPx: ev.speedPx,
          chargeNorm: ev.chargeNorm,
          shooterFeetX: ev.shooterFeetX,
          shooterFeetY: ev.shooterFeetY,
        });
      }),
    );

    this.bus.on("ui:close-pause", () => {
      if (!this.paused) {
        return;
      }
      this.paused = false;
      this.uiShell?.setPauseOverlayOpen(false);
      this._syncWorldInputBlocked();
    });

    const inventoryUI = new InventoryUI(
      this.mount,
      itemRegistry,
      () => this.entityManager!.getPlayer().inventory,
      (slotIndex, slotEl) => {
        this._handleInventoryShiftQuickMove(slotIndex, slotEl);
      },
      (stack) => {
        const w = this.world;
        const em = this.entityManager;
        const input = this.input;
        if (w === null || em === null || input === null || stack.count <= 0) {
          return;
        }
        const st = em.getPlayer().state;
        const { dirX, dirY } = getItemThrowUnitVectorFromFeet(
          st.position.x,
          st.position.y,
          input.mouseWorldPos.x,
          input.mouseWorldPos.y,
          st.facingRight,
        );
        const spd = ITEM_THROW_SPEED_PX;
        let vx =
          dirX * spd + st.velocity.x * ITEM_THROW_INHERIT_PLAYER_VEL_X;
        let vy = dirY * spd;
        ({ vx, vy } = clampItemThrowVelocity(vx, vy));
        const chestY = st.position.y + PLAYER_HEIGHT * 0.5;
        const off = ITEM_THROW_SPAWN_OFFSET_PX;
        const sx = st.position.x + dirX * off;
        const sy = chestY - dirY * off;
        const net = this.adapter.state;
        if (net.status === "connected" && net.role === "client") {
          const hid = net.lanHostPeerId;
          if (hid !== null) {
            this.adapter.send(hid as PeerId, {
              type: MsgType.THROW_CURSOR_STACK,
              itemId: stack.itemId,
              count: stack.count,
              damage: stack.damage ?? 0,
              x: sx,
              y: sy,
              vx,
              vy,
            });
          }
          return;
        }
        w.spawnItem(
          stack.itemId,
          stack.count,
          sx,
          sy,
          vx,
          vy,
          stack.damage ?? 0,
          ITEM_PLAYER_THROW_PICKUP_DELAY_SEC,
        );
      },
      (slot) => {
        const em = this.entityManager;
        if (em === null) {
          return;
        }
        em.getPlayer().state.hotbarSlot = slot;
        this.bus.emit({ type: "player:hotbarChanged", slot } satisfies GameEvent);
      },
    );
    await inventoryUI.loadTextureIcons();
    inventoryUI.setSandboxHud(this._isSandboxWorld());
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
        getNearStonecutter: () => this._getCraftingStationContext().nearStonecutter,
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
    this._creativePanel = new CreativePanel(
      inventoryUI.getCreativeMount(),
      itemRegistry,
      {
        getItemIconUrlLookup: () => this.inventoryUI?.getItemIconUrlLookup() ?? null,
        onPickItem: (itemId, count, button) => {
          const em = this.entityManager;
          if (em === null || !this._isSandboxWorld()) {
            return;
          }
          const inv = em.getPlayer().inventory;
          if (inv.getCursorStack() !== null) {
            inv.replaceCursorStack(null);
            return;
          }
          if (button !== 0) {
            return;
          }
          if (inv.getCursorStack() === null) {
            inv.replaceCursorStack({ itemId: itemId as ItemId, count });
          } else {
            inv.add(itemId as ItemId, count);
          }
        },
      },
    );

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
      this.bus.on("stonecutter:open-request", (e) => {
        this._handleStonecutterOpenRequest(e.wx, e.wy);
      }),
    );

    this.networkUnsubs.push(
      this.bus.on("furnace:open-request", (e) => {
        this._handleFurnaceOpenRequest(e.wx, e.wy);
      }),
    );

    this.networkUnsubs.push(
      this.bus.on("spawner:open-request", (e) => {
        this._handleSpawnerOpenRequest(e.wx, e.wy);
      }),
    );
    this.networkUnsubs.push(
      this.bus.on("sign:open-request", (e) => {
        this._handleSignOpenRequest(e.wx, e.wy);
      }),
    );

    this.networkUnsubs.push(
      this.bus.on("bed:sleep-request", (e) => {
        void this._handleBedSleepRequest(e.wx, e.wy);
      }),
    );

    this.networkUnsubs.push(
      this.bus.on("door:proximity-swing", (e) => {
        this._sfxFromWorldCell(
          e.wx,
          e.bottomWy,
          e.opening ? getOpenSound("door") : getCloseSound("door"),
          { pitchVariance: 25 },
        );
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
    this.networkUnsubs.push(
      this.bus.on("furnace:cancel-queue-request", (e) => {
        this._handleFurnaceCancelQueueRequest(e.smeltingRecipeId);
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

    const airBlockIdBreakSfx = world.getAirBlockId();
    this.bus.on("game:block-changed", (e) => {
      if (e.blockId !== airBlockIdBreakSfx) {
        return;
      }
      if (
        e.previousBlockId === undefined ||
        e.previousBlockId === airBlockIdBreakSfx
      ) {
        return;
      }
      let def;
      try {
        def = registry.getById(e.previousBlockId);
      } catch {
        return;
      }
      this._sfxFromWorldCell(e.wx, e.wy, getBreakSound(def.material), {
        pitchVariance: 50,
      });
    });

    this.leafFallParticles = new LeafFallParticles(
      this._worldSeed,
      world,
      registry,
      blockAtlas,
      world.getAirBlockId(),
      pipeline,
    );
    this.leafFallParticles.init();

    this.butterflyParticles = new ButterflyAmbientParticles(
      this._worldSeed,
      world,
      registry,
      pipeline,
    );
    await this.butterflyParticles.init();

    this.fireflyParticles = new FireflyAmbientParticles(
      this._worldSeed,
      world,
      pipeline,
    );

    this.bus.on("game:block-changed", (e) => {
      const state = this.adapter.state;
      if (state.status !== "connected" || state.role !== "host") {
        return;
      }
      this._pendingBlockUpdates.push({
        x: e.wx,
        y: e.wy,
        blockId: e.blockId,
        layer: e.layer === "bg" ? 1 : 0,
        cellMetadata: e.layer === "bg" ? 0 : (e.cellMetadata ?? 0),
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
          spawners: world.getSpawnerEntitiesForChunk(cx, cy),
          signs: world.getSignEntitiesForChunk(cx, cy),
        });
      }
    });

    const player = entityManager.getPlayer();
    if (playerSavedState !== undefined) {
      const safeSavedFeet = sanitizePersistedFeetPosition(
        playerSavedState.x,
        playerSavedState.y,
      );
      const spawnYFallback = this._computeWorldSpawnFeetY(world);
      const restoreFeet = safeSavedFeet ?? { x: 0, y: spawnYFallback };
      if (safeSavedFeet === null && import.meta.env.DEV) {
        console.warn("[Game] Invalid saved player feet; falling back to computed spawn.", {
          x: playerSavedState.x,
          y: playerSavedState.y,
          fallback: restoreFeet,
        });
      }
      player.applySavedState(
        restoreFeet.x,
        restoreFeet.y,
        playerSavedState.hotbarSlot,
        playerSavedState.inventory,
        playerSavedState.health,
        playerSavedState.armor,
      );
    } else {
      player.spawnAt(0, this._computeWorldSpawnFeetY(world));
    }

    if (this._pendingAssignedSpawn !== null) {
      const ps = this._pendingAssignedSpawn;
      this._pendingAssignedSpawn = null;
      this._applyAssignedSpawn(ps.x, ps.y);
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
    this._deathModalOpen = false;
    this._localDeathNotified = false;
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
    if (this._pendingAssignedSpawn !== null) {
      const ps = this._pendingAssignedSpawn;
      this._pendingAssignedSpawn = null;
      this._applyAssignedSpawn(ps.x, ps.y);
    }
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
      this._flushLocalCursorStackForClose();
      await sg.save();
      sg.destroy();
    }

    this.cursorStackUI?.destroy();
    this.cursorStackUI = null;
    this._craftingPanel?.destroy();
    this._craftingPanel = null;
    this._creativePanel?.destroy();
    this._creativePanel = null;
    this._closeSpawnerModal();
    this._closeSignModal();
    this.inventoryUI?.destroy();
    this.inventoryUI = null;
    this._craftingSystem = null;
    this.isInventoryOpen = false;
    this.paused = false;
    this._deathModalOpen = false;
    this._localDeathNotified = false;
    this.uiShell?.setDeathOverlayOpen(false);
    this._chatOverlay?.destroy();
    this._chatOverlay = null;
    this._nametagOverlay?.destroy();
    this._nametagOverlay = null;
    this._signHoverOverlay?.destroy();
    this._signHoverOverlay = null;
    this._damageNumbersOverlay?.destroy();
    this._damageNumbersOverlay = null;
    this._gpuDebugHud?.destroy();
    this._gpuDebugHud = null;
    this._chatHost = null;
    this.uiShell?.destroy();
    this.uiShell = null;
    this.audio?.stopSfxAmbientLoop();
    this._rainAmbientActive = false;
    if (this._ownsAudioEngine) {
      this.audio?.destroy();
    }
    this.audio = null;
    this.breakOverlay?.destroy();
    this.breakOverlay = null;
    this.blockBreakParticles?.destroy();
    this.blockBreakParticles = null;
    this.leafFallParticles?.destroy();
    this.leafFallParticles = null;
    this.butterflyParticles?.destroy();
    this.butterflyParticles = null;
    this.fireflyParticles?.destroy();
    this.fireflyParticles = null;
    this._mobManager?.clear();
    this._mobManager = null;
    this._sheepAmbientSfxById.clear();
    this._pigAmbientSfxById.clear();
    this._duckAmbientSfxById.clear();
    this._mobHurtSfxAtMs.clear();
    this.entityManager?.destroy();
    this.entityManager = null;
    this.input?.destroy();
    this.input = null;
    this.chunkRenderer?.destroy();
    this.chunkRenderer = null;
    this.lastRenderWallMs = 0;
    this._foliageBendLatchLocal = 0;
    this._foliageBendLatchRemote.clear();
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
      this.bus.on("net:handshake-success", () => {
        this._playerStateBroadcaster.invalidateSnapshot();
        this.audio?.onNetworkSessionReady();
        // If local skin is custom, send the PNG bytes to connected peers.
        if (this._localSkinId !== null && this._localSkinId.startsWith("custom:")) {
          void this._sendLocalCustomSkinData();
        }
      }),
    );
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

        if (msg.type === MsgType.PLAYER_DAMAGE_APPLIED) {
          if (stNet.status === "connected" && stNet.role === "client") {
            this.entityManager?.getPlayer().takeDamage(msg.damage);
          }
          return;
        }

        if (msg.type === MsgType.PLAYER_TELEPORT) {
          if (stNet.status === "connected" && stNet.role === "client") {
            this.entityManager?.getPlayer().spawnAt(msg.x, msg.y);
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
          const ck = `${msg.cx},${msg.cy}`;
          const tReq = this._chunkRequestSentAtMs.get(ck);
          if (tReq !== undefined) {
            this._chunkRequestSentAtMs.delete(ck);
            if (import.meta.env.DEV) {
              // eslint-disable-next-line no-console -- dev-only multiplayer chunk latency probe
              console.debug(
                `[net] chunk ${ck} RTT ${Math.round(performance.now() - tReq)}ms`,
              );
            }
          }
          const blocks = msg.blocks.slice();
          const background = msg.background?.slice();
          const furnaces = msg.furnaces?.map((f) => ({ ...f }));
          const chests = msg.chests?.map((c) => ({ ...c }));
          const spawners = msg.spawners?.map((s) => ({ ...s, spawnPotentials: [...s.spawnPotentials] }));
          const signs = msg.signs?.map((s) => ({ ...s }));
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
              spawners,
              signs,
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
              spawners,
              signs,
              metadata,
            );
          }
          this._resolveChunkFetchIfPending(msg.cx, msg.cy);
          return;
        }
        if (msg.type === MsgType.TERRAIN_ACK) {
          if (stNet.status === "connected" && stNet.role === "client") {
            this._applyTerrainAck(msg);
          }
          return;
        }
        if (msg.type === MsgType.DROP_SPAWN && this.world !== null) {
          if (stNet.status === "connected" && stNet.role === "client") {
            this.world.applyAuthoritativeDropSpawn({
              netId: msg.netId,
              itemId: msg.itemId,
              count: msg.count,
              x: msg.x,
              y: msg.y,
              vx: msg.vx,
              vy: msg.vy,
              damage: msg.damage,
              pickupDelayMs: msg.pickupDelayMs,
            });
          }
          return;
        }
        if (msg.type === MsgType.DROP_DESPAWN && this.world !== null) {
          this.world.removeAuthoritativeDropByNetId(msg.netId);
          return;
        }
        if (msg.type === MsgType.ENTITY_SPAWN && this._mobManager !== null) {
          if (stNet.status === "connected" && stNet.role === "client") {
            this._mobManager.applyNetworkSpawn(
              msg.entityId,
              msg.entityType,
              msg.x,
              msg.y,
              msg.woolColor ?? 0,
            );
            if (
              msg.spawnerFxWx !== undefined &&
              msg.spawnerFxWy !== undefined &&
              this.world !== null
            ) {
              this.bus.emit({
                type: "fx:spawner-spawn",
                wx: msg.spawnerFxWx,
                wy: msg.spawnerFxWy,
                blockId: this.world.getBlock(msg.spawnerFxWx, msg.spawnerFxWy).id,
              } satisfies GameEvent);
            }
          }
          return;
        }
        if (msg.type === MsgType.ENTITY_STATE && this._mobManager !== null) {
          if (stNet.status === "connected" && stNet.role === "client") {
            this._mobManager.applyEntityStateFromWire({
              entityId: msg.entityId,
              entityType: msg.entityType,
              x: msg.x,
              y: msg.y,
              vx: msg.vx,
              vy: msg.vy,
              hp: msg.hp,
              flags: msg.flags,
              woolColor: msg.woolColor ?? 0,
              deathAnim10Ms: msg.deathAnim10Ms,
            });
          }
          return;
        }
        if (msg.type === MsgType.ENTITY_DESPAWN && this._mobManager !== null) {
          if (stNet.status === "connected" && stNet.role === "client") {
            this._mobManager.applyNetworkDespawn(msg.entityId);
          }
          return;
        }
        if (
          msg.type === MsgType.ENTITY_HIT_REQUEST &&
          stNet.status === "connected" &&
          stNet.role === "host" &&
          this.world !== null &&
          this._mobManager !== null
        ) {
          const rng = this.world.forkMobRng();
          const localId = this.adapter.getLocalPeerId();
          const remoteAttacker =
            localId !== null && e.peerId !== localId;
          let attackerFeetX = this.entityManager?.getPlayer().state.position.x ?? 0;
          if (remoteAttacker) {
            const rp = this.world.getRemotePlayers().get(e.peerId);
            if (rp !== undefined) {
              attackerFeetX = rp.getAuthorityFeet().x;
            }
          }
          const heldItemId =
            msg.heldItemId !== undefined ? msg.heldItemId : 0;
          const def = this._itemRegistry?.getById(heldItemId as ItemId);
          const dmg = meleeDamageFromHeldItemId(def, heldItemId);
          const hitResult = this._mobManager.damageMobFromHost(
            msg.entityId,
            rng,
            attackerFeetX,
            dmg,
            {
              style: "melee",
              baseKnockback: meleeBaseKnockbackFromHeldItemId(def, heldItemId),
            },
            { emitDamageFx: !remoteAttacker },
          );
          if (hitResult.ok && hitResult.dealt > 0) {
            this._playMobHurtVocalSfx(msg.entityId);
          }
          if (
            remoteAttacker &&
            hitResult.ok &&
            hitResult.dealt > 0
          ) {
            const mob = this._mobManager.getById(msg.entityId);
            if (mob !== undefined) {
              const { h } = mobHitboxSizePx(mob.kind);
              const jitter = (Math.random() - 0.5) * 16;
              this.adapter.send(e.peerId as PeerId, {
                type: MsgType.MOB_HIT_FEEDBACK,
                entityId: msg.entityId,
                damage: hitResult.dealt,
                worldAnchorX: mob.x + jitter,
                worldAnchorY: mob.y + h * 0.52,
              });
            }
          }
          return;
        }
        if (
          msg.type === MsgType.PLAYER_HIT_REQUEST &&
          stNet.status === "connected" &&
          stNet.role === "host" &&
          this.world !== null &&
          this.entityManager !== null
        ) {
          if (msg.targetPeerId === e.peerId) {
            return;
          }
          const localPeer = this.adapter.getLocalPeerId();
          let attackerFeetX = this.entityManager.getPlayer().state.position.x;
          let attackerFeetY = this.entityManager.getPlayer().state.position.y;
          if (localPeer !== null && e.peerId !== localPeer) {
            const attacker = this.world.getRemotePlayers().get(e.peerId);
            if (attacker === undefined) {
              return;
            }
            const f = attacker.getAuthorityFeet();
            attackerFeetX = f.x;
            attackerFeetY = f.y;
          }
          let targetFeetX = 0;
          let targetFeetY = 0;
          if (localPeer !== null && msg.targetPeerId === localPeer) {
            targetFeetX = this.entityManager.getPlayer().state.position.x;
            targetFeetY = this.entityManager.getPlayer().state.position.y;
          } else {
            const target = this.world.getRemotePlayers().get(msg.targetPeerId);
            if (target === undefined) {
              return;
            }
            const f = target.getAuthorityFeet();
            targetFeetX = f.x;
            targetFeetY = f.y;
          }
          const maxReachPx = (REACH_BLOCKS + 0.75) * BLOCK_SIZE;
          const dx = targetFeetX - attackerFeetX;
          const dy = targetFeetY - attackerFeetY;
          if (dx * dx + dy * dy > maxReachPx * maxReachPx) {
            return;
          }
          const heldItemId = msg.heldItemId !== undefined ? msg.heldItemId : 0;
          const def = this._itemRegistry?.getById(heldItemId as ItemId);
          const dmg = meleeDamageFromHeldItemId(def, heldItemId);
          if (dmg <= 0) {
            return;
          }
          this._hostApplyPlayerDamageByPeerId(msg.targetPeerId, dmg);
          return;
        }
        if (
          msg.type === MsgType.BOW_FIRE_REQUEST &&
          stNet.status === "connected" &&
          stNet.role === "host" &&
          this.world !== null
        ) {
          const w = this.world;
          const spawnY = msg.shooterFeetY + PLAYER_HEIGHT * 0.5;
          const off = ITEM_THROW_SPAWN_OFFSET_PX + 4;
          const sx = msg.shooterFeetX + msg.dirX * off;
          const sy = spawnY - msg.dirY * off;
          const dmg = Math.max(1, Math.floor(1 + msg.chargeNorm * 8));
          w.spawnArrow(
            sx,
            sy,
            msg.dirX * msg.speedPx,
            msg.dirY * msg.speedPx,
            dmg,
            msg.shooterFeetX,
          );
          return;
        }
        if (msg.type === MsgType.MOB_HIT_FEEDBACK) {
          if (stNet.status === "connected" && stNet.role === "client") {
            if (msg.damage > 0) {
              this.bus.emit({
                type: "fx:damage-number",
                worldAnchorX: msg.worldAnchorX,
                worldAnchorY: msg.worldAnchorY,
                damage: msg.damage,
              } satisfies GameEvent);
            }
            this.entityManager?.bumpMobHealthBar(msg.entityId);
          }
          return;
        }
        if (msg.type === MsgType.ARROW_SPAWN && this.world !== null) {
          if (stNet.status === "connected" && stNet.role === "client") {
            this.world.applyAuthoritativeArrowSpawn({
              netArrowId: msg.netArrowId,
              x: msg.x,
              y: msg.y,
              vx: msg.vx,
              vy: msg.vy,
              damage: msg.damage,
              shooterFeetX: msg.shooterFeetX,
            });
          }
          return;
        }
        if (
          msg.type === MsgType.CHUNK_REQUEST &&
          stNet.status === "connected" &&
          stNet.role === "host"
        ) {
          void this._hostHandleChunkRequest(e.peerId as PeerId, msg.cx, msg.cy);
          return;
        }
        if (
          msg.type === MsgType.TERRAIN_BREAK_COMMIT &&
          stNet.status === "connected" &&
          stNet.role === "host"
        ) {
          this._hostHandleTerrainBreakCommit(e.peerId, msg);
          return;
        }
        if (
          msg.type === MsgType.TERRAIN_DOOR_TOGGLE &&
          stNet.status === "connected" &&
          stNet.role === "host"
        ) {
          this._hostHandleTerrainDoorToggle(e.peerId, msg.wx, msg.wy);
          return;
        }
        if (
          msg.type === MsgType.TERRAIN_PLACE &&
          stNet.status === "connected" &&
          stNet.role === "host"
        ) {
          this._hostHandleTerrainPlace(e.peerId, msg);
          return;
        }
        if (
          msg.type === MsgType.DROP_PICKUP_REQUEST &&
          stNet.status === "connected" &&
          stNet.role === "host"
        ) {
          this._hostHandleDropPickupRequest(e.peerId as PeerId, msg.netId);
          return;
        }
        if (
          msg.type === MsgType.THROW_CURSOR_STACK &&
          stNet.status === "connected" &&
          stNet.role === "host"
        ) {
          this._hostHandleThrowCursorStack(e.peerId, msg);
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
        if (
          msg.type === MsgType.CHEST_TAKE_REQUEST &&
          stNet.status === "connected" &&
          stNet.role === "host"
        ) {
          const w = this.world;
          const ir = this._itemRegistry;
          if (w === null || ir === null) {
            return;
          }
          const anchor = { ax: msg.wx, ay: msg.wy };
          if (!this._chestWithinReachForPeer(anchor, e.peerId)) {
            return;
          }
          const tile = w.getChestTileAtAnchor(anchor.ax, anchor.ay);
          if (tile === undefined) {
            return;
          }
          const s = tile.slots[msg.slotIndex];
          if (s === undefined || s === null || s.count <= 0) {
            return;
          }
          const take = msg.button === 2 ? 1 : s.count;
          const left = s.count - take;
          const nextSlots = tile.slots.map((x) => (x === null ? null : { ...x }));
          nextSlots[msg.slotIndex] =
            left > 0 ? { itemId: s.itemId, count: left } : null;
          w.setChestTileAtAnchor(anchor.ax, anchor.ay, { slots: nextSlots });
          this._broadcastChestSnapshotNow(anchor.ax, anchor.ay);
          this.adapter.send(e.peerId as PeerId, {
            type: MsgType.GIVE_ITEM_STACK,
            itemId: s.itemId as number,
            count: take,
          });
          return;
        }
        if (
          msg.type === MsgType.FURNACE_SLOT_REQUEST &&
          stNet.status === "connected" &&
          stNet.role === "host"
        ) {
          const w = this.world;
          const ir = this._itemRegistry;
          if (w === null || ir === null) {
            return;
          }
          if (!this._furnaceWithinReachForPeer(msg.wx, msg.wy, e.peerId)) {
            return;
          }
          const tile =
            w.getFurnaceTile(msg.wx, msg.wy) ??
            createEmptyFurnaceTileState(this._worldTime.ms);
          let taken: { itemId: number; count: number } | null = null;
          if (msg.kind === 0) {
            const fuel = tile.fuel;
            if (fuel !== null && fuel.count > 0) {
              const take = msg.button === 2 ? 1 : fuel.count;
              const left = fuel.count - take;
              tile.fuel = left > 0 ? { itemId: fuel.itemId, count: left } : null;
              taken = { itemId: fuel.itemId as number, count: take };
            }
          } else {
            const idx = msg.slotIndex | 0;
            const out = tile.outputSlots[idx];
            if (out !== undefined && out !== null && out.count > 0) {
              const take = msg.button === 2 ? 1 : out.count;
              const left = out.count - take;
              tile.outputSlots = tile.outputSlots.map((x, i) => {
                if (i !== idx) return x;
                return left > 0 ? { itemId: out.itemId, count: left } : null;
              });
              taken = { itemId: out.itemId as number, count: take };
            }
          }
          if (taken === null) {
            return;
          }
          w.setFurnaceTile(msg.wx, msg.wy, tile);
          this._broadcastFurnaceSnapshotNow(msg.wx, msg.wy);
          this.adapter.send(e.peerId as PeerId, {
            type: MsgType.GIVE_ITEM_STACK,
            itemId: taken.itemId,
            count: taken.count,
          });
          return;
        }
        if (
          msg.type === MsgType.CHEST_PUT_REQUEST &&
          stNet.status === "connected" &&
          stNet.role === "host"
        ) {
          const w = this.world;
          const ir = this._itemRegistry;
          if (w === null || ir === null) {
            return;
          }
          const anchor = { ax: msg.wx, ay: msg.wy };
          if (!this._chestWithinReachForPeer(anchor, e.peerId)) {
            return;
          }
          const tile = w.getChestTileAtAnchor(anchor.ax, anchor.ay);
          if (tile === undefined) {
            return;
          }
          const curCount = msg.cursorCount | 0;
          if (curCount <= 0 || msg.cursorItemId <= 0) {
            return;
          }
          const cursor = {
            itemId: msg.cursorItemId as ItemId,
            count: curCount,
            ...(msg.cursorDamage > 0 ? { damage: msg.cursorDamage } : {}),
          };
          const maxStack = (id: ItemId) => this._maxStackForItem(id);
          const { state: next } = applyChestSlotMouse(
            tile,
            msg.slotIndex,
            msg.button,
            cursor,
            maxStack,
          );
          w.setChestTileAtAnchor(anchor.ax, anchor.ay, next);
          this._broadcastChestSnapshotNow(anchor.ax, anchor.ay);
          return;
        }
        if (
          msg.type === MsgType.CHEST_QUICKMOVE_TO_CHEST &&
          stNet.status === "connected" &&
          stNet.role === "host"
        ) {
          const w = this.world;
          const ir = this._itemRegistry;
          if (w === null || ir === null) {
            return;
          }
          const anchor = { ax: msg.wx, ay: msg.wy };
          if (!this._chestWithinReachForPeer(anchor, e.peerId)) {
            return;
          }
          const tile = w.getChestTileAtAnchor(anchor.ax, anchor.ay);
          if (tile === undefined) {
            return;
          }
          if (msg.itemId <= 0 || msg.count <= 0) {
            return;
          }
          const stack = {
            itemId: msg.itemId as ItemId,
            count: msg.count,
            ...(msg.damage > 0 ? { damage: msg.damage } : {}),
          };
          const maxStack = (id: ItemId) => this._maxStackForItem(id);
          const { state: next } = quickMoveStackIntoChest(tile, stack, maxStack);
          w.setChestTileAtAnchor(anchor.ax, anchor.ay, next);
          this._broadcastChestSnapshotNow(anchor.ax, anchor.ay);
          return;
        }
        if (this._awaitingWorldData && msg.type === MsgType.WORLD_SYNC) {
          this._worldSeed = msg.seed;
          this._worldTime.sync(msg.worldTimeMs);
          this._worldGameMode = normalizeWorldGameMode(msg.gameMode);
          this._worldGenType = normalizeWorldGenType(msg.worldGenType);
          this._cheatsEnabled = msg.cheatsEnabled;
          this.entityManager?.getPlayer().setGameMode(this._worldGameMode);
          this._awaitingWorldData = false;
          return;
        }
        if (msg.type === MsgType.WORLD_TIME) {
          this._worldTime.sync(msg.worldTimeMs);
          return;
        }
        if (msg.type === MsgType.WEATHER_SYNC) {
          if (stNet.status === "connected" && stNet.role === "client") {
            this._clientRainRemainingSec = Math.max(0, msg.rainRemainingSec);
          }
          return;
        }
        if (msg.type === MsgType.WEATHER_LIGHTNING) {
          this._playLightningStrikeLocal();
          return;
        }
        if (msg.type === MsgType.SLEEP_TRANSITION) {
          const stand = this._pendingLocalSleepStandFeet;
          this._pendingLocalSleepStandFeet = null;
          void this._playLocalSleepTransition(msg.durationMs, stand);
          return;
        }
        if (
          msg.type === MsgType.SLEEP_REQUEST &&
          stNet.status === "connected" &&
          stNet.role === "host"
        ) {
          const w = this.world;
          if (w === null) {
            return;
          }
          if (!this._bedWithinReachForPeer(msg.wx, msg.wy, e.peerId)) {
            return;
          }
          const bedCells = this._resolveFullBedCells(msg.wx, msg.wy);
          if (bedCells === null) {
            return;
          }
          // Set peer spawnpoint to this bed's centered feet.
          const stand = this._bedStandFeetFromCells(bedCells);
          const roster = this._sessionRoster.get(e.peerId);
          if (roster !== undefined) {
            const key = multiplayerPersistKey(
              roster.accountId,
              roster.displayName,
              roster.localGuestUuid,
            );
            this._multiplayerSpawnPoints.set(key, { x: stand.x, y: stand.y });
            void this.saveGame?.save();
          }
          // Also send assignment immediately so the client updates its spawnpoint.
          this.adapter.send(e.peerId as PeerId, {
            type: MsgType.ASSIGNED_SPAWN,
            x: stand.x,
            y: stand.y,
          });
          // Register this peer as sleeping; trigger only when majority is reached.
          this._sleepVotePeerIds.add(e.peerId);
          this._maybeTriggerSleepSkipFromVotes();
          return;
        }
        if (msg.type === MsgType.ASSIGNED_SPAWN) {
          if (!this.started) {
            this._pendingAssignedSpawn = { x: msg.x, y: msg.y };
            return;
          }
          if (this.entityManager === null) {
            this._pendingAssignedSpawn = { x: msg.x, y: msg.y };
            return;
          }
          this._applyAssignedSpawn(msg.x, msg.y);
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
        if (msg.type === MsgType.BLOCK_UPDATE_BATCH && this.world !== null) {
          for (const entry of msg.entries) {
            if (entry.layer === 1) {
              this.world.setBackgroundBlock(entry.x, entry.y, entry.blockId);
              this.world.clearRemoteBreakMiningAtWorldCell(entry.x, entry.y, "bg");
            } else {
              this.world.setBlock(entry.x, entry.y, entry.blockId, {
                cellMetadata: entry.cellMetadata,
              });
              this.world.clearRemoteBreakMiningAtWorldCell(entry.x, entry.y, "fg");
            }
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
        if (msg.type === MsgType.PLAYER_STATE_RELAY) {
          if (
            stNet.status === "connected" &&
            stNet.role === "client" &&
            this.world === null
          ) {
            this._pendingRemotePlayerPackets.push({ kind: "relay", msg });
            return;
          }
          if (
            this.world !== null &&
            stNet.status === "connected" &&
            stNet.role === "client"
          ) {
            this.world.updateRemotePlayer(
              msg.subjectPeerId,
              msg.x,
              msg.y,
              msg.vx,
              msg.vy,
              msg.facingRight,
              msg.hotbarSlot,
              msg.heldItemId,
              msg.miningVisual,
              msg.armorHelmetId ?? 0,
              msg.armorChestId ?? 0,
              msg.armorLeggingsId ?? 0,
              msg.armorBootsId ?? 0,
              msg.bowDrawQuantized ?? 0,
              msg.aimDisplayX ?? 0,
              msg.aimDisplayY ?? 0,
            );
          }
          return;
        }
        if (msg.type === MsgType.PLAYER_STATE) {
          if (this.world === null) {
            this._pendingRemotePlayerPackets.push({
              kind: "direct",
              senderPeerId: e.peerId,
              msg,
            });
            return;
          }
          this.world.updateRemotePlayer(
            e.peerId,
            msg.x,
            msg.y,
            msg.vx,
            msg.vy,
            msg.facingRight,
            msg.hotbarSlot,
            msg.heldItemId,
            msg.miningVisual,
            msg.armorHelmetId ?? 0,
            msg.armorChestId ?? 0,
            msg.armorLeggingsId ?? 0,
            msg.armorBootsId ?? 0,
            msg.bowDrawQuantized ?? 0,
            msg.aimDisplayX ?? 0,
            msg.aimDisplayY ?? 0,
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
                hotbarSlot: msg.hotbarSlot,
                heldItemId: msg.heldItemId,
                miningVisual: msg.miningVisual,
                armorHelmetId: msg.armorHelmetId ?? 0,
                armorChestId: msg.armorChestId ?? 0,
                armorLeggingsId: msg.armorLeggingsId ?? 0,
                armorBootsId: msg.armorBootsId ?? 0,
                bowDrawQuantized: msg.bowDrawQuantized ?? 0,
                aimDisplayX: msg.aimDisplayX ?? 0,
                aimDisplayY: msg.aimDisplayY ?? 0,
              });
            }
          }
          return;
        }

        if (msg.type === MsgType.PLAYER_SKIN_DATA) {
          if (msg.skinPngBytes.length > PLAYER_SKIN_DATA_MAX_BYTES) {
            return;
          }
          const subjectPeer = msg.subjectPeerId || e.peerId;
          const blob = new Blob([msg.skinPngBytes], { type: "image/png" });
          const blobUrl = URL.createObjectURL(blob);
          const rosterEntry = this._sessionRoster.get(subjectPeer);
          const skinId = rosterEntry?.skinId ?? `custom:${subjectPeer}`;
          if (this.entityManager !== null) {
            void this.entityManager.loadRemoteSkinTextures(subjectPeer, skinId, blobUrl);
          }
          if (stNet.status === "connected" && stNet.role === "host") {
            const localId = this.adapter.getLocalPeerId();
            if (localId !== null && e.peerId !== localId) {
              this.adapter.broadcastExcept(e.peerId as PeerId, {
                type: MsgType.PLAYER_SKIN_DATA,
                subjectPeerId: subjectPeer,
                skinPngBytes: msg.skinPngBytes,
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
          skinId: e.skinId,
          localGuestUuid: e.localGuestUuid,
        });

        // Load remote peer's skin (built-in skins resolve immediately;
        // custom skins wait for PLAYER_SKIN_DATA follow-up).
        if (e.skinId !== "" && this.entityManager !== null) {
          const localId = this.adapter.getLocalPeerId();
          if (e.peerId !== localId) {
            void this.entityManager.loadRemoteSkinTextures(e.peerId, e.skinId);
          }
        }

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
        const wLeave = this.world;
        const sg = this.saveGame;
        if (
          wLeave !== null &&
          sg !== null &&
          st.status === "connected" &&
          st.role === "host"
        ) {
          const rp = wLeave.getRemotePlayers().get(e.peerId);
          const rosterEntry = this._sessionRoster.get(e.peerId);
          if (rp !== undefined && rosterEntry !== undefined) {
            const feet = rp.getAuthorityFeet();
            const key = multiplayerPersistKey(
              rosterEntry.accountId,
              rosterEntry.displayName,
              rosterEntry.localGuestUuid,
            );
            this._multiplayerLogoutSpawns.set(key, {
              x: feet.x,
              y: feet.y,
            });
            void sg.save();
          }
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
            gameMode: this._worldGameMode,
            worldGenType: this._worldGenType,
            cheatsEnabled: this._cheatsEnabled,
          });
          this.adapter.broadcast({
            type: MsgType.WORLD_TIME,
            worldTimeMs: this._worldTime.ms,
          });
          this.adapter.send(newPeer, {
            type: MsgType.WEATHER_SYNC,
            rainRemainingSec: this._weather.getRainRemainingSec(),
          });
          void (async () => {
            let meta: WorldMetadata | undefined;
            try {
              meta = await this.store.loadWorld(this.worldUuid);
              const r = resolveWorldWorkshopStacks(meta, this._modRepository);
              this.adapter.send(newPeer, {
                type: MsgType.PACK_STACK,
                behaviorRefs: r.behaviorRefs,
                resourceRefs: r.resourceRefs,
                requirePacksBeforeJoin: r.requirePacksBeforeJoin,
              });
            } catch (err) {
              console.error(err);
              meta = undefined;
              this.adapter.send(newPeer, {
                type: MsgType.PACK_STACK,
                behaviorRefs: [],
                resourceRefs: [],
                requirePacksBeforeJoin: false,
              });
            }
            const rosterJoin = this._sessionRoster.get(newPeer);
            if (
              rosterJoin !== undefined &&
              meta?.multiplayerLastPositions !== undefined
            ) {
              const key = multiplayerPersistKey(
                rosterJoin.accountId,
                rosterJoin.displayName,
                rosterJoin.localGuestUuid,
              );
              const sp =
                meta.multiplayerSpawnPoints?.[key] ??
                meta.multiplayerLastPositions?.[key];
              if (sp !== undefined) {
                this.adapter.send(newPeer, {
                  type: MsgType.ASSIGNED_SPAWN,
                  x: sp.x,
                  y: sp.y,
                });
              }
            }
          })();
          const world = this.world;
          if (world !== null) {
            const hostEm = this.entityManager;
            const hostPos = hostEm !== null
              ? hostEm.getPlayer().state.position
              : { x: 0, y: 0 };
            const spawnCx = Math.floor(hostPos.x / BLOCK_SIZE / CHUNK_SIZE);
            const spawnCy = Math.floor(hostPos.y / BLOCK_SIZE / CHUNK_SIZE);
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
                  spawners: world.getSpawnerEntitiesForChunk(chunk.coord.cx, chunk.coord.cy),
                  signs: world.getSignEntitiesForChunk(chunk.coord.cx, chunk.coord.cy),
                });
              }
            }, spawnCx, spawnCy);
            for (const [dropId, d] of world.getDroppedItems()) {
              if (!dropId.startsWith("n") || dropId.length <= 1) {
                continue;
              }
              const netId = Number.parseInt(dropId.slice(1), 10);
              if (!Number.isFinite(netId)) {
                continue;
              }
              this.adapter.send(newPeer, {
                type: MsgType.DROP_SPAWN,
                netId,
                itemId: d.itemId,
                count: d.count,
                x: d.x,
                y: d.y,
                vx: d.vx,
                vy: d.vy,
                damage: d.damage,
                pickupDelayMs: Math.min(
                  65535,
                  Math.max(0, Math.round(d.pickupDelayRemainSec * 1000)),
                ),
              });
            }
            for (const [arrowId, ar] of world.getArrows()) {
              if (!arrowId.startsWith("a") || arrowId.length <= 1) {
                continue;
              }
              const netArrowId = Number.parseInt(arrowId.slice(1), 10);
              if (!Number.isFinite(netArrowId)) {
                continue;
              }
              this.adapter.send(newPeer, {
                type: MsgType.ARROW_SPAWN,
                netArrowId,
                x: ar.x,
                y: ar.y,
                vx: ar.vx,
                vy: ar.vy,
                damage: ar.damage,
                shooterFeetX: ar.shooterFeetX,
              });
            }
          }
          this._playerStateBroadcaster.invalidateSnapshot();
          const localId = this.adapter.getLocalPeerId();
          const em = this.entityManager;
          if (world !== null && em !== null && localId !== null) {
            const st = em.getPlayer().state;
            const pose = em.getLocalPlayerNetworkPoseExtras();
            this.adapter.send(newPeer, {
              type: MsgType.PLAYER_STATE,
              playerId: 0,
              x: st.position.x,
              y: st.position.y,
              vx: st.velocity.x,
              vy: st.velocity.y,
              facingRight: st.facingRight,
              hotbarSlot: pose.hotbarSlot,
              heldItemId: pose.heldItemId,
              miningVisual: pose.miningVisual,
              armorHelmetId: pose.armorHelmetId,
              armorChestId: pose.armorChestId,
              armorLeggingsId: pose.armorLeggingsId,
              armorBootsId: pose.armorBootsId,
              bowDrawQuantized: pose.bowDrawQuantized,
              aimDisplayX: pose.aimDisplayX,
              aimDisplayY: pose.aimDisplayY,
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

  private _flushPendingRemotePlayerPackets(): void {
    const w = this.world;
    if (w === null || this._pendingRemotePlayerPackets.length === 0) {
      return;
    }
    const st = this.adapter.state;
    for (const p of this._pendingRemotePlayerPackets) {
      if (p.kind === "relay") {
        const m = p.msg;
        w.updateRemotePlayer(
          m.subjectPeerId,
          m.x,
          m.y,
          m.vx,
          m.vy,
          m.facingRight,
          m.hotbarSlot,
          m.heldItemId,
          m.miningVisual,
          m.armorHelmetId ?? 0,
          m.armorChestId ?? 0,
          m.armorLeggingsId ?? 0,
          m.armorBootsId ?? 0,
          m.bowDrawQuantized ?? 0,
          m.aimDisplayX ?? 0,
          m.aimDisplayY ?? 0,
        );
        continue;
      }
      const m = p.msg;
      w.updateRemotePlayer(
        p.senderPeerId,
        m.x,
        m.y,
        m.vx,
        m.vy,
        m.facingRight,
        m.hotbarSlot,
        m.heldItemId,
        m.miningVisual,
        m.armorHelmetId ?? 0,
        m.armorChestId ?? 0,
        m.armorLeggingsId ?? 0,
        m.armorBootsId ?? 0,
        m.bowDrawQuantized ?? 0,
        m.aimDisplayX ?? 0,
        m.aimDisplayY ?? 0,
      );
      if (st.status === "connected" && st.role === "host") {
        const localId = this.adapter.getLocalPeerId();
        if (localId !== null && p.senderPeerId !== localId) {
          this.adapter.broadcastExcept(p.senderPeerId as PeerId, {
            type: MsgType.PLAYER_STATE_RELAY,
            subjectPeerId: p.senderPeerId,
            x: m.x,
            y: m.y,
            vx: m.vx,
            vy: m.vy,
            facingRight: m.facingRight,
            hotbarSlot: m.hotbarSlot,
            heldItemId: m.heldItemId,
            miningVisual: m.miningVisual,
            armorHelmetId: m.armorHelmetId ?? 0,
            armorChestId: m.armorChestId ?? 0,
            armorLeggingsId: m.armorLeggingsId ?? 0,
            armorBootsId: m.armorBootsId ?? 0,
            bowDrawQuantized: m.bowDrawQuantized ?? 0,
            aimDisplayX: m.aimDisplayX ?? 0,
            aimDisplayY: m.aimDisplayY ?? 0,
          });
        }
      }
    }
    this._pendingRemotePlayerPackets.length = 0;
  }

  private _applyAssignedSpawn(x: number, y: number): void {
    const em = this.entityManager;
    if (em === null) {
      return;
    }
    const safeSpawn = sanitizePersistedFeetPosition(x, y);
    if (safeSpawn === null) {
      if (import.meta.env.DEV) {
        console.warn("[Game] Ignored invalid assigned spawn from network.", { x, y });
      }
      return;
    }
    const pl = em.getPlayer().state;
    pl.position.x = safeSpawn.x;
    pl.position.y = safeSpawn.y;
    pl.prevPosition.x = safeSpawn.x;
    pl.prevPosition.y = safeSpawn.y;
    pl.velocity.x = 0;
    pl.velocity.y = 0;
    this._localSpawnFeet = safeSpawn;
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
        skinId: this._localSkinId ?? "",
        localGuestUuid: this._localGuestUuid ?? "",
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
      executeWeather: (issuerPeerId, rest) => {
        this._executeWeatherCommand(issuerPeerId, rest);
      },
      executeSummon: (issuerPeerId, rest) => {
        this._executeSummonCommand(issuerPeerId, rest);
      },
      executeKillAll: (issuerPeerId, rest) => {
        this._executeKillAllCommand(issuerPeerId, rest);
      },
      executeTeleport: (issuerPeerId, rest) => {
        this._runTeleportCore(issuerPeerId, rest);
      },
      executeStructure: (issuerPeerId, rest) => {
        this._executeStructureCommand(issuerPeerId, rest);
      },
      executeWand: (issuerPeerId, rest) => {
        this._executeWandCommand(issuerPeerId, rest);
      },
      isCheatsEnabled: () => this._cheatsEnabled,
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

  private _isLocalIssuer(issuerPeerId: string | null): boolean {
    if (issuerPeerId === null) {
      return true;
    }
    const local = this.adapter.getLocalPeerId();
    return local !== null && issuerPeerId === local;
  }

  private _activeStructureBounds():
    | { minWx: number; minWy: number; maxWx: number; maxWy: number }
    | null {
    if (this._wandStart === null || this._wandEnd === null) {
      return null;
    }
    return {
      minWx: Math.min(this._wandStart.wx, this._wandEnd.wx),
      minWy: Math.min(this._wandStart.wy, this._wandEnd.wy),
      maxWx: Math.max(this._wandStart.wx, this._wandEnd.wx),
      maxWy: Math.max(this._wandStart.wy, this._wandEnd.wy),
    };
  }

  private _executeWandCommand(issuerPeerId: string | null, rest: string): void {
    if (!this._isLocalIssuer(issuerPeerId)) {
      this._giveFeedbackToIssuer(
        issuerPeerId,
        "Only the local host can toggle wand mode.",
      );
      return;
    }
    if (rest.trim() !== "") {
      this._giveFeedbackToIssuer(issuerPeerId, "Usage: /wand");
      return;
    }
    this._wandEnabled = !this._wandEnabled;
    if (!this._wandEnabled) {
      this._wandStart = null;
      this._wandEnd = null;
    }
    this._giveFeedbackToIssuer(
      issuerPeerId,
      this._wandEnabled
        ? "Wand enabled. Left click sets point A, right click sets point B."
        : "Wand disabled.",
    );
  }

  private _executeStructureCommand(issuerPeerId: string | null, rest: string): void {
    if (!this._isLocalIssuer(issuerPeerId)) {
      this._giveFeedbackToIssuer(
        issuerPeerId,
        "Only the local host can use structure commands.",
      );
      return;
    }
    const tokens = rest.trim().split(/\s+/).filter((p) => p.length > 0);
    if (tokens.length === 0) {
      this._giveFeedbackToIssuer(
        issuerPeerId,
        "Usage: /structure export | /structure place <identifier> [x y]",
      );
      return;
    }
    const sub = tokens[0]!.toLowerCase();
    if (sub === "place") {
      const world = this.world;
      const ir = this._itemRegistry;
      if (world === null || ir === null) {
        this._giveFeedbackToIssuer(issuerPeerId, "World not ready.");
        return;
      }
      if (tokens.length !== 2 && tokens.length !== 4) {
        this._giveFeedbackToIssuer(
          issuerPeerId,
          "Usage: /structure place <identifier> [x y]",
        );
        return;
      }
      const id = tokens[1]!;
      let targetWx: number;
      let targetWy: number;
      if (tokens.length === 4) {
        const x = Number.parseInt(tokens[2]!, 10);
        const y = Number.parseInt(tokens[3]!, 10);
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          this._giveFeedbackToIssuer(
            issuerPeerId,
            "Usage: /structure place <identifier> [x y]",
          );
          return;
        }
        targetWx = x;
        targetWy = y;
      } else if (this.input !== null) {
        targetWx = Math.floor(this.input.mouseWorldPos.x / BLOCK_SIZE);
        targetWy = Math.floor(-this.input.mouseWorldPos.y / BLOCK_SIZE);
      } else {
        this._giveFeedbackToIssuer(issuerPeerId, "Input not ready.");
        return;
      }
      const structure = this._structureRegistry.getStructure(id);
      if (structure === undefined) {
        this._giveFeedbackToIssuer(issuerPeerId, `Unknown structure: ${id}`);
        return;
      }
      const placed = placeStructureAt(world, ir, structure, targetWx, targetWy);
      this._giveFeedbackToIssuer(
        issuerPeerId,
        `Placed ${id} at (${targetWx}, ${targetWy}). Cells: fg ${placed.placedForeground}, bg ${placed.placedBackground}, containers ${placed.placedContainers}, furnaces ${placed.placedFurnaces}.`,
      );
      return;
    }
    if (sub !== "export") {
      this._giveFeedbackToIssuer(
        issuerPeerId,
        "Usage: /structure export | /structure place <identifier> [x y]",
      );
      return;
    }
    const bounds = this._activeStructureBounds();
    const world = this.world;
    const em = this.entityManager;
    const ir = this._itemRegistry;
    if (bounds === null || world === null || em === null || ir === null) {
      this._giveFeedbackToIssuer(
        issuerPeerId,
        "Selection is incomplete. Set both wand points first.",
      );
      return;
    }
    const chestAnchors = new Set<string>();
    const cells: Array<{
      x: number;
      y: number;
      foreground: { id: number; identifier: string; metadata: number };
      background: { id: number; identifier: string; metadata: number };
    }> = [];
    const entities: Array<
      | {
          type: "furnace";
          x: number;
          y: number;
          state: ReturnType<World["getFurnaceTile"]>;
        }
      | {
          type: "spawner";
          x: number;
          y: number;
          state: ReturnType<World["getSpawnerTile"]>;
        }
      | {
          type: "container";
          x: number;
          y: number;
          identifier: string;
          lootTable?: string;
          items: Array<{ key: string; count: number; damage?: number } | null> | null;
        }
    > = [];
    for (let wy = bounds.minWy; wy <= bounds.maxWy; wy++) {
      for (let wx = bounds.minWx; wx <= bounds.maxWx; wx++) {
        const fg = world.getBlock(wx, wy);
        const bg = world.getBackgroundBlock(wx, wy);
        const metadata = world.getMetadata(wx, wy);
        cells.push({
          x: wx - bounds.minWx,
          y: wy - bounds.minWy,
          foreground: {
            id: fg.id,
            identifier: fg.identifier,
            metadata,
          },
          background: {
            id: world.getBackgroundId(wx, wy),
            identifier: bg.identifier,
            metadata,
          },
        });
        if (fg.identifier === "stratum:furnace") {
          const tile = world.getFurnaceTile(wx, wy);
          if (tile !== undefined) {
            entities.push({
              type: "furnace",
              x: wx - bounds.minWx,
              y: wy - bounds.minWy,
              state: structuredClone(tile),
            });
          }
        }
        if (fg.identifier === "stratum:spawner") {
          const tile = world.getSpawnerTile(wx, wy);
          if (tile !== undefined) {
            entities.push({
              type: "spawner",
              x: wx - bounds.minWx,
              y: wy - bounds.minWy,
              state: structuredClone(tile),
            });
          }
        }
        if (fg.identifier === "stratum:chest" || fg.identifier === "stratum:barrel") {
          const anchor = world.getChestStorageAnchorForCell(wx, wy);
          if (anchor !== null) {
            const key = `${anchor.ax},${anchor.ay}`;
            if (!chestAnchors.has(key)) {
              chestAnchors.add(key);
              const chest = world.getChestTileAtAnchor(anchor.ax, anchor.ay);
              if (chest !== undefined) {
                const items = chest.slots.map((slot) => {
                  if (slot === null || slot.count <= 0) {
                    return null;
                  }
                  const def = ir.getById(slot.itemId);
                  if (def === undefined) {
                    return null;
                  }
                  return {
                    key: def.key,
                    count: slot.count,
                    ...(slot.damage !== undefined && slot.damage > 0
                      ? { damage: slot.damage }
                      : {}),
                  };
                });
                entities.push({
                  type: "container",
                  x: wx - bounds.minWx,
                  y: wy - bounds.minWy,
                  identifier: fg.identifier,
                  ...(chest.lootTableId !== undefined
                    ? { lootTable: chest.lootTableId }
                    : {}),
                  items,
                });
              }
            }
          }
        }
      }
    }
    const payload = {
      format: STRUCTURE_EXPORT_FORMAT,
      exportedAt: new Date().toISOString(),
      world: {
        uuid: this.worldUuid,
        name: this.worldName,
        seed: this._worldSeed,
        gameMode: this._worldGameMode,
      },
      selection: {
        start: this._wandStart,
        end: this._wandEnd,
        bounds,
        size: {
          width: bounds.maxWx - bounds.minWx + 1,
          height: bounds.maxWy - bounds.minWy + 1,
        },
      },
      player: {
        feetX: em.getPlayer().state.position.x,
        feetY: em.getPlayer().state.position.y,
      },
      blocks: cells,
      tileEntities: { entities },
    };
    triggerJsonDownload(safeStructureExportBasename(this.worldName), payload);
    const containers = entities.filter((e) => e.type === "container").length;
    const furnaces = entities.filter((e) => e.type === "furnace").length;
    const spawners = entities.filter((e) => e.type === "spawner").length;
    this._giveFeedbackToIssuer(
      issuerPeerId,
      `Exported ${cells.length} cells to JSON (${containers} containers, ${furnaces} furnaces, ${spawners} spawners).`,
    );
  }

  private _handleWandSelectionInput(): void {
    const input = this.input;
    const em = this.entityManager;
    const ir = this._itemRegistry;
    if (input === null || em === null || this.world === null || ir === null) {
      return;
    }
    if (!this._wandEnabled || !this._isSandboxWorld() || input.isWorldInputBlocked()) {
      return;
    }
    const pl = em.getPlayer();
    const heldSlot = pl.state.hotbarSlot % HOTBAR_SIZE;
    const heldStack = pl.inventory.getStack(heldSlot);
    const heldDef =
      heldStack !== null ? ir.getById(heldStack.itemId as ItemId) : undefined;
    if (heldDef?.key !== "stratum:wooden_axe") {
      return;
    }
    const wx = Math.floor(input.mouseWorldPos.x / BLOCK_SIZE);
    const wy = Math.floor(-input.mouseWorldPos.y / BLOCK_SIZE);
    const pcx = Math.floor(pl.state.position.x / BLOCK_SIZE);
    const pcy = Math.floor(pl.state.position.y / BLOCK_SIZE);
    const inReach =
      this._isSandboxWorld() ||
      Math.max(Math.abs(pcx - wx), Math.abs(pcy - wy)) <= REACH_BLOCKS;
    if (!inReach) {
      return;
    }
    if (input.isJustPressed("break")) {
      input.suppressBreakUntilMouseUp();
      this._wandStart = { wx, wy };
      this._wandEnd = null;
      this.bus.emit({
        type: "ui:chat-line",
        kind: "system",
        text: `Wand point A set to (${wx}, ${wy}).`,
      } satisfies GameEvent);
      return;
    }
    if (input.isJustPressed("place")) {
      input.suppressPlaceThisFrame();
      if (this._wandStart === null) {
        this.bus.emit({
          type: "ui:chat-line",
          kind: "system",
          text: "Set point A first with left click.",
        } satisfies GameEvent);
        return;
      }
      this._wandEnd = { wx, wy };
      const bounds = this._activeStructureBounds();
      if (bounds !== null) {
        const width = bounds.maxWx - bounds.minWx + 1;
        const height = bounds.maxWy - bounds.minWy + 1;
        this.bus.emit({
          type: "ui:chat-line",
          kind: "system",
          text: `Wand point B set to (${wx}, ${wy}). Selection: ${width}x${height} cells.`,
        } satisfies GameEvent);
      }
    }
  }

  private _isRainingForVisual(): boolean {
    const st = this.adapter.state;
    const role = st.status === "connected" ? st.role : "offline";
    if (role === "client") {
      return this._clientRainRemainingSec > 0;
    }
    return this._weather.isRaining();
  }

  private _broadcastWeatherSyncToClients(): void {
    const st = this.adapter.state;
    if (st.status !== "connected" || st.role !== "host") {
      return;
    }
    this.adapter.broadcast({
      type: MsgType.WEATHER_SYNC,
      rainRemainingSec: this._weather.getRainRemainingSec(),
    });
  }

  private _playLightningStrikeLocal(): void {
    this._lightningAnimEndMs = performance.now() + 300;
    this.audio?.playSfx("weather_lightning", { volume: 0.9 });
    window.setTimeout(() => {
      this.audio?.playSfx("weather_lightning", { volume: 0.38 });
    }, 110);
  }

  /**
   * Host (`issuerPeerId` set) or solo (`null`). `rest` is the command tail after `/weather`.
   */
  private _executeWeatherCommand(issuerPeerId: string | null, rest: string): void {
    const parts = rest.trim().toLowerCase().split(/\s+/).filter((p) => p.length > 0);
    if (parts.length < 2 || parts[0] !== "set") {
      this._giveFeedbackToIssuer(
        issuerPeerId,
        "Usage: /weather set <rain|clear>",
      );
      return;
    }
    if (parts[1] === "rain") {
      this._weather.setRainFullDuration();
      this._broadcastWeatherSyncToClients();
      this._giveFeedbackToIssuer(issuerPeerId, "Weather set to rain.");
      return;
    }
    if (parts[1] === "clear") {
      this._weather.clear();
      this._broadcastWeatherSyncToClients();
      this._giveFeedbackToIssuer(issuerPeerId, "Weather set to clear.");
      return;
    }
    this._giveFeedbackToIssuer(
      issuerPeerId,
      "Usage: /weather set <rain|clear>",
    );
  }

  /**
   * Feet position (world px) for the command issuer: local player or remote authority on host.
   */
  private _getIssuerFeetWorld(
    issuerPeerId: string | null,
    em: EntityManager,
    world: World,
  ): { x: number; y: number } | null {
    if (issuerPeerId === null) {
      const p = em.getPlayer().state.position;
      return { x: p.x, y: p.y };
    }
    const localId = this.adapter.getLocalPeerId();
    if (localId === null) {
      return null;
    }
    if (issuerPeerId === localId) {
      const p = em.getPlayer().state.position;
      return { x: p.x, y: p.y };
    }
    const rp = world.getRemotePlayers().get(issuerPeerId);
    if (rp === undefined) {
      return null;
    }
    return rp.getAuthorityFeet();
  }

  /**
   * Host (`issuerPeerId` set) or solo (`null`). `rest` is the command tail after `/summon`.
   */
  private _executeSummonCommand(issuerPeerId: string | null, rest: string): void {
    const mm = this._mobManager;
    const w = this.world;
    const em = this.entityManager;
    if (mm === null || w === null || em === null) {
      this._giveFeedbackToIssuer(issuerPeerId, "World not ready.");
      return;
    }
    const parsed = parseSummonCommandRest(rest);
    if (!parsed.ok) {
      this._giveFeedbackToIssuer(issuerPeerId, parsed.error);
      return;
    }
    const rng = w.forkMobRng();
    let x: number;
    let y: number;
    if (parsed.wx === undefined) {
      const feet = this._getIssuerFeetWorld(issuerPeerId, em, w);
      if (feet === null) {
        this._giveFeedbackToIssuer(
          issuerPeerId,
          "Could not determine your position.",
        );
        return;
      }
      x = feet.x;
      y = feet.y;
    } else {
      const wx = parsed.wx;
      const surfaceY = w.getSurfaceHeight(wx);
      x = (wx + 0.5) * BLOCK_SIZE;
      y = feetPxFromSurfaceBlockY(surfaceY);
    }
    const id =
      parsed.entityKey === "pig"
        ? mm.spawnSummonedPigAt(x, y, rng)
        : parsed.entityKey === "duck"
          ? mm.spawnSummonedDuckAt(x, y, rng)
        : parsed.entityKey === "zombie"
          ? mm.spawnSummonedZombieAt(x, y, rng)
          : parsed.entityKey === "slime"
            ? mm.spawnSummonedSlimeAt(x, y, rng, parsed.woolColor)
            : parsed.woolColor !== undefined
              ? mm.spawnSummonedSheepWithColorAt(x, y, parsed.woolColor, rng)
              : mm.spawnSummonedSheepAt(x, y, rng);
    if (id === null) {
      this._giveFeedbackToIssuer(
        issuerPeerId,
        `Could not summon ${parsed.entityKey} (mob cap or too many in this column).`,
      );
      return;
    }
    this._giveFeedbackToIssuer(issuerPeerId, `Summoned ${parsed.entityKey} (#${id}).`);
  }

  /** Host (`issuerPeerId` set) or solo (`null`): despawn all active mobs immediately. */
  private _executeKillAllCommand(issuerPeerId: string | null, rest: string): void {
    if (rest.trim() !== "") {
      this._giveFeedbackToIssuer(issuerPeerId, "Usage: /killall");
      return;
    }
    const mm = this._mobManager;
    if (mm === null) {
      this._giveFeedbackToIssuer(issuerPeerId, "World not ready.");
      return;
    }
    const removed = mm.despawnAll();
    this._giveFeedbackToIssuer(
      issuerPeerId,
      removed > 0 ? `Cleared ${removed} mob(s).` : "No mobs to clear.",
    );
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

  /**
   * Host / offline solo: `/tp` implementation.
   * Supported:
   * - `/tp <x> <y>` (self)
   * - `/tp @s <x> <y>` (self)
   * - `/tp <player> <x> <y>` (host/ops)
   */
  private _runTeleportCore(issuerPeerId: string | null, rest: string): void {
    const em = this.entityManager;
    const w = this.world;
    if (em === null || w === null) {
      this._giveFeedbackToIssuer(issuerPeerId, "World not ready.");
      return;
    }
    const usage = "Usage: /tp <x> <y>  or  /tp <player|@s> <x> <y>";
    const parts = rest.trim().split(/\s+/).filter((p) => p.length > 0);
    if (parts.length < 2 || parts.length > 3) {
      this._giveFeedbackToIssuer(issuerPeerId, usage);
      return;
    }
    let targetPeerId: string | null = null;
    let xTok: string;
    let yTok: string;
    if (parts.length === 2) {
      xTok = parts[0]!;
      yTok = parts[1]!;
      if (issuerPeerId !== null) {
        targetPeerId = issuerPeerId;
      }
    } else {
      const selector = parts[0]!;
      xTok = parts[1]!;
      yTok = parts[2]!;
      if (selector === "@s") {
        targetPeerId = issuerPeerId;
      } else {
        const hit = resolveRosterPeer(this._sessionRoster, selector);
        if (hit === null) {
          this._giveFeedbackToIssuer(
            issuerPeerId,
            `Player not found: ${selector}`,
          );
          return;
        }
        targetPeerId = hit.peerId;
      }
    }
    const bx = Number.parseFloat(xTok);
    const by = Number.parseFloat(yTok);
    if (!Number.isFinite(bx) || !Number.isFinite(by)) {
      this._giveFeedbackToIssuer(issuerPeerId, usage);
      return;
    }
    const feetX = (bx + 0.5) * BLOCK_SIZE;
    const feetY = by * BLOCK_SIZE;
    const localId = this.adapter.getLocalPeerId();
    const targetIsLocal =
      targetPeerId === null || (localId !== null && targetPeerId === localId);
    if (targetIsLocal) {
      em.getPlayer().spawnAt(feetX, feetY);
      this._giveFeedbackToIssuer(
        issuerPeerId,
        `Teleported to (${bx.toFixed(1)}, ${by.toFixed(1)}).`,
      );
      return;
    }
    const st = this.adapter.state;
    if (st.status !== "connected" || st.role !== "host") {
      this._giveFeedbackToIssuer(
        issuerPeerId,
        "Teleporting other players requires hosting a session.",
      );
      return;
    }
    const targetPeer = targetPeerId as PeerId;
    this.adapter.send(targetPeer, {
      type: MsgType.PLAYER_TELEPORT,
      x: feetX,
      y: feetY,
    });
    const rp = w.getRemotePlayers().get(targetPeerId!);
    if (rp !== undefined) {
      const s = rp.getNetworkSample();
      w.updateRemotePlayer(
        targetPeerId!,
        feetX,
        feetY,
        0,
        0,
        s.facingRight,
        s.hotbarSlot,
        s.heldItemId,
        false,
        s.armorHelmetId,
        s.armorChestId,
        s.armorLeggingsId,
        s.armorBootsId,
        s.bowDrawQuantized,
        s.aimDisplayX,
        s.aimDisplayY,
      );
    }
    const label = this._sessionRoster.get(targetPeerId!)?.displayName ?? targetPeerId!;
    this._giveFeedbackToIssuer(
      issuerPeerId,
      `Teleported ${label} to (${bx.toFixed(1)}, ${by.toFixed(1)}).`,
    );
    this._sendSystemToPeer(
      targetPeer,
      `You were teleported to (${bx.toFixed(1)}, ${by.toFixed(1)}).`,
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
            gameMode: this._worldGameMode,
            worldGenType: this._worldGenType,
            enableCheats: this._cheatsEnabled,
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
        return {
          ...prev,
          gameMode: prev.gameMode ?? this._worldGameMode,
          worldGenType: prev.worldGenType ?? this._worldGenType,
          enableCheats: prev.enableCheats ?? this._cheatsEnabled,
          moderation: mod,
          lastPlayedAt: now,
        };
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
    if (trimmed === "/version") {
      this.bus.emit({
        type: "ui:chat-line",
        kind: "system",
        text: formatStratumBuildLine(),
      } satisfies GameEvent);
      return;
    }
    const wandMatch = /^\/wand(\s+.*)?$/i.exec(trimmed);
    if (
      wandMatch !== null &&
      (st.status !== "connected" || st.role === "host")
    ) {
      if (!this._areCheatsEnabled()) {
        this.bus.emit({
          type: "ui:chat-line",
          kind: "system",
          text: "Cheats are disabled for this world.",
        } satisfies GameEvent);
        return;
      }
      const rest = (wandMatch[1] ?? "").trim();
      this._executeWandCommand(null, rest);
      return;
    }
    const structureMatch = /^\/structure(\s+.*)?$/i.exec(trimmed);
    if (
      structureMatch !== null &&
      (st.status !== "connected" || st.role === "host")
    ) {
      if (!this._areCheatsEnabled()) {
        this.bus.emit({
          type: "ui:chat-line",
          kind: "system",
          text: "Cheats are disabled for this world.",
        } satisfies GameEvent);
        return;
      }
      const rest = (structureMatch[1] ?? "").trim();
      this._executeStructureCommand(null, rest);
      return;
    }
    const giveMatch = /^\/give(\s+.*)?$/i.exec(trimmed);
    if (giveMatch !== null && st.status !== "connected") {
      if (!this._areCheatsEnabled()) {
        this.bus.emit({
          type: "ui:chat-line",
          kind: "system",
          text: "Cheats are disabled for this world.",
        } satisfies GameEvent);
        return;
      }
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
    const weatherMatch = /^\/weather(\s+.*)?$/i.exec(trimmed);
    if (weatherMatch !== null && st.status !== "connected") {
      if (!this._areCheatsEnabled()) {
        this.bus.emit({
          type: "ui:chat-line",
          kind: "system",
          text: "Cheats are disabled for this world.",
        } satisfies GameEvent);
        return;
      }
      const rest = (weatherMatch[1] ?? "").trim();
      if (rest === "") {
        this.bus.emit({
          type: "ui:chat-line",
          kind: "system",
          text: "Usage: /weather set <rain|clear>",
        } satisfies GameEvent);
        return;
      }
      this._executeWeatherCommand(null, rest);
      return;
    }
    const summonMatch = /^\/summon(\s+.*)?$/i.exec(trimmed);
    if (summonMatch !== null && st.status !== "connected") {
      if (!this._areCheatsEnabled()) {
        this.bus.emit({
          type: "ui:chat-line",
          kind: "system",
          text: "Cheats are disabled for this world.",
        } satisfies GameEvent);
        return;
      }
      const restSummon = (summonMatch[1] ?? "").trim();
      if (restSummon === "") {
        this.bus.emit({
          type: "ui:chat-line",
          kind: "system",
          text: "Usage: /summon <sheep|pig|duck|zombie|slime> [blockX] [sheepWool | slime 0-3|green|yellow|blue|red]",
        } satisfies GameEvent);
        return;
      }
      this._executeSummonCommand(null, restSummon);
      return;
    }
    const killallMatch = /^\/(?:killall|clear)(\s+.*)?$/i.exec(trimmed);
    if (killallMatch !== null && st.status !== "connected") {
      if (!this._areCheatsEnabled()) {
        this.bus.emit({
          type: "ui:chat-line",
          kind: "system",
          text: "Cheats are disabled for this world.",
        } satisfies GameEvent);
        return;
      }
      const restKillall = (killallMatch[1] ?? "").trim();
      if (restKillall !== "") {
        this.bus.emit({
          type: "ui:chat-line",
          kind: "system",
          text: "Usage: /killall",
        } satisfies GameEvent);
        return;
      }
      this._executeKillAllCommand(null, "");
      return;
    }
    const tpMatch = /^\/tp(\s+.*)?$/i.exec(trimmed);
    if (tpMatch !== null && st.status !== "connected") {
      if (!this._areCheatsEnabled()) {
        this.bus.emit({
          type: "ui:chat-line",
          kind: "system",
          text: "Cheats are disabled for this world.",
        } satisfies GameEvent);
        return;
      }
      const restTp = (tpMatch[1] ?? "").trim();
      if (restTp === "") {
        this.bus.emit({
          type: "ui:chat-line",
          kind: "system",
          text: "Usage: /tp <x> <y>  or  /tp <player|@s> <x> <y>",
        } satisfies GameEvent);
        return;
      }
      this._runTeleportCore(null, restTp);
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
    this._syncWorldInputBlocked();
  }

  private _isLocalDeathBlocking(): boolean {
    const pl = this.entityManager?.getPlayer().state;
    return this._deathModalOpen || pl?.deathAnimT !== null;
  }

  private _syncWorldInputBlocked(): void {
    const input = this.input;
    if (input === null) {
      return;
    }
    input.setWorldInputBlocked(
      this.paused ||
        this.isInventoryOpen ||
        this._chatOpen ||
        this._isLocalDeathBlocking() ||
        this._spawnerModalEl !== null ||
        this._signModalEl !== null,
    );
  }

  private _computeWorldSpawnFeetY(world: World): number {
    const registry = world.getRegistry();
    const airId = registry.getByIdentifier("stratum:air").id;
    const waterBlock = registry.getByIdentifier("stratum:water");
    const waterId = waterBlock?.id;

    // Scan horizontally from center outward to find dry land
    for (let absDx = 0; absDx < 200; absDx++) {
      // Try positive then negative x (0, 1, -1, 2, -2, ...)
      for (const sign of [1, -1]) {
        if (absDx === 0 && sign === -1) continue;
        const wx = absDx * sign;

        // Find surface at this x
        let surfaceY: number | null = null;
        for (let wy = 0; wy < WORLD_Y_MAX; wy++) {
          const solid = world.getBlock(wx, wy);
          const above = world.getBlock(wx, wy + 1);
          if (solid.solid && (above.id === airId || above.replaceable)) {
            surfaceY = wy;
            break;
          }
        }

        if (surfaceY === null) continue;

        // Check if spawn position (feet at surfaceY + 1) would be in water
        const spawnY = surfaceY + 1;
        if (waterId !== undefined) {
          const spawnBlock = world.getBlock(wx, spawnY);
          if (spawnBlock.id === waterId) {
            continue; // Try next x position - avoid spawning in water
          }
        }

        // Found dry land
        return spawnY * BLOCK_SIZE;
      }
    }

    // Fallback: spawn at origin above surface if no dry land found in range
    return 2 * BLOCK_SIZE;
  }

  private _respawnLocalPlayerAfterDeath(): void {
    const world = this.world;
    const em = this.entityManager;
    if (world === null || em === null) {
      return;
    }
    const player = em.getPlayer();
    const sp = this._localSpawnFeet;
    if (sp !== null) {
      player.spawnAt(sp.x, sp.y);
    } else {
      player.spawnAt(0, this._computeWorldSpawnFeetY(world));
    }
    this._localDeathNotified = false;
    this._deathModalOpen = false;
    this.uiShell?.setDeathOverlayOpen(false);
    const bx = Math.floor(player.state.position.x / BLOCK_SIZE);
    const by = Math.floor(player.state.position.y / BLOCK_SIZE);
    world.resetStreamCentre(bx, by);
    this.pipeline?.getCamera().setPositionImmediate(
      player.state.position.x,
      -player.state.position.y - CAMERA_PLAYER_VERTICAL_OFFSET_PX,
    );
    this._syncWorldInputBlocked();
  }

  private _hostApplyPlayerDamageByPeerId(targetPeerId: string, damage: number): void {
    if (this._isSandboxWorld()) {
      return;
    }
    if (damage <= 0) {
      return;
    }
    const em = this.entityManager;
    if (em === null) {
      return;
    }
    const localPeer = this.adapter.getLocalPeerId();
    const st = this.adapter.state;
    if (localPeer !== null && targetPeerId === localPeer) {
      em.getPlayer().takeDamage(damage);
      return;
    }
    if (st.status === "connected" && st.role === "host") {
      this.adapter.send(targetPeerId as PeerId, {
        type: MsgType.PLAYER_DAMAGE_APPLIED,
        damage,
      });
    }
  }

  private _findMeleeRemotePlayerTargetPeerId(
    attackerFeetX: number,
    attackerFeetY: number,
    aimDisplayX: number,
    aimDisplayY: number,
    reachBlocks: number,
  ): string | null {
    const w = this.world;
    if (w === null) {
      return null;
    }
    const maxReachPx = (reachBlocks + 0.75) * BLOCK_SIZE;
    const maxReachSq = maxReachPx * maxReachPx;
    const reticlePadPx = BLOCK_SIZE * 0.32;
    let bestPeerId: string | null = null;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const [peerId, rp] of w.getRemotePlayers()) {
      const feet = rp.getAuthorityFeet();
      const dxAtk = feet.x - attackerFeetX;
      const dyAtk = feet.y - attackerFeetY;
      if (dxAtk * dxAtk + dyAtk * dyAtk > maxReachSq) {
        continue;
      }
      const aabb = feetToScreenAABB({ x: feet.x, y: feet.y });
      const minX = aabb.x - reticlePadPx;
      const minY = aabb.y - reticlePadPx;
      const maxX = aabb.x + aabb.width + reticlePadPx;
      const maxY = aabb.y + aabb.height + reticlePadPx;
      const px = Math.max(minX, Math.min(maxX, aimDisplayX));
      const py = Math.max(minY, Math.min(maxY, aimDisplayY));
      const dAimX = aimDisplayX - px;
      const dAimY = aimDisplayY - py;
      if (dAimX * dAimX + dAimY * dAimY > reticlePadPx * reticlePadPx) {
        continue;
      }
      const centerX = aabb.x + aabb.width * 0.5;
      const centerY = aabb.y + aabb.height * 0.5;
      const scoreX = centerX - aimDisplayX;
      const scoreY = centerY - aimDisplayY;
      const score = scoreX * scoreX + scoreY * scoreY;
      if (score < bestScore) {
        bestScore = score;
        bestPeerId = peerId;
      }
    }
    return bestPeerId;
  }

  private _maybeMeleeMob(): void {
    const mm = this._mobManager;
    const input = this.input;
    const em = this.entityManager;
    const w = this.world;
    if (mm === null || input === null || em === null || w === null) {
      return;
    }
    if (!input.isJustPressed("break") || input.isWorldInputBlocked()) {
      return;
    }
    const pl = em.getPlayer();
    if (pl.state.dead) {
      return;
    }
    const px = pl.state.position.x;
    const py = pl.state.position.y;
    const { x: aimX, y: aimY } = getReachCrosshairDisplayPos(
      px,
      py,
      input.mouseWorldPos.x,
      input.mouseWorldPos.y,
      pl.state.facingRight,
      REACH_BLOCKS,
    );
    const aimPhysY = -aimY;
    const pcx = Math.floor(px / BLOCK_SIZE);
    const pcy = Math.floor(py / BLOCK_SIZE);
    const mwx = Math.floor(aimX / BLOCK_SIZE);
    const mwy = Math.floor(aimPhysY / BLOCK_SIZE);
    if (Math.max(Math.abs(pcx - mwx), Math.abs(pcy - mwy)) > REACH_BLOCKS) {
      return;
    }

    // Swing on melee clicks when attacking mobs or "hitting air" (no mineable block under the crosshair).
    const cell = w.getBlock(mwx, mwy);
    const mineableCell =
      cell.identifier !== "stratum:air" && cell.hardness !== 999;

    const tid = mm.findMeleeTarget(px, py, aimX, aimY, REACH_BLOCKS);
    const targetPeerId = this._findMeleeRemotePlayerTargetPeerId(
      px,
      py,
      aimX,
      aimY,
      REACH_BLOCKS,
    );
    let attackKind: "mob" | "player" | null = null;
    if (tid !== null && targetPeerId !== null) {
      const mob = mm.getById(tid);
      const rp = w.getRemotePlayers().get(targetPeerId);
      if (mob !== undefined && rp !== undefined) {
        const mobCenterX = mob.x;
        const mobCenterY = mob.y + mobHitboxSizePx(mob.kind).h * 0.5;
        const mobDx = mobCenterX - aimX;
        const mobDy = mobCenterY - aimPhysY;
        const mobD2 = mobDx * mobDx + mobDy * mobDy;
        const rpFeet = rp.getAuthorityFeet();
        const playerCenterX = rpFeet.x;
        const playerCenterY = rpFeet.y + PLAYER_HEIGHT * 0.5;
        const playerDx = playerCenterX - aimX;
        const playerDy = playerCenterY - aimPhysY;
        const playerD2 = playerDx * playerDx + playerDy * playerDy;
        attackKind = playerD2 < mobD2 ? "player" : "mob";
      } else {
        attackKind = tid !== null ? "mob" : "player";
      }
    } else if (tid !== null) {
      attackKind = "mob";
    } else if (targetPeerId !== null) {
      attackKind = "player";
    }
    if (attackKind === null) {
      if (!mineableCell) {
        pl.swingHand();
        this.audio?.playSfx("tool_swing", {
          volume: TOOL_SWING_SFX_VOLUME,
          pitchVariance: TOOL_SWING_SFX_PITCH_VARIANCE_CENTS,
        });
      }
      return;
    }
    pl.swingHand();
    this.audio?.playSfx("tool_swing", {
      volume: TOOL_SWING_SFX_VOLUME,
      pitchVariance: TOOL_SWING_SFX_PITCH_VARIANCE_CENTS,
    });
    // Ensure the click that hits a mob doesn't also start mining until mouse-up.
    input.suppressBreakUntilMouseUp();
    const heldSlot = pl.state.hotbarSlot % HOTBAR_SIZE;
    const heldItemId = pl.inventory.getStack(heldSlot)?.itemId ?? 0;
    const def = this._itemRegistry?.getById(heldItemId as ItemId);
    const dmg = meleeDamageFromHeldItemId(def, heldItemId);
    if (dmg <= 0) {
      return;
    }
    const net = this.adapter.state;
    if (net.status === "connected" && net.role === "client") {
      const hid = net.lanHostPeerId;
      if (hid !== null) {
        if (attackKind === "mob" && tid !== null) {
          this.adapter.send(hid as PeerId, {
            type: MsgType.ENTITY_HIT_REQUEST,
            entityId: tid,
            heldItemId,
          });
        } else if (attackKind === "player" && targetPeerId !== null) {
          this.adapter.send(hid as PeerId, {
            type: MsgType.PLAYER_HIT_REQUEST,
            targetPeerId,
            heldItemId,
          });
        }
      }
      return;
    }
    if (attackKind === "mob" && tid !== null) {
      const rng = w.forkMobRng();
      const hitR = mm.damageMobFromHost(tid, rng, px, dmg, {
        style: "melee",
        baseKnockback: meleeBaseKnockbackFromHeldItemId(def, heldItemId),
      });
      if (hitR.ok && hitR.dealt > 0) {
        this._playMobHurtVocalSfx(tid);
        em.bumpMobHealthBar(tid);
      }
      return;
    }
    if (attackKind === "player" && targetPeerId !== null) {
      this._hostApplyPlayerDamageByPeerId(targetPeerId, dmg);
    }
  }

  private _tickLocalPlayerDeath(dtSec: number): void {
    const em = this.entityManager;
    if (em === null) {
      return;
    }
    const pl = em.getPlayer().state;
    if (pl.deathAnimT === null) {
      return;
    }
    if (!this._localDeathNotified) {
      this._localDeathNotified = true;
      if (this._chatOpen) {
        this._chatOpen = false;
        this.input?.setChatOpen(false);
        this.bus.emit({ type: "ui:chat-set-open", open: false } satisfies GameEvent);
      }
      if (this.isInventoryOpen) {
        this.isInventoryOpen = false;
        this._applyInventoryPanelsOpen(false);
      }
      if (this.paused) {
        this.paused = false;
        this.uiShell?.setPauseOverlayOpen(false);
      }
      this.bus.emit({
        type: "ui:chat-line",
        kind: "system",
        text: `${this._displayName} died.`,
      } satisfies GameEvent);
      this._deathModalOpen = true;
      this.uiShell?.setDeathOverlayOpen(true);
      this._syncWorldInputBlocked();
    }
    pl.deathAnimT = Math.min(
      1,
      pl.deathAnimT + dtSec / PLAYER_DEATH_ANIM_DURATION_SEC,
    );
  }

  /** Crafting recipes loaded after {@link ItemRegistry} is populated (item keys validated). */
  get recipeRegistry(): RecipeRegistry {
    return this._recipeRegistry;
  }

  /** Non-null after base recipes load in {@link Game.initWorld}. */
  get craftingSystem(): CraftingSystem | null {
    return this._craftingSystem;
  }

  /** Spatial SFX from a block cell (chest/furnace UI, block break bus, etc.). */
  private _sfxFromWorldCell(
    wx: number,
    wy: number,
    name: string,
    opts?: Omit<SfxOptions, "world">,
  ): void {
    const em = this.entityManager;
    const snd = this.audio;
    if (em === null || snd === null) {
      return;
    }
    const pl = em.getPlayer().state.position;
    snd.playSfx(name, {
      ...opts,
      world: {
        listenerX: pl.x,
        listenerY: pl.y,
        sourceX: wx * BLOCK_SIZE + BLOCK_SIZE * 0.5,
        sourceY: wy * BLOCK_SIZE + BLOCK_SIZE * 0.5,
      },
    });
  }

  private _playMobHurtVocalSfx(mobId: number): void {
    const mm = this._mobManager;
    const em = this.entityManager;
    const snd = this.audio;
    if (mm === null || em === null || snd === null) {
      return;
    }
    const mob = mm.getById(mobId);
    if (mob === undefined) {
      return;
    }
    const now = performance.now();
    const last = this._mobHurtSfxAtMs.get(mobId) ?? -Infinity;
    if (now - last < 220) {
      return;
    }
    this._mobHurtSfxAtMs.set(mobId, now);

    const pl = em.getPlayer().state.position;
    // Prefer entity-specific "say" sounds (random variant), else fall back to generic hit.
    const name =
      mob.kind === "sheep"
        ? "entity_sheep_idle"
        : mob.kind === "pig"
          ? "entity_pig_idle"
          : mob.kind === "duck"
            ? "entity_duck_hurt"
          : "dmg_hit";
    snd.playSfx(name, {
      volume:
        mob.kind === "zombie" ? 0.5 : mob.kind === "slime" ? 0.36 : 0.42,
      pitchVariance:
        mob.kind === "zombie" ? 22 : mob.kind === "slime" ? 55 : 85,
      world: {
        listenerX: pl.x,
        listenerY: pl.y,
        sourceX: mob.x,
        sourceY: mob.y,
      },
    });
  }

  private _applyInventoryPanelsOpen(open: boolean): void {
    const chestAnchorForCloseSfx =
      !open && this._activeChestAnchor !== null
        ? this._activeChestAnchor
        : null;
    if (!open) {
      this._flushLocalCursorStackForClose();
      this._activeChestAnchor = null;
      this._lastFurnaceOpenSfxKey = null;
    }
    const chestActive = open && this._activeChestAnchor !== null;
    const sandboxActive = open && this._isSandboxWorld();

    this.inventoryUI?.setOpen(open);
    this.inventoryUI?.setChestMountCollapsed(!chestActive);

    this._chestPanel?.setOpen(open);
    this._chestPanel?.setChestVisible(chestActive);
    this._creativePanel?.setOpen(open);
    this._creativePanel?.setVisible(sandboxActive);

    /* Chest UI and recipe sidebar are mutually exclusive (no empty chest gap, no recipes on chest). */
    this._craftingPanel?.setOpen(open && !chestActive && !sandboxActive);

    if (chestAnchorForCloseSfx !== null) {
      this._sfxFromWorldCell(
        chestAnchorForCloseSfx.ax,
        chestAnchorForCloseSfx.ay,
        getCloseSound("chest"),
        {
          pitchVariance: 18,
          volume: 0.85,
        },
      );
    }
  }

  /**
   * Ensure cursor-held stack does not vanish when inventory/chest UI closes.
   * First tries merging back to inventory; if overflow remains, throws it into the world.
   */
  private _flushLocalCursorStackForClose(): void {
    const em = this.entityManager;
    const w = this.world;
    if (em === null || w === null) {
      return;
    }
    const inv = em.getPlayer().inventory;
    inv.returnCursorToSlots();
    const stack = inv.getCursorStack();
    if (stack === null || stack.count <= 0) {
      return;
    }
    inv.replaceCursorStack(null);

    const st = em.getPlayer().state;
    const input = this.input;
    const { dirX, dirY } =
      input === null
        ? { dirX: st.facingRight ? 1 : -1, dirY: 0 }
        : getItemThrowUnitVectorFromFeet(
            st.position.x,
            st.position.y,
            input.mouseWorldPos.x,
            input.mouseWorldPos.y,
            st.facingRight,
          );
    const spd = ITEM_THROW_SPEED_PX;
    let vx = dirX * spd + st.velocity.x * ITEM_THROW_INHERIT_PLAYER_VEL_X;
    let vy = dirY * spd;
    ({ vx, vy } = clampItemThrowVelocity(vx, vy));
    const chestY = st.position.y + PLAYER_HEIGHT * 0.5;
    const off = ITEM_THROW_SPAWN_OFFSET_PX;
    const sx = st.position.x + dirX * off;
    const sy = chestY - dirY * off;

    const net = this.adapter.state;
    if (net.status === "connected" && net.role === "client") {
      const hid = net.lanHostPeerId;
      if (hid !== null) {
        this.adapter.send(hid as PeerId, {
          type: MsgType.THROW_CURSOR_STACK,
          itemId: stack.itemId,
          count: stack.count,
          damage: stack.damage ?? 0,
          x: sx,
          y: sy,
          vx,
          vy,
        });
      }
      return;
    }

    w.spawnItem(
      stack.itemId,
      stack.count,
      sx,
      sy,
      vx,
      vy,
      stack.damage ?? 0,
      ITEM_PLAYER_THROW_PICKUP_DELAY_SEC,
    );
  }

  private _broadcastFurnaceSnapshotNow(wx: number, wy: number): void {
    const w = this.world;
    const st = w?.getFurnaceTile(wx, wy);
    if (w === null || st === undefined) {
      return;
    }
    const data = furnaceTileToPersisted(wx, wy, st, this._itemRegistry!);
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

  /** ~1 Hz crackle at each furnace that has smelts in progress (queue non-empty). */
  private _tickFurnaceSmeltAmbient(dtSec: number): void {
    const w = this.world;
    const em = this.entityManager;
    const snd = this.audio;
    if (w === null || em === null || snd === null) {
      return;
    }
    this._furnaceSmeltSfxAccumSec += dtSec;
    if (this._furnaceSmeltSfxAccumSec < 1) {
      return;
    }
    this._furnaceSmeltSfxAccumSec -= 1;
    const pl = em.getPlayer().state.position;
    w.forEachFurnaceTile((wx, wy, tile) => {
      if (tile.queue.length === 0) {
        return;
      }
      snd.playSfx(getOpenSound("furnace"), {
        volume: 0.38,
        pitchVariance: 28,
        world: {
          listenerX: pl.x,
          listenerY: pl.y,
          sourceX: wx * BLOCK_SIZE + BLOCK_SIZE * 0.5,
          sourceY: wy * BLOCK_SIZE + BLOCK_SIZE * 0.5,
        },
      });
    });
  }

  /** Idle bleats and walk steps for nearby sheep (spatial audio at mob feet). */
  private _tickSheepAmbientSfx(dtSec: number): void {
    const mm = this._mobManager;
    const em = this.entityManager;
    const snd = this.audio;
    if (mm === null || em === null || snd === null) {
      return;
    }
    const pl = em.getPlayer();
    if (pl.state.dead) {
      return;
    }
    const lx = pl.state.position.x;
    const ly = pl.state.position.y;
    const views = mm.getPublicViews().filter((v) => v.type === MobType.Sheep);
    const alive = new Set<number>();
    for (const v of views) {
      alive.add(v.id);
      let st = this._sheepAmbientSfxById.get(v.id);
      if (st === undefined) {
        st = { bleatIn: 2 + Math.random() * 4, stepPx: 0 };
        this._sheepAmbientSfxById.set(v.id, st);
      }
      st.bleatIn -= dtSec;
      if (st.bleatIn <= 0) {
        st.bleatIn = 4 + Math.random() * 6;
        if (Math.random() < 0.5) {
          snd.playSfx("entity_sheep_idle", {
            volume: 0.42,
            pitchVariance: 85,
            world: {
              listenerX: lx,
              listenerY: ly,
              sourceX: v.x,
              sourceY: v.y,
            },
          });
        }
      }
      if (v.walking) {
        st.stepPx += Math.abs(v.vx) * dtSec;
        const span = 28;
        if (st.stepPx >= span) {
          const q = Math.floor(st.stepPx / span);
          st.stepPx -= q * span;
          snd.playSfx("entity_sheep_step", {
            volume: 0.34,
            pitchVariance: 55,
            world: {
              listenerX: lx,
              listenerY: ly,
              sourceX: v.x,
              sourceY: v.y,
            },
          });
        }
      } else {
        st.stepPx = 0;
      }
    }
    for (const id of [...this._sheepAmbientSfxById.keys()]) {
      if (!alive.has(id)) {
        this._sheepAmbientSfxById.delete(id);
      }
    }
  }

  private _tickPigAmbientSfx(dtSec: number): void {
    const mm = this._mobManager;
    const em = this.entityManager;
    const snd = this.audio;
    if (mm === null || em === null || snd === null) {
      return;
    }
    const pl = em.getPlayer();
    if (pl.state.dead) {
      return;
    }
    const lx = pl.state.position.x;
    const ly = pl.state.position.y;
    const views = mm.getPublicViews().filter((v) => v.type === MobType.Pig);
    const alive = new Set<number>();
    for (const v of views) {
      alive.add(v.id);
      let st = this._pigAmbientSfxById.get(v.id);
      if (st === undefined) {
        st = { gruntIn: 2 + Math.random() * 4, stepPx: 0, deathPlayed: false };
        this._pigAmbientSfxById.set(v.id, st);
      }
      if (v.deathAnimRemainSec > 0) {
        if (!st.deathPlayed) {
          st.deathPlayed = true;
          snd.playSfx("entity_pig_death", {
            volume: 0.44,
            pitchVariance: 45,
            world: {
              listenerX: lx,
              listenerY: ly,
              sourceX: v.x,
              sourceY: v.y,
            },
          });
        }
        st.stepPx = 0;
        continue;
      }
      st.gruntIn -= dtSec;
      if (st.gruntIn <= 0) {
        st.gruntIn = 4 + Math.random() * 6;
        if (Math.random() < 0.5) {
          snd.playSfx("entity_pig_idle", {
            volume: 0.42,
            pitchVariance: 85,
            world: {
              listenerX: lx,
              listenerY: ly,
              sourceX: v.x,
              sourceY: v.y,
            },
          });
        }
      }
      if (v.walking) {
        st.stepPx += Math.abs(v.vx) * dtSec;
        const span = 28;
        if (st.stepPx >= span) {
          const q = Math.floor(st.stepPx / span);
          st.stepPx -= q * span;
          snd.playSfx("entity_pig_step", {
            volume: 0.34,
            pitchVariance: 55,
            world: {
              listenerX: lx,
              listenerY: ly,
              sourceX: v.x,
              sourceY: v.y,
            },
          });
        }
      } else {
        st.stepPx = 0;
      }
    }
    for (const id of [...this._pigAmbientSfxById.keys()]) {
      if (!alive.has(id)) {
        this._pigAmbientSfxById.delete(id);
      }
    }
  }

  private _tickDuckAmbientSfx(dtSec: number): void {
    const mm = this._mobManager;
    const em = this.entityManager;
    const snd = this.audio;
    if (mm === null || em === null || snd === null) {
      return;
    }
    const pl = em.getPlayer();
    if (pl.state.dead) {
      return;
    }
    const lx = pl.state.position.x;
    const ly = pl.state.position.y;
    const views = mm.getPublicViews().filter((v) => v.type === MobType.Duck);
    const alive = new Set<number>();
    for (const v of views) {
      alive.add(v.id);
      let st = this._duckAmbientSfxById.get(v.id);
      if (st === undefined) {
        st = { quackIn: 2 + Math.random() * 4, stepPx: 0, deathPlayed: false };
        this._duckAmbientSfxById.set(v.id, st);
      }
      if (v.deathAnimRemainSec > 0) {
        if (!st.deathPlayed) {
          st.deathPlayed = true;
          snd.playSfx("entity_duck_death", {
            volume: 0.44,
            pitchVariance: 45,
            world: {
              listenerX: lx,
              listenerY: ly,
              sourceX: v.x,
              sourceY: v.y,
            },
          });
        }
        st.stepPx = 0;
        continue;
      }
      st.quackIn -= dtSec;
      if (st.quackIn <= 0) {
        st.quackIn = 4 + Math.random() * 6;
        if (Math.random() < 0.5) {
          snd.playSfx("entity_duck_idle", {
            volume: 0.42,
            pitchVariance: 85,
            world: {
              listenerX: lx,
              listenerY: ly,
              sourceX: v.x,
              sourceY: v.y,
            },
          });
        }
      }
      if (v.walking) {
        st.stepPx += Math.abs(v.vx) * dtSec;
        const span = 28;
        if (st.stepPx >= span) {
          const q = Math.floor(st.stepPx / span);
          st.stepPx -= q * span;
          snd.playSfx("entity_duck_step", {
            volume: 0.34,
            pitchVariance: 55,
            world: {
              listenerX: lx,
              listenerY: ly,
              sourceX: v.x,
              sourceY: v.y,
            },
          });
        }
      } else {
        st.stepPx = 0;
      }
    }
    for (const id of [...this._duckAmbientSfxById.keys()]) {
      if (!alive.has(id)) {
        this._duckAmbientSfxById.delete(id);
      }
    }
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
      return { nearCraftingTable: false, nearFurnace: false, nearStonecutter: false };
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
    let nearStonecutter = false;
    if (reg.isRegistered("stratum:stonecutter")) {
      const stonecutterId = reg.getByIdentifier("stratum:stonecutter").id;
      nearStonecutter = isNearBlockOfId(
        w,
        stonecutterId,
        feet,
        STONECUTTER_ACCESS_RADIUS_BLOCKS,
      );
    }
    return { nearCraftingTable, nearFurnace, nearStonecutter };
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
      if (r.station === RECIPE_STATION_STONECUTTER) {
        return ctx.nearStonecutter;
      }
      return false;
    });
  }

  private _visibleCraftingCategories(): readonly string[] {
    const set = new Set<string>();
    for (const r of this._visibleRecipesForCrafting()) {
      set.add(r.category);
    }
    const rest = [...set]
      .filter((c) => c !== "Furnace" && c !== "Stonecutter")
      .sort((a, b) => a.localeCompare(b));
    const tail: string[] = [];
    if (set.has("Furnace")) {
      tail.push("Furnace");
    }
    if (set.has("Stonecutter")) {
      tail.push("Stonecutter");
    }
    return [...rest, ...tail];
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
    const queuedBatchesByRecipeId: Record<string, number> = {};
    for (const e of tile.queue) {
      queuedBatchesByRecipeId[e.smeltingRecipeId] =
        (queuedBatchesByRecipeId[e.smeltingRecipeId] ?? 0) + e.batches;
    }
    return {
      outputSlots: tile.outputSlots,
      fuel: tile.fuel,
      fuelRemainingSec: tile.fuelRemainingSec,
      cookProgressSec: tile.cookProgressSec,
      activeSmeltingRecipeId: head?.smeltingRecipeId ?? null,
      cookTimeSecForActive,
      queuedBatchesByRecipeId,
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
      const cell = this._nearestFurnaceCell();
      if (cell === null) {
        return;
      }
      const hostId = net.lanHostPeerId as PeerId | null;
      if (hostId === null) {
        return;
      }
      this.adapter.send(hostId, {
        type: MsgType.FURNACE_SLOT_REQUEST,
        wx: cell.wx,
        wy: cell.wy,
        kind: 0,
        slotIndex: 0,
        button,
      });
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
      const cell = this._nearestFurnaceCell();
      if (cell === null) {
        return;
      }
      const hostId = net.lanHostPeerId as PeerId | null;
      if (hostId === null) {
        return;
      }
      this.adapter.send(hostId, {
        type: MsgType.FURNACE_SLOT_REQUEST,
        wx: cell.wx,
        wy: cell.wy,
        kind: 1,
        slotIndex,
        button,
      });
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

  private _handleFurnaceCancelQueueRequest(smeltingRecipeId: string): void {
    const net = this.adapter.state;
    if (net.status === "connected" && net.role === "client") {
      return;
    }
    const crafting = this._craftingSystem;
    const w = this.world;
    const em = this.entityManager;
    if (crafting === null || w === null || em === null) {
      return;
    }
    const cell = this._nearestFurnaceCell();
    if (cell === null) {
      return;
    }
    const recipe = this._recipeRegistry
      .all()
      .find(
        (r) =>
          r.station === RECIPE_STATION_FURNACE &&
          r.smeltingSourceId === smeltingRecipeId,
      );
    if (recipe === undefined) {
      return;
    }
    const tile =
      w.getFurnaceTile(cell.wx, cell.wy) ??
      createEmptyFurnaceTileState(this._worldTime.ms);
    const removedEntries = tile.queue.filter(
      (e) => e.smeltingRecipeId === smeltingRecipeId,
    );
    const batchesRemoved = removedEntries.reduce((s, e) => s + e.batches, 0);
    if (batchesRemoved <= 0) {
      return;
    }
    const nextTile = removeFurnaceQueueEntriesForRecipe(tile, smeltingRecipeId);
    if (nextTile === null) {
      return;
    }
    w.setFurnaceTile(cell.wx, cell.wy, nextTile);
    this._broadcastFurnaceSnapshotNow(cell.wx, cell.wy);
    const inv = em.getPlayer().inventory;
    const overflow = crafting.refundFurnaceBatchesToInventory(
      recipe,
      batchesRemoved,
      inv,
    );
    const st = em.getPlayer().state;
    const sy = st.position.y + PLAYER_HEIGHT * 0.5;
    for (const rest of overflow) {
      w.spawnItem(
        rest.itemId,
        rest.count,
        st.position.x,
        sy,
        0,
        0,
        rest.damage ?? 0,
      );
    }
    this.bus.emit({
      type: "craft:result",
      ok: true,
      crafted: 0,
      recipeId: recipe.id,
      shiftKey: false,
    } satisfies GameEvent);
  }

  private _resolveChunkFetchIfPending(cx: number, cy: number): void {
    const key = `${cx},${cy}`;
    const list = this._chunkFetchWaitLists.get(key);
    if (list === undefined) {
      return;
    }
    this._chunkFetchWaitLists.delete(key);
    for (const r of list) {
      r();
    }
  }

  private _awaitChunkFromHost(cx: number, cy: number): Promise<void> {
    const st = this.adapter.state;
    if (
      st.status !== "connected" ||
      st.role !== "client" ||
      st.lanHostPeerId === null
    ) {
      return Promise.reject(
        new Error("awaitChunkFromHost: not a connected multiplayer client"),
      );
    }
    const key = `${cx},${cy}`;
    return new Promise<void>((resolve, reject) => {
      let list = this._chunkFetchWaitLists.get(key);
      if (list === undefined) {
        list = [];
        this._chunkFetchWaitLists.set(key, list);
      }
      const timeoutId = setTimeout(() => {
        const L = this._chunkFetchWaitLists.get(key);
        if (L === undefined) {
          return;
        }
        const i = L.indexOf(done);
        if (i >= 0) {
          L.splice(i, 1);
        }
        if (L.length === 0) {
          this._chunkFetchWaitLists.delete(key);
        }
        reject(new Error("Chunk request timed out"));
      }, 90_000);
      const done = (): void => {
        clearTimeout(timeoutId);
        resolve();
      };
      list.push(done);
      if (list.length === 1) {
        this._chunkRequestSentAtMs.set(key, performance.now());
        this.adapter.send(st.lanHostPeerId as PeerId, {
          type: MsgType.CHUNK_REQUEST,
          cx,
          cy,
        });
      }
    });
  }

  private _terrainCellWithinReachForPeer(
    wx: number,
    wy: number,
    peerId: string,
  ): boolean {
    if (this._isSandboxWorld()) {
      return true;
    }
    const w = this.world;
    if (w === null) {
      return false;
    }
    const localId = this.adapter.getLocalPeerId();
    let feetX: number;
    let feetY: number;
    if (localId !== null && peerId === localId && this.entityManager !== null) {
      const p = this.entityManager.getPlayer().state.position;
      feetX = p.x;
      feetY = p.y;
    } else {
      const rp = w.getRemotePlayers().get(peerId);
      if (rp === undefined) {
        return false;
      }
      const f = rp.getAuthorityFeet();
      feetX = f.x;
      feetY = f.y;
    }
    const pcx = Math.floor(feetX / BLOCK_SIZE);
    const pcy = Math.floor(feetY / BLOCK_SIZE);
    return (
      Math.max(Math.abs(pcx - wx), Math.abs(pcy - wy)) <= REACH_BLOCKS
    );
  }

  private _applyTerrainAck(msg: {
    ok: boolean;
    hotbarSlot: number;
    effects: number;
  }): void {
    const em = this.entityManager;
    const ir = this._itemRegistry;
    if (em === null || ir === null || !msg.ok) {
      return;
    }
    const pl = em.getPlayer();
    const slot = ((msg.hotbarSlot % HOTBAR_SIZE) + HOTBAR_SIZE) % HOTBAR_SIZE;
    const efx = msg.effects;
    if ((efx & ACK_TOOL_USE) !== 0) {
      pl.inventory.applyToolUseFromMining(slot);
    }
    if ((efx & ACK_CONSUME_ONE) !== 0) {
      pl.inventory.consumeOneFromSlot(slot);
    }
    if ((efx & ACK_WATER_BUCKET_SPENT) !== 0) {
      const b = ir.getByKey("stratum:bucket");
      if (b !== undefined) {
        pl.inventory.setStack(slot, { itemId: b.id, count: 1 });
      }
    }
    if ((efx & ACK_BUCKET_FILL_RESULT) !== 0) {
      const wb = ir.getByKey("stratum:water_bucket");
      if (wb !== undefined) {
        pl.inventory.setStack(slot, { itemId: wb.id, count: 1 });
      }
    }
  }

  private async _hostHandleChunkRequest(
    peerId: PeerId,
    cx: number,
    cy: number,
  ): Promise<void> {
    const w = this.world;
    if (w === null) {
      return;
    }
    try {
      await w.loadOrGenerateChunkAt(cx, cy);
    } catch {
      return;
    }
    const chunk = w.getChunk(cx, cy);
    if (chunk === undefined) {
      return;
    }
    this.adapter.send(peerId, {
      type: MsgType.CHUNK_DATA,
      cx,
      cy,
      blocks: chunk.blocks.slice(),
      background: chunk.background.slice(),
      metadata: chunk.metadata.slice(),
      furnaces: w.getFurnaceEntitiesForChunk(cx, cy),
      chests: w.getChestEntitiesForChunk(cx, cy),
      spawners: w.getSpawnerEntitiesForChunk(cx, cy),
      signs: w.getSignEntitiesForChunk(cx, cy),
    });
  }

  private _hostHandleTerrainBreakCommit(
    peerId: string,
    msg: {
      wx: number;
      wy: number;
      layer: 0 | 1;
      expectedBlockId?: number;
      expectedBlockKey?: string;
      hotbarSlot: number;
      heldItemId?: number;
      heldItemKey?: string;
    },
  ): void {
    const w = this.world;
    const ir = this._itemRegistry;
    if (w === null || ir === null) {
      return;
    }
    if (!this._terrainCellWithinReachForPeer(msg.wx, msg.wy, peerId)) {
      return;
    }
    const airId = w.getAirBlockId();
    const expectedBlockId =
      msg.expectedBlockKey !== undefined
        ? w.getRegistry().getByIdentifier(msg.expectedBlockKey).id
        : (msg.expectedBlockId ?? 0);
    if (msg.layer === 1) {
      if (w.getBackgroundId(msg.wx, msg.wy) !== expectedBlockId) {
        return;
      }
    } else if (w.getBlock(msg.wx, msg.wy).id !== expectedBlockId) {
      return;
    }
    let heldDef;
    try {
      heldDef =
        msg.heldItemKey !== undefined
          ? ir.getByKey(msg.heldItemKey)
          : (msg.heldItemId ?? 0) !== 0
            ? ir.getById((msg.heldItemId ?? 0) as ItemId)
          : undefined;
    } catch {
      heldDef = undefined;
    }
    const layer = msg.layer === 1 ? "bg" : "fg";
    applyCommittedBreakOnWorld(
      w,
      w.getRegistry(),
      ir,
      msg.wx,
      msg.wy,
      layer,
      airId,
      heldDef,
      this._worldGameMode,
    );
    this.adapter.send(peerId as PeerId, {
      type: MsgType.TERRAIN_ACK,
      ok: true,
      hotbarSlot: msg.hotbarSlot,
      effects: ACK_TOOL_USE,
    });
  }

  private _hostHandleTerrainDoorToggle(
    peerId: string,
    wx: number,
    wy: number,
  ): void {
    const w = this.world;
    if (w === null) {
      return;
    }
    if (!this._terrainCellWithinReachForPeer(wx, wy, peerId)) {
      return;
    }
    applyCommittedDoorToggle(w, wx, wy);
  }

  private _hostHandleTerrainPlace(
    peerId: string,
    msg: {
      subtype: number;
      wx: number;
      wy: number;
      hotbarSlot: number;
      placesBlockId?: number;
      placesBlockKey?: string;
      aux: number;
    },
  ): void {
    const w = this.world;
    const ir = this._itemRegistry;
    if (w === null || ir === null) {
      return;
    }
    if (!this._terrainCellWithinReachForPeer(msg.wx, msg.wy, peerId)) {
      return;
    }
    let feet: { x: number; y: number };
    const localId = this.adapter.getLocalPeerId();
    if (localId !== null && peerId === localId && this.entityManager !== null) {
      feet = this.entityManager.getPlayer().state.position;
    } else {
      const rp = w.getRemotePlayers().get(peerId);
      if (rp === undefined) {
        return;
      }
      feet = rp.getAuthorityFeet();
    }
    const waterId = w.getWaterBlockId();
    const placesBlockId =
      msg.placesBlockKey !== undefined
        ? w.getRegistry().getByIdentifier(msg.placesBlockKey).id
        : (msg.placesBlockId ?? 0);
    const { ok, effects } = tryHostTerrainPlace(
      w,
      w.getRegistry(),
      ir,
      w.getAirBlockId(),
      waterId,
      feet,
      w.getRemotePlayers(),
      msg.subtype,
      msg.wx,
      msg.wy,
      msg.hotbarSlot,
      placesBlockId,
      msg.aux,
    );
    this.adapter.send(peerId as PeerId, {
      type: MsgType.TERRAIN_ACK,
      ok,
      hotbarSlot: msg.hotbarSlot,
      effects,
    });
  }

  private _hostHandleDropPickupRequest(peerId: PeerId, netId: number): void {
    const w = this.world;
    if (w === null) {
      return;
    }
    const id = `n${netId}`;
    const item = w.getDroppedItems().get(id);
    if (item === undefined) {
      return;
    }
    const wx = Math.floor(item.x / BLOCK_SIZE);
    const wy = Math.floor(item.y / BLOCK_SIZE);
    if (!this._terrainCellWithinReachForPeer(wx, wy, peerId)) {
      return;
    }
    this.adapter.send(peerId, {
      type: MsgType.GIVE_ITEM_STACK,
      itemId: item.itemId,
      count: item.count,
    });
    w.removeAuthoritativeDropByNetId(netId);
    this.adapter.broadcast({ type: MsgType.DROP_DESPAWN, netId });
  }

  private _hostHandleThrowCursorStack(
    peerId: string,
    msg: {
      itemId: number;
      count: number;
      damage: number;
      x: number;
      y: number;
      vx: number;
      vy: number;
    },
  ): void {
    const w = this.world;
    if (w === null) {
      return;
    }
    const wx = Math.floor(msg.x / BLOCK_SIZE);
    const wy = Math.floor(msg.y / BLOCK_SIZE);
    if (!this._terrainCellWithinReachForPeer(wx, wy, peerId)) {
      return;
    }
    w.spawnItem(
      msg.itemId as ItemId,
      msg.count,
      msg.x,
      msg.y,
      msg.vx,
      msg.vy,
      msg.damage,
      ITEM_PLAYER_THROW_PICKUP_DELAY_SEC,
    );
  }

  private _chestWithinReach(anchor: { ax: number; ay: number }): boolean {
    if (this._isSandboxWorld()) {
      return true;
    }
    const w = this.world;
    const em = this.entityManager;
    if (w === null || em === null) {
      return false;
    }
    const cid = w.getChestBlockId();
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
      cid !== null &&
      w.getForegroundBlockId(anchor.ax + 1, anchor.ay) === cid &&
      cheb(anchor.ax + 1, anchor.ay)
    ) {
      return true;
    }
    return false;
  }

  private _rollContainerLootIfNeeded(anchor: { ax: number; ay: number }): void {
    const w = this.world;
    const lr = this._lootResolver;
    if (w === null || lr === null) {
      return;
    }
    const st = w.getChestTileAtAnchor(anchor.ax, anchor.ay);
    if (st === undefined || st.lootTableId === undefined || st.lootRolled === true) {
      return;
    }
    const empty = st.slots.every((s) => s === null || s.count <= 0);
    if (!empty) {
      w.setChestTileAtAnchor(anchor.ax, anchor.ay, { ...st, lootRolled: true });
      return;
    }
    const rng = w.forkMobRng();
    const drops = lr.resolveNamedTable(st.lootTableId, rng);
    const slots = st.slots.map((s) => (s === null ? null : { ...s }));
    for (const drop of drops) {
      let remaining = drop.count;
      const maxPerStack = this._maxStackForItem(drop.itemId);
      for (let i = 0; i < slots.length && remaining > 0; i++) {
        const cur = slots[i];
        if (cur !== null && cur !== undefined && cur.itemId === drop.itemId) {
          const space = Math.max(0, maxPerStack - cur.count);
          const add = Math.max(0, Math.min(remaining, space));
          cur.count += add;
          remaining -= add;
        }
      }
      while (remaining > 0) {
        const empties: number[] = [];
        for (let i = 0; i < slots.length; i++) {
          if (slots[i] === null) {
            empties.push(i);
          }
        }
        if (empties.length === 0) {
          break;
        }
        const pick = empties[Math.floor(rng.nextFloat() * empties.length)]!;
        const add = Math.max(1, Math.min(remaining, maxPerStack));
        slots[pick] = { itemId: drop.itemId, count: add };
        remaining -= add;
      }
    }
    w.setChestTileAtAnchor(anchor.ax, anchor.ay, {
      slots,
      lootTableId: st.lootTableId,
      lootRolled: true,
    });
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
    this._lastFurnaceOpenSfxKey = null;
    const prevAnchor = this._activeChestAnchor;
    const chestAnchorChanged =
      prevAnchor === null ||
      prevAnchor.ax !== anchor.ax ||
      prevAnchor.ay !== anchor.ay;
    this._activeChestAnchor = anchor;
    w.syncChestStorageToLayout(wx, wy);
    this._rollContainerLootIfNeeded(anchor);
    if (!this.isInventoryOpen) {
      this.isInventoryOpen = true;
      input.setWorldInputBlocked(true);
    }
    this._applyInventoryPanelsOpen(true);
    if (chestAnchorChanged) {
      this._sfxFromWorldCell(wx, wy, getOpenSound("chest"), {
        pitchVariance: 22,
        volume: 0.9,
      });
    }
    this._chestPanel?.update();
    this._creativePanel?.update();
  }

  private _craftingTableCellWithinReach(wx: number, wy: number): boolean {
    if (this._isSandboxWorld()) {
      return true;
    }
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

  private _stonecutterCellWithinReach(wx: number, wy: number): boolean {
    if (this._isSandboxWorld()) {
      return true;
    }
    const w = this.world;
    const em = this.entityManager;
    if (w === null || em === null) {
      return false;
    }
    const feet = em.getPlayer().state.position;
    const pcx = Math.floor(feet.x / BLOCK_SIZE);
    const pcy = Math.floor(feet.y / BLOCK_SIZE);
    const R = STONECUTTER_ACCESS_RADIUS_BLOCKS;
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
    this._lastFurnaceOpenSfxKey = null;
    this._activeChestAnchor = null;
    if (!this.isInventoryOpen) {
      this.isInventoryOpen = true;
      input.setWorldInputBlocked(true);
    }
    this._applyInventoryPanelsOpen(true);
    this._craftingPanel?.update(em.getPlayer().inventory);
  }

  /** RMB stonecutter: same as crafting table (inventory + recipe UI). */
  private _handleStonecutterOpenRequest(wx: number, wy: number): void {
    const w = this.world;
    const input = this.input;
    const em = this.entityManager;
    if (w === null || input === null || em === null) {
      return;
    }
    const reg = w.getRegistry();
    if (!reg.isRegistered("stratum:stonecutter")) {
      return;
    }
    const id = reg.getByIdentifier("stratum:stonecutter").id;
    if (w.getBlock(wx, wy).id !== id) {
      return;
    }
    if (!this._stonecutterCellWithinReach(wx, wy)) {
      return;
    }
    this._lastFurnaceOpenSfxKey = null;
    this._activeChestAnchor = null;
    if (!this.isInventoryOpen) {
      this.isInventoryOpen = true;
      input.setWorldInputBlocked(true);
    }
    this._applyInventoryPanelsOpen(true);
    this._craftingPanel?.update(em.getPlayer().inventory);
  }

  private _furnaceCellWithinReach(wx: number, wy: number): boolean {
    if (this._isSandboxWorld()) {
      return true;
    }
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
    const furnaceKey = `${wx},${wy}`;
    if (this._lastFurnaceOpenSfxKey !== furnaceKey) {
      this._lastFurnaceOpenSfxKey = furnaceKey;
      this._sfxFromWorldCell(wx, wy, getOpenSound("furnace"), {
        pitchVariance: 35,
        volume: 0.5,
      });
    }
  }

  private _canEditSpawner(): boolean {
    const st = this.adapter.state;
    if (st.status !== "connected") {
      return true;
    }
    if (st.role === "host") {
      return true;
    }
    const local = this.adapter.getLocalPeerId();
    if (local === null) {
      return false;
    }
    // World starter/host is always trusted, even if OP roster sync is stale.
    if (st.lanHostPeerId !== null && local === st.lanHostPeerId) {
      return true;
    }
    return this._opPeerIds.has(local);
  }

  private _allRegisteredSpawnerMobOptions(): string[] {
    return ["sheep", "pig", "duck", "zombie", "slime"];
  }

  private _handleSpawnerOpenRequest(wx: number, wy: number): void {
    const w = this.world;
    if (w === null) {
      return;
    }
    const spawnerId = w.getSpawnerBlockId();
    const cell = w.getBlock(wx, wy);
    const isSpawnerCell =
      cell.identifier === "stratum:spawner" ||
      (spawnerId !== null && cell.id === spawnerId);
    if (!isSpawnerCell) {
      return;
    }
    // Self-heal old sessions where spawner block id was not registered yet.
    if (spawnerId === null && cell.identifier === "stratum:spawner") {
      w.setSpawnerBlockId(cell.id);
    }
    if (!this._canEditSpawner()) {
      this.bus.emit({
        type: "ui:chat-line",
        kind: "system",
        text: "Spawner editing requires host/op permissions.",
      } satisfies GameEvent);
      return;
    }
    const existing = w.getSpawnerTile(wx, wy);
    if (existing === undefined) {
      w.setSpawnerTile(wx, wy, createDefaultSpawnerTileState());
    }
    this._openSpawnerModal(wx, wy);
  }

  private _handleSignOpenRequest(wx: number, wy: number): void {
    const w = this.world;
    if (w === null) {
      return;
    }
    const cell = w.getBlock(wx, wy);
    const isSignCell =
      cell.identifier === "stratum:oak_sign" ||
      cell.identifier === "stratum:spruce_sign" ||
      cell.identifier === "stratum:birch_sign" ||
      w.isSignBlockId(cell.id);
    if (!isSignCell) {
      return;
    }
    const existing = w.getSignTile(wx, wy);
    if (existing === undefined) {
      w.setSignTile(wx, wy, createDefaultSignTileState());
    }
    this._openSignModal(wx, wy);
  }

  private _closeSpawnerModal(): void {
    if (this._spawnerModalEl !== null) {
      this._spawnerModalEl.remove();
      this._spawnerModalEl = null;
      this._syncWorldInputBlocked();
    }
  }

  private _closeSignModal(): void {
    if (this._signModalEl !== null) {
      this._signModalEl.remove();
      this._signModalEl = null;
      this._syncWorldInputBlocked();
    }
  }

  private _openSignModal(wx: number, wy: number): void {
    const w = this.world;
    if (w === null) {
      return;
    }
    const state = w.getSignTile(wx, wy) ?? createDefaultSignTileState();
    this._closeSignModal();
    const overlay = document.createElement("div");
    overlay.className = "spawner-modal-overlay";
    const modal = document.createElement("div");
    modal.className = "spawner-modal sign-modal";
    const header = document.createElement("div");
    header.className = "spawner-modal-header";
    const title = document.createElement("h3");
    title.textContent = "Edit Sign";
    const subtitle = document.createElement("p");
    subtitle.className = "spawner-modal-subtitle";
    subtitle.textContent = `Cell ${wx}, ${wy}  [b][i][u] [color=red] [center]`;
    header.appendChild(title);
    header.appendChild(subtitle);
    modal.appendChild(header);
    const form = document.createElement("form");
    form.className = "spawner-modal-form";
    const wrap = document.createElement("label");
    wrap.className = "spawner-modal-field";
    wrap.textContent = "Sign Text";
    const input = document.createElement("textarea");
    input.className = "sign-modal-textarea";
    input.value = state.text;
    input.maxLength = 640;
    input.placeholder = "Welcome, traveler.\n[b]Bold[/b], [i]italic[/i], [u]underline[/u]";
    wrap.appendChild(input);
    form.appendChild(wrap);
    const preview = document.createElement("div");
    preview.className = "sign-modal-preview";
    const previewLabel = document.createElement("div");
    previewLabel.className = "sign-modal-preview-label";
    previewLabel.textContent = "Preview";
    const previewBody = document.createElement("div");
    previewBody.className = "sign-modal-preview-body";
    preview.appendChild(previewLabel);
    preview.appendChild(previewBody);
    const syncPreview = () => {
      previewBody.innerHTML = signMarkupToHtml(input.value);
    };
    input.addEventListener("input", syncPreview);
    syncPreview();
    form.appendChild(preview);
    const buttons = document.createElement("div");
    buttons.className = "spawner-modal-buttons";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => this._closeSignModal());
    const clear = document.createElement("button");
    clear.type = "button";
    clear.textContent = "Clear";
    clear.addEventListener("click", () => {
      input.value = "";
      syncPreview();
      input.focus();
    });
    const save = document.createElement("button");
    save.type = "submit";
    save.textContent = "Save";
    buttons.appendChild(cancel);
    buttons.appendChild(clear);
    buttons.appendChild(save);
    form.appendChild(buttons);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const sanitized = sanitizeSignMarkup(input.value);
      w.setSignTile(wx, wy, { text: sanitized });
      const systemLine = signMarkupToPlainText(sanitized).trim();
      if (systemLine.length > 0) {
        this.bus.emit({
          type: "ui:chat-line",
          kind: "system",
          text: `Sign updated: "${systemLine.slice(0, 120)}${systemLine.length > 120 ? "..." : ""}"`,
        } satisfies GameEvent);
      }
      this._closeSignModal();
    });
    modal.appendChild(form);
    overlay.appendChild(modal);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) {
        e.stopPropagation();
      }
    });
    this.mount.appendChild(overlay);
    this._signModalEl = overlay;
    this._syncWorldInputBlocked();
  }

  private _openSpawnerModal(wx: number, wy: number): void {
    const w = this.world;
    if (w === null) {
      return;
    }
    const state = w.getSpawnerTile(wx, wy) ?? createDefaultSpawnerTileState();
    this._closeSpawnerModal();
    const overlay = document.createElement("div");
    overlay.className = "spawner-modal-overlay";
    const modal = document.createElement("div");
    modal.className = "spawner-modal";
    const header = document.createElement("div");
    header.className = "spawner-modal-header";
    const title = document.createElement("h3");
    title.textContent = "Edit Spawner";
    const subtitle = document.createElement("p");
    subtitle.className = "spawner-modal-subtitle";
    subtitle.textContent = `Cell ${wx}, ${wy}`;
    header.appendChild(title);
    header.appendChild(subtitle);
    modal.appendChild(header);
    const form = document.createElement("form");
    form.className = "spawner-modal-form";
    const mkNumber = (labelText: string, value: number): HTMLInputElement => {
      const wrap = document.createElement("label");
      wrap.className = "spawner-modal-field";
      wrap.textContent = labelText;
      const input = document.createElement("input");
      input.type = "number";
      input.min = "0";
      input.step = "1";
      input.value = String(Math.max(0, Math.floor(value)));
      wrap.appendChild(input);
      form.appendChild(wrap);
      return input;
    };
    const delayIn = mkNumber("Delay", state.delay);
    const maxCountIn = mkNumber("Max Count (0 = infinite)", state.maxCount);
    const playerRangeIn = mkNumber("Player Range", state.playerRange);
    const spawnRangeIn = mkNumber("Spawn Range", state.spawnRange);
    const selectWrap = document.createElement("div");
    selectWrap.className = "spawner-modal-field";
    const selectLabel = document.createElement("span");
    selectLabel.textContent = "Spawn Potentials";
    selectWrap.appendChild(selectLabel);
    const dropdown = document.createElement("div");
    dropdown.className = "spawner-mob-dropdown";
    const dropdownBtn = document.createElement("button");
    dropdownBtn.type = "button";
    dropdownBtn.className = "spawner-mob-dropdown-btn";
    const dropdownBtnLabel = document.createElement("span");
    dropdownBtnLabel.className = "spawner-mob-dropdown-btn-label";
    const dropdownCaret = document.createElement("span");
    dropdownCaret.className = "spawner-mob-dropdown-caret";
    dropdownBtn.appendChild(dropdownBtnLabel);
    dropdownBtn.appendChild(dropdownCaret);
    const optionsList = document.createElement("ul");
    optionsList.className = "spawner-mob-dropdown-options";
    const selectedMobKeys = new Set(
      state.spawnPotentials.length > 0 ? state.spawnPotentials : ["sheep"],
    );
    const allMobOptions = this._allRegisteredSpawnerMobOptions();
    const updateDropdownLabel = () => {
      const count = selectedMobKeys.size;
      if (count <= 0) {
        dropdownBtnLabel.textContent = "Select mobs";
        return;
      }
      if (count === 1) {
        dropdownBtnLabel.textContent = [...selectedMobKeys][0] ?? "Select mobs";
        return;
      }
      dropdownBtnLabel.textContent = `${count} mobs selected`;
    };
    for (const mob of allMobOptions) {
      const li = document.createElement("li");
      const opt = document.createElement("button");
      opt.type = "button";
      opt.className = "spawner-mob-dropdown-option";
      const check = document.createElement("span");
      check.className = "spawner-mob-dropdown-option-check";
      const text = document.createElement("span");
      text.className = "spawner-mob-dropdown-option-text";
      text.textContent = mob;
      const sync = () => {
        const active = selectedMobKeys.has(mob);
        opt.classList.toggle("spawner-mob-dropdown-option-selected", active);
        opt.setAttribute("aria-pressed", active ? "true" : "false");
      };
      sync();
      opt.appendChild(check);
      opt.appendChild(text);
      opt.addEventListener("click", () => {
        if (selectedMobKeys.has(mob)) {
          if (selectedMobKeys.size === 1) return;
          selectedMobKeys.delete(mob);
        } else {
          selectedMobKeys.add(mob);
        }
        sync();
        updateDropdownLabel();
      });
      li.appendChild(opt);
      optionsList.appendChild(li);
    }
    updateDropdownLabel();
    dropdownBtn.addEventListener("click", () => {
      const open = dropdown.classList.toggle("spawner-mob-dropdown-open");
      dropdownBtn.setAttribute("aria-expanded", open ? "true" : "false");
    });
    modal.addEventListener("click", (e) => {
      const target = e.target;
      if (!(target instanceof Node)) return;
      if (dropdown.contains(target)) return;
      dropdown.classList.remove("spawner-mob-dropdown-open");
      dropdownBtn.setAttribute("aria-expanded", "false");
    });
    dropdown.appendChild(dropdownBtn);
    dropdown.appendChild(optionsList);
    selectWrap.appendChild(dropdown);
    form.appendChild(selectWrap);
    const buttons = document.createElement("div");
    buttons.className = "spawner-modal-buttons";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => this._closeSpawnerModal());
    const save = document.createElement("button");
    save.type = "submit";
    save.textContent = "Save";
    buttons.appendChild(cancel);
    buttons.appendChild(save);
    form.appendChild(buttons);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const chosen = [...selectedMobKeys];
      if (chosen.length === 0) {
        chosen.push("sheep");
      }
      const current = w.getSpawnerTile(wx, wy) ?? createDefaultSpawnerTileState();
      w.setSpawnerTile(wx, wy, {
        delay: Math.max(0, Math.floor(Number(delayIn.value) || 0)),
        maxCount: Math.max(0, Math.floor(Number(maxCountIn.value) || 0)),
        playerRange: Math.max(0, Math.floor(Number(playerRangeIn.value) || 0)),
        spawnRange: Math.max(0, Math.floor(Number(spawnRangeIn.value) || 0)),
        spawnPotentials: chosen,
        nextSpawnAtWorldTimeMs: current.nextSpawnAtWorldTimeMs,
      });
      this._closeSpawnerModal();
    });
    modal.appendChild(form);
    overlay.appendChild(modal);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) {
        e.stopPropagation();
      }
    });
    this.mount.appendChild(overlay);
    this._spawnerModalEl = overlay;
    this._syncWorldInputBlocked();
  }

  private _spawnMobFromSpawner(
    mobKey: string,
    x: number,
    y: number,
    rng: GeneratorContext,
  ): number | null {
    const mm = this._mobManager;
    if (mm === null) {
      return null;
    }
    const id =
      mobKey === "pig"
        ? mm.spawnSummonedPigAt(x, y, rng)
        : mobKey === "duck"
          ? mm.spawnSummonedDuckAt(x, y, rng)
          : mobKey === "zombie"
            ? mm.spawnSummonedZombieAt(x, y, rng)
            : mobKey === "slime"
              ? mm.spawnSummonedSlimeAt(x, y, rng)
              : mm.spawnSummonedSheepAt(x, y, rng);
    return id;
  }

  private _isSpawnerSpawnCellValid(world: World, feetWx: number, feetWy: number): boolean {
    const support = world.getBlock(feetWx, feetWy - 1);
    const feetCell = world.getBlock(feetWx, feetWy);
    const headCell = world.getBlock(feetWx, feetWy + 1);
    if (!support.solid || support.replaceable || support.water) {
      return false;
    }
    if (feetCell.collides || headCell.collides) {
      return false;
    }
    return true;
  }

  private _pickSpawnerSpawnFeet(
    world: World,
    spawnerWx: number,
    spawnerWy: number,
    spawnRangeBlocks: number,
    rng: GeneratorContext,
  ): { x: number; y: number } | null {
    const range = Math.max(0, Math.floor(spawnRangeBlocks));
    const tries = 28;
    for (let i = 0; i < tries; i++) {
      const ox = Math.floor(rng.nextFloat() * (range * 2 + 1)) - range;
      const candidateWx = spawnerWx + ox;
      const candidateYOffsets = [0, -1, 1];
      for (const oy of candidateYOffsets) {
        const candidateWy = spawnerWy + oy;
        if ((candidateWx - spawnerWx) ** 2 + (candidateWy - spawnerWy) ** 2 > range * range) {
          continue;
        }
        if (!this._isSpawnerSpawnCellValid(world, candidateWx, candidateWy)) {
          continue;
        }
        return {
          x: (candidateWx + 0.5) * BLOCK_SIZE,
          y: candidateWy * BLOCK_SIZE,
        };
      }
    }
    return null;
  }

  private _tickSpawnersHost(
    world: World,
    rng: GeneratorContext,
    simulationChunkKeys: ReadonlySet<string>,
  ): void {
    const mm = this._mobManager;
    if (mm === null) {
      return;
    }
    const nowMs = this._worldTime.ms;
    const playerFeet: Array<{ x: number; y: number }> = [];
    if (this.entityManager !== null) {
      playerFeet.push({ ...this.entityManager.getPlayer().state.position });
    }
    for (const rp of world.getRemotePlayers().values()) {
      const f = rp.getAuthorityFeet();
      playerFeet.push({ x: f.x, y: f.y });
    }
    const mobs = mm.getPublicViews();
    world.forEachSpawnerTile((wx, wy, tile) => {
      const { cx, cy } = worldToChunk(wx, wy);
      if (!simulationChunkKeys.has(`${cx},${cy}`)) {
        return;
      }
      const playerRangePx = tile.playerRange * BLOCK_SIZE;
      const hasPlayerInRange =
        playerRangePx <= 0 ||
        playerFeet.some((p) => (p.x - (wx + 0.5) * BLOCK_SIZE) ** 2 + (p.y - (wy + 0.5) * BLOCK_SIZE) ** 2 <= playerRangePx * playerRangePx);
      if (!hasPlayerInRange) {
        return;
      }
      if (nowMs < tile.nextSpawnAtWorldTimeMs) {
        return;
      }
      const spawnRangePx = Math.max(0, tile.spawnRange) * BLOCK_SIZE;
      const centerX = (wx + 0.5) * BLOCK_SIZE;
      const centerY = (wy + 1) * BLOCK_SIZE;
      const nearby = mobs.filter((m) => (m.x - centerX) ** 2 + (m.y - centerY) ** 2 <= spawnRangePx * spawnRangePx).length;
      if (tile.maxCount > 0 && nearby >= tile.maxCount) {
        return;
      }
      const potentials =
        tile.spawnPotentials.length > 0
          ? tile.spawnPotentials
          : this._allRegisteredSpawnerMobOptions();
      const chosen = potentials[Math.floor(rng.nextFloat() * potentials.length)] ?? "sheep";
      const spawnFeet = this._pickSpawnerSpawnFeet(world, wx, wy, tile.spawnRange, rng);
      if (spawnFeet === null) {
        return;
      }
      const spawnedId = this._spawnMobFromSpawner(chosen, spawnFeet.x, spawnFeet.y, rng);
      if (spawnedId !== null) {
        this._pendingSpawnerFxByMobId.set(spawnedId, { wx, wy });
        this.bus.emit({ type: "fx:spawner-spawn", wx, wy, blockId: world.getBlock(wx, wy).id } satisfies GameEvent);
      }
      const delayMs = Math.max(1, tile.delay) * FIXED_TIMESTEP_SEC * 1000;
      world.setSpawnerTile(wx, wy, {
        ...tile,
        nextSpawnAtWorldTimeMs: nowMs + delayMs,
      });
    });
  }

  private _bedWithinReachForPeer(wx: number, wy: number, peerId: string): boolean {
    if (this._isSandboxWorld()) {
      return true;
    }
    const w = this.world;
    if (w === null) {
      return false;
    }
    const rp = w.getRemotePlayers().get(peerId);
    if (rp === undefined) {
      return false;
    }
    const feet = rp.getAuthorityFeet();
    const pcx = Math.floor(feet.x / BLOCK_SIZE);
    const pcy = Math.floor(feet.y / BLOCK_SIZE);
    return Math.max(Math.abs(pcx - wx), Math.abs(pcy - wy)) <= REACH_BLOCKS;
  }

  private _resolveFullBedCells(
    wx: number,
    wy: number,
  ): { footWx: number; headWx: number; wy: number } | null {
    const w = this.world;
    if (w === null) {
      return null;
    }
    const cell = w.getBlock(wx, wy);
    if (cell.bedHalf !== "foot" && cell.bedHalf !== "head") {
      return null;
    }
    const meta = w.getMetadata(wx, wy);
    const headPlusX = bedHeadPlusXFromMeta(meta);
    const footWx =
      cell.bedHalf === "foot" ? wx : headPlusX ? wx - 1 : wx + 1;
    const headWx =
      cell.bedHalf === "head" ? wx : headPlusX ? wx + 1 : wx - 1;
    const foot = w.getBlock(footWx, wy);
    const head = w.getBlock(headWx, wy);
    if (foot.bedHalf !== "foot" || head.bedHalf !== "head") {
      return null;
    }
    return { footWx, headWx, wy };
  }

  private _bedStandFeetFromCells(c: { footWx: number; headWx: number; wy: number }): {
    x: number;
    y: number;
  } {
    // Center between foot + head block centers.
    const footCx = (c.footWx + 0.5) * BLOCK_SIZE;
    const headCx = (c.headWx + 0.5) * BLOCK_SIZE;
    const x = (footCx + headCx) * 0.5;
    const y = (c.wy + 1) * BLOCK_SIZE;
    return { x, y };
  }

  private _sleepMajorityRequiredCount(totalPlayers: number): number {
    const t = Math.max(1, Math.floor(totalPlayers));
    return Math.floor(t / 2) + 1;
  }

  private _sleepTotalOnlinePlayers(): number {
    const w = this.world;
    if (w === null) {
      return 1;
    }
    // Host is always included as 1; remotePlayers are other online peers.
    return 1 + w.getRemotePlayers().size;
  }

  private _sleepVoteCount(): number {
    // Host is represented as "__host" in the vote set when sleeping.
    return this._sleepVotePeerIds.size;
  }

  private _clearSleepVotes(): void {
    this._sleepVotePeerIds.clear();
  }

  private _maybeTriggerSleepSkipFromVotes(): void {
    if (this._sleepSkipInProgress) {
      return;
    }
    const total = this._sleepTotalOnlinePlayers();
    const need = this._sleepMajorityRequiredCount(total);
    if (this._sleepVoteCount() < need) {
      return;
    }
    this._sleepSkipInProgress = true;
    const kind: 0 | 1 =
      this._weather.isRaining() || this._isNightForSleep() ? 1 : 0;
    const durationMs = 4000;
    this._applySleepSkip(kind);
    const st = this.adapter.state;
    if (st.status === "connected" && st.role === "host") {
      this._broadcastSleepTransition(kind, durationMs);
    }
    // Local transition: only animate if we were sleeping (pending stand feet set by local request).
    void this._playLocalSleepTransition(durationMs, this._pendingLocalSleepStandFeet);
    this._pendingLocalSleepStandFeet = null;
    this._clearSleepVotes();
    // Clear the "in progress" gate when fade finishes.
    void this._sleepTransitionPromise?.finally(() => {
      this._sleepSkipInProgress = false;
    });
  }

  private _isNightForSleep(): boolean {
    const nightStartMs = DAWN_LENGTH_MS + DAYLIGHT_LENGTH_MS + DUSK_LENGTH_MS;
    const phase = (this._worldTime.ms % DAY_LENGTH_MS) / DAY_LENGTH_MS;
    const nightStartPhase = nightStartMs / DAY_LENGTH_MS;
    return phase >= nightStartPhase;
  }

  private _applySleepSkip(kind: 0 | 1): void {
    // kind: 0 = to night, 1 = to morning
    if (kind === 0) {
      const nightStartMs = DAWN_LENGTH_MS + DAYLIGHT_LENGTH_MS + DUSK_LENGTH_MS;
      this._worldTime.setMs(nightStartMs);
      return;
    }
    this._worldTime.setMs(0);
    this._weather.clear();
  }

  private _broadcastSleepTransition(kind: 0 | 1, durationMs: number): void {
    const st = this.adapter.state;
    if (st.status === "connected" && st.role === "host") {
      this.adapter.broadcast({
        type: MsgType.SLEEP_TRANSITION,
        kind,
        durationMs,
      });
      // Push time/weather immediately so clients snap during the fade.
      this.adapter.broadcast({
        type: MsgType.WORLD_TIME,
        worldTimeMs: this._worldTime.ms,
      });
      this._broadcastWeatherSyncToClients();
    }
  }

  private async _playLocalSleepTransition(
    durationMs: number,
    standFeet?: { x: number; y: number } | null,
  ): Promise<void> {
    if (this._sleepTransitionPromise !== null) {
      return this._sleepTransitionPromise;
    }
    const mount = this.mount;
    const em = this.entityManager;
    const w = this.world;
    if (em === null || w === null) {
      return;
    }
    // Snap onto the bed immediately so the sleep pose is always centered.
    if (standFeet !== null && standFeet !== undefined) {
      em.getPlayer().spawnAt(standFeet.x, standFeet.y);
    }
    const totalSec = Math.max(0, durationMs / 1000);
    em.getPlayer().beginSleep(totalSec);
    const inMs = Math.max(0, Math.round(durationMs * 0.38));
    const holdMs = Math.max(0, Math.round(durationMs * 0.14));
    const outMs = Math.max(0, durationMs - inMs - holdMs);
    this._sleepTransitionPromise = (async () => {
      try {
        await runSleepTransition(
          mount,
          () => {
            // Nothing: host already applied time/weather; clients already synced time.
          },
          { inMs, holdMs, outMs, dimOpacity: 0.6 },
        );
        // Stand up + place on bed top center (local-only nicety).
        if (standFeet !== null && standFeet !== undefined) {
          em.getPlayer().spawnAt(standFeet.x, standFeet.y);
        }
      } finally {
        em.getPlayer().beginSleep(0);
        this._sleepTransitionPromise = null;
      }
    })();
    return this._sleepTransitionPromise;
  }

  private async _handleBedSleepRequest(wx: number, wy: number): Promise<void> {
    const w = this.world;
    const em = this.entityManager;
    if (w === null || em === null) {
      return;
    }
    const net = this.adapter.state;
    const bedCells = this._resolveFullBedCells(wx, wy);
    if (bedCells === null) {
      return;
    }
    const standFeet = this._bedStandFeetFromCells(bedCells);
    // Sleeping in a bed sets your spawnpoint.
    this._localSpawnFeet = standFeet;
    void this.saveGame?.save();
    const durationMs = 4000;

    if (net.status === "connected" && net.role === "client") {
      const hid = net.lanHostPeerId;
      if (hid !== null) {
        this.adapter.send(hid as PeerId, {
          type: MsgType.SLEEP_REQUEST,
          wx,
          wy,
        });
      }
      this._pendingLocalSleepStandFeet = standFeet;
      // Immediately snap into the bed pose while waiting for majority.
      em.getPlayer().spawnAt(standFeet.x, standFeet.y);
      em.getPlayer().beginSleep(60);
      return;
    }

    // Offline or host: register this player as sleeping and trigger skip once a majority is reached.
    this._pendingLocalSleepStandFeet = standFeet;
    this._sleepVotePeerIds.add("__host");
    // Snap into the bed pose while waiting for majority.
    em.getPlayer().spawnAt(standFeet.x, standFeet.y);
    em.getPlayer().beginSleep(60);
    if (net.status === "connected" && net.role === "host") {
      this._maybeTriggerSleepSkipFromVotes();
      return;
    }
    // Offline: apply skip immediately (majority is always satisfied).
    const kind: 0 | 1 =
      this._weather.isRaining() || this._isNightForSleep() ? 1 : 0;
    this._applySleepSkip(kind);
    await this._playLocalSleepTransition(durationMs, standFeet);
  }

  private _chestWithinReachForPeer(
    anchor: { ax: number; ay: number },
    peerId: string,
  ): boolean {
    if (this._isSandboxWorld()) {
      return true;
    }
    const w = this.world;
    if (w === null) {
      return false;
    }
    const rp = w.getRemotePlayers().get(peerId);
    if (rp === undefined) {
      return false;
    }
    const cid = w.getChestBlockId();
    const feet = rp.getAuthorityFeet();
    const pcx = Math.floor(feet.x / BLOCK_SIZE);
    const pcy = Math.floor(feet.y / BLOCK_SIZE);
    const R = CHEST_ACCESS_RADIUS_BLOCKS;
    const cheb = (bx: number, by: number): boolean =>
      Math.max(Math.abs(pcx - bx), Math.abs(pcy - by)) <= R;
    if (cheb(anchor.ax, anchor.ay)) {
      return true;
    }
    if (
      cid !== null &&
      w.getForegroundBlockId(anchor.ax + 1, anchor.ay) === cid &&
      cheb(anchor.ax + 1, anchor.ay)
    ) {
      return true;
    }
    return false;
  }

  private _furnaceWithinReachForPeer(wx: number, wy: number, peerId: string): boolean {
    if (this._isSandboxWorld()) {
      return true;
    }
    const w = this.world;
    if (w === null) {
      return false;
    }
    const rp = w.getRemotePlayers().get(peerId);
    if (rp === undefined) {
      return false;
    }
    const feet = rp.getAuthorityFeet();
    const pcx = Math.floor(feet.x / BLOCK_SIZE);
    const pcy = Math.floor(feet.y / BLOCK_SIZE);
    const R = FURNACE_ACCESS_RADIUS_BLOCKS;
    return Math.max(Math.abs(pcx - wx), Math.abs(pcy - wy)) <= R;
  }

  private _broadcastChestSnapshotNow(ax: number, ay: number): void {
    const w = this.world;
    const st = w?.getChestTileAtAnchor(ax, ay);
    if (w === null || st === undefined) {
      return;
    }
    const data = chestTileToPersisted(ax, ay, st, this._itemRegistry!);
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
      const anchor = this._activeChestAnchor;
      const w = this.world;
      const em = this.entityManager;
      if (anchor === null || w === null || em === null) {
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
      const { state: next, cursor } = applyChestSlotMouse(
        tile,
        slotIndex,
        2,
        cur,
        maxStack,
      );
      w.setChestTileAtAnchor(anchor.ax, anchor.ay, next);
      inv.replaceCursorStack(cursor);
      const hostId = net.lanHostPeerId as PeerId | null;
      if (hostId !== null) {
        this.adapter.send(hostId, {
          type: MsgType.CHEST_PUT_REQUEST,
          wx: anchor.ax,
          wy: anchor.ay,
          slotIndex,
          button: 2,
          cursorItemId: cur.itemId as number,
          cursorCount: cur.count,
          cursorDamage: cur.damage ?? 0,
        });
      }
      return true;
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
    const isArmorSlot =
      slotIndex >= ARMOR_UI_SLOT_BASE &&
      slotIndex < ARMOR_UI_SLOT_BASE + ARMOR_SLOT_COUNT;
    const armorSlot: ArmorSlot | null = isArmorSlot
      ? ((slotIndex - ARMOR_UI_SLOT_BASE) as ArmorSlot)
      : null;
    const net = this.adapter.state;
    if (net.status === "connected" && net.role === "client") {
      const em = this.entityManager;
      const w = this.world;
      const ir = this._itemRegistry;
      const anchor = this._activeChestAnchor;
      if (em === null || w === null || ir === null || anchor === null) {
        return;
      }
      const inv = em.getPlayer().inventory;
      if (inv.getCursorStack() !== null) {
        return;
      }
      if (!this._chestWithinReach(anchor)) {
        return;
      }
      const src =
        armorSlot !== null
          ? inv.getArmorStack(armorSlot)
          : inv.getStack(slotIndex);
      if (src === null || src.count <= 0) {
        return;
      }
      const tile = w.getChestTileAtAnchor(anchor.ax, anchor.ay);
      if (tile === undefined) {
        return;
      }
      const maxStack = (id: ItemId) => this._maxStackForItem(id);
      const { state: nextChest, remainder, firstChestIndex } =
        quickMoveStackIntoChest(tile, src, maxStack);
      if (firstChestIndex === null) {
        return;
      }
      if (armorSlot !== null) {
        inv.setArmorStack(armorSlot, remainder);
      } else {
        inv.setStack(slotIndex, remainder);
      }
      w.setChestTileAtAnchor(anchor.ax, anchor.ay, nextChest);
      this._chestPanel?.scrollChestSlotIntoView(firstChestIndex);
      const toEl = this._chestSlotDomElement(firstChestIndex);
      playShiftSlotFlyAnimation(fromEl, toEl);
      const hostId = net.lanHostPeerId as PeerId | null;
      if (hostId !== null) {
        this.adapter.send(hostId, {
          type: MsgType.CHEST_QUICKMOVE_TO_CHEST,
          wx: anchor.ax,
          wy: anchor.ay,
          itemId: src.itemId as number,
          count: src.count,
          damage: src.damage ?? 0,
        });
      }
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
      const chestIdx = this._quickMovePlayerOrArmorSlotToChest(
        slotIndex,
        armorSlot,
      );
      if (chestIdx !== null) {
        this._chestPanel?.scrollChestSlotIntoView(chestIdx);
        const toEl = this._chestSlotDomElement(chestIdx);
        playShiftSlotFlyAnimation(fromEl, toEl);
        return;
      }
    }

    const invDest =
      armorSlot !== null
        ? inv.quickMoveFromArmorSlot(armorSlot)
        : inv.quickMoveFromSlot(slotIndex);
    if (invDest !== null) {
      const toEl =
        invDest >= ARMOR_UI_SLOT_BASE &&
        invDest < ARMOR_UI_SLOT_BASE + ARMOR_SLOT_COUNT
          ? (this.inventoryUI?.getArmorSlotElement(
              (invDest - ARMOR_UI_SLOT_BASE) as ArmorSlot,
            ) ?? null)
          : (this.inventoryUI?.getOverlaySlotElement(invDest) ?? null);
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
      const anchor = this._activeChestAnchor;
      if (anchor === null) {
        return;
      }
      const hostId = net.lanHostPeerId as PeerId | null;
      if (hostId === null) {
        return;
      }
      if (button !== 0 && button !== 2) {
        return;
      }
      const w = this.world;
      const em = this.entityManager;
      if (w === null || em === null) {
        return;
      }
      const inv = em.getPlayer().inventory;
      const cur = inv.getCursorStack();

      // Shift-click: always take from chest into inventory (host gives items).
      if (button === 0 && shift) {
        // Basic visual feedback: animate into the player's inventory card.
        const toEl = this.inventoryUI?.getOverlaySlotElement(em.getPlayer().state.hotbarSlot) ?? null;
        playShiftSlotFlyAnimation(slotEl, toEl);
        this.adapter.send(hostId, {
          type: MsgType.CHEST_TAKE_REQUEST,
          wx: anchor.ax,
          wy: anchor.ay,
          slotIndex,
          button: 0,
        });
        return;
      }

      // If cursor is holding items, this is a place operation; do it locally and ask host to mirror.
      if (cur !== null && cur.count > 0) {
        const tile = w.getChestTileAtAnchor(anchor.ax, anchor.ay);
        if (tile === undefined) {
          return;
        }
        const maxStack = (id: ItemId) => this._maxStackForItem(id);
        const { state: next, cursor } = applyChestSlotMouse(
          tile,
          slotIndex,
          button,
          cur,
          maxStack,
        );
        w.setChestTileAtAnchor(anchor.ax, anchor.ay, next);
        inv.replaceCursorStack(cursor);
        this.adapter.send(hostId, {
          type: MsgType.CHEST_PUT_REQUEST,
          wx: anchor.ax,
          wy: anchor.ay,
          slotIndex,
          button,
          cursorItemId: cur.itemId as number,
          cursorCount: cur.count,
          cursorDamage: cur.damage ?? 0,
        });
        return;
      }

      // Otherwise: take from chest (host gives items).
      this.adapter.send(hostId, {
        type: MsgType.CHEST_TAKE_REQUEST,
        wx: anchor.ax,
        wy: anchor.ay,
        slotIndex,
        button,
      });
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

  private _quickMovePlayerOrArmorSlotToChest(
    slotIndex: number,
    armorSlot: ArmorSlot | null,
  ): number | null {
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
    const src =
      armorSlot !== null
        ? inv.getArmorStack(armorSlot)
        : inv.getStack(slotIndex);
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
    if (armorSlot !== null) {
      inv.setArmorStack(armorSlot, remainder);
    } else {
      inv.setStack(slotIndex, remainder);
    }
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
      const anchor = this._activeChestAnchor;
      const w = this.world;
      const em = this.entityManager;
      if (anchor === null || w === null || em === null) {
        return;
      }
      if (!this._chestWithinReach(anchor)) {
        return;
      }
      const inv = em.getPlayer().inventory;
      const cur = inv.getCursorStack();
      if (cur === null || cur.count <= 0) {
        return;
      }
      const hostId = net.lanHostPeerId as PeerId | null;
      if (hostId === null) {
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
        this.adapter.send(hostId, {
          type: MsgType.CHEST_PUT_REQUEST,
          wx: anchor.ax,
          wy: anchor.ay,
          slotIndex,
          button: 0,
          cursorItemId: cur.itemId as number,
          cursorCount: cur.count,
          cursorDamage: cur.damage ?? 0,
        });
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
        this.adapter.send(hostId, {
          type: MsgType.CHEST_PUT_REQUEST,
          wx: anchor.ax,
          wy: anchor.ay,
          slotIndex,
          button: 2,
          cursorItemId: cur.itemId as number,
          cursorCount: cur.count,
          cursorDamage: cur.damage ?? 0,
        });
      }
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
      const net = this.adapter.state;
      if (net.status === "connected" && net.role === "client") {
        this.bus.emit({
          type: "craft:result",
          ok: false,
          reason:
            "Furnace smelting from here is host-only. Open the furnace UI to queue smelts.",
        } satisfies GameEvent);
        return;
      }
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

      if (input.isJustPressed("toggleGpuDebug")) {
        this._gpuDebugHud?.toggle(pipeline);
      }

      if (input.isJustPressed("pause")) {
        if (this._isLocalDeathBlocking()) {
          // Pause / inventory / chat are disabled until respawn or main menu.
        } else if (this._chatOpen) {
          this.bus.emit({ type: "ui:chat-set-open", open: false } satisfies GameEvent);
        } else if (this.isInventoryOpen) {
          this.isInventoryOpen = false;
          this._applyInventoryPanelsOpen(false);
          this._syncWorldInputBlocked();
        } else {
          this.paused = !this.paused;
          this.uiShell?.setPauseOverlayOpen(this.paused);
          this._syncWorldInputBlocked();
        }
      }

      if (this.paused) {
        input.postUpdate();
        return;
      }

      if (input.isJustPressed("chat") && !this._chatOpen && !this._isLocalDeathBlocking()) {
        this._chatOpen = true;
        input.setChatOpen(true);
        this.bus.emit({ type: "ui:chat-set-open", open: true } satisfies GameEvent);
        this._syncWorldInputBlocked();
      }

      if (input.isJustPressed("inventory") && !this._isLocalDeathBlocking()) {
        this.isInventoryOpen = !this.isInventoryOpen;
        this._applyInventoryPanelsOpen(this.isInventoryOpen);
        this._syncWorldInputBlocked();
      }

      this._worldTime.tick(FIXED_TIMESTEP_MS);

      {
        const snd = this.audio;
        const w = this.world;
        const em = this.entityManager;
        if (snd !== null) {
          snd.setWorldForSpatial(w);
        }
        if (snd !== null && em !== null) {
          const pl = em.getPlayer().state.position;
          if (tickIndex % AUDIO_SPATIAL_LISTENER_UPDATE_INTERVAL_TICKS === 0) {
            snd.updateListenerPosition(pl.x, pl.y);
          }
          if (
            w !== null &&
            tickIndex % AUDIO_ENV_DETECT_INTERVAL_TICKS === 0
          ) {
            snd.updateEnvironment(w, pl.x, pl.y);
          }
        }
      }

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
          this.adapter.broadcast({
            type: MsgType.WEATHER_SYNC,
            rainRemainingSec: this._weather.getRainRemainingSec(),
          });
        }
      }

      if (role === "host" || role === "offline") {
        const wr = this._weather.tickAuthority(FIXED_TIMESTEP_SEC);
        if (wr.lightningStrike) {
          if (
            netStateForTime.status === "connected" &&
            netStateForTime.role === "host"
          ) {
            this.adapter.broadcast({
              type: MsgType.WEATHER_LIGHTNING,
            });
          }
          this._playLightningStrikeLocal();
        }
        if (wr.rainJustStarted || wr.rainJustEnded) {
          this._broadcastWeatherSyncToClients();
        }
      } else if (role === "client" && this._clientRainRemainingSec > 0) {
        this._clientRainRemainingSec = Math.max(
          0,
          this._clientRainRemainingSec - FIXED_TIMESTEP_SEC,
        );
      }

      const wantRain = this._isRainingForVisual();
      const px = entityManager.getPlayer().state.position.x;
      const py = entityManager.getPlayer().state.position.y;
      const rainColumnWx = Math.floor((px + PLAYER_WIDTH * 0.5) / BLOCK_SIZE);
      const outdoorRain =
        world.canHearOpenSkyRain(rainColumnWx, py);
      const rainAudibleTarget = wantRain && outdoorRain ? 1 : 0;
      const fadeK = 1 - Math.exp(-FIXED_TIMESTEP_SEC / Game.RAIN_AUDIO_FADE_SEC);
      this._rainAudioExposure +=
        (rainAudibleTarget - this._rainAudioExposure) * fadeK;
      this.audio?.setSfxRainExposure(this._rainAudioExposure);

      // Keep dual loops running for the whole storm; volume is only {@link _rainAudioExposure}
      // (open sky). Avoid stop/restart when stepping under cover — that was easy to miss audibly.
      if (wantRain && !this._rainAmbientActive) {
        this.audio?.startSfxRainDualAmbient("weather_rain_ambient", 0.28);
        this._rainAmbientActive = true;
        this._rainAmbientRefreshAccum = 0;
      }

      if (this._rainAmbientActive && !wantRain) {
        this.audio?.stopSfxRainDualAmbient();
        this._rainAmbientActive = false;
        this._rainAmbientRefreshAccum = 0;
      }

      if (
        this._rainAmbientActive &&
        wantRain &&
        this._rainAudioExposure > 0.12
      ) {
        this._rainAmbientRefreshAccum += FIXED_TIMESTEP_SEC;
        if (this._rainAmbientRefreshAccum >= Game.RAIN_AMBIENT_REFRESH_SEC) {
          this._rainAmbientRefreshAccum = 0;
          this.audio?.refreshSfxRainDualAmbient("weather_rain_ambient", 0.28);
        }
      }

      // Prefer melee hits over mining when clicking an entity (so mobs aren't "hard to hit"
      // due to a breakable block behind them).
      this._handleWandSelectionInput();
      this._maybeMeleeMob();
      withPerfSpan("EntityManager.update", () => {
        entityManager.update(dtSec);
      });

      this._tickLocalPlayerDeath(dtSec);

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
          if (brk.layer === "fg") {
            this.leafFallParticles?.syncLocalMiningBoost({
              wx: brk.wx,
              wy: brk.wy,
              blockId: bid,
              progress: plState.breakProgress,
            });
          } else {
            this.leafFallParticles?.syncLocalMiningBoost(null);
          }
        } else {
          this.blockBreakParticles?.syncLocalMiningBreak(null);
          this.leafFallParticles?.syncLocalMiningBoost(null);
        }
      } else {
        this.blockBreakParticles?.syncLocalMiningBreak(null);
        this.leafFallParticles?.syncLocalMiningBoost(null);
      }

      this._maybeBroadcastBlockBreakProgress(world, plState);

      this.blockBreakParticles?.update(dtSec);
      const pl = entityManager.getPlayer().state.position;
      this.leafFallParticles?.update(dtSec, pl.x, pl.y);
      // NOTE: firefly / butterfly ambient particles are visual-only and are now ticked
      // from the render path (see {@link Game._tickAmbientVisualParticles}) so their
      // cost scales with render FPS (and an adaptive-workload gate) rather than the
      // fixed 60 Hz simulation tick. Keeping them here regressed fixedUpdate CPU under
      // heavy scenes and wasn't needed — they don't affect gameplay state.
      this._playerStateBroadcastPhase += 1;
      if (this._playerStateBroadcastPhase >= 2) {
        this._playerStateBroadcastPhase = 0;
        this._playerStateBroadcaster.tick();
      }
      world.updateRemotePlayers(dtSec);
      withPerfSpan("Game.fixedUpdate.audioAmbient", () => {
        const em = this.entityManager;
        const w = this.world;
        const snd = this.audio;
        if (em !== null && w !== null && snd !== null) {
          const pl = em.getPlayer().state.position;
          this._remotePlayerMovementSfx.tick(
            dtSec,
            performance.now(),
            w,
            w.getRemotePlayers(),
            snd,
            pl.x,
            pl.y,
            w.getAirBlockId(),
          );
          this._tickFurnaceSmeltAmbient(dtSec);
          this._tickSheepAmbientSfx(dtSec);
          this._tickPigAmbientSfx(dtSec);
          this._tickDuckAmbientSfx(dtSec);
        }
      });
      const dropNet = this.adapter.state;
      {
        const mm = this._mobManager;
        if (role === "offline" || role === "host") {
          const rng = world.forkMobRng();
          withPerfSpan("Game.fixedUpdate.worldArrows", () => {
            world.updateArrows(
              dtSec,
              mm !== null
                ? (ox, oy, nx, ny, damage, shooterFeetX) =>
                    mm.tryArrowStrikeSegment(ox, oy, nx, ny, damage, shooterFeetX, rng)
                : null,
              mm !== null
                ? (mobId) => {
                    const m = mm.getById(mobId);
                    if (m === undefined) {
                      return undefined;
                    }
                    return {
                      x: m.x,
                      y: m.y,
                      tiltRad: mobDeathTipOverTiltRad(
                        m.kind,
                        m.facingRight,
                        m.deathAnimRemainSec,
                      ),
                      facingRight: m.facingRight,
                    };
                  }
                : undefined,
              (sx, sy) => {
                const snd = this.audio;
                const em = this.entityManager;
                if (snd === null || em === null) {
                  return;
                }
                const lp = em.getPlayer().state.position;
                const listenY = lp.y + PLAYER_HEIGHT * 0.5;
                snd.playSfx("bowhit", {
                  pitchVariance: 55,
                  world: {
                    listenerX: lp.x,
                    listenerY: listenY,
                    sourceX: sx,
                    sourceY: sy,
                  },
                });
              },
              (mobId) => {
                this.entityManager?.bumpMobHealthBar(mobId);
              },
            );
          });
        } else {
          world.updateArrows(dtSec, null, undefined, undefined, undefined);
        }
      }

      withPerfSpan("Game.fixedUpdate.droppedItems", () => {
        world.updateDroppedItems(
          dtSec,
          {
            x: pl.x,
            y: pl.y + PLAYER_HEIGHT * 0.5,
          },
          entityManager.getPlayer().inventory,
          () => {
            const snd = this.audio;
            if (snd === null) {
              return;
            }
            const now = performance.now();
            if (now - this._lastItemPickupSfxMs < ITEM_PICKUP_SFX_MIN_INTERVAL_MS) {
              return;
            }
            this._lastItemPickupSfxMs = now;
            snd.playSfx("item_pickup", { pitchVariance: 120 });
          },
          dropNet.status === "connected" && dropNet.role === "client"
            ? (netId) => {
                const hid = dropNet.lanHostPeerId;
                if (hid !== null) {
                  this.adapter.send(hid as PeerId, {
                    type: MsgType.DROP_PICKUP_REQUEST,
                    netId,
                  });
                }
              }
            : undefined,
          dropNet.status === "connected" && dropNet.role === "host"
            ? (netId) => {
                this.adapter.broadcast({
                  type: MsgType.DROP_DESPAWN,
                  netId,
                });
              }
            : undefined,
        );
      });

      if (
        (role === "offline" || role === "host") &&
        this.world !== null &&
        entityManager !== null
      ) {
        const arrowItemId = entityManager.tryGetArrowItemId();
        if (arrowItemId !== undefined) {
          this.world.collectGroundStuckArrows(
            {
              x: pl.x,
              y: pl.y + PLAYER_HEIGHT * 0.5,
            },
            entityManager.getPlayer().inventory,
            arrowItemId,
            () => {
              const snd = this.audio;
              if (snd === null) {
                return;
              }
              const now = performance.now();
              if (now - this._lastItemPickupSfxMs < ITEM_PICKUP_SFX_MIN_INTERVAL_MS) {
                return;
              }
              this._lastItemPickupSfxMs = now;
              snd.playSfx("item_pickup", { pitchVariance: 120 });
            },
          );
        }
      }

      if (role !== "client" && this.world !== null && this._mobManager !== null) {
        const rng = this.world.forkMobRng();
        const world = this.world;
        const zombiePlayerTargets: {
          peerId: string | null;
          x: number;
          y: number;
        }[] = [];
        const netForMobs = this.adapter.state;
        if (netForMobs.status !== "connected") {
          zombiePlayerTargets.push({ peerId: null, x: pl.x, y: pl.y });
        } else {
          const localPeer = this.adapter.getLocalPeerId();
          if (localPeer !== null) {
            zombiePlayerTargets.push({
              peerId: localPeer,
              x: pl.x,
              y: pl.y,
            });
          }
          for (const [pid, rp] of world.getRemotePlayers()) {
            const f = rp.getAuthorityFeet();
            zombiePlayerTargets.push({ peerId: pid, x: f.x, y: f.y });
          }
          if (zombiePlayerTargets.length === 0) {
            zombiePlayerTargets.push({ peerId: null, x: pl.x, y: pl.y });
          }
        }
        const sandboxWorld = this._isSandboxWorld();
        let spawnViewRects: ReadonlyArray<MobSpawnViewRect> | undefined;
        const pipeForSpawn = this.pipeline;
        if (pipeForSpawn !== null) {
          try {
            const cam = pipeForSpawn.getCamera();
            const { width: sw, height: sh } = pipeForSpawn.pixiApp.renderer.screen;
            if (sw > 0 && sh > 0) {
              const rects: MobSpawnViewRect[] = [
                buildMobSpawnViewRectFromCamera(
                  cam,
                  sw,
                  sh,
                  MOB_SPAWN_VIEW_MARGIN_SCREEN_PX,
                ),
              ];
              const z = cam.getZoom();
              const localPeerForSpawn = this.adapter.getLocalPeerId();
              for (const t of zombiePlayerTargets) {
                if (t.peerId !== null && t.peerId !== localPeerForSpawn) {
                  rects.push(
                    buildMobSpawnViewRectCenteredOnFeet(
                      t.x,
                      t.y,
                      sw,
                      sh,
                      z,
                      MOB_SPAWN_VIEW_MARGIN_SCREEN_PX,
                    ),
                  );
                }
              }
              spawnViewRects = rects;
            }
          } catch {
            /* Pixi not ready */
          }
        }
        this._mobManager.tickHost(
          FIXED_TIMESTEP_SEC,
          rng,
          this._worldTime.ms,
          { x: pl.x, y: pl.y },
          sandboxWorld ? [] : zombiePlayerTargets,
          sandboxWorld
            ? undefined
            : (peerId, dmg) => {
                const em = this.entityManager;
                if (em === null) {
                  return;
                }
                const localPeer = this.adapter.getLocalPeerId();
                const st = this.adapter.state;
                if (peerId === null || (localPeer !== null && peerId === localPeer)) {
                  em.getPlayer().takeDamage(dmg);
                  return;
                }
                if (st.status === "connected" && st.role === "host") {
                  this.adapter.send(peerId as PeerId, {
                    type: MsgType.PLAYER_DAMAGE_APPLIED,
                    damage: dmg,
                  });
                }
              },
          spawnViewRects,
        );
        const flush = this._mobManager.flushHostReplication();
        const netSt = this.adapter.state;
        if (netSt.status === "connected" && netSt.role === "host") {
          for (const id of flush.despawns) {
            this.adapter.broadcast({ type: MsgType.ENTITY_DESPAWN, entityId: id });
          }
          for (const sp of flush.spawns) {
            const spFx = this._pendingSpawnerFxByMobId.get(sp.id);
            if (spFx !== undefined) {
              this._pendingSpawnerFxByMobId.delete(sp.id);
            }
            this.adapter.broadcast({
              type: MsgType.ENTITY_SPAWN,
              entityId: sp.id,
              entityType: sp.type,
              x: sp.x,
              y: sp.y,
              woolColor: sp.woolColor,
              ...(spFx !== undefined
                ? { spawnerFxWx: spFx.wx, spawnerFxWy: spFx.wy }
                : {}),
            });
          }
          for (const v of flush.states) {
            let flags = 0;
            if (v.facingRight) {
              flags |= 1;
            }
            if (v.panic) {
              flags |= 2;
            }
            if (v.walking) {
              flags |= 4;
            }
            if (v.hurt) {
              flags |= 8;
            }
            if (v.attacking) {
              flags |= 16;
            }
            if (v.burning) {
              flags |= 32;
            }
            if (v.type === MobType.Slime) {
              if (v.slimeOnGround) {
                flags |= ENTITY_STATE_FLAG_SLIME_ON_GROUND;
              }
              if (v.slimeJumpPriming) {
                flags |= ENTITY_STATE_FLAG_SLIME_JUMP_PRIMING;
              }
            }
            this.adapter.broadcast({
              type: MsgType.ENTITY_STATE,
              entityId: v.id,
              entityType: v.type,
              x: v.x,
              y: v.y,
              vx: v.vx,
              vy: v.vy,
              hp: v.hp,
              flags,
              woolColor: v.woolColor,
              deathAnim10Ms: Math.min(
                255,
                Math.max(0, Math.round(v.deathAnimRemainSec / 0.01)),
              ),
            });
          }
        }
      }

      if (this._blockInteractions !== null && role !== "client") {
        const pbx = Math.floor(pl.x / BLOCK_SIZE);
        const pby = Math.floor(pl.y / BLOCK_SIZE);
        const rainGrowthMul = this._weather.isRaining() ? RAIN_GROWTH_MUL : 1;
        this._blockInteractions.tick(dtSec, pbx, pby, {
          rainGrowthMul,
        });
      }

      if (role !== "client" && this._itemRegistry !== null) {
        const tWater = import.meta.env.DEV ? chunkPerfNow() : 0;
        world.tickWaterSystems();
        if (import.meta.env.DEV) {
          chunkPerfLog("game:tickWaterSystems", chunkPerfNow() - tWater);
        }
        const simChunks = new Set<string>();
        {
          const localPx = entityManager.getPlayer().state.position.x;
          const localPy = entityManager.getPlayer().state.position.y;
          const lcx = Math.floor(localPx / BLOCK_SIZE / CHUNK_SIZE);
          const lcy = Math.floor(localPy / BLOCK_SIZE / CHUNK_SIZE);
          for (let dy = -SIMULATION_DISTANCE_CHUNKS; dy <= SIMULATION_DISTANCE_CHUNKS; dy++) {
            for (let dx = -SIMULATION_DISTANCE_CHUNKS; dx <= SIMULATION_DISTANCE_CHUNKS; dx++) {
              simChunks.add(`${lcx + dx},${lcy + dy}`);
            }
          }
          for (const rp of world.getRemotePlayers().values()) {
            const rcx = Math.floor(rp.x / BLOCK_SIZE / CHUNK_SIZE);
            const rcy = Math.floor(rp.y / BLOCK_SIZE / CHUNK_SIZE);
            for (let dy = -SIMULATION_DISTANCE_CHUNKS; dy <= SIMULATION_DISTANCE_CHUNKS; dy++) {
              for (let dx = -SIMULATION_DISTANCE_CHUNKS; dx <= SIMULATION_DISTANCE_CHUNKS; dx++) {
                simChunks.add(`${rcx + dx},${rcy + dy}`);
              }
            }
          }
        }
        const changed = world.tickFurnaces(
          FIXED_TIMESTEP_SEC,
          this._worldTime.ms,
          this._itemRegistry,
          this._smeltingRegistry,
          simChunks,
        );
        this._tickSpawnersHost(world, world.forkMobRng(), simChunks);
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

      world.flushPendingBlockChangedEvents();

      if (this._pendingBlockUpdates.length > 0) {
        const st = this.adapter.state;
        if (st.status === "connected" && st.role === "host") {
          if (this._pendingBlockUpdates.length === 1) {
            const e = this._pendingBlockUpdates[0]!;
            this.adapter.broadcast({
              type: MsgType.BLOCK_UPDATE,
              x: e.x,
              y: e.y,
              blockId: e.blockId,
              layer: e.layer,
              cellMetadata: e.cellMetadata,
            });
          } else {
            this.adapter.broadcast({
              type: MsgType.BLOCK_UPDATE_BATCH,
              entries: this._pendingBlockUpdates,
            });
          }
        }
        this._pendingBlockUpdates.length = 0;
      }

      input.postUpdate();

      const p = entityManager.getPlayer().state.position;
      const bx = Math.floor(p.x / BLOCK_SIZE);
      const by = Math.floor(p.y / BLOCK_SIZE);
      this._requestChunkStreamAroundPlayer(world, bx, by);
    }

    this.bus.emit({
      type: "game:tick",
      tickIndex,
      dtSec,
      worldTimeMs: this._worldTime.ms,
    } satisfies GameEvent);
  }

  /** Coalesces per-tick chunk streaming so slow loads always target the latest player block. */
  private _requestChunkStreamAroundPlayer(world: World, bx: number, by: number): void {
    this._chunkStreamBx = bx;
    this._chunkStreamBy = by;
    if (this._chunkStreamInflight) {
      this._chunkStreamDirty = true;
      return;
    }
    this._chunkStreamInflight = true;
    void this._runChunkStreamLoop(world);
  }

  private async _runChunkStreamLoop(world: World): Promise<void> {
    try {
      do {
        this._chunkStreamDirty = false;
        await world.streamChunksAroundPlayer(this._chunkStreamBx, this._chunkStreamBy);
        const st = this.adapter.state;
        const authority = st.status !== "connected" || st.role !== "client";
        if (authority && this._blockInteractions !== null) {
          this._blockInteractions.hydrateWheatSchedulesInLoadedWorld();
          this._blockInteractions.hydrateSaplingSchedulesInLoadedWorld();
        }
      } while (this._chunkStreamDirty);
    } catch (err: unknown) {
      console.warn("[Game] streamChunksAroundPlayer failed", err);
    } finally {
      this._chunkStreamInflight = false;
    }
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

  /**
   * Ambient particle (firefly / butterfly) tick, driven from the render path.
   * Runs interpolated with the camera but is gated by {@link paused} so behavior
   * matches the previous fixed-tick wiring whenever the game is frozen.
   */
  private _tickAmbientVisualParticles(dtSec: number, alpha: number): void {
    if (this.paused || dtSec <= 0) {
      return;
    }
    const pipe = this.pipeline;
    const em = this.entityManager;
    if (pipe === null || em === null) {
      return;
    }
    const s = em.getPlayer().state;
    const ix = s.prevPosition.x + (s.position.x - s.prevPosition.x) * alpha;
    const iy = s.prevPosition.y + (s.position.y - s.prevPosition.y) * alpha;
    if (!Number.isFinite(ix) || !Number.isFinite(iy)) {
      return;
    }
    const { width: sw, height: sh } = pipe.pixiApp.renderer.screen;
    const cam = pipe.getCamera();
    this.butterflyParticles?.update(dtSec, ix, iy, cam, sw, sh);
    this.fireflyParticles?.update(
      dtSec,
      ix,
      iy,
      cam,
      sw,
      sh,
      this._isNightForSleep(),
    );
  }

  private render(alpha: number): void {
    const now = performance.now();
    const winterAmount = 0;
    const dtSec =
      this.lastRenderWallMs > 0
        ? Math.min((now - this.lastRenderWallMs) / 1000, 0.1)
        : 0;
    this.lastRenderWallMs = now;
    this._gpuDebugHud?.beginFrame();
    const perfSpikePhaseMs: Record<string, number> = {};
    const perfMark = (phase: string, t0: number): void => {
      perfSpikePhaseMs[phase] = Math.max(0, performance.now() - t0);
    };

    if (this.world !== null) {
      const pipe = this.pipeline;
      if (pipe !== null) {
        const cam = pipe.getCamera().getPosition();
        const pcx = Math.floor(cam.x / (CHUNK_SIZE * BLOCK_SIZE));
        const pcy = Math.floor((-cam.y) / (CHUNK_SIZE * BLOCK_SIZE));
        this.world.setLightRecomputeViewChunk(pcx, pcy);
      } else {
        this.world.setLightRecomputeViewChunk(null, null);
      }
      const tLightFlush = import.meta.env.DEV ? chunkPerfNow() : 0;
      const tPhase = performance.now();
      // Keep frame pacing stable under load: spend less light time when the previous
      // render delta is already slow, then recover to full budget on healthy frames.
      const pendingLight = this.world.getPendingLightRecomputeCount();
      let lightFlushBudgetMs: number | undefined;
      if (dtSec > 1 / 24) {
        lightFlushBudgetMs = 1;
      } else if (dtSec > 1 / 35) {
        lightFlushBudgetMs = 2;
      } else if (pendingLight >= 96) {
        lightFlushBudgetMs = 5;
      } else if (pendingLight >= 48) {
        lightFlushBudgetMs = 4;
      } else if (pendingLight <= 8) {
        lightFlushBudgetMs = 2;
      } else {
        lightFlushBudgetMs = undefined;
      }
      withPerfSpan("World.flushPendingLightRecomputes", () => {
        this.world?.flushPendingLightRecomputes(lightFlushBudgetMs);
      });
      perfMark("World.flushPendingLightRecomputes", tPhase);
      if (import.meta.env.DEV) {
        chunkPerfLog("game:flushPendingLightRecomputes", chunkPerfNow() - tLightFlush);
      }
    }

    if (this.chunkRenderer !== null && this.world !== null) {
      const chunkRenderer = this.chunkRenderer;
      const cm = this.world.getChunkManager();
      const centre = this.world.getStreamCentre();
      const visible =
        centre === null
          ? cm.getLoadedChunks()
          : cm.getChunksWithinDistance(centre, getEffectiveViewDistanceChunks());
      const tSync = import.meta.env.DEV ? chunkPerfNow() : 0;
      const tSyncPhase = performance.now();
      withPerfSpan("ChunkRenderer.syncChunks", () => {
        this.chunkRenderer?.syncChunks(visible);
      });
      perfMark("ChunkRenderer.syncChunks", tSyncPhase);
      if (import.meta.env.DEV) {
        chunkPerfLog("game:chunkRendererSync", chunkPerfNow() - tSync);
      }
      const tSec = now * 0.001;
      let foliageWindBodies: FoliageWindInfluence[] | undefined;
      if (this.entityManager !== null) {
        const bodies: FoliageWindInfluence[] = [];
        const s = this.entityManager.getPlayer().state;
        if (!s.dead && !s.sleeping) {
          const ix =
            s.prevPosition.x + (s.position.x - s.prevPosition.x) * alpha;
          const iy =
            s.prevPosition.y + (s.position.y - s.prevPosition.y) * alpha;
          const rawVx = s.velocity.x;
          if (Math.abs(rawVx) >= 9) {
            this._foliageBendLatchLocal = Math.sign(rawVx);
          }
          const hb = feetToScreenAABB({ x: ix, y: iy });
          bodies.push({
            feetX: ix,
            feetY: iy,
            vx: rawVx,
            hitboxX: hb.x,
            hitboxY: hb.y,
            hitboxW: hb.width,
            hitboxH: hb.height,
            bendSignLatch: this._foliageBendLatchLocal,
          });
        } else {
          this._foliageBendLatchLocal = 0;
        }
        const remotes = this.world.getRemotePlayers();
        for (const [peerId, rp] of remotes) {
          const d = rp.getDisplayPose(now);
          if (Math.abs(d.vx) >= 9) {
            this._foliageBendLatchRemote.set(peerId, Math.sign(d.vx));
          }
          const hbR = feetToScreenAABB({ x: d.x, y: d.y });
          bodies.push({
            feetX: d.x,
            feetY: d.y,
            vx: d.vx,
            hitboxX: hbR.x,
            hitboxY: hbR.y,
            hitboxW: hbR.width,
            hitboxH: hbR.height,
            bendSignLatch: this._foliageBendLatchRemote.get(peerId) ?? 0,
          });
        }
        for (const id of this._foliageBendLatchRemote.keys()) {
          if (!remotes.has(id)) {
            this._foliageBendLatchRemote.delete(id);
          }
        }
        if (bodies.length > 0) {
          foliageWindBodies = bodies;
        }
      }
      const tFoliage = performance.now();
      withPerfSpan("ChunkRenderer.updateFoliageWind", () => {
        chunkRenderer.updateFoliageWind(tSec, foliageWindBodies);
      });
      perfMark("ChunkRenderer.updateFoliageWind", tFoliage);
      const tFurnace = performance.now();
      withPerfSpan("ChunkRenderer.updateFurnaceFire", () => {
        chunkRenderer.updateFurnaceFire(tSec);
      });
      perfMark("ChunkRenderer.updateFurnaceFire", tFurnace);
      const tRipple = performance.now();
      const entityManager = this.entityManager;
      if (entityManager !== null) {
        withPerfSpan("ChunkRenderer.updateWaterRipples", () => {
          chunkRenderer.updateWaterRipples(
            tSec,
            entityManager.collectWaterRippleBodies(alpha, now),
          );
        });
      } else {
        withPerfSpan("ChunkRenderer.updateWaterRipples", () => {
          chunkRenderer.updateWaterRipples(tSec, undefined);
        });
      }
      perfMark("ChunkRenderer.updateWaterRipples", tRipple);
    }

    if (this.entityManager !== null && this.pipeline !== null) {
      const s = this.entityManager.getPlayer().state;
      const ix = s.prevPosition.x + (s.position.x - s.prevPosition.x) * alpha;
      const iy = s.prevPosition.y + (s.position.y - s.prevPosition.y) * alpha;
      if (Number.isFinite(ix) && Number.isFinite(iy)) {
        this.pipeline
          .getCamera()
          .setTarget(ix, -iy - CAMERA_PLAYER_VERTICAL_OFFSET_PX);
      } else if (import.meta.env.DEV) {
        const nowMs = performance.now();
        if (nowMs - this._lastInvalidCameraTargetWarnMs > 2000) {
          this._lastInvalidCameraTargetWarnMs = nowMs;
          console.warn("[Game] Skipped camera target update due to invalid player interpolation.", {
            ix,
            iy,
          });
        }
      }
    }

    this.pipeline?.getCamera().update(dtSec);

    if (this.input !== null && this.pipeline !== null) {
      if (now - this._lastMouseWorldPosUpdateTime >= POINTER_MOVE_THROTTLE_MS) {
        this.input.updateMouseWorldPos(this.pipeline.getCamera());
        this._lastMouseWorldPosUpdateTime = now;
      }
    }

    this.entityManager?.syncPlayerGraphic(alpha, dtSec, now);

    // Ambient visual particles (fireflies/butterflies) tick on the render path so
    // their spawn probing & motion integration cost scales with draw FPS rather than
    // the fixed-timestep simulation loop, which had them competing with gameplay work.
    this._tickAmbientVisualParticles(dtSec, alpha);

    if (
      this._nametagOverlay !== null &&
      this.pipeline !== null &&
      this.entityManager !== null &&
      this.world !== null
    ) {
      const tTags = import.meta.env.DEV ? chunkPerfNow() : 0;
      const s = this.entityManager.getPlayer().state;
      this._nametagOverlay.update(
        this.mount,
        this.pipeline.getCanvas(),
        this.pipeline.getCamera(),
        alpha,
        now,
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
      if (import.meta.env.DEV) {
        chunkPerfLog("game:nametagOverlayUpdate", chunkPerfNow() - tTags);
      }
    }
    if (
      this._signHoverOverlay !== null &&
      this.pipeline !== null &&
      this.entityManager !== null &&
      this.world !== null &&
      this.input !== null
    ) {
      const playerState = this.entityManager.getPlayer().state;
      this._signHoverOverlay.update(
        this.world,
        this.pipeline.getCamera(),
        this.pipeline.getCanvas(),
        this.input.mouseWorldPos.x,
        this.input.mouseWorldPos.y,
        playerState.position.x,
        playerState.position.y,
      );
    }

    if (this._damageNumbersOverlay !== null && this.pipeline !== null) {
      this._damageNumbersOverlay.update(
        this.pipeline.getCanvas(),
        this.pipeline.getCamera(),
        dtSec,
      );
    }

    if (this.entityManager !== null && this.inventoryUI !== null) {
      const pl = this.entityManager.getPlayer();
      this.inventoryUI.setSandboxHud(this._isSandboxWorld());
      this.inventoryUI.update(
        pl.inventory,
        pl.state.hotbarSlot,
        pl.state.health,
        pl.state.bowDrawSec,
        pl.state.temporaryHealth,
        pl.state.temporaryHealthRemainSec,
      );
      this._craftingPanel?.update(pl.inventory);
      this._chestPanel?.update();
      this._creativePanel?.update();
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
      const toggleBgCode =
        this.input?.getKeyBindingsForAction("toggleBackgroundMode")[0] ?? null;
      this.inventoryUI?.setBackgroundEditMode(
        this.entityManager.getPlayer().state.backgroundEditMode,
        toggleBgCode,
      );
    }
    this.pipeline?.prepareFrame();
    if (this.pipeline !== null) {
      const pipeline = this.pipeline;
      const baseLighting = this._worldTime.getLightingParams();
      const rainingGlobal = this._isRainingForVisual();
      let rainVisual = rainingGlobal && winterAmount < 0.2;
      if (
        rainingGlobal &&
        this.world !== null &&
        this.entityManager !== null
      ) {
        const st = this.entityManager.getPlayer().state;
        const pwx = Math.floor((st.position.x + PLAYER_WIDTH * 0.5) / BLOCK_SIZE);
        if (this.world.isDesertColumn(pwx)) {
          rainVisual = false;
        }
      }
      const lightingParams = applyRainLightingTint(
        baseLighting,
        rainVisual ? 1 : 0,
      );
      const lightningAlpha =
        rainVisual && this._lightningAnimEndMs > now
          ? ((this._lightningAnimEndMs - now) / 300) * 0.95
          : 0;
      pipeline.updateSky(lightingParams, this._worldTime.ms, {
        lightningAlpha,
      });
      pipeline.updateWeatherOverlay(rainVisual, dtSec);
      pipeline.updateSnowfallEffect(winterAmount, dtSec);
      if (this.world !== null && this.entityManager !== null) {
        const cam = pipeline.getCamera();
        const pos = cam.getPosition();
        const player = this.entityManager.getPlayer();
        const torchId = this.world
          .getRegistry()
          .getByIdentifier("stratum:torch").id;
        let heldTorch: HeldTorchLighting | null = null;
        if (player.getSelectedHotbarBlockId() === torchId) {
          const ht = this._heldTorchScratch;
          const tip = this.entityManager.getHeldTorchLightWorldBlock();
          if (tip !== null) {
            ht.worldBlock[0] = tip[0];
            ht.worldBlock[1] = tip[1];
            heldTorch = ht;
          } else {
            const st = player.state;
            ht.worldBlock[0] = (st.position.x + PLAYER_WIDTH * 0.5) / BLOCK_SIZE;
            ht.worldBlock[1] = (st.position.y + PLAYER_HEIGHT * 0.5) / BLOCK_SIZE;
            heldTorch = ht;
          }
        }
        const dynamicLightEmitters = this._fireflyLightingScratch;
        dynamicLightEmitters.length = 0;
        const playerCenterWx =
          (player.state.position.x + PLAYER_WIDTH * 0.5) / BLOCK_SIZE;
        const playerCenterWy =
          (player.state.position.y + PLAYER_HEIGHT * 0.5) / BLOCK_SIZE;
        this.fireflyParticles?.collectDynamicLightEmitters(
          playerCenterWx,
          playerCenterWy,
          dynamicLightEmitters,
        );
        withPerfSpan("LightingComposer.update", () => {
          pipeline.lightingComposer.update(
            lightingParams,
            pos.x,
            pos.y,
            heldTorch,
            dynamicLightEmitters,
          );
        });
      }
    }
    const tRenderPipeline = performance.now();
    withPerfSpan("RenderPipeline.render", () => {
      this.pipeline?.render(alpha);
    });
    perfMark("RenderPipeline.render", tRenderPipeline);
    this._gpuDebugHud?.sync(this.pipeline, dtSec);
    if (import.meta.env.DEV) {
      const frameMs = dtSec * 1000;
      const renderMs = perfSpikePhaseMs["RenderPipeline.render"] ?? 0;
      // Wall dtSec is time between RAF callbacks; it spikes when the tab is throttled,
      // DevTools pauses, or work runs outside render() — not necessarily GPU draw cost.
      const renderHeavy = renderMs >= 18;
      const longWallGap = frameMs >= 120;
      if (
        (renderHeavy || longWallGap) &&
        now - this._lastPerfSpikeLogMs >= 4000
      ) {
        this._lastPerfSpikeLogMs = now;
        const entries = Object.entries(perfSpikePhaseMs).sort((a, b) => b[1] - a[1]);
        const topPhases = entries.slice(0, 5).map(([phase, ms]) => `${phase}:${ms.toFixed(2)}ms`);
        const label = renderHeavy
          ? "[Game] Render budget spike"
          : "[Game] Long frame interval (likely outside render; check RAF throttling / main thread)";
        console.warn(label, {
          frameMs: Number(frameMs.toFixed(2)),
          renderMs: Number(renderMs.toFixed(2)),
          dtSec: Number(dtSec.toFixed(4)),
          pendingLight: this.world?.getPendingLightRecomputeCount() ?? 0,
          topPhases,
        });
      }
    }
    this.bus.emit({ type: "game:render", alpha } satisfies GameEvent);
  }

  /** Read custom skin bytes from IndexedDB and broadcast as PLAYER_SKIN_DATA. */
  private async _sendLocalCustomSkinData(): Promise<void> {
    const skinId = this._localSkinId;
    if (skinId === null || !skinId.startsWith("custom:")) {
      return;
    }
    const customId = skinId.slice("custom:".length);
    try {
      const tempStore = new IndexedDBStore();
      await tempStore.openDB();
      const record = await tempStore.getCustomSkin(customId);
      if (record === undefined) {
        return;
      }
      const bytes = new Uint8Array(await record.blob.arrayBuffer());
      if (bytes.length > PLAYER_SKIN_DATA_MAX_BYTES) {
        return;
      }
      const localId = this.adapter.getLocalPeerId();
      if (localId === null) {
        return;
      }
      this.adapter.broadcast({
        type: MsgType.PLAYER_SKIN_DATA,
        subjectPeerId: localId,
        skinPngBytes: bytes,
      });
    } catch {
      // Non-fatal; remote players will see the default skin.
    }
  }
}
