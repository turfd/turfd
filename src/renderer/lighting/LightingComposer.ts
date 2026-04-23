/** Light texture pool, occlusion rebuild, and fullscreen composite lighting pass. */
import type { Container, RenderTexture, TextureSource } from "pixi.js";
import type { EventBus } from "../../core/EventBus";
import {
  BLOCK_SIZE,
  CHUNK_SIZE,
  MAX_PLACED_TORCHES,
  TORCH_FLAME_TIP_OFFSET_X_BLOCKS,
  TORCH_FLAME_TIP_OFFSET_Y_BLOCKS,
} from "../../core/constants";
import type { DynamicLightEmitter } from "../../core/types";
import type { Camera } from "../Camera";
import { CompositePass } from "./CompositePass";
import type { CompositeUniforms } from "./CompositePass";
import { LightTexture } from "./LightTexture";
import { OcclusionTexture } from "./OcclusionTexture";
import { IndirectLightTexture } from "./IndirectLightTexture";
import type { WorldLightingParams } from "../../world/lighting/WorldTime";
import type { World } from "../../world/World";
import { getBackground, getBlock } from "../../world/chunk/Chunk";
import { getVideoPrefs } from "../../ui/settings/videoPrefs";

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
  private readonly _emitterBlockUnsub: () => void;
  private readonly _emitterBulkUnsub: () => void;

  /** Sparse emissive-cell positions per chunk; invalidated on block edits (see constructor). */
  private readonly _emitterChunkCache = new Map<
    string,
    { wx: number[]; wy: number[] }
  >();

  /** Max-heap by dist² (root = worst of the K nearest). Reused each frame. */
  private readonly _torchHeapWx = new Float64Array(MAX_PLACED_TORCHES);
  private readonly _torchHeapWy = new Float64Array(MAX_PLACED_TORCHES);
  private readonly _torchHeapStrength = new Float32Array(MAX_PLACED_TORCHES);
  private readonly _torchHeapD2 = new Float64Array(MAX_PLACED_TORCHES);
  private _torchHeapSize = 0;

  private readonly _placedTorchTriples: [number, number, number][] = Array.from(
    { length: MAX_PLACED_TORCHES },
    () => [0, 0, 1] as [number, number, number],
  );

  private _camera: Camera | null = null;
  private _occlusion: OcclusionTexture | null = null;
  private _indirect: IndirectLightTexture | null = null;
  private _composite: CompositePass | null = null;

  private readonly _compositeU: CompositeUniforms = {
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
    placedTorches: [],
    placedTorchCount: 0,
    tonemapper: 1,
    bloomEnabled: true,
    bloomMaskActive: true,
    playerBloomUvBoundsActive: false,
    playerBloomUvMin: [0, 0],
    playerBloomUvMax: [0, 0],
    uvBaseOffset: [0, 0],
    uvScale: [1, 1],
    uvSubpixelOffset: [0, 0],
  };

  private _playerBloomUvBoundsActive = false;
  private readonly _playerBloomUvMinScratch: [number, number] = [0, 0];
  private readonly _playerBloomUvMaxScratch: [number, number] = [0, 0];

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
      this._occlusion?.markDirty(e.chunkX, e.chunkY);
      this._indirect?.markDirty(e.chunkX, e.chunkY);
    });

    this._emitterBlockUnsub = bus.on("game:block-changed", (e) => {
      const cx = Math.floor(e.wx / CHUNK_SIZE);
      const cy = Math.floor(e.wy / CHUNK_SIZE);
      this._emitterChunkCache.delete(chunkKey(cx, cy));
    });

    this._emitterBulkUnsub = bus.on("game:chunks-fg-bulk-updated", (e) => {
      for (const c of e.chunkCoords) {
        this._emitterChunkCache.delete(chunkKey(c.cx, c.cy));
      }
    });
  }

  initComposite(
    albedoRT: RenderTexture,
    camera: Camera,
    playerBloomMaskSource: TextureSource,
  ): void {
    if (this._composite !== null) {
      return;
    }
    this._camera = camera;
    this._occlusion = new OcclusionTexture();
    this._indirect = new IndirectLightTexture();
    this._composite = new CompositePass(
      albedoRT,
      this._occlusion,
      this._indirect,
      playerBloomMaskSource,
    );
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
    dynamicEmitters?: readonly DynamicLightEmitter[],
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

    const mid = cam.screenToWorld(this._screenW * 0.5, this._screenH * 0.5);
    const viewCenterWx = mid.x / BLOCK_SIZE;
    const viewCenterWy = -mid.y / BLOCK_SIZE;

    // Nearest MAX_PLACED_TORCHES emissive cells in the occlusion region (distance to view center).
    // Chunk-local id scan + per-chunk sparse cache (invalidated on block edits); top-K via max-heap.
    const regionChunks = OcclusionTexture.REGION_BLOCKS / CHUNK_SIZE;
    const halfRegion = Math.floor(regionChunks / 2);
    const camCx = centerChunkX;
    const camCy = centerChunkY;

    const keepKeys = new Set<string>();
    for (let dy = -halfRegion; dy <= halfRegion; dy++) {
      for (let dx = -halfRegion; dx <= halfRegion; dx++) {
        keepKeys.add(chunkKey(camCx + dx, camCy + dy));
      }
    }
    for (const k of this._emitterChunkCache.keys()) {
      if (!keepKeys.has(k)) {
        this._emitterChunkCache.delete(k);
      }
    }

    this._torchHeapReset();
    if (dynamicEmitters !== undefined) {
      for (const e of dynamicEmitters) {
        const ddx = e.worldBlockX - viewCenterWx;
        const ddy = e.worldBlockY - viewCenterWy;
        this._torchHeapOffer(
          e.worldBlockX,
          e.worldBlockY,
          e.strength,
          ddx * ddx + ddy * ddy,
        );
      }
    }
    for (let dy = -halfRegion; dy <= halfRegion; dy++) {
      for (let dx = -halfRegion; dx <= halfRegion; dx++) {
        const ccx = camCx + dx;
        const ccy = camCy + dy;
        const { wx, wy } = this._getChunkEmitterPositions(this._world, ccx, ccy);
        for (let i = 0; i < wx.length; i++) {
          const wxi = wx[i]! + TORCH_FLAME_TIP_OFFSET_X_BLOCKS;
          const wyi = wy[i]! + TORCH_FLAME_TIP_OFFSET_Y_BLOCKS;
          const ddx = wxi - viewCenterWx;
          const ddy = wyi - viewCenterWy;
          this._torchHeapOffer(wxi, wyi, 1, ddx * ddx + ddy * ddy);
        }
      }
    }

    const u = this._compositeU;
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
    this._fillPlacedTorchUniforms(u);
    const vp = getVideoPrefs();
    const tm = vp.tonemapper;
    u.tonemapper =
      tm === "aces"
        ? 1
        : tm === "agx"
          ? 2
          : tm === "reinhard"
            ? 3
            : 0;
    u.bloomEnabled = vp.bloom;
    // Sub-pixel correction is now applied via RenderPipeline's `subPixelNudge` container.
    // Keep composite UV sampling stable to avoid double-applying the same offset.
    u.uvSubpixelOffset[0] = 0;
    u.uvSubpixelOffset[1] = 0;
    u.playerBloomUvBoundsActive = this._playerBloomUvBoundsActive;
    u.playerBloomUvMin[0] = this._playerBloomUvMinScratch[0];
    u.playerBloomUvMin[1] = this._playerBloomUvMinScratch[1];
    u.playerBloomUvMax[0] = this._playerBloomUvMaxScratch[0];
    u.playerBloomUvMax[1] = this._playerBloomUvMaxScratch[1];
    comp.updateUniforms(u);
  }

  /**
   * UV rectangle in the same space as composite sampleUv (full albedo RT, including overscan pad).
   * Suppresses placed/held torch bloom inside the box so the small HDR bloom kernel cannot sit
   * on top of the local player when the RT mask misses soft sprite edges.
   */
  setLocalPlayerBloomUvBounds(
    active: boolean,
    minU: number,
    minV: number,
    maxU: number,
    maxV: number,
  ): void {
    this._playerBloomUvBoundsActive = active;
    this._playerBloomUvMinScratch[0] = minU;
    this._playerBloomUvMinScratch[1] = minV;
    this._playerBloomUvMaxScratch[0] = maxU;
    this._playerBloomUvMaxScratch[1] = maxV;
  }

  setCompositeViewportMapping(params: {
    viewWidth: number;
    viewHeight: number;
    renderWidth: number;
    renderHeight: number;
    overscanPadPx: number;
  }): void {
    const renderW = Math.max(1, Math.round(params.renderWidth));
    const renderH = Math.max(1, Math.round(params.renderHeight));
    const viewW = Math.max(1, Math.round(params.viewWidth));
    const viewH = Math.max(1, Math.round(params.viewHeight));
    const u = this._compositeU;
    u.uvBaseOffset[0] = params.overscanPadPx / renderW;
    u.uvBaseOffset[1] = params.overscanPadPx / renderH;
    u.uvScale[0] = viewW / renderW;
    u.uvScale[1] = viewH / renderH;
  }

  /** Sparse emissive positions for one chunk; cached until block edits or region prune. */
  private _getChunkEmitterPositions(
    world: World,
    cx: number,
    cy: number,
  ): { wx: number[]; wy: number[] } {
    const key = chunkKey(cx, cy);
    const hit = this._emitterChunkCache.get(key);
    if (hit !== undefined) {
      return hit;
    }
    const wx: number[] = [];
    const wy: number[] = [];
    const chunk = world.getChunk(cx, cy);
    if (chunk !== undefined) {
      const wxBase = cx * CHUNK_SIZE;
      const wyBase = cy * CHUNK_SIZE;
      for (let ly = 0; ly < CHUNK_SIZE; ly++) {
        for (let lx = 0; lx < CHUNK_SIZE; lx++) {
          const fgId = getBlock(chunk, lx, ly);
          const bgId = getBackground(chunk, lx, ly);
          if (
            world.getLightEmissionForBlockId(fgId) <= 0 &&
            world.getLightEmissionForBlockId(bgId) <= 0
          ) {
            continue;
          }
          wx.push(wxBase + lx);
          wy.push(wyBase + ly);
        }
      }
    }
    const entry = { wx, wy };
    this._emitterChunkCache.set(key, entry);
    return entry;
  }

  private _torchHeapReset(): void {
    this._torchHeapSize = 0;
  }

  private _torchHeapSwap(a: number, b: number): void {
    const h = this._torchHeapWx;
    const hy = this._torchHeapWy;
    const hs = this._torchHeapStrength;
    const hd = this._torchHeapD2;
    let t = h[a]!;
    h[a] = h[b]!;
    h[b] = t;
    t = hy[a]!;
    hy[a] = hy[b]!;
    hy[b] = t;
    t = hs[a]!;
    hs[a] = hs[b]!;
    hs[b] = t;
    t = hd[a]!;
    hd[a] = hd[b]!;
    hd[b] = t;
  }

  private _torchHeapSiftUp(i: number): void {
    const hd = this._torchHeapD2;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (hd[i]! <= hd[p]!) {
        break;
      }
      this._torchHeapSwap(i, p);
      i = p;
    }
  }

  private _torchHeapSiftDown(i: number): void {
    const sz = this._torchHeapSize;
    const hd = this._torchHeapD2;
    while (true) {
      const l = i * 2 + 1;
      const r = l + 1;
      let largest = i;
      if (l < sz && hd[l]! > hd[largest]!) {
        largest = l;
      }
      if (r < sz && hd[r]! > hd[largest]!) {
        largest = r;
      }
      if (largest === i) {
        break;
      }
      this._torchHeapSwap(i, largest);
      i = largest;
    }
  }

  /** Max-heap of up to K smallest dist² (root holds the worst among the kept set). */
  private _torchHeapOffer(wx: number, wy: number, strength: number, d2: number): void {
    const h = this._torchHeapWx;
    const hy = this._torchHeapWy;
    const hs = this._torchHeapStrength;
    const hd = this._torchHeapD2;
    const cap = MAX_PLACED_TORCHES;
    let sz = this._torchHeapSize;
    if (sz < cap) {
      h[sz] = wx;
      hy[sz] = wy;
      hs[sz] = strength;
      hd[sz] = d2;
      sz += 1;
      this._torchHeapSize = sz;
      this._torchHeapSiftUp(sz - 1);
      return;
    }
    if (d2 >= hd[0]!) {
      return;
    }
    h[0] = wx;
    hy[0] = wy;
    hs[0] = strength;
    hd[0] = d2;
    this._torchHeapSiftDown(0);
  }

  private _fillPlacedTorchUniforms(u: CompositeUniforms): void {
    const h = this._torchHeapWx;
    const hy = this._torchHeapWy;
    const hs = this._torchHeapStrength;
    const sz = this._torchHeapSize;
    const triplets = this._placedTorchTriples;
    for (let i = 0; i < sz; i++) {
      const p = triplets[i]!;
      p[0] = h[i]!;
      p[1] = hy[i]!;
      p[2] = hs[i]!;
    }
    // Do not set triplets.length = sz — truncating removes slots and causes undefined on the next frame.
    u.placedTorchCount = sz;
    u.placedTorches = triplets;
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
    this._emitterBlockUnsub();
    this._emitterBulkUnsub();
    for (const tex of this._textures.values()) {
      tex.destroy();
    }
    this._textures.clear();
    this._dirty.clear();
    this._emitterChunkCache.clear();
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
