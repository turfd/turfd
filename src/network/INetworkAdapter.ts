/** Contract for network backends; `Game` depends only on this interface, not concrete adapters. */

import type { NetworkMessage } from "./protocol/messages";
import type { HostPeerId } from "./hostPeerId";

export type NetworkRole = "host" | "client" | "offline";

/** Connection to a self-hosted PeerJS signaling server (LAN or port-forwarded). */
export type PeerServerConfig = Readonly<{
  /** Hostname or IP reachable from this browser. */
  host: string;
  port: number;
  /** Path on the PeerJS server; PeerJS default is `'/'`. */
  path?: string;
  /** Use TLS (WSS). Default: true only when port is 443. */
  secure?: boolean;
}>;

export type ConnectionState =
  | { status: "disconnected" }
  | { status: "connecting" }
  | {
      status: "connected";
      role: NetworkRole;
      /** When hosting, your peer id for others to dial; when client, the host's id; offline: null. */
      lanHostPeerId: string | null;
    };

declare const __peerIdBrand: unique symbol;
export type PeerId = string & { [__peerIdBrand]: never };

export interface INetworkAdapter {
  /** Current connection state. Readonly — Game reads, adapter writes. */
  readonly state: ConnectionState;

  /**
   * Host: register on the signaling server and accept peers.
   * Resolves with the peer id joiners must use once the host peer is open.
   */
  host(config: PeerServerConfig): Promise<HostPeerId>;

  /**
   * Client: connect to an existing host on the same signaling server.
   * Resolves when the handshake with the host completes.
   */
  join(config: PeerServerConfig, hostPeerId: HostPeerId): Promise<void>;

  /**
   * Disconnect from all peers and release transport resources.
   * Safe to call when already disconnected.
   */
  disconnect(): void;

  /**
   * Send a message to one specific peer (by PeerId).
   * No-op if not connected or peer is unknown.
   */
  send(to: PeerId, msg: NetworkMessage): void;

  /**
   * Broadcast a message to all connected peers.
   * No-op if not connected.
   */
  broadcast(msg: NetworkMessage): void;

  /**
   * Send to every open connection except `excludePeerId` (null = all peers). Host uses this to relay client poses.
   */
  broadcastExcept(excludePeerId: PeerId | null, msg: NetworkMessage): void;

  /**
   * Register a handler for inbound messages.
   * The adapter calls this exactly once per received message.
   * Replaces any previously registered handler.
   */
  onMessage(handler: (from: PeerId, msg: NetworkMessage) => void): void;

  /**
   * Register a handler for peer connect events.
   * Called when a new peer completes the handshake.
   * Replaces any previously registered handler.
   */
  onPeerConnected(handler: (peerId: PeerId) => void): void;

  /**
   * Register a handler for peer disconnect events.
   * Called when a peer drops or closes the connection.
   * Replaces any previously registered handler.
   */
  onPeerDisconnected(handler: (peerId: PeerId) => void): void;

  /** Display name + Supabase user id sent in wire handshake (host + client). */
  setHandshakeProfile(displayName: string, accountId: string | null): void;

  /**
   * Host only: if set, called before a joining client is admitted after their handshake.
   * Return false to close the connection (e.g. banned).
   */
  setClientAdmissionGate(
    gate:
      | ((peerId: PeerId, displayName: string, accountId: string) => boolean)
      | null,
  ): void;

  /** This peer's PeerJS id when the peer object is open; null if unavailable. */
  getLocalPeerId(): string | null;

  /** Host: force-close a client's data connection. */
  disconnectPeer(peerId: PeerId): void;
}
