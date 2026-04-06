/**
 * Stable key for storing a guest’s last multiplayer feet position in world metadata.
 * Prefer signed-in `accountId`; otherwise normalized display name (collisions possible for guests).
 */
export function multiplayerPersistKey(
  accountId: string | undefined | null,
  displayName: string,
): string {
  const id = typeof accountId === "string" ? accountId.trim() : "";
  if (id.length > 0) {
    return `id:${id}`;
  }
  const n = displayName.trim().toLowerCase().replace(/\s+/g, " ");
  return `name:${n.length > 0 ? n : "guest"}`;
}
