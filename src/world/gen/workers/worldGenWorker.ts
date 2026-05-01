/// <reference lib="webworker" />
/**
 * Dedicated worker that hosts a {@link WorldGenerator} instance and answers
 * `generate(coord)` requests from {@link WorldGenWorkerPool}. The procedural
 * cost (terrain noise + caves + ores + sediment + sea-level flood + surface
 * vegetation + structure features) runs entirely off the main thread; only
 * typed-array buffers cross the postMessage boundary (transferred, not copied).
 *
 * Lifecycle:
 *  1. `init` — construct {@link BlockRegistry} from the snapshot and
 *     {@link WorldGenerator} from `(seed, registry, genType)`.
 *  2. `setFeatures` (optional, broadcast from pool) — forwards to
 *     `generator.setStructureFeatures(...)`.
 *  3. `generate` — runs the combined `generateChunkWithEntities` pipeline
 *     (single-pass structure resolution shared between block stamping and
 *     entity extraction), posts back a {@link WorkerGenerateResponse} with
 *     the chunk's typed arrays as transferables.
 */
import { BlockRegistry } from "../../blocks/BlockRegistry";
import { WorldGenerator } from "../WorldGenerator";
import type {
  WorkerInbound,
  WorkerOutbound,
} from "./worldGenWorkerProtocol";

let generator: WorldGenerator | null = null;

const ctx: DedicatedWorkerGlobalScope =
  self as DedicatedWorkerGlobalScope & typeof globalThis;

ctx.addEventListener("message", (e: MessageEvent<WorkerInbound>) => {
  const msg = e.data;
  if (msg.type === "init") {
    const reg = new BlockRegistry();
    for (const def of msg.blockDefinitions) {
      reg.register(def);
    }
    generator = new WorldGenerator(msg.seed, reg, msg.genType);
    return;
  }
  if (msg.type === "setFeatures") {
    if (generator !== null) {
      generator.setStructureFeatures([...msg.features]);
    }
    return;
  }
  if (msg.type === "generate") {
    if (generator === null) {
      const err: WorkerOutbound = {
        type: "error",
        requestId: msg.requestId,
        message: "WorldGen worker not initialized before generate request",
      };
      ctx.postMessage(err);
      return;
    }
    try {
      const coord = { cx: msg.cx, cy: msg.cy };
      const { chunk, structureEntities } = generator.generateChunkWithEntities(coord);
      const response: WorkerOutbound = {
        type: "generated",
        requestId: msg.requestId,
        cx: msg.cx,
        cy: msg.cy,
        blocks: chunk.blocks,
        background: chunk.background,
        metadata: chunk.metadata,
        structureEntities,
      };
      const transfers: Transferable[] = [
        chunk.blocks.buffer,
        chunk.background.buffer,
        chunk.metadata.buffer,
      ];
      ctx.postMessage(response, transfers);
    } catch (err) {
      const errResp: WorkerOutbound = {
        type: "error",
        requestId: msg.requestId,
        message: err instanceof Error ? err.message : String(err),
      };
      ctx.postMessage(errResp);
    }
  }
});
