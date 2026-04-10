/**
 * Timed block interactions: leaf decay, grass smothering, grass spreading,
 * sapling growth, farmland moisture (dry ↔ moist near water), wheat crop growth.
 *
 * Runs each fixed tick on the authoritative side (host / offline).  Maintains a
 * time-delayed event queue so changes feel organic rather than instant.
 */

import type { EventBus } from "../core/EventBus";
import { unixRandom01 } from "../core/unixRandom";
import type { GameEvent } from "../core/types";
import { CHUNK_SIZE, WORLD_Y_MAX, WORLD_Y_MIN, WORLDGEN_NO_COLLIDE } from "../core/constants";
import type { BlockRegistry } from "./blocks/BlockRegistry";
import type { World } from "./World";
import { getBlock } from "./chunk/Chunk";
import { chunkToWorldOrigin, worldToChunk } from "./chunk/ChunkCoord";
import { forEachDeciduousBushCell, forEachSpruceBushCell } from "./gen/treeCanopy";

// ---------------------------------------------------------------------------
// Tuning knobs
// ---------------------------------------------------------------------------

/** Manhattan distance to search for supporting logs around a leaf block. */
const LEAF_SUPPORT_RADIUS = 4;

/** Base delay (seconds) before an unsupported leaf decays. */
const LEAF_DECAY_BASE_SEC = 1.5;
/** Additional random jitter so leaves don't all pop at once. */
const LEAF_DECAY_JITTER_SEC = 4;

/** Delay before a smothered grass block turns to dirt. */
const GRASS_SMOTHER_DELAY_SEC = 0.25;

/** Random delay window for dirt→grass conversion. */
const GRASS_SPREAD_MIN_SEC = 12;
const GRASS_SPREAD_MAX_SEC = 40;

/** Random dirt positions sampled per tick for grass-spread candidacy. */
const GRASS_SPREAD_SAMPLES_PER_TICK = 4;

/** Block radius around the player to sample for grass spreading. */
const GRASS_SPREAD_RADIUS = 40;

/** Cap on expired events processed in a single tick (avoids frame spikes). */
const MAX_EVENTS_PER_TICK = 12;

/** Sapling growth delay range (seconds). */
const SAPLING_GROW_MIN_SEC = 60;
const SAPLING_GROW_MAX_SEC = 180;

/** Retry delay when a sapling can't grow yet (seconds). */
const SAPLING_RETRY_MIN_SEC = 15;
const SAPLING_RETRY_MAX_SEC = 30;

/** Minimum light level at the sapling cell to count down growth. */
const SAPLING_MIN_LIGHT = 9;

/** Vertical clearance required above sapling for oak tree growth. */
const OAK_CLEARANCE = 7;

/** Vertical clearance required above sapling for spruce tree growth. */
const SPRUCE_CLEARANCE = 10;

/** Vertical clearance required above sapling for birch tree growth (taller than oak). */
const BIRCH_CLEARANCE = 9;

/** Chebyshev distance (max of |dx|,|dy|) for farmland to count water as nearby. */
const FARMLAND_WATER_RADIUS = 5;

/** Random-tick samples per fixed tick for farmland moisture (dry↔moist). */
const FARMLAND_MOISTURE_SAMPLES_PER_TICK = 4;

/** Block radius around the player to sample for farmland moisture. */
const FARMLAND_MOISTURE_SAMPLE_RADIUS = 40;

/** Delay before dry farmland becomes moist when hydrated (seconds). */
const FARMLAND_MOISTEN_MIN_SEC = 3;
const FARMLAND_MOISTEN_MAX_SEC = 12;

/** Delay before moist farmland dries when not hydrated (seconds). */
const FARMLAND_DRYOUT_MIN_SEC = 25;
const FARMLAND_DRYOUT_MAX_SEC = 55;

/** Delay between wheat growth stages (seconds). */
const WHEAT_GROW_MIN_SEC = 18;
const WHEAT_GROW_MAX_SEC = 48;

