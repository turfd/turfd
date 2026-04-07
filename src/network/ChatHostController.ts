/**
 * Host-side chat relay and slash commands (operators + host).
 */

import type { PeerId } from "./INetworkAdapter";
import type { PeerJSAdapter } from "./PeerJSAdapter";
import {
  normalizeModerationName,
  type ModerationEntry,
  type WorldModerationState,
} from "./moderation/WorldModerationState";
import { MessageType, type NetworkMessage } from "./protocol/messages";

export type SessionRosterEntry = {
  displayName: string;
  accountId: string;
};

function splitCommand(line: string): { cmd: string; rest: string } {
  const t = line.trim();
  if (!t.startsWith("/")) {
    return { cmd: "", rest: t };
  }
  const space = t.indexOf(" ");
  if (space < 0) {
    return { cmd: t.slice(1).toLowerCase(), rest: "" };
  }
  return {
    cmd: t.slice(1, space).toLowerCase(),
    rest: t.slice(space + 1).trim(),
  };
}

/** Resolve a single online player by prefix / substring of display name. */
export function resolveRosterPeer(
  roster: ReadonlyMap<string, SessionRosterEntry>,
  query: string,
): { peerId: string; entry: SessionRosterEntry } | null {
  const q = query.trim().toLowerCase();
  if (q === "") {
    return null;
  }
  const exact: { peerId: string; entry: SessionRosterEntry }[] = [];
  const partial: { peerId: string; entry: SessionRosterEntry }[] = [];
  for (const [peerId, entry] of roster) {
    const dn = entry.displayName.toLowerCase();
    if (dn === q) {
      exact.push({ peerId, entry });
    } else if (dn.includes(q)) {
      partial.push({ peerId, entry });
    }
  }
  if (exact.length === 1) {
    return exact[0]!;
  }
  if (exact.length > 1) {
    return null;
  }
  if (partial.length === 1) {
    return partial[0]!;
  }
  return null;
}

export type ChatHostControllerDeps = {
  adapter: PeerJSAdapter;
  /** Emit a player chat line on the host machine only (clients get the broadcast). */
  emitHostChatLine: (senderLabel: string, text: string) => void;
  /** Emit a system line on the host machine only. */
  emitHostSystemLine: (text: string) => void;
  moderation: WorldModerationState;
  roster: Map<string, SessionRosterEntry>;
  mutedPeerIds: Set<string>;
  opPeerIds: Set<string>;
  getLocalPeerId: () => string | null;
  getLocalDisplayName: () => string;
  schedulePersistModeration: () => void;
  sendSystemTo: (peerId: PeerId, text: string) => void;
  /** Host-only: parse `/give` tail and grant items (local or remote client). */
  executeGive: (issuerPeerId: string, rest: string) => void;
  /** Host-only: `/weather set rain|clear`. */
  executeWeather: (issuerPeerId: string, rest: string) => void;
};

export class ChatHostController {
  private readonly d: ChatHostControllerDeps;

  constructor(deps: ChatHostControllerDeps) {
    this.d = deps;
  }

  private isHostIssuer(issuerPeerId: string): boolean {
    const local = this.d.getLocalPeerId();
    return local !== null && issuerPeerId === local;
  }

  private canModerate(issuerPeerId: string): boolean {
    return this.isHostIssuer(issuerPeerId) || this.d.opPeerIds.has(issuerPeerId);
  }

  private canOp(issuerPeerId: string): boolean {
    return this.isHostIssuer(issuerPeerId);
  }

  private relayChat(fromPeerId: string, text: string): void {
    if (this.d.mutedPeerIds.has(fromPeerId)) {
      this.d.sendSystemTo(fromPeerId as PeerId, "You are muted.");
      return;
    }
    const msg: NetworkMessage = {
      type: MessageType.CHAT,
      fromPeerId,
      text,
    };
    this.d.adapter.broadcast(msg);
    const entry = this.d.roster.get(fromPeerId);
    const label = entry?.displayName ?? fromPeerId;
    this.d.emitHostChatLine(label, text);
  }

  private broadcastSystem(text: string): void {
    const msg: NetworkMessage = {
      type: MessageType.SYSTEM_MESSAGE,
      text,
    };
    this.d.adapter.broadcast(msg);
    this.d.emitHostSystemLine(text);
  }

