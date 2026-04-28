import { CHUNK_SIZE } from "../../core/constants";
import { worldToLocalBlock } from "../chunk/ChunkCoord";
import type { SignTileState } from "./SignTileState";

export type SignPersistedChunk = {
  lx: number;
  ly: number;
  text: string;
};

function clampInt(v: unknown, fallback: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    return fallback;
  }
  return Math.max(0, Math.floor(v));
}

export function normalizeSignPersistedChunk(raw: unknown): SignPersistedChunk | undefined {
  if (raw === null || typeof raw !== "object") {
    return undefined;
  }
  const o = raw as Record<string, unknown>;
  const lx = clampInt(o.lx, -1);
  const ly = clampInt(o.ly, -1);
  if (lx < 0 || lx >= CHUNK_SIZE || ly < 0 || ly >= CHUNK_SIZE) {
    return undefined;
  }
  const text = typeof o.text === "string" ? o.text.slice(0, 640) : "";
  return { lx, ly, text };
}

export function signTileToPersisted(wx: number, wy: number, state: SignTileState): SignPersistedChunk {
  const { lx, ly } = worldToLocalBlock(wx, wy);
  return { lx, ly, text: state.text.slice(0, 640) };
}

export function persistedToSignTile(p: SignPersistedChunk): SignTileState {
  return { text: p.text.slice(0, 640) };
}