/** Delay between sugar cane growth attempts (seconds). */
const SUGARCANE_GROW_MIN_SEC = 22;
const SUGARCANE_GROW_MAX_SEC = 55;
const SUGARCANE_MAX_HEIGHT = 3;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type InteractionKind =
  | "leaf-decay"
  | "grass-smother"
  | "grass-spread"
  | "sapling-grow"
  | "farmland-moisten"
  | "farmland-dryout"
  | "wheat-grow"
  | "sugarcane-grow";

interface ScheduledEvent {
  wx: number;
  wy: number;
  kind: InteractionKind;
  remaining: number;
}

// ---------------------------------------------------------------------------
// BlockInteractions
// ---------------------------------------------------------------------------

export class BlockInteractions {
  private readonly world: World;
  private readonly registry: BlockRegistry;

  private readonly queue: ScheduledEvent[] = [];
  private readonly pending = new Set<string>();

  private readonly leafIds: ReadonlySet<number>;
  private readonly logIds: ReadonlySet<number>;
  private readonly grassId: number;
  private readonly dirtId: number;
  private readonly airId: number;
  private readonly oakSaplingId: number;
  private readonly spruceSaplingId: number;
  private readonly birchSaplingId: number;
  private readonly saplingIds: ReadonlySet<number>;
  private readonly oakLogId: number;
  private readonly spruceLogId: number;
  private readonly birchLogId: number;
  private readonly oakLeavesId: number;
  private readonly spruceLeavesId: number;
  private readonly birchLeavesId: number;
  private readonly farmlandDryId: number;
  private readonly farmlandMoistId: number;
  /** `wheat_stage_0` … `wheat_stage_7` in order. */
  private readonly wheatStageIds: readonly number[];
  private readonly wheatStageByBlockId = new Map<number, number>();
  private readonly sugarCaneId: number;
  private readonly sandId: number;
  private readonly sugarCaneHydratedChunkKeys = new Set<string>();

  /**
   * Chunk coords (`cx,cy`) whose immature wheat has already been given grow timers.
   * Without this, {@link hydrateWheatSchedulesInLoadedWorld} would rescan every loaded
   * chunk after every streaming tick (catastrophic main-thread cost).
   */
  private readonly wheatHydratedChunkKeys = new Set<string>();

  constructor(world: World, registry: BlockRegistry, bus: EventBus) {
    this.world = world;
    this.registry = registry;

    this.grassId = registry.getByIdentifier("stratum:grass").id;
    this.dirtId = registry.getByIdentifier("stratum:dirt").id;
    this.airId = registry.getByIdentifier("stratum:air").id;
    this.oakSaplingId = registry.getByIdentifier("stratum:oak_sapling").id;
    this.spruceSaplingId = registry.getByIdentifier("stratum:spruce_sapling").id;
    this.birchSaplingId = registry.getByIdentifier("stratum:birch_sapling").id;
    this.saplingIds = new Set([
      this.oakSaplingId,
      this.spruceSaplingId,
      this.birchSaplingId,
    ]);
    this.oakLogId = registry.getByIdentifier("stratum:oak_log").id;
    this.spruceLogId = registry.getByIdentifier("stratum:spruce_log").id;
    this.birchLogId = registry.getByIdentifier("stratum:birch_log").id;
    this.oakLeavesId = registry.getByIdentifier("stratum:oak_leaves").id;
    this.spruceLeavesId = registry.getByIdentifier("stratum:spruce_leaves").id;
    this.birchLeavesId = registry.getByIdentifier("stratum:birch_leaves").id;
    this.farmlandDryId = registry.getByIdentifier("stratum:farmland_dry").id;
    this.farmlandMoistId = registry.getByIdentifier("stratum:farmland_moist").id;
    this.sugarCaneId = registry.getByIdentifier("stratum:sugar_cane").id;
    this.sandId = registry.getByIdentifier("stratum:sand").id;
    this.wheatStageIds = [
      registry.getByIdentifier("stratum:wheat_stage_0").id,
      registry.getByIdentifier("stratum:wheat_stage_1").id,
      registry.getByIdentifier("stratum:wheat_stage_2").id,
      registry.getByIdentifier("stratum:wheat_stage_3").id,
      registry.getByIdentifier("stratum:wheat_stage_4").id,
      registry.getByIdentifier("stratum:wheat_stage_5").id,
      registry.getByIdentifier("stratum:wheat_stage_6").id,
      registry.getByIdentifier("stratum:wheat_stage_7").id,
    ];
    for (let i = 0; i < this.wheatStageIds.length; i++) {
      this.wheatStageByBlockId.set(this.wheatStageIds[i]!, i);
    }

    this.leafIds = new Set([
      this.oakLeavesId,
      this.spruceLeavesId,
      this.birchLeavesId,
    ]);
    this.logIds = new Set([
      registry.getByIdentifier("stratum:oak_log").id,
      registry.getByIdentifier("stratum:spruce_log").id,
      registry.getByIdentifier("stratum:birch_log").id,
    ]);

    bus.on("game:block-changed", (e) => this.onBlockChanged(e));
  }

