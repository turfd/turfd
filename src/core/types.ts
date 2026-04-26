import type { KeybindableAction } from "../input/bindings";
import type { NetworkMessage } from "../network/protocol/messages";
import type {
  ModComment,
  ModDetailEntry,
  ModListEntry,
  ModSortBy,
  ModTypeFilter,
} from "../mods/workshopTypes";

export type WorldGameMode = "survival" | "sandbox";

/** Back-compat parser for persisted/networked world mode values. */
export function normalizeWorldGameMode(raw: unknown): WorldGameMode {
  if (raw === "sandbox" || raw === "creative") {
    return "sandbox";
  }
  return "survival";
}

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
  | { type: "ui:perf-capture-start"; durationMs?: number }
  | {
      type: "ui:perf-capture-status";
      status: "idle" | "capturing" | "saved" | "failed";
      message: string;
      outputPath?: string;
    }
  /** In-game death overlay: respawn at world spawn (x=0). */
  | { type: "ui:death-respawn" }
  | {
      type: "ui:crash-log";
      title: string;
      message: string;
      sendStatus: string;
      log: string;
    }
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
  /** Local player or remote peer: walking on solid ground (footstep cadence). */
  | {
      type: "entity:ground-kick";
      feetWorldX: number;
      feetWorldY: number;
      velocityX: number;
      blockId: number;
    }
  | { type: "game:worldLoaded"; name: string }
  | { type: "world:loaded" }
  | { type: "window:resized" }
  | {
      type: "settings:volume";
      master: number;
      music: number;
      sfx: number;
    }
  | {
      type: "settings:apply-key-bindings";
      bindings: Record<KeybindableAction, readonly string[]>;
    }
  | {
      type: "game:block-changed";
      wx: number;
      wy: number;
      blockId: number;
      /** Set when a block was replaced (e.g. break → air); used for break particles. */
      previousBlockId?: number;
      /** Foreground vs back-wall; omit treated as foreground for older handlers. */
      layer?: "fg" | "bg";
      /** Foreground per-cell flags after change (e.g. tree no-collision); omit/0 when unused. */
      cellMetadata?: number;
    }
  | {
      type: "game:chunks-fg-bulk-updated";
      /** Chunks whose lighting was recomputed after batched foreground writes (±1 neighborhood). */
      chunkCoords: readonly { cx: number; cy: number }[];
    }
  | { type: "net:peer-joined"; peerId: string }
  | {
      type: "net:session-player";
      peerId: string;
      displayName: string;
      accountId: string;
      skinId: string;
      /** Persisted local anonymous id when peer is not signed in; empty otherwise. */
      localGuestUuid: string;
    }
  | { type: "net:peer-left"; peerId: string }
  | { type: "net:handshake-success"; isHost: boolean }
  | { type: "net:error"; message: string }
  | { type: "net:room-code"; roomCode: string | null }
  | { type: "net:message"; peerId: string; message: NetworkMessage }
  /** Multiplayer client → Game: host-authoritative break (`TERRAIN_BREAK_COMMIT`). */
  | {
      type: "terrain:net-break-commit";
      wx: number;
      wy: number;
      layer: "fg" | "bg";
      expectedBlockId: number;
      hotbarSlot: number;
      heldItemId: number;
    }
  | { type: "terrain:net-door-toggle"; wx: number; wy: number }
  | {
      type: "terrain:net-place";
      subtype: number;
      wx: number;
      wy: number;
      hotbarSlot: number;
      placesBlockId: number;
      aux: number;
    }
  | {
      type: "bow:fire-request";
      dirX: number;
      dirY: number;
      speedPx: number;
      /** Eased charge 0–1 for damage scaling (matches bow draw feel). */
      chargeNorm: number;
      shooterFeetX: number;
    }
  | {
      type: "bow:net-fire-request";
      dirX: number;
      dirY: number;
      speedPx: number;
      chargeNorm: number;
      shooterFeetX: number;
      shooterFeetY: number;
    }
  | { type: "network:world-time-received"; worldTimeMs: number }
  | { type: "world:light-updated"; chunkX: number; chunkY: number }
  | {
      type: "ui:chat-line";
      kind: "player" | "system";
      text: string;
      senderLabel?: string;
    }
  | { type: "ui:chat-set-open"; open: boolean }
  /** True while chat input is focused for typing (widen bar, hide hotbar). */
  | { type: "ui:chat-compose"; open: boolean }
  | { type: "game:chat-submit"; text: string }
  | { type: "debug:trigger-crash" }
  | { type: "game:chat-closed" }
  | { type: "craft:request"; recipeId: string; batches: number; shiftKey?: boolean }
  | { type: "craft:result"; ok: true; crafted: number; recipeId?: string; shiftKey?: boolean }
  | { type: "craft:result"; ok: false; reason: string }
  | { type: "furnace:fuel-slot-click"; button: number }
  | { type: "furnace:output-slot-click"; slotIndex: number; button: number }
  /** Remove queued smelts for this smelting JSON id and refund ingredients (host/solo). */
  | { type: "furnace:cancel-queue-request"; smeltingRecipeId: string }
  | { type: "chest:open-request"; wx: number; wy: number }
  | { type: "crafting-table:open-request"; wx: number; wy: number }
  | { type: "stonecutter:open-request"; wx: number; wy: number }
  | { type: "furnace:open-request"; wx: number; wy: number }
  | { type: "bed:sleep-request"; wx: number; wy: number }
  /** Door opened/closed by proximity (not redstone latch); latch stays closed both frames. */
  | {
      type: "door:proximity-swing";
      wx: number;
      bottomWy: number;
      opening: boolean;
    }
  | { type: "mod:install-started"; modId: string }
  | { type: "mod:install-progress"; modId: string; percent: number }
  | { type: "mod:install-complete"; modId: string }
  | { type: "mod:install-error"; modId: string; message: string }
  | { type: "mod:uninstalled"; modId: string }
  | {
      type: "workshop:request-list";
      offset: number;
      modType: ModTypeFilter;
      sortBy: ModSortBy;
      query?: string;
    }
  | {
      type: "workshop:install-requested";
      recordId: string;
      pinToWorldUuid?: string;
    }
  | { type: "workshop:library-request-updates" }
  | {
      type: "workshop:library-updates-result";
      updates: readonly {
        modId: string;
        latestRecordId: string;
        latestVersion: string;
        currentVersion: string;
      }[];
    }
  | { type: "workshop:install-record-requested"; recordId: string }
  | { type: "workshop:uninstall-requested"; modId: string; version: string }
  | {
      type: "workshop:publish-requested";
      zipBytes: Uint8Array;
      coverBytes: Uint8Array;
      displayName: string;
    }
  | {
      type: "workshop:publish-world-requested";
      worldJsonBytes: Uint8Array;
      coverBytes: Uint8Array;
      displayName: string;
      description: string;
    }
  | { type: "workshop:open-detail"; recordId: string }
  | { type: "workshop:post-comment"; recordId: string; body: string }
  | { type: "workshop:post-rating"; recordId: string; stars: number }
  | { type: "workshop:dev-folder-picked"; handle: FileSystemDirectoryHandle | null }
  | { type: "workshop:dev-zips-picked"; files: readonly { name: string; bytes: Uint8Array }[] }
  | {
      type: "workshop:dev-folder-files-picked";
      files: readonly { name: string; relativePath: string; bytes: Uint8Array }[];
    }
  | { type: "workshop:dev-sync-ok"; packCount: number }
  | { type: "workshop:dev-sync-error"; message: string }
  | {
      type: "workshop:list-result";
      records: readonly ModListEntry[];
      offset: number;
      hasMore: boolean;
    }
  | {
      type: "workshop:detail-result";
      record: ModDetailEntry;
      comments: readonly ModComment[];
    }
  | { type: "workshop:publish-result"; record: ModListEntry }
  | { type: "workshop:publish-error"; message: string }
  | {
      type: "workshop:comment-result";
      recordId: string;
      comments: readonly ModComment[];
    }
  | { type: "workshop:request-owned" }
  | { type: "workshop:owned-result"; records: readonly ModListEntry[] }
  | { type: "workshop:delete-requested"; recordId: string }
  | { type: "workshop:deleted"; recordId: string }
  | { type: "workshop:set-published-requested"; recordId: string; isPublished: boolean }
  | { type: "workshop:error"; message: string }
  /** Cosmetic: floating damage digits at a world anchor (feet Y up). */
  | {
      type: "fx:damage-number";
      worldAnchorX: number;
      worldAnchorY: number;
      damage: number;
    };

/** Dynamic world-space emissive source used by the composite placed-light path. */
export type DynamicLightEmitter = {
  worldBlockX: number;
  worldBlockY: number;
  /** Relative intensity scale (1 = regular placed torch contribution). */
  strength: number;
  /**
   * Multiplier for torch-specific bloom tip shift in the composite shader.
   * 1 = keep default torch shift, 0 = no shift (centered glow).
   */
  bloomTipShiftScale?: number;
};