  /**
   * Handle an inbound chat line from `fromPeerId` (host uses local peer id).
   * Returns true if consumed as command (no public relay of raw slash line).
   */
  handleInboundLine(fromPeerId: string, line: string): boolean {
    const trimmed = line.trim();
    if (trimmed === "") {
      return true;
    }

    const { cmd, rest } = splitCommand(trimmed);
    if (cmd === "") {
      this.relayChat(fromPeerId, trimmed);
      return true;
    }

    if (cmd === "ping") {
      void rest;
      this.d.sendSystemTo(
        fromPeerId as PeerId,
        "Ping is handled by your client (network round-trip to the host).",
      );
      return true;
    }

    if (cmd === "give") {
      if (!this.canModerate(fromPeerId)) {
        this.d.sendSystemTo(
          fromPeerId as PeerId,
          "You do not have permission to use this command.",
        );
        return true;
      }
      this.d.executeGive(fromPeerId, rest);
      return true;
    }

    if (cmd === "weather") {
      if (!this.canModerate(fromPeerId)) {
        this.d.sendSystemTo(
          fromPeerId as PeerId,
          "You do not have permission to use this command.",
        );
        return true;
      }
      this.d.executeWeather(fromPeerId, rest);
      return true;
    }

    if (!this.canModerate(fromPeerId)) {
      this.d.sendSystemTo(
        fromPeerId as PeerId,
        "You do not have permission to use this command.",
      );
      return true;
    }

    switch (cmd) {
      case "kick": {
        if (rest === "") {
          this.d.sendSystemTo(fromPeerId as PeerId, "Usage: /kick <player>");
          return true;
        }
        const hit = resolveRosterPeer(this.d.roster, rest);
        if (hit === null) {
          this.d.sendSystemTo(fromPeerId as PeerId, "Player not found.");
          return true;
        }
        if (hit.peerId === fromPeerId) {
          this.d.sendSystemTo(fromPeerId as PeerId, "You cannot kick yourself.");
          return true;
        }
        try {
          this.d.adapter.send(hit.peerId as PeerId, {
            type: MessageType.SESSION_ENDED,
            reason: "You were kicked from the game.",
          });
        } catch {
          /* ignore */
        }
        this.d.adapter.disconnectPeer(hit.peerId as PeerId);
        this.broadcastSystem(`${hit.entry.displayName} was kicked.`);
        return true;
      }
      case "ban": {
        if (rest === "") {
          this.d.sendSystemTo(fromPeerId as PeerId, "Usage: /ban <player>");
          return true;
        }
        const hit = resolveRosterPeer(this.d.roster, rest);
        if (hit === null) {
          this.d.sendSystemTo(fromPeerId as PeerId, "Player not found (must be online).");
          return true;
        }
        const entry: ModerationEntry = {
          name: hit.entry.displayName,
          accountId:
            hit.entry.accountId.trim() !== "" ? hit.entry.accountId : null,
        };
        this.d.moderation.addBan(entry);
        this.d.schedulePersistModeration();
        try {
          this.d.adapter.send(hit.peerId as PeerId, {
            type: MessageType.SESSION_ENDED,
            reason: "You are banned from this world.",
          });
        } catch {
          /* ignore */
        }
        this.d.adapter.disconnectPeer(hit.peerId as PeerId);
        this.broadcastSystem(`${hit.entry.displayName} was banned.`);
        return true;
      }
      case "unban": {
        if (rest === "") {
          this.d.sendSystemTo(fromPeerId as PeerId, "Usage: /unban <player|uuid>");
          return true;
        }
        this.d.moderation.removeBanMatches(rest);
        this.d.schedulePersistModeration();
        this.d.sendSystemTo(fromPeerId as PeerId, "Ban removed (if it existed).");
        return true;
      }
      case "mute": {
        if (rest === "") {
          this.d.sendSystemTo(fromPeerId as PeerId, "Usage: /mute <player>");
          return true;
        }
        const hit = resolveRosterPeer(this.d.roster, rest);
        if (hit === null) {
          this.d.sendSystemTo(fromPeerId as PeerId, "Player not found.");
          return true;
        }
        this.d.moderation.addMute({
          name: hit.entry.displayName,
          accountId:
            hit.entry.accountId.trim() !== "" ? hit.entry.accountId : null,
        });
        this.d.mutedPeerIds.add(hit.peerId);
        this.d.schedulePersistModeration();
        this.broadcastSystem(`${hit.entry.displayName} was muted.`);
        return true;
      }
      case "unmute": {
        if (rest === "") {
          this.d.sendSystemTo(fromPeerId as PeerId, "Usage: /unmute <player|uuid>");
          return true;
        }
        this.d.moderation.removeMuteMatches(rest);
        for (const [pid, e] of this.d.roster) {
          if (
            normalizeModerationName(e.displayName) ===
              normalizeModerationName(rest) ||
            (e.accountId !== "" && e.accountId === rest.trim())
          ) {
            this.d.mutedPeerIds.delete(pid);
          }
        }
        this.d.schedulePersistModeration();
        this.d.sendSystemTo(fromPeerId as PeerId, "Mute removed (if it existed).");
        return true;
      }
      case "op": {
        if (!this.canOp(fromPeerId)) {
          this.d.sendSystemTo(
            fromPeerId as PeerId,
            "Only the host can assign operators.",
          );
          return true;
        }
        if (rest === "") {
          this.d.sendSystemTo(fromPeerId as PeerId, "Usage: /op <player>");
          return true;
        }
        const hit = resolveRosterPeer(this.d.roster, rest);
        if (hit === null) {
          this.d.sendSystemTo(fromPeerId as PeerId, "Player not found.");
          return true;
        }
        this.d.moderation.addOp({
          name: hit.entry.displayName,
          accountId:
            hit.entry.accountId.trim() !== "" ? hit.entry.accountId : null,
        });
        this.d.opPeerIds.add(hit.peerId);
        this.d.schedulePersistModeration();
        this.d.sendSystemTo(fromPeerId as PeerId, `${hit.entry.displayName} is now an operator.`);
        this.d.sendSystemTo(
          hit.peerId as PeerId,
          "You are now a server operator.",
        );
        return true;
      }
      case "deop": {
        if (!this.canOp(fromPeerId)) {
          this.d.sendSystemTo(
            fromPeerId as PeerId,
            "Only the host can remove operators.",
          );
          return true;
        }
        if (rest === "") {
          this.d.sendSystemTo(fromPeerId as PeerId, "Usage: /deop <player|uuid>");
          return true;
        }
        const hit = resolveRosterPeer(this.d.roster, rest);
        if (hit !== null) {
          this.d.opPeerIds.delete(hit.peerId);
        }
        this.d.moderation.removeOpMatches(rest);
        this.d.schedulePersistModeration();
        this.d.sendSystemTo(fromPeerId as PeerId, "Operator removed (if applicable).");
        return true;
      }
      default:
        this.d.sendSystemTo(fromPeerId as PeerId, `Unknown command: /${cmd}`);
        return true;
    }
  }

}