  // -----------------------------------------------------------------------
  // Public
  // -----------------------------------------------------------------------

  /**
   * Ensures immature wheat has a pending `wheat-grow` timer. Chunks hydrated from disk (or net)
   * never emit per-cell `game:block-changed`, so crops would otherwise never advance.
   */
  hydrateWheatSchedulesInLoadedWorld(): void {
    const chunks = this.world.getChunkManager().getLoadedChunks();
    const loadedKeys = new Set<string>();
    for (const chunk of chunks) {
      loadedKeys.add(`${chunk.coord.cx},${chunk.coord.cy}`);
    }
    const staleHydrationKeys: string[] = [];
    for (const key of this.wheatHydratedChunkKeys) {
      if (!loadedKeys.has(key)) {
        staleHydrationKeys.push(key);
      }
    }
    for (const key of staleHydrationKeys) {
      this.wheatHydratedChunkKeys.delete(key);
    }
    for (const chunk of chunks) {
      const key = `${chunk.coord.cx},${chunk.coord.cy}`;
      if (this.wheatHydratedChunkKeys.has(key)) {
        continue;
      }
      const { wx: ox, wy: oy } = chunkToWorldOrigin(chunk.coord);
      for (let ly = 0; ly < CHUNK_SIZE; ly++) {
        for (let lx = 0; lx < CHUNK_SIZE; lx++) {
          const id = getBlock(chunk, lx, ly);
          if (id === this.airId) {
            continue;
          }
          const widx = this.wheatStageIndex(id);
          if (widx < 0 || widx >= 7) {
            continue;
          }
          this.scheduleWheatGrow(ox + lx, oy + ly);
        }
      }
      this.wheatHydratedChunkKeys.add(key);
    }
  }

  /**
   * Sugar cane growth uses a timed queue like wheat. Hydrate timers for loaded chunks
   * so persisted cane continues to grow.
   */
  hydrateSugarCaneSchedulesInLoadedWorld(): void {
    const chunks = this.world.getChunkManager().getLoadedChunks();
    const loadedKeys = new Set<string>();
    for (const chunk of chunks) {
      loadedKeys.add(`${chunk.coord.cx},${chunk.coord.cy}`);
    }
    const stale: string[] = [];
    for (const key of this.sugarCaneHydratedChunkKeys) {
      if (!loadedKeys.has(key)) {
        stale.push(key);
      }
    }
    for (const key of stale) {
      this.sugarCaneHydratedChunkKeys.delete(key);
    }
    for (const chunk of chunks) {
      const key = `${chunk.coord.cx},${chunk.coord.cy}`;
      if (this.sugarCaneHydratedChunkKeys.has(key)) {
        continue;
      }
      const { wx: ox, wy: oy } = chunkToWorldOrigin(chunk.coord);
      for (let ly = 0; ly < CHUNK_SIZE; ly++) {
        for (let lx = 0; lx < CHUNK_SIZE; lx++) {
          const id = getBlock(chunk, lx, ly);
          if (id !== this.sugarCaneId) {
            continue;
          }
          this.scheduleSugarCaneGrow(ox + lx, oy + ly);
        }
      }
      this.sugarCaneHydratedChunkKeys.add(key);
    }
  }

