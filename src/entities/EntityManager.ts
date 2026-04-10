/**
 * Phase 1: local player only.
 */
import {
  AnimatedSprite,
  Assets,
  Container,
  Graphics,
  Rectangle,
  Sprite,
  Texture,
} from "pixi.js";
import { MobManager } from "./mobs/MobManager";
import { MobType } from "./mobs/mobTypes";
import {
  PIG_BODY_TRIM_TARGET_PX,
  PIG_DEATH_ANIM_SEC,
  PIG_FEET_SPRITE_NUDGE_Y_PX,
  PIG_IDLE_FRAMES,
  PIG_RENDER_SCALE_MULT,
  PIG_SPRITE_REL,
  PIG_WALK_FRAMES,
  SHEEP_BODY_TRIM_TARGET_PX,
  SHEEP_DEATH_ANIM_SEC,
  SHEEP_FEET_SPRITE_NUDGE_Y_PX,
  ZOMBIE_DEATH_ANIM_SEC,
  ZOMBIE_FEET_SPRITE_NUDGE_Y_PX,
  ZOMBIE_SPRITE_REL,
  SHEEP_RENDER_SCALE_MULT,
  SHEEP_IDLE_FRAMES,
  SHEEP_MASK_SPRITE_REL,
  SHEEP_SPRITE_REL,
  SHEEP_WALK_FRAMES,
} from "./mobs/mobConstants";
import { getSheepWoolTintHex } from "./mobs/sheepWool";
import type { AudioEngine } from "../audio/AudioEngine";
import {
  BLOCK_SIZE,
  HOTBAR_SIZE,
  PLAYER_HEIGHT,
  PLAYER_BODY_ATLAS_FRAMES,
  PLAYER_BODY_ATLAS_IMAGE_REL,
  PLAYER_BODY_ATLAS_JSON_REL,
  PLAYER_BODY_REQUIRED_FRAME_COUNT,
  PLAYER_BODY_IDLE_FRAME_INDEX,
  PLAYER_BODY_JUMP_DOWN_FRAME_INDEX,
  PLAYER_BODY_JUMP_UP_FRAME_INDEX,
  PLAYER_BODY_MINING_FRAME_INDEX,
  PLAYER_BODY_WALK_CYCLE_INDICES,
  PLAYER_BREAKING_ANIM_SPEED,
  PLAYER_BREAKING_MINING_FRAME_OFFSET_X_TEXELS,
  PLAYER_BREAKING_MINING_FRAME_OFFSET_Y_TEXELS,
  PLAYER_HELD_ITEM_ANCHOR_X,
  PLAYER_HELD_ITEM_ANCHOR_Y,
  PLAYER_HELD_ITEM_FACING_SIDE_NUDGE_X_PX,
  PLAYER_HELD_ITEM_HAND_OFFSET_X_TEXELS,
  PLAYER_HELD_ITEM_AIR_JUMP_NUDGE_Y_PX,
  PLAYER_HELD_BREAK_FRAME_NUDGE_FORWARD_PX,
  PLAYER_HELD_BREAK_FRAME_NUDGE_UP_PX,
  PLAYER_HELD_BREAK_FRAME_ROTATION_RAD,
  PLAYER_HELD_ITEM_OUTWARD_NUDGE_X_PX,
  PLAYER_HELD_ITEM_OUTWARD_NUDGE_Y_PX,
  PLAYER_HELD_ITEM_HAND_OFFSET_Y_TEXELS,
  PLAYER_HELD_ITEM_SCALE_MULTIPLIER,
  PLAYER_HELD_AXE_NUDGE_X_PX,
  PLAYER_HELD_AXE_NUDGE_Y_PX,
  PLAYER_HELD_AXE_ROTATION_RAD,
  PLAYER_HELD_PLACEABLE_BLOCK_NUDGE_Y_PX,
  PLAYER_HELD_PLACEABLE_BLOCK_REL_SCALE,
  PLAYER_MOVE_ANIM_VEL_THRESHOLD,
  PLAYER_REMOTE_SPRINT_VEL_THRESHOLD,
  PLAYER_SPRITE_FEET_OFFSET_PX,
  PLAYER_SPRITE_FEET_PAD_TEXELS,
  PLAYER_SPRITE_SCALE_MULTIPLIER,
  PLAYER_SPRINT_ANIM_SPEED_MULT,
  PLAYER_REMOTE_AIR_VY_THRESHOLD,
  PLAYER_REMOTE_ANIM_VEL_SMOOTH_PER_SEC,
  PLAYER_DAMAGE_TINT_DURATION_SEC,
  PLAYER_WALK_ANIM_SPEED,
  PLAYER_WIDTH,
  REACH_BLOCKS,
} from "../core/constants";
import { stratumCoreTextureAssetUrl } from "../core/textureManifest";
import type { EventBus } from "../core/EventBus";
import { getReachLineGeometry } from "../input/aimDirection";
import type { InputManager } from "../input/InputManager";
import type { ItemId } from "../core/itemDefinition";
import type { ItemRegistry } from "../items/ItemRegistry";
import type { AtlasLoader } from "../renderer/AtlasLoader";
import type { RenderPipeline } from "../renderer/RenderPipeline";
import type { BlockRegistry } from "../world/blocks/BlockRegistry";
import type { World } from "../world/World";
import type { DoorPlayerSample } from "../world/door/doorWorld";
import { createAABB, type AABB } from "./physics/AABB";
import { Player } from "./Player";

/** `strength` 0 = white, 1 = strong red (multiplies sprite RGB). */
function playerHurtTintRgb(strength: number): number {
  const k = Math.min(1, Math.max(0, strength));
  const r = 255;
  const g = Math.round(255 * (1 - k * 0.74));
  const b = Math.round(255 * (1 - k * 0.78));
  return (r << 16) | (g << 8) | b;
}

function feetCollisionAABBForDoors(pos: { x: number; y: number }): AABB {
  const x = pos.x - PLAYER_WIDTH * 0.5;
  const y = -(pos.y + PLAYER_HEIGHT);
  return createAABB(x, y, PLAYER_WIDTH, PLAYER_HEIGHT);
}

function doorSamplesForWorld(
  player: Player,
  world: World,
): DoorPlayerSample[] {
  const s = player.state;
  const out: DoorPlayerSample[] = [
    {
      aabb: feetCollisionAABBForDoors(s.position),
      vx: s.velocity.x,
    },
  ];
  for (const rp of world.getRemotePlayers().values()) {
    const f = rp.getAuthorityFeet();
    out.push({
      aabb: feetCollisionAABBForDoors({ x: f.x, y: f.y }),
      vx: rp.velocityX,
    });
  }
  return out;
}
import { z } from "zod";

function sliceAtlasFrames(
  sheet: Texture,
  rects: readonly Readonly<{ x: number; y: number; w: number; h: number }>[],
): Texture[] {
  const src = sheet.source;
  if (src === undefined) {
    return [];
  }
  const out: Texture[] = [];
  for (const r of rects) {
    if (
      r.x < 0 ||
      r.y < 0 ||
      r.w <= 0 ||
      r.h <= 0 ||
      r.x + r.w > sheet.width + 0.5 ||
      r.y + r.h > sheet.height + 0.5
    ) {
      return [];
    }
    out.push(
      new Texture({
        source: src,
        frame: new Rectangle(r.x, r.y, r.w, r.h),
      }),
    );
  }
  return out;
}

type SheepCropRect = Readonly<{ x: number; y: number; w: number; h: number }>;

/**
 * Turn `sheep_mask.png` slices into white RGBA silhouettes (alpha = wool coverage).
 * Avoids Pixi sprite masks / multiply at draw time — fixes GPU stencil quirks at screen edges.
 */
