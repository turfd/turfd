/**
 * JSON file export/import for full world backup (metadata + all chunks).
 */
import { CHUNK_SIZE } from "../core/constants";
import { chunkKey } from "../world/chunk/ChunkCoord";
import type { WorldMetadata, ChunkRecord } from "./IndexedDBStore";

export const STRATUM_WORLD_EXPORT_FORMAT = "stratum-world-export-v1" as const;

const CHUNK_CELL_COUNT = CHUNK_SIZE * CHUNK_SIZE;

export type StratumWorldExportChunkV1 = {
  readonly cx: number;
  readonly cy: number;
  readonly blocksB64: string;
  readonly metadataB64: string;
  readonly backgroundB64: string;
  readonly furnaces?: ChunkRecord["furnaces"];
  readonly chests?: ChunkRecord["chests"];
};

export type StratumWorldExportV1 = {
  readonly format: typeof STRATUM_WORLD_EXPORT_FORMAT;
  readonly metadata: WorldMetadata;
  readonly chunks: readonly StratumWorldExportChunkV1[];
};

function uint8ArrayToBase64(bytes: Uint8Array): string {
  const chunk = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToUint8Array(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

function u16ToB64(arr: Uint16Array): string {
  return uint8ArrayToBase64(
    new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength),
  );
}

function b64ToU16(b64: string, label: string): Uint16Array {
  const u8 = base64ToUint8Array(b64);
  if (u8.byteLength % 2 !== 0) {
    throw new Error(`Invalid ${label} data (bad length).`);
  }
  return new Uint16Array(u8.buffer, u8.byteOffset, u8.byteLength / 2);
}

function b64ToU8(b64: string): Uint8Array {
  return base64ToUint8Array(b64);
}

function expectLength(
  arr: Uint16Array | Uint8Array,
  n: number,
  label: string,
): void {
  if (arr.length !== n) {
    throw new Error(`Invalid ${label} length (expected ${n}, got ${arr.length}).`);
  }
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

export function buildStratumWorldExportV1(
  metadata: WorldMetadata,
  chunks: readonly ChunkRecord[],
): StratumWorldExportV1 {
  const wireChunks: StratumWorldExportChunkV1[] = chunks.map((rec) => {
    const blocks = rec.blocks;
    const meta = rec.metadata;
    const bg =
      rec.background !== undefined
        ? rec.background
        : new Uint16Array(CHUNK_CELL_COUNT);
    expectLength(blocks, CHUNK_CELL_COUNT, "chunk blocks");
    expectLength(meta, CHUNK_CELL_COUNT, "chunk metadata");
    expectLength(bg, CHUNK_CELL_COUNT, "chunk background");
    return {
      cx: rec.cx,
      cy: rec.cy,
      blocksB64: u16ToB64(blocks),
      metadataB64: uint8ArrayToBase64(meta),
      backgroundB64: u16ToB64(bg),
      ...(rec.furnaces !== undefined && rec.furnaces.length > 0
        ? { furnaces: rec.furnaces.map((f) => ({ ...f })) }
        : {}),
      ...(rec.chests !== undefined && rec.chests.length > 0
        ? { chests: rec.chests.map((c) => ({ ...c })) }
        : {}),
    } satisfies StratumWorldExportChunkV1;
  });
  return {
    format: STRATUM_WORLD_EXPORT_FORMAT,
    metadata: { ...metadata },
    chunks: wireChunks,
  };
}

export function parseStratumWorldImportV1(
  raw: unknown,
  newUuid: string,
): { metadata: WorldMetadata; chunks: ChunkRecord[] } {
  if (!isRecord(raw)) {
    throw new Error("Invalid file: not a JSON object.");
  }
  if (raw.format !== STRATUM_WORLD_EXPORT_FORMAT) {
    throw new Error("Not a Stratum world export (unrecognized format).");
  }
  const metaRaw = raw.metadata;
  if (!isRecord(metaRaw)) {
    throw new Error("Invalid file: missing metadata.");
  }
  const chunksRaw = raw.chunks;
  if (!Array.isArray(chunksRaw)) {
    throw new Error("Invalid file: missing chunk list.");
  }

  const metadata: WorldMetadata = {
    ...(metaRaw as unknown as WorldMetadata),
    uuid: newUuid,
    createdAt: Date.now(),
    lastPlayedAt: Date.now(),
  };

  const chunks: ChunkRecord[] = [];
  for (let i = 0; i < chunksRaw.length; i++) {
    const c = chunksRaw[i];
    if (!isRecord(c)) {
      throw new Error(`Invalid chunk entry at index ${i}.`);
    }
    const cx = c.cx;
    const cy = c.cy;
    if (typeof cx !== "number" || typeof cy !== "number") {
      throw new Error(`Invalid chunk coordinates at index ${i}.`);
    }
    const blocksB64 = c.blocksB64;
    const metadataB64 = c.metadataB64;
    const backgroundB64 = c.backgroundB64;
    if (
      typeof blocksB64 !== "string" ||
      typeof metadataB64 !== "string" ||
      typeof backgroundB64 !== "string"
    ) {
      throw new Error(`Invalid chunk payload at index ${i}.`);
    }
    const blocks = b64ToU16(blocksB64, "blocks");
    const metaBytes = b64ToU8(metadataB64);
    const background = b64ToU16(backgroundB64, "background");
    expectLength(blocks, CHUNK_CELL_COUNT, "blocks");
    expectLength(metaBytes, CHUNK_CELL_COUNT, "metadata");
    expectLength(background, CHUNK_CELL_COUNT, "background");

    const key = `${newUuid}:${chunkKey({ cx, cy })}`;
    const record: ChunkRecord = {
      key,
      worldUuid: newUuid,
      cx,
      cy,
      blocks,
      metadata: metaBytes,
      background,
    };
    const furnaces = c.furnaces;
    if (Array.isArray(furnaces) && furnaces.length > 0) {
      record.furnaces = furnaces.map((f) =>
        isRecord(f) ? { ...(f as object) } : f,
      ) as ChunkRecord["furnaces"];
    }
    const chests = c.chests;
    if (Array.isArray(chests) && chests.length > 0) {
      record.chests = chests.map((ch) =>
        isRecord(ch) ? { ...(ch as object) } : ch,
      ) as ChunkRecord["chests"];
    }
    chunks.push(record);
  }

  return { metadata, chunks };
}
