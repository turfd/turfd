/** WebRTC networking via PeerJS; implements `INetworkAdapter` for host and client. */

import Peer, { type DataConnection } from "peerjs";
import type { EventBus } from "../core/EventBus";
import type {
  ConnectionState,
  INetworkAdapter,
  PeerId,
  PeerServerConfig,
} from "./INetworkAdapter";
import {
  BinarySerializer,
  WIRE_PROTOCOL_VERSION,
  type DecodedWirePayload,
} from "./protocol/BinarySerializer";
import type { NetworkMessage } from "./protocol/messages";
import {
  decode,
  encode,
  MessageType,
  PLAYER_STATE_WIRE_BYTE_LENGTH,
  writePlayerStateWire,
} from "./protocol/messages";
import type { HandshakeWirePayload } from "./protocol/BinarySerializer";
import type { HostPeerId } from "./hostPeerId";
import { generateClientPeerId, generateHostPeerId } from "./hostPeerId";

/** Milliseconds before a client join attempt is considered timed out. */
const JOIN_TIMEOUT_MS = 10_000;

const PROTOCOL_MISMATCH_MSG = "Protocol version mismatch";
const INVALID_HANDSHAKE_MSG = "Invalid handshake";

function toPeerOptions(cfg: PeerServerConfig): ConstructorParameters<typeof Peer>[1] {
  const secure = cfg.secure ?? cfg.port === 443;
  return {
    host: cfg.host,
    port: cfg.port,
    path: cfg.path ?? "/",
    secure,
  };
}

export class PeerJSAdapter implements INetworkAdapter {
  private readonly _bus: EventBus;

  private _state: ConnectionState = { status: "disconnected" };

  get state(): ConnectionState {
    return this._state;
  }

  private _peer: Peer | null = null;
  private readonly _connections = new Map<PeerId, DataConnection>();

  private _onMessage:
    | ((from: PeerId, msg: NetworkMessage) => void)
    | null = null;
  private _onPeerConnected: ((peerId: PeerId) => void) | null = null;
  private _onPeerDisconnected: ((peerId: PeerId) => void) | null = null;

  /** Reused for `PLAYER_STATE` broadcasts to avoid per-tick `ArrayBuffer` allocation. */
  private _playerStateScratch: ArrayBuffer | null = null;

  private _handshakeDisplayName = "Player";
  private _handshakeAccountId = "";
  private _handshakeSkinId = "";

  private _clientAdmissionGate:
    | ((peerId: PeerId, displayName: string, accountId: string) => boolean)
    | null = null;

  constructor(bus: EventBus) {
    this._bus = bus;
  }

  setHandshakeProfile(displayName: string, accountId: string | null, skinId?: string): void {
    const d = displayName.trim();
    this._handshakeDisplayName = d !== "" ? d : "Player";
    this._handshakeAccountId = accountId?.trim() ?? "";
    this._handshakeSkinId = skinId?.trim() ?? "";
  }

  setClientAdmissionGate(
    gate:
      | ((peerId: PeerId, displayName: string, accountId: string) => boolean)
      | null,
  ): void {
    this._clientAdmissionGate = gate;
  }

  getLocalPeerId(): string | null {
    const id = this._peer?.id;
    return id !== undefined && id !== "" ? id : null;
  }

  disconnectPeer(peerId: PeerId): void {
    const conn = this._connections.get(peerId);
    if (conn !== undefined) {
      conn.close();
      this._connections.delete(peerId);
    }
  }

  private _serializeLocalHandshake(localId: string): ArrayBuffer {
    return BinarySerializer.serializeHandshake({
      version: WIRE_PROTOCOL_VERSION,
      peerId: localId,
      displayName: this._handshakeDisplayName,
      accountId: this._handshakeAccountId,
      skinId: this._handshakeSkinId,
    });
  }

