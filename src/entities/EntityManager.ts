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
import { getAimUnitVectorFromFeet } from "../input/aimDirection";
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

    // Remote players are added lazily in syncPlayerGraphic when their state appears in World.
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
        if (idle !== null && cycle !== null && cycle.length > 0) {
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
          miningVisual &&
          breaking !== null &&
          breaking.length >= 2 &&
          anim.textures === breaking;
        applyPlayerSpriteFeetPosition(
          anim,
          this.playerSpriteBaseScale,
          breakingLoopActive,
          s.facingRight,
        );

        const held = this.localHeldItemSprite;
        if (held !== null) {
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
    const centerX = ix;
    const centerY = -iy - PLAYER_HEIGHT * 0.5;
    const mouseX = this.input.mouseWorldPos.x;
    const mouseY = this.input.mouseWorldPos.y;
    const { dirX, dirY } = getAimUnitVectorFromFeet(
      ix,
      iy,
      mouseX,
      mouseY,
      playerState.facingRight,
    );
    const dist = Math.hypot(mouseX - centerX, mouseY - centerY);

    const startOffsetPx = BLOCK_SIZE;
    const maxLenPx = REACH_BLOCKS * BLOCK_SIZE;
    const lineLenPx = Math.min(Math.max(dist - startOffsetPx, 0), maxLenPx);

    const lineStartX = centerX + dirX * startOffsetPx;
    const lineStartY = centerY + dirY * startOffsetPx;
    const aimX = lineStartX + dirX * lineLenPx;
    const aimY = lineStartY + dirY * lineLenPx;

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
  }
}
