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
import { feetAabbOverlapsWater } from "./feetAabbOverlapsWater";
import { MobManager } from "./mobs/MobManager";
import { MobType } from "./mobs/mobTypes";
import {
  DUCK_DEATH_ANIM_SEC,
  DUCK_FEET_SPRITE_NUDGE_Y_PX,
  DUCK_HEIGHT_PX,
  DUCK_IDLE_FRAMES,
  DUCK_MAX_HEALTH,
  DUCK_SPRITE_IDLE_FOLDER_REL,
  DUCK_SPRITE_WALK_FOLDER_REL,
  DUCK_WALK_FRAMES,
  DUCK_WIDTH_PX,
  PIG_BODY_TRIM_TARGET_PX,
  PIG_DEATH_ANIM_SEC,
  PIG_FEET_SPRITE_NUDGE_Y_PX,
  PIG_HEIGHT_PX,
  PIG_IDLE_FRAMES,
  PIG_MAX_HEALTH,
  PIG_RENDER_SCALE_MULT,
  PIG_SPRITE_IDLE_FOLDER_REL,
  PIG_SPRITE_WALK_FOLDER_REL,
  PIG_VISUAL_FEET_DROP_PX,
  PIG_WALK_FRAMES,
  PIG_WIDTH_PX,
  PASSIVE_MOB_TEXEL_SCREEN_SCALE,
  SLIME_ATTACK_FRAMES,
  SLIME_ATTACK_SWING_VISUAL_SEC,
  SLIME_DEATH_ANIM_SEC,
  SLIME_FEET_SPRITE_NUDGE_Y_PX,
  SLIME_FRAME_TEXEL,
  SLIME_VISUAL_FEET_DROP_PX,
  SLIME_HEIGHT_PX,
  SLIME_IDLE_FRAMES,
  SLIME_JUMP_FRAMES,
  SLIME_JUMP_PRIME_SEC,
  SLIME_MAX_HEALTH,
  SLIME_RENDER_SCALE_MULT,
  SLIME_SPRITE_ATTACK_FOLDER_REL,
  SLIME_SPRITE_IDLE_FOLDER_REL,
  SLIME_SPRITE_JUMP_FOLDER_REL,
  SLIME_WIDTH_PX,
  SHEEP_BODY_TRIM_TARGET_PX,
  SHEEP_DEATH_ANIM_SEC,
  SHEEP_FEET_SPRITE_NUDGE_Y_PX,
  SHEEP_HEIGHT_PX,
  SHEEP_MAX_HEALTH,
  SHEEP_WIDTH_PX,
  ZOMBIE_DEATH_ANIM_SEC,
  ZOMBIE_FEET_SPRITE_NUDGE_Y_PX,
  ZOMBIE_HEIGHT_PX,
  ZOMBIE_MAX_HEALTH,
  ZOMBIE_SPRITE_REL,
  ZOMBIE_WIDTH_PX,
  mobDeathTipOverTiltRad,
  SHEEP_RENDER_SCALE_MULT,
  SHEEP_IDLE_FRAMES,
  SHEEP_MASK_SPRITE_REL,
  SHEEP_SPRITE_REL,
  SHEEP_WALK_FRAMES,
} from "./mobs/mobConstants";
import { getSheepWoolTintHex } from "./mobs/sheepWool";
import { createSlimeGelAlphaFilter } from "./mobs/slimeGelAlphaFilter";

/** Slime `woolColor` wire field: 0 green (untinted art), 1–3 warm/cool/red multipliers. */
function slimeVariantBodyTint(slimeWireColor: number): number {
  const c =
    slimeWireColor <= 0 ? 0 : slimeWireColor >= 3 ? 3 : Math.floor(slimeWireColor);
  switch (c) {
    case 1:
      return 0xffe878;
    case 2:
      return 0x73c4ff;
    case 3:
      return 0xff6b6b;
    default:
      return 0xffffff;
  }
}
import type { AudioEngine } from "../audio/AudioEngine";
import {
  ARROW_SPRITE_TIP_ANGLE_AT_ZERO_ROT_RAD,
  BLOCK_SIZE,
  bowDrawItemTextureName,
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
  PLAYER_HELD_ITEM_JUMP_NUDGE_X_PX,
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
  PLAYER_HELD_BOW_TEXTURE_AIM_AXIS_AT_ZERO_ROT_RAD,
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
  PLAYER_WATER_WALK_ANIM_SPEED_MULT,
  PLAYER_WIDTH,
  REACH_BLOCKS,
  BOW_MAX_DRAW_SEC,
  ENTITY_SWIM_VISUAL_SINK_PX,
  DEFAULT_SKIN_ID,
} from "../core/constants";
import { stratumCoreTextureAssetUrl } from "../core/textureManifest";
import type { SkinTextureSet } from "../skins/skinTypes";
import {
  resolveBuiltinSkinUrl,
  parseSkinId,
} from "../skins/SkinRegistry";
import type { EventBus } from "../core/EventBus";
import { getReachLineGeometry } from "../input/aimDirection";
import type { InputManager } from "../input/InputManager";
import type { ItemId } from "../core/itemDefinition";
import type { ItemRegistry } from "../items/ItemRegistry";
import type { ArmorSlot } from "../items/PlayerInventory";
import type { AtlasLoader } from "../renderer/AtlasLoader";
import type { RenderPipeline } from "../renderer/RenderPipeline";
import type { BlockRegistry } from "../world/blocks/BlockRegistry";
import type { World } from "../world/World";
import type { DoorPlayerSample } from "../world/door/doorWorld";
import { getSolidAABBs } from "./physics/Collision";
import { createAABB, sweepAABB, type AABB } from "./physics/AABB";
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

export type WaterRippleBodySample = {
  id: string;
  feetX: number;
  feetY: number;
  vx: number;
  vy: number;
  inWater: boolean;
};

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

/**
 * Loads `sprite-1-{1…n}.png` from a folder under Stratum textures (`relativeFolder` has no trailing slash).
 */