  host(config: PeerServerConfig): Promise<HostPeerId> {
    return new Promise((resolve, reject) => {
      if (this._state.status === "connecting") {
        reject(new Error("PeerJSAdapter: host already in progress"));
        return;
      }
      if (this._state.status === "connected") {
        reject(new Error("PeerJSAdapter: already connected"));
        return;
      }
      if (this._peer !== null && !this._peer.destroyed) {
        this._peer.destroy();
        this._peer = null;
        this._connections.clear();
      }

      this._setState({ status: "connecting" });

      const hostPeerId = generateHostPeerId();
      const peer = new Peer(hostPeerId, toPeerOptions(config));
      this._peer = peer;

      const onOpen = (): void => {
        peer.off("error", onError);
        this._setState({
          status: "connected",
          role: "host",
          lanHostPeerId: hostPeerId,
        });
        peer.on("connection", (conn) => {
          const remoteId = conn.peer as PeerId;
          this._handleIncomingConnection(conn, remoteId);
        });
        resolve(hostPeerId);
      };

      const onError = (err: unknown): void => {
        peer.off("open", onOpen);
        this._setState({ status: "disconnected" });
        this._peer = null;
        reject(err instanceof Error ? err : new Error(String(err)));
      };

      peer.once("open", onOpen);
      peer.once("error", onError);
    });
  }

