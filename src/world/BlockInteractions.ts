/**
 * Timed block interactions: leaf decay, grass smothering, grass spreading,
 * sapling growth.
 *
 * Runs each fixed tick on the authoritative side (host / offline).  Maintains a
 * time-delayed event queue so changes feel organic rather than instant.
 */

import type { EventBus } from "../core/EventBus";
import type { GameEvent } from "../core/types";
import { WORLDGEN_NO_COLLIDE } from "../core/constants";
import type { BlockRegistry } from "./blocks/BlockRegistry";
import type { World } from "./World";

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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type InteractionKind = "leaf-decay" | "grass-smother" | "grass-spread" | "sapling-grow";

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
  private readonly bus: EventBus;

  private readonly queue: ScheduledEvent[] = [];
  private readonly pending = new Set<string>();

  private readonly leafIds: ReadonlySet<number>;
  private readonly logIds: ReadonlySet<number>;
  private readonly grassId: number;
  private readonly dirtId: number;
  private readonly airId: number;
  private readonly oakSaplingId: number;
  private readonly spruceSaplingId: number;
  private readonly saplingIds: ReadonlySet<number>;
  private readonly oakLogId: number;
  private readonly spruceLogId: number;
  private readonly leavesId: number;

  constructor(world: World, registry: BlockRegistry, bus: EventBus) {
    this.world = world;
    this.registry = registry;
    this.bus = bus;

    this.grassId = registry.getByIdentifier("stratum:grass").id;
    this.dirtId = registry.getByIdentifier("stratum:dirt").id;
    this.airId = registry.getByIdentifier("stratum:air").id;
    this.oakSaplingId = registry.getByIdentifier("stratum:oak_sapling").id;
    this.spruceSaplingId = registry.getByIdentifier("stratum:spruce_sapling").id;
    this.saplingIds = new Set([this.oakSaplingId, this.spruceSaplingId]);
    this.oakLogId = registry.getByIdentifier("stratum:oak_log").id;
    this.spruceLogId = registry.getByIdentifier("stratum:spruce_log").id;
    this.leavesId = registry.getByIdentifier("stratum:leaves").id;

    this.leafIds = new Set([
      registry.getByIdentifier("stratum:leaves").id,
    ]);
    this.logIds = new Set([
      registry.getByIdentifier("stratum:oak_log").id,
      registry.getByIdentifier("stratum:spruce_log").id,
    ]);

    bus.on("game:block-changed", (e) => this.onBlockChanged(e));
  }

  // -----------------------------------------------------------------------
  // Public
  // -----------------------------------------------------------------------

  /** Called once per fixed tick on the authority (host / offline). */
  tick(dtSec: number, playerBlockX: number, playerBlockY: number): void {
    const expired: ScheduledEvent[] = [];
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const ev = this.queue[i]!;

      if (ev.kind === "sapling-grow") {
        const light = Math.max(
          this.world.getSkyLight(ev.wx, ev.wy),
          this.world.getBlockLight(ev.wx, ev.wy),
        );
        if (light < SAPLING_MIN_LIGHT) {
          continue;
        }
      }

      ev.remaining -= dtSec;
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
  }

  // -----------------------------------------------------------------------
  // Event handler
  // -----------------------------------------------------------------------

  private onBlockChanged(
    e: Extract<GameEvent, { type: "game:block-changed" }>,
  ): void {
    const { wx, wy, blockId } = e;

    if (blockId === 0 || blockId === this.airId) {
      this.scanLeafDecayAround(wx, wy);
    }

    if (this.saplingIds.has(blockId)) {
      const delay = SAPLING_GROW_MIN_SEC +
        Math.random() * (SAPLING_GROW_MAX_SEC - SAPLING_GROW_MIN_SEC);
      this.schedule(wx, wy, "sapling-grow", delay);
    }

    const def = this.registry.getById(blockId);
    if (def.solid && !def.transparent) {
      const below = this.world.getBlock(wx, wy - 1);
      if (below.id === this.grassId) {
        this.schedule(wx, wy - 1, "grass-smother", GRASS_SMOTHER_DELAY_SEC);
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
          LEAF_DECAY_BASE_SEC + Math.random() * LEAF_DECAY_JITTER_SEC;
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
      const wx = px + Math.floor(Math.random() * (r * 2 + 1)) - r;
      const wy = py + Math.floor(Math.random() * (r * 2 + 1)) - r;

      if (this.world.getBlock(wx, wy).id !== this.dirtId) continue;
      if (this.world.getBlock(wx, wy + 1).solid) continue;
      if (!this.hasAdjacentGrass(wx, wy)) continue;

      const delay =
        GRASS_SPREAD_MIN_SEC +
        Math.random() * (GRASS_SPREAD_MAX_SEC - GRASS_SPREAD_MIN_SEC);
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
  // Scheduling
  // -----------------------------------------------------------------------

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
    }
  }

  private execLeafDecay(wx: number, wy: number): void {
    const block = this.world.getBlock(wx, wy);
    if (!this.leafIds.has(block.id)) return;
    if (this.isLeafSupported(wx, wy)) return;

    this.world.spawnLootForBrokenBlock(block.id, wx, wy);
    this.world.setBlock(wx, wy, this.airId);
    this.emitBlockChanged(wx, wy, 0);
  }

  private execGrassSmother(wx: number, wy: number): void {
    if (this.world.getBlock(wx, wy).id !== this.grassId) return;
    const above = this.world.getBlock(wx, wy + 1);
    if (!above.solid || above.transparent) return;

    this.world.setBlock(wx, wy, this.dirtId);
    this.emitBlockChanged(wx, wy, this.dirtId);
  }

  private execGrassSpread(wx: number, wy: number): void {
    if (this.world.getBlock(wx, wy).id !== this.dirtId) return;
    if (this.world.getBlock(wx, wy + 1).solid) return;
    if (!this.hasAdjacentGrass(wx, wy)) return;

    this.world.setBlock(wx, wy, this.grassId);
    this.emitBlockChanged(wx, wy, this.grassId);
  }

  // -----------------------------------------------------------------------
  // Sapling growth
  // -----------------------------------------------------------------------

  private execSaplingGrow(wx: number, wy: number): void {
    const blockId = this.world.getBlock(wx, wy).id;
    if (!this.saplingIds.has(blockId)) return;

    const isSpruce = blockId === this.spruceSaplingId;

    if (isSpruce) {
      if (!this.canGrowSpruce(wx, wy)) {
        this.retrySapling(wx, wy);
        return;
      }
      this.growSpruceTree(wx, wy);
    } else {
      if (!this.canGrowOak(wx, wy)) {
        this.retrySapling(wx, wy);
        return;
      }
      this.growOakTree(wx, wy);
    }
  }

  private retrySapling(wx: number, wy: number): void {
    const retry = SAPLING_RETRY_MIN_SEC +
      Math.random() * (SAPLING_RETRY_MAX_SEC - SAPLING_RETRY_MIN_SEC);
    this.schedule(wx, wy, "sapling-grow", retry);
  }

  // -- Clearance checks ----------------------------------------------------

  private canGrowOak(wx: number, wy: number): boolean {
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

  // -- Tree placement ------------------------------------------------------

  private growOakTree(wx: number, wy: number): void {
    const trunkHeight = 4;
    const canopyCy = wy + 5;
    const radiusX = 2;
    const radiusY = 2;

    this.world.setBlock(wx, wy, this.airId);

    for (let dy = -radiusY; dy <= radiusY; dy++) {
      for (let dx = -radiusX; dx <= radiusX; dx++) {
        const nx = dx / radiusX;
        const ny = dy / radiusY;
        if (nx * nx + ny * ny > 1) continue;
        this.placeTreeBlock(wx + dx, canopyCy + dy, this.leavesId);
      }
    }

    for (let dy = 0; dy < trunkHeight; dy++) {
      this.placeTreeBlock(wx, wy + dy + 1, this.oakLogId);
    }

    this.emitBlockChanged(wx, wy, this.airId);
  }

  private growSpruceTree(wx: number, wy: number): void {
    const trunkHeight = 7;
    const canopyStartDy = 2;
    const canopyLayers: readonly number[] = [0, 1, 1, 2, 2, 3, 3];

    this.world.setBlock(wx, wy, this.airId);

    const canopyBottom = wy + canopyStartDy;
    for (let i = 0; i < canopyLayers.length; i++) {
      const cy = canopyBottom + i;
      const halfW = canopyLayers[canopyLayers.length - 1 - i]!;
      for (let dx = -halfW; dx <= halfW; dx++) {
        this.placeTreeBlock(wx + dx, cy, this.leavesId);
      }
    }

    for (let dy = 1; dy <= trunkHeight; dy++) {
      this.placeTreeBlock(wx, wy + dy, this.spruceLogId);
    }

    this.emitBlockChanged(wx, wy, this.airId);
  }

  private placeTreeBlock(wx: number, wy: number, blockId: number): void {
    const existing = this.world.getBlock(wx, wy);
    if (existing.id !== this.airId && !existing.replaceable && existing.id !== this.leavesId) {
      return;
    }
    this.world.setBlock(wx, wy, blockId);
    this.world.setMetadata(wx, wy, WORLDGEN_NO_COLLIDE);
    this.emitBlockChanged(wx, wy, blockId);
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private emitBlockChanged(wx: number, wy: number, blockId: number): void {
    this.bus.emit({
      type: "game:block-changed",
      wx,
      wy,
      blockId,
      layer: "fg",
    } satisfies GameEvent);
  }
}

function eventKey(wx: number, wy: number, kind: InteractionKind): string {
  return `${wx},${wy},${kind}`;
}
