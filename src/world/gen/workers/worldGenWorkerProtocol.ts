/**
 * Wire protocol between the main thread and {@link WorldGenWorkerPool} workers.
 *
 * All payloads are structured-clone safe; chunk typed arrays are transferred
 * (not copied) to avoid the per-chunk ~6 KB main-thread copy cost.
 */
import type { BlockDefinition } from "../../blocks/BlockDefinition";
import type { ChunkCoord } from "../../chunk/ChunkCoord";
import type { WorldGenType } from "../../../core/types";
import type { ParsedStructure } from "../../structure/structureSchema";
import type { StructureFeatureEntry } from "../../structure/StructureRegistry";
import type { GeneratedStructureEntity } from "../WorldGenerator";

/** Mirrors {@link World.setStructureFeatures} input, kept clone-safe (plain data). */
export type WorkerStructureFeature = {
  identifier: string;
  structures: ParsedStructure[];
  placement: StructureFeatureEntry["placement"];
};

export type WorkerInitMessage = {
  type: "init";
  seed: number;
  genType: WorldGenType;
  /**
   * Full block definition table in numeric-id order
   * (see {@link BlockRegistry.snapshotDefinitions}). Sent once at worker
   * startup; the worker re-registers entries to obtain identical ids.
   */
  blockDefinitions: readonly BlockDefinition[];
};

export type WorkerSetFeaturesMessage = {
  type: "setFeatures";
  features: readonly WorkerStructureFeature[];
};

export type WorkerGenerateRequest = {
  type: "generate";
  /** Round-trip correlation id assigned by {@link WorldGenWorkerPool}. */
  requestId: number;
  cx: number;
  cy: number;
};

export type WorkerInbound =
  | WorkerInitMessage
  | WorkerSetFeaturesMessage
  | WorkerGenerateRequest;

export type WorkerGenerateResponse = {
  type: "generated";
  requestId: number;
  cx: number;
  cy: number;
  /** Transferred from worker — main thread owns the buffer after receipt. */
  blocks: Uint16Array;
  background: Uint16Array;
  metadata: Uint8Array;
  structureEntities: GeneratedStructureEntity[];
};

export type WorkerErrorResponse = {
  type: "error";
  requestId: number;
  message: string;
};

export type WorkerOutbound = WorkerGenerateResponse | WorkerErrorResponse;

export type { ChunkCoord };
