/** Turf'd host peer IDs for PeerJS (`turfd-host-` + random suffix). Joiners dial this ID on your signaling server. */

const HOST_PREFIX = "turfd-host-";

/** Length of the random suffix (characters). */
export const HOST_PEER_SUFFIX_LENGTH = 6;

/** Alphabet aligned with legacy room codes (no I, O, 0, 1). */
export const HOST_PEER_SUFFIX_ALPHABET =
  "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

declare const __hostPeerIdBrand: unique symbol;
export type HostPeerId = string & { [__hostPeerIdBrand]: never };

const SUFFIX_REGEX = new RegExp(
  `^[${HOST_PEER_SUFFIX_ALPHABET}]{${HOST_PEER_SUFFIX_LENGTH}}$`,
);

const FULL_HOST_REGEX = new RegExp(
  `^${HOST_PREFIX}[${HOST_PEER_SUFFIX_ALPHABET}]{${HOST_PEER_SUFFIX_LENGTH}}$`,
);

/** True if `s` is a full host peer id (`turfd-host-XXXXXX`). */
export function isHostPeerId(s: string): s is HostPeerId {
  return FULL_HOST_REGEX.test(s);
}

/**
 * Generate a cryptographically random suffix (not `Math.random()`).
 * Used for host and client peer id tails.
 */
export function generateRandomSuffix(): string {
  const bytes = new Uint8Array(HOST_PEER_SUFFIX_LENGTH);
  crypto.getRandomValues(bytes);
  const n = HOST_PEER_SUFFIX_ALPHABET.length;
  let out = "";
  for (let i = 0; i < HOST_PEER_SUFFIX_LENGTH; i++) {
    out += HOST_PEER_SUFFIX_ALPHABET.charAt(bytes[i]! % n);
  }
  if (!SUFFIX_REGEX.test(out)) {
    throw new Error("Unreachable: generated host suffix failed validation");
  }
  return out;
}

/** Allocate a new host peer id for `new Peer(...)`. */
export function generateHostPeerId(): HostPeerId {
  const id = HOST_PREFIX + generateRandomSuffix();
  if (!isHostPeerId(id)) {
    throw new Error("Unreachable: generated host peer id failed validation");
  }
  return id;
}

/** Random client id (`turfd-client-` + suffix). */
export function generateClientPeerId(): string {
  return `turfd-client-${generateRandomSuffix()}`;
}
