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
  PLAYER_HEIGHT,
  PLAYER_BREAKING_ANIM_SPEED,
  PLAYER_BREAKING_ATLAS_FRAMES,
  PLAYER_BREAKING_ATLAS_IMAGE_REL,
  PLAYER_BREAKING_MINING_FRAME_OFFSET_X_TEXELS,
  PLAYER_BREAKING_MINING_FRAME_OFFSET_Y_TEXELS,
  PLAYER_MOVE_ANIM_VEL_THRESHOLD,
  PLAYER_REMOTE_SPRINT_VEL_THRESHOLD,
  PLAYER_SPRITE_FEET_OFFSET_PX,
  PLAYER_SPRITE_FEET_PAD_TEXELS,
  PLAYER_SPRITE_SCALE_MULTIPLIER,
  PLAYER_SPRINT_ANIM_SPEED_MULT,
  PLAYER_JUMP_ATLAS_FRAMES,
  PLAYER_JUMP_ATLAS_IMAGE_REL,
  PLAYER_REMOTE_AIR_VY_THRESHOLD,
  PLAYER_REMOTE_ANIM_VEL_SMOOTH_PER_SEC,
  PLAYER_WALK_ANIM_SPEED,
  PLAYER_WALK_ATLAS_FRAMES,
  PLAYER_WALK_ATLAS_IMAGE_REL,
  PLAYER_WALK_CYCLE_FRAME_INDICES,
  PLAYER_WALK_FRAME_COUNT,
  PLAYER_WALK_IDLE_FRAME_INDEX,
  PLAYER_WIDTH,
  REACH_BLOCKS,
} from "../core/constants";
import { stratumCoreTextureAssetUrl } from "../core/textureManifest";
import type { EventBus } from "../core/EventBus";
import { getAimUnitVectorFromFeet } from "../input/aimDirection";
import type { InputManager } from "../input/InputManager";
import type { ItemRegistry } from "../items/ItemRegistry";
import type { AtlasLoader } from "../renderer/AtlasLoader";
import type { RenderPipeline } from "../renderer/RenderPipeline";
import type { BlockRegistry } from "../world/blocks/BlockRegistry";
import type { World } from "../world/World";
import { Player } from "./Player";

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

function sliceWalkFrames(sheet: Texture): Texture[] {
  return sliceAtlasFrames(sheet, PLAYER_WALK_ATLAS_FRAMES);
}

type WalkAnimModeRef = { v: "idle" | "walk" | "breaking" };

type WalkAnimTextures = {
  readonly idle: Texture[];
  readonly cycle: Texture[];
  readonly mode: WalkAnimModeRef;
};

type SurfaceModeRef = { v: "ground" | "air" };

function layoutPlayerSprite(sprite: AnimatedSprite, uniformScale: number): void {
  sprite.anchor.set(0.5, 1);
  const feetNudge =
    PLAYER_SPRITE_FEET_OFFSET_PX + PLAYER_SPRITE_FEET_PAD_TEXELS * uniformScale;
  sprite.position.set(PLAYER_WIDTH * 0.5, PLAYER_HEIGHT + feetNudge);
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
  sprite.position.set(PLAYER_WIDTH * 0.5 + ox, PLAYER_HEIGHT + feetNudge + oy);
}

