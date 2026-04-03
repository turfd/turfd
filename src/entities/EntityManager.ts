/**
 * Phase 1: local player only.
 */
import { Assets, Graphics, Sprite, Texture } from "pixi.js";
import type { AudioEngine } from "../audio/AudioEngine";
import { BLOCK_SIZE, REACH_BLOCKS, PLAYER_HEIGHT, PLAYER_WIDTH } from "../core/constants";
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

export class EntityManager {
  private readonly world: World;
  private readonly input: InputManager;
  private readonly player: Player;
  private readonly airId: number;
  private readonly itemRegistry: ItemRegistry;
  /** Packed item atlas (block + item manifest paths); dropped entities use this, not terrain atlas. */
  private readonly itemTextureAtlas: AtlasLoader;
  private playerGraphic: Graphics | null = null;
  private aimGraphic: Graphics | null = null;
  private aimLineSprite: Sprite | null = null;
  private readonly remoteGraphics = new Map<string, Graphics>();
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
    const g = new Graphics();
    g.rect(0, 0, PLAYER_WIDTH, PLAYER_HEIGHT);
    g.fill({ color: 0x00ffff });
    pipeline.layerEntities.addChild(g);
    this.playerGraphic = g;

    const aim = new Graphics();
    pipeline.layerForeground.addChild(aim);
    this.aimGraphic = aim;

    this.aimLineSprite = null;
    void this.loadAimLineSprite(pipeline);

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
    const g = this.playerGraphic;
    if (g !== null) {
      const s = this.player.state;
      const x = s.prevPosition.x + (s.position.x - s.prevPosition.x) * alpha;
      const y = s.prevPosition.y + (s.position.y - s.prevPosition.y) * alpha;
      g.position.set(x - PLAYER_WIDTH / 2, -y - PLAYER_HEIGHT);
    }

    const remotePlayers = this.world.getRemotePlayers();
    for (const [peerId, sprite] of this.remoteGraphics) {
      if (!remotePlayers.has(peerId)) {
        sprite.parent?.removeChild(sprite);
        sprite.destroy();
        this.remoteGraphics.delete(peerId);
      }
    }
    for (const [peerId, rp] of remotePlayers) {
      let sprite = this.remoteGraphics.get(peerId);
      if (sprite === undefined) {
        sprite = new Graphics();
        sprite.rect(0, 0, PLAYER_WIDTH, PLAYER_HEIGHT);
        sprite.fill({ color: 0xff66ff });
        const parent = this.playerGraphic?.parent;
        parent?.addChild(sprite);
        this.remoteGraphics.set(peerId, sprite);
      }
      const screenX = rp.x;
      const screenY = -rp.y;
      sprite.position.set(screenX - PLAYER_WIDTH / 2, screenY - PLAYER_HEIGHT);
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
    const ix = playerState.prevPosition.x + (playerState.position.x - playerState.prevPosition.x) * alpha;
    const iy = playerState.prevPosition.y + (playerState.position.y - playerState.prevPosition.y) * alpha;
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
      this.playerGraphic.destroy();
      this.playerGraphic = null;
    }
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
      sprite.destroy();
    }
    this.remoteGraphics.clear();
    for (const sprite of this.droppedSprites.values()) {
      sprite.parent?.removeChild(sprite);
      sprite.destroy();
    }
    this.droppedSprites.clear();
  }
}
