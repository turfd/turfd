/**
 * Round-robin pool of {@link worldGenWorker} instances. Routes per-chunk
 * `generateChunk(coord)` calls across the pool and returns the resolved
 * `Chunk` (typed arrays transferred from the worker thread, no copy on the
 * main side).
 *
 * Why not a queue with least-loaded dispatch? Round-robin is sufficient: the
 * caller (`World.loadChunksAroundCentre`) already paces dispatch via a
 * sliding-window dispatcher capped at `pool.size`, so per-worker queue depth
 * stays bounded. A least-loaded scheduler would add bookkeeping for
 * negligible gain at the steady-state 1–2 in-flight requests we observe.
 *
 * Worker failure handling: each slot gets `error` + `messageerror` listeners.
 * On either failure all pending requests routed to that slot are rejected
 * (the streaming dispatcher then falls back to inline sync gen via
 * {@link World._generateChunkAsync}'s catch), the worker is terminated, and a
 * replacement is spawned at the same slot up to {@link MAX_RESPAWNS_PER_WORKER}
 * times. Beyond that the slot stays dead and {@link size} shrinks naturally so
 * the dispatcher's concurrency adapts.
 */
import {
  createChunkFromTransferredArrays,
  type Chunk,
} from "../../chunk/Chunk";
import type { ChunkCoord } from "../../chunk/ChunkCoord";
import type { BlockRegistry } from "../../blocks/BlockRegistry";
import type { BlockDefinition } from "../../blocks/BlockDefinition";
import type { WorldGenType } from "../../../core/types";
import { WORLDGEN_WORKER_POOL_MAX } from "../../../core/constants";
import type { GeneratedStructureEntity } from "../WorldGenerator";
import type {
  WorkerOutbound,
  WorkerStructureFeature,
} from "./worldGenWorkerProtocol";

export type GeneratedChunkPayload = {
  chunk: Chunk;
  structureEntities: GeneratedStructureEntity[];
};

type PendingRequest = {
  cx: number;
  cy: number;
  workerSlot: number;
  resolve: (payload: GeneratedChunkPayload) => void;
  reject: (err: Error) => void;
};

/** Per-slot respawn budget. After this many consecutive failures the slot stays dead. */
const MAX_RESPAWNS_PER_WORKER = 3;

/**
 * Default pool size: `clamp(hardwareConcurrency - 2, 1, WORLDGEN_WORKER_POOL_MAX)`.
 * Leaves 2 cores for main thread + browser internals; capped per
 * {@link WORLDGEN_WORKER_POOL_MAX} so total worker memory stays bounded.
 */
function defaultPoolSize(): number {
  const hc =
    typeof navigator !== "undefined" &&
    typeof navigator.hardwareConcurrency === "number"
      ? navigator.hardwareConcurrency
      : 4;
  return Math.max(1, Math.min(WORLDGEN_WORKER_POOL_MAX, hc - 2));
}

/** Returns true when the runtime supports module workers via Vite's URL import pattern. */
export function isWorldGenWorkerSupported(): boolean {
  if (typeof Worker === "undefined") return false;
  if (typeof URL === "undefined") return false;
  return true;
}

export class WorldGenWorkerPool {
  /** Slot may be `null` when the worker died and respawns are exhausted. */
  private readonly workers: (Worker | null)[] = [];
  private readonly pending = new Map<number, PendingRequest>();
  /** Per-slot in-flight request ids (for selective rejection on worker death). */
  private readonly pendingByWorker: Set<number>[] = [];
  /** Per-slot respawn counter (capped by {@link MAX_RESPAWNS_PER_WORKER}). */
  private readonly respawnCount: number[] = [];
  private nextRequestId = 1;
  private nextWorkerIndex = 0;
  private destroyed = false;
  private readonly _seed: number;
  private readonly _genType: WorldGenType;
  private readonly _blockDefinitions: readonly BlockDefinition[];
  /** Most recent features broadcast — replayed to respawned workers. */
  private _latestFeatures: WorkerStructureFeature[] | null = null;

  constructor(
    seed: number,
    registry: BlockRegistry,
    genType: WorldGenType,
    poolSize: number = defaultPoolSize(),
  ) {
    this._seed = seed;
    this._genType = genType;
    this._blockDefinitions = [...registry.snapshotDefinitions()];
    for (let i = 0; i < poolSize; i += 1) {
      this.workers.push(null);
      this.pendingByWorker.push(new Set());
      this.respawnCount.push(0);
      this._spawnSlot(i);
    }
  }

  /** Number of currently *alive* worker slots. Shrinks if any slot exhausts respawns. */
  get size(): number {
    let n = 0;
    for (const w of this.workers) {
      if (w !== null) n += 1;
    }
    return n;
  }

  /** Total in-flight `generate` requests across all slots (for diagnostics / HUD). */
  getPendingCount(): number {
    return this.pending.size;
  }

  /** Broadcasts the structure feature table to every alive worker (idempotent per pool). */
  setStructureFeatures(features: readonly WorkerStructureFeature[]): void {
    if (this.destroyed) return;
    const cloned = [...features];
    this._latestFeatures = cloned;
    const msg = {
      type: "setFeatures" as const,
      features: cloned,
    };
    for (const w of this.workers) {
      if (w !== null) {
        w.postMessage(msg);
      }
    }
  }

