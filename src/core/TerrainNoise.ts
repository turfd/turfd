/**
 * Deterministic surface-height noise: mostly flat with mild hills and rare mountains.
 *
 * Layers:
 *  1. Base roll   – gentle, low-frequency undulation  (±3 blocks)
 *  2. Detail      – small surface bumps               (±1.5 blocks)
 *  3. Mountain    – rare peaks gated by a very-low-frequency selector
 *  4. Lake        – rare low basins; smooth blend into surrounding terrain (Minecraft-style shore)
 */
import { createNoise2D } from "simplex-noise";
import {
  LAKE_BIOME_DEPTH_BLOCKS,
  LAKE_BIOME_DEPTH_JITTER_SCALE,
  LAKE_BIOME_INFLUENCE_POW,
  LAKE_BIOME_MACRO_SMOOTH_HIGH,
  LAKE_BIOME_MACRO_SMOOTH_LOW,
  LAKE_BIOME_MICRO_SMOOTH_HIGH,
  LAKE_BIOME_MICRO_SMOOTH_LOW,
  LAKE_BIOME_SCALE_BLOCKS,
  TERRAIN_BASE_SURFACE_BIAS_BLOCKS,
  WATER_SEA_LEVEL_WY,
  WORLD_Y_MAX,
  WORLD_Y_MIN,
} from "./constants";
import { mulberry32 } from "../utils/mulberry32";

/** Horizontal scale for forest/plains bands (macro noise). ~1 cycle per this many blocks. */
const BIOME_MAX_BLOCKS = 250;

/** Horizontal scale for forest-type selection (oak / birch / spruce bands). */
const FOREST_TYPE_SCALE = 400;

/**
 * Desert bands: same order of magnitude as {@link BIOME_MAX_BLOCKS} but a separate
 * noise channel (offset 777) so desert regions are large and independent of forest macro.
 */
const DESERT_SCALE_BLOCKS = 280;

/** Raw desert field above this (after smoothstep) counts as desert if forest is sparse. */
const DESERT_THRESHOLD = 0.58;

/** Forest density must stay below this so dense woods are never overridden by desert. */
const DESERT_MAX_FOREST_DENSITY = 0.22;

export type ForestType = "oak" | "birch" | "spruce";

export class TerrainNoise {
  private readonly noise2D: ReturnType<typeof createNoise2D>;

  constructor(seed: number) {
    const rng = mulberry32(seed);
    this.noise2D = createNoise2D(() => rng());
  }

  /**
   * World Y of solid surface (grass sits here). Clamped vertically.
   * Lake regions lerp terrain down toward a bed below sea level so flood-fill yields large water with smooth banks.
   */
  getSurfaceHeight(wx: number): number {
    const base = this.computeBaseSurfaceHeight(wx);
    const lakeInf = this.getLakeBiomeInfluence(wx);
    if (lakeInf <= 0) {
      return base;
    }
    const bedJitter = this.noise2D(wx * 0.07, 1305) * LAKE_BIOME_DEPTH_JITTER_SCALE;
    const lakeFloor = WATER_SEA_LEVEL_WY - LAKE_BIOME_DEPTH_BLOCKS + bedJitter;
    const blended = base * (1 - lakeInf) + lakeFloor * lakeInf;
    const h = Math.round(blended);
    const lo = WORLD_Y_MIN + 10;
    const hi = WORLD_Y_MAX - 10;
    return Math.min(hi, Math.max(lo, h));
  }

  /**
   * Lake shore / basin strength in [0, 1]. Used for height blending and generator hints (e.g. trees).
   * Zero in desert; two noise channels with smoothsteps give wide, smooth transitions and irregular lakes.
   */
  getLakeBiomeInfluence(wx: number): number {
    if (this.isDesert(wx)) {
      return 0;
    }
    const macroRaw = this.noise2D(wx / LAKE_BIOME_SCALE_BLOCKS, 1201) * 0.5 + 0.5;
    const microRaw = this.noise2D(wx / (LAKE_BIOME_SCALE_BLOCKS * 0.62), 1203) * 0.5 + 0.5;
    const macro = smoothstep(LAKE_BIOME_MACRO_SMOOTH_LOW, LAKE_BIOME_MACRO_SMOOTH_HIGH, macroRaw);
    const micro = smoothstep(LAKE_BIOME_MICRO_SMOOTH_LOW, LAKE_BIOME_MICRO_SMOOTH_HIGH, microRaw);
    const product = Math.max(0, Math.min(1, macro * micro));
    return Math.max(0, Math.min(1, product ** LAKE_BIOME_INFLUENCE_POW));
  }

  private computeBaseSurfaceHeight(wx: number): number {
    const base = this.noise2D(wx * 0.01, 0) * 5;
    const detail = this.noise2D(wx * 0.05, 0) * 2;

    const mountainSelector = this.noise2D(wx * 0.004, 100);
    const mountainFactor = Math.max(0, (mountainSelector - 0.45) / 0.55);
    const mountain = mountainFactor * mountainFactor * 40;

    const h = Math.round(
      base + detail + mountain + TERRAIN_BASE_SURFACE_BIAS_BLOCKS,
    );
    const lo = WORLD_Y_MIN + 10;
    const hi = WORLD_Y_MAX - 10;
    return Math.min(hi, Math.max(lo, h));
  }

  /**
   * Forest density field in [0..1].
   * - Macro noise uses ~{@link BIOME_MAX_BLOCKS}-block-scale bands (woods vs open ground).
   * - Mid frequency adds clumping and internal clearings inside woods.
   */
  getForestDensity(wx: number): number {
    const macroFreq = 1 / BIOME_MAX_BLOCKS;
    const macroRaw = this.noise2D(wx * macroFreq, 220);
    const patchRaw = this.noise2D(wx * 0.028, 337);
    const macro01 = macroRaw * 0.5 + 0.5;
    const patch01 = patchRaw * 0.5 + 0.5;

    // Wider smoothstep so woods/plains alternate more often and more columns reach visible density.
    const woodsBand = smoothstep(0.32, 0.72, macro01);
    const patch = 0.55 + patch01 * 0.45;
    return Math.max(0, Math.min(1, woodsBand * patch));
  }

  /**
   * Which type of forest grows at this column.
   * Uses a large-scale noise channel (separate Y offset) so you get extended
   * regions of oak, birch, and spruce forest.
   */
  getForestType(wx: number): ForestType {
    const raw = this.noise2D(wx / FOREST_TYPE_SCALE, 555);
    const t = raw * 0.5 + 0.5;
    if (t < 0.34) {
      return "oak";
    }
    if (t < 0.67) {
      return "birch";
    }
    return "spruce";
  }

  /**
   * Large-scale desert biome mask. False when forest density is high so trees and desert
   * rarely coincide on the same column.
   */
  isDesert(wx: number): boolean {
    if (this.getForestDensity(wx) >= DESERT_MAX_FOREST_DENSITY) {
      return false;
    }
    const macroRaw = this.noise2D(wx / DESERT_SCALE_BLOCKS, 777);
    const macro01 = macroRaw * 0.5 + 0.5;
    const band = smoothstep(DESERT_THRESHOLD - 0.12, DESERT_THRESHOLD + 0.18, macro01);
    return band >= 0.5;
  }
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  if (x <= edge0) {
    return 0;
  }
  if (x >= edge1) {
    return 1;
  }
  const t = (x - edge0) / (edge1 - edge0);
  return t * t * (3 - 2 * t);
}