  /** Called once per fixed tick on the authority (host / offline). */
  tick(
    dtSec: number,
    playerBlockX: number,
    playerBlockY: number,
    opts?: { rainGrowthMul?: number },
  ): void {
    const growthMul = opts?.rainGrowthMul ?? 1;

    const expired: ScheduledEvent[] = [];
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const ev = this.queue[i]!;

      if (ev.kind === "sapling-grow" || ev.kind === "wheat-grow") {
        const c = worldToChunk(ev.wx, ev.wy);
        if (this.world.getChunk(c.cx, c.cy) === undefined) {
          continue;
        }
      }

      if (ev.kind === "sapling-grow") {
        const light = Math.max(
          this.world.getSkyLight(ev.wx, ev.wy),
          this.world.getBlockLight(ev.wx, ev.wy),
        );
        if (light < SAPLING_MIN_LIGHT) {
          continue;
        }
      }

      const stepMul =
        ev.kind === "sapling-grow" ||
        ev.kind === "wheat-grow" ||
        ev.kind === "grass-spread"
          ? growthMul
          : 1;
      ev.remaining -= dtSec * stepMul;
      if (ev.remaining <= 0) {
        this.queue.splice(i, 1);
        this.pending.delete(eventKey(ev.wx, ev.wy, ev.kind));
        expired.push(ev);
      }
    }

    let processed = 0;
    for (const ev of expired) {
      if (processed >= MAX_EVENTS_PER_TICK) {
        this.schedule(ev.wx, ev.wy, ev.kind, 0.05);
        continue;
      }
      this.execute(ev);
      processed++;
    }

