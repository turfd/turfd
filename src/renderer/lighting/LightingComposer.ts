/** Light texture pool, occlusion rebuild, and fullscreen composite lighting pass. */
import type { Container, RenderTexture } from "pixi.js";
import type { EventBus } from "../../core/EventBus";
import { BLOCK_SIZE, CHUNK_SIZE } from "../../core/constants";
import type { Camera } from "../Camera";
import { CompositePass } from "./CompositePass";
import type { CompositeUniforms } from "./CompositePass";
import { LightTexture } from "./LightTexture";
import { OcclusionTexture } from "./OcclusionTexture";
import { IndirectLightTexture } from "./IndirectLightTexture";
import type { WorldLightingParams } from "../../world/lighting/WorldTime";
import type { World } from "../../world/World";

export type HeldTorchLighting = NonNullable<CompositeUniforms["heldTorch"]>;

function chunkKey(cx: number, cy: number): string {
  return `${cx},${cy}`;
}

export class LightingComposer {
  private readonly _world: World;
  private readonly _stage: Container;
  private readonly _textures = new Map<string, LightTexture>();
  private readonly _dirty = new Set<string>();
  private _screenW: number;
  private _screenH: number;
  private readonly _lightUnsub: () => void;

  private _camera: Camera | null = null;
  private _occlusion: OcclusionTexture | null = null;
  private _indirect: IndirectLightTexture | null = null;
  private _composite: CompositePass | null = null;

  private readonly _compositeU: CompositeUniforms = {
    sunDir: [0, 0],
    moonDir: [0, 0],
    ambient: 0,
    ambientTint: [1, 1, 1],
    skyLightTint: [1, 1, 1],
    sunIntensity: 0,
    sunTint: [1, 1, 1],
    cameraWorld: [0, 0],
    blockPixels: 32,
    occlusionOrigin: [0, 0],
    occlusionSize: OcclusionTexture.REGION_BLOCKS,
    moonIntensity: 0,
    moonTint: [0.6, 0.7, 1.0],
    heldTorch: null,
  };

  constructor(world: World, bus: EventBus, stage: Container) {
    this._world = world;
    this._stage = stage;
    this._screenW = window.innerWidth;
    this._screenH = window.innerHeight;

    this._lightUnsub = bus.on("world:light-updated", (e) => {
      const key = chunkKey(e.chunkX, e.chunkY);
      this._dirty.add(key);
      if (!this._textures.has(key)) {
        this._textures.set(key, new LightTexture());
      }
      this._occlusion?.markDirty();
      this._indirect?.markDirty();
    });
  }

  initComposite(albedoRT: RenderTexture, camera: Camera): void {
    if (this._composite !== null) {
      return;
    }
    this._camera = camera;
    this._occlusion = new OcclusionTexture();
    this._indirect = new IndirectLightTexture();
    this._composite = new CompositePass(albedoRT, this._occlusion, this._indirect);
    this._stage.addChild(this._composite.displayObject);
    this._composite.resize(this._screenW, this._screenH);
  }

  /**
   * Call once per frame before rendering.
   * Flushes dirty light textures; rebuilds occlusion; updates composite uniforms.
   */
  update(
    lighting: WorldLightingParams,
    _cameraX: number,
    _cameraY: number,
    heldTorch: HeldTorchLighting | null,
  ): void {
    for (const key of this._dirty) {
      const tex = this._textures.get(key);
      if (tex === undefined) {
        continue;
      }
      const comma = key.indexOf(",");
      if (comma <= 0) {
        continue;
      }
      const cx = Number.parseInt(key.slice(0, comma), 10);
      const cy = Number.parseInt(key.slice(comma + 1), 10);
      const chunk = this._world.getChunk(cx, cy);
      if (chunk === undefined) {
        continue;
      }
      if (tex.update(chunk.skyLight, chunk.blockLight)) {
        tex.upload();
      }
    }
    this._dirty.clear();

    const cam = this._camera;
    const occ = this._occlusion;
    const indirect = this._indirect;
    const comp = this._composite;
    if (cam === null || occ === null || indirect === null || comp === null) {
      return;
    }

    const pos = cam.getPosition();
    // Derive center chunk directly from continuous camera world coords. This avoids
    // premature region snaps near block edges that can show up as chunk-boundary seams.
    const chunkWorldSize = BLOCK_SIZE * CHUNK_SIZE;
    const centerChunkX = Math.floor(pos.x / chunkWorldSize);
    const centerChunkY = Math.floor(-pos.y / chunkWorldSize);
    if (occ.rebuild(centerChunkX, centerChunkY, this._world)) {
      occ.upload();
    }
    if (indirect.rebuild(centerChunkX, centerChunkY, this._world)) {
      indirect.upload();
    }

    const tl = cam.screenToWorld(0, 0);
    const blockPixels = BLOCK_SIZE * cam.getZoom();
    // Pixi world Y is flipped vs block wy (tiles use y = -wy * BLOCK_SIZE). Top-left world block:
    const cameraWorldX = tl.x / BLOCK_SIZE;
    const cameraWorldY = -tl.y / BLOCK_SIZE;

    const u = this._compositeU;
    u.sunDir[0] = lighting.sunDir[0];
    u.sunDir[1] = lighting.sunDir[1];
    u.moonDir[0] = lighting.moonDir[0];
    u.moonDir[1] = lighting.moonDir[1];
    u.ambient = lighting.ambient;
    u.ambientTint[0] = lighting.ambientTint[0];
    u.ambientTint[1] = lighting.ambientTint[1];
    u.ambientTint[2] = lighting.ambientTint[2];
    u.skyLightTint[0] = lighting.skyLightTint[0];
    u.skyLightTint[1] = lighting.skyLightTint[1];
    u.skyLightTint[2] = lighting.skyLightTint[2];
    u.sunIntensity = lighting.sunIntensity;
    u.sunTint[0] = lighting.sunTint[0];
    u.sunTint[1] = lighting.sunTint[1];
    u.sunTint[2] = lighting.sunTint[2];
    u.cameraWorld[0] = cameraWorldX;
    u.cameraWorld[1] = cameraWorldY;
    u.blockPixels = blockPixels;
    u.occlusionOrigin[0] = occ.originX;
    u.occlusionOrigin[1] = occ.originY;
    u.occlusionSize = OcclusionTexture.REGION_BLOCKS;
    u.moonIntensity = lighting.moonIntensity;
    u.heldTorch = heldTorch;
    comp.updateUniforms(u);
  }

  getLightTexture(cx: number, cy: number): LightTexture {
    const key = chunkKey(cx, cy);
    let tex = this._textures.get(key);
    if (tex === undefined) {
      tex = new LightTexture();
      this._textures.set(key, tex);
    }
    return tex;
  }

  resize(w: number, h: number): void {
    this._screenW = w;
    this._screenH = h;
    this._composite?.resize(w, h);
  }

  destroy(): void {
    this._lightUnsub();
    for (const tex of this._textures.values()) {
      tex.destroy();
    }
    this._textures.clear();
    this._dirty.clear();
    this._composite?.displayObject.parent?.removeChild(this._composite.displayObject);
    this._composite?.destroy();
    this._composite = null;
    this._occlusion?.destroy();
    this._occlusion = null;
    this._indirect?.destroy();
    this._indirect = null;
    this._camera = null;
  }
}