function syncWalkAnimation(
  sprite: AnimatedSprite,
  moving: boolean,
  sprinting: boolean,
  facingRight: boolean,
  baseScale: number,
  walkAnim: WalkAnimTextures | null,
): void {
  if (walkAnim === null) {
    return;
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
  jumpTextures: Texture[] | null,
  surface: SurfaceModeRef,
  breakingTextures: Texture[] | null,
  miningActive: boolean,
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

  if (!onGround && jumpTextures !== null && jumpTextures.length > 0) {
    if (surface.v === "ground") {
      surface.v = "air";
      if (walkAnim !== null) {
        walkAnim.mode.v = "idle";
      }
    }
    sprite.textures = jumpTextures;
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
  private localPlayerPlaceholder: Graphics | null = null;
  /** Full atlas columns after trim (length {@link PLAYER_WALK_FRAME_COUNT}). */
  private playerWalkAtlasFrames: Texture[] | null = null;
  private playerIdleAnimTextures: Texture[] | null = null;
  private playerWalkCycleTextures: Texture[] | null = null;
  private playerJumpAnimTextures: Texture[] | null = null;
  /** Two frames: idle walk pose + `breaking.png` (loops while mining). */
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

  update(dt: number): void {
    this.player.update(dt, this.input, this.world);
  }

  /** Sync placeholder rects to player + remote player world positions (call each render). */
  syncPlayerGraphic(alpha: number, dtSec: number): void {
    const root = this.playerGraphic;
    if (root !== null) {
      const s = this.player.state;
      const x = s.prevPosition.x + (s.position.x - s.prevPosition.x) * alpha;
      const y = s.prevPosition.y + (s.position.y - s.prevPosition.y) * alpha;
      root.position.set(x - PLAYER_WIDTH / 2, -y - PLAYER_HEIGHT);

      const anim = this.localPlayerAnim;
      if (anim !== null) {
        const vx = s.velocity.x;
        const moving =
          s.onGround && Math.abs(vx) >= PLAYER_MOVE_ANIM_VEL_THRESHOLD;
        const sprinting = moving && this.input.isDown("sprint");
        const idle = this.playerIdleAnimTextures;
        const cycle = this.playerWalkCycleTextures;
        const jump = this.playerJumpAnimTextures;
        const breaking = this.playerBreakingAnimTextures;
        const mining =
          s.breakTarget !== null &&
          s.breakProgress < 1 &&
          !this.input.isWorldInputBlocked();
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
            jump,
            this.localSurfaceMode,
            breaking,
            mining,
          );
        }
        const breakingLoopActive =
          mining &&
          breaking !== null &&
          breaking.length >= 2 &&
          anim.textures === breaking;
        applyPlayerSpriteFeetPosition(
          anim,
          this.playerSpriteBaseScale,
          breakingLoopActive,
          s.facingRight,
        );
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
      const rx = rp.prevX + (rp.x - rp.prevX) * alpha;
      const ry = rp.prevY + (rp.y - rp.prevY) * alpha;
      remoteRoot.position.set(rx - PLAYER_WIDTH / 2, -ry - PLAYER_HEIGHT);

      const body = remoteRoot.children[0];
      if (body instanceof AnimatedSprite) {
        const rawVx = rp.velocityX;
        const rawVy = rp.velocityY;
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
        const jump = this.playerJumpAnimTextures;
        const breaking = this.playerBreakingAnimTextures;
        const mining = rp.getBreakMining() !== null;
        if (idle !== null && cycle !== null && cycle.length > 0 && mode !== undefined) {
          syncPlayerBodyAnimation(
            body,
            onGroundApprox,
            moving,
            sprinting,
            rp.facingRight,
            this.playerSpriteBaseScale,
            { idle, cycle, mode },
            jump,
            surf,
            breaking,
            mining,
          );
        }
        const breakingLoopActive =
          mining &&
          breaking !== null &&
          breaking.length >= 2 &&
          body.textures === breaking;
        applyPlayerSpriteFeetPosition(
          body,
          this.playerSpriteBaseScale,
          breakingLoopActive,
          rp.facingRight,
        );
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
    const idle = this.playerIdleAnimTextures;
    if (
      idle !== null &&
      this.playerWalkCycleTextures !== null &&
      this.playerWalkCycleTextures.length > 0 &&
      this.playerWalkAtlasFrames !== null &&
      this.playerWalkAtlasFrames.length === PLAYER_WALK_FRAME_COUNT
    ) {
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
    const atlas = this.playerWalkAtlasFrames;
    if (
      idle === null ||
      cycle === null ||
      cycle.length === 0 ||
      atlas === null ||
      atlas.length !== PLAYER_WALK_FRAME_COUNT
    ) {
      return;
    }
    for (const [peerId, root] of this.remoteGraphics) {
      const first = root.children[0];
      if (first instanceof AnimatedSprite) {
        continue;
      }
      first?.destroy();
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
      root.addChildAt(anim, 0);
      let mode = this.remoteWalkAnimMode.get(peerId);
      if (mode === undefined) {
        mode = { v: "idle" };
        this.remoteWalkAnimMode.set(peerId, mode);
      } else {
        mode.v = "idle";
      }
      const rp = this.world.getRemotePlayers().get(peerId);
      if (rp !== undefined) {
        const vx = rp.velocityX;
        const onGroundApprox =
          Math.abs(rp.velocityY) <= PLAYER_REMOTE_AIR_VY_THRESHOLD;
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
        const mining = rp.getBreakMining() !== null;
        syncPlayerBodyAnimation(
          anim,
          onGroundApprox,
          moving,
          sprinting,
          rp.facingRight,
          this.playerSpriteBaseScale,
          { idle, cycle, mode },
          this.playerJumpAnimTextures,
          surf,
          breaking,
          mining,
        );
      }
    }
  }

  private async loadPlayerSprites(): Promise<void> {
    const walkUrl = stratumCoreTextureAssetUrl(PLAYER_WALK_ATLAS_IMAGE_REL);
    const jumpUrl = stratumCoreTextureAssetUrl(PLAYER_JUMP_ATLAS_IMAGE_REL);
    try {
      const sheet =
        (await Assets.load<Texture>(walkUrl)) ?? Assets.get<Texture>(walkUrl);
      if (
        sheet === undefined ||
        sheet === Texture.EMPTY ||
        sheet.source === undefined
      ) {
        return;
      }
      sheet.source.scaleMode = "nearest";
      const frames = sliceWalkFrames(sheet);
      if (frames.length !== PLAYER_WALK_FRAME_COUNT) {
        return;
      }
      const idleTex = frames[PLAYER_WALK_IDLE_FRAME_INDEX];
      if (idleTex === undefined) {
        return;
      }
      const cycle: Texture[] = [];
      for (const idx of PLAYER_WALK_CYCLE_FRAME_INDICES) {
        const t = frames[idx];
        if (t === undefined) {
          return;
        }
        cycle.push(t);
      }
      this.playerWalkAtlasFrames = frames;
      this.playerIdleAnimTextures = [idleTex];
      this.playerWalkCycleTextures = cycle;
      this.localWalkAnimMode.v = "idle";
      this.localSurfaceMode.v = "ground";

      let maxW = 0;
      let maxH = 0;
      for (const f of frames) {
        maxW = Math.max(maxW, f.width);
        maxH = Math.max(maxH, f.height);
      }

      let jumpFrames: Texture[] | null = null;
      try {
        const jumpSheet =
          (await Assets.load<Texture>(jumpUrl)) ??
          Assets.get<Texture>(jumpUrl);
        if (
          jumpSheet !== undefined &&
          jumpSheet !== Texture.EMPTY &&
          jumpSheet.source !== undefined
        ) {
          jumpSheet.source.scaleMode = "nearest";
          const sliced = sliceAtlasFrames(jumpSheet, PLAYER_JUMP_ATLAS_FRAMES);
          if (sliced.length === PLAYER_JUMP_ATLAS_FRAMES.length) {
            jumpFrames = sliced;
            for (const f of sliced) {
              maxW = Math.max(maxW, f.width);
              maxH = Math.max(maxH, f.height);
            }
          }
        }
      } catch {
        jumpFrames = null;
      }
      this.playerJumpAnimTextures = jumpFrames;

      let breakingLoop: Texture[] | null = null;
      try {
        const breakUrl = stratumCoreTextureAssetUrl(
          PLAYER_BREAKING_ATLAS_IMAGE_REL,
        );
        const breakSheet =
          (await Assets.load<Texture>(breakUrl)) ??
          Assets.get<Texture>(breakUrl);
        if (
          breakSheet !== undefined &&
          breakSheet !== Texture.EMPTY &&
          breakSheet.source !== undefined
        ) {
          breakSheet.source.scaleMode = "nearest";
          const sliced = sliceAtlasFrames(
            breakSheet,
            PLAYER_BREAKING_ATLAS_FRAMES,
          );
          if (sliced.length === PLAYER_BREAKING_ATLAS_FRAMES.length) {
            const b0 = sliced[0];
            if (b0 !== undefined) {
              breakingLoop = [idleTex, b0];
              maxW = Math.max(maxW, b0.width);
              maxH = Math.max(maxH, b0.height);
            }
          }
        }
      } catch {
        breakingLoop = null;
      }
      this.playerBreakingAnimTextures = breakingLoop;

      if (maxW <= 0 || maxH <= 0) {
        return;
      }
      const uniformScale =
        Math.min(PLAYER_WIDTH / maxW, PLAYER_HEIGHT / maxH) *
        PLAYER_SPRITE_SCALE_MULTIPLIER;
      this.playerSpriteBaseScale = uniformScale;

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
      layoutPlayerSprite(anim, uniformScale);
      anim.gotoAndStop(0);
      root.addChild(anim);
      this.localPlayerAnim = anim;

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
    this.localPlayerPlaceholder = null;
    this.playerWalkAtlasFrames = null;
    this.playerIdleAnimTextures = null;
    this.playerWalkCycleTextures = null;
    this.playerJumpAnimTextures = null;
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