async function buildSheepWoolSilhouetteTextures(
  maskImageUrl: string,
  rects: readonly SheepCropRect[],
): Promise<Texture[] | null> {
  let bmp: ImageBitmap | null = null;
  try {
    const res = await fetch(maskImageUrl);
    if (!res.ok) {
      return null;
    }
    bmp = await createImageBitmap(await res.blob());
  } catch {
    return null;
  }
  try {
    if (bmp === null) {
      return null;
    }
    const maskBmp = bmp;
    const out: Texture[] = [];
    for (const r of rects) {
      const canvas = document.createElement("canvas");
      canvas.width = r.w;
      canvas.height = r.h;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (ctx === null) {
        return null;
      }
      ctx.drawImage(maskBmp, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
      const img = ctx.getImageData(0, 0, r.w, r.h);
      const d = img.data;
      for (let p = 0; p < d.length; p += 4) {
        const pr = d[p]!;
        const pg = d[p + 1]!;
        const pb = d[p + 2]!;
        const pa = d[p + 3]!;
        if (pa < 3) {
          d[p + 3] = 0;
          continue;
        }
        const lum = (pr + pg + pb) / 3;
        // Plate / empty margin: very light and opaque — drop.
        if (lum > 250 && pa > 220) {
          d[p + 3] = 0;
          continue;
        }
        // Artist mask: dark “ink” = wool; transparent elsewhere.
        const ink = Math.max(0, (255 - lum) / 255);
        if (ink < 0.03 && pa < 96) {
          d[p + 3] = 0;
          continue;
        }
        const outA = Math.min(255, Math.round(pa * Math.max(ink, 0.12)));
        d[p] = 255;
        d[p + 1] = 255;
        d[p + 2] = 255;
        d[p + 3] = outA;
      }
      ctx.putImageData(img, 0, 0);
      const tex = Texture.from(canvas);
      if (tex.source !== undefined) {
        tex.source.scaleMode = "nearest";
      }
      out.push(tex);
    }
    return out.length === rects.length ? out : null;
  } finally {
    bmp?.close();
  }
}

function destroyTextureList(textures: Texture[] | null): void {
  if (textures === null) {
    return;
  }
  for (const t of textures) {
    t.destroy(true);
  }
}

const playerBodyAtlasJsonZ = z.object({
  frames: z.array(
    z.object({
      x: z.number().int().nonnegative(),
      y: z.number().int().nonnegative(),
      w: z.number().int().positive(),
      h: z.number().int().positive(),
    }),
  ),
});

function sliceBodyFrames(
  sheet: Texture,
  rects: readonly Readonly<{ x: number; y: number; w: number; h: number }>[],
): Texture[] {
  return sliceAtlasFrames(sheet, rects);
}

async function tryFetchPlayerBodyAtlasRects(): Promise<
  readonly Readonly<{ x: number; y: number; w: number; h: number }>[] | null
> {
  const url = stratumCoreTextureAssetUrl(PLAYER_BODY_ATLAS_JSON_REL);
  try {
    const res = await fetch(url);
    if (!res.ok) {
      return null;
    }
    const raw: unknown = await res.json();
    const parsed = playerBodyAtlasJsonZ.safeParse(raw);
    if (
      !parsed.success ||
      parsed.data.frames.length < PLAYER_BODY_REQUIRED_FRAME_COUNT
    ) {
      return null;
    }
    return parsed.data.frames;
  } catch {
    return null;
  }
}

type WalkAnimModeRef = { v: "idle" | "walk" | "breaking" | "skid" };

type WalkAnimTextures = {
  readonly idle: Texture[];
  readonly cycle: Texture[];
  readonly mode: WalkAnimModeRef;
};

type SurfaceModeRef = { v: "ground" | "air" };

function layoutPlayerSprite(sprite: AnimatedSprite, uniformScale: number): void {
  sprite.anchor.set(0.5, 1);
  // Sub-pixel motion stays smooth; texture uses nearest-neighbor (no root snapping — that read as jitter).
  sprite.roundPixels = false;
  const feetNudge =
    PLAYER_SPRITE_FEET_OFFSET_PX + PLAYER_SPRITE_FEET_PAD_TEXELS * uniformScale;
  sprite.position.set(
    Math.round(PLAYER_WIDTH * 0.5),
    Math.round(PLAYER_HEIGHT + feetNudge),
  );
  sprite.scale.set(uniformScale, uniformScale);
}

/** Call after {@link syncPlayerBodyAnimation} so scale is current; fixes mine-frame art vs idle alignment. */
function applyPlayerSpriteFeetPosition(
  sprite: AnimatedSprite,
  uniformScale: number,
  miningTwoFrameLoop: boolean,
  facingRight: boolean,
): void {
  const feetNudge =
    PLAYER_SPRITE_FEET_OFFSET_PX + PLAYER_SPRITE_FEET_PAD_TEXELS * uniformScale;
  const onBreakingCell =
    miningTwoFrameLoop && sprite.currentFrame === 1;
  const mirrorX = facingRight ? -1 : 1;
  const ox = onBreakingCell
    ? PLAYER_BREAKING_MINING_FRAME_OFFSET_X_TEXELS * uniformScale * mirrorX
    : 0;
  const oy = onBreakingCell
    ? PLAYER_BREAKING_MINING_FRAME_OFFSET_Y_TEXELS * uniformScale
    : 0;
  sprite.position.set(
    Math.round(PLAYER_WIDTH * 0.5 + ox),
    Math.round(PLAYER_HEIGHT + feetNudge + oy),
  );
}

function syncWalkAnimation(
  sprite: AnimatedSprite,
  moving: boolean,
  sprinting: boolean,
  facingRight: boolean,
  baseScale: number,
  walkAnim: WalkAnimTextures | null,
  skidding: boolean,
  skidTextures: Texture[] | null,
): void {
  if (walkAnim === null) {
    return;
  }
  if (skidding && skidTextures !== null && skidTextures.length > 0) {
    if (walkAnim.mode.v !== "skid") {
      walkAnim.mode.v = "skid";
      sprite.textures = skidTextures;
      sprite.gotoAndStop(0);
    }
    sprite.stop();
    sprite.scale.x = facingRight ? -baseScale : baseScale;
    sprite.scale.y = baseScale;
    return;
  }
  if (walkAnim.mode.v === "skid") {
    walkAnim.mode.v = "idle";
  }
  if (moving) {
    if (walkAnim.mode.v !== "walk") {
      walkAnim.mode.v = "walk";
      sprite.textures = walkAnim.cycle;
      sprite.gotoAndPlay(0);
    }
    sprite.animationSpeed = sprinting
      ? PLAYER_WALK_ANIM_SPEED * PLAYER_SPRINT_ANIM_SPEED_MULT
      : PLAYER_WALK_ANIM_SPEED;
    if (!sprite.playing) {
      sprite.play();
    }
  } else {
    if (walkAnim.mode.v !== "idle") {
      walkAnim.mode.v = "idle";
      sprite.textures = walkAnim.idle;
    }
    sprite.gotoAndStop(0);
  }
  // PNG faces left; mirror when moving/facing +X (right).
  sprite.scale.x = facingRight ? -baseScale : baseScale;
  sprite.scale.y = baseScale;
}

function syncPlayerBodyAnimation(
  sprite: AnimatedSprite,
  onGround: boolean,
  moving: boolean,
  sprinting: boolean,
  facingRight: boolean,
  baseScale: number,
  walkAnim: WalkAnimTextures | null,
  velocityY: number,
  jumpUpTextures: Texture[] | null,
  jumpDownTextures: Texture[] | null,
  surface: SurfaceModeRef,
  breakingTextures: Texture[] | null,
  miningActive: boolean,
  skidding: boolean,
  skidTextures: Texture[] | null,
): void {
  if (
    miningActive &&
    breakingTextures !== null &&
    breakingTextures.length >= 2
  ) {
    if (walkAnim !== null && walkAnim.mode.v !== "breaking") {
      walkAnim.mode.v = "breaking";
      sprite.textures = breakingTextures;
      sprite.loop = true;
      sprite.animationSpeed = PLAYER_BREAKING_ANIM_SPEED;
      sprite.gotoAndPlay(0);
    }
    if (walkAnim?.mode.v === "breaking" && !sprite.playing) {
      sprite.play();
    }
    sprite.scale.x = facingRight ? -baseScale : baseScale;
    sprite.scale.y = baseScale;
    return;
  }

  if (walkAnim !== null && walkAnim.mode.v === "breaking") {
    walkAnim.mode.v = "idle";
  }

  if (
    !onGround &&
    jumpUpTextures !== null &&
    jumpDownTextures !== null &&
    jumpUpTextures.length > 0 &&
    jumpDownTextures.length > 0
  ) {
    if (surface.v === "ground") {
      surface.v = "air";
      if (walkAnim !== null) {
        walkAnim.mode.v = "idle";
      }
    }
    sprite.textures =
      velocityY < 0 ? jumpUpTextures : jumpDownTextures;
    sprite.gotoAndStop(0);
    sprite.stop();
    sprite.scale.x = facingRight ? -baseScale : baseScale;
    sprite.scale.y = baseScale;
    return;
  }
  if (onGround && surface.v === "air" && walkAnim !== null) {
    // syncWalkAnimation only swaps textures when mode changes; after jump, mode is often still
    // "idle", so force a mismatch so idle or walk frames are reapplied on landing.
    walkAnim.mode.v = moving ? "idle" : "walk";
  }
  surface.v = onGround ? "ground" : "air";
  if (walkAnim === null) {
    sprite.scale.x = facingRight ? -baseScale : baseScale;
    sprite.scale.y = baseScale;
    return;
  }
  syncWalkAnimation(
    sprite,
    moving,
    sprinting,
    facingRight,
    baseScale,
    walkAnim,
    skidding,
    skidTextures,
  );
}

/** Local player sheep: base sprite + optional wool overlay (white silhouette × tint, no mask). */
type SheepRig = {
  root: Container;
  base: AnimatedSprite;
  wool: AnimatedSprite | null;
};

type PigRig = {
  root: Container;
  base: AnimatedSprite;
};

type ZombieRig = {
  root: Container;
  base: AnimatedSprite;
  fire: AnimatedSprite;
};

export class EntityManager {
  private readonly world: World;
  private readonly input: InputManager;
  private readonly player: Player;
  private readonly airId: number;
  private readonly itemRegistry: ItemRegistry;
  /** Packed item atlas (block + item manifest paths); dropped entities use this, not terrain atlas. */
  private readonly itemTextureAtlas: AtlasLoader;
  /** World-space root for the local player (hitbox top-left). */
  private playerGraphic: Container | null = null;
  private localPlayerAnim: AnimatedSprite | null = null;
  /** Sibling of the local body sprite; draw order via `zIndex` (body over tool when facing left). */
  private localHeldItemSprite: Sprite | null = null;
  private localPlayerPlaceholder: Graphics | null = null;
  /** Sliced cells from {@link PLAYER_BODY_ATLAS_IMAGE_REL} (≥ {@link PLAYER_BODY_REQUIRED_FRAME_COUNT}). */
  private playerBodyAtlasFrames: Texture[] | null = null;
  private playerIdleAnimTextures: Texture[] | null = null;
  private playerWalkCycleTextures: Texture[] | null = null;
  private playerJumpUpAnimTextures: Texture[] | null = null;
  private playerJumpDownAnimTextures: Texture[] | null = null;
  /** Single-frame skid / brake pose (same cell as mining swing; static while reversing). */
  private playerSkidAnimTextures: Texture[] | null = null;
  /** Two frames: idle + mining pose (loops while mining). */
  private playerBreakingAnimTextures: Texture[] | null = null;
  private readonly localWalkAnimMode: WalkAnimModeRef = { v: "idle" };
  private readonly localSurfaceMode: SurfaceModeRef = { v: "ground" };
  private readonly remoteWalkAnimMode = new Map<string, WalkAnimModeRef>();
  private readonly remoteSurfaceMode = new Map<string, SurfaceModeRef>();
  /** Smoothed net vx/vy for remote animation (reduces threshold flicker). */
  private readonly remoteAnimVelX = new Map<string, number>();
  private readonly remoteAnimVelY = new Map<string, number>();
  private playerSpriteBaseScale = 1;
  private aimGraphic: Graphics | null = null;
  private aimLineSprite: Sprite | null = null;
  private readonly remoteGraphics = new Map<string, Container>();
  private readonly droppedSprites = new Map<string, Sprite>();
  private droppedBobPhase = 0;
  private mobManager: MobManager | null = null;
  private sheepWalkTextures: Texture[] | null = null;
  private sheepIdleTextures: Texture[] | null = null;
  /** Pre-baked from `sheep_mask.png`: white RGB, alpha = wool — tint in `syncSheepSprites`. */
  private sheepWoolOverlayWalkTextures: Texture[] | null = null;
  private sheepWoolOverlayIdleTextures: Texture[] | null = null;
  private readonly sheepSprites = new Map<number, SheepRig>();
  private pigWalkTextures: Texture[] | null = null;
  private pigIdleTextures: Texture[] | null = null;
  private readonly pigSprites = new Map<number, PigRig>();
  /** Reuses sliced player body textures (see {@link hydrateZombieTexturesFromPlayerBody}). */
  private zombieWalkTextures: Texture[] | null = null;
  private zombieIdleTextures: Texture[] | null = null;
  private zombieJumpTextures: Texture[] | null = null;
  private zombieAttackTextures: Texture[] | null = null;
  private zombieFireTextures: Texture[] | null = null;
  private zombieFirePhase = 0;
  private zombieSpriteBaseScale = 1;
  private readonly zombieSprites = new Map<number, ZombieRig>();

  constructor(
    world: World,
    input: InputManager,
    registry: BlockRegistry,
    bus: EventBus,
    audio: AudioEngine,
    itemRegistry: ItemRegistry,
    itemTextureAtlas: AtlasLoader,
  ) {
    this.world = world;
    this.input = input;
    this.player = new Player(registry, bus, audio, itemRegistry);
    this.airId = registry.getByIdentifier("stratum:air").id;
    this.itemRegistry = itemRegistry;
    this.itemTextureAtlas = itemTextureAtlas;
  }

  /** Call after {@link RenderPipeline.init} so `layerEntities` is mounted. */
  initVisual(pipeline: RenderPipeline): void {
    const root = new Container();
    root.sortableChildren = true;
    // Sprite extends past the 14×28 hitbox; don’t let world cull clip the edges while mining.
    root.cullable = false;
    root.cullableChildren = false;
    const placeholder = new Graphics();
    placeholder.rect(0, 0, PLAYER_WIDTH, PLAYER_HEIGHT);
    placeholder.fill({ color: 0x00ffff });
    root.addChild(placeholder);
    pipeline.layerEntities.addChild(root);
    this.playerGraphic = root;
    this.localPlayerPlaceholder = placeholder;
    this.localPlayerAnim = null;

    const aim = new Graphics();
    pipeline.layerForeground.addChild(aim);
    this.aimGraphic = aim;

    this.aimLineSprite = null;
    void this.loadAimLineSprite(pipeline);
    void this.loadPlayerSprites();
    void this.loadSheepSprites();
    void this.loadPigSprites();
    void this.loadZombieSprites();
    void this.loadZombieFireOverlay();

    // Remote players are added lazily in syncPlayerGraphic when their state appears in World.
  }

  private async loadZombieFireOverlay(): Promise<void> {
    try {
      const url = stratumCoreTextureAssetUrl("environment/fire.png");
      const tex =
        (await Assets.load<Texture>(url)) ?? Assets.get<Texture>(url);
      if (tex === undefined || tex === Texture.EMPTY || tex.source === undefined) {
        return;
      }
      tex.source.scaleMode = "nearest";
      tex.source.autoGenerateMipmaps = false;
      // `fire.png` is an animated strip: 8 vertical frames, 16×16 each (16×128 total).
      const fw = 16;
      const fh = 16;
      const frames = 8;
      const rects: { x: number; y: number; w: number; h: number }[] = [];
      for (let i = 0; i < frames; i++) {
        rects.push({ x: 0, y: i * fh, w: fw, h: fh });
      }
      const sliced = sliceAtlasFrames(tex, rects);
      this.zombieFireTextures = sliced.length === frames ? sliced : null;
    } catch {
      this.zombieFireTextures = null;
    }
  }

  /** Mobs render in the same layer as the local player root (see {@link syncSheepSprites}). */
  setMobManager(manager: MobManager | null): void {
    this.mobManager = manager;
  }

  getPlayer(): Player {
    return this.player;
  }

  /** Route block break / place through host RPCs when true. */
  setMultiplayerTerrainClient(v: boolean): void {
    this.player.setMultiplayerTerrainClient(v);
  }

  /** Pose extras for `PLAYER_STATE` / host snapshots (matches local held + mining body logic). */
  getLocalPlayerNetworkPoseExtras(): {
    hotbarSlot: number;
    heldItemId: number;
    miningVisual: boolean;
  } {
    const s = this.player.state;
    const slot = ((s.hotbarSlot % HOTBAR_SIZE) + HOTBAR_SIZE) % HOTBAR_SIZE;
    const stack = this.player.inventory.getStack(slot);
    const heldItemId =
      stack !== null && stack.count > 0 ? stack.itemId : 0;
    const miningBreak =
      s.breakTarget !== null &&
      s.breakProgress < 1 &&
      !this.input.isWorldInputBlocked();
    const miningVisual = miningBreak || s.handSwingRemainSec > 0;
    return { hotbarSlot: slot, heldItemId, miningVisual };
  }

  update(dt: number): void {
    this.world.setDoorPlayerCollidersForProximity(
      doorSamplesForWorld(this.player, this.world),
    );
    this.player.update(dt, this.input, this.world);
    this.world.setDoorPlayerCollidersForProximity(
      doorSamplesForWorld(this.player, this.world),
    );
    this.world.refreshDoorProximityMeshDirty();
  }

  /** Sync placeholder rects to player + remote player world positions (call each render). */
  syncPlayerGraphic(alpha: number, dtSec: number, nowMs: number): void {
    const root = this.playerGraphic;
    if (root !== null) {
      const s = this.player.state;
      const x = s.prevPosition.x + (s.position.x - s.prevPosition.x) * alpha;
      const y = s.prevPosition.y + (s.position.y - s.prevPosition.y) * alpha;
      const deathT = s.deathAnimT;
      if (deathT !== null) {
        const t = Math.min(1, Math.max(0, deathT));
        root.pivot.set(PLAYER_WIDTH * 0.5, PLAYER_HEIGHT);
        root.position.set(x, -y);
        const sign = s.facingRight ? 1 : -1;
        root.rotation = sign * t * (Math.PI * 0.5);
        root.alpha = 1 - t;
      } else if (s.sleeping) {
        // Bed sleep pose: rotate the whole body root (local-only).
        root.pivot.set(PLAYER_WIDTH * 0.5, PLAYER_HEIGHT * 0.55);
        root.position.set(x, -y);
        root.rotation = -Math.PI * 0.5;
        root.alpha = 1;
      } else {
        root.pivot.set(0, 0);
        root.rotation = 0;
        root.alpha = 1;
        root.position.set(x - PLAYER_WIDTH / 2, -y - PLAYER_HEIGHT);
      }

      const anim = this.localPlayerAnim;
      if (anim !== null) {
        const vx = s.velocity.x;
        const moving =
          s.onGround && Math.abs(vx) >= PLAYER_MOVE_ANIM_VEL_THRESHOLD;
        const sprinting = moving && this.input.isDown("sprint");
        const moveIntent =
          (this.input.isDown("right") ? 1 : 0) -
          (this.input.isDown("left") ? 1 : 0);
        const miningBreak =
          s.breakTarget !== null &&
          s.breakProgress < 1 &&
          !this.input.isWorldInputBlocked();
        const miningVisual =
          miningBreak || s.handSwingRemainSec > 0;
        const skidding =
          s.onGround &&
          !miningVisual &&
          Math.abs(vx) >= PLAYER_MOVE_ANIM_VEL_THRESHOLD &&
          moveIntent !== 0 &&
          Math.sign(vx) !== 0 &&
          Math.sign(moveIntent) !== Math.sign(vx);
        const idle = this.playerIdleAnimTextures;
        const cycle = this.playerWalkCycleTextures;
        const jumpUp = this.playerJumpUpAnimTextures;
        const jumpDown = this.playerJumpDownAnimTextures;
        const breaking = this.playerBreakingAnimTextures;
        const skid = this.playerSkidAnimTextures;
        // While sleeping, force an idle pose (no mining/place animation loop).
        if (s.sleeping) {
          if (idle !== null && idle.length > 0) {
            if (anim.textures !== idle) {
              anim.textures = idle;
            }
            anim.gotoAndStop(0);
            anim.stop();
            anim.scale.x = s.facingRight ? -this.playerSpriteBaseScale : this.playerSpriteBaseScale;
            anim.scale.y = this.playerSpriteBaseScale;
          }
          const held = this.localHeldItemSprite;
          if (held !== null) {
            held.visible = false;
            held.rotation = 0;
          }
        } else if (idle !== null && cycle !== null && cycle.length > 0) {
          syncPlayerBodyAnimation(
            anim,
            s.onGround,
            moving,
            sprinting,
            s.facingRight,
            this.playerSpriteBaseScale,
            {
              idle,
              cycle,
              mode: this.localWalkAnimMode,
            },
            s.velocity.y,
            jumpUp,
            jumpDown,
            this.localSurfaceMode,
            breaking,
            miningVisual,
            skidding,
            skid,
          );
        }
        const breakingLoopActive =
          !s.sleeping &&
          miningVisual &&
          breaking !== null &&
          breaking.length >= 2 &&
          anim.textures === breaking;
        if (!s.sleeping) {
          applyPlayerSpriteFeetPosition(
            anim,
            this.playerSpriteBaseScale,
            breakingLoopActive,
            s.facingRight,
          );
        }

        const held = this.localHeldItemSprite;
        if (held !== null) {
          if (s.sleeping) {
            held.visible = false;
          } else {
          const slot =
            ((s.hotbarSlot % HOTBAR_SIZE) + HOTBAR_SIZE) % HOTBAR_SIZE;
          const stack = this.player.inventory.getStack(slot);
          const heldItemId =
            stack !== null && stack.count > 0 ? stack.itemId : 0;
          this.syncHeldItemVisual(
            held,
            anim,
            s.facingRight,
            miningVisual,
            s.onGround,
            heldItemId,
          );
          }
        }

        const hurtK =
          s.damageTintRemainSec > 0
            ? s.damageTintRemainSec / PLAYER_DAMAGE_TINT_DURATION_SEC
            : 0;
        const hurtTint = playerHurtTintRgb(hurtK);
        anim.tint = hurtTint;
        if (held !== null) {
          held.tint = hurtTint;
        }
      }
    }

    const remotePlayers = this.world.getRemotePlayers();
    for (const [peerId, sprite] of this.remoteGraphics) {
      if (!remotePlayers.has(peerId)) {
        sprite.parent?.removeChild(sprite);
        sprite.destroy({ children: true });
        this.remoteGraphics.delete(peerId);
        this.remoteWalkAnimMode.delete(peerId);
        this.remoteSurfaceMode.delete(peerId);
        this.remoteAnimVelX.delete(peerId);
        this.remoteAnimVelY.delete(peerId);
      }
    }
    for (const [peerId, rp] of remotePlayers) {
      let remoteRoot = this.remoteGraphics.get(peerId);
      if (remoteRoot === undefined) {
        remoteRoot = this.createRemotePlayerRoot();
        const parent = this.playerGraphic?.parent;
        parent?.addChild(remoteRoot);
        this.remoteGraphics.set(peerId, remoteRoot);
        this.remoteWalkAnimMode.set(peerId, { v: "idle" });
        this.remoteSurfaceMode.set(peerId, { v: "ground" });
      }
      const disp = rp.getDisplayPose(nowMs);
      remoteRoot.position.set(disp.x - PLAYER_WIDTH / 2, -disp.y - PLAYER_HEIGHT);

      let remoteBody: AnimatedSprite | null = null;
      let remoteHeld: Sprite | null = null;
      for (const ch of remoteRoot.children) {
        if (ch instanceof AnimatedSprite) {
          remoteBody = ch;
        } else if (ch instanceof Sprite) {
          remoteHeld = ch;
        }
      }
      if (remoteBody !== null) {
        const body = remoteBody;
        const rawVx = disp.vx;
        const rawVy = disp.vy;
        const k = Math.min(1, PLAYER_REMOTE_ANIM_VEL_SMOOTH_PER_SEC * dtSec);
        let sx = this.remoteAnimVelX.get(peerId) ?? rawVx;
        let sy = this.remoteAnimVelY.get(peerId) ?? rawVy;
        sx += (rawVx - sx) * k;
        sy += (rawVy - sy) * k;
        this.remoteAnimVelX.set(peerId, sx);
        this.remoteAnimVelY.set(peerId, sy);
        const onGroundApprox =
          Math.abs(sy) <= PLAYER_REMOTE_AIR_VY_THRESHOLD;
        const moving =
          onGroundApprox &&
          Math.abs(sx) >= PLAYER_MOVE_ANIM_VEL_THRESHOLD;
        const sprinting =
          moving && Math.abs(sx) >= PLAYER_REMOTE_SPRINT_VEL_THRESHOLD;
        const idle = this.playerIdleAnimTextures;
        const cycle = this.playerWalkCycleTextures;
        const mode = this.remoteWalkAnimMode.get(peerId);
        let surf = this.remoteSurfaceMode.get(peerId);
        if (surf === undefined) {
          surf = { v: "ground" };
          this.remoteSurfaceMode.set(peerId, surf);
        }
        const jumpUp = this.playerJumpUpAnimTextures;
        const jumpDown = this.playerJumpDownAnimTextures;
        const breaking = this.playerBreakingAnimTextures;
        const skid = this.playerSkidAnimTextures;
        const miningVisual =
          rp.miningVisualFromNetwork || rp.getBreakMining() !== null;
        if (idle !== null && cycle !== null && cycle.length > 0 && mode !== undefined) {
          syncPlayerBodyAnimation(
            body,
            onGroundApprox,
            moving,
            sprinting,
            disp.facingRight,
            this.playerSpriteBaseScale,
            { idle, cycle, mode },
            sy,
            jumpUp,
            jumpDown,
            surf,
            breaking,
            miningVisual,
            false,
            skid,
          );
        }
        const breakingLoopActive =
          miningVisual &&
          breaking !== null &&
          breaking.length >= 2 &&
          body.textures === breaking;
        applyPlayerSpriteFeetPosition(
          body,
          this.playerSpriteBaseScale,
          breakingLoopActive,
          disp.facingRight,
        );
        if (remoteHeld !== null) {
          this.syncHeldItemVisual(
            remoteHeld,
            body,
            disp.facingRight,
            miningVisual,
            onGroundApprox,
            rp.heldItemId,
          );
        }
      }
    }

    this.syncAimGraphic(alpha);
    this.syncDroppedItems(dtSec);
    this.syncSheepSprites(dtSec);
    this.syncPigSprites(dtSec);
    this.syncZombieSprites(dtSec);
  }

  /** Sync dropped item sprites to world state (call from render with frame dt for animation). */
  private syncDroppedItems(dtSec: number): void {
    const drops = this.world.getDroppedItems();
    const staleIds: string[] = [];
    for (const id of this.droppedSprites.keys()) {
      if (!drops.has(id)) {
        staleIds.push(id);
      }
    }
    for (const id of staleIds) {
      const s = this.droppedSprites.get(id);
      if (s !== undefined) {
        s.parent?.removeChild(s);
        s.destroy();
      }
      this.droppedSprites.delete(id);
    }

    this.droppedBobPhase += dtSec;
    for (const [id, item] of drops) {
      let sprite = this.droppedSprites.get(id);
      if (sprite === undefined) {
        const def = this.itemRegistry.getById(item.itemId);
        if (def === undefined) {
          continue;
        }
        let tex: Texture;
        try {
          tex = this.itemTextureAtlas.getTexture(def.textureName);
        } catch {
          continue;
        }
        const created = new Sprite(tex);
        created.anchor.set(0.5);
        created.scale.set(0.5);
        const parent = this.playerGraphic?.parent;
        parent?.addChild(created);
        this.droppedSprites.set(id, created);
        sprite = created;
      }
      if (sprite === undefined) {
        continue;
      }
      // World Y is up; sin*amplitude alone would dip below rest and clip into the ground.
      const bob = item.pulling
        ? 0
        : (Math.sin(this.droppedBobPhase * 1.25 + id.length * 0.7) * 0.5 + 0.5) * 3;
      sprite.rotation = 0;
      const ix = item.x;
      const iy = item.y + bob;
      sprite.position.set(ix, -iy);
    }
  }

  private syncAimGraphic(alpha: number): void {
    const aim = this.aimGraphic;
    if (aim === null) {
      return;
    }
    if (this.input.isWorldInputBlocked()) {
      aim.clear();
      const lineHidden = this.aimLineSprite;
      if (lineHidden !== null) {
        lineHidden.visible = false;
      }
      return;
    }

    aim.clear();

    const playerState = this.player.state;
    const ix =
      playerState.prevPosition.x +
      (playerState.position.x - playerState.prevPosition.x) * alpha;
    const iy =
      playerState.prevPosition.y +
      (playerState.position.y - playerState.prevPosition.y) * alpha;
    const mouseX = this.input.mouseWorldPos.x;
    const mouseY = this.input.mouseWorldPos.y;
    const {
      dirX,
      dirY,
      lineStartX,
      lineStartY,
      lineLenPx,
      aimX,
      aimY,
    } = getReachLineGeometry(
      ix,
      iy,
      mouseX,
      mouseY,
      playerState.facingRight,
      REACH_BLOCKS,
    );

    const lineSprite = this.aimLineSprite;
    if (lineSprite !== null) {
      lineSprite.visible = lineLenPx > 0;
      lineSprite.position.set(lineStartX, lineStartY);
      lineSprite.rotation = Math.atan2(dirY, dirX);
      lineSprite.width = lineLenPx;
    }

    const hoverWx = Math.floor(aimX / BLOCK_SIZE);
    const hoverWy = Math.floor(-aimY / BLOCK_SIZE);
    const playerBlockX = Math.floor(playerState.position.x / BLOCK_SIZE);
    const playerBlockY = Math.floor(playerState.position.y / BLOCK_SIZE);
    const inReach =
      Math.max(
        Math.abs(playerBlockX - hoverWx),
        Math.abs(playerBlockY - hoverWy),
      ) <= REACH_BLOCKS;

    const crossSize = 4;
    aim.moveTo(aimX - crossSize, aimY);
    aim.lineTo(aimX + crossSize, aimY);
    aim.moveTo(aimX, aimY - crossSize);
    aim.lineTo(aimX, aimY + crossSize);
    aim.stroke({ color: 0xffffff, alpha: 0.95, width: 1 });

    if (inReach) {
      const hovered = this.world.getBlock(hoverWx, hoverWy);
      if (hovered.id !== this.airId) {
        aim.rect(
          hoverWx * BLOCK_SIZE,
          -(hoverWy + 1) * BLOCK_SIZE,
          BLOCK_SIZE,
          BLOCK_SIZE,
        );
        aim.stroke({ color: 0x66ccff, alpha: 1, width: 2 });
      }
    }
  }

  private createRemotePlayerRoot(): Container {
    const c = new Container();
    c.sortableChildren = true;
    c.cullable = false;
    c.cullableChildren = false;
    const idle = this.playerIdleAnimTextures;
    if (
      idle !== null &&
      this.playerWalkCycleTextures !== null &&
      this.playerWalkCycleTextures.length > 0 &&
      this.playerBodyAtlasFrames !== null &&
      this.playerBodyAtlasFrames.length >= PLAYER_BODY_REQUIRED_FRAME_COUNT
    ) {
      const held = new Sprite(Texture.WHITE);
      held.visible = false;
      held.roundPixels = false;
      held.zIndex = -1;
      if (held.texture.source !== undefined) {
        held.texture.source.scaleMode = "nearest";
      }
      const anim = new AnimatedSprite({
        textures: idle,
        animationSpeed: PLAYER_WALK_ANIM_SPEED,
        loop: true,
        autoPlay: false,
      });
      if (anim.texture.source !== undefined) {
        anim.texture.source.scaleMode = "nearest";
      }
      layoutPlayerSprite(anim, this.playerSpriteBaseScale);
      anim.gotoAndStop(0);
      anim.zIndex = 0;
      c.addChild(held);
      c.addChild(anim);
    } else {
      const g = new Graphics();
      g.rect(0, 0, PLAYER_WIDTH, PLAYER_HEIGHT);
      g.fill({ color: 0xff66ff });
      c.addChild(g);
    }
    return c;
  }

  /** Upgrade remote roots from magenta placeholder to animated sprites once walk textures load. */
  private refreshRemotePlayerBodies(): void {
    const idle = this.playerIdleAnimTextures;
    const cycle = this.playerWalkCycleTextures;
    const atlas = this.playerBodyAtlasFrames;
    if (
      idle === null ||
      cycle === null ||
      cycle.length === 0 ||
      atlas === null ||
      atlas.length < PLAYER_BODY_REQUIRED_FRAME_COUNT
    ) {
      return;
    }
    for (const [peerId, root] of this.remoteGraphics) {
      const first = root.children[0];
      if (first instanceof AnimatedSprite) {
        continue;
      }
      first?.destroy();
      root.sortableChildren = true;
      const held = new Sprite(Texture.WHITE);
      held.visible = false;
      held.roundPixels = false;
      held.zIndex = -1;
      if (held.texture.source !== undefined) {
        held.texture.source.scaleMode = "nearest";
      }
      const anim = new AnimatedSprite({
        textures: idle,
        animationSpeed: PLAYER_WALK_ANIM_SPEED,
        loop: true,
        autoPlay: false,
      });
      if (anim.texture.source !== undefined) {
        anim.texture.source.scaleMode = "nearest";
      }
      layoutPlayerSprite(anim, this.playerSpriteBaseScale);
      anim.gotoAndStop(0);
      anim.zIndex = 0;
      root.addChild(held);
      root.addChild(anim);
      let mode = this.remoteWalkAnimMode.get(peerId);
      if (mode === undefined) {
        mode = { v: "idle" };
        this.remoteWalkAnimMode.set(peerId, mode);
      } else {
        mode.v = "idle";
      }
      const rp = this.world.getRemotePlayers().get(peerId);
      if (rp !== undefined) {
        const disp = rp.getDisplayPose(performance.now());
        const vx = disp.vx;
        const onGroundApprox =
          Math.abs(disp.vy) <= PLAYER_REMOTE_AIR_VY_THRESHOLD;
        const moving =
          onGroundApprox &&
          Math.abs(vx) >= PLAYER_MOVE_ANIM_VEL_THRESHOLD;
        const sprinting =
          moving && Math.abs(vx) >= PLAYER_REMOTE_SPRINT_VEL_THRESHOLD;
        let surf = this.remoteSurfaceMode.get(peerId);
        if (surf === undefined) {
          surf = { v: "ground" };
          this.remoteSurfaceMode.set(peerId, surf);
        }
        const breaking = this.playerBreakingAnimTextures;
        const skid = this.playerSkidAnimTextures;
        const miningVisual =
          rp.miningVisualFromNetwork || rp.getBreakMining() !== null;
        syncPlayerBodyAnimation(
          anim,
          onGroundApprox,
          moving,
          sprinting,
          disp.facingRight,
          this.playerSpriteBaseScale,
          { idle, cycle, mode },
          disp.vy,
          this.playerJumpUpAnimTextures,
          this.playerJumpDownAnimTextures,
          surf,
          breaking,
          miningVisual,
          false,
          skid,
        );
      }
    }
  }

  private syncHeldItemVisual(
    held: Sprite,
    anim: AnimatedSprite,
    facingRight: boolean,
    miningVisual: boolean,
    onGroundApprox: boolean,
    heldItemId: number,
  ): void {
    const breaking = this.playerBreakingAnimTextures;
    const breakingLoopActive =
      miningVisual &&
      breaking !== null &&
      breaking.length >= 2 &&
      anim.textures === breaking;
    let tex: Texture | null = null;
    let heldPlaceableBlock = false;
    /** Axe art mirrors opposite to pick/shovel for correct blade direction in-hand. */
    let heldToolOppositeMirror = false;
    if (heldItemId !== 0) {
      const def = this.itemRegistry.getById(heldItemId as ItemId);
      if (def !== undefined) {
        tex = this.itemTextureAtlas.getTextureOrNull(def.textureName);
        heldPlaceableBlock = def.placesBlockId !== undefined;
        heldToolOppositeMirror = def.toolType === "axe";
      }
    }
    if (tex === null || tex === Texture.EMPTY) {
      held.visible = false;
      held.rotation = 0;
      return;
    }
    held.texture = tex;
    const src = tex.source;
    if (src !== undefined) {
      src.scaleMode = "nearest";
    }
    held.anchor.set(PLAYER_HELD_ITEM_ANCHOR_X, PLAYER_HELD_ITEM_ANCHOR_Y);
    const k =
      PLAYER_HELD_ITEM_SCALE_MULTIPLIER *
      (heldPlaceableBlock ? PLAYER_HELD_PLACEABLE_BLOCK_REL_SCALE : 1);
    const bx = anim.scale.x;
    const heldSx =
      (heldToolOppositeMirror
        ? facingRight
          ? bx
          : -bx
        : facingRight
          ? -bx
          : bx) * k;
    const heldFacingFlipX = facingRight ? 1 : -1;
    held.scale.set(heldSx * heldFacingFlipX, anim.scale.y * k);
    const faceScreenX = facingRight ? 1 : -1;
    const airJumpHeld = !onGroundApprox;
    const onHeldBreakSwingFrame =
      breakingLoopActive && anim.currentFrame === 1;
    const baseHeldRotation = heldToolOppositeMirror
      ? faceScreenX * PLAYER_HELD_AXE_ROTATION_RAD
      : 0;
    const breakSwingRotation = onHeldBreakSwingFrame
      ? faceScreenX * PLAYER_HELD_BREAK_FRAME_ROTATION_RAD
      : 0;
    held.rotation = baseHeldRotation + breakSwingRotation;
    const breakForward = onHeldBreakSwingFrame
      ? faceScreenX * PLAYER_HELD_BREAK_FRAME_NUDGE_FORWARD_PX
      : 0;
    const breakUp = onHeldBreakSwingFrame
      ? -PLAYER_HELD_BREAK_FRAME_NUDGE_UP_PX
      : 0;
    held.position.set(
      anim.position.x +
        PLAYER_HELD_ITEM_HAND_OFFSET_X_TEXELS * anim.scale.x +
        faceScreenX * PLAYER_HELD_ITEM_FACING_SIDE_NUDGE_X_PX +
        faceScreenX * PLAYER_HELD_ITEM_OUTWARD_NUDGE_X_PX +
        (heldToolOppositeMirror ? faceScreenX * PLAYER_HELD_AXE_NUDGE_X_PX : 0) +
        breakForward,
      anim.position.y +
        PLAYER_HELD_ITEM_HAND_OFFSET_Y_TEXELS * anim.scale.y +
        PLAYER_HELD_ITEM_OUTWARD_NUDGE_Y_PX +
        (airJumpHeld ? PLAYER_HELD_ITEM_AIR_JUMP_NUDGE_Y_PX : 0) +
        (heldToolOppositeMirror ? PLAYER_HELD_AXE_NUDGE_Y_PX : 0) +
        (heldPlaceableBlock ? PLAYER_HELD_PLACEABLE_BLOCK_NUDGE_Y_PX : 0) +
        breakUp,
    );
    held.zIndex = -1;
    anim.zIndex = 0;
    held.visible = true;
  }

  private async loadPlayerSprites(): Promise<void> {
    const sheetUrl = stratumCoreTextureAssetUrl(PLAYER_BODY_ATLAS_IMAGE_REL);
    try {
      const rects =
        (await tryFetchPlayerBodyAtlasRects()) ?? PLAYER_BODY_ATLAS_FRAMES;
      const sheet =
        (await Assets.load<Texture>(sheetUrl)) ?? Assets.get<Texture>(sheetUrl);
      if (
        sheet === undefined ||
        sheet === Texture.EMPTY ||
        sheet.source === undefined
      ) {
        return;
      }
      sheet.source.scaleMode = "nearest";
      sheet.source.autoGenerateMipmaps = false;
      const frames = sliceBodyFrames(sheet, rects);
      if (frames.length < PLAYER_BODY_REQUIRED_FRAME_COUNT) {
        return;
      }
      const idleTex = frames[PLAYER_BODY_IDLE_FRAME_INDEX];
      if (idleTex === undefined) {
        return;
      }
      const cycle: Texture[] = [];
      for (const idx of PLAYER_BODY_WALK_CYCLE_INDICES) {
        const t = frames[idx];
        if (t === undefined) {
          return;
        }
        cycle.push(t);
      }
      const miningTex = frames[PLAYER_BODY_MINING_FRAME_INDEX];
      const jumpUpTex = frames[PLAYER_BODY_JUMP_UP_FRAME_INDEX];
      const jumpDownTex = frames[PLAYER_BODY_JUMP_DOWN_FRAME_INDEX];
      if (
        miningTex === undefined ||
        jumpUpTex === undefined ||
        jumpDownTex === undefined
      ) {
        return;
      }

      this.playerBodyAtlasFrames = frames;
      this.playerIdleAnimTextures = [idleTex];
      this.playerWalkCycleTextures = cycle;
      this.playerJumpUpAnimTextures = [jumpUpTex];
      this.playerJumpDownAnimTextures = [jumpDownTex];
      this.playerSkidAnimTextures = [miningTex];
      this.playerBreakingAnimTextures = [idleTex, miningTex];
      this.localWalkAnimMode.v = "idle";
      this.localSurfaceMode.v = "ground";

      let maxW = 0;
      let maxH = 0;
      for (const f of frames) {
        maxW = Math.max(maxW, f.width);
        maxH = Math.max(maxH, f.height);
      }

      if (maxW <= 0 || maxH <= 0) {
        return;
      }
      this.playerSpriteBaseScale =
        Math.min(PLAYER_WIDTH / maxW, PLAYER_HEIGHT / maxH) *
        PLAYER_SPRITE_SCALE_MULTIPLIER;

      const root = this.playerGraphic;
      if (root === null) {
        return;
      }
      this.localPlayerPlaceholder?.destroy();
      this.localPlayerPlaceholder = null;

      const anim = new AnimatedSprite({
        textures: this.playerIdleAnimTextures,
        animationSpeed: PLAYER_WALK_ANIM_SPEED,
        loop: true,
        autoPlay: false,
      });
      layoutPlayerSprite(anim, this.playerSpriteBaseScale);
      anim.gotoAndStop(0);
      anim.zIndex = 0;
      root.addChild(anim);
      this.localPlayerAnim = anim;

      const held = new Sprite(Texture.WHITE);
      held.visible = false;
      held.roundPixels = false;
      held.zIndex = -1;
      if (held.texture.source !== undefined) {
        held.texture.source.scaleMode = "nearest";
      }
      root.addChildAt(held, 0);
      this.localHeldItemSprite = held;

      this.refreshRemotePlayerBodies();
    } catch {
      // Optional asset: keep cyan placeholder when missing.
    }
  }

  private async loadZombieSprites(): Promise<void> {
    try {
      const url = stratumCoreTextureAssetUrl(ZOMBIE_SPRITE_REL);
      const sheet =
        (await Assets.load<Texture>(url)) ?? Assets.get<Texture>(url);
      if (
        sheet === undefined ||
        sheet === Texture.EMPTY ||
        sheet.source === undefined
      ) {
        return;
      }
      sheet.source.scaleMode = "nearest";
      sheet.source.autoGenerateMipmaps = false;
      /**
       * Zombie sprite sheets are allowed to differ from the player atlas.
       * Current `zombie.png` is a single-row strip; slice uniformly, allowing 1px gutters.
       */
      const w = sheet.width;
      const h = sheet.height;
      if (w <= 0 || h <= 0) {
        return;
      }
      // New zombie art uses an explicit spritesheet layout (see `sprite_sheet.json` used to pack it).
      // Prefer exact coordinates (no heuristic slicing).
      if (w === 119 && h === 31) {
        const fh = 31;
        const fw = 17;
        const rect = (x: number): { x: number; y: number; w: number; h: number } => ({
          x,
          y: 0,
          w: fw,
          h: fh,
        });
        // Order below is semantic (idle, walk×4, jump, hit), not the original packer list.
        const frames = sliceAtlasFrames(sheet, [
          rect(0), // layer_1 idle
          rect(17), // layer_2 walk
          rect(34), // layer_3 walk
          rect(51), // layer_4 walk
          rect(68), // layer_5 walk
          rect(102), // layer_7 jump
          rect(85), // layer_8 hit
        ]);
        if (frames.length !== 7) {
          return;
        }
        this.zombieIdleTextures = [frames[0]!];
        this.zombieWalkTextures = frames.slice(1, 5);
        this.zombieJumpTextures = [frames[5]!];
        this.zombieAttackTextures = [frames[6]!];
      } else {
        const fh = h;

        // Prefer a layout with 1px gutters: many strips are `(frameW * n) + (n-1)` wide.
        const pickStripLayout = (): {
          cols: number;
          fw: number;
          gutter: number;
          startX: number;
        } => {
          const candidates: Array<{ cols: number; fw: number; gutter: number }> =
            [];
          for (const gutter of [1, 0]) {
            for (let cols = 4; cols <= 12; cols++) {
              const num = w - gutter * (cols - 1);
              if (num <= 0) continue;
              if (num % cols !== 0) continue;
              const fw = num / cols;
              if (fw < 10 || fw > 64) continue;
              candidates.push({ cols, fw, gutter });
            }
          }

          // Prefer exact 7-frame strips when plausible (idle, walk×4, jump, hit).
          // Many strips have 1px total padding, e.g. 141px wide for 7×20px frames.
          const approxFw7 = Math.floor(w / 7);
          if (approxFw7 >= 10 && approxFw7 <= 64) {
            const fw = approxFw7;
            const contentW = fw * 7;
            const startX = Math.floor((w - contentW) / 2);
            return { cols: 7, fw, gutter: 0, startX };
          }

          // Otherwise pick any valid candidate; center it if there's leftover padding.
          const picked = candidates[0];
          if (picked !== undefined) {
            const contentW =
              picked.fw * picked.cols + picked.gutter * (picked.cols - 1);
            const startX = Math.floor((w - contentW) / 2);
            return { ...picked, startX };
          }

          // Last resort: coarse uniform slice.
          const cols = 7;
          const fw = Math.max(1, Math.floor(w / cols));
          const contentW = fw * cols;
          const startX = Math.floor((w - contentW) / 2);
          return { cols, fw, gutter: 0, startX };
        };

        const { cols, fw, gutter, startX } = pickStripLayout();
        const rects: { x: number; y: number; w: number; h: number }[] = [];
        for (let i = 0; i < cols; i++) {
          rects.push({ x: startX + i * (fw + gutter), y: 0, w: fw, h: fh });
        }
        const frames = sliceAtlasFrames(sheet, rects);
        if (frames.length <= 1) {
          return;
        }
        // Expected zombie strip layout:
        // 1 = idle, 2–5 = walk, 6 = jump, 7 = hit (attack).
        this.zombieIdleTextures = [frames[0]!];
        this.zombieWalkTextures =
          frames.length >= 5 ? frames.slice(1, 5) : frames.slice(1);
        this.zombieJumpTextures = frames.length >= 6 ? [frames[5]!] : null;
        this.zombieAttackTextures = frames.length >= 7 ? [frames[6]!] : null;
      }

      let maxW = 0;
      let maxH = 0;
      const all = [
        ...(this.zombieIdleTextures ?? []),
        ...(this.zombieWalkTextures ?? []),
        ...(this.zombieJumpTextures ?? []),
        ...(this.zombieAttackTextures ?? []),
      ];
      for (const f of all) {
        maxW = Math.max(maxW, f.width);
        maxH = Math.max(maxH, f.height);
      }
      if (maxW <= 0 || maxH <= 0) {
        return;
      }
      this.zombieSpriteBaseScale =
        Math.min(PLAYER_WIDTH / maxW, PLAYER_HEIGHT / maxH) *
        PLAYER_SPRITE_SCALE_MULTIPLIER;
    } catch {
      this.zombieWalkTextures = null;
      this.zombieIdleTextures = null;
      this.zombieJumpTextures = null;
      this.zombieAttackTextures = null;
    }
  }

  private async loadAimLineSprite(pipeline: RenderPipeline): Promise<void> {
    const pointerLineUrl = stratumCoreTextureAssetUrl("GUI/pointer_line.png");
    try {
      const pointerLineTexture =
        (await Assets.load<Texture>(pointerLineUrl)) ??
        Assets.get<Texture>(pointerLineUrl);
      if (
        pointerLineTexture === undefined ||
        pointerLineTexture === Texture.EMPTY ||
        pointerLineTexture.source === undefined
      ) {
        return;
      }
      pointerLineTexture.source.scaleMode = "nearest";
      const aimLine = new Sprite(pointerLineTexture);
      aimLine.anchor.set(0, 0.5);
      pipeline.layerForeground.addChild(aimLine);
      this.aimLineSprite = aimLine;
    } catch {
      // Optional cosmetic asset: keep graphics fallback when missing.
      this.aimLineSprite = null;
    }
  }

  private async loadSheepSprites(): Promise<void> {
    try {
      const url = stratumCoreTextureAssetUrl(SHEEP_SPRITE_REL);
      const sheet =
        (await Assets.load<Texture>(url)) ?? Assets.get<Texture>(url);
      if (sheet === undefined || sheet.source === undefined) {
        return;
      }
      sheet.source.scaleMode = "nearest";
      const fw = Math.floor(sheet.width / SHEEP_WALK_FRAMES);
      const fh = Math.floor(sheet.height / 2);
      if (fw <= 0 || fh <= 0) {
        return;
      }
      const walkRects: { x: number; y: number; w: number; h: number }[] = [];
      for (let i = 0; i < SHEEP_WALK_FRAMES; i++) {
        walkRects.push({ x: i * fw, y: 0, w: fw, h: fh });
      }
      const idleRects: { x: number; y: number; w: number; h: number }[] = [];
      for (let i = 0; i < SHEEP_IDLE_FRAMES; i++) {
        idleRects.push({ x: i * fw, y: fh, w: fw, h: fh });
      }
      this.sheepWalkTextures = sliceAtlasFrames(sheet, walkRects);
      this.sheepIdleTextures = sliceAtlasFrames(sheet, idleRects);

      const maskUrl = stratumCoreTextureAssetUrl(SHEEP_MASK_SPRITE_REL);
      const maskSheet =
        (await Assets.load<Texture>(maskUrl)) ?? Assets.get<Texture>(maskUrl);
      if (
        maskSheet !== undefined &&
        maskSheet.source !== undefined &&
        maskSheet.width === sheet.width &&
        maskSheet.height === sheet.height
      ) {
        const [ovWalk, ovIdle] = await Promise.all([
          buildSheepWoolSilhouetteTextures(maskUrl, walkRects),
          buildSheepWoolSilhouetteTextures(maskUrl, idleRects),
        ]);
        if (ovWalk === null || ovIdle === null) {
          destroyTextureList(ovWalk);
          destroyTextureList(ovIdle);
          this.sheepWoolOverlayWalkTextures = null;
          this.sheepWoolOverlayIdleTextures = null;
        } else {
          this.sheepWoolOverlayWalkTextures = ovWalk;
          this.sheepWoolOverlayIdleTextures = ovIdle;
        }
      } else {
        this.sheepWoolOverlayWalkTextures = null;
        this.sheepWoolOverlayIdleTextures = null;
      }
    } catch {
      this.sheepWalkTextures = null;
      this.sheepIdleTextures = null;
      this.sheepWoolOverlayWalkTextures = null;
      this.sheepWoolOverlayIdleTextures = null;
    }
  }

  private async loadPigSprites(): Promise<void> {
    try {
      const url = stratumCoreTextureAssetUrl(PIG_SPRITE_REL);
      const sheet =
        (await Assets.load<Texture>(url)) ?? Assets.get<Texture>(url);
      if (sheet === undefined || sheet.source === undefined) {
        return;
      }
      sheet.source.scaleMode = "nearest";
      const fw = Math.floor(sheet.width / PIG_WALK_FRAMES);
      const fh = Math.floor(sheet.height / 2);
      if (fw <= 0 || fh <= 0) {
        return;
      }
      const walkRects: { x: number; y: number; w: number; h: number }[] = [];
      for (let i = 0; i < PIG_WALK_FRAMES; i++) {
        walkRects.push({ x: i * fw, y: 0, w: fw, h: fh });
      }
      const idleRects: { x: number; y: number; w: number; h: number }[] = [];
      for (let i = 0; i < PIG_IDLE_FRAMES; i++) {
        idleRects.push({ x: i * fw, y: fh, w: fw, h: fh });
      }
      this.pigWalkTextures = sliceAtlasFrames(sheet, walkRects);
      this.pigIdleTextures = sliceAtlasFrames(sheet, idleRects);
    } catch {
      this.pigWalkTextures = null;
      this.pigIdleTextures = null;
    }
  }

  private syncSheepSprites(_dtSec: number): void {
    const mm = this.mobManager;
    const walk = this.sheepWalkTextures;
    const idle = this.sheepIdleTextures;
    const woolWalk = this.sheepWoolOverlayWalkTextures;
    const woolIdle = this.sheepWoolOverlayIdleTextures;
    if (
      mm === null ||
      walk === null ||
      idle === null ||
      walk.length === 0 ||
      idle.length === 0
    ) {
      return;
    }
    const parent = this.playerGraphic?.parent;
    if (parent === null || parent === undefined) {
      return;
    }
    const hasWoolOverlay =
      woolWalk !== null &&
      woolIdle !== null &&
      woolWalk.length > 0 &&
      woolIdle.length > 0;
    const views = mm.getPublicViews().filter((v) => v.type === MobType.Sheep);
    const alive = new Set<number>();
    let baseScale = 1.25;
    const extraNudgeDownPx = 3;
    for (const v of views) {
      alive.add(v.id);
      let rig = this.sheepSprites.get(v.id);
      if (rig === undefined) {
        const root = new Container();
        root.sortableChildren = true;
        root.zIndex = -2;
        root.cullable = false;
        root.cullableChildren = false;
        const base = new AnimatedSprite({
          textures: walk,
          animationSpeed: 0.16,
          loop: true,
          autoPlay: true,
        });
        base.anchor.set(0.5, 1);
        base.roundPixels = false;
        base.zIndex = 0;
        root.addChild(base);
        let wool: AnimatedSprite | null = null;
        if (hasWoolOverlay) {
          const initialWoolFrames =
            v.walking && !v.panic ? woolWalk! : woolIdle!;
          wool = new AnimatedSprite({
            textures: initialWoolFrames,
            animationSpeed: 0.16,
            loop: true,
            autoPlay: true,
          });
          wool.anchor.set(0.5, 1);
          wool.roundPixels = false;
          // Multiply keeps base shading while applying dye tint (no mask/stencil involved).
          wool.blendMode = "multiply";
          wool.cullable = false;
          wool.zIndex = 1;
          root.addChild(wool);
        }
        parent.addChild(root);
        rig = { root, base, wool };
        this.sheepSprites.set(v.id, rig);
      }
      const useWalk = v.walking && !v.panic;
      const frames = useWalk ? walk : idle;
      const woolFrames =
        hasWoolOverlay && woolWalk !== null && woolIdle !== null
          ? useWalk
            ? woolWalk
            : woolIdle
          : null;
      const { root, base, wool } = rig;
      if (base.textures !== frames) {
        base.textures = frames;
        if (v.deathAnimRemainSec > 0) {
          base.gotoAndStop(0);
        } else {
          base.gotoAndPlay(0);
        }
      }
      if (wool !== null && woolFrames !== null) {
        if (wool.textures !== woolFrames) {
          wool.textures = woolFrames;
          if (v.deathAnimRemainSec > 0) {
            wool.gotoAndStop(0);
          } else {
            wool.gotoAndPlay(0);
          }
        }
      }
      base.animationSpeed = useWalk ? 0.2 : 0.12;
      if (wool !== null) {
        wool.animationSpeed = useWalk ? 0.2 : 0.12;
        wool.tint = getSheepWoolTintHex(v.woolColor);
        base.tint = 0xffffff;
      } else {
        base.tint = getSheepWoolTintHex(v.woolColor);
      }
      const frameH = base.textures[0]?.height ?? 0;
      const effectiveH = Math.max(1, frameH - SHEEP_FEET_SPRITE_NUDGE_Y_PX);
      baseScale =
        (SHEEP_BODY_TRIM_TARGET_PX / effectiveH) * SHEEP_RENDER_SCALE_MULT;
      // Keep root X scale positive; flip facing on sprites (avoids odd transforms with layered sprites).
      const flipX = v.facingRight ? -1 : 1;
      root.scale.set(baseScale, baseScale);
      base.scale.set(flipX, 1);
      if (wool !== null) {
        wool.scale.set(flipX, 1);
      }
      root.tint = v.hurt ? 0xff4a4a : 0xffffff;
      root.position.set(v.x, -v.y + SHEEP_FEET_SPRITE_NUDGE_Y_PX + extraNudgeDownPx);
      if (v.deathAnimRemainSec > 0) {
        base.stop();
        if (wool !== null) {
          wool.stop();
        }
        const t = Math.min(
          1,
          Math.max(0, 1 - v.deathAnimRemainSec / SHEEP_DEATH_ANIM_SEC),
        );
        const sign = v.facingRight ? 1 : -1;
        root.rotation = sign * t * (Math.PI * 0.5);
        root.alpha = 1 - t;
      } else {
        root.rotation = 0;
        root.alpha = 1;
      }
    }
    for (const id of [...this.sheepSprites.keys()]) {
      if (!alive.has(id)) {
        const rig = this.sheepSprites.get(id);
        if (rig !== undefined) {
          rig.root.parent?.removeChild(rig.root);
          rig.root.destroy({ children: true });
        }
        this.sheepSprites.delete(id);
      }
    }
  }

  private syncPigSprites(_dtSec: number): void {
    const mm = this.mobManager;
    const walk = this.pigWalkTextures;
    const idle = this.pigIdleTextures;
    if (
      mm === null ||
      walk === null ||
      idle === null ||
      walk.length === 0 ||
      idle.length === 0
    ) {
      return;
    }
    const parent = this.playerGraphic?.parent;
    if (parent === null || parent === undefined) {
      return;
    }
    const views = mm.getPublicViews().filter((v) => v.type === MobType.Pig);
    const alive = new Set<number>();
    let baseScale = 1.25;
    const extraNudgeDownPx = 6;
    for (const v of views) {
      alive.add(v.id);
      let rig = this.pigSprites.get(v.id);
      if (rig === undefined) {
        const root = new Container();
        root.sortableChildren = true;
        root.zIndex = -2;
        root.cullable = false;
        root.cullableChildren = false;
        const base = new AnimatedSprite({
          textures: walk,
          animationSpeed: 0.16,
          loop: true,
          autoPlay: true,
        });
        base.anchor.set(0.5, 1);
        base.roundPixels = false;
        base.zIndex = 0;
        root.addChild(base);
        parent.addChild(root);
        rig = { root, base };
        this.pigSprites.set(v.id, rig);
      }
      const useWalk = v.walking && !v.panic;
      const frames = useWalk ? walk : idle;
      const { root, base } = rig;
      if (base.textures !== frames) {
        base.textures = frames;
        if (v.deathAnimRemainSec > 0) {
          base.gotoAndStop(0);
        } else {
          base.gotoAndPlay(0);
        }
      }
      base.animationSpeed = useWalk ? 0.2 : 0.12;
      base.tint = 0xffffff;
      const frameH = base.textures[0]?.height ?? 0;
      const effectiveH = Math.max(1, frameH - PIG_FEET_SPRITE_NUDGE_Y_PX);
      baseScale =
        (PIG_BODY_TRIM_TARGET_PX / effectiveH) * PIG_RENDER_SCALE_MULT;
      const flipX = v.facingRight ? -1 : 1;
      root.scale.set(baseScale, baseScale);
      base.scale.set(flipX, 1);
      root.tint = v.hurt ? 0xff4a4a : 0xffffff;
      root.position.set(v.x, -v.y + PIG_FEET_SPRITE_NUDGE_Y_PX + extraNudgeDownPx);
      if (v.deathAnimRemainSec > 0) {
        base.stop();
        const t = Math.min(1, Math.max(0, 1 - v.deathAnimRemainSec / PIG_DEATH_ANIM_SEC));
        const sign = v.facingRight ? 1 : -1;
        root.rotation = sign * t * (Math.PI * 0.5);
        root.alpha = 1 - t;
      } else {
        root.rotation = 0;
        root.alpha = 1;
      }
    }
    for (const id of [...this.pigSprites.keys()]) {
      if (!alive.has(id)) {
        const rig = this.pigSprites.get(id);
        if (rig !== undefined) {
          rig.root.parent?.removeChild(rig.root);
          rig.root.destroy({ children: true });
        }
        this.pigSprites.delete(id);
      }
    }
  }

  private syncZombieSprites(_dtSec: number): void {
    this.zombieFirePhase += _dtSec * 9;
    const mm = this.mobManager;
    const walk = this.zombieWalkTextures;
    const idle = this.zombieIdleTextures;
    const jump = this.zombieJumpTextures;
    const attack = this.zombieAttackTextures;
    if (
      mm === null ||
      walk === null ||
      idle === null ||
      walk.length === 0 ||
      idle.length === 0
    ) {
      return;
    }
    const parent = this.playerGraphic?.parent;
    if (parent === null || parent === undefined) {
      return;
    }
    const views = mm.getPublicViews().filter((v) => v.type === MobType.Zombie);
    const alive = new Set<number>();
    const baseScale = this.zombieSpriteBaseScale;
    const extraNudgeDownPx = 1;
    for (const v of views) {
      alive.add(v.id);
      let rig = this.zombieSprites.get(v.id);
      if (rig === undefined) {
        const root = new Container();
        root.sortableChildren = true;
        root.zIndex = -2;
        root.cullable = false;
        root.cullableChildren = false;
        const base = new AnimatedSprite({
          textures: walk,
          animationSpeed: PLAYER_WALK_ANIM_SPEED,
          loop: true,
          autoPlay: true,
        });
        base.anchor.set(0.5, 1);
        base.roundPixels = false;
        base.zIndex = 0;
        base.tint = 0xffffff;
        root.addChild(base);
        const fire = new AnimatedSprite({
          textures: this.zombieFireTextures ?? [Texture.EMPTY],
          animationSpeed: 0.22,
          loop: true,
          autoPlay: true,
        });
        fire.anchor.set(0.5, 1);
        fire.roundPixels = false;
        fire.zIndex = 1;
        fire.visible = false;
        fire.gotoAndPlay(0);
        root.addChild(fire);
        parent.addChild(root);
        rig = { root, base, fire };
        this.zombieSprites.set(v.id, rig);
      }
      const useWalk = v.walking && !v.panic;
      const useAttack = v.attacking && attack !== null && attack.length > 0;
      const useJump = !useAttack && jump !== null && jump.length > 0 && v.vy < -30;
      const frames = useAttack ? attack : useJump ? jump : useWalk ? walk : idle;
      const { root, base, fire } = rig;
      if (base.textures !== frames) {
        base.textures = frames;
        if (v.deathAnimRemainSec > 0) {
          base.gotoAndStop(0);
        } else if (useAttack) {
          base.gotoAndStop(0);
        } else if (useJump) {
          base.gotoAndStop(0);
        } else {
          base.gotoAndPlay(0);
        }
      }
      base.animationSpeed = useWalk
        ? PLAYER_WALK_ANIM_SPEED * 1.15
        : PLAYER_WALK_ANIM_SPEED * 0.85;
      base.tint = 0xffffff;
      const flipX = v.facingRight ? -1 : 1;
      root.scale.set(baseScale, baseScale);
      base.scale.set(flipX, 1);
      // The hit frame in some strips leans forward a few pixels; counter-nudge so the feet stay planted.
      const hitBackPx = 3;
      base.position.x = useAttack ? (v.facingRight ? -hitBackPx : hitBackPx) : 0;
      root.tint = v.hurt ? 0xff4a4a : 0xffffff;
      root.position.set(
        v.x,
        -v.y + ZOMBIE_FEET_SPRITE_NUDGE_Y_PX + extraNudgeDownPx,
      );

      const burning = v.burning && this.zombieFireTextures !== null;
      fire.visible = burning && v.deathAnimRemainSec <= 0;
      if (fire.visible) {
        fire.position.set(-2, -3);
        fire.scale.set(1, 1);
        if (!fire.playing) {
          fire.gotoAndPlay(0);
        }
        const flicker =
          0.78 +
          0.18 * Math.sin(this.zombieFirePhase + v.id * 0.7) +
          0.06 * Math.sin(this.zombieFirePhase * 2.1 + v.id * 1.3);
        fire.alpha = Math.max(0.25, Math.min(0.98, flicker));
      } else {
        fire.stop();
      }
      if (v.deathAnimRemainSec > 0) {
        base.stop();
        const t = Math.min(
          1,
          Math.max(0, 1 - v.deathAnimRemainSec / ZOMBIE_DEATH_ANIM_SEC),
        );
        const sign = v.facingRight ? 1 : -1;
        root.rotation = sign * t * (Math.PI * 0.5);
        root.alpha = 1 - t;
      } else {
        root.rotation = 0;
        root.alpha = 1;
      }
    }
    for (const id of [...this.zombieSprites.keys()]) {
      if (!alive.has(id)) {
        const rig = this.zombieSprites.get(id);
        if (rig !== undefined) {
          rig.root.parent?.removeChild(rig.root);
          rig.root.destroy({ children: true });
        }
        this.zombieSprites.delete(id);
      }
    }
  }

  destroy(): void {
    if (this.playerGraphic !== null) {
      this.playerGraphic.parent?.removeChild(this.playerGraphic);
      this.playerGraphic.destroy({ children: true });
      this.playerGraphic = null;
    }
    this.localPlayerAnim = null;
    this.localHeldItemSprite = null;
    this.localPlayerPlaceholder = null;
    this.playerBodyAtlasFrames = null;
    this.playerIdleAnimTextures = null;
    this.playerWalkCycleTextures = null;
    this.playerJumpUpAnimTextures = null;
    this.playerJumpDownAnimTextures = null;
    this.playerSkidAnimTextures = null;
    this.playerBreakingAnimTextures = null;
    this.localWalkAnimMode.v = "idle";
    this.localSurfaceMode.v = "ground";
    this.remoteWalkAnimMode.clear();
    this.remoteSurfaceMode.clear();
    if (this.aimGraphic !== null) {
      this.aimGraphic.parent?.removeChild(this.aimGraphic);
      this.aimGraphic.destroy();
      this.aimGraphic = null;
    }
    if (this.aimLineSprite !== null) {
      this.aimLineSprite.parent?.removeChild(this.aimLineSprite);
      this.aimLineSprite.destroy();
      this.aimLineSprite = null;
    }
    for (const sprite of this.remoteGraphics.values()) {
      sprite.parent?.removeChild(sprite);
      sprite.destroy({ children: true });
    }
    this.remoteGraphics.clear();
    for (const sprite of this.droppedSprites.values()) {
      sprite.parent?.removeChild(sprite);
      sprite.destroy();
    }
    this.droppedSprites.clear();
    for (const rig of this.sheepSprites.values()) {
      rig.root.parent?.removeChild(rig.root);
      rig.root.destroy({ children: true });
    }
    this.sheepSprites.clear();
    for (const rig of this.pigSprites.values()) {
      rig.root.parent?.removeChild(rig.root);
      rig.root.destroy({ children: true });
    }
    this.pigSprites.clear();
    for (const rig of this.zombieSprites.values()) {
      rig.root.parent?.removeChild(rig.root);
      rig.root.destroy({ children: true });
    }
    this.zombieSprites.clear();
    this.zombieWalkTextures = null;
    this.zombieIdleTextures = null;
    this.zombieJumpTextures = null;
    this.zombieAttackTextures = null;
    this.zombieFireTextures = null;
    this.zombieSpriteBaseScale = 1;
    destroyTextureList(this.sheepWoolOverlayWalkTextures);
    destroyTextureList(this.sheepWoolOverlayIdleTextures);
    this.sheepWalkTextures = null;
    this.sheepIdleTextures = null;
    this.sheepWoolOverlayWalkTextures = null;
    this.sheepWoolOverlayIdleTextures = null;
    this.pigWalkTextures = null;
    this.pigIdleTextures = null;
    this.mobManager = null;
  }
}