  join(config: PeerServerConfig, hostPeerId: HostPeerId): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this._state.status !== "disconnected") {
        reject(new Error("PeerJSAdapter.join: already active"));
        return;
      }

      this._setState({ status: "connecting" });

      const clientPeerId = generateClientPeerId();
      const peer = new Peer(clientPeerId, toPeerOptions(config));
      this._peer = peer;

      let joinTimeoutId: ReturnType<typeof setTimeout> | null = null;

      const cleanupJoinTimeout = (): void => {
        if (joinTimeoutId !== null) {
          clearTimeout(joinTimeoutId);
          joinTimeoutId = null;
        }
      };

      const fail = (err: unknown): void => {
        cleanupJoinTimeout();
        this.disconnect();
        reject(err instanceof Error ? err : new Error(String(err)));
      };

      const onPeerOpen = (): void => {
        peer.off("error", onPeerErrorBeforeOpen);

        const conn = peer.connect(hostPeerId, { reliable: true });

        joinTimeoutId = setTimeout(() => {
          cleanupJoinTimeout();
          this.disconnect();
          reject(new Error("PeerJSAdapter.join: connection timeout"));
        }, JOIN_TIMEOUT_MS);

        const onConnOpen = (): void => {
          conn.off("error", onConnErrorBeforeOpen);
          cleanupJoinTimeout();

          const remotePeerId = conn.peer as PeerId;
          this._runClientHandshake(
            conn,
            remotePeerId,
            peer,
            hostPeerId,
            resolve,
            fail,
          );
        };

        const onConnErrorBeforeOpen = (err: unknown): void => {
          conn.off("open", onConnOpen);
          cleanupJoinTimeout();
          fail(err);
        };

        conn.once("open", onConnOpen);
        conn.once("error", onConnErrorBeforeOpen);
      };

      const onPeerErrorBeforeOpen = (err: unknown): void => {
        peer.off("open", onPeerOpen);
        fail(err);
      };

      peer.once("open", onPeerOpen);
      peer.once("error", onPeerErrorBeforeOpen);
    });
  }

  disconnect(): void {
    for (const conn of this._connections.values()) {
      conn.close();
    }
    this._connections.clear();
    if (this._peer !== null) {
      this._peer.destroy();
      this._peer = null;
    }
    this._setState({ status: "disconnected" });
  }

  send(to: PeerId, msg: NetworkMessage): void {
    if (this._state.status !== "connected") {
      return;
    }
    const conn = this._connections.get(to);
    if (conn === undefined || !conn.open) {
      return;
    }
    conn.send(encode(msg));
  }

  broadcast(msg: NetworkMessage): void {
    this.broadcastExcept(null, msg);
  }

  broadcastExcept(excludePeerId: PeerId | null, msg: NetworkMessage): void {
    if (this._state.status !== "connected") {
      return;
    }
    const buf = this._encodeWireBuffer(msg);
    for (const [peerId, conn] of this._connections) {
      if (excludePeerId !== null && peerId === excludePeerId) {
        continue;
      }
      if (conn.open) {
        conn.send(buf);
      }
    }
  }

  private _encodeWireBuffer(msg: NetworkMessage): ArrayBuffer {
    if (msg.type === MessageType.PLAYER_STATE) {
      if (this._playerStateScratch === null) {
        this._playerStateScratch = new ArrayBuffer(PLAYER_STATE_WIRE_BYTE_LENGTH);
      }
      writePlayerStateWire(
        new DataView(this._playerStateScratch),
        msg.playerId,
        msg.x,
        msg.y,
        msg.vx,
        msg.vy,
        msg.facingRight,
        msg.hotbarSlot,
        msg.heldItemId,
        msg.miningVisual,
        msg.armorHelmetId ?? 0,
        msg.armorChestId ?? 0,
        msg.armorLeggingsId ?? 0,
        msg.armorBootsId ?? 0,
        msg.bowDrawQuantized ?? 0,
        msg.aimDisplayX ?? 0,
        msg.aimDisplayY ?? 0,
      );
      return this._playerStateScratch;
    }
    return encode(msg);
  }

  onMessage(handler: (from: PeerId, msg: NetworkMessage) => void): void {
    void this._onMessage;
    this._onMessage = handler;
  }

  onPeerConnected(handler: (peerId: PeerId) => void): void {
    void this._onPeerConnected;
    this._onPeerConnected = handler;
  }

  onPeerDisconnected(handler: (peerId: PeerId) => void): void {
    void this._onPeerDisconnected;
    this._onPeerDisconnected = handler;
  }

  private _setState(next: ConnectionState): void {
    this._state = next;
  }

  /** Host: first inbound packet must be a binary handshake; then reply with host handshake. */
  private _handleIncomingConnection(
    conn: DataConnection,
    remotePeerId: PeerId,
  ): void {
    const waitHandshake = (): void => {
      conn.once("data", (data: unknown) => {
        const buf = this._toArrayBuffer(data);
        if (buf === null) {
          this._bus.emit({ type: "net:error", message: INVALID_HANDSHAKE_MSG });
          conn.close();
          return;
        }
        let decoded: DecodedWirePayload;
        try {
          decoded = BinarySerializer.deserialize(buf);
        } catch {
          this._bus.emit({ type: "net:error", message: INVALID_HANDSHAKE_MSG });
          conn.close();
          return;
        }
        if (decoded.kind !== "handshake") {
          this._bus.emit({ type: "net:error", message: INVALID_HANDSHAKE_MSG });
          conn.close();
          return;
        }
        const payload = decoded.payload as HandshakeWirePayload;
        if (payload.version !== WIRE_PROTOCOL_VERSION) {
          this._bus.emit({ type: "net:error", message: PROTOCOL_MISMATCH_MSG });
          conn.close();
          return;
        }

        const gate = this._clientAdmissionGate;
        if (
          gate !== null &&
          !gate(remotePeerId, payload.displayName, payload.accountId)
        ) {
          try {
            conn.send(
              encode({
                type: MessageType.SESSION_ENDED,
                reason: "You are banned from this world.",
              }),
            );
          } catch {
            /* ignore */
          }
          conn.close();
          return;
        }

        const localPeer = this._peer;
        const localId = localPeer?.id;
        if (localId !== undefined && localId !== "") {
          conn.send(this._serializeLocalHandshake(localId));
        }

        this._connections.set(remotePeerId, conn);
        this._bus.emit({
          type: "net:session-player",
          peerId: conn.peer,
          displayName: payload.displayName,
          accountId: payload.accountId,
          skinId: payload.skinId,
        });
        this._bus.emit({ type: "net:handshake-success", isHost: true });
        this._bus.emit({ type: "net:peer-joined", peerId: conn.peer });

        const h = this._onPeerConnected;
        if (h !== null) {
          h(remotePeerId);
        }

        this._wireDataListeners(conn, remotePeerId);
      });
    };

    if (conn.open) {
      waitHandshake();
    } else {
      conn.once("open", waitHandshake);
    }
  }

  /** Client: send handshake first, then first received packet must be host handshake. */
  private _runClientHandshake(
    conn: DataConnection,
    remotePeerId: PeerId,
    peer: Peer,
    hostPeerId: HostPeerId,
    resolve: () => void,
    fail: (err: unknown) => void,
  ): void {
    const localId = peer.id;
    if (localId === undefined || localId === "") {
      this._bus.emit({ type: "net:error", message: INVALID_HANDSHAKE_MSG });
      conn.close();
      fail(new Error(INVALID_HANDSHAKE_MSG));
      return;
    }

    const sendThenWait = (): void => {
      conn.send(this._serializeLocalHandshake(localId));

      conn.once("data", (data: unknown) => {
        const buf = this._toArrayBuffer(data);
        if (buf === null) {
          this._bus.emit({ type: "net:error", message: INVALID_HANDSHAKE_MSG });
          conn.close();
          fail(new Error(INVALID_HANDSHAKE_MSG));
          return;
        }
        let decoded: DecodedWirePayload;
        try {
          decoded = BinarySerializer.deserialize(buf);
        } catch {
          this._bus.emit({ type: "net:error", message: INVALID_HANDSHAKE_MSG });
          conn.close();
          fail(new Error(INVALID_HANDSHAKE_MSG));
          return;
        }
        if (decoded.kind !== "handshake") {
          this._bus.emit({ type: "net:error", message: INVALID_HANDSHAKE_MSG });
          conn.close();
          fail(new Error(INVALID_HANDSHAKE_MSG));
          return;
        }
        const payload = decoded.payload;
        if (payload.version !== WIRE_PROTOCOL_VERSION) {
          this._bus.emit({ type: "net:error", message: PROTOCOL_MISMATCH_MSG });
          conn.close();
          fail(new Error(PROTOCOL_MISMATCH_MSG));
          return;
        }

        this._connections.set(remotePeerId, conn);
        this._setState({
          status: "connected",
          role: "client",
          lanHostPeerId: hostPeerId,
        });
        const hostPayload = decoded.payload as HandshakeWirePayload;
        this._bus.emit({
          type: "net:session-player",
          peerId: remotePeerId,
          displayName: hostPayload.displayName,
          accountId: hostPayload.accountId,
          skinId: hostPayload.skinId,
        });
        this._bus.emit({ type: "net:handshake-success", isHost: false });
        this._bus.emit({ type: "net:peer-joined", peerId: conn.peer });

        const h = this._onPeerConnected;
        if (h !== null) {
          h(remotePeerId);
        }

        this._wireDataListeners(conn, remotePeerId);
        resolve();
      });
    };

    if (conn.open) {
      sendThenWait();
    } else {
      conn.once("open", sendThenWait);
    }
  }

  private _wireDataListeners(conn: DataConnection, peerId: PeerId): void {
    conn.on("data", (data: unknown) => {
      this._onConnData(peerId, data);
    });
    conn.on("close", () => {
      this._connections.delete(peerId);
      this._bus.emit({ type: "net:peer-left", peerId: conn.peer });
      this._onPeerDisconnected?.(peerId);
    });
    conn.on("error", () => {
      if (this._connections.delete(peerId)) {
        this._bus.emit({ type: "net:peer-left", peerId: conn.peer });
        this._onPeerDisconnected?.(peerId);
      }
    });
  }

  private _onConnData(peerId: PeerId, data: unknown): void {
    const buf = this._toArrayBuffer(data);
    if (buf === null) {
      return;
    }
    let msg: NetworkMessage;
    try {
      msg = decode(buf);
    } catch {
      return;
    }
    this._bus.emit({
      type: "net:message",
      peerId,
      message: msg,
    });
    const h = this._onMessage;
    if (h !== null) {
      h(peerId, msg);
    }
  }

  private _toArrayBuffer(data: unknown): ArrayBuffer | null {
    if (data instanceof ArrayBuffer) {
      return data;
    }
    if (data instanceof Uint8Array) {
      return data.buffer.slice(
        data.byteOffset,
        data.byteOffset + data.byteLength,
      );
    }
    return null;
  }
}
