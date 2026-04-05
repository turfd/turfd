/**
 * Block break progress: Minecraft-style destroy-stage overlay from
 * `textures/GUI/destroy_stage/destroy_stage_0.png` … `_9.png`, with procedural fallback if any stage fails to load.
 */
import { Assets, Container, Graphics, Sprite, Texture } from "pixi.js";
import { BLOCK_SIZE } from "../core/constants";
import { stratumCoreTextureAssetUrl } from "../core/textureManifest";
import type { PlayerState } from "../entities/Player";
import type { RemotePlayer } from "../world/entities/RemotePlayer";
import type { RenderPipeline } from "./RenderPipeline";

const DESTROY_STAGE_COUNT = 10;

function destroyStageUrls(): readonly string[] {
  return Array.from({ length: DESTROY_STAGE_COUNT }, (_, i) =>
    stratumCoreTextureAssetUrl(`GUI/destroy_stage/destroy_stage_${i}.png`),
  );
}

type BreakVisual = {
  root: Container;
  sprite: Sprite;
  fallback: Graphics;
};

export class BreakOverlay {
  private readonly remoteLayer: Container;
  private readonly localRoot: Container;
  private readonly localSprite: Sprite;
  private readonly localFallback: Graphics;
  private textures: Texture[] | null = null;
  private readonly remoteByPeer = new Map<string, BreakVisual>();

  constructor(pipeline: RenderPipeline) {
    this.remoteLayer = new Container();
    pipeline.layerEntities.addChild(this.remoteLayer);

    this.localRoot = new Container();
    this.localRoot.visible = false;
    this.localSprite = new Sprite();
    this.localSprite.width = BLOCK_SIZE;
    this.localSprite.height = BLOCK_SIZE;
    this.localFallback = new Graphics();
    this.localRoot.addChild(this.localFallback);
    this.localRoot.addChild(this.localSprite);
    this.localRoot.blendMode = "overlay";
    pipeline.layerEntities.addChild(this.localRoot);
  }

  /**
   * Loads all destroy stages in order. The PNG overlay is used only when every stage loads;
   * otherwise {@link sync} uses the legacy procedural crack fill.
   */
  async loadDestroyStageTextures(): Promise<void> {
    const urls = destroyStageUrls();
    const out: Texture[] = [];
    for (const url of urls) {
      try {
        const tex =
          (await Assets.load<Texture>(url)) ?? Assets.get<Texture>(url);
        if (
          tex === undefined ||
          tex === Texture.EMPTY ||
          tex.source === undefined
        ) {
          this.textures = null;
          return;
        }
        tex.source.scaleMode = "nearest";
        out.push(tex);
      } catch {
        this.textures = null;
        return;
      }
    }
    this.textures = out;
  }

  sync(state: PlayerState): void {
    const t = state.breakTarget;
    if (t === null || state.breakProgress <= 0) {
      this.localRoot.visible = false;
      return;
    }

    this.paintBreak(
      this.localRoot,
      this.localSprite,
      this.localFallback,
      t.wx,
      t.wy,
      state.breakProgress,
    );
  }

  /** Renders other players’ mining cracks (host + clients). */
  syncRemotes(remotes: ReadonlyMap<string, RemotePlayer>): void {
    const seen = new Set<string>();
    for (const [peerId, rp] of remotes) {
      const bm = rp.getBreakMining();
      if (bm === null || bm.progress <= 0) {
        continue;
      }
      seen.add(peerId);
      let entry = this.remoteByPeer.get(peerId);
      if (entry === undefined) {
        const root = new Container();
        root.blendMode = "overlay";
        const sprite = new Sprite();
        sprite.width = BLOCK_SIZE;
        sprite.height = BLOCK_SIZE;
        const fallback = new Graphics();
        root.addChild(fallback);
        root.addChild(sprite);
        this.remoteLayer.addChild(root);
        entry = { root, sprite, fallback };
        this.remoteByPeer.set(peerId, entry);
      }
      this.paintBreak(
        entry.root,
        entry.sprite,
        entry.fallback,
        bm.wx,
        bm.wy,
        bm.progress,
      );
    }
    for (const id of this.remoteByPeer.keys()) {
      if (!seen.has(id)) {
        const e = this.remoteByPeer.get(id)!;
        e.root.parent?.removeChild(e.root);
        e.root.destroy({ children: true });
        this.remoteByPeer.delete(id);
      }
    }
  }

  destroy(): void {
    for (const e of this.remoteByPeer.values()) {
      e.root.parent?.removeChild(e.root);
      e.root.destroy({ children: true });
    }
    this.remoteByPeer.clear();
    this.remoteLayer.parent?.removeChild(this.remoteLayer);
    this.remoteLayer.destroy({ children: true });
    this.localRoot.parent?.removeChild(this.localRoot);
    this.localRoot.destroy({ children: true });
  }

  private paintBreak(
    root: Container,
    sprite: Sprite,
    fallback: Graphics,
    wx: number,
    wy: number,
    progress: number,
  ): void {
    root.visible = true;
    root.position.set(wx * BLOCK_SIZE, -(wy + 1) * BLOCK_SIZE);

    const stages = this.textures;

    if (stages !== null && stages.length === DESTROY_STAGE_COUNT) {
      sprite.visible = true;
      fallback.visible = false;
      fallback.clear();
      const idx = Math.min(
        DESTROY_STAGE_COUNT - 1,
        Math.floor(progress * DESTROY_STAGE_COUNT),
      );
      const tex = stages[idx]!;
      if (sprite.texture !== tex) {
        sprite.texture = tex;
      }
    } else {
      sprite.visible = false;
      fallback.visible = true;
      fallback.clear();
      drawProceduralFallback(fallback, progress);
    }
  }
}

function drawProceduralFallback(g: Graphics, p: number): void {
  const w = BLOCK_SIZE;
  g.rect(0, 0, w, w);
  g.fill({ color: 0x000000, alpha: p * 0.7 });
  g.rect(0, 0, w, w);
  g.stroke({ width: 2, color: 0xffffff, alpha: 1 });
  const pad = 3;
  const span = (w - pad * 2) * p;
  g.moveTo(pad, pad);
  g.lineTo(pad + span, pad + span);
  g.stroke({ width: 1.5, color: 0x888888, alpha: 0.85 });
  g.moveTo(w - pad, pad);
  g.lineTo(w - pad - span, pad + span);
  g.stroke({ width: 1.5, color: 0x888888, alpha: 0.85 });
}
