/**
 * Build identity for support (GitHub Pages cache vs latest, wire protocol mismatches).
 */
import {
  MIN_WIRE_PROTOCOL_VERSION,
  WIRE_PROTOCOL_VERSION,
} from "./network/protocol/BinarySerializer";

export type StratumBuildInfo = {
  appVersion: string;
  /** Per `vite build`; matches root `build.json` on the server when deploy is current. */
  buildId: string;
  wireProtocol: number;
  minWireProtocol: number;
  mode: string;
};

export function getStratumBuildInfo(): StratumBuildInfo {
  return {
    appVersion: __APP_VERSION__,
    buildId: __BUILD_ID__,
    wireProtocol: WIRE_PROTOCOL_VERSION,
    minWireProtocol: MIN_WIRE_PROTOCOL_VERSION,
    mode: import.meta.env.MODE,
  };
}

/** One line for chat / DevTools. */
export function formatStratumBuildLine(): string {
  const b = getStratumBuildInfo();
  return `Stratum ${b.appVersion} · build ${b.buildId} · wire ${b.wireProtocol} (accepts ${b.minWireProtocol}–${b.wireProtocol}) · ${b.mode}`;
}
