import type { NetworkMessage } from "../network/protocol/messages";

/**
 * Application-wide events for EventBus (extend as systems are added).
 * Discriminated by `type` for exhaustive handling.
 */
export type GameEvent =
  | { type: "game:started" }
  | { type: "game:stopped" }
  | {
      type: "game:tick";
      tickIndex: number;
      dtSec: number;
      worldTimeMs: number;
    }
  /** Normalised phase [0,1): 0 = dawn start. Host/offline only in multiplayer. */
  | { type: "ui:set-world-time-phase"; phase: number }
  | { type: "game:render"; alpha: number }
  | { type: "player:hotbarChanged"; slot: number }
  | { type: "game:saved" }
  | { type: "ui:save" }
  | { type: "ui:close-pause" }
  | { type: "ui:quit" }
  | { type: "ui:toggle-multiplayer" }
  | { type: "ui:session-ended"; message: string }
  | {
      type: "ui:lobby-join";
      signalingHost: string;
      port: number;
      hostPeerId: string;
    }
  | { type: "ui:lobby-offline" }
  | { type: "ui:lan-host"; signalingHost: string; port: number }
  | { type: "ui:lan-close" }
  | {
      type: "net:lan-status";
      status: "idle" | "opening" | "listening" | "error";
      hostPeerId?: string;
      message?: string;
    }
  | { type: "game:network-role"; role: "offline" | "host" | "client" }
  | {
      type: "player:moved";
      wx: number;
      wy: number;
      blockX: number;
      blockY: number;
    }
  | { type: "game:worldLoaded"; name: string }
  | {
      type: "settings:volume";
      master: number;
      music: number;
      sfx: number;
    }
  | {
      type: "network:chunk-received";
      chunkX: number;
      chunkY: number;
      blocks: Uint16Array;
      background?: Uint16Array;
    }
  | {
      type: "network:chunk-send-request";
      peerId: string;
      chunkX: number;
      chunkY: number;
    }
  | {
      type: "game:block-changed";
      wx: number;
      wy: number;
      blockId: number;
      /** Foreground vs back-wall; omit treated as foreground for older handlers. */
      layer?: "fg" | "bg";
    }
  | { type: "net:peer-joined"; peerId: string }
  | { type: "net:peer-left"; peerId: string }
  | { type: "net:handshake-success"; isHost: boolean }
  | { type: "net:error"; message: string }
  | { type: "net:room-code"; roomCode: string | null }
  | { type: "net:message"; peerId: string; message: NetworkMessage }
  | { type: "network:world-time-received"; worldTimeMs: number }
  | { type: "world:light-updated"; chunkX: number; chunkY: number }
  | { type: "ui:screenshot" };