  /**
   * Dispatch a chunk generation request to the next alive worker. The resolved
   * `Chunk` already has `dirty`/`renderDirty`/`persistDirty` set so callers
   * can `chunks.putChunk(chunk)` and it will be picked up by mesh sync,
   * persistence, and lighting paths exactly like the synchronous path did.
   *
   * Rejects when no alive workers remain (e.g. every slot exhausted respawns);
   * callers should treat rejection as a signal to fall back to inline gen.
   */
  generateChunk(coord: ChunkCoord): Promise<GeneratedChunkPayload> {
    if (this.destroyed) {
      return Promise.reject(new Error("WorldGenWorkerPool destroyed"));
    }
    const slot = this._pickNextAliveSlot();
    if (slot === -1) {
      return Promise.reject(
        new Error("WorldGenWorkerPool: no live workers available"),
      );
    }
    return new Promise((resolve, reject) => {
      const requestId = this.nextRequestId++;
      this.pending.set(requestId, {
        cx: coord.cx,
        cy: coord.cy,
        workerSlot: slot,
        resolve,
        reject,
      });
      this.pendingByWorker[slot]!.add(requestId);
      this.workers[slot]!.postMessage({
        type: "generate",
        requestId,
        cx: coord.cx,
        cy: coord.cy,
      });
    });
  }

  destroy(): void {
    this.destroyed = true;
    for (let i = 0; i < this.workers.length; i += 1) {
      const w = this.workers[i];
      if (w != null) {
        try {
          w.terminate();
        } catch {
          /* ignore */
        }
        this.workers[i] = null;
      }
      this.pendingByWorker[i]?.clear();
    }
    for (const p of this.pending.values()) {
      p.reject(new Error("WorldGenWorkerPool destroyed"));
    }
    this.pending.clear();
  }

  private _spawnSlot(slot: number): void {
    if (this.destroyed) return;
    const worker = new Worker(
      new URL("./worldGenWorker.ts", import.meta.url),
      { type: "module" },
    );
    worker.addEventListener("message", (e: MessageEvent<WorkerOutbound>) => {
      this._handleResponse(slot, e.data);
    });
    worker.addEventListener("error", (e) => {
      const msg = e instanceof ErrorEvent && e.message ? e.message : "error";
      this._handleWorkerFailure(slot, "error", msg);
    });
    worker.addEventListener("messageerror", () => {
      this._handleWorkerFailure(
        slot,
        "messageerror",
        "structured-clone failure",
      );
    });
    worker.postMessage({
      type: "init",
      seed: this._seed,
      genType: this._genType,
      blockDefinitions: this._blockDefinitions,
    });
    if (this._latestFeatures !== null) {
      worker.postMessage({
        type: "setFeatures",
        features: this._latestFeatures,
      });
    }
    this.workers[slot] = worker;
  }

  private _handleWorkerFailure(
    slot: number,
    kind: "error" | "messageerror",
    message: string,
  ): void {
    const worker = this.workers[slot];
    if (worker == null) {
      return;
    }
    if (import.meta.env.DEV) {
      console.warn(
        `[WorldGenWorkerPool] worker slot ${slot} ${kind}: ${message}`,
      );
    }
    const pendingForSlot = this.pendingByWorker[slot];
    if (pendingForSlot !== undefined) {
      for (const requestId of pendingForSlot) {
        const req = this.pending.get(requestId);
        if (req !== undefined) {
          this.pending.delete(requestId);
          req.reject(
            new Error(`WorldGen worker slot ${slot} ${kind}: ${message}`),
          );
        }
      }
      pendingForSlot.clear();
    }
    try {
      worker.terminate();
    } catch {
      /* ignore */
    }
    this.workers[slot] = null;
    if (this.destroyed) {
      return;
    }
    const used = this.respawnCount[slot] ?? 0;
    if (used >= MAX_RESPAWNS_PER_WORKER) {
      if (import.meta.env.DEV) {
        console.warn(
          `[WorldGenWorkerPool] worker slot ${slot} exhausted ${MAX_RESPAWNS_PER_WORKER} respawns; marking permanently dead.`,
        );
      }
      return;
    }
    this.respawnCount[slot] = used + 1;
    this._spawnSlot(slot);
  }

  /** Round-robin over alive slots; returns -1 when no slot is alive. */
  private _pickNextAliveSlot(): number {
    const total = this.workers.length;
    if (total === 0) {
      return -1;
    }
    for (let attempt = 0; attempt < total; attempt += 1) {
      const slot = this.nextWorkerIndex;
      this.nextWorkerIndex = (this.nextWorkerIndex + 1) % total;
      if (this.workers[slot] !== null) {
        return slot;
      }
    }
    return -1;
  }

  private _handleResponse(slot: number, msg: WorkerOutbound): void {
    const pending = this.pending.get(msg.requestId);
    if (pending === undefined) {
      if (import.meta.env.DEV) {
        console.warn(
          `[WorldGenWorkerPool] unknown response requestId=${msg.requestId} from slot ${slot}`,
        );
      }
      return;
    }
    this.pending.delete(msg.requestId);
    this.pendingByWorker[slot]?.delete(msg.requestId);
    if (msg.type === "error") {
      pending.reject(new Error(msg.message));
      return;
    }
    /**
     * Reuses the worker's transferred typed arrays directly — no copy on the
     * main thread, and avoids the ~3072 bytes of throwaway allocations that
     * `createChunk + assign` would incur per chunk.
     */
    const chunk = createChunkFromTransferredArrays(
      { cx: pending.cx, cy: pending.cy },
      msg.blocks,
      msg.background,
      msg.metadata,
    );
    pending.resolve({
      chunk,
      structureEntities: msg.structureEntities,
    });
  }
}