async function loadSlimeSpriteFolderStrip(
  relativeFolder: string,
  frameCount: number,
): Promise<Texture[] | null> {
  const urls = Array.from({ length: frameCount }, (_, i) =>
    stratumCoreTextureAssetUrl(`${relativeFolder}/sprite-1-${i + 1}.png`),
  );
  try {
    const strip: Texture[] = [];
    for (const url of urls) {
      const tex = (await Assets.load<Texture>(url)) ?? Assets.get<Texture>(url);
      if (tex === undefined || tex.source === undefined) {
        return null;
      }
      tex.source.scaleMode = "nearest";
      tex.source.autoGenerateMipmaps = false;
      strip.push(tex);
    }
    return strip;
  } catch {
    return null;
  }
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

/**
 * Composite the base sheep sprite frame with the tinted wool overlay into a
 * single texture suitable for death-bit fragments.  Uses canvas multiply
 * composite so the fragments carry the sheep's body art with wool coloring
 * baked in, instead of flat-colored mask fragments.
 */
function compositeSheepTextureForDeathBits(
  baseTexture: Texture,
  woolTexture: Texture,
  woolTintHex: number,
): Texture | null {
  const baseRes = baseTexture.source?.resource as CanvasImageSource | undefined;
  const woolRes = woolTexture.source?.resource as CanvasImageSource | undefined;
  if (baseRes === undefined || woolRes === undefined) {
    return null;
  }
  const bf = baseTexture.frame;
  const wf = woolTexture.frame;
  const fw = Math.floor(bf.width);
  const fh = Math.floor(bf.height);
  if (fw < 2 || fh < 2) {
    return null;
  }
  const canvas = document.createElement("canvas");
  canvas.width = fw;
  canvas.height = fh;
  const ctx = canvas.getContext("2d");
  if (ctx === null) {
    return null;
  }
  ctx.drawImage(baseRes, bf.x, bf.y, bf.width, bf.height, 0, 0, fw, fh);

  const woolCanvas = document.createElement("canvas");
  woolCanvas.width = fw;
  woolCanvas.height = fh;
  const woolCtx = woolCanvas.getContext("2d");
  if (woolCtx === null) {
    return null;
  }
  woolCtx.drawImage(woolRes, wf.x, wf.y, wf.width, wf.height, 0, 0, fw, fh);

  // Replace white with the tint color, preserving alpha.
  woolCtx.globalCompositeOperation = "source-in";
  const r = (woolTintHex >> 16) & 0xff;
  const g = (woolTintHex >> 8) & 0xff;
  const b = woolTintHex & 0xff;
  woolCtx.fillStyle = `rgb(${r},${g},${b})`;
  woolCtx.fillRect(0, 0, fw, fh);

  ctx.globalCompositeOperation = "multiply";
  ctx.drawImage(woolCanvas, 0, 0);

  // Restore base alpha — canvas multiply can bleed the alpha channel, so
  // re-stamp the original base alpha onto the composited result.
  const baseCtx = document.createElement("canvas");
  baseCtx.width = fw;
  baseCtx.height = fh;
  const bCtx = baseCtx.getContext("2d");
  if (bCtx !== null) {
    bCtx.drawImage(baseRes, bf.x, bf.y, bf.width, bf.height, 0, 0, fw, fh);
    ctx.globalCompositeOperation = "destination-in";
    ctx.drawImage(baseCtx, 0, 0);
  }

  const tex = Texture.from(canvas);
  if (tex.source !== undefined) {
    tex.source.scaleMode = "nearest";
  }
  return tex;
}

async function tryUnloadAssetUrls(urls: readonly string[]): Promise<void> {
  const keys = urls.filter((u) => Assets.cache.has(u));
  if (keys.length === 0) {
    return;
  }
  try {
    await Assets.unload(keys);
  } catch {
    // Resolver/cache can be inconsistent during teardown.
  }
}

/** Textures not owned by {@link Assets} (e.g. `Texture.from(canvas)`). */
function destroyOwnedTextureList(textures: Texture[] | null): void {
  if (textures === null) {
    return;
  }
  for (const t of textures) {
    t.destroy(true);
  }
}

/**
 * Drop atlas slice textures and unload the backing image from Pixi Assets.
 * Slices share the Assets-managed sheet {@link TextureSource}; do not destroy it via `destroy(true)`.
 */
function releaseSlicedAssetTextures(
  slices: Texture[] | null,
  sheetAssetUrl: string,
): void {
  if (slices === null) return;
  for (const t of slices) {
    t.destroy(false);
  }
  void tryUnloadAssetUrls([sheetAssetUrl]);
}

function releaseSlimeFolderStripAssets(
  relativeFolder: string,
  frameCount: number,
): void {
  const urls = Array.from({ length: frameCount }, (_, i) =>
    stratumCoreTextureAssetUrl(`${relativeFolder}/sprite-1-${i + 1}.png`),
  );
  void tryUnloadAssetUrls(urls);
}

function releaseAllSlimeSpriteAssetTextures(): void {
  releaseSlimeFolderStripAssets(SLIME_SPRITE_IDLE_FOLDER_REL, SLIME_IDLE_FRAMES);
  releaseSlimeFolderStripAssets(SLIME_SPRITE_JUMP_FOLDER_REL, SLIME_JUMP_FRAMES);
  releaseSlimeFolderStripAssets(SLIME_SPRITE_ATTACK_FOLDER_REL, SLIME_ATTACK_FRAMES);
}

function releaseAllDuckSpriteAssetTextures(): void {
  releaseSlimeFolderStripAssets(DUCK_SPRITE_IDLE_FOLDER_REL, DUCK_IDLE_FRAMES);
  releaseSlimeFolderStripAssets(DUCK_SPRITE_WALK_FOLDER_REL, DUCK_WALK_FRAMES);
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

/**
 * Load a player body sprite sheet from a URL, slice it, and return a full
 * {@link SkinTextureSet}. Returns `null` on any load / validation failure.
 */
async function loadSkinTextureSet(
  sheetUrl: string,
): Promise<SkinTextureSet | null> {
  const rects =
    (await tryFetchPlayerBodyAtlasRects()) ?? PLAYER_BODY_ATLAS_FRAMES;
  const sheet =
    (await Assets.load<Texture>(sheetUrl)) ?? Assets.get<Texture>(sheetUrl);
  if (
    sheet === undefined ||
    sheet === Texture.EMPTY ||
    sheet.source === undefined
  ) {
    return null;
  }
  sheet.source.scaleMode = "nearest";
  sheet.source.autoGenerateMipmaps = false;
  const frames = sliceBodyFrames(sheet, rects);
  if (frames.length < PLAYER_BODY_REQUIRED_FRAME_COUNT) {
    return null;
  }
  const idleTex = frames[PLAYER_BODY_IDLE_FRAME_INDEX];
  if (idleTex === undefined) {
    return null;
  }
  const cycle: Texture[] = [];
  for (const idx of PLAYER_BODY_WALK_CYCLE_INDICES) {
    const t = frames[idx];
    if (t === undefined) {
      return null;
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
    return null;
  }

  let maxW = 0;
  let maxH = 0;
  for (const f of frames) {
    maxW = Math.max(maxW, f.width);
    maxH = Math.max(maxH, f.height);
  }
  if (maxW <= 0 || maxH <= 0) {
    return null;
  }
  const scale =
    Math.min(PLAYER_WIDTH / maxW, PLAYER_HEIGHT / maxH) *
    PLAYER_SPRITE_SCALE_MULTIPLIER;

  return {
    frames,
    idle: [idleTex],
    walk: cycle,
    jumpUp: [jumpUpTex],
    jumpDown: [jumpDownTex],
    skid: [miningTex],
    breaking: [idleTex, miningTex],
    scale,
  };
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
  feetInWater: boolean,
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
    const waterMult = feetInWater ? PLAYER_WATER_WALK_ANIM_SPEED_MULT : 1;
    sprite.animationSpeed =
      (sprinting
        ? PLAYER_WALK_ANIM_SPEED * PLAYER_SPRINT_ANIM_SPEED_MULT
        : PLAYER_WALK_ANIM_SPEED) * waterMult;
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
  feetInWater: boolean,
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
    feetInWater,
  );
}

/** Which atlas column (0–6) the body {@link AnimatedSprite} is showing for this frame. */
function resolvePlayerBodyAtlasFrameIndex(
  anim: AnimatedSprite,
  idle: Texture[] | null,
  cycle: Texture[] | null,
  jumpUp: Texture[] | null,
  jumpDown: Texture[] | null,
  breaking: Texture[] | null,
  skid: Texture[] | null,
  atlasFrames: Texture[] | null,
): number {
  const t = anim.textures;
  const cf = anim.currentFrame;
  if (breaking !== null && t === breaking) {
    return cf === 1
      ? PLAYER_BODY_MINING_FRAME_INDEX
      : PLAYER_BODY_IDLE_FRAME_INDEX;
  }
  if (jumpUp !== null && t === jumpUp) {
    return PLAYER_BODY_JUMP_UP_FRAME_INDEX;
  }
  if (jumpDown !== null && t === jumpDown) {
    return PLAYER_BODY_JUMP_DOWN_FRAME_INDEX;
  }
  if (skid !== null && t === skid) {
    return PLAYER_BODY_MINING_FRAME_INDEX;
  }
  if (cycle !== null && t === cycle) {
    return PLAYER_BODY_WALK_CYCLE_INDICES[cf] ?? PLAYER_BODY_IDLE_FRAME_INDEX;
  }
  if (idle !== null && t === idle) {
    return PLAYER_BODY_IDLE_FRAME_INDEX;
  }
  if (atlasFrames !== null) {
    const tex = anim.texture;
    const idx = atlasFrames.findIndex((f) => f === tex);
    if (idx >= 0) {
      return idx;
    }
  }
  return PLAYER_BODY_IDLE_FRAME_INDEX;
}

/** Local player sheep: base sprite + optional wool overlay (white silhouette × tint, no mask). */
type SheepRig = {
  root: Container;
  base: AnimatedSprite;
  wool: AnimatedSprite | null;
  hpBar: Graphics;
};

type PigRig = {
  root: Container;
  base: AnimatedSprite;
  hpBar: Graphics;
};

type DuckRig = {
  root: Container;
  /** One texture per frame to keep duck feet stable like slime. */
  base: Sprite;
  hpBar: Graphics;
};

type SlimeRig = {
  root: Container;
  /** One texture per frame — avoids multi-frame batch bleed from {@link AnimatedSprite}. */
  base: Sprite;
  hpBar: Graphics;
};

type DuckClientAnim = {
  walkAccumSec: number;
};

const SLIME_LAND_STEP_SEC = 0.11;

type SlimeClientAnim = {
  prevOnGround: boolean;
  landRemainSec: number;
  primeLocalSec: number;
  wasPriming: boolean;
  wasAttacking: boolean;
  attackElapsedSec: number;
  airPhaseAccum: number;
  /** Soft idle wobble phase for jelly-like motion (radians/sec scaled in sync). */
  jellyWobblePhase: number;
};

type ZombieRig = {
  root: Container;
  base: AnimatedSprite;
  fire: AnimatedSprite;
  hpBar: Graphics;
};

type DeathBit = {
  sprite: Sprite;
  fragmentTexture: Texture;
  vx: number;
  vy: number;
  gravity: number;
  rotVel: number;
  lifeSec: number;
  ageSec: number;
  grounded: boolean;
  bounces: number;
  rollRadiusPx: number;
};

const MOB_HIT_HEALTH_BAR_SHOW_SEC = 2;
const DEATH_BITS_PER_MOB = 4;
const DEATH_BITS_MIN_LIFE_SEC = 1.35;
const DEATH_BITS_MAX_LIFE_SEC = 2.05;
const DEATH_BITS_SETTLE_BEFORE_FADE_SEC = 0.55;
const DEATH_BITS_BOUNCE = 0.24;
const DEATH_BITS_WALL_BOUNCE = 0.18;
const DEATH_BITS_GROUND_FRICTION = 0.84;
const DEATH_BITS_AIR_DRAG = 0.988;
const DEATH_BITS_ROLL_DAMP = 0.93;
const DEATH_BITS_GROUND_STOP_SPEED = 7.5;
const DEATH_BITS_MAX_BOUNCES = 2;
const DEATH_BITS_MIN_COUNT = 4;
const DEATH_BITS_MAX_COUNT = 16;

function darkenHexColor(color: number, amount: number): number {
  const t = Math.min(1, Math.max(0, amount));
  const r = (color >> 16) & 0xff;
  const g = (color >> 8) & 0xff;
  const b = color & 0xff;
  const rr = Math.max(0, Math.round(r * (1 - t)));
  const gg = Math.max(0, Math.round(g * (1 - t)));
  const bb = Math.max(0, Math.round(b * (1 - t)));
  return (rr << 16) | (gg << 8) | bb;
}

function mobFootprintPx(mobType: MobType): { width: number; height: number } {
  switch (mobType) {
    case MobType.Sheep:
      return { width: SHEEP_WIDTH_PX, height: SHEEP_HEIGHT_PX };
    case MobType.Pig:
      return { width: PIG_WIDTH_PX, height: PIG_HEIGHT_PX };
    case MobType.Duck:
      return { width: DUCK_WIDTH_PX, height: DUCK_HEIGHT_PX };
    case MobType.Slime:
      return { width: SLIME_WIDTH_PX, height: SLIME_HEIGHT_PX };
    case MobType.Zombie:
      return { width: ZOMBIE_WIDTH_PX, height: ZOMBIE_HEIGHT_PX };
    default:
      return { width: BLOCK_SIZE, height: BLOCK_SIZE };
  }
}

function deathBitsCountForMob(mobType: MobType): number {
  const footprint = mobFootprintPx(mobType);
  const areaInBlocks = (footprint.width * footprint.height) / (BLOCK_SIZE * BLOCK_SIZE);
  const raw = Math.round(3 + areaInBlocks * 4.8);
  return Math.max(DEATH_BITS_MIN_COUNT, Math.min(DEATH_BITS_MAX_COUNT, raw));
}

function diceTextureIntoUniqueFragments(texture: Texture, requestedCount: number): Texture[] {
  const source = texture.source;
  const frame = texture.frame;
  if (source === undefined || frame === undefined) {
    return [];
  }
  const frameW = Math.max(1, Math.floor(frame.width));
  const frameH = Math.max(1, Math.floor(frame.height));
  if (frameW < 2 || frameH < 2) {
    return [];
  }
  const targetCount = Math.max(1, requestedCount);
  const cellPx = Math.max(
    2,
    Math.floor(Math.sqrt((frameW * frameH) / targetCount)),
  );
  const cols = Math.max(1, Math.ceil(frameW / cellPx));
  const rows = Math.max(1, Math.ceil(frameH / cellPx));
  const allCells: Rectangle[] = [];
  for (let cy = 0; cy < rows; cy += 1) {
    for (let cx = 0; cx < cols; cx += 1) {
      const x = cx * cellPx;
      const y = cy * cellPx;
      const w = Math.min(cellPx, frameW - x);
      const h = Math.min(cellPx, frameH - y);
      if (w > 0 && h > 0) {
        allCells.push(new Rectangle(frame.x + x, frame.y + y, w, h));
      }
    }
  }
  for (let i = allCells.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = allCells[i]!;
    allCells[i] = allCells[j]!;
    allCells[j] = tmp;
  }
  const out: Texture[] = [];
  const take = Math.min(targetCount, allCells.length);
  for (let i = 0; i < take; i += 1) {
    const cell = allCells[i]!;
    out.push(
      new Texture({
        source,
        frame: cell,
      }),
    );
  }
  return out;
}

function drawMobHealthBar(
  bar: Graphics,
  hp: number,
  maxHp: number,
  alpha: number,
  y: number,
  parentScaleX: number,
  parentScaleY: number,
): void {
  const w = Math.round(BLOCK_SIZE * 1.5);
  const h = 4;
  const clampedMax = Math.max(1, maxHp);
  const ratio = Math.max(0, Math.min(1, hp / clampedMax));
  const sx = Math.abs(parentScaleX) > 0.0001 ? Math.abs(parentScaleX) : 1;
  const sy = Math.abs(parentScaleY) > 0.0001 ? Math.abs(parentScaleY) : 1;
  const rr = Math.round(255 * (1 - ratio));
  const gg = Math.round(255 * ratio);
  const fillColor = (rr << 16) | (gg << 8) | 0x30;
  bar.clear();
  // Counter parent scaling so health bars stay crisp in screen pixels.
  bar.scale.set(1 / sx, 1 / sy);
  bar.position.set(Math.round((-w * 0.5) / sx), Math.round((y - 7) / sy));
  bar.alpha = Math.max(0, Math.min(1, alpha));
  // Pixel-rounded silhouette: 1px corner cutouts (no vector smoothing).
  bar.rect(1, 0, Math.max(0, w - 2), h).fill({ color: 0x121212, alpha: 1 });
  if (h > 2) {
    bar.rect(0, 1, w, h - 2).fill({ color: 0x121212, alpha: 1 });
  }
  if (ratio > 0) {
    const fillW = Math.max(1, Math.round(w * ratio));
    if (fillW <= 2 || h <= 2) {
      bar.rect(0, 0, fillW, h).fill({ color: fillColor, alpha: 1 });
    } else {
      bar.rect(1, 0, Math.max(0, fillW - 2), h).fill({
        color: fillColor,
        alpha: 1,
      });
      bar.rect(0, 1, fillW, h - 2).fill({ color: fillColor, alpha: 1 });
    }
  }
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
  /** Currently loaded local skin id (serialised, e.g. `"explorer_bob"` or `"custom:uuid"`). */
  private localSkinId: string | null = null;
  /** Per-peer skin texture sets for remote players. */
  private readonly remoteSkinTextures = new Map<string, SkinTextureSet>();
  private aimGraphic: Graphics | null = null;
  private aimLineSprite: Sprite | null = null;
  private readonly remoteGraphics = new Map<string, Container>();
  /** Per-peer armor overlay sprites (destroyed with remote root; map cleared on peer removal). */
  private readonly remoteArmorSprites = new Map<string, (Sprite | null)[]>();
  private readonly droppedSprites = new Map<string, Sprite>();
  private readonly arrowSprites = new Map<string, Sprite>();
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
  private duckWalkTextures: Texture[] | null = null;
  private duckIdleTextures: Texture[] | null = null;
  private readonly duckSprites = new Map<number, DuckRig>();
  private readonly duckClientAnim = new Map<number, DuckClientAnim>();
  private slimeJumpPrimeTextures: Texture[] | null = null;
  private slimeJumpAirTextures: Texture[] | null = null;
  private slimeIdleTextures: Texture[] | null = null;
  private slimeAttackTextures: Texture[] | null = null;
  private readonly slimeSprites = new Map<number, SlimeRig>();
  private readonly slimeClientAnim = new Map<number, SlimeClientAnim>();
  /** Reuses sliced player body textures (see {@link hydrateZombieTexturesFromPlayerBody}). */
  private zombieWalkTextures: Texture[] | null = null;
  private zombieIdleTextures: Texture[] | null = null;
  private zombieJumpTextures: Texture[] | null = null;
  private zombieAttackTextures: Texture[] | null = null;
  private zombieFireTextures: Texture[] | null = null;
  private zombieFirePhase = 0;
  // Zombies now match the player's base scale (see `syncZombieSprites`).
  private readonly zombieSprites = new Map<number, ZombieRig>();
  /**
   * Local-only: remaining seconds to show mob HP bar after this client dealt damage
   * (`MOB_HIT_FEEDBACK` / host melee); not driven by replicated `hurt`.
   */
  private readonly mobHitHealthBarRemainSec = new Map<number, number>();
  private readonly deathBits: DeathBit[] = [];
  private readonly deathBitsSpawned = new Set<string>();
  private readonly deathBitSolidScratch: AABB[] = [];

  /** Sliced iron armor overlay frames (same layout as {@link PLAYER_BODY_ATLAS_FRAMES}); null if asset missing. */
  private ironArmorHelmetFrames: Texture[] | null = null;
  private ironArmorChestplateFrames: Texture[] | null = null;
  private ironArmorLeggingsFrames: Texture[] | null = null;
  private ironArmorBootsFrames: Texture[] | null = null;
  /** Sliced gold armor overlay frames (same layout as {@link PLAYER_BODY_ATLAS_FRAMES}); null if asset missing. */
  private goldArmorHelmetFrames: Texture[] | null = null;
  private goldArmorChestplateFrames: Texture[] | null = null;
  private goldArmorLeggingsFrames: Texture[] | null = null;
  private goldArmorBootsFrames: Texture[] | null = null;
  private localArmorSprites: (Sprite | null)[] = [null, null, null, null];

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
    void this.loadSheepSprites();
    void this.loadPigSprites();
    void this.loadDuckSprites();
    void this.loadSlimeSprites();
    void this.loadZombieSprites();
    void this.loadZombieFireOverlay();
    void this.loadArmorTextures();

    // Remote players are added lazily in syncPlayerGraphic when their state appears in World.
  }

  private releaseArmorOverlayTextures(material: "iron" | "gold"): void {
    const folder = `entities/armor_overlay/${material}`;
    const helmetFrames =
      material === "iron" ? this.ironArmorHelmetFrames : this.goldArmorHelmetFrames;
    const chestplateFrames =
      material === "iron"
        ? this.ironArmorChestplateFrames
        : this.goldArmorChestplateFrames;
    const leggingsFrames =
      material === "iron"
        ? this.ironArmorLeggingsFrames
        : this.goldArmorLeggingsFrames;
    const bootsFrames =
      material === "iron" ? this.ironArmorBootsFrames : this.goldArmorBootsFrames;
    releaseSlicedAssetTextures(
      helmetFrames,
      stratumCoreTextureAssetUrl(`${folder}/${material}_helmet.png`),
    );
    releaseSlicedAssetTextures(
      chestplateFrames,
      stratumCoreTextureAssetUrl(`${folder}/${material}_chestplate.png`),
    );
    releaseSlicedAssetTextures(
      leggingsFrames,
      stratumCoreTextureAssetUrl(`${folder}/${material}_leggings.png`),
    );
    releaseSlicedAssetTextures(
      bootsFrames,
      stratumCoreTextureAssetUrl(`${folder}/${material}_boots.png`),
    );
  }

  private async loadArmorTextures(): Promise<void> {
    const clearArmorFrames = (): void => {
      this.releaseArmorOverlayTextures("iron");
      this.releaseArmorOverlayTextures("gold");
      this.ironArmorHelmetFrames = null;
      this.ironArmorChestplateFrames = null;
      this.ironArmorLeggingsFrames = null;
      this.ironArmorBootsFrames = null;
      this.goldArmorHelmetFrames = null;
      this.goldArmorChestplateFrames = null;
      this.goldArmorLeggingsFrames = null;
      this.goldArmorBootsFrames = null;
    };
    try {
      const loadSliced = async (rel: string): Promise<Texture[] | null> => {
        const url = stratumCoreTextureAssetUrl(rel);
        const sheet = await Assets.load<Texture>(url).catch(() => null);
        if (
          sheet === null ||
          sheet === undefined ||
          sheet === Texture.EMPTY ||
          sheet.source === undefined
        ) {
          return null;
        }
        sheet.source.scaleMode = "nearest";
        sheet.source.autoGenerateMipmaps = false;
        const sheetWidth = Math.floor(sheet.width);
        const sheetHeight = Math.floor(sheet.height);
        if (
          !Number.isFinite(sheetWidth) ||
          !Number.isFinite(sheetHeight) ||
          sheetWidth <= 0 ||
          sheetHeight <= 0
        ) {
          return null;
        }
        const frameCount = PLAYER_BODY_REQUIRED_FRAME_COUNT;
        if (sheetWidth % frameCount !== 0) {
          return null;
        }
        const frameWidth = sheetWidth / frameCount;
        const armorRects = Array.from({ length: frameCount }, (_, i) => ({
          x: i * frameWidth,
          y: 0,
          w: frameWidth,
          h: sheetHeight,
        }));
        const frames = sliceAtlasFrames(sheet, armorRects);
        if (frames.length < PLAYER_BODY_REQUIRED_FRAME_COUNT) {
          releaseSlicedAssetTextures(
            frames.length > 0 ? frames : null,
            url,
          );
          return null;
        }
        return frames;
      };

      const [
        ironHelmetF,
        ironChestF,
        ironLegsF,
        ironBootsF,
        goldHelmetF,
        goldChestF,
        goldLegsF,
        goldBootsF,
      ] = await Promise.all([
        loadSliced("entities/armor_overlay/iron/iron_helmet.png"),
        loadSliced("entities/armor_overlay/iron/iron_chestplate.png"),
        loadSliced("entities/armor_overlay/iron/iron_leggings.png"),
        loadSliced("entities/armor_overlay/iron/iron_boots.png"),
        loadSliced("entities/armor_overlay/gold/gold_helmet.png"),
        loadSliced("entities/armor_overlay/gold/gold_chestplate.png"),
        loadSliced("entities/armor_overlay/gold/gold_leggings.png"),
        loadSliced("entities/armor_overlay/gold/gold_boots.png"),
      ]);

      clearArmorFrames();
      this.ironArmorHelmetFrames = ironHelmetF;
      this.ironArmorChestplateFrames = ironChestF;
      this.ironArmorLeggingsFrames = ironLegsF;
      this.ironArmorBootsFrames = ironBootsF;
      this.goldArmorHelmetFrames = goldHelmetF;
      this.goldArmorChestplateFrames = goldChestF;
      this.goldArmorLeggingsFrames = goldLegsF;
      this.goldArmorBootsFrames = goldBootsF;
    } catch {
      clearArmorFrames();
    }
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
    this.player.setMobOverlapCheck(
      manager !== null ? (aabb) => manager.anyMobOverlapsAABB(aabb) : null
    );
  }

  getPlayer(): Player {
    return this.player;
  }

  /** Host/solo: world pickup of stuck arrows uses this id. */
  tryGetArrowItemId(): ItemId | undefined {
    const d = this.itemRegistry.getByKey("stratum:arrow");
    return d === undefined ? undefined : (d.id as ItemId);
  }

  /** Route block break / place through host RPCs when true. */
  setMultiplayerTerrainClient(v: boolean): void {
    this.player.setMultiplayerTerrainClient(v);
  }

  /**
   * Show this mob’s HP bar briefly for the local client (melee hit, arrow stick, or
   * {@link MsgType.MOB_HIT_FEEDBACK}).
   */
  bumpMobHealthBar(mobEntityId: number): void {
    this.mobHitHealthBarRemainSec.set(
      mobEntityId,
      MOB_HIT_HEALTH_BAR_SHOW_SEC,
    );
  }

  /** Pose extras for `PLAYER_STATE` / host snapshots (matches local held + mining body logic). */
  getLocalPlayerNetworkPoseExtras(): {
    hotbarSlot: number;
    heldItemId: number;
    miningVisual: boolean;
    armorHelmetId: number;
    armorChestId: number;
    armorLeggingsId: number;
    armorBootsId: number;
    bowDrawQuantized: number;
    aimDisplayX: number;
    aimDisplayY: number;
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
    const armorSlotId = (armSlot: ArmorSlot): number => {
      const ast = this.player.inventory.getArmorStack(armSlot);
      return ast !== null && ast.count > 0 ? ast.itemId : 0;
    };
    let bowDrawQuantized = 0;
    if (heldItemId !== 0) {
      const def = this.itemRegistry.getById(heldItemId as ItemId);
      if (def?.key === "stratum:bow") {
        bowDrawQuantized = Math.min(
          255,
          Math.max(0, Math.round((s.bowDrawSec / BOW_MAX_DRAW_SEC) * 255)),
        );
      }
    }
    const blocked = this.input.isWorldInputBlocked();
    const feetX = s.position.x;
    const feetY = s.position.y;
    const aimDisplayX = blocked
      ? feetX + (s.facingRight ? 140 : -140)
      : this.input.mouseWorldPos.x;
    const aimDisplayY = blocked ? feetY - 90 : this.input.mouseWorldPos.y;
    return {
      hotbarSlot: slot,
      heldItemId,
      miningVisual,
      armorHelmetId: armorSlotId(0),
      armorChestId: armorSlotId(1),
      armorLeggingsId: armorSlotId(2),
      armorBootsId: armorSlotId(3),
      bowDrawQuantized,
      aimDisplayX,
      aimDisplayY,
    };
  }

  collectWaterRippleBodies(alpha: number, nowMs: number): WaterRippleBodySample[] {
    const out: WaterRippleBodySample[] = [];
    const s = this.player.state;
    const localX = s.prevPosition.x + (s.position.x - s.prevPosition.x) * alpha;
    const localY = s.prevPosition.y + (s.position.y - s.prevPosition.y) * alpha;
    out.push({
      id: "player:local",
      feetX: localX,
      feetY: localY,
      vx: s.velocity.x,
      vy: s.velocity.y,
      inWater:
        s.deathAnimT === null &&
        !s.sleeping &&
        feetAabbOverlapsWater(this.world, localX, localY, PLAYER_WIDTH, PLAYER_HEIGHT),
    });
    for (const [peerId, rp] of this.world.getRemotePlayers()) {
      const d = rp.getDisplayPose(nowMs);
      out.push({
        id: `player:remote:${peerId}`,
        feetX: d.x,
        feetY: d.y,
        vx: d.vx,
        vy: d.vy,
        inWater: feetAabbOverlapsWater(this.world, d.x, d.y, PLAYER_WIDTH, PLAYER_HEIGHT),
      });
    }
    if (this.mobManager !== null) {
      for (const m of this.mobManager.getAll()) {
        let width = PLAYER_WIDTH;
        let height = PLAYER_HEIGHT;
        if (m.kind === "sheep") {
          width = SHEEP_WIDTH_PX;
          height = SHEEP_HEIGHT_PX;
        } else if (m.kind === "pig") {
          width = PIG_WIDTH_PX;
          height = PIG_HEIGHT_PX;
        } else if (m.kind === "duck") {
          width = DUCK_WIDTH_PX;
          height = DUCK_HEIGHT_PX;
        } else if (m.kind === "slime") {
          width = SLIME_WIDTH_PX;
          height = SLIME_HEIGHT_PX;
        } else if (m.kind === "zombie") {
          width = ZOMBIE_WIDTH_PX;
          height = ZOMBIE_HEIGHT_PX;
        }
        out.push({
          id: `mob:${m.id}`,
          feetX: m.x,
          feetY: m.y,
          vx: m.vx,
          vy: m.vy,
          inWater: feetAabbOverlapsWater(this.world, m.x, m.y, width, height),
        });
      }
    }
    return out;
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
      const feetInWater =
        deathT === null &&
        !s.sleeping &&
        feetAabbOverlapsWater(this.world, x, y, PLAYER_WIDTH, PLAYER_HEIGHT);
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
            feetInWater,
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
          const aimFx =
            s.prevPosition.x + (s.position.x - s.prevPosition.x) * alpha;
          const aimFy =
            s.prevPosition.y + (s.position.y - s.prevPosition.y) * alpha;
          this.syncHeldItemVisual(
            held,
            anim,
            s.facingRight,
            miningVisual,
            s.onGround,
            heldItemId,
            s.bowDrawSec,
            aimFx,
            aimFy,
            null,
          );
          }
        }

        // Sync armor overlay sprites
        this.syncLocalArmorOverlays(anim, s.facingRight, s.sleeping);

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
        this.remoteSkinTextures.delete(peerId);
        this.remoteArmorSprites.delete(peerId);
      }
    }
    for (const [peerId, rp] of remotePlayers) {
      let remoteRoot = this.remoteGraphics.get(peerId);
      if (remoteRoot === undefined) {
        const peerSkin = this.remoteSkinTextures.get(peerId);
        remoteRoot = this.createRemotePlayerRoot(peerSkin);
        const parent = this.playerGraphic?.parent;
        parent?.addChild(remoteRoot);
        this.remoteGraphics.set(peerId, remoteRoot);
        this.remoteWalkAnimMode.set(peerId, { v: "idle" });
        this.remoteSurfaceMode.set(peerId, { v: "ground" });
      }
      const disp = rp.getDisplayPose(nowMs);
      const remoteFeetInWater = feetAabbOverlapsWater(
        this.world,
        disp.x,
        disp.y,
        PLAYER_WIDTH,
        PLAYER_HEIGHT,
      );
      remoteRoot.position.set(disp.x - PLAYER_WIDTH / 2, -disp.y - PLAYER_HEIGHT);

      let remoteBody: AnimatedSprite | null = null;
      let remoteHeld: Sprite | null = null;
      for (const ch of remoteRoot.children) {
        if (ch instanceof AnimatedSprite) {
          remoteBody = ch;
        } else if (ch instanceof Sprite && ch.zIndex === -1) {
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
        const peerSkin = this.remoteSkinTextures.get(peerId);
        const idle = peerSkin?.idle ?? this.playerIdleAnimTextures;
        const cycle = peerSkin?.walk ?? this.playerWalkCycleTextures;
        const mode = this.remoteWalkAnimMode.get(peerId);
        let surf = this.remoteSurfaceMode.get(peerId);
        if (surf === undefined) {
          surf = { v: "ground" };
          this.remoteSurfaceMode.set(peerId, surf);
        }
        const jumpUp = peerSkin?.jumpUp ?? this.playerJumpUpAnimTextures;
        const jumpDown = peerSkin?.jumpDown ?? this.playerJumpDownAnimTextures;
        const breaking = peerSkin?.breaking ?? this.playerBreakingAnimTextures;
        const skid = peerSkin?.skid ?? this.playerSkidAnimTextures;
        const peerScale = peerSkin?.scale ?? this.playerSpriteBaseScale;
        const miningVisual =
          rp.miningVisualFromNetwork || rp.getBreakMining() !== null;
        if (idle !== null && cycle !== null && cycle.length > 0 && mode !== undefined) {
          syncPlayerBodyAnimation(
            body,
            onGroundApprox,
            moving,
            sprinting,
            disp.facingRight,
            peerScale,
            { idle, cycle, mode },
            sy,
            jumpUp,
            jumpDown,
            surf,
            breaking,
            miningVisual,
            false,
            skid,
            remoteFeetInWater,
          );
        }
        const breakingLoopActive =
          miningVisual &&
          breaking !== null &&
          breaking.length >= 2 &&
          body.textures === breaking;
        applyPlayerSpriteFeetPosition(
          body,
          peerScale,
          breakingLoopActive,
          disp.facingRight,
        );
        if (remoteHeld !== null) {
          const bowDrawSecRemote =
            (rp.bowDrawQuantized / 255) * BOW_MAX_DRAW_SEC;
          this.syncHeldItemVisual(
            remoteHeld,
            body,
            disp.facingRight,
            miningVisual,
            onGroundApprox,
            rp.heldItemId,
            bowDrawSecRemote,
            disp.x,
            disp.y,
            { x: rp.aimDisplayX, y: rp.aimDisplayY },
          );
        }
        this.syncRemoteArmorOverlays(
          peerId,
          remoteRoot,
          body,
          disp.facingRight,
          peerScale,
          [
            rp.armorHelmetId,
            rp.armorChestId,
            rp.armorLeggingsId,
            rp.armorBootsId,
          ],
          body.tint,
        );
      }
    }

    this.syncAimGraphic(alpha);
    this.syncDroppedItems(dtSec);
    this.syncArrowSprites(dtSec);
    this.syncSheepSprites(dtSec);
    this.syncPigSprites(dtSec);
    this.syncDuckSprites(dtSec);
    this.syncSlimeSprites(dtSec);
    this.syncZombieSprites(dtSec);
    this.syncDeathBits(dtSec);
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

  private syncArrowSprites(dtSec: number): void {
    void dtSec;
    const arrows = this.world.getArrows();
    const staleIds: string[] = [];
    for (const id of this.arrowSprites.keys()) {
      if (!arrows.has(id)) {
        staleIds.push(id);
      }
    }
    for (const id of staleIds) {
      const s = this.arrowSprites.get(id);
      if (s !== undefined) {
        s.parent?.removeChild(s);
        s.destroy();
      }
      this.arrowSprites.delete(id);
    }

    for (const [id, arrow] of arrows) {
      let sprite = this.arrowSprites.get(id);
      if (sprite === undefined) {
        const def = this.itemRegistry.getByKey("stratum:arrow");
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
        created.scale.set(0.55);
        const parent = this.playerGraphic?.parent;
        parent?.addChild(created);
        this.arrowSprites.set(id, created);
        sprite = created;
      }
      if (sprite === undefined) {
        continue;
      }
      // Sprite is at (worldX, -worldY); match reach-line convention Math.atan2(displayDy, displayDx).
      // Stuck arrows (mob/block): keep impact flight angle (`frozenRotationRad`). Feet→arrow is wrong
      // for mobs (that vector is mostly “up the body”, not along the shaft).
      const dx = arrow.x - arrow.prevX;
      const dyDisp = -(arrow.y - arrow.prevY);
      const motion2 = dx * dx + dyDisp * dyDisp;
      let ang =
        arrow.frozenRotationRad !== null
          ? arrow.frozenRotationRad
          : motion2 > 0.25
            ? Math.atan2(dyDisp, dx)
            : Math.atan2(arrow.vy, arrow.vx);
      if (arrow.isStuckInBlock() && arrow.stuckBlockFace === "side") {
        ang += Math.PI;
      }
      if (arrow.isStuckInMob() && this.mobManager !== null) {
        const m = this.mobManager.getById(arrow.stuckMobId);
        if (m !== undefined) {
          const tilt = mobDeathTipOverTiltRad(
            m.kind,
            m.facingRight,
            m.deathAnimRemainSec,
          );
          ang = arrow.stuckMobShaftWorldAngleRad(tilt, m.facingRight);
        }
      }
      // Tip art points ~SW at rotation 0 (see constant). Match `atan2` flight angle after atlas/anchor checks.
      sprite.rotation = ang - ARROW_SPRITE_TIP_ANGLE_AT_ZERO_ROT_RAD;
      sprite.position.set(arrow.x, -arrow.y);
    }
  }

  private deathBitsKey(mobType: MobType, id: number): string {
    return `${mobType}:${id}`;
  }

  private spawnDeathBitsIfNeeded(
    mobType: MobType,
    id: number,
    x: number,
    y: number,
    facingRight: boolean,
    killerFeetX: number | null,
    sourceTexture: Texture,
    baseTint: number,
  ): void {
    const key = this.deathBitsKey(mobType, id);
    if (this.deathBitsSpawned.has(key)) {
      return;
    }
    const parent = this.playerGraphic?.parent;
    if (parent === null || parent === undefined) {
      return;
    }
    this.deathBitsSpawned.add(key);
    const facingDir = facingRight ? 1 : -1;
    const footprint = mobFootprintPx(mobType);
    const sourceFrameW = Math.max(1, sourceTexture.frame.width);
    const sourceFrameH = Math.max(1, sourceTexture.frame.height);
    // Keep fragment size in lockstep with the source sprite's world-pixel scale.
    const worldPxPerTexel = Math.max(
      0.25,
      Math.min(footprint.width / sourceFrameW, footprint.height / sourceFrameH),
    );
    const halfW = footprint.width * 0.38;
    const halfH = footprint.height * 0.42;
    const centerX = x;
    const centerY = y - halfH * 0.95;
    const tintA = darkenHexColor(baseTint, 0.1);
    const tintB = darkenHexColor(baseTint, 0.28);
    const count = Math.max(DEATH_BITS_PER_MOB, deathBitsCountForMob(mobType));
    const diced = diceTextureIntoUniqueFragments(sourceTexture, count);
    for (let i = 0; i < diced.length; i += 1) {
      const fragmentTexture = diced[i]!;
      const bit = new Sprite(fragmentTexture);
      bit.anchor.set(0.5);
      bit.roundPixels = true;
      bit.zIndex = -1;
      bit.tint = i % 2 === 0 ? tintA : tintB;
      const bitScale = worldPxPerTexel;
      bit.scale.set(bitScale, bitScale);
      const offsetX = (Math.random() * 2 - 1) * halfW * 0.95;
      const offsetY = (Math.random() * 2 - 1) * halfH * 0.95;
      const awayDirX =
        killerFeetX !== null
          ? Math.sign(centerX - killerFeetX) || facingDir
          : facingDir;
      const spread = (Math.random() * 2 - 1) * 0.95;
      let nx = awayDirX * (0.9 + Math.random() * 0.7) + spread;
      let ny = -(0.75 + Math.random() * 0.95) + Math.abs(spread) * 0.16;
      const nLen = Math.hypot(nx, ny);
      if (nLen > 1e-5) {
        nx /= nLen;
        ny /= nLen;
      } else {
        nx = awayDirX;
        ny = -0.5;
      }
      bit.position.set(
        centerX + offsetX,
        centerY + offsetY,
      );
      parent.addChild(bit);
      const outwardSpeed = 145 + Math.random() * 135;
      const bitHalf = Math.max(bit.width, bit.height) * 0.5;
      this.deathBits.push({
        sprite: bit,
        fragmentTexture,
        vx: nx * outwardSpeed,
        vy: ny * outwardSpeed,
        gravity: 420 + Math.random() * 130,
        rotVel: ((Math.random() * 2 - 1) * 1.9 + Math.sign(nx) * 3.2),
        lifeSec:
          DEATH_BITS_MIN_LIFE_SEC +
          Math.random() * (DEATH_BITS_MAX_LIFE_SEC - DEATH_BITS_MIN_LIFE_SEC),
        ageSec: 0,
        grounded: false,
        bounces: 0,
        rollRadiusPx: Math.max(2, bitHalf),
      });
    }
  }

  private pruneDeathBitsSpawned(mobType: MobType, alive: ReadonlySet<number>): void {
    const prefix = `${mobType}:`;
    const stale: string[] = [];
    for (const key of this.deathBitsSpawned) {
      if (!key.startsWith(prefix)) {
        continue;
      }
      const idText = key.slice(prefix.length);
      const id = Number.parseInt(idText, 10);
      if (!Number.isFinite(id) || !alive.has(id)) {
        stale.push(key);
      }
    }
    for (const key of stale) {
      this.deathBitsSpawned.delete(key);
    }
  }

  private syncDeathBits(dtSec: number): void {
    if (this.deathBits.length === 0) {
      return;
    }
    for (let i = this.deathBits.length - 1; i >= 0; i -= 1) {
      const p = this.deathBits[i]!;
      p.ageSec += dtSec;
      const t = Math.min(1, p.ageSec / p.lifeSec);
      const stepCount = Math.max(1, Math.ceil(Math.min(0.05, dtSec) / (1 / 180)));
      const stepDt = dtSec / stepCount;
      for (let s = 0; s < stepCount; s += 1) {
        p.vy += p.gravity * stepDt;
        p.vx *= DEATH_BITS_AIR_DRAG;
        const halfW = Math.max(1, p.sprite.width * 0.5);
        const halfH = Math.max(1, p.sprite.height * 0.5);
        const mover = createAABB(
          p.sprite.position.x - halfW,
          p.sprite.position.y - halfH,
          halfW * 2,
          halfH * 2,
        );
        const dx = p.vx * stepDt;
        const dy = p.vy * stepDt;
        const query = createAABB(
          Math.min(mover.x, mover.x + dx) - 2,
          Math.min(mover.y, mover.y + dy) - 2,
          mover.width + Math.abs(dx) + 4,
          mover.height + Math.abs(dy) + 4,
        );
        getSolidAABBs(this.world, query, this.deathBitSolidScratch);
        const { hitX, hitY } = sweepAABB(mover, dx, dy, this.deathBitSolidScratch);
        p.sprite.position.set(mover.x + halfW, mover.y + halfH);

        if (hitX) {
          p.vx *= -DEATH_BITS_WALL_BOUNCE;
        }
        if (hitY) {
          if (dy > 0) {
            if (p.bounces < DEATH_BITS_MAX_BOUNCES && Math.abs(p.vy) > 38) {
              p.vy *= -DEATH_BITS_BOUNCE;
              p.bounces += 1;
            } else {
              p.vy = 0;
            }
            p.vx *= DEATH_BITS_GROUND_FRICTION;
            p.grounded = true;
          } else {
            p.vy = Math.abs(p.vy) * 0.22;
            p.grounded = false;
          }
        } else {
          p.grounded = false;
        }
        if (p.grounded) {
          p.vx *= DEATH_BITS_ROLL_DAMP;
          if (Math.abs(p.vx) < DEATH_BITS_GROUND_STOP_SPEED) {
            p.vx = 0;
          }
        }
      }
      if (p.grounded) {
        const targetRollVel =
          p.rollRadiusPx > 0.001 ? (p.vx / p.rollRadiusPx) * 0.9 : 0;
        p.rotVel += (targetRollVel - p.rotVel) * 0.42;
      } else {
        p.rotVel *= 0.995;
      }
      p.sprite.rotation += p.rotVel * dtSec;
      const fadeStart = Math.min(
        p.lifeSec - 0.22,
        Math.max(DEATH_BITS_SETTLE_BEFORE_FADE_SEC, p.lifeSec * 0.72),
      );
      const fadeT =
        p.ageSec <= fadeStart ? 0 : (p.ageSec - fadeStart) / Math.max(0.001, p.lifeSec - fadeStart);
      p.sprite.alpha = 1 - Math.min(1, Math.max(0, fadeT));
      if (t >= 1) {
        p.sprite.parent?.removeChild(p.sprite);
        p.sprite.destroy();
        p.fragmentTexture.destroy();
        this.deathBits.splice(i, 1);
      }
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

  private createRemotePlayerRoot(skinSet?: SkinTextureSet): Container {
    const c = new Container();
    c.sortableChildren = true;
    c.cullable = false;
    c.cullableChildren = false;
    const idle = skinSet?.idle ?? this.playerIdleAnimTextures;
    const walk = skinSet?.walk ?? this.playerWalkCycleTextures;
    const frames = skinSet?.frames ?? this.playerBodyAtlasFrames;
    const scale = skinSet?.scale ?? this.playerSpriteBaseScale;
    if (
      idle !== null &&
      walk !== null &&
      walk.length > 0 &&
      frames !== null &&
      frames.length >= PLAYER_BODY_REQUIRED_FRAME_COUNT
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
      layoutPlayerSprite(anim, scale);
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

  /** Rebuild a single remote peer's container with a new skin texture set. */
  private rebuildRemotePlayerRoot(peerId: string, skinSet: SkinTextureSet): void {
    const existing = this.remoteGraphics.get(peerId);
    if (existing === undefined) {
      return;
    }
    const parent = existing.parent;
    if (parent === null) {
      return;
    }
    existing.destroy({ children: true });
    this.remoteArmorSprites.delete(peerId);
    const newRoot = this.createRemotePlayerRoot(skinSet);
    parent.addChild(newRoot);
    this.remoteGraphics.set(peerId, newRoot);
    this.remoteWalkAnimMode.set(peerId, { v: "idle" });
    this.remoteSurfaceMode.set(peerId, { v: "ground" });
  }

  /** Upgrade remote roots from magenta placeholder to animated sprites once walk textures load. */
  private refreshRemotePlayerBodies(): void {
    const defaultIdle = this.playerIdleAnimTextures;
    const defaultCycle = this.playerWalkCycleTextures;
    const defaultAtlas = this.playerBodyAtlasFrames;
    const hasDefaults =
      defaultIdle !== null &&
      defaultCycle !== null &&
      defaultCycle.length > 0 &&
      defaultAtlas !== null &&
      defaultAtlas.length >= PLAYER_BODY_REQUIRED_FRAME_COUNT;
    for (const [peerId, root] of this.remoteGraphics) {
      const first = root.children[0];
      if (first instanceof AnimatedSprite) {
        continue;
      }
      const peerSkin = this.remoteSkinTextures.get(peerId);
      const idle = peerSkin?.idle ?? defaultIdle;
      const scale = peerSkin?.scale ?? this.playerSpriteBaseScale;
      if (idle === null || (!hasDefaults && peerSkin === undefined)) {
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
      layoutPlayerSprite(anim, scale);
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
        const cycle = peerSkin?.walk ?? defaultCycle;
        const breaking = peerSkin?.breaking ?? this.playerBreakingAnimTextures;
        const skid = peerSkin?.skid ?? this.playerSkidAnimTextures;
        const jumpUp = peerSkin?.jumpUp ?? this.playerJumpUpAnimTextures;
        const jumpDown = peerSkin?.jumpDown ?? this.playerJumpDownAnimTextures;
        const miningVisual =
          rp.miningVisualFromNetwork || rp.getBreakMining() !== null;
        const feetInWaterRemote = feetAabbOverlapsWater(
          this.world,
          disp.x,
          disp.y,
          PLAYER_WIDTH,
          PLAYER_HEIGHT,
        );
        if (cycle === null) {
          continue;
        }
        syncPlayerBodyAnimation(
          anim,
          onGroundApprox,
          moving,
          sprinting,
          disp.facingRight,
          scale,
          { idle: idle!, cycle, mode },
          disp.vy,
          jumpUp,
          jumpDown,
          surf,
          breaking,
          miningVisual,
          false,
          skid,
          feetInWaterRemote,
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
    bowDrawSec: number,
    aimFeetX: number,
    aimFeetY: number,
    /** When set (remote peers), bow aim uses shooter crosshair instead of local mouse. */
    remoteAim: { x: number; y: number } | null,
  ): void {
    const breaking = this.playerBreakingAnimTextures;
    const breakingLoopActive =
      miningVisual &&
      breaking !== null &&
      breaking.length >= 2 &&
      anim.textures === breaking;
    let tex: Texture | null = null;
    let heldPlaceableBlock = false;
    /** Tool art: mirror X so blade/head faces the right way in-hand (bow uses default flip + aim rotation). */
    let heldFlipOppositeToDefault = false;
    /** Tool tilt and nudges for all tool types (do not apply to bow). */
    let heldAxeLayout = false;
    let heldBowLayout = false;
    if (heldItemId !== 0) {
      const def = this.itemRegistry.getById(heldItemId as ItemId);
      if (def !== undefined) {
        let textureName = def.textureName;
        if (def.key === "stratum:bow") {
          textureName = bowDrawItemTextureName(bowDrawSec);
        }
        tex = this.itemTextureAtlas.getTextureOrNull(textureName);
        heldPlaceableBlock = def.placesBlockId !== undefined;
        heldAxeLayout = def.toolType !== undefined;
        heldBowLayout = def.key === "stratum:bow";
        heldFlipOppositeToDefault = heldAxeLayout;
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
      (heldFlipOppositeToDefault
        ? facingRight
          ? bx
          : -bx
        : facingRight
          ? -bx
          : bx) * k;
    const heldFacingFlipX = facingRight ? 1 : -1;
    const heldEffScaleX = heldSx * heldFacingFlipX;
    /** Bow: positive `scale.x` so rotation matches `atan2` aim (held flip was folded into angle before). */
    let heldScaleX = heldEffScaleX;
    const faceScreenX = facingRight ? 1 : -1;
    /** Bow: aim from feet→cursor (same as reach line); roundPixels keeps quarter-ish angles crisp. */
    held.roundPixels = heldBowLayout;
    const airJumpHeld = !onGroundApprox;
    const onHeldBreakSwingFrame =
      breakingLoopActive && anim.currentFrame === 1;
    let bowAimRad = 0;
    if (heldBowLayout) {
      let mx: number;
      let my: number;
      if (remoteAim !== null) {
        mx = remoteAim.x;
        my = remoteAim.y;
      } else {
        const blocked = this.input.isWorldInputBlocked();
        mx = blocked
          ? aimFeetX + (facingRight ? 140 : -140)
          : this.input.mouseWorldPos.x;
        my = blocked ? aimFeetY - 90 : this.input.mouseWorldPos.y;
      }
      const { dirX, dirY } = getReachLineGeometry(
        aimFeetX,
        aimFeetY,
        mx,
        my,
        facingRight,
        REACH_BLOCKS,
      );
      /** Same pattern as flying arrows: `aimAngle - textureAxisAtZero` ({@link ARROW_SPRITE_TIP_ANGLE_AT_ZERO_ROT_RAD}). */
      bowAimRad =
        Math.atan2(dirY, dirX) -
        PLAYER_HELD_BOW_TEXTURE_AIM_AXIS_AT_ZERO_ROT_RAD;
      heldScaleX = Math.abs(heldEffScaleX);
    }
    held.scale.set(heldScaleX, anim.scale.y * k);
    const baseHeldRotation = heldAxeLayout
      ? faceScreenX * PLAYER_HELD_AXE_ROTATION_RAD
      : heldBowLayout
        ? bowAimRad
        : 0;
    const breakSwingRotation =
      heldBowLayout || !onHeldBreakSwingFrame
        ? 0
        : faceScreenX * PLAYER_HELD_BREAK_FRAME_ROTATION_RAD;
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
        (heldAxeLayout ? faceScreenX * PLAYER_HELD_AXE_NUDGE_X_PX : 0) +
        (airJumpHeld ? faceScreenX * PLAYER_HELD_ITEM_JUMP_NUDGE_X_PX : 0) +
        breakForward,
      anim.position.y +
        PLAYER_HELD_ITEM_HAND_OFFSET_Y_TEXELS * anim.scale.y +
        PLAYER_HELD_ITEM_OUTWARD_NUDGE_Y_PX +
        (airJumpHeld ? PLAYER_HELD_ITEM_AIR_JUMP_NUDGE_Y_PX : 0) +
        (heldAxeLayout ? PLAYER_HELD_AXE_NUDGE_Y_PX : 0) +
        (heldPlaceableBlock ? PLAYER_HELD_PLACEABLE_BLOCK_NUDGE_Y_PX : 0) +
        breakUp,
    );
    if (heldBowLayout) {
      held.position.set(
        Math.round(held.position.x),
        Math.round(held.position.y),
      );
    }
    held.zIndex = -1;
    anim.zIndex = 0;
    held.visible = true;
  }

  /**
   * Body atlas cell for an armor piece, or null when the item is not a supported overlay material.
   */
  private resolveArmorOverlayCellForItem(
    slot: number,
    itemId: number,
    atlasFrame: number,
  ): Texture | null {
    if (itemId === 0) {
      return null;
    }
    const itemKey = this.itemRegistry.getById(itemId as ItemId)?.key ?? "";
    const material =
      itemKey.startsWith("stratum:gold_") ||
      itemKey.startsWith("stratum:golden_")
        ? "gold"
        : itemKey.startsWith("stratum:iron_")
          ? "iron"
          : null;
    const frames =
      material === "gold"
        ? slot === 0
          ? this.goldArmorHelmetFrames
          : slot === 1
            ? this.goldArmorChestplateFrames
            : slot === 2
              ? this.goldArmorLeggingsFrames
              : this.goldArmorBootsFrames
        : material === "iron"
          ? slot === 0
            ? this.ironArmorHelmetFrames
            : slot === 1
              ? this.ironArmorChestplateFrames
              : slot === 2
                ? this.ironArmorLeggingsFrames
                : this.ironArmorBootsFrames
          : null;
    if (
      frames === null ||
      frames === undefined ||
      atlasFrame < 0 ||
      atlasFrame >= frames.length
    ) {
      return null;
    }
    return frames[atlasFrame]!;
  }

  /** Armor overlays for a networked peer (same art rules as {@link syncLocalArmorOverlays}). */
  private syncRemoteArmorOverlays(
    peerId: string,
    root: Container,
    anim: AnimatedSprite,
    facingRight: boolean,
    bodyScale: number,
    armorIds: readonly [number, number, number, number],
    bodyTint: number,
  ): void {
    const zByArmorSlot = [5, 4, 3, 2];
    let slots = this.remoteArmorSprites.get(peerId);
    if (slots === undefined) {
      slots = [null, null, null, null];
      this.remoteArmorSprites.set(peerId, slots);
    }
    const atlasFrame = resolvePlayerBodyAtlasFrameIndex(
      anim,
      this.playerIdleAnimTextures,
      this.playerWalkCycleTextures,
      this.playerJumpUpAnimTextures,
      this.playerJumpDownAnimTextures,
      this.playerBreakingAnimTextures,
      this.playerSkidAnimTextures,
      this.playerBodyAtlasFrames,
    );
    for (let slot = 0; slot < 4; slot++) {
      const itemId = armorIds[slot]!;
      const cell = this.resolveArmorOverlayCellForItem(slot, itemId, atlasFrame);
      const existingSprite = slots[slot];
      if (cell === null) {
        if (existingSprite !== null && existingSprite !== undefined) {
          existingSprite.visible = false;
        }
        continue;
      }
      let sprite = existingSprite;
      if (sprite === null || sprite === undefined) {
        const newSprite = new Sprite(cell);
        newSprite.anchor.set(0.5, 1);
        newSprite.roundPixels = false;
        newSprite.cullable = false;
        root.addChild(newSprite);
        slots[slot] = newSprite;
        sprite = newSprite;
      } else {
        sprite.texture = cell;
      }
      sprite.scale.set(
        facingRight ? -bodyScale : bodyScale,
        bodyScale,
      );
      sprite.position.set(anim.position.x, anim.position.y);
      sprite.zIndex = zByArmorSlot[slot] ?? 2;
      sprite.visible = true;
      sprite.tint = bodyTint;
    }
  }

  /**
   * Sync armor overlay sprites for the local player.
   * slot 0=helmet, 1=chestplate, 2=leggings, 3=boots
   */
  private syncLocalArmorOverlays(
    anim: AnimatedSprite,
    facingRight: boolean,
    sleeping: boolean,
  ): void {
    /** Draw order: boots (behind) → helmet (in front); indices 3,2,1,0. */
    const zByArmorSlot = [5, 4, 3, 2];

    const root = this.playerGraphic;
    if (root === null) return;

    const atlasFrame = resolvePlayerBodyAtlasFrameIndex(
      anim,
      this.playerIdleAnimTextures,
      this.playerWalkCycleTextures,
      this.playerJumpUpAnimTextures,
      this.playerJumpDownAnimTextures,
      this.playerBreakingAnimTextures,
      this.playerSkidAnimTextures,
      this.playerBodyAtlasFrames,
    );

    for (let slot = 0; slot < 4; slot++) {
      const armorStack = this.player.inventory.getArmorStack(slot as ArmorSlot);
      const hasArmor = armorStack !== null && armorStack.count > 0;
      const itemId = armorStack?.itemId ?? 0;
      const cell = this.resolveArmorOverlayCellForItem(slot, itemId, atlasFrame);

      const existingSprite = this.localArmorSprites[slot];

      if (!hasArmor || sleeping || cell === null) {
        if (existingSprite !== null && existingSprite !== undefined) {
          existingSprite.visible = false;
        }
        continue;
      }

      let sprite = existingSprite;

      if (sprite === null || sprite === undefined) {
        const newSprite = new Sprite(cell);
        newSprite.anchor.set(0.5, 1);
        newSprite.roundPixels = false;
        newSprite.cullable = false;
        root.addChild(newSprite);
        this.localArmorSprites[slot] = newSprite;
        sprite = newSprite;
      } else {
        sprite.texture = cell;
      }

      sprite.scale.set(
        facingRight ? -this.playerSpriteBaseScale : this.playerSpriteBaseScale,
        this.playerSpriteBaseScale,
      );
      sprite.position.set(anim.position.x, anim.position.y);
      sprite.zIndex = zByArmorSlot[slot] ?? 2;
      sprite.visible = true;
      sprite.tint = anim.tint;
    }
  }

  /**
   * Load player sprites from a skin URL. If `skinUrl` is omitted, falls back
   * to the default built-in skin.
   */
  private async loadPlayerSprites(skinUrl?: string): Promise<void> {
    const url =
      skinUrl ?? stratumCoreTextureAssetUrl(PLAYER_BODY_ATLAS_IMAGE_REL);
    try {
      const set = await loadSkinTextureSet(url);
      if (set === null) {
        return;
      }
      this.applyLocalSkinTextureSet(set);
      this.refreshRemotePlayerBodies();
    } catch {
      // Optional asset: keep cyan placeholder when missing.
    }
  }

  /** Apply a pre-loaded {@link SkinTextureSet} to the local player visuals. */
  private applyLocalSkinTextureSet(set: SkinTextureSet): void {
    this.playerBodyAtlasFrames = set.frames;
    this.playerIdleAnimTextures = set.idle;
    this.playerWalkCycleTextures = set.walk;
    this.playerJumpUpAnimTextures = set.jumpUp;
    this.playerJumpDownAnimTextures = set.jumpDown;
    this.playerSkidAnimTextures = set.skid;
    this.playerBreakingAnimTextures = set.breaking;
    this.localWalkAnimMode.v = "idle";
    this.localSurfaceMode.v = "ground";
    this.playerSpriteBaseScale = set.scale;

    const root = this.playerGraphic;
    if (root === null) {
      return;
    }
    this.localPlayerPlaceholder?.destroy();
    this.localPlayerPlaceholder = null;

    if (this.localPlayerAnim !== null) {
      this.localPlayerAnim.destroy();
      this.localPlayerAnim = null;
    }
    if (this.localHeldItemSprite !== null) {
      this.localHeldItemSprite.destroy();
      this.localHeldItemSprite = null;
    }

    const anim = new AnimatedSprite({
      textures: set.idle,
      animationSpeed: PLAYER_WALK_ANIM_SPEED,
      loop: true,
      autoPlay: false,
    });
    layoutPlayerSprite(anim, set.scale);
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
  }

  /**
   * Load the local player skin once after {@link initVisual}.
   * Custom skins need a temporary object URL from {@link options.resolveCustomSkinBlobUrl}.
   */
  async initializeLocalPlayerSkin(
    skinId: string | null | undefined,
    options: {
      resolveCustomSkinBlobUrl?: (uuid: string) => Promise<string | null>;
    } = {},
  ): Promise<void> {
    const effectiveId =
      skinId !== null && skinId !== undefined && skinId.length > 0
        ? skinId
        : DEFAULT_SKIN_ID;

    const ref = parseSkinId(effectiveId);
    let url: string | null = null;
    let blobUrl: string | null = null;

    if (ref.kind === "builtin") {
      url = resolveBuiltinSkinUrl(ref.skinId);
    } else {
      blobUrl =
        (await options.resolveCustomSkinBlobUrl?.(ref.skinId)) ?? null;
      url = blobUrl;
    }

    const revokeBlobIfNeeded = (): void => {
      if (blobUrl !== null) {
        URL.revokeObjectURL(blobUrl);
        blobUrl = null;
      }
    };

    if (url === null) {
      await this.loadPlayerSprites();
      return;
    }

    try {
      const set = await loadSkinTextureSet(url);
      revokeBlobIfNeeded();
      if (set === null) {
        await this.loadPlayerSprites();
        return;
      }
      this.localSkinId = effectiveId;
      this.applyLocalSkinTextureSet(set);
      this.refreshRemotePlayerBodies();
    } catch {
      revokeBlobIfNeeded();
      await this.loadPlayerSprites();
    }
  }

  /** Change the local player skin at runtime (e.g. from profile screen selection). */
  async setLocalSkin(skinId: string, blobUrl?: string): Promise<void> {
    const ref = parseSkinId(skinId);
    let url: string | null = null;
    if (ref.kind === "builtin") {
      url = resolveBuiltinSkinUrl(ref.skinId);
    } else if (blobUrl !== undefined) {
      url = blobUrl;
    }
    if (url === null) {
      return;
    }
    const set = await loadSkinTextureSet(url);
    if (set === null) {
      return;
    }
    this.localSkinId = skinId;
    this.applyLocalSkinTextureSet(set);
    this.refreshRemotePlayerBodies();
  }

  /** Load and cache a skin texture set for a remote peer. */
  async loadRemoteSkinTextures(
    peerId: string,
    skinId: string,
    blobUrl?: string,
  ): Promise<void> {
    const ref = parseSkinId(skinId);
    let url: string | null = null;
    if (ref.kind === "builtin") {
      url = resolveBuiltinSkinUrl(ref.skinId);
    } else if (blobUrl !== undefined) {
      url = blobUrl;
    }
    if (url === null) {
      return;
    }
    try {
      const set = await loadSkinTextureSet(url);
      if (set === null) {
        return;
      }
      this.remoteSkinTextures.set(peerId, set);
      this.rebuildRemotePlayerRoot(peerId, set);
    } catch {
      // Remote skin load failure is non-fatal; peer keeps the default textures.
    }
  }

  /** Get the current local skin id (serialised string). */
  getLocalSkinId(): string | null {
    return this.localSkinId;
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
      let assumeDoubleResolutionForScale = false;
      if (w === 119 && h === 31) {
        // This pack is authored at effectively 2× the logical frame size (Pixi may report half-res dims
        // depending on image resolution metadata). Treat it as 34×62 for scaling so zombies don't render ~2×.
        assumeDoubleResolutionForScale = true;
        const fh = 31;
        const fw = 17;
        const rect = (x: number): { x: number; y: number; w: number; h: number } => ({
          x,
          y: 0,
          w: fw,
          h: fh,
        });
        // Order is semantic (idle, walk×4, jump, hit).
        const frames = sliceAtlasFrames(sheet, [
          rect(0), // layer_1 idle
          rect(17), // layer_2 walk
          rect(34), // layer_3 walk
          rect(51), // layer_4 walk
          rect(68), // layer_5 walk
          rect(85), // layer_6 jump
          rect(102), // layer_7 hit
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
      const scaleW = assumeDoubleResolutionForScale ? maxW * 2 : maxW;
      const scaleH = assumeDoubleResolutionForScale ? maxH * 2 : maxH;
      // Kept for backwards-compat load; runtime uses `playerSpriteBaseScale` for zombies.
      void scaleW;
      void scaleH;
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
          destroyOwnedTextureList(ovWalk);
          destroyOwnedTextureList(ovIdle);
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
      const [idle, walk] = await Promise.all([
        loadSlimeSpriteFolderStrip(PIG_SPRITE_IDLE_FOLDER_REL, PIG_IDLE_FRAMES),
        loadSlimeSpriteFolderStrip(PIG_SPRITE_WALK_FOLDER_REL, PIG_WALK_FRAMES),
      ]);
      if (idle === null || walk === null) {
        return;
      }
      this.pigIdleTextures = idle;
      this.pigWalkTextures = walk;
    } catch {
      this.pigWalkTextures = null;
      this.pigIdleTextures = null;
    }
  }

  private async loadDuckSprites(): Promise<void> {
    try {
      const [idle, walk] = await Promise.all([
        loadSlimeSpriteFolderStrip(DUCK_SPRITE_IDLE_FOLDER_REL, DUCK_IDLE_FRAMES),
        loadSlimeSpriteFolderStrip(DUCK_SPRITE_WALK_FOLDER_REL, DUCK_WALK_FRAMES),
      ]);
      if (idle === null || walk === null) {
        return;
      }
      this.duckIdleTextures = idle;
      this.duckWalkTextures = walk;
    } catch {
      this.duckWalkTextures = null;
      this.duckIdleTextures = null;
    }
  }

  private async loadSlimeSprites(): Promise<void> {
    try {
      const [idle, jump, attack] = await Promise.all([
        loadSlimeSpriteFolderStrip(SLIME_SPRITE_IDLE_FOLDER_REL, SLIME_IDLE_FRAMES),
        loadSlimeSpriteFolderStrip(SLIME_SPRITE_JUMP_FOLDER_REL, SLIME_JUMP_FRAMES),
        loadSlimeSpriteFolderStrip(SLIME_SPRITE_ATTACK_FOLDER_REL, SLIME_ATTACK_FRAMES),
      ]);
      if (idle === null || jump === null || attack === null) {
        return;
      }
      this.slimeJumpPrimeTextures = jump.slice(0, 3);
      this.slimeJumpAirTextures = jump.slice(3, 5);
      this.slimeIdleTextures = idle;
      this.slimeAttackTextures = attack;
    } catch {
      this.slimeJumpPrimeTextures = null;
      this.slimeJumpAirTextures = null;
      this.slimeIdleTextures = null;
      this.slimeAttackTextures = null;
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
        const hpBar = new Graphics();
        hpBar.zIndex = 2;
        hpBar.roundPixels = true;
        hpBar.visible = false;
        root.addChild(hpBar);
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
        rig = { root, base, wool, hpBar };
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
      const { root, base, wool, hpBar } = rig;
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
      const sheepInWater =
        v.deathAnimRemainSec <= 0 &&
        feetAabbOverlapsWater(
          this.world,
          v.x,
          v.y,
          SHEEP_WIDTH_PX,
          SHEEP_HEIGHT_PX,
        );
      const sheepWalkMult =
        sheepInWater && useWalk ? PLAYER_WATER_WALK_ANIM_SPEED_MULT : 1;
      base.animationSpeed = (useWalk ? 0.2 : 0.12) * sheepWalkMult;
      if (wool !== null) {
        wool.animationSpeed = (useWalk ? 0.2 : 0.12) * sheepWalkMult;
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
      const sheepSwimDown = sheepInWater ? ENTITY_SWIM_VISUAL_SINK_PX : 0;
      root.position.set(
        Math.round(v.x),
        Math.round(-v.y + SHEEP_FEET_SPRITE_NUDGE_Y_PX + extraNudgeDownPx + sheepSwimDown),
      );
      if (v.deathAnimRemainSec > 0) {
        let deathBitTex: Texture = base.texture;
        let deathBitTint: number = base.tint as number;
        if (wool !== null) {
          const composited = compositeSheepTextureForDeathBits(
            base.texture,
            wool.texture,
            getSheepWoolTintHex(v.woolColor),
          );
          if (composited !== null) {
            deathBitTex = composited;
            deathBitTint = 0xffffff;
          } else {
            deathBitTex = base.texture;
            deathBitTint = wool.tint as number;
          }
        }
        this.spawnDeathBitsIfNeeded(
          MobType.Sheep,
          v.id,
          root.position.x,
          root.position.y,
          v.facingRight,
          mm.getDeathImpulseSourceX(v.id),
          deathBitTex,
          deathBitTint,
        );
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
      const sheepBarRemain = Math.max(
        0,
        (this.mobHitHealthBarRemainSec.get(v.id) ?? 0) - _dtSec,
      );
      this.mobHitHealthBarRemainSec.set(v.id, sheepBarRemain);
      const sheepBarAlpha = sheepBarRemain / MOB_HIT_HEALTH_BAR_SHOW_SEC;
      hpBar.visible = sheepBarAlpha > 0 && v.deathAnimRemainSec <= 0 && v.hp > 0;
      if (hpBar.visible) {
        drawMobHealthBar(hpBar, v.hp, SHEEP_MAX_HEALTH, sheepBarAlpha, -31, root.scale.x, root.scale.y);
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
        this.mobHitHealthBarRemainSec.delete(id);
      }
    }
    this.pruneDeathBitsSpawned(MobType.Sheep, alive);
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
        const hpBar = new Graphics();
        hpBar.zIndex = 2;
        hpBar.roundPixels = true;
        hpBar.visible = false;
        root.addChild(hpBar);
        parent.addChild(root);
        rig = { root, base, hpBar };
        this.pigSprites.set(v.id, rig);
      }
      const useWalk = v.walking && !v.panic;
      const frames = useWalk ? walk : idle;
      const { root, base, hpBar } = rig;
      if (base.textures !== frames) {
        base.textures = frames;
        if (v.deathAnimRemainSec > 0) {
          base.gotoAndStop(0);
        } else {
          base.gotoAndPlay(0);
        }
      }
      const pigInWater =
        v.deathAnimRemainSec <= 0 &&
        feetAabbOverlapsWater(this.world, v.x, v.y, PIG_WIDTH_PX, PIG_HEIGHT_PX);
      const pigWalkMult =
        pigInWater && useWalk ? PLAYER_WATER_WALK_ANIM_SPEED_MULT : 1;
      base.animationSpeed = (useWalk ? 0.2 : 0.12) * pigWalkMult;
      base.tint = 0xffffff;
      const frameH = base.textures[0]?.height ?? 0;
      const effectiveH = Math.max(1, frameH - PIG_FEET_SPRITE_NUDGE_Y_PX);
      baseScale =
        (PIG_BODY_TRIM_TARGET_PX / effectiveH) * PIG_RENDER_SCALE_MULT;
      const flipX = v.facingRight ? -1 : 1;
      root.scale.set(baseScale, baseScale);
      base.scale.set(flipX, 1);
      root.tint = v.hurt ? 0xff4a4a : 0xffffff;
      const pigSwimDown = pigInWater ? ENTITY_SWIM_VISUAL_SINK_PX : 0;
      root.position.set(
        Math.round(v.x),
        Math.round(
          -v.y +
            PIG_FEET_SPRITE_NUDGE_Y_PX +
            PIG_VISUAL_FEET_DROP_PX +
            extraNudgeDownPx +
            pigSwimDown,
        ),
      );
      if (v.deathAnimRemainSec > 0) {
        this.spawnDeathBitsIfNeeded(
          MobType.Pig,
          v.id,
          root.position.x,
          root.position.y,
          v.facingRight,
          mm.getDeathImpulseSourceX(v.id),
          base.texture,
          base.tint,
        );
        base.stop();
        const t = Math.min(1, Math.max(0, 1 - v.deathAnimRemainSec / PIG_DEATH_ANIM_SEC));
        const sign = v.facingRight ? 1 : -1;
        root.rotation = sign * t * (Math.PI * 0.5);
        root.alpha = 1 - t;
      } else {
        root.rotation = 0;
        root.alpha = 1;
      }
      const pigBarRemain = Math.max(
        0,
        (this.mobHitHealthBarRemainSec.get(v.id) ?? 0) - _dtSec,
      );
      this.mobHitHealthBarRemainSec.set(v.id, pigBarRemain);
      const pigBarAlpha = pigBarRemain / MOB_HIT_HEALTH_BAR_SHOW_SEC;
      hpBar.visible = pigBarAlpha > 0 && v.deathAnimRemainSec <= 0 && v.hp > 0;
      if (hpBar.visible) {
        drawMobHealthBar(hpBar, v.hp, PIG_MAX_HEALTH, pigBarAlpha, -31, root.scale.x, root.scale.y);
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
        this.mobHitHealthBarRemainSec.delete(id);
      }
    }
    this.pruneDeathBitsSpawned(MobType.Pig, alive);
  }

  private syncDuckSprites(_dtSec: number): void {
    const mm = this.mobManager;
    const walk = this.duckWalkTextures;
    const idle = this.duckIdleTextures;
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
    const views = mm.getPublicViews().filter((v) => v.type === MobType.Duck);
    const alive = new Set<number>();
    const extraNudgeDownPx = 0;
    for (const v of views) {
      alive.add(v.id);
      let rig = this.duckSprites.get(v.id);
      if (rig === undefined) {
        const root = new Container();
        root.sortableChildren = true;
        root.zIndex = -2;
        root.cullable = false;
        root.cullableChildren = false;
        const base = new Sprite({ texture: idle[0]! });
        base.anchor.set(0.5, 1);
        base.roundPixels = true;
        base.zIndex = 0;
        root.addChild(base);
        const hpBar = new Graphics();
        hpBar.zIndex = 2;
        hpBar.roundPixels = true;
        hpBar.visible = false;
        root.addChild(hpBar);
        parent.addChild(root);
        rig = { root, base, hpBar };
        this.duckSprites.set(v.id, rig);
        this.duckClientAnim.set(v.id, { walkAccumSec: 0 });
      }
      const anim = this.duckClientAnim.get(v.id);
      if (anim === undefined) {
        continue;
      }
      const useWalk = v.walking && !v.panic;
      const { root, base, hpBar } = rig;
      const duckInWater =
        v.deathAnimRemainSec <= 0 &&
        feetAabbOverlapsWater(this.world, v.x, v.y, DUCK_WIDTH_PX, DUCK_HEIGHT_PX);
      const duckWalkMult =
        duckInWater && useWalk ? PLAYER_WATER_WALK_ANIM_SPEED_MULT : 1;

      let strip: Texture[] = idle;
      let frame = 0;
      if (v.deathAnimRemainSec > 0) {
        strip = idle;
        frame = 0;
      } else if (useWalk) {
        strip = walk;
        const stepSec = 0.11;
        anim.walkAccumSec += _dtSec * duckWalkMult;
        if (anim.walkAccumSec >= stepSec * strip.length) {
          anim.walkAccumSec -= stepSec * strip.length;
        }
        frame = Math.floor(anim.walkAccumSec / stepSec) % strip.length;
      } else {
        strip = idle;
        anim.walkAccumSec = 0;
        frame = 0;
      }
      const frameTex = strip[frame] ?? strip[0];
      if (frameTex !== undefined && base.texture !== frameTex) {
        base.texture = frameTex;
      }
      base.tint = 0xffffff;
      const flipX = v.facingRight ? 1 : -1;
      root.scale.set(PASSIVE_MOB_TEXEL_SCREEN_SCALE, PASSIVE_MOB_TEXEL_SCREEN_SCALE);
      base.scale.set(flipX, 1);
      // Keep duck sprite origin fixed across animation frames to avoid visible popping/jitter.
      base.position.set(0, 0);
      root.tint = v.hurt ? 0xff4a4a : 0xffffff;
      const duckSwimDown = duckInWater ? ENTITY_SWIM_VISUAL_SINK_PX : 0;
      root.position.set(
        Math.round(v.x),
        Math.round(-v.y + DUCK_FEET_SPRITE_NUDGE_Y_PX + extraNudgeDownPx + duckSwimDown),
      );
      if (v.deathAnimRemainSec > 0) {
        this.spawnDeathBitsIfNeeded(
          MobType.Duck,
          v.id,
          root.position.x,
          root.position.y,
          v.facingRight,
          mm.getDeathImpulseSourceX(v.id),
          base.texture,
          base.tint,
        );
        const t = Math.min(1, Math.max(0, 1 - v.deathAnimRemainSec / DUCK_DEATH_ANIM_SEC));
        const sign = v.facingRight ? 1 : -1;
        root.rotation = sign * t * (Math.PI * 0.5);
        root.alpha = 1 - t;
      } else {
        root.rotation = 0;
        root.alpha = 1;
      }
      const duckBarRemain = Math.max(
        0,
        (this.mobHitHealthBarRemainSec.get(v.id) ?? 0) - _dtSec,
      );
      this.mobHitHealthBarRemainSec.set(v.id, duckBarRemain);
      const duckBarAlpha = duckBarRemain / MOB_HIT_HEALTH_BAR_SHOW_SEC;
      hpBar.visible = duckBarAlpha > 0 && v.deathAnimRemainSec <= 0 && v.hp > 0;
      if (hpBar.visible) {
        drawMobHealthBar(hpBar, v.hp, DUCK_MAX_HEALTH, duckBarAlpha, -23, root.scale.x, root.scale.y);
      }
    }
    for (const id of [...this.duckSprites.keys()]) {
      if (!alive.has(id)) {
        const rig = this.duckSprites.get(id);
        if (rig !== undefined) {
          rig.root.parent?.removeChild(rig.root);
          rig.root.destroy({ children: true });
        }
        this.duckSprites.delete(id);
        this.duckClientAnim.delete(id);
        this.mobHitHealthBarRemainSec.delete(id);
      }
    }
    this.pruneDeathBitsSpawned(MobType.Duck, alive);
  }

  private syncSlimeSprites(dtSec: number): void {
    const mm = this.mobManager;
    const jumpPrime = this.slimeJumpPrimeTextures;
    const jumpAir = this.slimeJumpAirTextures;
    const idle = this.slimeIdleTextures;
    const attack = this.slimeAttackTextures;
    if (
      mm === null ||
      jumpPrime === null ||
      jumpAir === null ||
      idle === null ||
      attack === null ||
      jumpPrime.length < 3 ||
      jumpAir.length < 2 ||
      idle.length === 0
    ) {
      return;
    }
    const parent = this.playerGraphic?.parent;
    if (parent === null || parent === undefined) {
      return;
    }
    const views = mm.getPublicViews().filter((v) => v.type === MobType.Slime);
    const alive = new Set<number>();
    const slimeTexelScreenScale =
      PASSIVE_MOB_TEXEL_SCREEN_SCALE * SLIME_RENDER_SCALE_MULT;
    /** Slime 16px art: no pig-style down nudge (that buried the blob in terrain). */
    const extraNudgeDownPx = 0;
    for (const v of views) {
      alive.add(v.id);
      let rig = this.slimeSprites.get(v.id);
      if (rig === undefined) {
        const root = new Container();
        root.sortableChildren = true;
        root.zIndex = -2;
        root.cullable = false;
        root.cullableChildren = false;
        const base = new Sprite({ texture: idle[0]! });
        base.anchor.set(0.5, 1);
        base.roundPixels = true;
        base.zIndex = 0;
        base.filters = [createSlimeGelAlphaFilter()];
        root.addChild(base);
        const hpBar = new Graphics();
        hpBar.zIndex = 2;
        hpBar.roundPixels = true;
        hpBar.visible = false;
        root.addChild(hpBar);
        parent.addChild(root);
        root.alpha = 1;
        rig = { root, base, hpBar };
        this.slimeSprites.set(v.id, rig);
        this.slimeClientAnim.set(v.id, {
          prevOnGround: true,
          landRemainSec: 0,
          primeLocalSec: 0,
          wasPriming: false,
          wasAttacking: false,
          attackElapsedSec: 0,
          airPhaseAccum: 0,
          jellyWobblePhase: v.id * 0.37,
        });
      }
      const anim = this.slimeClientAnim.get(v.id);
      if (anim === undefined) {
        continue;
      }
      if (typeof anim.jellyWobblePhase !== "number") {
        anim.jellyWobblePhase = v.id * 0.37;
      }
      const slimeInWater =
        v.deathAnimRemainSec <= 0 &&
        feetAabbOverlapsWater(
          this.world,
          v.x,
          v.y,
          SLIME_WIDTH_PX,
          SLIME_HEIGHT_PX,
        );
      const useAttack =
        v.attacking && !v.hurt && v.deathAnimRemainSec <= 0;
      const useHurt = !useAttack && v.hurt && v.deathAnimRemainSec <= 0;
      const slimeAirborne = v.walking;
      const useJumpPrime = !useAttack && !useHurt && v.slimeJumpPriming;
      const useJumpAir = !useAttack && !useHurt && !useJumpPrime && slimeAirborne;

      if (v.slimeJumpPriming && !anim.wasPriming) {
        anim.primeLocalSec = 0;
      }
      anim.wasPriming = v.slimeJumpPriming;
      if (v.slimeJumpPriming) {
        anim.primeLocalSec += dtSec;
      } else {
        anim.primeLocalSec = 0;
      }

      if (useAttack && !anim.wasAttacking) {
        anim.attackElapsedSec = 0;
      }
      anim.wasAttacking = useAttack;
      if (useAttack) {
        anim.attackElapsedSec += dtSec;
      } else {
        anim.attackElapsedSec = 0;
      }

      if (
        !anim.prevOnGround &&
        v.slimeOnGround &&
        !useJumpPrime &&
        slimeAirborne === false &&
        v.deathAnimRemainSec <= 0
      ) {
        anim.landRemainSec = SLIME_LAND_STEP_SEC * 3;
      }
      if (anim.landRemainSec > 0) {
        anim.landRemainSec = Math.max(0, anim.landRemainSec - dtSec);
      }

      const useLandSquash =
        !useAttack &&
        !useHurt &&
        !useJumpPrime &&
        !useJumpAir &&
        anim.landRemainSec > 0 &&
        v.deathAnimRemainSec <= 0;

      let strip: Texture[];
      let frame = 0;
      if (useAttack) {
        strip = attack;
        frame = Math.min(
          strip.length - 1,
          Math.floor((anim.attackElapsedSec / SLIME_ATTACK_SWING_VISUAL_SEC) * strip.length),
        );
      } else if (useHurt) {
        strip = idle;
        frame = 0;
      } else if (useLandSquash) {
        strip = idle;
        const t = 3 * SLIME_LAND_STEP_SEC - anim.landRemainSec;
        const step = Math.min(2, Math.floor(t / SLIME_LAND_STEP_SEC));
        frame = 2 - step;
      } else if (useJumpPrime) {
        strip = jumpPrime;
        const u = Math.min(1, anim.primeLocalSec / SLIME_JUMP_PRIME_SEC);
        frame = Math.min(strip.length - 1, Math.floor(u * strip.length));
      } else if (useJumpAir) {
        strip = jumpAir;
        const slimeAirDtMult = slimeInWater ? PLAYER_WATER_WALK_ANIM_SPEED_MULT : 1;
        anim.airPhaseAccum += dtSec * slimeAirDtMult;
        if (anim.airPhaseAccum >= 0.24) {
          anim.airPhaseAccum -= 0.24;
        }
        frame = Math.floor(anim.airPhaseAccum / 0.12) % 2;
      } else {
        strip = idle;
        frame = 0;
      }

      const { root, base, hpBar } = rig;
      const frameTex = strip[frame];
      if (frameTex !== undefined && base.texture !== frameTex) {
        base.texture = frameTex;
      }
      base.tint = slimeVariantBodyTint(v.woolColor);
      const cw = strip[0]?.width ?? 1;
      const ch = strip[0]?.height ?? 1;
      // Keep slime texel-to-screen mapping tied to global mob pixel scaling.
      const sx = (SLIME_FRAME_TEXEL / cw) * slimeTexelScreenScale;
      const sy = (SLIME_FRAME_TEXEL / ch) * slimeTexelScreenScale;
      const baseScale = Math.min(sx, sy);
      const moveFlipX = v.facingRight ? 1 : -1;
      const attackFlipX = v.facingRight ? -1 : 1;
      const flip = useAttack ? attackFlipX : moveFlipX;
      anim.jellyWobblePhase += dtSec;
      const canWobble =
        v.deathAnimRemainSec <= 0 &&
        !useAttack &&
        !useHurt &&
        !useJumpPrime &&
        !useJumpAir &&
        !useLandSquash;
      const wobble = canWobble ? Math.sin(anim.jellyWobblePhase * 5.2) * 0.014 : 0;
      root.scale.set(baseScale * (1 + wobble), baseScale * (1 - wobble * 0.45));
      base.scale.set(flip, 1);
      base.position.set(0, 0);
      root.tint = v.hurt && !useAttack ? 0xff6a6a : 0xffffff;
      const slimeSwimDown = slimeInWater ? ENTITY_SWIM_VISUAL_SINK_PX : 0;
      const slimeRootY =
        -v.y +
        SLIME_FEET_SPRITE_NUDGE_Y_PX +
        extraNudgeDownPx +
        SLIME_VISUAL_FEET_DROP_PX +
        slimeSwimDown;
      root.position.set(Math.round(v.x), Math.round(slimeRootY));
      if (v.deathAnimRemainSec > 0) {
        this.spawnDeathBitsIfNeeded(
          MobType.Slime,
          v.id,
          root.position.x,
          root.position.y,
          v.facingRight,
          mm.getDeathImpulseSourceX(v.id),
          base.texture,
          base.tint,
        );
        const t = Math.min(
          1,
          Math.max(0, 1 - v.deathAnimRemainSec / SLIME_DEATH_ANIM_SEC),
        );
        const sign = v.facingRight ? 1 : -1;
        root.rotation = sign * t * (Math.PI * 0.5);
        root.alpha = 1 - t;
      } else {
        root.rotation = 0;
        root.alpha = 1;
      }
      const slimeBarRemain = Math.max(
        0,
        (this.mobHitHealthBarRemainSec.get(v.id) ?? 0) - dtSec,
      );
      this.mobHitHealthBarRemainSec.set(v.id, slimeBarRemain);
      const slimeBarAlpha = slimeBarRemain / MOB_HIT_HEALTH_BAR_SHOW_SEC;
      hpBar.visible = slimeBarAlpha > 0 && v.deathAnimRemainSec <= 0 && v.hp > 0;
      if (hpBar.visible) {
        drawMobHealthBar(hpBar, v.hp, SLIME_MAX_HEALTH, slimeBarAlpha, -18, root.scale.x, root.scale.y);
      }
      if (!useJumpAir) {
        anim.airPhaseAccum = 0;
      }
      anim.prevOnGround = v.slimeOnGround;
    }
    for (const id of [...this.slimeSprites.keys()]) {
      if (!alive.has(id)) {
        const rig = this.slimeSprites.get(id);
        if (rig !== undefined) {
          rig.root.parent?.removeChild(rig.root);
          rig.root.destroy({ children: true });
        }
        this.slimeSprites.delete(id);
        this.slimeClientAnim.delete(id);
        this.mobHitHealthBarRemainSec.delete(id);
      }
    }
    this.pruneDeathBitsSpawned(MobType.Slime, alive);
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
        const hpBar = new Graphics();
        hpBar.zIndex = 3;
        hpBar.roundPixels = true;
        hpBar.visible = false;
        root.addChild(hpBar);
        parent.addChild(root);
        rig = { root, base, fire, hpBar };
        this.zombieSprites.set(v.id, rig);
      }
      const useWalk = v.walking && !v.panic;
      const useAttack = v.attacking && attack !== null && attack.length > 0;
      const useJump = !useAttack && jump !== null && jump.length > 0 && v.vy < -30;
      const frames = useAttack ? attack : useJump ? jump : useWalk ? walk : idle;
      const { root, base, fire, hpBar } = rig;
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
      const zombieInWater =
        v.deathAnimRemainSec <= 0 &&
        feetAabbOverlapsWater(
          this.world,
          v.x,
          v.y,
          ZOMBIE_WIDTH_PX,
          ZOMBIE_HEIGHT_PX,
        );
      const zombieWalkMult =
        zombieInWater && useWalk ? PLAYER_WATER_WALK_ANIM_SPEED_MULT : 1;
      base.animationSpeed =
        (useWalk
          ? PLAYER_WALK_ANIM_SPEED * 1.15
          : PLAYER_WALK_ANIM_SPEED * 0.85) * zombieWalkMult;
      base.tint = 0xffffff;
      const flipX = v.facingRight ? -1 : 1;
      root.scale.set(this.playerSpriteBaseScale, this.playerSpriteBaseScale);
      base.scale.set(flipX, 1);
      // The hit frame in some strips leans forward a few pixels; counter-nudge so the feet stay planted.
      const hitBackPx = 3;
      // Also bias 1px left to avoid a subtle jitter when toggling attack pose.
      base.position.x = useAttack ? (v.facingRight ? -hitBackPx : hitBackPx) - 1 : 0;
      root.tint = v.hurt ? 0xff4a4a : 0xffffff;
      const zombieSwimDown = zombieInWater ? ENTITY_SWIM_VISUAL_SINK_PX : 0;
      root.position.set(
        Math.round(v.x),
        Math.round(
          -v.y +
            ZOMBIE_FEET_SPRITE_NUDGE_Y_PX +
            (extraNudgeDownPx - 3) +
            zombieSwimDown,
        ),
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
        this.spawnDeathBitsIfNeeded(
          MobType.Zombie,
          v.id,
          root.position.x,
          root.position.y,
          v.facingRight,
          mm.getDeathImpulseSourceX(v.id),
          base.texture,
          base.tint,
        );
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
      const zombieBarRemain = Math.max(
        0,
        (this.mobHitHealthBarRemainSec.get(v.id) ?? 0) - _dtSec,
      );
      this.mobHitHealthBarRemainSec.set(v.id, zombieBarRemain);
      const zombieBarAlpha = zombieBarRemain / MOB_HIT_HEALTH_BAR_SHOW_SEC;
      hpBar.visible = zombieBarAlpha > 0 && v.deathAnimRemainSec <= 0 && v.hp > 0;
      if (hpBar.visible) {
        drawMobHealthBar(hpBar, v.hp, ZOMBIE_MAX_HEALTH, zombieBarAlpha, -43, root.scale.x, root.scale.y);
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
        this.mobHitHealthBarRemainSec.delete(id);
      }
    }
    this.pruneDeathBitsSpawned(MobType.Zombie, alive);
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
    this.remoteArmorSprites.clear();
    for (const sprite of this.droppedSprites.values()) {
      sprite.parent?.removeChild(sprite);
      sprite.destroy();
    }
    this.droppedSprites.clear();
    for (const sprite of this.arrowSprites.values()) {
      sprite.parent?.removeChild(sprite);
      sprite.destroy();
    }
    this.arrowSprites.clear();
    for (const p of this.deathBits) {
      p.sprite.parent?.removeChild(p.sprite);
      p.sprite.destroy();
      p.fragmentTexture.destroy();
    }
    this.deathBits.length = 0;
    this.deathBitsSpawned.clear();
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
    for (const rig of this.duckSprites.values()) {
      rig.root.parent?.removeChild(rig.root);
      rig.root.destroy({ children: true });
    }
    this.duckSprites.clear();
    this.duckClientAnim.clear();
    for (const rig of this.slimeSprites.values()) {
      rig.root.parent?.removeChild(rig.root);
      rig.root.destroy({ children: true });
    }
    this.slimeSprites.clear();
    this.slimeClientAnim.clear();
    this.slimeJumpPrimeTextures = null;
    this.slimeJumpAirTextures = null;
    this.slimeIdleTextures = null;
    this.slimeAttackTextures = null;
    releaseAllSlimeSpriteAssetTextures();
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
    // No zombie-specific base scale; see comment at declaration site.
    destroyOwnedTextureList(this.sheepWoolOverlayWalkTextures);
    destroyOwnedTextureList(this.sheepWoolOverlayIdleTextures);
    this.sheepWalkTextures = null;
    this.sheepIdleTextures = null;
    this.sheepWoolOverlayWalkTextures = null;
    this.sheepWoolOverlayIdleTextures = null;
    this.pigWalkTextures = null;
    this.pigIdleTextures = null;
    this.duckWalkTextures = null;
    this.duckIdleTextures = null;
    releaseAllDuckSpriteAssetTextures();
    this.mobManager = null;

    // Cleanup armor overlay sprites and textures
    for (const sprite of this.localArmorSprites) {
      if (sprite !== null && sprite !== undefined) {
        sprite.parent?.removeChild(sprite);
        sprite.destroy();
      }
    }
    this.localArmorSprites = [null, null, null, null];
    this.releaseArmorOverlayTextures("iron");
    this.releaseArmorOverlayTextures("gold");
    this.ironArmorHelmetFrames = null;
    this.ironArmorChestplateFrames = null;
    this.ironArmorLeggingsFrames = null;
    this.ironArmorBootsFrames = null;
    this.goldArmorHelmetFrames = null;
    this.goldArmorChestplateFrames = null;
    this.goldArmorLeggingsFrames = null;
    this.goldArmorBootsFrames = null;
  }
}