    this.sampleGrassSpread(playerBlockX, playerBlockY);
    this.sampleFarmlandMoisture(playerBlockX, playerBlockY);
  }

  // -----------------------------------------------------------------------
  // Event handler
  // -----------------------------------------------------------------------

  private onBlockChanged(
    e: Extract<GameEvent, { type: "game:block-changed" }>,
  ): void {
    const { wx, wy, blockId } = e;

    if (blockId === 0 || blockId === this.airId) {
      this.cancelSaplingGrowAt(wx, wy);
      this.scanLeafDecayAround(wx, wy);
    }

    if (this.saplingIds.has(blockId)) {
      const delay = SAPLING_GROW_MIN_SEC +
        unixRandom01() * (SAPLING_GROW_MAX_SEC - SAPLING_GROW_MIN_SEC);
      this.schedule(wx, wy, "sapling-grow", delay);
    }

    const wheatIdx = this.wheatStageIndex(blockId);
    if (wheatIdx >= 0 && wheatIdx < 7) {
      this.scheduleWheatGrow(wx, wy);
    }
    if (blockId === this.sugarCaneId) {
      this.scheduleSugarCaneGrow(wx, wy);
    }

    const def = this.registry.getById(blockId);
    if (def.solid && !def.transparent) {
      const below = this.world.getBlock(wx, wy - 1);
      if (below.id === this.grassId) {
        this.schedule(wx, wy - 1, "grass-smother", GRASS_SMOTHER_DELAY_SEC);
      }
      if (below.id === this.farmlandDryId || below.id === this.farmlandMoistId) {
        this.world.setBlock(wx, wy - 1, this.dirtId);
      }
    }
  }

  // -----------------------------------------------------------------------
  // Leaf decay
  // -----------------------------------------------------------------------

  private scanLeafDecayAround(cx: number, cy: number): void {
    const scan = LEAF_SUPPORT_RADIUS + 1;
    for (let dx = -scan; dx <= scan; dx++) {
      for (let dy = -scan; dy <= scan; dy++) {
        const wx = cx + dx;
        const wy = cy + dy;
        const block = this.world.getBlock(wx, wy);
        if (!this.leafIds.has(block.id)) continue;
        if (this.isLeafSupported(wx, wy)) continue;

        const delay =
          LEAF_DECAY_BASE_SEC + unixRandom01() * LEAF_DECAY_JITTER_SEC;
        this.schedule(wx, wy, "leaf-decay", delay);
      }
    }
  }

  private isLeafSupported(wx: number, wy: number): boolean {
    for (let dx = -LEAF_SUPPORT_RADIUS; dx <= LEAF_SUPPORT_RADIUS; dx++) {
      for (let dy = -LEAF_SUPPORT_RADIUS; dy <= LEAF_SUPPORT_RADIUS; dy++) {
        if (Math.abs(dx) + Math.abs(dy) > LEAF_SUPPORT_RADIUS) continue;
        if (this.logIds.has(this.world.getBlock(wx + dx, wy + dy).id)) {
          return true;
        }
      }
    }
    return false;
  }

  // -----------------------------------------------------------------------
  // Grass spreading (random-tick sampling)
  // -----------------------------------------------------------------------

  private sampleGrassSpread(px: number, py: number): void {
    const r = GRASS_SPREAD_RADIUS;
    for (let i = 0; i < GRASS_SPREAD_SAMPLES_PER_TICK; i++) {
      const wx = px + Math.floor(unixRandom01() * (r * 2 + 1)) - r;
      const wy = py + Math.floor(unixRandom01() * (r * 2 + 1)) - r;

      if (this.world.getBlock(wx, wy).id !== this.dirtId) continue;
      if (this.world.getBlock(wx, wy + 1).solid) continue;
      if (!this.hasAdjacentGrass(wx, wy)) continue;

      const delay =
        GRASS_SPREAD_MIN_SEC +
        unixRandom01() * (GRASS_SPREAD_MAX_SEC - GRASS_SPREAD_MIN_SEC);
      this.schedule(wx, wy, "grass-spread", delay);
    }
  }

  private hasAdjacentGrass(wx: number, wy: number): boolean {
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        if (dx === 0 && dy === 0) continue;
        if (this.world.getBlock(wx + dx, wy + dy).id === this.grassId) {
          return true;
        }
      }
    }
    return false;
  }

  // -----------------------------------------------------------------------
  // Farmland moisture (random-tick style near player)
  // -----------------------------------------------------------------------

  /** True if any water block lies within Chebyshev radius {@link FARMLAND_WATER_RADIUS}. */
  private isNearFarmlandWater(wx: number, wy: number): boolean {
    const r = FARMLAND_WATER_RADIUS;
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        if (this.world.getBlock(wx + dx, wy + dy).water) {
          return true;
        }
      }
    }
    return false;
  }

  private sampleFarmlandMoisture(px: number, py: number): void {
    const rad = FARMLAND_MOISTURE_SAMPLE_RADIUS;
    for (let i = 0; i < FARMLAND_MOISTURE_SAMPLES_PER_TICK; i++) {
      const wx = px + Math.floor(unixRandom01() * (rad * 2 + 1)) - rad;
      const wy = py + Math.floor(unixRandom01() * (rad * 2 + 1)) - rad;

      const id = this.world.getBlock(wx, wy).id;
      if (id === this.farmlandDryId && this.isNearFarmlandWater(wx, wy)) {
        const delay =
          FARMLAND_MOISTEN_MIN_SEC +
          unixRandom01() * (FARMLAND_MOISTEN_MAX_SEC - FARMLAND_MOISTEN_MIN_SEC);
        this.schedule(wx, wy, "farmland-moisten", delay);
      } else if (id === this.farmlandMoistId && !this.isNearFarmlandWater(wx, wy)) {
        const delay =
          FARMLAND_DRYOUT_MIN_SEC +
          unixRandom01() * (FARMLAND_DRYOUT_MAX_SEC - FARMLAND_DRYOUT_MIN_SEC);
        this.schedule(wx, wy, "farmland-dryout", delay);
      }
    }
  }

  // -----------------------------------------------------------------------
  // Scheduling
  // -----------------------------------------------------------------------

  private scheduleWheatGrow(wx: number, wy: number): void {
    const delay =
      WHEAT_GROW_MIN_SEC +
      unixRandom01() * (WHEAT_GROW_MAX_SEC - WHEAT_GROW_MIN_SEC);
    this.schedule(wx, wy, "wheat-grow", delay);
  }

  private scheduleSugarCaneGrow(wx: number, wy: number): void {
    const delay =
      SUGARCANE_GROW_MIN_SEC +
      unixRandom01() * (SUGARCANE_GROW_MAX_SEC - SUGARCANE_GROW_MIN_SEC);
    this.schedule(wx, wy, "sugarcane-grow", delay);
  }

  /** Drop queued sapling timers for this cell (e.g. sapling broken or replaced). */
  private cancelSaplingGrowAt(wx: number, wy: number): void {
    const key = eventKey(wx, wy, "sapling-grow");
    this.pending.delete(key);
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const ev = this.queue[i]!;
      if (ev.kind === "sapling-grow" && ev.wx === wx && ev.wy === wy) {
        this.queue.splice(i, 1);
        this.pending.delete(eventKey(ev.wx, ev.wy, ev.kind));
      }
    }
  }

  private schedule(
    wx: number,
    wy: number,
    kind: InteractionKind,
    delay: number,
  ): void {
    const key = eventKey(wx, wy, kind);
    if (this.pending.has(key)) return;
    this.pending.add(key);
    this.queue.push({ wx, wy, kind, remaining: delay });
  }

  // -----------------------------------------------------------------------
  // Execution
  // -----------------------------------------------------------------------

  private execute(ev: ScheduledEvent): void {
    switch (ev.kind) {
      case "leaf-decay":
        this.execLeafDecay(ev.wx, ev.wy);
        break;
      case "grass-smother":
        this.execGrassSmother(ev.wx, ev.wy);
        break;
      case "grass-spread":
        this.execGrassSpread(ev.wx, ev.wy);
        break;
      case "sapling-grow":
        this.execSaplingGrow(ev.wx, ev.wy);
        break;
      case "farmland-moisten":
        this.execFarmlandMoisten(ev.wx, ev.wy);
        break;
      case "farmland-dryout":
        this.execFarmlandDryout(ev.wx, ev.wy);
        break;
      case "wheat-grow":
        this.execWheatGrow(ev.wx, ev.wy);
        break;
      case "sugarcane-grow":
        this.execSugarCaneGrow(ev.wx, ev.wy);
        break;
    }
  }

  private execLeafDecay(wx: number, wy: number): void {
    const block = this.world.getBlock(wx, wy);
    if (!this.leafIds.has(block.id)) return;
    if (this.isLeafSupported(wx, wy)) return;

    this.world.spawnLootForBrokenBlock(block.id, wx, wy);
    this.world.setBlock(wx, wy, this.airId);
  }

  private execGrassSmother(wx: number, wy: number): void {
    if (this.world.getBlock(wx, wy).id !== this.grassId) return;
    const above = this.world.getBlock(wx, wy + 1);
    if (!above.solid || above.transparent) return;

    this.world.setBlock(wx, wy, this.dirtId);
  }

  private execGrassSpread(wx: number, wy: number): void {
    if (this.world.getBlock(wx, wy).id !== this.dirtId) return;
    if (this.world.getBlock(wx, wy + 1).solid) return;
    if (!this.hasAdjacentGrass(wx, wy)) return;

    this.world.setBlock(wx, wy, this.grassId);
  }

  private execFarmlandMoisten(wx: number, wy: number): void {
    if (this.world.getBlock(wx, wy).id !== this.farmlandDryId) return;
    if (!this.isNearFarmlandWater(wx, wy)) return;
    this.world.setBlock(wx, wy, this.farmlandMoistId);
  }

  private execFarmlandDryout(wx: number, wy: number): void {
    if (this.world.getBlock(wx, wy).id !== this.farmlandMoistId) return;
    if (this.isNearFarmlandWater(wx, wy)) return;
    this.world.setBlock(wx, wy, this.farmlandDryId);
  }

  /** Index 0–7 for wheat stages, or -1 if not a wheat crop block. */
  private wheatStageIndex(blockId: number): number {
    return this.wheatStageByBlockId.get(blockId) ?? -1;
  }

  private execWheatGrow(wx: number, wy: number): void {
    const id = this.world.getBlock(wx, wy).id;
    const idx = this.wheatStageIndex(id);
    if (idx < 0 || idx >= 7) {
      return;
    }
    this.world.setBlock(wx, wy, this.wheatStageIds[idx + 1]!);
  }

  private execSugarCaneGrow(wx: number, wy: number): void {
    if (this.world.getBlock(wx, wy).id !== this.sugarCaneId) {
      return;
    }

    // Find base of the column.
    let baseY = wy;
    while (baseY - 1 >= WORLD_Y_MIN && this.world.getBlock(wx, baseY - 1).id === this.sugarCaneId) {
      baseY -= 1;
    }

    // Compute height and top.
    let topY = baseY;
    let h = 1;
    while (topY + 1 <= WORLD_Y_MAX && this.world.getBlock(wx, topY + 1).id === this.sugarCaneId) {
      topY += 1;
      h += 1;
      if (h >= SUGARCANE_MAX_HEIGHT) {
        break;
      }
    }

    // Validate base rules (adjacent water, on sand/grass/dirt) when column is grounded.
    const belowBase = this.world.getBlock(wx, baseY - 1);
    const soilOk =
      belowBase.id === this.sandId ||
      belowBase.identifier === "stratum:grass" ||
      belowBase.identifier === "stratum:dirt";
    const soilY = baseY - 1;
    const waterOk =
      this.world.getBlock(wx - 1, soilY).water ||
      this.world.getBlock(wx + 1, soilY).water ||
      this.world.getBlock(wx, soilY - 1).water ||
      this.world.getBlock(wx, soilY + 1).water ||
      this.world.getBlock(wx - 1, soilY - 1).water ||
      this.world.getBlock(wx + 1, soilY - 1).water;

    if (!soilOk || !waterOk) {
      this.scheduleSugarCaneGrow(wx, wy);
      return;
    }

    if (h < SUGARCANE_MAX_HEIGHT) {
      const aboveTop = this.world.getBlock(wx, topY + 1);
      if (aboveTop.id === this.airId || (aboveTop.replaceable && aboveTop.id !== this.airId)) {
        if (aboveTop.id !== this.airId) {
          this.world.spawnLootForBrokenBlock(aboveTop.id, wx, topY + 1);
          this.world.setBlock(wx, topY + 1, this.airId);
        }
        this.world.setBlock(wx, topY + 1, this.sugarCaneId, { cellMetadata: WORLDGEN_NO_COLLIDE });
      }
    }

    this.scheduleSugarCaneGrow(wx, wy);
  }

  // -----------------------------------------------------------------------
  // Sapling growth
  // -----------------------------------------------------------------------

  private execSaplingGrow(wx: number, wy: number): void {
    const blockId = this.world.getBlock(wx, wy).id;
    if (!this.saplingIds.has(blockId)) return;

    if (blockId === this.spruceSaplingId) {
      if (!this.canGrowSpruce(wx, wy)) {
        this.retrySapling(wx, wy);
        return;
      }
      this.growSpruceTree(wx, wy);
      return;
    }

    if (blockId === this.birchSaplingId) {
      if (!this.canGrowBirch(wx, wy)) {
        this.retrySapling(wx, wy);
        return;
      }
      this.growBirchTree(wx, wy);
      return;
    }

    if (!this.canGrowOak(wx, wy)) {
      this.retrySapling(wx, wy);
      return;
    }
    this.growOakTree(wx, wy);
  }

  private retrySapling(wx: number, wy: number): void {
    const retry = SAPLING_RETRY_MIN_SEC +
      unixRandom01() * (SAPLING_RETRY_MAX_SEC - SAPLING_RETRY_MIN_SEC);
    this.schedule(wx, wy, "sapling-grow", retry);
  }

  // -- Clearance checks ----------------------------------------------------

  /** Sapling sits in `wy`; ground must be grass, dirt, or farmland (not stone, etc.). */
  private isSoilGroundBelowSapling(wx: number, wy: number): boolean {
    const ground = this.world.getBlock(wx, wy - 1);
    const id = ground.id;
    return (
      id === this.grassId ||
      id === this.dirtId ||
      id === this.farmlandDryId ||
      id === this.farmlandMoistId
    );
  }

  private canGrowOak(wx: number, wy: number): boolean {
    if (!this.isSoilGroundBelowSapling(wx, wy)) {
      return false;
    }
    for (let dy = 1; dy <= OAK_CLEARANCE; dy++) {
      const blk = this.world.getBlock(wx, wy + dy);
      if (blk.id !== this.airId && !blk.replaceable) return false;
    }
    for (let dy = 3; dy <= OAK_CLEARANCE; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        if (dx === 0) continue;
        const blk = this.world.getBlock(wx + dx, wy + dy);
        if (blk.id !== this.airId && !blk.replaceable) return false;
      }
    }
    return true;
  }

  private canGrowSpruce(wx: number, wy: number): boolean {
    if (!this.isSoilGroundBelowSapling(wx, wy)) {
      return false;
    }
    for (let dy = 1; dy <= SPRUCE_CLEARANCE; dy++) {
      const blk = this.world.getBlock(wx, wy + dy);
      if (blk.id !== this.airId && !blk.replaceable) return false;
    }
    for (let dy = 2; dy <= SPRUCE_CLEARANCE; dy++) {
      for (let dx = -3; dx <= 3; dx++) {
        if (dx === 0) continue;
        const blk = this.world.getBlock(wx + dx, wy + dy);
        if (blk.id !== this.airId && !blk.replaceable) return false;
      }
    }
    return true;
  }

  private canGrowBirch(wx: number, wy: number): boolean {
    if (!this.isSoilGroundBelowSapling(wx, wy)) {
      return false;
    }
    for (let dy = 1; dy <= BIRCH_CLEARANCE; dy++) {
      const blk = this.world.getBlock(wx, wy + dy);
      if (blk.id !== this.airId && !blk.replaceable) return false;
    }
    for (let dy = 3; dy <= BIRCH_CLEARANCE; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        if (dx === 0) continue;
        const blk = this.world.getBlock(wx + dx, wy + dy);
        if (blk.id !== this.airId && !blk.replaceable) return false;
      }
    }
    return true;
  }

  // -- Tree placement ------------------------------------------------------

  private growOakTree(wx: number, wy: number): void {
    const trunkHeight = 4;
    // Match WorldGenerator: first trunk at sapling Y (surfaceY+1); crown one cell above old trunk top.
    const canopyCy = wy + 4;
    const radiusX = 2;
    const radiusY = 2;

    this.placeTrunkFromSapling(wx, wy, trunkHeight, this.oakLogId);

    forEachDeciduousBushCell(wx, canopyCy, radiusX, radiusY, (cx, cy) => {
      this.placeTreeBlock(cx, cy, this.oakLeavesId);
    });
  }

  private growBirchTree(wx: number, wy: number): void {
    const trunkHeight = 5;
    const canopyCy = wy + 5;
    const radiusX = 2;
    const radiusY = 2;

    this.placeTrunkFromSapling(wx, wy, trunkHeight, this.birchLogId);

    forEachDeciduousBushCell(wx, canopyCy, radiusX, radiusY, (cx, cy) => {
      this.placeTreeBlock(cx, cy, this.birchLeavesId);
    });
  }

  private growSpruceTree(wx: number, wy: number): void {
    const trunkHeight = 7;
    const canopyStartDy = 2;
    const canopyLayers: readonly number[] = [0, 1, 1, 2, 2, 3, 3];

    // Sapling sits at surfaceY+1; worldgen uses surfaceY + canopyStartDy for canopy base.
    const surfaceY = wy - 1;
    const canopyBottom = surfaceY + canopyStartDy;

    this.placeTrunkFromSapling(wx, wy, trunkHeight, this.spruceLogId);

    forEachSpruceBushCell(wx, canopyBottom, canopyLayers, (cx, cy) => {
      this.placeTreeBlock(cx, cy, this.spruceLeavesId);
    });
  }

  /** Bottom log always replaces the sapling cell; upper segments respect replaceable/air. */
  private placeTrunkFromSapling(
    wx: number,
    wy: number,
    height: number,
    logId: number,
  ): void {
    this.world.setBlock(wx, wy, logId, { cellMetadata: WORLDGEN_NO_COLLIDE });
    for (let dy = 1; dy < height; dy++) {
      this.placeTreeBlock(wx, wy + dy, logId);
    }
  }

  private placeTreeBlock(wx: number, wy: number, blockId: number): void {
    const existing = this.world.getBlock(wx, wy);
    if (existing.id !== this.airId && !existing.replaceable && !this.leafIds.has(existing.id)) {
      return;
    }
    this.world.setBlock(wx, wy, blockId, {
      cellMetadata: WORLDGEN_NO_COLLIDE,
    });
  }
}

function eventKey(wx: number, wy: number, kind: InteractionKind): string {
  return `${wx},${wy},${kind}`;
}
